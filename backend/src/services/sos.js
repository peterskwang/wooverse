const { pool } = require('../config/db');
const { sendSosPush } = require('./push_notifications');
const { sendAliSms } = require('./sms-service');

const FALLBACK_AFTER_MS = 30000;
const fallbackTimers = new Map();

const broadcaster = {
  broadcastToGroup: () => {},
  broadcastToRoom: () => {},
};

function setSosBroadcaster({ broadcastToGroup, broadcastToRoom }) {
  if (typeof broadcastToGroup === 'function') {
    broadcaster.broadcastToGroup = broadcastToGroup;
  }
  if (typeof broadcastToRoom === 'function') {
    broadcaster.broadcastToRoom = broadcastToRoom;
  }
}

function getGpsLink({ lat, lng }) {
  const safeLat = Number(lat);
  const safeLng = Number(lng);
  if (!Number.isFinite(safeLat) || !Number.isFinite(safeLng)) {
    return null;
  }
  return `https://uri.amap.com/marker?position=${safeLng},${safeLat}&name=SOS`;
}

function getStatus(row) {
  if (row.resolved_at) return 'resolved';
  if (row.acknowledged_at) return 'acknowledged';
  if (row.sms_fallback_sent_at) return 'sms_fallback_sent';
  return 'active';
}

function shapeSosEvent(row) {
  return {
    id: row.id,
    sos_id: row.id,
    user_id: row.user_id,
    user_name: row.user_name || row.username || 'Unknown',
    username: row.user_name || row.username || 'Unknown',
    group_id: row.group_id,
    lat: row.lat,
    lng: row.lng,
    gps_link: getGpsLink(row),
    triggered_at: row.triggered_at,
    acknowledged_at: row.acknowledged_at || null,
    acknowledged_by: row.acknowledged_by || null,
    resolved_at: row.resolved_at || null,
    resolved_by: row.resolved_by || null,
    sms_fallback_sent_at: row.sms_fallback_sent_at || null,
    sms_fallback_status: row.sms_fallback_status || null,
    status: getStatus(row),
    fallback_after_ms: FALLBACK_AFTER_MS,
  };
}

function validateUuid(value, fieldName) {
  if (!value) {
    const err = new Error(`${fieldName} required`);
    err.code = `missing_${fieldName}`;
    throw err;
  }
}

function validateCoordinates(lat, lng) {
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    const err = new Error('lat and lng required');
    err.code = 'invalid_location';
    throw err;
  }
  return { lat: latNum, lng: lngNum };
}

async function ensureGroupMembership(userId, groupId) {
  const result = await pool.query(
    'SELECT 1 FROM group_members WHERE user_id = $1 AND group_id = $2',
    [userId, groupId]
  );
  if (result.rowCount === 0) {
    const err = new Error('User not in group');
    err.code = 'not_group_member';
    throw err;
  }
}

async function loadUserName(userId) {
  const result = await pool.query('SELECT name FROM users WHERE id = $1', [userId]);
  if (result.rowCount === 0) {
    const err = new Error('User not found');
    err.code = 'user_not_found';
    throw err;
  }
  return result.rows[0].name || 'Unknown';
}

function clearFallbackTimer(sosId) {
  const timer = fallbackTimers.get(sosId);
  if (timer) {
    clearTimeout(timer);
    fallbackTimers.delete(sosId);
  }
}

function broadcastSosAlert(row, userName) {
  const gpsLink = getGpsLink(row);
  broadcaster.broadcastToRoom('admin', {
    type: 'sos_alert',
    sos_id: row.id,
    group_id: row.group_id,
    user_id: row.user_id,
    user_name: userName,
    lat: row.lat,
    lng: row.lng,
    gps_link: gpsLink,
    triggered_at: row.triggered_at,
    status: 'active',
    acknowledged_at: row.acknowledged_at || null,
    acknowledged_by: row.acknowledged_by || null,
    resolved_at: row.resolved_at || null,
    resolved_by: row.resolved_by || null,
    sms_fallback_status: row.sms_fallback_status || null,
    fallback_after_ms: FALLBACK_AFTER_MS,
  });
  broadcaster.broadcastToGroup(row.group_id, {
    type: 'sos_alert',
    sos_id: row.id,
    group_id: row.group_id,
    user_id: row.user_id,
    username: userName,
    lat: row.lat,
    lng: row.lng,
    triggered_at: row.triggered_at,
  });
  broadcaster.broadcastToRoom('admin', { type: 'refresh_sos' });
}

