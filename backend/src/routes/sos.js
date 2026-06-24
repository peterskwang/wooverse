const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { triggerSos, resolveSos } = require('../services/sos');

// Trigger SOS
// POST /api/sos
router.post('/', requireAuth, async (req, res) => {
  const { group_id, lat, lng } = req.body;
  if (!group_id || lat == null || lng == null) {
    return res.status(400).json({ error: 'group_id, lat, lng required' });
  }
  try {
    const sosEvent = await triggerSos({
      userId: req.user.userId,
      groupId: group_id,
      lat,
      lng,
      timestamp: req.body.client_timestamp,
      source: 'rest',
    });
    res.status(201).json(sosEvent);
  } catch (e) {
    if (e.code === 'invalid_location' || e.code === 'missing_group_id') {
      return res.status(400).json({ error: e.message });
    }
    if (e.code === 'not_group_member') {
      return res.status(403).json({ error: e.message });
    }
    console.error('[sos] create error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Resolve SOS
// PATCH /api/sos/:id/resolve
router.patch('/:id/resolve', requireAuth, async (req, res) => {
  try {
    const event = await resolveSos({
      sosId: req.params.id,
      adminUserId: req.user.userId,
    });
    res.json(event);
  } catch (e) {
    if (e.code === 'not_found') {
      return res.status(404).json({ error: 'SOS event not found' });
    }
    if (e.code === 'missing_sos_id' || e.code === 'missing_admin_user_id') {
      return res.status(400).json({ error: e.message });
    }
    console.error('[sos] resolve error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
