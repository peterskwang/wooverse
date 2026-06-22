const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const appleSignin = require('apple-signin-auth');
const { pool } = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { exchangeWeChatCode } = require('../services/wechat-auth');
const { sendAliSms } = require('../services/sms-service');

const EXPO_PUSH_TOKEN_REGEX = /^ExponentPushToken\[[^\]]+\]$/;
const PUSH_TOKEN_PROVIDERS = new Set(['expo', 'jpush']);
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SALT_ROUNDS = 12;
const SMS_CODE_REGEX = /^\d{6}$/;
const CHINA_MOBILE_REGEX = /^1[3-9]\d{9}$/;
const SMS_REQUEST_WINDOW_MS = 5 * 60 * 1000;
const SMS_REQUEST_MAX_COUNT = 3;
const smsRequestLimiter = new Map();

function sanitizePushToken(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().replace(/[\u0000-\u001F\u007F]/g, '');
}

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '30d'
  });
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizePhoneE164(phone) {
  if (!phone || typeof phone !== 'string') return null;
  const compact = phone.trim().replace(/[\s-]/g, '');
  if (!compact) return null;

  let national = compact;
  if (national.startsWith('+86')) {
    national = national.slice(3);
  } else if (national.startsWith('86') && national.length === 13) {
    national = national.slice(2);
  }

  if (!/^\d+$/.test(national) || !CHINA_MOBILE_REGEX.test(national)) {
    return null;
  }
  return `+86${national}`;
}

function isSmsRequestRateLimited(phoneE164) {
  const now = Date.now();
  const existing = smsRequestLimiter.get(phoneE164) || [];
  const active = existing.filter((ts) => now - ts < SMS_REQUEST_WINDOW_MS);

  if (active.length >= SMS_REQUEST_MAX_COUNT) {
    smsRequestLimiter.set(phoneE164, active);
    return true;
  }

  active.push(now);
  smsRequestLimiter.set(phoneE164, active);
  return false;
}

function generateSixDigitCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function buildFallbackDeviceId(provider, subject) {
  return `${provider}:${subject}`.slice(0, 255);
}

async function findUserByIdentity(provider, subject) {
  const result = await pool.query(
    `SELECT u.id, u.email, u.name, u.created_at, u.banned_at
     FROM auth_identities ai
     JOIN users u ON u.id = ai.user_id
     WHERE ai.provider = $1 AND ai.subject = $2
     LIMIT 1`,
    [provider, subject]
  );
  return result.rows[0] || null;
}

