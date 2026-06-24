const { WebSocketServer } = require('ws');
const { pool } = require('../config/db');
const { WebSocketServer } = require('ws');
const { pool } = require('../config/db');
const {
  DEFAULT_CHANNEL_ID,
  listChannels,
  requestToken,
  releaseToken,
  isTokenHolder,
  getCurrentHolder,
  createChannel,
  deleteChannel,
  muteUser,
  unmuteUser,
  forceRotate,
  releaseUserFromAll,
} = require('./channels');
const { triggerSos, acknowledgeSos, resolveSos, FALLBACK_AFTER_MS, setSosBroadcaster } = require('./sos');

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
function safeSend(socket, payload) {
  if (!isOpenSocket(socket)) return;
  socket.send(JSON.stringify(payload));
}

function resolveChannelId(msg) {
  if (typeof msg.channelId === 'string' && msg.channelId.trim()) {
    return msg.channelId.trim();
  }
  return DEFAULT_CHANNEL_ID;
}

function emitChannelsSnapshot(groupId, target = null) {
  const payload = {
    type: target ? 'admin_channels_snapshot' : 'channels_snapshot',
    group_id: groupId,
    channels: listChannels(groupId),
  };
  if (target) {
    safeSend(target, payload);
    return;
  }
  broadcastToGroup(groupId, payload);
}

function emitTokenGranted(groupId, channelId, granted) {
  const holderName = getCurrentHolder(groupId, channelId)?.name || null;
  broadcastToGroup(groupId, {
    type: 'ptt_granted',
    groupId,
    channelId,
    userId: granted.user_id,
    user_id: granted.user_id,
    name: holderName,
    granted_at: granted.granted_at,
    expires_at: granted.expires_at,
    queue_length: granted.queue_length ?? 0,
  });

  if (channelId === DEFAULT_CHANNEL_ID) {
    broadcastToGroup(groupId, {
      type: 'ptt_start',
      userId: granted.user_id,
      user_id: granted.user_id,
      name: holderName,
    });
  }
}

function emitTokenRelease(groupId, channelId, release) {
  if (!release?.released) return;
  broadcastToGroup(groupId, {
    type: 'ptt_released',
    groupId,
    channelId,
    userId: release.released_user_id,
    user_id: release.released_user_id,
    reason: release.reason,
    queue_length: release.queue_length ?? 0,
  });

  if (channelId === DEFAULT_CHANNEL_ID) {
    broadcastToGroup(groupId, {
      type: 'ptt_end',
      userId: release.released_user_id,
      user_id: release.released_user_id,
    });
  }

  if (release.next_granted?.granted) {
    emitTokenGranted(groupId, channelId, release.next_granted);
  }
}

