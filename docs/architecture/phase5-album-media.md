# Phase 5 Album and Media System (#80)

Date: 2026-06-25

## Goal

Phase 5 adds persistent ski media without weakening the Phase 4 SOS workflow:

1. Mobile browses and downloads photos from Flow S goggles over Wi-Fi Direct.
2. Mobile uploads imported media to Alibaba Cloud OSS through backend-issued signed URLs.
3. SOS trigger creates or reuses an emergency album and asks connected goggles to auto-capture evidence.
4. Admins can inspect, filter, and manage media, with emergency albums surfaced from the SOS triage context.

The design is additive over the current Prisma schema. `Device`, `SosEvent`, `WorkOrder`, and `Evidence` already model goggles, SOS events, rescue workflows, and OSS-backed evidence. Phase 5 should add general album/media tables and reuse `evidence.oss_key` for formal rescue evidence instead of overloading it for every user photo.

## Current Baseline

- `backend/prisma/schema.prisma` uses UUID primary keys, `created_at`/`updated_at` style timestamps, and app-level auth.
- `User` owns `Device[]`, `SosEvent[]`, and `WorkOrder[]` assignments.
- `Device` already has `ble_mac`, `owner_user_id`, `wifi_connected`, `storage_remaining_gb`, and `last_seen_at`, which are the right anchors for Wi-Fi Direct state.
- `SosEvent` stores `trigger_source`, `user_id`, `resort_id`, GPS, status, `triggered_at`, `sent_at`, and `resolved_at`.
- `Evidence` already stores `work_order_id`, `type`, `oss_key`, `recorded_at`, `retained_until`, and blockchain fields.
- There is no current `albums` or `media_items` table. Phase 5 needs a migration after approval before implementation.
- Phase 4 requires all SOS sources to use one service path. Emergency album creation must be inside that same SOS service path, not bolted onto only one trigger route.

## Implementation Scope

Recommended split to stay inside Wooverse's 3-5 file rule:

PR A - backend data model and OSS contracts:
- `backend/prisma/schema.prisma`: add album/media models after approved migration design.
- `backend/migrations/00x_album_media.sql`: create `albums` and `media_items`.
- `backend/src/routes/media.js` or `backend/src/media/media.routes.ts`: album/media REST contracts.
- `backend/src/services/oss.js` or `backend/src/media/oss.service.ts`: signed URL generation and key validation.
- Focused backend tests for ownership, admin access, signed URL TTL, and complete-upload state transitions.

PR B - mobile Wi-Fi Direct import:
- Mobile goggle media service for Wi-Fi Direct discovery, local manifest browsing, and download.
- Album browser and media import UI.
- Upload flow using backend signed URLs and complete-upload confirmation.
- Native permission and platform handling. Any native/config package changes require Peter approval first.

PR C - emergency album and admin:
- SOS service integration: create emergency album and dispatch capture request on trigger.
- Admin media management page or SOS detail extension.
- Evidence promotion flow for patrol/admin use when media becomes rescue evidence.

Do not change OSS bucket credentials, app config, native permissions, or deployment configuration in the architecture PR. Those require separate approval during implementation.

## Data Model

Use Prisma camelCase fields with `@map("snake_case")`, UUID primary keys, and app-level authorization, matching the existing schema.

### New Enums

```prisma
enum AlbumType {
  USER
  EMERGENCY
}

enum MediaType {
  PHOTO
  VIDEO
}

enum MediaSource {
  GOGGLE_WIFI_DIRECT
  APP_CAMERA
  ADMIN_UPLOAD
  SOS_AUTO_CAPTURE
}

enum MediaStatus {
  PENDING_UPLOAD
  AVAILABLE
  FAILED
  DELETED
}
```

### Existing Enum Migration

`EvidenceType` currently lacks `PHOTO`. Add it before Phase 5 migrations:

```prisma
enum EvidenceType {
  VIDEO
  GPS_TRACK
  AUDIO
  PHOTO   // added for Phase 5 emergency photo evidence
}
```