async function fetchUserById(userId) {
  const result = await pool.query(
    `SELECT id, email, name, created_at, banned_at
     FROM users
     WHERE id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

async function createIdentityUser({ name, deviceId, provider, subject }) {
  const fallbackName = name && name.trim() ? name.trim() : `${provider.toUpperCase()} User`;
  const resolvedDeviceId = deviceId && deviceId.trim()
    ? deviceId.trim()
    : buildFallbackDeviceId(provider, subject);

  const result = await pool.query(
    `INSERT INTO users (name, device_id, last_login_at)
     VALUES ($1, $2, now())
     RETURNING id, email, name, created_at, banned_at`,
    [fallbackName, resolvedDeviceId]
  );
  return result.rows[0];
}

async function upsertAuthIdentity({ userId, provider, subject, metadata }) {
  // Guard: if the identity is already linked to a DIFFERENT user, reject — no account takeover
  const existing = await pool.query(
    `SELECT user_id FROM auth_identities WHERE provider = $1 AND subject = $2`,
    [provider, subject]
  );
  if (existing.rows.length > 0 && existing.rows[0].user_id !== userId) {
    throw Object.assign(new Error('Identity already linked to a different account'), { statusCode: 409 });
  }

  await pool.query(
    `INSERT INTO auth_identities (user_id, provider, subject, metadata, last_login_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (provider, subject) DO UPDATE SET
       metadata = COALESCE(auth_identities.metadata, '{}'::jsonb) || COALESCE(EXCLUDED.metadata, '{}'::jsonb),
       last_login_at = now()`,
    [userId, provider, subject, metadata || {}]
  );
}

async function touchUserLastLogin(userId) {
  await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
}

async function markPhoneVerified(userId) {
  try {
    await pool.query(
      `UPDATE users
       SET phone_verified_at = now(),
           last_login_at = now()
       WHERE id = $1`,
      [userId]
    );
  } catch (e) {
    if (e.code === '42703') {
      await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
      return;
    }
    throw e;
  }
}

async function extractOptionalAuthUser(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  if (!authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Invalid authorization format' });
    return false;
  }

  try {
    const token = authHeader.slice(7);
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await pool.query(
      'SELECT id, email, name, created_at, banned_at FROM users WHERE id = $1',
      [decoded.userId]
    );
    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return false;
    }
    if (result.rows[0].banned_at) {
      res.status(403).json({ error: 'Account banned' });
      return false;
    }
    return result.rows[0];
  } catch (e) {
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') {
      res.status(401).json({ error: 'Invalid or expired token' });
      return false;
    }
    res.status(500).json({ error: 'Auth error' });
    return false;
  }
}

// POST /api/auth/signup — Email/password registration
router.post('/signup', async (req, res) => {
  const { email, password, name } = req.body || {};

  if (!email || !EMAIL_REGEX.test(email)) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name required' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, $2, $3)
       RETURNING id, email, name, created_at`,
      [email.toLowerCase(), passwordHash, name.trim()]
    );
    const user = result.rows[0];
    const token = signToken({ userId: user.id, email: user.email });
    res.status(201).json({ token, user: { id: user.id, email: user.email, name: user.name, created_at: user.created_at } });
  } catch (e) {
    if (e.code === '23505' && e.constraint && e.constraint.includes('email')) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    console.error('[auth] signup error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/login — Email/password login
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  try {
    const result = await pool.query(
      `SELECT id, email, name, password_hash, banned_at FROM users WHERE email = $1`,
      [email.toLowerCase()]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const user = result.rows[0];
    if (!user.password_hash) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (user.banned_at) {
      return res.status(403).json({ error: 'Account banned' });
    }
    await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    const token = signToken({ userId: user.id, email: user.email });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (e) {
    console.error('[auth] login error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/apple — Apple Sign In
router.post('/apple', async (req, res) => {
  const { identityToken, name } = req.body || {};

  if (!identityToken) {
    return res.status(400).json({ error: 'identityToken required' });
  }

  try {
    const applePayload = await appleSignin.verifyIdToken(identityToken, {
      audience: process.env.APPLE_CLIENT_ID || 'com.wooverse.app',
      ignoreExpiration: false
    });
    const appleSub = applePayload.sub;
    const appleEmail = applePayload.email || null;

    // UPSERT by apple_sub
    const upsertResult = await pool.query(
      `INSERT INTO users (apple_sub, email, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (apple_sub) DO UPDATE SET
         last_login_at = now(),
         email = COALESCE(EXCLUDED.email, users.email),
         name = CASE
           WHEN users.name IS NULL OR users.name = '' THEN COALESCE(EXCLUDED.name, users.name)
           ELSE users.name
         END
       RETURNING id, email, name, banned_at`,
      [appleSub, appleEmail, name ? name.trim() : null]
    );
    const user = upsertResult.rows[0];
    if (user.banned_at) {
      return res.status(403).json({ error: 'Account banned' });
    }
    const token = signToken({ userId: user.id, appleSub });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (e) {
    console.error('[auth] apple error:', e.message);
    if (e.message && (e.message.includes('invalid') || e.message.includes('expired'))) {
      return res.status(401).json({ error: 'Invalid or expired Apple identity token' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/wechat — WeChat Open Platform login/link
router.post('/wechat', async (req, res) => {
  const { code, device_id: deviceId, name } = req.body || {};

  if (!code || !String(code).trim()) {
    return res.status(400).json({ error: 'code required' });
  }

  try {
    const authUser = await extractOptionalAuthUser(req, res);
    if (authUser === false) return;

    const wechatProfile = await exchangeWeChatCode(String(code).trim());
    const openid = wechatProfile.openid;
    const unionid = wechatProfile.unionid || null;

    let user = authUser;
    if (!user) {
      user = await findUserByIdentity('wechat', openid);
    }
    if (!user) {
      user = await createIdentityUser({
        name,
        deviceId,
        provider: 'wechat',
        subject: openid
      });
    }
    if (user.banned_at) {
      return res.status(403).json({ error: 'Account banned' });
    }

    await upsertAuthIdentity({
      userId: user.id,
      provider: 'wechat',
      subject: openid,
      metadata: { openid, unionid }
    });
    await touchUserLastLogin(user.id);

    const token = signToken({ userId: user.id, email: user.email || null });
    const freshUser = await fetchUserById(user.id);
    res.json({
      token,
      user: {
        id: freshUser.id,
        email: freshUser.email,
        name: freshUser.name,
        created_at: freshUser.created_at
      }
    });
  } catch (e) {
    console.error('[auth] wechat error:', e.message);
    if (e.message && e.message.toLowerCase().includes('wechat')) {
      return res.status(401).json({ error: 'Invalid WeChat authorization code' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/sms/request — Request SMS login code
router.post('/sms/request', async (req, res) => {
  const { phone } = req.body || {};
  const phoneE164 = normalizePhoneE164(phone);

  if (!phoneE164) {
    return res.status(400).json({ error: 'Valid China mobile number required' });
  }
  if (isSmsRequestRateLimited(phoneE164)) {
    return res.status(429).json({ error: 'Too many requests, please try again later' });
  }

  const code = generateSixDigitCode();
  const codeHash = sha256(code);

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO sms_login_codes (phone_e164, code_hash, expires_at)
         VALUES ($1, $2, now() + interval '5 minutes')`,
        [phoneE164, codeHash]
      );
      await sendAliSms({ phoneE164, code });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('[auth] sms request error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/sms/verify — Verify SMS login code
router.post('/sms/verify', async (req, res) => {
  const { phone, code, device_id: deviceId } = req.body || {};
  const phoneE164 = normalizePhoneE164(phone);

  if (!phoneE164) {
    return res.status(400).json({ error: 'Valid China mobile number required' });
  }
  if (!code || !SMS_CODE_REGEX.test(String(code))) {
    return res.status(400).json({ error: 'Valid 6-digit code required' });
  }

  try {
    const authUser = await extractOptionalAuthUser(req, res);
    if (authUser === false) return;

    const codesResult = await pool.query(
      `SELECT id, code_hash, attempts
       FROM sms_login_codes
       WHERE phone_e164 = $1
         AND consumed_at IS NULL
         AND expires_at > now()
       ORDER BY created_at DESC`,
      [phoneE164]
    );
    if (codesResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired code' });
    }

    const inputHash = sha256(String(code));
    let matchedCode = null;

    for (const row of codesResult.rows) {
      if ((row.attempts || 0) >= 5) {
        await pool.query(
          'UPDATE sms_login_codes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL',
          [row.id]
        );
        continue;
      }
      if (row.code_hash === inputHash) {
        matchedCode = row;
        break;
      }
    }

    if (!matchedCode) {
      const latest = codesResult.rows[0];
      const nextAttempts = (latest.attempts || 0) + 1;
      if (nextAttempts >= 5) {
        await pool.query(
          `UPDATE sms_login_codes
           SET attempts = $1, consumed_at = now()
           WHERE id = $2`,
          [nextAttempts, latest.id]
        );
      } else {
        await pool.query(
          'UPDATE sms_login_codes SET attempts = $1 WHERE id = $2',
          [nextAttempts, latest.id]
        );
      }
      return res.status(401).json({ error: 'Invalid or expired code' });
    }

    await pool.query(
      'UPDATE sms_login_codes SET consumed_at = now() WHERE id = $1',
      [matchedCode.id]
    );

    let user = authUser;
    if (!user) {
      user = await findUserByIdentity('phone', phoneE164);
    }
    if (!user) {
      user = await createIdentityUser({
        name: null,
        deviceId,
        provider: 'phone',
        subject: phoneE164
      });
    }
    if (user.banned_at) {
      return res.status(403).json({ error: 'Account banned' });
    }

    await upsertAuthIdentity({
      userId: user.id,
      provider: 'phone',
      subject: phoneE164,
      metadata: { phone_e164: phoneE164 }
    });
    await markPhoneVerified(user.id);

    const token = signToken({ userId: user.id, email: user.email || null });
    const freshUser = await fetchUserById(user.id);
    res.json({
      token,
      user: {
        id: freshUser.id,
        email: freshUser.email,
        name: freshUser.name,
        created_at: freshUser.created_at
      }
    });
  } catch (e) {
    console.error('[auth] sms verify error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/register — Legacy device_id (backward compat, deprecated)
router.post('/register', async (req, res) => {
  console.warn('[auth] DEPRECATED: /api/auth/register called — client should migrate to /signup or /login');
  res.set('X-Deprecated', 'true');

  const resolvedName = (req.body.name || req.body.display_name || '').trim();
  const deviceId = req.body.device_id;
  if (!deviceId || !resolvedName) {
    return res.status(400).json({ error: 'device_id and name required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO users (device_id, name)
       VALUES ($1, $2)
       ON CONFLICT (device_id) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, device_id, name, created_at, banned_at`,
      [deviceId, resolvedName]
    );
    const user = result.rows[0];
    if (user.banned_at) {
      return res.status(403).json({ error: 'Account banned' });
    }
    const token = signToken({ userId: user.id, deviceId: user.device_id });
    res.json({ token, user });
  } catch (e) {
    console.error('[auth] register error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/push-token — Register push notification token
router.post('/push-token', requireAuth, async (req, res) => {
  const { provider, token, platform, app_version } = req.body || {};
  if (!provider || !PUSH_TOKEN_PROVIDERS.has(provider)) {
    return res.status(400).json({ error: 'invalid provider' });
  }

  const sanitizedToken = sanitizePushToken(token);
  if (!sanitizedToken) {
    return res.status(400).json({ error: 'token required' });
  }
  if (provider === 'expo' && !EXPO_PUSH_TOKEN_REGEX.test(sanitizedToken)) {
    return res.status(400).json({ error: 'invalid token format' });
  }

  try {
    await pool.query(
      `WITH updated AS (
         UPDATE push_tokens
         SET token = $3,
             platform = $4,
             app_version = $5,
             last_seen_at = now(),
             disabled_at = NULL,
             updated_at = now()
         WHERE user_id = $1 AND provider = $2
         RETURNING user_id
       )
       INSERT INTO push_tokens (user_id, provider, token, platform, app_version, last_seen_at, updated_at)
       SELECT $1, $2, $3, $4, $5, now(), now()
       WHERE NOT EXISTS (SELECT 1 FROM updated)`,
      [req.user.userId, provider, sanitizedToken, platform || null, app_version || null]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[auth] push-token error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/users/me — Update display name
router.patch('/users/me', requireAuth, async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name required' });
  }
  const trimmed = name.trim();
  if (trimmed.length > 50) {
    return res.status(400).json({ error: 'Name must be 50 characters or fewer' });
  }
  try {
    const result = await pool.query(
      'UPDATE users SET name = $1 WHERE id = $2 RETURNING id, name',
      [trimmed, req.user.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ ok: true, user: result.rows[0] });
  } catch (e) {
    console.error('[auth] patch-me error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
