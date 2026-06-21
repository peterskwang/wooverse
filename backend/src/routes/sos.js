const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { pool } = require('../config/db');
const { broadcastToGroup } = require('../services/ws');
const { sendSosPush } = require('../services/push_notifications');

// Trigger SOS
// POST /api/sos
router.post('/', requireAuth, async (req, res) => {
  const { group_id, lat, lng } = req.body;
  if (!group_id || lat == null || lng == null) {
    return res.status(400).json({ error: 'group_id, lat, lng required' });
  }
  try {
    const insert = await pool.query(
      `INSERT INTO sos_events (user_id, group_id, lat, lng)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.user.userId, group_id, lat, lng]
    );
    const sosEvent = insert.rows[0];

    const userResult = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.userId]);
    const username = userResult.rows[0]?.name || 'Unknown';

    broadcastToGroup(group_id, {
      type: 'sos_alert',
      user_id: req.user.userId,
      username,
      lat,
      lng,
      triggered_at: sosEvent.triggered_at,
      sos_id: sosEvent.id,
    });

    const memberResult = await pool.query(
      'SELECT user_id FROM group_members WHERE group_id = $1 AND user_id <> $2',
      [group_id, req.user.userId]
    );
    const targetIds = memberResult.rows.map((row) => row.user_id);
    sendSosPush(targetIds, { id: req.user.userId, name: username }, { lat, lng, group_id });

    res.status(201).json({ ...sosEvent, username });
  } catch (e) {
    console.error('[sos] create error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Resolve SOS
// PATCH /api/sos/:id/resolve
router.patch('/:id/resolve', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE sos_events SET resolved_at = now(), resolved_by = $1 WHERE id = $2 RETURNING *',
      [req.user.userId, req.params.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'SOS event not found' });
    }
    const event = result.rows[0];
    if (event.group_id) {
      broadcastToGroup(event.group_id, {
        type: 'sos_resolved',
        sos_id: event.id,
        resolved_by: req.user.userId,
        resolved_at: event.resolved_at,
      });
    }
    res.json(event);
  } catch (e) {
    console.error('[sos] resolve error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