Migration SQL: `ALTER TYPE "EvidenceType" ADD VALUE 'PHOTO';`

### `albums`

```prisma
model Album {
  id          String    @id @default(uuid())
  ownerUserId String   @map("owner_user_id")
  resortId    String?  @map("resort_id")
  sosEventId  String?  @map("sos_event_id")
  type        AlbumType @default(USER)
  title       String
  description String?
  coverMediaItemId String? @map("cover_media_item_id")
  locked      Boolean  @default(false)
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")
  deletedAt   DateTime? @map("deleted_at")

  owner       User      @relation(fields: [ownerUserId], references: [id])
  resort      Resort?   @relation(fields: [resortId], references: [id])
  sosEvent    SosEvent? @relation(fields: [sosEventId], references: [id])
  mediaItems  MediaItem[]

  @@index([ownerUserId, createdAt])
  @@index([sosEventId])
  @@map("albums")
}
```

Reverse relations to add to existing models:

```prisma
// User model — add:
albums     Album[]
mediaItems MediaItem[]

// Device model — add:
mediaItems MediaItem[]

// SosEvent model — add:
emergencyAlbum Album?     @relation("EmergencyAlbum")
mediaItems     MediaItem[]

// Evidence model — add:
mediaItems MediaItem[]
```

Rules:

- Normal albums use `type=USER` and `sos_event_id=NULL`.
- Emergency albums use `type=EMERGENCY`, `locked=true`, and a non-null `sos_event_id`.
- One SOS event should have at most one emergency album. Enforce a partial unique index on `sos_event_id WHERE sos_event_id IS NOT NULL` in SQL if Prisma cannot express it cleanly.
- `locked=true` prevents user deletion while an SOS/work order is active. Admin/patrol can still manage retention through admin-only routes.

### `media_items`

