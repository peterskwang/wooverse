# Phase 3: PTT Intercom Upgrade — Channel System, Token Queue, Admin Controls

Date: 2026-06-24

Issue: #74

Grounding from main (b4bba29):
- `backend/src/services/ws.js`: group rooms, `channelFloor` per group, PTT floor lock, WebRTC signal relay, `client_ping`, `broadcastToRoom`, admin room
- `frontend/app/(tabs)/intercom.tsx`: PTT hold-to-talk, always-on mode with fallback, signal quality indicator, WebRTC group audio
- `frontend/app/services/groupAudio.ts`: `GroupAudioManager` with peer lifecycle, `setMicEnabled`, `setSignalTier`, `bitrateForSignalTier`
- `admin/src/pages/sos.tsx`: Leaflet map, admin WS, resolve flow — pattern to follow for admin channel controls

## Architecture Decisions

### 1. Channel System

Channels live within a group. One group has N channels. At connection time, users join a default "general" channel. They can switch channels without leaving the WS room.

Channel state is **server-authoritative** — maintained in `backend/src/services/channels.js`, persisted in-memory only (no DB table). If server restarts, channels reset to default.

Channel data structure:
```js
{
  channelId: string (uuid),
  groupId: string,
  name: string,
  createdBy: string (userId),
  created_at: ISO string,
  users: Set<string> (userIds in channel),
  floorHolder: string | null,  // replaced by token queue
}
```

### 2. Token-Based PTT Queue

Replaces the simple `channelFloor` boolean. A queue of userIds waiting to speak.

Rules:
- Only one speaker per channel at a time
- When floor is released, token passes to next userId in queue (FIFO)
- If queue is empty, floor is free (any member can grab it)
- Token holder has max 30s before forced rotation (prevents starvation)
- Admin can force-rotate token

WS message flow:
```
Client -> Server: { type: 'ptt_request', channelId }
Server -> Client: { type: 'ptt_granted', channelId }  // if floor free & client first in queue
Server -> Client: { type: 'ptt_queued', channelId, position: N }  // if queued
Client -> Server: { type: 'ptt_release', channelId }
Server -> All in channel: { type: 'ptt_granted', channelId, userId }
```

### 3. Admin Controls

New admin page: `admin/src/pages/channels.tsx`
- View all channels per group
- Select group → see channel list with user counts, floor holder
- Mute/unmute individual users per channel
- Force-rotate PTT token
- Delete channels (not "general")

Admin WS message types:
```json
{ "type": "admin_list_channels", "groupId": "uuid" }
{ "type": "channel_list", "groupId": "uuid", "channels": [...] }
{ "type": "admin_mute_user", "channelId": "uuid", "userId": "uuid", "muted": true }
{ "type": "admin_force_rotate", "channelId": "uuid" }
```

### 4. Backward Compatibility

- Default "general" channel mimics current behavior
- `ptt_start` / `ptt_end` still work — mapped to general channel
- `channelFloor` still used as fallback for general channel
- Existing PTT busy behavior preserved

## Data Flow

```
User A presses PTT
  → ws.send({ type: 'ptt_request', channelId: 'general' })
  → Server checks token queue for 'general'
    → If free: grant immediately, broadcast ptt_granted to channel
    → If held: add to queue, reply ptt_queued(position: N)
  
User A releases PTT
  → ws.send({ type: 'ptt_release', channelId: 'general' })
  → Server dequeues next, grants them the floor
  → If queue empty: broadcast ptt_channel_clear to channel

Admin mutes User B
  → ws.send({ type: 'admin_mute_user', channelId, userId, muted: true })
  → Server removes B from token queue, forces mic disabled
  → Server notifies B: { type: 'user_muted', channelId, reason: 'admin' }
```

## WS Message Contracts (New)

