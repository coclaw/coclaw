---
'@coclaw/ui': patch
---

Add `credRemain` field to all ICE restart remoteLog lines on the UI side.

`credRemain` reports the seconds remaining until the embedded TURN credential expires (negative when already expired, `none` when no creds or unparseable). Helps diagnose whether ICE restart failures correlate with stale credentials (PC lifetime > 24h cred TTL window). Pure telemetry — no behavior change. UI caches the parsed expiry on `__credExpireAt` at `__buildPeerConnection` time.
