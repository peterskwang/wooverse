const { pool } = require('../config/db');
const { sendJpushSos } = require('./jpush-service');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

async function getTokensForUsers(userIds = []) {
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return [];
  }

  const placeholders = userIds.map((_, idx) => `$${idx + 1}`).join(', ');
  const result = await pool.query(
    `SELECT user_id, provider, token
       FROM push_tokens
      WHERE user_id IN (${placeholders})
        AND disabled_at IS NULL`,
    userIds
  );
  return result.rows;
}

async function sendExpoSos(tokens = [], triggeredBy = {}, location = {}) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return;
  }

  const coordStr =
    location.lat != null && location.lng != null
      ? `${Number(location.lat).toFixed(4)}, ${Number(location.lng).toFixed(4)}`
      : 'unknown location';

  const messages = tokens.map((to) => ({
    to,
    sound: 'default',
    title: '🚨 SOS Alert',
    body: `${triggeredBy.name || 'A teammate'} needs help at ${coordStr}`,
    data: {
      type: 'sos_alert',
      user_id: triggeredBy.id,
      username: triggeredBy.name,
      lat: location.lat,
      lng: location.lng,
      group_id: location.group_id || null,
    },
    priority: 'high',
    channelId: 'sos-alerts',
  }));

  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });
    const result = await response.json();
    const sample = Array.isArray(result?.data) ? result.data.slice(0, 3) : result;
    console.log(`[push] Expo SOS push sent to ${tokens.length} devices`, JSON.stringify(sample));
  } catch (e) {
    console.error('[push] Expo Push API error:', e.message);
  }
}

async function sendSosPush(userIds = [], triggeredBy = {}, location = {}) {
  const total = Array.isArray(userIds) ? userIds.length : 0;
  if (total === 0) {
    console.log('[push] No recipients for SOS push');
    return;
  }

  let rows;
  try {
    rows = await getTokensForUsers(userIds);
  } catch (e) {
    console.error('[push] Failed to fetch push tokens:', e.message);
    return;
  }

  if (rows.length === 0) {
    console.log(`[push] SOS push: ${total} users have no registered tokens — skipping`);
    return;
  }

  const expoTokens = [];
  const jpushTokens = [];
  for (const row of rows) {
    const provider = row.provider || 'expo';
    if (provider === 'jpush') {
      jpushTokens.push(row.token);
    } else {
      expoTokens.push(row.token);
    }
  }

  await Promise.all([
    sendExpoSos(expoTokens, triggeredBy, location),
    sendJpushSos(jpushTokens, triggeredBy, location),
  ]);
}

module.exports = { sendSosPush };
