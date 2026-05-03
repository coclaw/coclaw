---
'@coclaw/openclaw-coclaw': patch
---

Round-2 hardening of rpc-drop-monitor wiring after multi-dimensional deep review:

- **Race fix between in-flight broadcast and DC close**: `MemoryQueue.destroy()` now accepts an optional synchronous `onBeforeClear(residual)` callback that fires inside the mutex, immediately before the in-memory queue is cleared. `WebRtcPeer` (`closeByConnId`, `dc.onclose`, `setupDataChannel` rebuild cleanup, consume-loop finally) drives `monitor.summarize` through this callback so the residual snapshot reflects every enqueue that arrived in the same tick — including in-flight `broadcast()` calls whose mutex-queued enqueue had not yet executed when `dc.onclose` fired. Previously the synchronous `queue.stats()` read happened before the in-flight enqueue could land, undercounting the residual.
- **`rpc-queue.close` log gains residual disk tokens**: the close summary now appends `residualDiskBytes` and `residualWrittenBytes` between the existing memory residual tokens and `fsBroken`/`lastReason`. On `MemoryQueue` they stay zero; on the upcoming `FileBackedQueue` they will surface disk-side residual data without further wiring changes. `monitor.summarize` `hasAnomaly` decision now also considers these two fields, so a session ending with disk-only residual still emits a close log.
- **`maybeEmitOverflowEnd` null-stat guard**: the helper now returns early if `stats` is null/undefined, preventing a TypeError if a future caller forgets to pass `queue.stats()`.
- **WebRtcPeer outer try/catch removed**: now that `monitor` internals defensively wrap every logger/remoteLog call and the new `destroy` callback contract is synchronous, the outer `try { monitor.X() } catch {}` wrappers in the four cleanup paths are gone — keeping a single defensive line inside the monitor instead of two redundant ones, and clearing the dead-branch noise from coverage reports.
- **JSDoc + monitor module header refreshed** to describe the new close-log token order and document `onBeforeClear` as strictly synchronous.

No public-facing behavior change beyond the additive close-log tokens (operator greps on the existing tokens still match). Tests added: `MemoryQueue.destroy(callback)` covers the in-flight snapshot, callback-throw-swallowed, idempotency, and residual-zero paths; `rpc-drop-monitor` covers `oversize`-only `dropCount` summarize, residual-disk-only summarize, and stats-null guards; `WebRtcPeer` race-fix test asserts the `dc.onclose` snapshot sees an in-flight broadcast.
