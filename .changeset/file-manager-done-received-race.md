---
'@coclaw/openclaw-coclaw': patch
---

fix(plugin/file-manager): close orphan-tmp race on `doneReceived=true` error paths

Commit `3f9d05e` fixed the fopen-vs-unlink race on the cancel /
`SIZE_EXCEEDED` / `dc.onerror` / `dc.onclose` (not-done) paths by
attaching `ws.on('close', () => safeUnlink(tmpPath))` so cleanup runs
only after `fs.WriteStream` opens its fd. Two `doneReceived=true` error
paths were missed:

- `drainLoop` catch block (sync `ws.write` throw)
- `ws.on('error')` handler (stream emits 'error')

Both did a synchronous `safeUnlink(tmpPath)` that races the in-flight
fopen — ENOENT-swallowed pre-fopen, then fopen completes and creates an
orphan tmp file with no one to clean it. Replace both with the existing
`attachTmpCleanupOnce()` helper. In both paths, `attachTmpCleanupOnce()`
and `ws.destroy()` run *before* `sendError()` so the cleanup listener is
in place before `sendError`'s synchronous `dc.close()` re-enters
`finishUpload()` via `dc.onclose` (in the `doneReceived=true &&
!finishing` case). The `ws.on('error')` handler also calls `ws.destroy()`
explicitly rather than relying on Node 18+ autoDestroy —
`_createWriteStream` is dependency-injected, and a non-standard stream
could emit `error` without ever emitting `close`, leaving the listener
dangling.

The race is structurally real but unreachable in production with
`fs.createWriteStream`: the `drainLoop` catch is defensive against an
upstream sync throw that no current path produces, and a real
`fs.WriteStream` only emits 'error' either before fopen (no file to
orphan) or after fopen (sync unlink would find the file). The fix
closes the structural gap and removes the not-done / done-path
inconsistency for future contributors. Two regression tests cover both
trigger chains.

The three sync `safeUnlink` calls inside `finishUpload`'s `ws.end`
callback (dcClosed / size-mismatch / rename-failed branches) are
unchanged: real Node `Writable` fires the `end` callback only after
'finish', which requires the fd to have been opened, so the unlink
necessarily runs after fopen.
