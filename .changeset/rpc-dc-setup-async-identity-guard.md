---
'@coclaw/openclaw-coclaw': patch
---

Tighten rpc DataChannel setup timing in webrtc-peer: `__setupDataChannel` is now async, awaits `queue.init()` before assigning the session triplet (queue/sender/consumeLoop), and re-checks identity (session still in map and `rpcChannel` still this dc) so concurrent `closeByConnId` or same-connId rebuilds during the init window cannot leave half-wired state. Same-connId rebuild also awaits the old `queue.destroy()` before constructing the new one. DC handlers (reassembler / onopen / onclose / onerror / onmessage) remain wired in the synchronous prologue so external code can dispatch dc events immediately. Behavior preserved with `MemoryQueue` (init is a no-op); the await + identity guard reserve the contract for the upcoming `FileBackedQueue` swap.
