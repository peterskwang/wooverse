const { WebSocketServer } = require('ws');
const { pool } = require('../config/db');

// In-memory room registry: groupId → Set<ws>
const rooms = new Map();
// User → ws mapping
const userSockets = new Map();
// User → ISO timestamp of last observed WS presence
const lastSeenByUser = new Map();
// Per-user audio sequence numbers
const speakerSeq = new Map();
// Goggle simulator registries (ephemeral — in-memory only)
// gogglesId → ws (goggle-mode socket)
const goggleSockets = new Map();
// gogglesId → ws (central-mode socket awaiting goggle)
const centralSockets = new Map();
// gogglesId → userId that registered this goggle (ownership map)
const gogglesOwners = new Map();
// Per-group channel floor holder (prevents simultaneous PTT cross-talk)
const channelFloor = new Map();

async function ensureUserAllowed(userId) {
  if (!userId) {
    const err = new Error('missing_user');
    err.code = 'missing_user';
    throw err;
  }
  const result = await pool.query('SELECT id, name, banned_at FROM users WHERE id = $1', [userId]);
  if (result.rowCount === 0) {
    const err = new Error('user_not_found');
    err.code = 'user_not_found';
    throw err;
  }
  const record = result.rows[0];
  if (record.banned_at) {
    const err = new Error('user_banned');
    err.code = 'user_banned';
    throw err;
  }
  return record;
}

async function ensureGroupMembership(userId, groupId) {
  if (!groupId) {
    const err = new Error('missing_group');
    err.code = 'missing_group';
    throw err;
  }

  const result = await pool.query(
    'SELECT 1 FROM group_members WHERE user_id = $1 AND group_id = $2',
    [userId, groupId]
  );
  if (result.rowCount === 0) {
    const err = new Error('not_group_member');
    err.code = 'not_group_member';
    throw err;
  }
}

function isOpenSocket(socket) {
  return socket?.readyState === 1;
}

function getRoomSocket(groupId, userId) {
  const room = rooms.get(groupId);
  if (!room) return null;
  for (const client of room) {
    if (client.userId === userId && isOpenSocket(client)) {
      return client;
    }
  }
  return null;
}

function getUserPresence(userId, groupId) {
  const socket = groupId ? getRoomSocket(groupId, userId) : userSockets.get(userId);
  const online = isOpenSocket(socket);
  return {
    online,
    last_seen_at: online ? socket.lastSeenAt : (lastSeenByUser.get(userId) || null),
  };
}

async function getGroupMemberPresence(groupId) {
  const result = await pool.query(
    `SELECT gm.user_id, u.name, l.lat, l.lng, l.updated_at AS location_updated_at
     FROM group_members gm
     JOIN users u ON u.id = gm.user_id
     LEFT JOIN locations l ON l.user_id = gm.user_id AND l.group_id = gm.group_id
     WHERE gm.group_id = $1
     ORDER BY u.name ASC`,
    [groupId]
  );

  return result.rows.map((member) => {
    const presence = getUserPresence(member.user_id, groupId);
    return {
      user_id: member.user_id,
      userId: member.user_id,
      name: member.name,
      online: presence.online,
      last_seen_at: presence.last_seen_at,
      lat: member.lat,
      lng: member.lng,
      location_updated_at: member.location_updated_at,
    };
  });
}

function startHeartbeat(ws) {
  ws.on('pong', () => {
    if (ws.pongTimeout) {
      clearTimeout(ws.pongTimeout);
      ws.pongTimeout = null;
    }
  });

  ws.heartbeatInterval = setInterval(() => {
    if (ws.readyState !== 1) return;
    try {
      ws.ping();
      if (ws.pongTimeout) clearTimeout(ws.pongTimeout);
      ws.pongTimeout = setTimeout(() => {
        console.warn('[WS] Closing stale connection');
        ws.terminate();
      }, 10000);
    } catch (err) {
      console.error('[WS] Heartbeat error:', err.message);
    }
  }, 30000);
}

function cleanupHeartbeat(ws) {
  if (ws.heartbeatInterval) {
    clearInterval(ws.heartbeatInterval);
    ws.heartbeatInterval = null;
  }
  if (ws.pongTimeout) {
    clearTimeout(ws.pongTimeout);
    ws.pongTimeout = null;
  }
}

function setupWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    console.log('[WS] New connection');
    startHeartbeat(ws);

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data);
        await handleMessage(ws, msg);
      } catch (e) {
        console.error('[WS] Message handling error:', e.message);
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      }
    });

    ws.on('close', () => {
      cleanupHeartbeat(ws);
      handleDisconnect(ws);
    });

    ws.on('error', (err) => {
      console.error('[WS] Error:', err.message);
    });
  });

  console.log('[Wooverse] WebSocket server ready');
  return wss;
}

