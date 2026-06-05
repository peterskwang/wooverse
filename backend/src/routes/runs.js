const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { requireAuth } = require('../middleware/auth');

// POST /api/runs/start — Open a new active run
router.post('/start', requireAuth, async (req, res) => {
  try {
    const { group_id, top_altitude_m, started_at } = req.body;
    const result = await pool.query(
      `INSERT INTO runs (user_id, group_id, top_altitude_m, started_at, status)
       VALUES ($1, $2, $3, $4, 'active')
       RETURNING id`,
      [req.user.userId, group_id || null, top_altitude_m || null, started_at || new Date()]
    );
    res.status(201).json({ run_id: result.rows[0].id });
  } catch (err) {
    console.error('[Runs] POST /start error:', err);
    res.status(500).json({ error: 'Failed to start run' });
  }
});

// POST /api/runs/:id/end — Close run with final stats
router.post('/:id/end', requireAuth, async (req, res) => {
  try {
    const {
      ended_at,
      duration_seconds,
      distance_meters,
      vertical_meters,
      max_speed_kmh,
      avg_speed_kmh,
      bottom_altitude_m
    } = req.body;

    const result = await pool.query(
      `UPDATE runs SET
         status = 'completed',
         ended_at = $1,
         duration_seconds = $2,
         distance_meters = $3,
         vertical_meters = $4,
         max_speed_kmh = $5,
         avg_speed_kmh = $6,
         bottom_altitude_m = $7
       WHERE id = $8 AND user_id = $9 AND status = 'active'
       RETURNING id`,
      [
        ended_at || new Date(),
        duration_seconds,
        distance_meters,
        vertical_meters,
        max_speed_kmh,
        avg_speed_kmh,
        bottom_altitude_m || null,
        req.params.id,
        req.user.userId
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Run not found or already closed' });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[Runs] POST /:id/end error:', err);
    res.status(500).json({ error: 'Failed to end run' });
  }
});

// POST /api/runs/:id/discard — Mark run as discarded
router.post('/:id/discard', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE runs SET status = 'discarded' WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[Runs] POST /:id/discard error:', err);
    res.status(500).json({ error: 'Failed to discard run' });
  }
});

// GET /api/runs — Paginated run history (completed only, newest first)
router.get('/', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = parseInt(req.query.offset) || 0;
    const result = await pool.query(
      `SELECT id, started_at, ended_at, duration_seconds, distance_meters,
              vertical_meters, max_speed_kmh, avg_speed_kmh,
              top_altitude_m, bottom_altitude_m, status
       FROM runs
       WHERE user_id = $1 AND status = 'completed'
       ORDER BY started_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.userId, limit, offset]
    );
    res.json({ runs: result.rows, offset, limit });
  } catch (err) {
    console.error('[Runs] GET / error:', err);
    res.status(500).json({ error: 'Failed to fetch runs' });
  }
});

// GET /api/runs/:id — Single run detail
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM runs WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.userId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[Runs] GET /:id error:', err);
    res.status(500).json({ error: 'Failed to fetch run' });
  }
});

module.exports = router;
