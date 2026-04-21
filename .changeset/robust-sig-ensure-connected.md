---
'@coclaw/ui': patch
---

Harden `SignalingConnection.ensureConnected` against stale WS states. Previously both `ensureConnected` and `__handleForegroundResume` trusted the JS-layer `__state` blindly — after long mobile backgrounds a `connected` state could mask a zombie TCP, and a `connecting` state could persist indefinitely after a stalled handshake. RTC would send offers into the void or wait up to 15s on a dead handshake.

Now `ensureConnected` applies a freshness safety net:

- `state === 'connected'` + `elapsed > HB_TIMEOUT_MS` (45s) → `forceReconnect()` then wait for new WS.
- `state === 'connecting'` + state-duration > `CONNECT_TIMEOUT_MS` (15s) → `forceReconnect()` then wait.

`__handleForegroundResume` applies the same staleness check in its `connecting` branch. The `verify` parameter, `VERIFY_COOLDOWN_MS` constant, and `__lastVerifiedAt` field are removed — their semantics are subsumed by the new unified freshness check. `webrtc-connection.js` rebuild path no longer passes `{verify:true}`; ICE restart path unchanged.

Eliminates the implicit dependency on event-listener registration order (WS handler before RTC handler), making the recovery path robust to future refactors of the foreground-event dispatch.