async function listEmergencyContacts(userId) {
  try {
    const result = await pool.query(
      `SELECT id, name, phone_e164
       FROM emergency_contacts
       WHERE user_id = $1
         AND disabled_at IS NULL
       ORDER BY created_at ASC`,
      [userId]
    );
    return result.rows;
  } catch (err) {
    if (err.code === '42P01') {
      return [];
    }
    throw err;
  }
}

async function recordContactNotification(sosId, contact, status, providerMessage) {
  try {
    await pool.query(
      `INSERT INTO sos_contact_notifications (sos_id, contact_id, phone_e164, status, provider_message)
       VALUES ($1, $2, $3, $4, $5)`,
      [sosId, contact.id || null, contact.phone_e164 || null, status, providerMessage || null]
    );
  } catch (err) {
    if (err.code !== '42P01') {
      console.error('[sos] contact notification record error:', err.message);
    }
  }
}

async function runSmsFallback(sosId) {
  clearFallbackTimer(sosId);

  const lockResult = await pool.query(
    `UPDATE sos_events
       SET sms_fallback_status = 'sending'
     WHERE id = $1
       AND acknowledged_at IS NULL
       AND resolved_at IS NULL
       AND sms_fallback_status IS NULL
     RETURNING id, user_id, group_id, lat, lng, triggered_at`,
    [sosId]
  );
  if (lockResult.rowCount === 0) return;

  const row = lockResult.rows[0];
  const userName = await loadUserName(row.user_id);
  const contacts = await listEmergencyContacts(row.user_id);
  const checkedAt = new Date().toISOString();

  if (contacts.length === 0) {
    await pool.query(
      `UPDATE sos_events
       SET sms_fallback_status = 'no_contacts'
       WHERE id = $1`,
      [sosId]
    );
    broadcaster.broadcastToRoom('admin', {
      type: 'sos_sms_fallback_skipped',
      sos_id: sosId,
      reason: 'no_emergency_contacts',
      checked_at: checkedAt,
    });
    broadcaster.broadcastToRoom('admin', { type: 'refresh_sos' });
    return;
  }

  const gpsLink = getGpsLink(row) || 'N/A';
  const triggeredAt = new Date(row.triggered_at).toISOString();
  const code = `${userName} ${gpsLink} ${triggeredAt}`;
  let sentCount = 0;

  for (const contact of contacts) {
    if (!contact.phone_e164) continue;
    try {
      await sendAliSms({ phoneE164: contact.phone_e164, code });
      sentCount += 1;
      await recordContactNotification(sosId, contact, 'sent', null);
    } catch (err) {
      await recordContactNotification(sosId, contact, 'failed', err.message);
    }
  }

  const finalStatus = sentCount > 0 ? 'sent' : 'failed';
  await pool.query(
    `UPDATE sos_events
       SET sms_fallback_sent_at = now(),
           sms_fallback_status = $2
       WHERE id = $1`,
    [sosId, finalStatus]
  );

  broadcaster.broadcastToRoom('admin', {
    type: 'sos_sms_fallback_sent',
    sos_id: sosId,
    sent_at: new Date().toISOString(),
    contact_count: sentCount,
    status: 'sms_fallback_sent',
  });
  broadcaster.broadcastToRoom('admin', { type: 'refresh_sos' });
}

function scheduleFallback(row) {
  clearFallbackTimer(row.id);
  const timer = setTimeout(() => {
    runSmsFallback(row.id).catch((err) => {
      console.error('[sos] fallback error:', err.message);
    });
  }, FALLBACK_AFTER_MS);
  fallbackTimers.set(row.id, timer);
}

