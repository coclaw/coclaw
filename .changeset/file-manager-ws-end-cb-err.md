---
'@coclaw/openclaw-coclaw': patch
---

fix(plugin/file-manager): handle err parameter in finishUpload ws.end callback

Node's `Writable.end(cb)` invokes the pending end callback with an `err`
argument whenever the stream is `destroy()`-ed before reaching the
normal 'finish' state (`destroy(e)` passes `e`; `destroy()` passes
`ERR_STREAM_DESTROYED`). Verified locally on Node 22 and consistent with
documented behavior on Node 18+.

`finishUpload`'s `ws.end` callback previously ignored that parameter, so
on any `destroy`-driven path it would fall through to the `dcClosed` /
size-mismatch / `rename` branches. Production was safe in practice only
because every path that destroys `ws` (drain catch, `ws.on('error')`,
`dc.onerror`, `SIZE_EXCEEDED`) first triggers `sendError(dc, ...)` whose
synchronous `dc.close()` sets `dcClosed=true`, and the `dcClosed` early
return then masks `rename`. That made correctness an implicit dependency
on the `dcClosed` early-return — a hazard for future edits.

Accept `err` explicitly and short-circuit with `attachTmpCleanupOnce()`:
register the `ws.on('close', safeUnlink)` listener idempotently, then
return. The listener fires after the fd is closed (and therefore after
fopen completed), so tmp cleanup remains race-safe even when the err
path is taken before fopen finishes. The four error chains that today
destroy `ws` already attach `attachTmpCleanupOnce` upstream; the new
branch is a redundant safety net for them and prophylactic for future
paths that might destroy `ws` without first registering cleanup.

Observable change: the trailing
`file.up.fail reason=dc-closed-before-flush` `remoteLog` no longer fires
on the four `sendError`-driven destroy chains, because the err branch
short-circuits before reaching the `dcClosed` branch that emits it. Each
of those chains already emits a more specific failure reason
(`write-error` / `drain-write-error` / `dc-error` / `size-exceeded`), so
this is log deduplication, not signal loss. The `dc-closed-before-flush`
event still fires on the non-error path where the DC peer closes
gracefully after `done` while `ws` is still flushing (cb receives
`null`, `dcClosed` branch still runs).

One regression test pins the contract: with a `fakeWs`
(`EventEmitter`-based) that lets the test invoke `endCb(new Error(...))`
directly — bypassing the `sendError → dcClosed` early-return — the
handler must not call `rename` and must not send any response beyond the
initial ready ack.