```prisma
model MediaItem {
  id          String      @id @default(uuid())
  albumId     String      @map("album_id")
  ownerUserId String      @map("owner_user_id")
  deviceId    String?     @map("device_id")
  sosEventId  String?     @map("sos_event_id")
  evidenceId  String?     @map("evidence_id")
  type        MediaType
  source      MediaSource
  status      MediaStatus @default(PENDING_UPLOAD)
  ossKey      String      @unique @map("oss_key")
  originalDevicePath String? @map("original_device_path")
  filename    String
  mimeType    String      @map("mime_type")
  byteSize    BigInt?     @map("byte_size")
  width       Int?
  height      Int?
  durationSec Int?        @map("duration_sec")
  checksumSha256 String?  @map("checksum_sha256")
  capturedAt  DateTime?   @map("captured_at")
  uploadedAt  DateTime?   @map("uploaded_at")
  retainedUntil DateTime? @map("retained_until")
  createdAt   DateTime    @default(now()) @map("created_at")
  updatedAt   DateTime    @updatedAt @map("updated_at")
  deletedAt   DateTime?   @map("deleted_at")

  album       Album       @relation(fields: [albumId], references: [id])
  owner       User        @relation(fields: [ownerUserId], references: [id])
  device      Device?     @relation(fields: [deviceId], references: [id])
  sosEvent    SosEvent?   @relation(fields: [sosEventId], references: [id])
  evidence    Evidence?   @relation(fields: [evidenceId], references: [id])

  @@index([albumId, capturedAt])
  @@index([ownerUserId, createdAt])
  @@index([sosEventId])
  @@index([deviceId, capturedAt])
  @@index([evidenceId])
  @@map("media_items")
}
```
  @@map("media_items")
}
```

Rules:

- Store only OSS object keys in DB, never public bucket URLs.
- `oss_key` is immutable after `AVAILABLE`.
- `byte_size`, dimensions, checksum, and MIME type must be supplied or verified during upload completion.
- Soft delete user media with `deleted_at` and optionally apply OSS lifecycle deletion. Do not hard-delete emergency media while the linked SOS/work order is active.
- When media is promoted to rescue evidence, create an `evidence` row with the same OSS object or a copied immutable evidence key, then set `media_items.evidence_id`.

## OSS Key Design

Bucket configuration stays in environment variables:

- `OSS_REGION`
- `OSS_BUCKET`
- `OSS_ENDPOINT`
- `OSS_ACCESS_KEY_ID`
- `OSS_ACCESS_KEY_SECRET`
- optional `OSS_CDN_BASE_URL`

Key format:

```text
media/{env}/{yyyy}/{mm}/{owner_user_id}/{album_id}/{media_item_id}.{ext}
emergency/{env}/{yyyy}/{mm}/{sos_event_id}/{media_item_id}.{ext}
evidence/{env}/{yyyy}/{mm}/{work_order_id}/{evidence_id}.{ext}
tmp/{env}/{yyyy}/{mm}/{upload_session_id}/{filename}
```

Rules:

- `env` is `dev`, `staging`, or `prod`; never infer it from request input.
- Use server-generated UUID path segments. Do not include phone numbers, display names, original GPS coordinates, or raw goggle paths in OSS keys.
- Normal user media uses `media/...`.
- Emergency album uploads use `emergency/...` until a patrol/admin promotes an item to `evidence/...`.
- Signed PUT URLs should expire in 5 minutes. Signed GET URLs should expire in 2 minutes for mobile and admin preview.
- Backend must validate allowed file extensions and MIME types before issuing a PUT URL.
- OSS lifecycle can transition normal media to lower-cost storage after 90 days. Emergency and evidence retention should follow `retained_until`, with `Evidence.retainedUntil` remaining the source of truth for rescue records.

## API Contracts

All user APIs require:

```http
Authorization: Bearer <jwt>
```

All admin APIs require:

```http
X-Admin-Password: <admin password>
```

Error shape remains:

```json
{ "error": "message" }
```

### List Albums

```http
GET /api/albums?type=user|emergency&cursor=<created_at,id>&limit=30
```

Response `200`:

```json
{
  "albums": [
    {
      "id": "uuid",
      "type": "USER",
      "title": "Hakuba Day 1",
      "media_count": 42,
      "cover_media_item_id": "uuid-or-null",
      "sos_event_id": null,
      "locked": false,
      "created_at": "2026-06-25T02:00:00.000Z",
      "updated_at": "2026-06-25T02:10:00.000Z"
    }
  ],
  "next_cursor": null
}
```

### Create Album

```http
POST /api/albums
Content-Type: application/json
```

Request:

```json
{
  "title": "Hakuba Day 1",
  "description": "Morning powder laps"
}
```

Response `201`:

```json
{
  "id": "uuid",
  "type": "USER",
  "title": "Hakuba Day 1",
  "description": "Morning powder laps",
  "locked": false,
  "created_at": "2026-06-25T02:00:00.000Z"
}
```

### Album Detail

```http
GET /api/albums/:albumId?cursor=<captured_at,id>&limit=60
```

Response `200`:

```json
{
  "album": {
    "id": "uuid",
    "type": "EMERGENCY",
    "title": "Emergency - 2026-06-25 10:15",
    "sos_event_id": "uuid",
    "locked": true
  },
  "media_items": [
    {
      "id": "uuid",
      "type": "PHOTO",
      "source": "SOS_AUTO_CAPTURE",
      "status": "AVAILABLE",
      "filename": "IMG_0001.JPG",
      "mime_type": "image/jpeg",
      "byte_size": 2841120,
      "width": 4000,
      "height": 3000,
      "captured_at": "2026-06-25T02:15:32.000Z",
      "download_url_expires_at": null
    }
  ],
  "next_cursor": null
}
```

### Create Upload URL

```http
POST /api/media/upload-url
Content-Type: application/json
```

Request:

```json
{
  "album_id": "uuid",
  "device_id": "uuid-or-null",
  "type": "PHOTO",
  "source": "GOGGLE_WIFI_DIRECT",
  "filename": "IMG_0001.JPG",
  "mime_type": "image/jpeg",
  "byte_size": 2841120,
  "checksum_sha256": "hex-or-null",
  "captured_at": "2026-06-25T02:15:32.000Z",
  "original_device_path": "/DCIM/100FLOW/IMG_0001.JPG"
}
```

Response `201`:

```json
{
  "media_item_id": "uuid",
  "oss_key": "media/prod/2026/06/user-id/album-id/media-id.jpg",
  "upload_url": "signed-put-url",
  "upload_headers": {
    "Content-Type": "image/jpeg"
  },
  "expires_at": "2026-06-25T02:20:32.000Z"
}
```

### Complete Upload

```http
POST /api/media/:mediaItemId/complete
Content-Type: application/json
```

Request:

```json
{
  "etag": "oss-etag",
  "byte_size": 2841120,
  "checksum_sha256": "hex-or-null",
  "width": 4000,
  "height": 3000
}
```

Response `200`:

```json
{
  "id": "uuid",
  "status": "AVAILABLE",
  "uploaded_at": "2026-06-25T02:16:10.000Z"
}
```

The backend should verify object existence with OSS before moving from `PENDING_UPLOAD` to `AVAILABLE`.

### Download URL

```http
GET /api/media/:mediaItemId/download-url
```

Response `200`:

```json
{
  "media_item_id": "uuid",
  "download_url": "signed-get-url",
  "expires_at": "2026-06-25T02:18:10.000Z"
}
```

### Delete Media

```http
DELETE /api/media/:mediaItemId
```

Response `200`:

```json
{
  "id": "uuid",
  "deleted_at": "2026-06-25T02:20:00.000Z"
}
```

Reject deletion with `409` when `locked=true`, the item is linked to active SOS/work order evidence, or retention has not expired.

## Wi-Fi Direct Flow

> ⚠️ **Platform limitation**: Android supports generic Wi-Fi Direct peer-to-peer connections; iOS does not. On iOS, the goggle must present as a Wi-Fi access point (AP mode) or use Apple's Multipeer Connectivity framework (limited to Apple devices). The goggle firmware must support AP-mode media serving for cross-platform compatibility. This is a firmware requirement, not a mobile-app-only fix.

Mobile is the coordinator. The backend never connects directly to goggles over Wi-Fi Direct.

```text
Mobile app
  -> BLE/goggle bridge discovers paired Flow S device
  -> app asks goggle to start Wi-Fi Direct media server
  -> OS Wi-Fi Direct permission/connect flow
  -> app fetches local manifest from goggle
  -> user selects files
  -> app downloads files to local cache
  -> app requests OSS signed PUT URL from backend
  -> app uploads object to OSS
  -> app calls complete-upload
  -> backend marks media item AVAILABLE
