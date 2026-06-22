const { WebSocketServer } = require('ws');
const { pool } = require('../config/db');

// In-memory room registry: groupId → Set<ws>
const rooms = new Map();
// User → ws mapping
const userSockets = new Map();
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
  switch (msg.type) {
    case 'join': {
      try {
        const userRecord = await ensureUserAllowed(msg.userId);
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
        userSockets.set(msg.userId, ws);
        room.add(ws);
        speakerSeq.set(msg.userId, 0);

        broadcastToGroup(msg.groupId, {
          type: 'member_joined',
          userId: msg.userId,
          name: ws.name,
        }, ws);

        ws.send(JSON.stringify({ type: 'joined', groupId: msg.groupId }));
      } catch (err) {
        if (err.code === 'user_banned') {
          ws.send(JSON.stringify({ type: 'error', message: 'Account banned' }));
          ws.close(4001, 'banned');
          return;
        }
        ws.send(JSON.stringify({ type: 'error', message: 'Unable to join room' }));
        ws.close(1011, 'join_failed');
      }
      break;
    }

    case 'location': {
      broadcastToGroup(msg.groupId, {
        type: 'location',
        userId: msg.userId,
        lat: msg.lat,
        lng: msg.lng,
        ts: Date.now(),
      }, ws);

      try {
        await pool.query(
          `INSERT INTO locations (user_id, group_id, lat, lng, updated_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (user_id) DO UPDATE
           SET group_id = excluded.group_id,
               lat = excluded.lat,
               lng = excluded.lng,
               updated_at = now()`,
          [msg.userId, msg.groupId, msg.lat, msg.lng]
        );
      } catch (err) {
        console.error('[WS] Location persistence failed:', err.message);
      }
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
  if (ws.userId) {
    userSockets.delete(ws.userId);
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
      name: ws.name,
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
  const room = rooms.get(groupId);
  if (!room) return;
  const payload = JSON.stringify(msg);
  for (const client of room) {
    if (client !== exclude && client.readyState === 1) {
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

module.exports = { setupWebSocket, broadcastToGroup, disconnectUser };
