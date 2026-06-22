# Phase 2 Core Architecture: PTT Intercom, GPS Broadcast, SOS Admin Resolve

Date: 2026-06-22

Issues:
- #3: Phase 2 Core Features - PTT Intercom + GPS Broadcast
- #47: SOS Admin Map + Resolve Flow (P1)

Grounding from current `main`:
- Backend runtime is `backend/src/index.js` with Express + `ws` on `/ws`; `backend/src/index.ts` contains a separate Fastify path that is not the active JS runtime.
- `backend/src/services/ws.js` already has group rooms, `join`, `location`, PTT floor lock, `audio_chunk`, SOS relay, goggle signaling, heartbeats, and reconnect-safe disconnect cleanup.
- `frontend/app/services/ws.ts` is the shared singleton for mobile WS; `intercom.tsx`, `map.tsx`, `location.ts`, and `backgroundLocation.ts` already use it.
- Mobile intercom currently records AAC files via Expo AV, then sends one base64 `audio_chunk` on release. It is not WebRTC/Opus yet.
- GPS already broadcasts `location` over WS and persists latest coordinates with an upsert; the map still relies on 10s REST polling and does not consume live `location` messages.
- Admin SOS page currently lists events only. Backend has user-auth `PATCH /api/sos/:id/resolve` but no admin resolve route.
- `docs/DECISIONS.md` keeps GPS as foreground-only unless Peter explicitly approves background GPS changes. The "always-on" intercom toggle below must not expand background GPS scope.

## Cross-Issue Dependency

#47 should land before #3 if both are built as separate PRs, because #47 adds the reusable `broadcastToRoom(roomName, message)` helper and admin room cleanup in `backend/src/services/ws.js`. #3 also touches `ws.js`, so building #3 after #47 avoids a WebSocket merge conflict and keeps the SOS P1 path stable.

There is no business dependency between SOS resolve and PTT/GPS, but there is a code dependency on the shared WS service. If implementation starts with #3, it should include the same `broadcastToRoom` shape so #47 can reuse it without rewriting.

## Issue #47 - SOS Admin Map + Resolve Flow

### Exact Files and Scope Boundaries

Backend:
- `backend/src/services/ws.js`: add authenticated admin room join, `broadcastToRoom`, admin-room cleanup, and broadcast to admin on SOS trigger/resolve.
- `backend/src/routes/admin.js`: add `PATCH /api/admin/sos/:id/resolve`.
- `backend/src/routes/sos.js`: after a mobile SOS is inserted, also broadcast a sanitized admin refresh/event to the `admin` room.
- `backend/tests/e2e/admin.test.js`: add admin resolve API coverage.
- `backend/tests/e2e/sos-runs.test.js`: extend or add a focused WS SOS flow test if the live test harness can run WS clients.

Admin frontend:
- `admin/src/api/adminApi.ts`: add `resolveSos(id)` and optionally expose a `getAdminPassword()` helper for WS auth.
- `admin/src/pages/sos.tsx`: add active map, resolve buttons, WS listener, loading/error states, and active-only map pins.
- `admin/src/pages/_app.tsx`: import Leaflet CSS if Leaflet is used.
- `admin/package.json` and `admin/package-lock.json`: add `leaflet`, `react-leaflet`, and `@types/leaflet`.
- `admin/next.config.js`: only change if Next build requires `transpilePackages` for `react-leaflet`; this is a config change and needs Peter approval before implementation.

Do not touch mobile app files for #47 except when adding optional client acknowledgment handling to an already SOS-related screen. Do not change database schema; `sos_events` already has `resolved_at` and `resolved_by`.

### Sequence of Changes

