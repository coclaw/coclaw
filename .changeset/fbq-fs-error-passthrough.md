---
'@coclaw/openclaw-coclaw': patch
---

Pass underlying error through `FileBackedQueue.onDrop` for `'fs-error'` drops. `__handleFsError` now caches the error in `this.lastFsErr`; subsequent enqueues that hit the sticky `fsBroken` short-circuit forward the cached error to `onDrop(reason, size, err?)` so the drop monitor (and operators) see the actual errno / message instead of an opaque drop. `clear()` and `destroy()` reset `lastFsErr`. Non-`fs-error` drops (e.g. `'disk-cap'`) still pass `undefined` for the third arg, matching the existing monitor contract from plan-1 round-2.
