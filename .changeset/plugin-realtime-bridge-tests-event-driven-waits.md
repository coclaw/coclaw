---
'@coclaw/openclaw-coclaw': patch
---

Speed up the realtime-bridge test suite by replacing fixed `setTimeout` sleeps with event-driven waits. Three changes in one pass:

1. The `ensureAgentSession should NOT reset on resolve timeout` test no longer waits for the production code's hardcoded 2 s `sessions.resolve` timer — it stubs `bridge.__gatewayRpc` to return `{ok:false, error:'timeout'}` immediately and verifies that no `sessions.reset` is sent. The end-to-end `__gatewayRpc` timeout path remains covered by the dedicated `__gatewayAgentRpc` timeout tests.
2. A small `waitFor(predicate, opts)` helper replaces 26 × 50 ms, 2 × 100 ms, and the 80 ms TTL-scan sleep across the rtc-signaling, WebRTC-peer init, broadcast, gateway-DC routing, and remote-log flush tests. Each replacement targets the specific signal the next assertion needs (peer created, answer forwarded to server, broadcast queue advanced, buffer drained, `__sessions` populated, etc.) so each test proceeds the moment the SUT is actually ready.
3. Two intentional fixed sleeps are preserved: the `setTimeout(50)` inside the slow-preload mock (the test verifies `start()` waits for it) and the multi-step `setTimeout(0)/(5)/(100)` sequence in the `rpc/unbound/close/send-fail branches` test (deeply entangled async chain with no single positive signal).

The bridge implementation is not modified. Coverage stays at 100/100/100 lines/functions/statements with branches unchanged. realtime-bridge test file drops from ~18.2 s to ~16.2 s (-11%); the whole plugin suite drops by ~2 s.
