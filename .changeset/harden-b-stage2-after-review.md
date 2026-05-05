---
'@coclaw/openclaw-coclaw': patch
---

Harden B-stage2 after deep-review. The B9b cut from `MemoryQueue` to `FileBackedQueue` accidentally dropped the `maxMessageBytes: MAX_SINGLE_MSG_BYTES` admission that `MemoryQueue` had been enforcing — single frames > 50 MB could enter the FBQ backlog and only get rejected later inside `RpcDcSender` (with `MESSAGE_OVERSIZED`), bypassing the `onDrop('oversize', size)` loud-on-loss accounting that the rpc-drop-monitor relies on, and letting `bypassAdmission` whitelist traffic skip even the `diskCap` ceiling.

`FileBackedQueue` now mirrors `MemoryQueue` exactly: optional `maxMessageBytes` constructor option (default `Infinity`), validated as `Infinity` or finite positive, enforced before the disk-cap admission and before the bypass predicate (so whitelisted messages do **not** escape the per-message hard cap, matching red-line 3). The webrtc-peer assembly site explicitly passes `maxMessageBytes: MAX_SINGLE_MSG_BYTES` to FBQ so the FBQ path now drops oversize frames at enqueue time with `reason: 'oversize'`, just like the legacy `MemoryQueue` path.

Three smaller follow-throughs from the same review pass:
- The `rpc queue impl=…` info log + `rtc.queue-impl` remoteLog now fire **after** the stale-identity guard, so stale assemblies that destroy and exit do not emit a misleading "fbq" line.
- `__setupDataChannel`'s opening comment and the FBQ `__handleFsError` inner `catch` binding (`rmErr`) are updated so they no longer reference the old `MemoryQueue`-only world / shadow the outer `err` parameter.
- B9b's default-fbq and mem-fallback tests now assert on the actual `diskCap` / `memBudget` / `maxMessageBytes` values, so a wiring mistake at the assembly site is detectable.

Also records a PRE-EXISTING TODO entry (`sendPeerTransport sig` rollback has no re-trigger) caught during the review — the race exists since plan-1 round-2 introduced async `MemoryQueue.init()`, but the FBQ swap stretches the window from microsecond-level to tens-of-milliseconds, making the bug far easier to hit. Diagnostic-only impact (peer-transport candidate info missing in the UI), not RPC business; deferred out-of-scope.
