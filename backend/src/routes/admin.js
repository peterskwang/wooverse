const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { broadcastToGroup, broadcastToRoom, disconnectUser } = require('../services/ws');
const { sendSosPush } = require('../services/push_notifications');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Simple password auth for admin
function requireAdmin(req, res, next) {
  const pass = req.headers['x-admin-password'];
  if (!pass || pass !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// GET /api/admin/users
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, device_id, name, created_at, banned_at FROM users ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (e) {
    console.error('[admin] list users error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/groups
router.get('/groups', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT g.*, COUNT(gm.user_id)::int as member_count
       FROM groups g LEFT JOIN group_members gm ON gm.group_id = g.id
       GROUP BY g.id ORDER BY g.created_at DESC`
    );
    res.json(result.rows);
  } catch (e) {
    console.error('[admin] list groups error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/sos
router.get('/sos', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.*, u.name as user_name
       FROM sos_events s JOIN users u ON u.id = s.user_id
       ORDER BY s.triggered_at DESC LIMIT 100`
    );
    res.json(result.rows);
  } catch (e) {
    console.error('[admin] list sos error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/admin/sos/:id/resolve
router.patch('/sos/:id/resolve', requireAdmin, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'invalid id' });
  }

  try {
    const result = await pool.query(
      `UPDATE sos_events
       SET resolved_at = COALESCE(resolved_at, now()),
           resolved_by = CASE WHEN resolved_at IS NULL THEN NULL ELSE resolved_by END
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'SOS event not found' });
    }

    const event = result.rows[0];
    if (event.group_id) {
      broadcastToGroup(event.group_id, {
        type: 'sos_resolved',
        sos_id: event.id,
        group_id: event.group_id,
        resolved_by: 'admin',
        resolved_at: event.resolved_at,
      });
    }
    broadcastToRoom('admin', { type: 'refresh_sos' });

    res.json({ ...event, resolved_by_admin: true });
  } catch (e) {
    console.error('[admin] resolve sos error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/users/:id/ban
router.post('/users/:id/ban', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE users SET banned_at = now() WHERE id = $1 RETURNING id, banned_at',
      [req.params.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    disconnectUser(req.params.id, 'banned');
    res.json({ ok: true, banned_at: result.rows[0].banned_at });
  } catch (e) {
    console.error('[admin] ban user error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/admin/groups/:id — hard delete (cascades members + locations; clears SOS refs)
router.delete('/groups/:id', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Null out group_id on SOS events (preserve audit trail, drop FK ref)
    await client.query('UPDATE sos_events SET group_id = NULL WHERE group_id = $1', [req.params.id]);
    // Delete the group (cascades group_members + locations via ON DELETE CASCADE)
    const result = await client.query('DELETE FROM groups WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Group not found' });
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[admin] delete group error:', e.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// POST /api/admin/notify — send push notification to all users in a group (or all users)
router.post('/notify', requireAdmin, async (req, res) => {
  const { group_id, title, body } = req.body || {};
  if (!title || !body) {
    return res.status(400).json({ error: 'title and body required' });
  }

  try {
    let userIds;
    if (group_id) {
      const result = await pool.query(
        'SELECT user_id FROM group_members WHERE group_id = $1',
        [group_id]
      );
      userIds = result.rows.map((r) => r.user_id);
    } else {
      const result = await pool.query(
        'SELECT user_id FROM push_tokens'
      );
      userIds = result.rows.map((r) => r.user_id);
    }

    if (userIds.length === 0) {
      return res.json({ ok: true, sent: 0, message: 'No registered devices found' });
    }

    // Fetch tokens
    const placeholders = userIds.map((_, i) => `$${i + 1}`).join(', ');
    const tokensResult = await pool.query(
      `SELECT token FROM push_tokens WHERE user_id IN (${placeholders})`,
      userIds
    );
    const tokens = tokensResult.rows.map((r) => r.token);

    if (tokens.length === 0) {
      return res.json({ ok: true, sent: 0, message: 'No push tokens registered' });
    }

    // Send via Expo Push API
    const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
    const messages = tokens.map((to) => ({
      to,
      sound: 'default',
      title,
      body,
      priority: 'normal',
    }));

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
    console.log(`[admin] notify: sent to ${tokens.length} devices`, JSON.stringify(result?.data?.slice(0, 3)));
    res.json({ ok: true, sent: tokens.length });
  } catch (e) {
    console.error('[admin] notify error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
