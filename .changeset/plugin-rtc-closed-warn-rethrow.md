---
"@coclaw/openclaw-coclaw": patch
---

Tighten rtc signaling diagnostics and reclaim semantics. The realtime-bridge outer catch on `handleSignaling` now logs and remoteLogs `rtc.signaling-error` with structured `type=<rtc:offer|rtc:closed|rtc:ice>` and `conn=<connId>` fields, so server-side ops can locate the signaling path that failed without parsing the message string. `WebRtcPeer.closeAll` becomes a while-drain loop — any session that lands in the table while the first round is awaiting `pc.close` is reclaimed by the next round, structurally eliminating the previously documented snapshot race instead of relying on the 12h failed-TTL fallback. The rtc:closed handler reverts to a one-line bare await; the original close-failure rethrow contract is preserved through the new structured outer-catch fields.
