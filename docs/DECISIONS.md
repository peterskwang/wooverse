# Architecture Decisions — Wooverse

> Record every non-obvious decision. Before any task that touches architecture, read this.
> If you're about to reverse a decision here, stop and discuss first.

## Decisions

### D1: WebSocket over SSE
**Date:** 2026-02 · **By:** Henry
**Why:** Bidirectional communication needed for intercom audio relay. SSE is server→client only. WebSocket supports binary frames (audio) natively.
**Do not change to SSE** without solving the audio uplink problem.

### D2: Opus Audio Codec, not PCM
**Date:** 2026-03 · **By:** Henry
**Why:** 16kHz Opus mono is ~6x smaller than PCM at equivalent quality. Critical for BLE bandwidth (goggles bridge). Tested with 50 concurrent users on M1 simulation.
**Do not change** without BLE throughput profiling with real hardware.

### D3: Upsert for Locations, not Append
**Date:** 2026-04 · **By:** Henry
**Why:** 50 skiers × 1 GPS update/sec × 3600 sec = 180 million rows/hour if using append. Upsert keeps 50 rows (one per user). For real-time GPS, append is a scaling disaster.
**Do not change to append** without profiling against 50+ user load test.

### D4: App-Level Auth, not PostgreSQL RLS
**Date:** 2026-02 · **By:** Henry
**Why:** JWT validation in Express middleware is simpler and avoids per-query RLS overhead. Device-bound auth means we control token lifecycle, not DB roles.
**Do not add RLS** without benchmarking against current middleware approach.

### D5: UUID Primary Keys, not Serial
**Date:** 2026-02 · **By:** Henry
**Why:** Device-bound auth means user IDs are generated client-side. Predictable serial IDs leak user count and allow enumeration. UUIDs prevent this.
**No change.**

### D6: Expo Router, not React Navigation
**Date:** 2026-05 · **By:** frontlead-woo
**Why:** Expo Router is the official standard for new Expo projects. File-based routing. React Navigation remains available as underlying implementation.
**Do not migrate back to React Navigation standalone.**

### D7: Foreground GPS Only
**Date:** 2026-05 · **By:** Peter
**Why:** Privacy decision — skiers' locations stop sharing when app backgrounded. Battery conservation is a secondary benefit.
**Do not add background GPS** without explicit approval and privacy review.

### D8: Gaode Maps, not Google Maps
**Date:** 2026-03 · **By:** Peter
**Why:** Target market is China ski resorts. Gaode (AMap) has better coverage, Chinese UI support, and operates without VPN.
**No change.**

## Anti-Decisions (Rejected Approaches)

| Approach | Rejected Why | Date |
|----------|-------------|------|
| GraphQL | Added latency for real-time GPS, complex BLE audio handling. REST + WebSocket simpler | 2026-02 |
| MongoDB | Relational data (users, groups, SOS history). SQL fits better. JSONB in Postgres covers flexible fields | 2026-02 |
| Firebase | Vendor lock-in. Self-hosted Postgres + Express gives full control | 2026-02 |
| React Navigation standalone | Expo Router is standard path forward | 2026-05 |
| Background GPS | Privacy + battery. Foreground-only is explicit decision | 2026-05 |