function handleTokenTimeout({ groupId, channelId, userId }) {
  if (!groupId || !channelId || !userId) return;
  // Notify the timed-out holder first
  const socket = getRoomSocket(groupId, userId) || userSockets.get(userId);
  safeSend(socket, {
    type: 'ptt_timeout',
    channelId,
    userId,
    reason: 'max_hold_duration',
  });
  // Broadcast timeout to the channel so everyone knows
  broadcastToGroup(groupId, {
    type: 'ptt_timeout',
    channelId,
    userId,
    reason: 'max_hold_duration',
  });
  const release = releaseToken({
    groupId,
    channelId,
    userId,
    force: true,
    reason: 'token_timeout',
    onTimeout: handleTokenTimeout,
  });
  emitTokenRelease(groupId, channelId, release);
  emitChannelsSnapshot(groupId);
}

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
      if (!msg.admin_user_id || !UUID_RE.test(msg.admin_user_id)) {
        ws.send(JSON.stringify({ type: 'error', message: 'admin_user_id required' }));
        return;
      }
      if (!rooms.has('admin')) rooms.set('admin', new Set());
      rooms.get('admin').add(ws);
      ws.adminRoom = true;
      ws.adminUserId = msg.admin_user_id;
      ws.send(JSON.stringify({ type: 'joined', room: 'admin', admin_user_id: msg.admin_user_id }));
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
        ws.channelId = DEFAULT_CHANNEL_ID;
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
        safeSend(ws, {
          type: 'channels_snapshot',
          group_id: msg.groupId,
          channels: listChannels(msg.groupId),
        });

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

    case 'channels_list': {
      if (!ws.groupId) {
        ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
        return;
      }
      safeSend(ws, {
        type: 'channels_snapshot',
        group_id: ws.groupId,
        channels: listChannels(ws.groupId),
      });
      break;
    }

    case 'channel_create': {
      if (!ws.userId || !ws.groupId) {
        ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
        return;
      }
      if (!msg.name || typeof msg.name !== 'string' || !msg.name.trim()) {
        ws.send(JSON.stringify({ type: 'error', message: 'channel name required' }));
        return;
      }
      const channelId = msg.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      const result = createChannel(ws.groupId, channelId, msg.name.trim());
      safeSend(ws, {
        type: result.created ? 'channel_created' : 'error',
        channel_id: channelId,
        group_id: ws.groupId,
        name: msg.name.trim(),
        reason: result.reason || null,
      });
      if (result.created) {
        broadcastToGroup(ws.groupId, {
          type: 'channel_created',
          channel_id: channelId,
          group_id: ws.groupId,
          name: msg.name.trim(),
        });
        emitChannelsSnapshot(ws.groupId);
      }
      break;
    }

    case 'channel_join': {
      if (!ws.userId || !ws.groupId) {
        ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
        return;
      }
      const joinChannelId = resolveChannelId(msg);
      const exists = listChannels(ws.groupId).some((channel) => channel.id === joinChannelId);
      if (!exists) {
        safeSend(ws, {
          type: 'error',
          message: 'channel_not_found',
          channel_id: joinChannelId,
        });
        return;
      }
      ws.channelId = joinChannelId;
      safeSend(ws, {
        type: 'channel_joined',
        channel_id: joinChannelId,
        group_id: ws.groupId,
        channels: listChannels(ws.groupId),
      });
      break;
    }

    case 'channel_leave': {
      if (!ws.userId || !ws.groupId) {
        ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
        return;
      }
      const leaveChannelId = resolveChannelId(msg);
      if (leaveChannelId === DEFAULT_CHANNEL_ID) {
        safeSend(ws, { type: 'error', message: 'cannot leave general channel' });
        return;
      }
      if (isTokenHolder(ws.groupId, leaveChannelId, ws.userId)) {
        releaseToken({
          groupId: ws.groupId,
          channelId: leaveChannelId,
          userId: ws.userId,
          force: true,
          reason: 'left_channel',
          onTimeout: handleTokenTimeout,
        });
      }
      ws.channelId = DEFAULT_CHANNEL_ID;
      safeSend(ws, {
        type: 'channel_left',
        channel_id: leaveChannelId,
        group_id: ws.groupId,
      });
      emitChannelsSnapshot(ws.groupId);
      break;
    }

    case 'channel_switch': {
      if (!ws.userId || !ws.groupId) {
        ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
        return;
      }
      const switchChannelId = resolveChannelId(msg);
      const switchExists = listChannels(ws.groupId).some((channel) => channel.id === switchChannelId);
      if (!switchExists) {
        safeSend(ws, { type: 'error', message: 'channel_not_found', channel_id: switchChannelId });
        return;
      }
      const oldChannelId = ws.channelId || DEFAULT_CHANNEL_ID;
      if (oldChannelId === switchChannelId) {
        safeSend(ws, { type: 'channel_joined', channel_id: switchChannelId, group_id: ws.groupId });
        return;
      }
      if (isTokenHolder(ws.groupId, oldChannelId, ws.userId)) {
        releaseToken({
          groupId: ws.groupId,
          channelId: oldChannelId,
          userId: ws.userId,
          force: true,
          reason: 'switched_channel',
          onTimeout: handleTokenTimeout,
        });
      }
      ws.channelId = switchChannelId;
      safeSend(ws, {
        type: 'channel_joined',
        channel_id: switchChannelId,
        group_id: ws.groupId,
        channels: listChannels(ws.groupId),
      });
      emitChannelsSnapshot(ws.groupId);
      break;
    }

    case 'channel_select': {
      if (!ws.groupId) {
        ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
        return;
      }
      const selChannelId = resolveChannelId(msg);
      const selExists = listChannels(ws.groupId).some((channel) => channel.id === selChannelId);
      if (!selExists) {
        safeSend(ws, {
          type: 'error',
          message: 'channel_not_found',
          channel_id: selChannelId,
        });
        return;
      }
      ws.channelId = channelId;
      safeSend(ws, {
        type: 'channel_selected',
        group_id: ws.groupId,
        channel_id: channelId,
      });
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

    case 'ptt_request': {
      if (!ws.userId || !ws.groupId) {
        ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
        return;
      }
      const channelId = resolveChannelId(msg);
      ws.channelId = channelId;
      const result = requestToken({
        groupId: ws.groupId,
        channelId,
        userId: ws.userId,
        name: ws.name,
        onTimeout: handleTokenTimeout,
      });

      if (result.denied) {
        safeSend(ws, {
          type: 'ptt_denied',
          channel_id: channelId,
          reason: result.reason,
        });
        if (result.reason === 'muted') {
          safeSend(ws, {
            type: 'ptt_force_release',
            channel_id: channelId,
            reason: 'admin_muted',
          });
        }
        break;
      }

      if (result.granted) {
        emitTokenGranted(ws.groupId, channelId, result);
      } else if (result.queued) {
        safeSend(ws, {
          type: 'ptt_queued',
          groupId: ws.groupId,
          channelId,
          userId: ws.userId,
          position: result.position,
          queue_length: result.queue_length ?? result.position,
        });
      }

      emitChannelsSnapshot(ws.groupId);
      break;
    }

    case 'ptt_start': {
      // Backward compatible: old PTT clients that don't know about channels
      if (!ws.userId || !ws.groupId) {
        ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
        return;
      }
      const channelId = DEFAULT_CHANNEL_ID;
      ws.channelId = channelId;
      const result = requestToken({
        groupId: ws.groupId,
        channelId,
        userId: ws.userId,
        name: ws.name,
        onTimeout: handleTokenTimeout,
      });

      if (result.denied) {
        safeSend(ws, { type: 'ptt_busy', userId: ws.userId });
        break;
      }

      if (result.granted) {
        safeSend(ws, { type: 'ptt_granted', channelId: DEFAULT_CHANNEL_ID, userId: ws.userId });
        broadcastToGroup(ws.groupId, { type: 'ptt_start', userId: ws.userId, name: ws.name }, ws);
      } else if (result.queued) {
        // Old clients: respond with ptt_busy so they don't leave mic on
        safeSend(ws, { type: 'ptt_busy', userId: ws.userId });
      }
      break;
    }

    case 'ptt_release': {
      if (!ws.userId || !ws.groupId) {
        ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
        return;
      }
      const channelId = resolveChannelId(msg);
      const release = releaseToken({
        groupId: ws.groupId,
        channelId,
        userId: ws.userId,
        force: false,
        reason: 'released',
        onTimeout: handleTokenTimeout,
      });
      emitTokenRelease(ws.groupId, channelId, release);
      emitChannelsSnapshot(ws.groupId);
      break;
    }

    case 'ptt_end': {
      // Backward compatible: old PTT release
      if (!ws.userId || !ws.groupId) {
        ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
        return;
      }
      const release = releaseToken({
        groupId: ws.groupId,
        channelId: DEFAULT_CHANNEL_ID,
        userId: ws.userId,
        force: false,
        reason: 'released',
        onTimeout: handleTokenTimeout,
      });
      if (release.released) {
        broadcastToGroup(ws.groupId, { type: 'ptt_end', userId: ws.userId }, ws);
        if (release.next_granted?.granted) {
          broadcastToGroup(ws.groupId, { type: 'ptt_start', userId: release.next_granted.user_id, name: release.next_granted.name || 'Teammate' });
        }
      }
      emitChannelsSnapshot(ws.groupId);
      break;
    }

    case 'audio_chunk': {
      const channelId = resolveChannelId(msg);
      // Only the channel token holder may send audio.
      if (!isTokenHolder(ws.groupId, channelId, ws.userId)) {
        break;
      }
      const nextSeq = (speakerSeq.get(ws.userId) || 0) + 1;
      speakerSeq.set(ws.userId, nextSeq);
      broadcastToGroup(ws.groupId, {
        type: 'audio_chunk',
        channelId,
        userId: ws.userId,
        user_id: ws.userId,
        data: msg.data,
        seqNum: nextSeq,
      }, ws);
      break;
    }

    case 'admin_list_channels': {
      if (!ws.adminRoom) {
        ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
        return;
      }
      if (!msg.groupId) {
        ws.send(JSON.stringify({ type: 'error', message: 'groupId required' }));
        return;
      }
      emitChannelsSnapshot(msg.groupId, ws);
      break;
    }

    case 'admin_mute_user': {
      if (!ws.adminRoom) {
        ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
        return;
      }
      if (!msg.groupId || !msg.userId) {
        ws.send(JSON.stringify({ type: 'error', message: 'groupId and userId required' }));
        return;
      }
      const channelId = resolveChannelId(msg);
      const muted = msg.muted !== false; // true by default for backward compat
      if (muted) {
        const result = muteUser(msg.groupId, channelId, msg.userId, handleTokenTimeout);
        if (!result.muted) {
          safeSend(ws, {
            type: 'admin_user_muted',
            group_id: msg.groupId,
            channel_id: channelId,
            user_id: msg.userId,
            muted: false,
            reason: result.reason || 'failed',
          });
          return;
        }
        safeSend(ws, {
          type: 'admin_user_muted',
          group_id: msg.groupId,
          channel_id: channelId,
          user_id: msg.userId,
          muted: true,
        });
        broadcastToGroup(msg.groupId, {
          type: 'user_muted',
          groupId: msg.groupId,
          channelId,
          userId: msg.userId,
          user_id: msg.userId,
          reason: 'admin',
        });
        const targetSocket = getRoomSocket(msg.groupId, msg.userId) || userSockets.get(msg.userId);
        safeSend(targetSocket, {
          type: 'user_muted',
          channelId,
          reason: 'admin',
        });
        if (result.rotation?.released) {
          emitTokenRelease(msg.groupId, channelId, result.rotation);
        }
      } else {
        // Unmute
        const unmuteResult = unmuteUser(msg.groupId, channelId, msg.userId);
        safeSend(ws, {
          type: 'admin_user_muted',
          group_id: msg.groupId,
          channel_id: channelId,
          user_id: msg.userId,
          muted: false,
          unmuted: unmuteResult?.unmuted ?? true,
        });
        broadcastToGroup(msg.groupId, {
          type: 'user_unmuted',
          groupId: msg.groupId,
          channelId,
          userId: msg.userId,
          user_id: msg.userId,
        });
        const unmuteTarget = getRoomSocket(msg.groupId, msg.userId) || userSockets.get(msg.userId);
        safeSend(unmuteTarget, {
          type: 'user_unmuted',
          channelId,
        });
      }
      emitChannelsSnapshot(msg.groupId);
      break;
    }

    case 'admin_force_rotate': {
      if (!ws.adminRoom) {
        ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
        return;
      }
      if (!msg.groupId) {
        ws.send(JSON.stringify({ type: 'error', message: 'groupId required' }));
        return;
      }
      const channelId = resolveChannelId(msg);
      const result = forceRotate(msg.groupId, channelId, handleTokenTimeout);
      safeSend(ws, {
        type: 'admin_force_rotated',
        group_id: msg.groupId,
        channel_id: channelId,
        rotated: result.rotated,
      });
      if (result.rotation?.released) {
        emitTokenRelease(msg.groupId, channelId, result.rotation);
      }
      emitChannelsSnapshot(msg.groupId);
      break;
    }

    case 'admin_delete_channel': {
      if (!ws.adminRoom) {
        ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
        return;
      }
      if (!msg.groupId) {
        ws.send(JSON.stringify({ type: 'error', message: 'groupId required' }));
        return;
      }
      const channelId = resolveChannelId(msg);
      const holder = getCurrentHolder(msg.groupId, channelId);
      const result = deleteChannel(msg.groupId, channelId);
      safeSend(ws, {
        type: 'admin_channel_deleted',
        group_id: msg.groupId,
        channel_id: channelId,
        deleted: result.deleted,
        reason: result.reason || null,
      });
      if (!result.deleted) {
        break;
      }
      if (holder?.userId) {
        const holderSocket = getRoomSocket(msg.groupId, holder.userId) || userSockets.get(holder.userId);
        safeSend(holderSocket, {
          type: 'ptt_force_release',
          channel_id: channelId,
          reason: 'channel_deleted',
        });
      }
      broadcastToGroup(msg.groupId, {
        type: 'channel_deleted',
        groupId: msg.groupId,
        channelId,
      });
      emitChannelsSnapshot(msg.groupId);
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

    case 'sos_trigger': {
      if (!ws.userId) {
        ws.send(JSON.stringify({ type: 'sos_error', code: 'unauthorized', message: 'Join a group first' }));
        return;
      }

      const groupId = msg.group_id || ws.groupId;
      try {
        const event = await triggerSos({
          userId: ws.userId,
          groupId,
          lat: msg.lat,
          lng: msg.lng,
          timestamp: msg.client_timestamp,
          source: 'ws',
        });
        ws.send(JSON.stringify({
          type: 'sos_triggered',
          sos_id: event.sos_id,
          group_id: event.group_id,
          triggered_at: event.triggered_at,
          fallback_after_ms: FALLBACK_AFTER_MS,
        }));
      } catch (err) {
        ws.send(JSON.stringify({
          type: 'sos_error',
          code: err.code || 'sos_trigger_failed',
          message: err.message || 'Failed to trigger SOS',
        }));
      }
      break;
    }

    case 'sos_acknowledge': {
      if (!ws.adminRoom) {
        ws.send(JSON.stringify({ type: 'sos_error', code: 'unauthorized', message: 'Admin room required' }));
        return;
      }

      const adminUserId = msg.admin_user_id || ws.adminUserId;
      try {
        const event = await acknowledgeSos({
          sosId: msg.sos_id,
          adminUserId,
        });
        ws.send(JSON.stringify({
          type: 'sos_acknowledge_ok',
          sos_id: event.sos_id,
          acknowledged_at: event.acknowledged_at,
        }));
      } catch (err) {
        ws.send(JSON.stringify({
          type: 'sos_error',
          code: err.code || 'sos_acknowledge_failed',
          message: err.message || 'Failed to acknowledge SOS',
        }));
      }
      break;
    }

    case 'sos_resolve': {
      if (!ws.adminRoom) {
        ws.send(JSON.stringify({ type: 'sos_error', code: 'unauthorized', message: 'Admin room required' }));
        return;
      }

      const adminUserId = msg.admin_user_id || ws.adminUserId;
      try {
        const event = await resolveSos({
          sosId: msg.sos_id,
          adminUserId,
        });
        ws.send(JSON.stringify({
          type: 'sos_resolve_ok',
          sos_id: event.sos_id,
          resolved_at: event.resolved_at,
        }));
      } catch (err) {
        ws.send(JSON.stringify({
          type: 'sos_error',
          code: err.code || 'sos_resolve_failed',
          message: err.message || 'Failed to resolve SOS',
        }));
      }
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
    if (ws.groupId) {
      const releases = releaseUserFromAll(ws.groupId, ws.userId, handleTokenTimeout);
      releases.forEach((release) => {
        emitTokenRelease(ws.groupId, release.channel_id || DEFAULT_CHANNEL_ID, release);
      });
      emitChannelsSnapshot(ws.groupId);
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

setSosBroadcaster({
  broadcastToGroup,
  broadcastToRoom,
});

module.exports = {
  setupWebSocket,
  broadcastToGroup,
  broadcastToRoom,
  disconnectUser,
  getGroupMemberPresence,
};
