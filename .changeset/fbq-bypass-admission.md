---
'@coclaw/openclaw-coclaw': patch
---

Add `bypassAdmission` option to `FileBackedQueue`, mirroring `MemoryQueue` semantics: callers may inject a predicate that exempts whitelisted messages from the `diskCap` admission check. Capacity-layer exemption only — physical IO failures (`fsBroken`) still drop with `'fs-error'`, even for whitelisted messages. The predicate is invoked under try/catch; an exception is treated as non-bypass (conservative drop). Non-function values are coerced to no-op for backward compatibility. Prepares the queue for B-stage2 swap into the WebRTC RPC send path so agent-run responses can survive sustained backpressure that would otherwise hit `diskCap`.