Backend first:
1. Add `broadcastToRoom(roomName, msg, exclude?)` to `ws.js` and export it beside `broadcastToGroup`.
2. Add `admin_join` handling in `ws.js`. Require `msg.adminPassword` and validate against `process.env.ADMIN_PASSWORD`; do not allow unauthenticated `{ type: 'join', room: 'admin' }`.
3. Track admin sockets in `rooms.get('admin')`; remove them on disconnect.
4. In `backend/src/routes/sos.js`, import `broadcastToRoom` and broadcast admin-safe `sos_alert` or `refresh_sos` after successful insert.
5. In `backend/src/routes/admin.js`, add `PATCH /api/admin/sos/:id/resolve`. Use `requireAdmin`, validate UUID-ish `id`, update the event, broadcast `sos_resolved` to the event group, and broadcast `refresh_sos` to admin room.
6. Extend backend E2E tests for auth, 404, idempotent/duplicate resolve behavior, and broadcast side effects where possible.

Frontend second:
1. Add admin API `resolveSos(id)`.
2. Add Leaflet dependencies and CSS import. Render the map only client-side to avoid SSR failures.
3. In `admin/src/pages/sos.tsx`, derive `activeEvents = events.filter(e => !e.resolved_at)`.
4. Show red pins for active events with valid `lat/lng`; keep null-coordinate events in the table.
5. Add Resolve buttons in table rows and marker popups; disable while resolving and refresh after success.
6. Open admin WS on mount. Send `{ type: 'admin_join', adminPassword }`; on `sos_alert`, `sos_resolved`, or `refresh_sos`, re-fetch `GET /api/admin/sos`.
7. Add reconnect with capped backoff or a visible disconnected state; table refresh must still work manually.

### API Contracts

Admin resolve:

```http
PATCH /api/admin/sos/:id/resolve
X-Admin-Password: <admin password>
```

Response `200`:

```json
{
  "id": "uuid",
  "user_id": "uuid",
  "group_id": "uuid-or-null",
  "lat": 45.923,
  "lng": 6.869,
  "triggered_at": "2026-06-22T09:00:00.000Z",
  "resolved_at": "2026-06-22T09:04:00.000Z",
  "resolved_by": null,
  "resolved_by_admin": true
}
```

Errors:
- `401 { "error": "Unauthorized" }`
- `400 { "error": "invalid id" }`
- `404 { "error": "SOS event not found" }`
- `500 { "error": "Server error" }`

Admin WS join:

```json
{ "type": "admin_join", "adminPassword": "..." }
```

Admin WS joined:

```json
{ "type": "joined", "room": "admin" }
```

Admin WS events:

```json
{
  "type": "sos_alert",
  "sos_id": "uuid",
  "user_id": "uuid",
  "username": "Alice",
  "group_id": "uuid-or-null",
  "lat": 45.923,
  "lng": 6.869,
  "triggered_at": "2026-06-22T09:00:00.000Z"
}
```

```json
{
  "type": "sos_resolved",
  "sos_id": "uuid",
  "group_id": "uuid-or-null",
  "resolved_by": "admin",
  "resolved_at": "2026-06-22T09:04:00.000Z"
}
```

```json
{ "type": "refresh_sos" }
```

Mobile group ack:

```json
{
  "type": "sos_resolved",
  "sos_id": "uuid",
  "resolved_by": "admin-or-user-id",
  "resolved_at": "2026-06-22T09:04:00.000Z"
}
```

### Risks and Edge Cases

- Admin WS auth: an unauthenticated admin room would leak live SOS data. Require the same admin password used by REST.
- Multiple admins resolving the same event: make resolve idempotent. Returning the row is acceptable, but do not clear `resolved_by` or regress `resolved_at`.
- `resolved_by` references `users(id)` in the current schema. If storing literal `"admin"` violates FK in a deployed DB, either set `resolved_by = NULL` for admin resolves or add a migration after explicit schema approval. Prefer `NULL` plus response metadata unless Peter approves an admin identity model.
- Null GPS: show the row, skip the marker, keep Resolve enabled.
- Map SSR: Leaflet must be client-only in Next. Use dynamic import or guard map rendering behind `typeof window !== 'undefined'`.
- Tile/network failure: keep table as source of truth; map is an enhancement.
- Push verification: current backend pushes on trigger. E2E should verify trigger path and WS/admin resolve; real push receipt may need a mock or token fixture.
- Current issue #47 text says `/api/sos/:id/resolve` exists; it does, but admin needs `/api/admin/sos/:id/resolve` because admin auth is password-header based.

