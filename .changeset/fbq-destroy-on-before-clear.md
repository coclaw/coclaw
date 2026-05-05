---
'@coclaw/openclaw-coclaw': patch
---

Add optional synchronous `onBeforeClear` hook to `FileBackedQueue.destroy`, mirroring `MemoryQueue.destroy`. The hook fires inside the destroy mutex — after `destroyed = true` but before stream close / file removal / state reset — and receives an atomic 6-field residual snapshot (`memCount`, `memBytes`, `diskBytes`, `writtenBytes`, `spilled`, `fsBroken`) reflecting the real disk state. In-flight enqueues that won the mutex race ahead of destroy are reflected in the snapshot; enqueues that queue up behind destroy short-circuit on `destroyed = true` and return false (silent drop). Synchronous throws inside the callback are swallowed; if the callback returns a Promise, its rejection is unhandled (not awaited) — by design, matching the MemoryQueue contract: callers must pass a synchronous function. Lets `WebRtcPeer` keep its 4 `destroy((residual) => monitor.summarize(residual))` call sites unchanged after the B-stage2 swap to FBQ.
