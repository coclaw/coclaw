---
'@coclaw/openclaw-coclaw': patch
---

Expand `__dumpSessionState` queue diagnostics in webrtc-peer to surface six `MemoryQueue.stats()` fields (`memCount`/`memBytes`/`diskBytes`/`writtenBytes`/`spilled`/`fsBroken`) alongside the existing `droppedCount`/`droppedBytes`. The historical `queueLen` token is preserved as the `memCount` rendering; the four disk-related fields are constant zero/false on top of `MemoryQueue` and reserve the dump shape for the upcoming `FileBackedQueue` swap, when they will start carrying real values without requiring downstream parser changes.