## Issue #3 - PTT Intercom + GPS Broadcast

### Exact Files and Scope Boundaries

Recommended split into three PRs under issue #3 to keep scope inside Wooverse's 3-5 file rule:

PR A - WebSocket contracts and live GPS:
- `backend/src/services/ws.js`: add member roster snapshot, online/offline presence payloads, WebRTC signaling relay, optional signal telemetry, and preserve existing PTT floor lock.
- `backend/src/routes/groups.js`: add `GET /api/groups/:groupId/members` for full online/offline member list.
- `frontend/app/services/ws.ts`: add typed helpers/events for location, presence, signal, and WebRTC signaling.
- `frontend/app/(tabs)/map.tsx`: consume live `location` WS messages and update pins immediately, with REST polling as fallback.
- `frontend/app/services/location.ts`: include altitude/speed consistently and throttle/coalesce sends if needed.

PR B - WebRTC/Opus intercom:
- `frontend/app/services/groupAudio.ts` (new): group audio WebRTC manager using `react-native-webrtc`, Opus preferences, RTP sender bitrate caps, track enable/disable, peer lifecycle.
- `frontend/app/(tabs)/intercom.tsx`: replace Expo AV file-chunk send path with WebRTC audio track control; keep hold-to-talk UI and floor-lock behavior.
- `backend/src/services/ws.js`: add `webrtc_signal` relay if not landed in PR A.
- `frontend/app/services/ws.ts`: add `sendWebRtcSignal(targetUserId, signal)` helper if not landed in PR A.
- `backend/tests/e2e/ws-phase2.test.js` (new) only if the existing live test runner can support WS clients; otherwise cover with syntax/build checks and manual matrix.

PR C - Always-on intercom, fallback, signal UI:
- `frontend/app/(tabs)/settings.tsx`: add a separate `intercomAlwaysOn` setting. Do not reuse the current background GPS `alwaysOn` key.
- `frontend/app/(tabs)/intercom.tsx`: add mode state, fallback banner, signal quality indicator, and online/offline member list.
- `frontend/app/services/groupAudio.ts`: expose `setMode('ptt' | 'always_on')`, signal-based bitrate adaptation, and fallback callback.
- `frontend/app/services/ws.ts`: expose RTT/connection quality from ping/pong/status events.
- `frontend/app/services/location.ts` only if signal quality uses GPS freshness as an input.

Do not modify `frontend/app/services/webrtc.ts` for group intercom unless also separating the existing goggle simulator API. It is currently goggle-specific and should not become a mixed-purpose service.

Do not change `app.json`, package files, or native config for #3 unless the existing `react-native-webrtc` dependency proves insufficient. Any native/config change requires Peter approval.

### Sequence of Changes

Backend first:
1. Keep the current `join` contract but validate `groupId` membership before adding a user to a room. This closes a current trust gap and protects location/audio broadcasts.
2. On join, send the joining user a `members_snapshot` containing all group members with `online`, `last_seen_at`, and latest known location if available.
3. Broadcast `member_joined` and `member_left` with `online` status to the room. Preserve current fields so existing UI does not break.
4. Add `webrtc_signal` relay:
   - Require authenticated joined socket with `ws.userId` and `ws.groupId`.
   - Require `target_user_id`.
   - Deliver only if target is in the same room and online.
