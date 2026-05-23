---
'@coclaw/openclaw-coclaw': patch
---

fix(plugin/file-manager): dedupe ws close cleanup listener on dc error → close sequence

`dc.onerror` and the not-done branch of `dc.onclose` both attached
`ws.on('close', () => safeUnlink(tmpPath))` and called `ws.destroy()`. In
the real pion sequence (error followed by close), both fired in order:
`dc.onerror` set `wsError = true` but did not set `dcClosed`, so
`dc.onclose`'s else branch still ran and attached a second listener,
producing a redundant `safeUnlink` (second one ENOENT-swallowed) and a
second `file.up.fail reason=dc-closed` log on top of the
`reason=dc-error` log.

Introduce a one-shot `cleanupAttached` flag (`attachTmpCleanupOnce()`)
shared by both cleanup paths, and skip the `reason=dc-closed` log when
`wsError` is already set. Result: at most one `ws.on('close')` listener
and at most one `file.up.fail` log per upload regardless of which side
fires first.

A `wsError`-only early-return guard was considered first but would have
broken the `SIZE_EXCEEDED` path — that branch sets `wsError = true`,
synchronously calls `safeUnlink` (ENOENT-swallowed pre-fopen), then
triggers `dc.close()`, and still relies on `dc.onclose`'s attach as the
post-fopen orphan-tmp safety net. The flag-based dedup keeps that
safety net intact (SIZE_EXCEEDED still legitimately fires two
`safeUnlink` invocations — the synchronous one and the post-fopen one
from the listener — by design).