async function handleMessage(ws, msg) {
  if (ws.userId) {
    ws.lastSeenAt = new Date().toISOString();
    lastSeenByUser.set(ws.userId, ws.lastSeenAt);
  }

  switch (msg.type) {
    case 'admin_join': {
      if (!msg.adminPassword || msg.adminPassword !== process.env.ADMIN_PASSWORD) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
        ws.close(4001, 'unauthorized');
        return;
      }
      if (!rooms.has('admin')) rooms.set('admin', new Set());
      rooms.get('admin').add(ws);
      ws.adminRoom = true;
      ws.send(JSON.stringify({ type: 'joined', room: 'admin' }));
      break;
    }

    case 'join': {
      try {
        const userRecord = await ensureUserAllowed(msg.userId);
        await ensureGroupMembership(msg.userId, msg.groupId);
        if (!rooms.has(msg.groupId)) rooms.set(msg.groupId, new Set());
        const room = rooms.get(msg.groupId);
        if (room.size >= 20) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room is full (max 20 members)' }));
          ws.close(1008, 'room_full');
          return;
        }

        ws.userId = msg.userId;
        ws.groupId = msg.groupId;
        ws.name = msg.name || userRecord.name;
        ws.lastSeenAt = new Date().toISOString();
        lastSeenByUser.set(msg.userId, ws.lastSeenAt);
        userSockets.set(msg.userId, ws);
        room.add(ws);
        speakerSeq.set(msg.userId, 0);

        ws.send(JSON.stringify({ type: 'joined', groupId: msg.groupId }));
        ws.send(JSON.stringify({
          type: 'members_snapshot',
          groupId: msg.groupId,
          members: await getGroupMemberPresence(msg.groupId),
        }));

        broadcastToGroup(msg.groupId, {
          type: 'member_joined',
          userId: msg.userId,
          user_id: msg.userId,
          name: ws.name,
          online: true,
          last_seen_at: ws.lastSeenAt,
        }, ws);
      } catch (err) {
        if (err.code === 'user_banned') {
          ws.send(JSON.stringify({ type: 'error', message: 'Account banned' }));
          ws.close(4001, 'banned');
          return;
        }
        if (err.code === 'not_group_member') {
          ws.send(JSON.stringify({ type: 'error', message: 'Not a group member' }));
          ws.close(1008, 'not_group_member');
          return;
        }
        ws.send(JSON.stringify({ type: 'error', message: 'Unable to join room' }));
        ws.close(1011, 'join_failed');
      }
      break;
    }

    case 'location': {
      if (!ws.userId || !ws.groupId) {
        ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
        return;
      }
      const lat = Number(msg.lat);
      const lng = Number(msg.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        ws.send(JSON.stringify({ type: 'error', message: 'invalid location' }));
        return;
      }
      const altitudeM = msg.altitude_m == null ? null : Number(msg.altitude_m);
      const speedMs = msg.speed_ms == null ? null : Number(msg.speed_ms);
      const locationTs = Date.now();
      ws.lastSeenAt = new Date().toISOString();
      lastSeenByUser.set(ws.userId, ws.lastSeenAt);

      broadcastToGroup(ws.groupId, {
        type: 'location',
        userId: ws.userId,
        user_id: ws.userId,
        lat,
        lng,
        altitude_m: Number.isFinite(altitudeM) ? altitudeM : null,
        speed_ms: Number.isFinite(speedMs) ? speedMs : null,
        sent_at: msg.sent_at || msg.ts || null,
        ts: locationTs,
      }, ws);

      try {
        await pool.query(
          `INSERT INTO locations (user_id, group_id, lat, lng, altitude_m, speed_kmh, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (user_id) DO UPDATE
           SET group_id = excluded.group_id,
               lat = excluded.lat,
               lng = excluded.lng,
               altitude_m = excluded.altitude_m,
               speed_kmh = excluded.speed_kmh,
               updated_at = now()`,
          [
            ws.userId,
            ws.groupId,
            lat,
            lng,
            Number.isFinite(altitudeM) ? altitudeM : null,
            Number.isFinite(speedMs) ? speedMs * 3.6 : null,
          ]
        );
      } catch (err) {
        console.error('[WS] Location persistence failed:', err.message);
      }
      break;
    }

    case 'webrtc_signal': {
      if (!ws.userId || !ws.groupId) {
        ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
        return;
      }
      if (!msg.target_user_id) {
        ws.send(JSON.stringify({ type: 'error', message: 'target_user_id required' }));
        return;
      }
      const targetSocket = getRoomSocket(ws.groupId, msg.target_user_id);
      if (!targetSocket) {
        ws.send(JSON.stringify({
          type: 'webrtc_signal_failed',
          target_user_id: msg.target_user_id,
          reason: 'target_offline',
        }));
        return;
      }
      targetSocket.send(JSON.stringify({
        type: 'webrtc_signal',
        from_user_id: ws.userId,
        signal: msg.signal,
      }));
      break;
    }

    case 'client_ping': {
      ws.send(JSON.stringify({
        type: 'server_pong',
        ts: msg.ts,
        server_ts: Date.now(),
      }));
      break;
    }

    case 'ptt_start': {
      const floorHolder = channelFloor.get(msg.groupId);
      if (floorHolder && floorHolder !== msg.userId) {
        ws.send(JSON.stringify({ type: 'ptt_busy', userId: floorHolder }));
        break;
      }
      channelFloor.set(msg.groupId, msg.userId);
      broadcastToGroup(msg.groupId, {
        type: 'ptt_start',
        userId: msg.userId,
        name: ws.name,
      }, ws);
      break;
    }

    case 'ptt_end': {
      if (channelFloor.get(msg.groupId) === msg.userId) {
        channelFloor.delete(msg.groupId);
      }
      broadcastToGroup(msg.groupId, {
        type: 'ptt_end',
        userId: msg.userId,
      }, ws);
      break;
    }

    case 'audio_chunk': {
      // Only the floor holder may send audio
      if (channelFloor.get(msg.groupId) !== msg.userId) {
        break;
      }
      const nextSeq = (speakerSeq.get(msg.userId) || 0) + 1;
      speakerSeq.set(msg.userId, nextSeq);
      broadcastToGroup(msg.groupId, {
        type: 'audio_chunk',
        userId: msg.userId,
        data: msg.data,
        seqNum: nextSeq,
      }, ws);
      break;
    }

    case 'sos': {
      broadcastToGroup(msg.groupId, {
        type: 'sos',
        userId: msg.userId,
        name: ws.name,
        lat: msg.lat,
        lng: msg.lng,
        ts: Date.now(),
      });
      break;
    }

    case 'goggle_register': {
      if (!ws.userId) {
        ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
        ws.close(4001, 'unauthorized');
        return;
      }
      ws.gogglesId = msg.gogglesId;
      ws.goggleMode = true;
      goggleSockets.set(msg.gogglesId, ws);
      gogglesOwners.set(msg.gogglesId, ws.userId);
      // Notify waiting central if present
      const centralForReg = centralSockets.get(msg.gogglesId);
      if (centralForReg?.readyState === 1) {
        centralForReg.send(JSON.stringify({ type: 'goggle_ready', gogglesId: msg.gogglesId }));
      }
      ws.send(JSON.stringify({ type: 'goggle_registered', gogglesId: msg.gogglesId }));
      break;
    }

    case 'goggle_offer': {
      if (!ws.userId) {
        ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
        ws.close(4001, 'unauthorized');
        return;
      }
      if (gogglesOwners.get(msg.gogglesId) !== ws.userId) {
        ws.send(JSON.stringify({ type: 'error', message: 'forbidden' }));
        return;
      }
      const centralForOffer = centralSockets.get(msg.gogglesId);
      if (centralForOffer?.readyState === 1) {
        centralForOffer.send(JSON.stringify({ type: 'goggle_offer', gogglesId: msg.gogglesId, sdp: msg.sdp }));
      }
      break;
    }

    case 'goggle_answer': {
      if (!ws.userId) {
        ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
        ws.close(4001, 'unauthorized');
        return;
      }
      if (gogglesOwners.has(msg.gogglesId) && gogglesOwners.get(msg.gogglesId) !== ws.userId) {
        ws.send(JSON.stringify({ type: 'error', message: 'forbidden' }));
        return;
      }
      const goggleForAnswer = goggleSockets.get(msg.gogglesId);
      if (goggleForAnswer?.readyState === 1) {
        goggleForAnswer.send(JSON.stringify({ type: 'goggle_answer', gogglesId: msg.gogglesId, sdp: msg.sdp }));
      }
      break;
    }

    case 'goggle_ice': {
      if (!ws.userId) {
        ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
        ws.close(4001, 'unauthorized');
        return;
      }
      const iceTarget = msg.from === 'goggle'
        ? centralSockets.get(msg.gogglesId)
        : goggleSockets.get(msg.gogglesId);
      if (iceTarget?.readyState === 1) {
        iceTarget.send(JSON.stringify({ type: 'goggle_ice', candidate: msg.candidate, from: msg.from }));
      }
      break;
    }

    case 'goggle_command': {
      if (!ws.userId) {
        ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
        ws.close(4001, 'unauthorized');
        return;
      }
      if (gogglesOwners.has(msg.gogglesId) && gogglesOwners.get(msg.gogglesId) !== ws.userId) {
        ws.send(JSON.stringify({ type: 'error', message: 'forbidden' }));
        return;
      }
      const goggleForCmd = goggleSockets.get(msg.gogglesId);
      if (goggleForCmd?.readyState === 1) {
        goggleForCmd.send(JSON.stringify({ type: 'goggle_command', cmd: msg.cmd }));
      }
      break;
    }

    case 'goggle_await': {
      if (!ws.userId) {
        ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
        ws.close(4001, 'unauthorized');
        return;
      }
      // Central registers it is waiting for a specific goggle
      ws.awaitingGoggle = msg.gogglesId;
      centralSockets.set(msg.gogglesId, ws);
      // If goggle already registered, notify immediately
      const goggleForAwait = goggleSockets.get(msg.gogglesId);
      if (goggleForAwait?.readyState === 1) {
        ws.send(JSON.stringify({ type: 'goggle_ready', gogglesId: msg.gogglesId }));
      }
      break;
    }

    case 'goggle_disconnect': {
      if (!ws.userId) {
        ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
        ws.close(4001, 'unauthorized');
        return;
      }
      const goggleForDisc = goggleSockets.get(msg.gogglesId);
      const centralForDisc = centralSockets.get(msg.gogglesId);
      if (goggleForDisc?.readyState === 1) {
        goggleForDisc.send(JSON.stringify({ type: 'goggle_disconnect', gogglesId: msg.gogglesId }));
      }
      if (centralForDisc?.readyState === 1) {
        centralForDisc.send(JSON.stringify({ type: 'goggle_disconnect', gogglesId: msg.gogglesId }));
      }
      goggleSockets.delete(msg.gogglesId);
      centralSockets.delete(msg.gogglesId);
      gogglesOwners.delete(msg.gogglesId);
      break;
    }

    default:
      ws.send(JSON.stringify({ type: 'error', message: `Unknown type: ${msg.type}` }));
  }
}

