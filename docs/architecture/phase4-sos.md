# Phase 4 SOS Safety System (#76)

## Goal

Phase 4 turns the existing manual SOS flow into an accountable safety workflow:

1. Mobile SOS sends GPS, timestamp, and authenticated user context to the backend.
2. Backend persists the alert and dispatches it live to connected group admins over WebSocket.
3. Admins acknowledge first response from the SOS triage page.
4. If no admin acknowledges within 30 seconds, backend sends fallback SMS to the user's emergency contacts with user name, GPS link, and timestamp.
5. Admins resolve alerts from the triage page; `resolved_by` records the admin user ID, and history remains visible.

The design is additive over the current SOS baseline. Existing manual SOS, push notification, admin room auth, and admin resolve behavior already exist. #76 must consolidate all alert sources through one SOS service before it is considered complete.

## Current Baseline

- Mobile currently has more than one SOS entry point and calls `POST /api/sos`.
- `backend/src/routes/sos.js` persists `sos_events`, broadcasts `sos_alert` to the group and admin room, and sends push notifications to group members.
- `backend/src/routes/admin.js` exposes `GET /api/admin/sos` and `PATCH /api/admin/sos/:id/resolve`.
- `backend/src/services/ws.js` already supports authenticated `admin_join`, group rooms, `broadcastToGroup`, and `broadcastToRoom`.
- `admin/src/pages/sos.tsx` already shows live events, map pins, and a resolve action.

Because there are multiple current SOS sources, implementation must verify that all active sources use the same Phase 4 service path or that legacy sources are explicitly disabled. Fixing only one source is not enough.

## Implementation Scope

Requested implementation files:

- `backend/src/services/sos.js` (new): own SOS state transitions, alert dispatch, ack timeout, SMS fallback, and event shaping.
- `backend/src/services/ws.js` (modify): add SOS WS handlers and route admin commands to the service.
- `admin/src/pages/sos.tsx` (modify): add triage list, acknowledge flow, resolve flow, and alert history.

Important constraint: the current mobile clients call REST, but the requested file scope does not include `backend/src/routes/sos.js` or mobile files. If #76 implementation remains strictly three files, `ws.js` can add a new WS-first SOS trigger path, but REST-triggered alerts will still bypass the new service. The safer implementation is to include a very small follow-up change to `routes/sos.js` so REST also calls `services/sos.js`; that is outside the requested three-file list and should be approved before coding.

## Data Model

`sos_events` currently has:

- `id`
- `user_id`
- `group_id`
- `lat`
- `lng`
- `triggered_at`
- `resolved_at`
- `resolved_by`

Phase 4 needs additional durable state:

- `acknowledged_at`
- `acknowledged_by`
- `sms_fallback_sent_at`
- `sms_fallback_status`
- emergency contacts for the triggering user

The Prisma model includes `emergency_contacts`, but the SQL migrations in this repo do not create that table. Do not hardcode contacts in code. If production DB does not already have emergency contacts and ack columns, add a separate migration after approval. Until then, `services/sos.js` should treat "no contacts configured" as a logged fallback result, not as a process crash.

Admin identity must be an actual admin user ID for `acknowledged_by` and `resolved_by`. Storing the literal string `"admin"` conflicts with the existing UUID-shaped `resolved_by` convention.

## Service Design

`backend/src/services/sos.js` should export:

```js
async function triggerSos({ userId, groupId, lat, lng, timestamp, source })
async function acknowledgeSos({ sosId, adminUserId })
async function resolveSos({ sosId, adminUserId })
function shapeSosEvent(row)
function getGpsLink({ lat, lng })
```

Service responsibilities:

- Validate `groupId`, finite GPS coordinates, and authenticated `userId`.
- Verify the user belongs to the target group before inserting.
- Insert the SOS event with server `triggered_at`; preserve client timestamp as metadata only if a schema field exists.
- Load user display name for dispatch and SMS content.
- Broadcast `sos_alert` to the admin room and the user's group.
- Start a 30 second ack timer in memory for active alerts.
- Cancel the timer when the first valid admin acknowledgement arrives.
- Send SMS fallback exactly once per alert when the timer fires and the alert is still unacknowledged and unresolved.
- Resolve idempotently: first resolver wins; duplicate resolve returns the existing terminal state.