```

Goggle local manifest response:

```json
{
  "device_id": "goggle-local-id",
  "firmware_version": "1.4.0",
  "files": [
    {
      "path": "/DCIM/100FLOW/IMG_0001.JPG",
      "filename": "IMG_0001.JPG",
      "mime_type": "image/jpeg",
      "byte_size": 2841120,
      "width": 4000,
      "height": 3000,
      "captured_at": "2026-06-25T02:15:32.000Z",
      "checksum_sha256": "hex-or-null"
    }
  ]
}
```

Backend coordination endpoints:

```http
POST /api/devices/:deviceId/wifi-direct/session
```

Request:

```json
{
  "state": "starting",
  "platform": "ios|android",
  "goggle_ssid": "optional-redacted-ssid"
}
```

Response `201`:

```json
{
  "session_id": "uuid",
  "device_id": "uuid",
  "expires_at": "2026-06-25T02:30:00.000Z"
}
```

```http
PATCH /api/devices/:deviceId/wifi-direct/session/:sessionId
```

Request:

```json
{
  "state": "connected|browsing|downloading|completed|failed",
  "storage_remaining_gb": 12.4,
  "error_code": null
}
```

Rules:

- Verify `device.owner_user_id` matches the authenticated user.
- Store long-term state on `devices.wifi_connected`, `devices.storage_remaining_gb`, and `devices.last_seen_at`.
- Session rows are optional for MVP. If added, keep them short-lived and do not store local Wi-Fi credentials.
- Import dedupe should use `(device_id, original_device_path, checksum_sha256)` when checksum exists; fallback to `(device_id, original_device_path, byte_size, captured_at)`.
- If upload fails after local download, leave `media_items.status=PENDING_UPLOAD` with retry affordance rather than creating a duplicate record.

## Emergency Album Trigger Flow

Emergency album creation belongs inside the canonical SOS trigger service from Phase 4.

```text
SOS trigger accepted
  -> insert/update sos_events through SOS service
  -> find or create locked emergency album for sos_event_id
  -> dispatch normal sos_alert to admin/group rooms
  -> if a paired goggle is connected, request emergency capture
  -> mobile/goggle captures photo burst or short clip
  -> mobile downloads captured files through goggle bridge
  -> mobile uploads to OSS using emergency key namespace
  -> backend links media_items to album_id and sos_event_id
  -> admin SOS page receives emergency_media_available or refresh_sos