### Channel CRUD
```json
// Create
{ "type": "channel_create", "name": "Racing", "groupId": "uuid" }
{ "type": "channel_created", "channelId": "uuid", "name": "Racing", "groupId": "uuid" }

// List
{ "type": "channel_list", "groupId": "uuid" }
{ "type": "channel_list", "groupId": "uuid", "channels": [{ channelId, name, userCount, floorHolder }] }

// Join
{ "type": "channel_join", "channelId": "uuid" }
{ "type": "channel_joined", "channelId": "uuid", "name": "Racing", "members": [...] }

// Leave (reverts to general)
{ "type": "channel_leave", "channelId": "uuid" }
{ "type": "channel_left", "channelId": "uuid" }

// Switch (atomic leave+join)
{ "type": "channel_switch", "fromChannelId": "uuid", "toChannelId": "uuid" }
```

### Token Queue
```json
// Request floor
{ "type": "ptt_request", "channelId": "uuid" }

// Granted
{ "type": "ptt_granted", "channelId": "uuid", "userId": "uuid", "name": "Alice" }

// Queued
{ "type": "ptt_queued", "channelId": "uuid", "position": 2 }

// Release
{ "type": "ptt_release", "channelId": "uuid" }

// Clear (no queue)
{ "type": "ptt_channel_clear", "channelId": "uuid" }

// Max duration exceeded — forced rotate
{ "type": "ptt_timeout", "channelId": "uuid" }
```

### Admin
```json
{ "type": "admin_list_channels", "groupId": "uuid" }
{ "type": "admin_channel_list", "groupId": "uuid", "channels": [...] }
{ "type": "admin_mute_user", "channelId": "uuid", "userId": "uuid", "muted": true }
{ "type": "user_muted", "channelId": "uuid", "reason": "admin" }
{ "type": "admin_force_rotate", "channelId": "uuid" }
{ "type": "admin_delete_channel", "channelId": "uuid" }
```

## Implementation Plan (4 files)

### 1. `backend/src/services/channels.js` (NEW)
- Channel state map: `Map<groupId, Map<channelId, Channel>>`
- Functions: `createChannel`, `deleteChannel`, `joinChannel`, `leaveChannel`, `getChannels`
- Token queue per channel: `Map<channelId, TokenQueue>`
- Functions: `requestFloor`, `releaseFloor`, `grantNext`, `forceRotate`, `muteUser`
- Export all for `ws.js` to call

### 2. `backend/src/services/ws.js` (MODIFY)
- Add channel message handlers: `channel_create`, `channel_join`, `channel_leave`, `channel_switch`
- Replace `ptt_start`/`ptt_end` with token-based `ptt_request`/`ptt_release` (keep old handlers as fallback for general channel)
- Add `channel_list` handler
- Add admin channel handlers: `admin_list_channels`, `admin_mute_user`, `admin_force_rotate`, `admin_delete_channel`
- On disconnect: release any held floor token from any channel

### 3. `frontend/app/(tabs)/intercom.tsx` (MODIFY)
- Add channel picker UI (dropdown / bottom sheet)
- Replace `startTalking`/`stopTalking` with token-based flow:
  - `startTalking` → send `ptt_request`
  - Wait for `ptt_granted` → enable mic
  - `stopTalking` → send `ptt_release`
- Show queue position badge when waiting
- Handle `ptt_timeout` — auto-release mic, show notification
- Handle `user_muted` — disable PTT, show banner
- Channel member list shows current channel only

### 4. `admin/src/pages/channels.tsx` (NEW)
- Group selector dropdown (or reuse from existing admin pages)
- Channel list table: name, user count, floor holder, active/inactive
- Per-user mute toggle
- Force-rotate button
- Delete channel button (with confirmation)
- Admin WS connection for real-time updates
- Leaflet not needed — this is a table/dashboard page

### Files NOT touched
- `groupAudio.ts` — unchanged, mic lifecycle stays the same
- `settings.tsx` — unchanged
- `ws.ts` (frontend) — add new type handlers, message type defs
- Database — no schema changes, in-memory only

## Edge Cases

- **Channel max**: 10 channels per group, 20 users per channel max
- **Token starvation**: 30s max hold, force-rotate fires `ptt_timeout`
- **Disconnect while holding token**: automatically release, grant next in queue
- **Race condition on join+request**: server serializes — join completes before queue processes
- **Admin delete general channel**: rejected — general is permanent
- **Empty channel**: auto-deleted after 5 min with 0 users (except general)