function handleDisconnect(ws) {
  if (ws.adminRoom && rooms.has('admin')) {
    const room = rooms.get('admin');
    room.delete(ws);
    if (room.size === 0) {
      rooms.delete('admin');
    }
  }
  if (ws.userId) {
    ws.lastSeenAt = new Date().toISOString();
    lastSeenByUser.set(ws.userId, ws.lastSeenAt);
    if (userSockets.get(ws.userId) === ws) {
      userSockets.delete(ws.userId);
    }
    speakerSeq.delete(ws.userId);
    // Release channel floor if this user held it
    if (ws.groupId && channelFloor.get(ws.groupId) === ws.userId) {
      channelFloor.delete(ws.groupId);
      broadcastToGroup(ws.groupId, {
        type: 'ptt_end',
        userId: ws.userId,
      });
    }
  }
  if (ws.groupId && rooms.has(ws.groupId)) {
    const room = rooms.get(ws.groupId);
    room.delete(ws);
    if (room.size === 0) {
      rooms.delete(ws.groupId);
    }
    broadcastToGroup(ws.groupId, {
      type: 'member_left',
      userId: ws.userId,
      user_id: ws.userId,
      name: ws.name,
      online: false,
      last_seen_at: ws.lastSeenAt,
    });
  }
  // Clean up goggle/central registries
  if (ws.gogglesId && ws.goggleMode) {
    goggleSockets.delete(ws.gogglesId);
    const central = centralSockets.get(ws.gogglesId);
    if (central?.readyState === 1) {
      central.send(JSON.stringify({ type: 'goggle_disconnect', gogglesId: ws.gogglesId }));
    }
  }
  if (ws.awaitingGoggle) {
    centralSockets.delete(ws.awaitingGoggle);
    const goggle = goggleSockets.get(ws.awaitingGoggle);
    if (goggle?.readyState === 1) {
      goggle.send(JSON.stringify({ type: 'goggle_disconnect', gogglesId: ws.awaitingGoggle }));
    }
  }
}

function broadcastToGroup(groupId, msg, exclude = null) {
  broadcastToRoom(groupId, msg, exclude);
}

function broadcastToRoom(roomName, msg, exclude = null) {
  const room = rooms.get(roomName);
  if (!room) return;
  const payload = JSON.stringify(msg);
  for (const client of room) {
    if (client !== exclude && isOpenSocket(client)) {
      client.send(payload);
    }
  }
}

function disconnectUser(userId, reason = 'admin_disconnect') {
  const socket = userSockets.get(userId);
  if (!socket) return;
  try {
    socket.send(JSON.stringify({ type: 'error', message: 'Session closed by admin' }));
  } catch (err) {
    console.warn('[WS] Failed to notify user before disconnect:', err.message);
  }
  socket.close(4001, reason);
  userSockets.delete(userId);
}

module.exports = {
  setupWebSocket,
  broadcastToGroup,
  broadcastToRoom,
  disconnectUser,
  getGroupMemberPresence,
};
