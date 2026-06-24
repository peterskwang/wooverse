const TOKEN_HOLD_MS = 30_000;
const DEFAULT_CHANNEL_ID = 'general';

const groupChannels = new Map();

function nowIso() {
  return new Date().toISOString();
}

function createChannelState(channelId, name = channelId) {
  return {
    id: channelId,
    name,
    createdAt: nowIso(),
    tokenHolder: null,
    queue: [],
    mutedUsers: new Set(),
    holdTimer: null,
  };
}

function ensureGroupState(groupId) {
  if (!groupChannels.has(groupId)) {
    groupChannels.set(groupId, {
      channels: new Map([[DEFAULT_CHANNEL_ID, createChannelState(DEFAULT_CHANNEL_ID, 'General')]]),
    });
  }
  return groupChannels.get(groupId);
}

function getChannelState(groupId, channelId = DEFAULT_CHANNEL_ID) {
  const group = ensureGroupState(groupId);
  const existing = group.channels.get(channelId);
  if (existing) return existing;
  return null;
}

function clearHoldTimer(channel) {
  if (channel.holdTimer) {
    clearTimeout(channel.holdTimer);
    channel.holdTimer = null;
  }
}

function createQueueEntry(userId, name) {
  return {
    userId,
    name: name || 'Teammate',
    requestedAt: nowIso(),
  };
}

function snapshotChannel(channel) {
  return {
    id: channel.id,
    name: channel.name,
    created_at: channel.createdAt,
    is_default: channel.id === DEFAULT_CHANNEL_ID,
    token_holder: channel.tokenHolder
      ? {
          user_id: channel.tokenHolder.userId,
          name: channel.tokenHolder.name,
          granted_at: channel.tokenHolder.grantedAt,
          expires_at: channel.tokenHolder.expiresAt,
        }
      : null,
    queue: channel.queue.map((entry, index) => ({
      user_id: entry.userId,
      name: entry.name,
      position: index + 1,
      requested_at: entry.requestedAt,
    })),
    queue_length: channel.queue.length,
    muted_users: [...channel.mutedUsers],
  };
}

