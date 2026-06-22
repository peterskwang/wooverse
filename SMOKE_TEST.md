# FLOW App — Pre-Release Smoke Test

**This checklist must be completed before any demo or release build is sent to external testers.**

Argus gate: if a PR or release does not include a completed smoke test section → **Request Changes, do not approve**.

---

## 🔴 P0 — Must pass before any demo ships

### Intercom
- [ ] Open Intercom tab → status shows **"Connected to group intercom"** within 5s (never stuck on "Connecting...")
- [ ] PTT button is **enabled and tappable** (not greyed out)
- [ ] Hold PTT on Phone A for ~1s (short) → **Phone B hears audio clearly** within ~2s
- [ ] Hold PTT on Phone A for ~5s (long message) → Phone B hears full audio, not cut off
- [ ] Phone B speaks back → Phone A hears it (bidirectional, both directions must work)
- [ ] iOS → Android: Phone A (iOS) speaks → Phone B (Android) hears it
- [ ] Android → iOS: Phone A (Android) speaks → Phone B (iOS) hears it
- [ ] Release PTT → channel shows clear, "Now Talking" resets
- [ ] PTT floor lock: Phone A holds PTT → Phone B tries PTT → gets "channel busy" indicator
- [ ] PTT floor release: Phone A disconnects → floor auto-releases, Phone B can talk

### iPod / AirPod
- [ ] Tap "Start Advertising" → status changes to "Advertising FLOW service"
- [ ] From Settings, scan + pair → iPod screen shows "Paired with FLOW app"
- [ ] Hold "HOLD TO TALK" → **no microphone error**, recording indicator visible
- [ ] Release → audio plays on paired side

### Map
- [ ] GPS blue dot appears on map within 10s of opening
- [ ] On second device (same group): teammate marker visible within 30s

### SOS
- [ ] Hold SOS button → confirmation dialog appears
- [ ] Confirm → alert appears in admin panel at `/sos`

### Settings / Auth
- [ ] Enter userId, groupId, display name → tap Save → values persist after app restart
- [ ] Join group by code → user appears in admin panel group member list

---

## 🟡 P1 — Must pass before production release

- [ ] Tested on **both iOS and Android**
- [ ] Background GPS continues broadcasting when app is minimised
- [ ] Fresh install (no cached data) → no crash on first launch
- [ ] AirPods connected → intercom audio routes through earphones correctly
- [ ] Two-phone full round-trip: both users can PTT and hear each other bidirectionally
- [ ] Audio quality acceptable at both short (~1s) and long (~10s) message durations

---

## After Every Merge to Main — Do This First

Before distributing the QR code to any tester, always restart Metro with a cache clear:

```bash
pm2 restart flow-frontend --update-env
# OR for a full cache bust:
pm2 stop flow-frontend && cd /opt/flow-app/frontend && CI=1 npx expo start --clear --lan --port 8081 &
```

Then verify the bundle is serving before handing the QR to testers:
```bash
curl -s http://5.223.73.76:8081/status  # should return: packager-status:running
```

Skipping this step will cause testers to get stale code or a loading timeout (issue #31).

## How to Run

1. Use two physical devices (simulator cannot test audio or BLE)
2. Both devices: Settings → enter the **same groupId**, different userId + display name → Save
3. Work through P0 checklist top to bottom, tick each item
4. Screenshot or screen-record any failures for the bug report

## Argus Enforcement

For any PR that ships frontend or audio changes:

1. Does the PR description include a smoke test section with all P0 items checked? → If not, **Request Changes**
2. Were both iOS and Android tested? → If only one platform, flag in review
3. Does the PR description describe *how* the fix was verified (not just "should work now")? → If not, **Request Changes**