5. Preserve PTT floor lock in `ptt_start`/`ptt_end`; add optional mode metadata but keep current busy behavior.
6. Continue `location` upsert pattern; include `altitude_m`, `speed_ms`, and `sent_at` in WS broadcast when provided.
7. Add `GET /api/groups/:groupId/members` as a REST fallback for offline member list.

Frontend second:
1. Update `ws.ts` to maintain `status`, app-level ping/pong `rtt_ms`, and last message time; emit `signal_quality` as derived client state.
2. Update `map.tsx` so incoming `location` messages update `teammates` immediately; keep initial/fallback `GET /api/locations/:groupId` polling.
3. Add `groupAudio.ts` to own WebRTC peer connections and microphone track lifecycle.
4. In `intercom.tsx`, connect WebRTC peers after `members_snapshot` and `member_joined`; pressing PTT sends `ptt_start`, enables the local mic track while floor is held, then disables it and sends `ptt_end` on release.
5. Add Opus preference and bitrate caps in `groupAudio.ts`:
   - preferred codec: Opus
   - adaptive `maxBitrate`: 6000, 12000, 18000, or 24000 bps based on signal tier
   - mono audio where platform support allows
6. Add separate `intercomAlwaysOn` toggle in Settings. When enabled, the app keeps the audio peer graph ready and enables the mic without hold-to-talk only while foregrounded and connected.
7. Auto-fallback: if signal quality is below threshold for a sustained window, switch `intercomAlwaysOn` off for the current session, force PTT mode, and show a banner in Intercom.
8. Add UI signal indicator and offline/online member states in Intercom. Map can show stale/offline locations as dimmed if `last_seen_at` is available.

### API and WebSocket Contracts

Group members fallback:

```http
GET /api/groups/:groupId/members
Authorization: Bearer <jwt>
```

Response `200`:

```json
{
  "members": [
    {
      "user_id": "uuid",
      "name": "Alice",
      "online": true,
      "last_seen_at": "2026-06-22T09:00:00.000Z",
      "lat": 45.923,
      "lng": 6.869,
      "location_updated_at": "2026-06-22T09:00:00.000Z"
    }
  ]
}
```

WS join remains backward compatible:

```json
{ "type": "join", "userId": "uuid", "groupId": "uuid", "name": "Alice" }
```

Joined:

```json
{ "type": "joined", "groupId": "uuid" }
```

Member snapshot:

```json
{
  "type": "members_snapshot",
  "groupId": "uuid",
  "members": [
    { "userId": "uuid", "name": "Alice", "online": true, "last_seen_at": "2026-06-22T09:00:00.000Z" }
  ]
}
```

Presence:

```json
{ "type": "member_joined", "userId": "uuid", "name": "Alice", "online": true }
```

```json
{ "type": "member_left", "userId": "uuid", "name": "Alice", "online": false, "last_seen_at": "2026-06-22T09:04:00.000Z" }
```

Live location:

```json
{
  "type": "location",
  "userId": "uuid",
  "lat": 45.923,
  "lng": 6.869,
  "altitude_m": 1800.5,
  "speed_ms": 8.2,
  "ts": 1782118800000
}
```

PTT floor:

```json
{ "type": "ptt_start", "mode": "ptt" }
```

```json
{ "type": "ptt_end" }
```

Busy:

```json
{ "type": "ptt_busy", "userId": "uuid" }
```

WebRTC signaling:

```json
{
  "type": "webrtc_signal",
  "target_user_id": "uuid",
  "signal": {
    "kind": "offer",
    "sdp": "..."
  }
}
```

Relayed:

```json
{
  "type": "webrtc_signal",
  "from_user_id": "uuid",
  "signal": {
    "kind": "answer",
    "sdp": "..."
  }
}
```

ICE:

```json
{
  "type": "webrtc_signal",
  "target_user_id": "uuid",
  "signal": {
    "kind": "ice",
    "candidate": {}
  }
}
```

App-level signal probe:

```json
{ "type": "client_ping", "ts": 1782118800000 }
```