```

Emergency album title:

```text
Emergency - {local resort/user time}
```

WS request to mobile/goggle coordinator:

```json
{
  "type": "emergency_capture_request",
  "sos_id": "uuid",
  "album_id": "uuid",
  "capture_mode": "photo_burst",
  "requested_count": 3,
  "requested_at": "2026-06-25T02:15:31.000Z"
}
```

Mobile ack:

```json
{
  "type": "emergency_capture_ack",
  "sos_id": "uuid",
  "album_id": "uuid",
  "device_id": "uuid",
  "status": "capturing|unavailable|failed",
  "reason": null
}
```

Admin/media event after upload completion:

```json
{
  "type": "emergency_media_available",
  "sos_id": "uuid",
  "album_id": "uuid",
  "media_item_id": "uuid",
  "captured_at": "2026-06-25T02:15:32.000Z"
}
```

Rules:

- SOS dispatch must not wait on capture or upload. The safety alert remains first priority.
- Failure to capture media must not fail SOS trigger.
- Create the emergency album synchronously with SOS trigger so the admin UI can show "waiting for media" immediately.
- If multiple SOS triggers are retried for the same `sos_event_id`, reuse the existing emergency album.
- If the goggle is offline, record no media item unless there is an actual file to upload; show the capture state as unavailable in the SOS event detail.
- Uploaded emergency media uses `source=SOS_AUTO_CAPTURE`, `type=PHOTO` or `VIDEO`, `locked=true` through the album, and a non-null `sos_event_id`.

## Admin Media Management

Admin surface should be operational, not marketing-style.

Routes:

```http
GET /api/admin/albums?type=user|emergency&user_id=&sos_event_id=&status=&cursor=&limit=50
GET /api/admin/albums/:albumId
GET /api/admin/media/:mediaItemId/download-url
PATCH /api/admin/media/:mediaItemId
DELETE /api/admin/media/:mediaItemId
POST /api/admin/media/:mediaItemId/promote-evidence
```

Admin list response:

```json
{
  "albums": [
    {
      "id": "uuid",
      "type": "EMERGENCY",
      "title": "Emergency - 2026-06-25 10:15",
      "owner_user_id": "uuid",
      "owner_name": "Peter",
      "sos_event_id": "uuid",
      "media_count": 3,
      "locked": true,
      "created_at": "2026-06-25T02:15:31.000Z"
    }
  ],
  "next_cursor": null
}
```

Promote to evidence:

```http
POST /api/admin/media/:mediaItemId/promote-evidence
Content-Type: application/json
```

Request:

```json
{
  "work_order_id": "uuid",
  "type": "VIDEO|AUDIO|GPS_TRACK",
  "retained_until": "2026-12-22T00:00:00.000Z"
}
```

Response `201`:

```json
{
  "evidence_id": "uuid",
  "media_item_id": "uuid",
  "oss_key": "evidence/prod/2026/06/work-order-id/evidence-id.jpg",
  "retained_until": "2026-12-22T00:00:00.000Z"
}
```

Admin UI should include:

- Filter tabs for all media, emergency albums, and pending uploads.
- Search/filter by user, SOS event, resort, device, date range, and media status.
- Thumbnail grid with list-density controls for repeated patrol/admin work.
- SOS detail panel showing linked emergency album and capture/upload state.
- Preview through signed GET URLs only; never expose raw OSS keys in UI.
- Delete/restore controls with disabled states and reasons for locked emergency/evidence items.
- Promote-to-evidence action for emergency media tied to a work order.

## Authorization and Privacy

- Users can read and manage only their own non-deleted albums.
- Users cannot delete locked emergency albums or evidence-linked media.
- Admins can list media across users through admin routes, but all previews still use short-lived signed URLs.
- Emergency media is visible to admin/patrol workflows tied to the SOS event. Normal user albums are not broadcast over SOS WebSocket rooms.
- Do not store raw Wi-Fi Direct credentials, private SSIDs, or local IPs beyond short-lived diagnostics.
- Do not include phone numbers, names, coordinates, or original device paths in OSS keys.

## Testing Gates

Backend:

- Album creation requires auth and creates only user-owned `USER` albums.
- Upload URL rejects unsupported MIME types, wrong owner album, oversized files, and stale device ownership.
- Complete-upload verifies OSS object existence before marking `AVAILABLE`.
- Download URL requires owner or admin access and expires as configured.
- Delete rejects locked emergency media and evidence-linked media.
- Emergency SOS trigger creates exactly one emergency album per SOS event, even under retry.
- Failed capture/upload does not fail SOS trigger or admin SOS dispatch.
- Admin promote-to-evidence creates `evidence` and links `media_items.evidence_id`.

Mobile:

- Wi-Fi Direct discovery handles permission denial, timeout, disconnect, and retry.
- Manifest browse does not upload until user selects media or emergency capture requires it.
- Duplicate goggle files do not create duplicate media items.
- Upload retry resumes a `PENDING_UPLOAD` media item where possible.
- Emergency capture ack is sent for capture, unavailable, and failed paths.

Admin:

- Media page filters emergency albums and pending uploads.
- Preview fetches signed URLs lazily and handles expiry by refetching.
- Locked/evidence media shows disabled destructive actions with reason.
- SOS detail receives `emergency_media_available` or falls back to `refresh_sos`.

Manual smoke:

1. Pair a Flow S goggle and start Wi-Fi Direct browse.
2. Download one photo from the goggle manifest.
3. Upload through signed PUT URL and complete the media item.
4. Confirm the album shows the photo on mobile and admin preview uses a signed GET URL.
5. Trigger SOS with the goggle connected.
6. Confirm an emergency album appears immediately in admin SOS detail.
7. Confirm auto-captured media uploads into that emergency album.
8. Promote one emergency item to evidence and verify the linked `evidence.oss_key`.

## Risks and Follow-ups

- Wi-Fi Direct behavior differs between iOS and Android and may need native package or permission changes. That is a separate approval-gated implementation decision.
- Backend cannot guarantee emergency capture if the mobile app/goggle bridge is disconnected. SOS must remain successful without media.
- OSS object lifecycle and evidence retention must be coordinated carefully so user media cleanup cannot delete active rescue evidence.
- `EvidenceType` currently lacks `PHOTO`. Resolution: add `PHOTO` to the EvidenceType enum with migration `ALTER TYPE "EvidenceType" ADD VALUE 'PHOTO'`, ran before PR A migrations. Emergency photos promoted to evidence will use `type=PHOTO`.
- Prisma cannot express every useful partial index. The migration may need raw SQL for unique emergency album per SOS event and retention indexes.
- Admin auth remains password-header based in parts of the app. Audit media admin actions before exposing cross-user previews.
