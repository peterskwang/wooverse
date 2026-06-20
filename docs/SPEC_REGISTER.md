# Spec Register — What Exists in Wooverse

> Single source of truth. Read before any task. Update after any task.
> If a feature isn't listed here, it doesn't exist yet.

## Phase 1 — Core Foundation
- **Device Registration:** Registration.tsx → POST /api/register → users table
- **JWT Auth:** Token-based, device-bound, no passwords
- **Group Joining:** JoinScreen.tsx → POST /api/groups/join → users.groups
- **Group Creation:** POST /api/groups/create → groups table
- **User Profile:** user metadata stored in users table (JSONB)
- Built: 2026-02

## Phase 2 — Intercom & GPS
- **Push-to-Talk Intercom:** IntercomScreen.tsx → WebSocket "intercom_audio" binary frames
- **BLE Goggles Bridge:** AudioBridge.ts → native audio relay (not Expo Go compatible)
- **Audio Codec:** Opus @ 16kHz mono
- **Live GPS Map:** MapScreen.tsx → Gaode Maps via GAODE_API_KEY
- **Location Sharing:** WebSocket "location_update" → broadcast to group
- **Location Storage:** Upsert pattern — single row per user in locations table
- **Privacy:** GPS stops when app backgrounded
- Built: 2026-03

## Phase 3 — SOS & Database
- **Manual SOS:** SOSScreen.tsx → POST /api/sos/trigger → sos_alerts table
- **SOS Alert Flow:** Trigger → store in DB → push notification to group → WebSocket broadcast
- **SOS Resolution:** POST /api/sos/resolve → updates resolved_at
- **DB Migration:** 002_phase3.sql — sos_alerts table
- Built: 2026-04

## Phase 4 — Groups, UI, Push, Background GPS
- **Group Management:** admin push, member lists, leave/rejoin
- **Push Notifications:** Expo Push API — SOS alerts, group invites
- **Background GPS:** foreground-only, stops on background (privacy decision)
- **Admin Dashboard:** Next.js admin panel @ port 8101
- **DB Migration:** 003_push_tokens.sql — push_tokens table
- Built: 2026-05

## Phase 5 — Features (in progress)
- **Run Tracking:** RunTrackingScreen.tsx (branched, not merged)
- **Stats Dashboard:** StatsDashboard.tsx (branched, not merged)
- **Goggle Simulator:** dev tool for testing BLE without hardware (branched)
- **Rebrand & Auth:** feature/rebrand-and-auth branch (not merged)

## Future / Not Yet Built
- [ ] Auto-SOS (prolonged inactivity trigger)
- [ ] Offline SOS queue
- [ ] Group chat text messages
- [ ] Ski patrol admin panel
- [ ] Weather integration
- [ ] Slope difficulty overlay
- [ ] Friend system (add/follow/search)
- [ ] Battery optimization for GPS polling