async function triggerSos({ userId, groupId, lat, lng }) {
  validateUuid(userId, 'user_id');
  validateUuid(groupId, 'group_id');
  const coords = validateCoordinates(lat, lng);

  await ensureGroupMembership(userId, groupId);
  const userName = await loadUserName(userId);

  const insert = await pool.query(
    `INSERT INTO sos_events (user_id, group_id, lat, lng)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [userId, groupId, coords.lat, coords.lng]
  );
  const row = insert.rows[0];

  broadcastSosAlert(row, userName);

  const memberResult = await pool.query(
    'SELECT user_id FROM group_members WHERE group_id = $1 AND user_id <> $2',
    [groupId, userId]
  );
  const targetIds = memberResult.rows.map((item) => item.user_id);
  await sendSosPush(targetIds, { id: userId, name: userName }, { lat: coords.lat, lng: coords.lng, group_id: groupId });

  scheduleFallback(row);
  return shapeSosEvent({ ...row, user_name: userName });
}

async function acknowledgeSos({ sosId, adminUserId }) {
  validateUuid(sosId, 'sos_id');
  validateUuid(adminUserId, 'admin_user_id');

  const result = await pool.query(
    `UPDATE sos_events
     SET acknowledged_at = COALESCE(acknowledged_at, now()),
         acknowledged_by = COALESCE(acknowledged_by, $2)
     WHERE id = $1
     RETURNING *`,
    [sosId, adminUserId]
  );
  if (result.rowCount === 0) {
    const err = new Error('SOS event not found');
    err.code = 'not_found';
    throw err;
  }

  const row = result.rows[0];
  clearFallbackTimer(row.id);

  broadcaster.broadcastToRoom('admin', {
    type: 'sos_acknowledged',
    sos_id: row.id,
    acknowledged_at: row.acknowledged_at,
    acknowledged_by: row.acknowledged_by,
    status: 'acknowledged',
  });
  broadcaster.broadcastToGroup(row.group_id, {
    type: 'sos_acknowledged',
    sos_id: row.id,
    acknowledged_at: row.acknowledged_at,
  });
  broadcaster.broadcastToRoom('admin', { type: 'refresh_sos' });

  return shapeSosEvent(row);
}

async function resolveSos({ sosId, adminUserId }) {
  validateUuid(sosId, 'sos_id');
  // adminUserId is an admin identifier (e.g. 'admin'), not a user UUID.
  // Per Phase 4 convention, resolved_by can be null or any identifier.
  const resolvedBy = adminUserId || null;

  const result = await pool.query(
    `UPDATE sos_events
     SET resolved_at = COALESCE(resolved_at, now()),
         resolved_by = COALESCE(resolved_by, $2)
     WHERE id = $1
     RETURNING *`,
    [sosId, resolvedBy]
  );
  if (result.rowCount === 0) {
    const err = new Error('SOS event not found');
    err.code = 'not_found';
    throw err;
  }

  const row = result.rows[0];
  clearFallbackTimer(row.id);

  broadcaster.broadcastToRoom('admin', {
    type: 'sos_resolved',
    sos_id: row.id,
    resolved_at: row.resolved_at,
    resolved_by: row.resolved_by,
    status: 'resolved',
  });
  if (row.group_id) {
    broadcaster.broadcastToGroup(row.group_id, {
      type: 'sos_resolved',
      sos_id: row.id,
      group_id: row.group_id,
      resolved_at: row.resolved_at,
      resolved_by: row.resolved_by,
    });
  }
  broadcaster.broadcastToRoom('admin', { type: 'refresh_sos' });

  return shapeSosEvent(row);
}

function resumePendingFallbacks() {}

module.exports = {
  FALLBACK_AFTER_MS,
  triggerSos,
  acknowledgeSos,
  resolveSos,
  shapeSosEvent,
  getGpsLink,
  resumePendingFallbacks,
  setSosBroadcaster,
};
