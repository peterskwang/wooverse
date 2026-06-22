const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { pool } = require('../config/db');
const { getGroupMemberPresence } = require('../services/ws');

function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// Create a group
// POST /api/groups
router.post('/', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  let code;
  let attempts = 0;
  while (attempts < 10) {
    code = generateInviteCode();
    const exists = await pool.query('SELECT 1 FROM groups WHERE invite_code = $1', [code]);
    if (exists.rowCount === 0) break;
    attempts++;
  }

  try {
    const result = await pool.query(
      `INSERT INTO groups (name, invite_code, owner_id)
       VALUES ($1, $2, $3) RETURNING *`,
      [name, code, req.user.userId]
    );
    const group = result.rows[0];
    // Auto-join owner
    await pool.query(
      'INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [group.id, req.user.userId]
    );
    res.status(201).json(group);
  } catch (e) {
    console.error('[groups] create error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Join by invite code
// POST /api/groups/join
router.post('/join', requireAuth, async (req, res) => {
  const { invite_code } = req.body;
  if (!invite_code) return res.status(400).json({ error: 'invite_code required' });

  try {
    const groupResult = await pool.query(
      'SELECT * FROM groups WHERE invite_code = $1 AND closed_at IS NULL',
      [invite_code.toUpperCase()]
    );
    if (groupResult.rowCount === 0) {
      return res.status(404).json({ error: 'Group not found or closed' });
    }
    const group = groupResult.rows[0];

    // Check max members
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM group_members WHERE group_id = $1',
      [group.id]
    );
    if (parseInt(countResult.rows[0].count) >= group.max_members) {
      return res.status(400).json({ error: 'Group is full (max 20 members)' });
    }

    await pool.query(
      'INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [group.id, req.user.userId]
    );
    res.json(group);
  } catch (e) {
    console.error('[groups] join error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get my groups
// GET /api/groups/mine
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT g.*, COUNT(gm.user_id) as member_count
       FROM groups g
       JOIN group_members gm ON gm.group_id = g.id
       WHERE gm.user_id = $1 AND g.closed_at IS NULL
       GROUP BY g.id
       ORDER BY g.created_at DESC`,
      [req.user.userId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get full member roster with live presence and last known location
// GET /api/groups/:groupId/members
router.get('/:groupId/members', requireAuth, async (req, res) => {
  const { groupId } = req.params;

  try {
    const membership = await pool.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, req.user.userId]
    );
    if (membership.rowCount === 0) {
      return res.status(403).json({ error: 'Not a group member' });
    }

    const members = await getGroupMemberPresence(groupId);
    res.json({ members });
  } catch (e) {
    console.error('[groups] members error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Leave a group
// POST /api/groups/:groupId/leave
router.post('/:groupId/leave', requireAuth, async (req, res) => {
  await pool.query(
    'DELETE FROM group_members WHERE group_id = $1 AND user_id = $2',
    [req.params.groupId, req.user.userId]
  );
  res.json({ ok: true });
});

module.exports = router;