function listChannels(groupId) {
  const group = ensureGroupState(groupId);
  return [...group.channels.values()]
    .map((channel) => snapshotChannel(channel))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function armHoldTimer(groupId, channelId, onTimeout) {
  const channel = getChannelState(groupId, channelId);
  if (!channel || !channel.tokenHolder) return;
  clearHoldTimer(channel);
  channel.holdTimer = setTimeout(() => {
    onTimeout?.({ groupId, channelId, userId: channel.tokenHolder?.userId || null });
  }, TOKEN_HOLD_MS);
}

function grantToken(groupId, channelId, userId, name, onTimeout) {
  const channel = getChannelState(groupId, channelId);
  if (!channel) {
    return { denied: true, reason: 'channel_not_found', channel_id: channelId };
  }
  const grantedAt = nowIso();
  const expiresAt = new Date(Date.now() + TOKEN_HOLD_MS).toISOString();
  channel.tokenHolder = { userId, name: name || 'Teammate', grantedAt, expiresAt };
  armHoldTimer(groupId, channelId, onTimeout);
  return {
    granted: true,
    queued: false,
    user_id: userId,
    channel_id: channelId,
    granted_at: grantedAt,
    expires_at: expiresAt,
    queue_length: channel.queue.length,
  };
}

function requestToken({ groupId, channelId = DEFAULT_CHANNEL_ID, userId, name, onTimeout }) {
  const channel = getChannelState(groupId, channelId);
  if (!channel) {
    return { denied: true, reason: 'channel_not_found', channel_id: channelId };
  }
  if (channel.mutedUsers.has(userId)) {
    return { denied: true, reason: 'muted', channel_id: channelId };
  }

  if (!channel.tokenHolder) {
    return grantToken(groupId, channelId, userId, name, onTimeout);
  }

  if (channel.tokenHolder.userId === userId) {
    return {
      granted: true,
      queued: false,
      user_id: userId,
      channel_id: channelId,
      granted_at: channel.tokenHolder.grantedAt,
      expires_at: channel.tokenHolder.expiresAt,
      queue_length: channel.queue.length,
      already_holding: true,
    };
  }

  const existingIndex = channel.queue.findIndex((entry) => entry.userId === userId);
  if (existingIndex !== -1) {
    return {
      granted: false,
      queued: true,
      channel_id: channelId,
      position: existingIndex + 1,
      queue_length: channel.queue.length,
    };
  }

  channel.queue.push(createQueueEntry(userId, name));
  return {
    granted: false,
    queued: true,
    channel_id: channelId,
    position: channel.queue.length,
    queue_length: channel.queue.length,
  };
}

function releaseToken({ groupId, channelId = DEFAULT_CHANNEL_ID, userId, force = false, reason = 'released', onTimeout }) {
  const channel = getChannelState(groupId, channelId);
  if (!channel) {
    return { released: false, channel_id: channelId };
  }

  const removedFromQueue = channel.queue.some((entry) => entry.userId === userId);
  if (removedFromQueue) {
    channel.queue = channel.queue.filter((entry) => entry.userId !== userId);
  }

  const holder = channel.tokenHolder;
  if (!holder) {
    return {
      released: removedFromQueue,
      channel_id: channelId,
      queue_length: channel.queue.length,
    };
  }
  if (!force && holder.userId !== userId) {
    return {
      released: removedFromQueue,
      denied: true,
      reason: 'not_holder',
      channel_id: channelId,
      queue_length: channel.queue.length,
    };
  }

  const releasedHolder = channel.tokenHolder;
  channel.tokenHolder = null;
  clearHoldTimer(channel);

  let nextGranted = null;
  while (channel.queue.length > 0 && !nextGranted) {
    const next = channel.queue.shift();
    if (!next || channel.mutedUsers.has(next.userId)) continue;
    nextGranted = grantToken(groupId, channelId, next.userId, next.name, onTimeout);
  }

  return {
    released: true,
    channel_id: channelId,
    released_user_id: releasedHolder.userId,
    reason,
    queue_length: channel.queue.length,
    next_granted: nextGranted,
  };
}

function isTokenHolder(groupId, channelId = DEFAULT_CHANNEL_ID, userId) {
  const channel = getChannelState(groupId, channelId);
  return Boolean(channel?.tokenHolder?.userId === userId);
}

function getCurrentHolder(groupId, channelId = DEFAULT_CHANNEL_ID) {
  const channel = getChannelState(groupId, channelId);
  return channel?.tokenHolder || null;
}

function createChannel(groupId, channelId, name) {
  if (!channelId || channelId === DEFAULT_CHANNEL_ID) {
    return { created: false, reason: channelId === DEFAULT_CHANNEL_ID ? 'exists' : 'invalid_channel_id' };
  }
  const group = ensureGroupState(groupId);
  if (group.channels.has(channelId)) {
    return { created: false, reason: 'exists' };
  }
  const channel = createChannelState(channelId, name || channelId);
  group.channels.set(channelId, channel);
  return { created: true, channel: snapshotChannel(channel) };
}

function deleteChannel(groupId, channelId) {
  if (channelId === DEFAULT_CHANNEL_ID) {
    return { deleted: false, reason: 'default_channel_locked' };
  }
  const group = ensureGroupState(groupId);
  const channel = group.channels.get(channelId);
  if (!channel) {
    return { deleted: false, reason: 'not_found' };
  }
  clearHoldTimer(channel);
  group.channels.delete(channelId);
  return { deleted: true };
}

function muteUser(groupId, channelId, userId, onTimeout) {
  const channel = getChannelState(groupId, channelId);
  if (!channel) {
    return { muted: false, reason: 'channel_not_found', channel_id: channelId };
  }
  channel.mutedUsers.add(userId);
  channel.queue = channel.queue.filter((entry) => entry.userId !== userId);
  const wasHolder = channel.tokenHolder?.userId === userId;
  let rotation = null;
  if (wasHolder) {
    rotation = releaseToken({
      groupId,
      channelId,
      userId,
      force: true,
      reason: 'admin_muted',
      onTimeout,
    });
  }
  return {
    muted: true,
    channel_id: channelId,
    user_id: userId,
    queue_length: channel.queue.length,
    rotation,
  };
}

function unmuteUser(groupId, channelId, userId) {
  const channel = getChannelState(groupId, channelId);
  if (!channel) {
    return { unmuted: false, reason: 'channel_not_found', channel_id: channelId };
  }
  channel.mutedUsers.delete(userId);
  return {
    unmuted: true,
    channel_id: channelId,
    user_id: userId,
  };
}

function forceRotate(groupId, channelId, onTimeout) {
  const channel = getChannelState(groupId, channelId);
  if (!channel?.tokenHolder) {
    return { rotated: false, reason: 'no_holder', channel_id: channelId };
  }
  const rotation = releaseToken({
    groupId,
    channelId,
    userId: channel.tokenHolder.userId,
    force: true,
    reason: 'admin_force_rotate',
    onTimeout,
  });
  return {
    rotated: true,
    channel_id: channelId,
    rotation,
  };
}

function releaseUserFromAll(groupId, userId, onTimeout) {
  const group = groupChannels.get(groupId);
  if (!group) return [];
  const releases = [];
  for (const channel of group.channels.values()) {
    if (channel.tokenHolder?.userId === userId || channel.queue.some((entry) => entry.userId === userId)) {
      const release = releaseToken({
        groupId,
        channelId: channel.id,
        userId,
        force: true,
        reason: 'disconnect',
        onTimeout,
      });
      releases.push(release);
    }
  }
  return releases;
}

module.exports = {
  DEFAULT_CHANNEL_ID,
  TOKEN_HOLD_MS,
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
};