Timer durability:

- In-memory timers are acceptable for Phase 4 MVP because no new scheduler file is in scope.
- On process restart, `services/sos.js` should expose a future `resumePendingFallbacks()` hook, but implementation can defer wiring it until a startup file change is approved.
- Because timers are in memory, tests must cover the normal 30 second path and document that restart recovery is a follow-up hardening item.

SMS fallback:

- Reuse the existing Ali SMS signing/service pattern.
- Use environment variables for SMS sign/template configuration; never hardcode credentials, phone numbers, or template IDs.
- Message content should include only: user name, GPS link, and timestamp.
- Recommended GPS link format: `https://uri.amap.com/marker?position=<lng>,<lat>&name=SOS`.

## State Machine

```text
active
  | admin acknowledge
  v
acknowledged
  | admin resolve
  v
resolved

active
  | 30s without acknowledge
  v
sms_fallback_sent
  | admin acknowledge or resolve
  v
acknowledged/resolved
```

Rules:

- `acknowledge` does not resolve the alert.
- `resolve` is allowed without prior acknowledgement.
- First acknowledgement wins and sets `acknowledged_by`.
- First resolve wins and sets `resolved_by`.
- SMS fallback does not change `resolved_at`.
- Admin UI should keep resolved alerts in history and remove them from the active queue.

## WebSocket Contracts

All payloads are JSON. Keep both `snake_case` and existing compatibility fields only where current clients already require both. New Phase 4 fields should use `snake_case`.

### Admin Join

Client to server:

```json
{
  "type": "admin_join",
  "adminPassword": "secret",
  "admin_user_id": "uuid"
}
```

Server to admin:

```json
{
  "type": "joined",
  "room": "admin",
  "admin_user_id": "uuid"
}
```

`admin_user_id` is required for Phase 4 acknowledge/resolve attribution. If the current admin auth remains password-only, implementation needs a real admin identity source before writing `resolved_by=admin user ID`.

### Mobile SOS Trigger

Client to server:

```json
{
  "type": "sos_trigger",
  "group_id": "uuid",
  "lat": 24.12345,
  "lng": 121.12345,
  "client_timestamp": "2026-06-24T10:15:30.000Z"
}
```

Server to triggering client:

```json
{
  "type": "sos_triggered",
  "sos_id": "uuid",
  "group_id": "uuid",
  "triggered_at": "2026-06-24T10:15:31.000Z",
  "fallback_after_ms": 30000
}
```

Server error:

```json
{
  "type": "sos_error",
  "code": "invalid_location",
  "message": "lat and lng required"
}
```

### Alert Dispatch to Admins

Server to admin room:

```json
{
  "type": "sos_alert",
  "sos_id": "uuid",
  "group_id": "uuid",
  "user_id": "uuid",
  "user_name": "Peter",
  "lat": 24.12345,
  "lng": 121.12345,
  "gps_link": "https://uri.amap.com/marker?position=121.12345,24.12345&name=SOS",
  "triggered_at": "2026-06-24T10:15:31.000Z",
  "status": "active",
  "acknowledged_at": null,
  "acknowledged_by": null,
  "resolved_at": null,
  "resolved_by": null,
  "fallback_after_ms": 30000
}
```

Server to group room:

```json
{
  "type": "sos_alert",
  "sos_id": "uuid",
  "group_id": "uuid",
  "user_id": "uuid",
  "username": "Peter",
  "lat": 24.12345,
  "lng": 121.12345,
  "triggered_at": "2026-06-24T10:15:31.000Z"
}
```

### Admin Acknowledge

Admin to server:

```json
{
  "type": "sos_acknowledge",
  "sos_id": "uuid",
  "admin_user_id": "uuid"
}
```

Server to admin room:

```json
{
  "type": "sos_acknowledged",
  "sos_id": "uuid",
  "acknowledged_at": "2026-06-24T10:15:45.000Z",
  "acknowledged_by": "uuid",
  "status": "acknowledged"
}
```

Server to triggering group:

```json
{
  "type": "sos_acknowledged",
  "sos_id": "uuid",
  "acknowledged_at": "2026-06-24T10:15:45.000Z"
}
```

### SMS Fallback

Server to admin room after timeout:

```json
{
  "type": "sos_sms_fallback_sent",
  "sos_id": "uuid",
  "sent_at": "2026-06-24T10:16:01.000Z",
  "contact_count": 2,
  "status": "sms_fallback_sent"
}
```

If no contacts exist:

```json
{
  "type": "sos_sms_fallback_skipped",
  "sos_id": "uuid",
  "reason": "no_emergency_contacts",
  "checked_at": "2026-06-24T10:16:01.000Z"
}
```

### Admin Resolve

Admin to server:

```json
{
  "type": "sos_resolve",
  "sos_id": "uuid",
  "admin_user_id": "uuid"
}
```

Server to admin room:

```json
{
  "type": "sos_resolved",
  "sos_id": "uuid",
  "resolved_at": "2026-06-24T10:18:00.000Z",
  "resolved_by": "uuid",
  "status": "resolved"
}
```

Server to group room:

```json
{
  "type": "sos_resolved",
  "sos_id": "uuid",
  "group_id": "uuid",
  "resolved_at": "2026-06-24T10:18:00.000Z",
  "resolved_by": "uuid"
}
```

### Refresh Fallback

The current `refresh_sos` message may remain as a coarse invalidation event:

```json
{
  "type": "refresh_sos"
}
```

Admin UI should prefer typed deltas when available and fall back to refetching `GET /api/admin/sos` on `refresh_sos` or unknown SOS messages.

## Admin UI Plan

`admin/src/pages/sos.tsx` should show:

- Active alert queue first, ordered oldest active first.
- Each active alert: user name, triggered time, elapsed time, GPS link, acknowledgement status, fallback status, and actions.
- `Acknowledge` button disabled after any admin acknowledges.
- `Resolve` button disabled after resolution.
- Live history table below active alerts, ordered newest first.
- Current map pins for unresolved alerts with acknowledged/resolved visual state.
- WS status and REST polling fallback, preserving the current behavior.

UI actions:

- `Acknowledge` sends `sos_acknowledge` over WS when connected; if WS is disconnected, use the REST endpoint only if an ack REST endpoint exists.
- `Resolve` sends `sos_resolve` over WS or falls back to the existing REST resolve path after it records a real admin user ID.
- On `sos_alert`, `sos_acknowledged`, `sos_sms_fallback_*`, `sos_resolved`, or `refresh_sos`, update local state or refetch.

Do not add a marketing-style page. This is an operational triage console.

## Testing Gates

Backend:

- Trigger with valid user/group/GPS inserts one alert and dispatches `sos_alert` to admin room.
- Trigger rejects missing group, invalid GPS, unauthenticated user, and non-member group.
- First `sos_acknowledge` sets `acknowledged_by` and cancels SMS fallback.
- Duplicate acknowledgement returns the existing ack state without replacing `acknowledged_by`.
- No acknowledgement for 30 seconds sends SMS to emergency contacts once.
- No emergency contacts emits skipped fallback and does not crash.
- Resolve sets `resolved_by` to the admin user ID.
- Duplicate resolve is idempotent.
- REST and WS trigger sources are both verified silent or consciously retired.

Admin:

- SOS page renders active alerts and history.
- Acknowledge disables the ack button and shows admin/timestamp state.
- Resolve removes alert from active queue but keeps it in history.
- WS disconnect falls back to polling without losing actions already completed.

Manual smoke:

1. Open admin SOS page and connect admin WS.
2. Trigger SOS from mobile with GPS lock.
3. Verify live alert appears on admin page without refresh.
4. Wait less than 30 seconds, acknowledge, and verify no SMS fallback is sent.
5. Trigger another SOS, do not acknowledge, and verify SMS fallback after 30 seconds.
6. Resolve from admin and verify mobile/group receives `sos_resolved`.

## Risks and Follow-ups

- Admin identity is currently weaker than the requirement. Password-only admin auth cannot honestly populate `resolved_by=admin user ID`.
- SQL migrations do not currently show emergency contacts or ack columns. SMS fallback and durable acknowledgement need schema work unless production already has those tables/columns.
- In-memory timers do not survive backend restart. A later hardening pass should resume pending fallbacks from DB at startup.
- Existing REST SOS route is an active source. #76 implementation must either route it through `services/sos.js` or move all SOS buttons to WS and verify REST is no longer called.
