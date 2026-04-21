---
'@coclaw/openclaw-coclaw': patch
---

Cap pion SCTP RTO backoff at 10s and emit SCTP diagnostic samples on disconnect/recovery.

- Pass `settings: { sctpRtoMax: 10000 }` to the pion PeerConnection so that post-background-wake retransmission backoff is bounded by 10s instead of pion's 60s default. This lets the UI's 15s READY_TIMEOUT window cover the recovery path, fixing the "chat/topic spinner" symptom after long APK backgrounds.
- Add `__dumpSctpStats` that, on pion-impl sessions, samples `getSctpStats()` and emits a separate `rtc.sctp conn=... state=... cwnd=... srtt=...ms sent=... recv=... mtu=...` remoteLog line alongside `rtc.dump` (or `sctp=none` before the association is up, `error=<msg>` on rejection). Triggers piggyback on the existing `__dumpSessionState` call sites (ICE restart recovery + disconnected/failed), so `cwnd` collapsing to ~1×MTU with flat `bytesSent` is now observable.
- Both changes are gated by `__impl === 'pion'`; werift fallback is untouched. Bumps `@coclaw/pion-node` to `^0.3.0`.