```json
{ "type": "server_pong", "ts": 1782118800000, "server_ts": 1782118800050 }
```

Mode change:

```json
{ "type": "audio_mode", "mode": "ptt", "reason": "low_signal" }
```

Signal quality UI event, client-derived:

```json
{
  "type": "signal_quality",
  "tier": "good",
  "rtt_ms": 120,
  "ws_state": "connected",
  "packet_loss_pct": 2,
  "bitrate_bps": 18000
}
```

### Adaptive Bitrate and Fallback Rules

Initial bitrate: 18000 bps.

Suggested tiers:
- Excellent: RTT < 100ms and no recent reconnects -> 24000 bps.
- Good: RTT 100-250ms -> 18000 bps.
- Fair: RTT 250-500ms or one reconnect in 60s -> 12000 bps.
- Poor: RTT > 500ms, repeated reconnects, or ICE state `disconnected`/`failed` -> 6000 bps.

Always-on fallback:
- Threshold: signal tier `poor` for 10 continuous seconds or two WebRTC reconnects within 60 seconds.
- Action: disable session always-on, keep peer connections if viable, require PTT floor before enabling mic, show a banner.
- Persistence: do not overwrite the user's saved `intercomAlwaysOn` preference unless they manually toggle it off. The fallback is session-local.

### Risks and Edge Cases

- Expo AV cannot satisfy the Opus/WebRTC requirement. Use `react-native-webrtc`; current AAC chunk transport should become fallback/debug only, not the primary implementation.
- Group mesh scaling: max group size is 20. Audio-only mesh may be acceptable for Phase 2, but test battery, CPU, and bandwidth on real devices. If it fails, the next architecture step is an SFU/TURN service, which is outside this issue.
- TURN not configured: STUN-only works on many networks but fails behind restrictive NATs. Track failure rates before calling WebRTC complete for production resorts.
- PTT floor race: keep server-authoritative floor lock. Do not trust client mode state.
- WebSocket singleton ownership: map, intercom, SOS, and iPod all share `wsClient`; changes must preserve reconnect behavior fixed in #27/#29 and must not disconnect the socket when switching tabs.
- Signal quality: React Native WebRTC stats availability varies. Fall back to WS RTT/reconnect history when `getStats()` is incomplete.
- Background GPS privacy: do not expand foreground GPS behavior for #3. The existing Settings background GPS toggle already conflicts with D7 and should not be broadened under "always-on intercom."
- Location freshness: if a member goes offline, keep their last coordinate with a stale timestamp rather than deleting immediately; delete/dim after a configured stale window.
- SOS and PTT both use the shared WS room. Avoid message type collisions; keep SOS messages as `sos_alert`/`sos_resolved` and intercom messages as `ptt_*`/`webrtc_signal`.
- Admin auth patches are live on ECS but not fully reflected in GitHub per workspace memory. Any deployment after these changes must first reconcile PR #48 or risk overwriting live auth behavior.

## Verification Plan

#47:
- Backend syntax: `npm test` in `backend`.
- Admin build: `npm run build` in `admin` after Leaflet integration.
- E2E: live backend test for trigger -> admin WS refresh -> admin resolve -> group `sos_resolved`.
- Manual: open admin SOS page, trigger mobile SOS, verify red pin appears, resolve from row and popup, verify pin disappears and mobile receives resolved ack.

#3:
- Backend syntax: `npm test` in `backend`.
- Frontend TypeScript/lint where available: `npm run lint` in `frontend`.
- Manual two-device matrix:
  - join same group -> both appear online
  - move one device -> other map pin moves without waiting 10s poll
  - hold PTT -> remote hears Opus/WebRTC audio -> release mutes
  - simultaneous PTT -> second user receives busy
  - always-on enabled -> low-signal simulation -> fallback banner and PTT-only mode
  - WS reconnect -> map/intercom recover without duplicate sockets
