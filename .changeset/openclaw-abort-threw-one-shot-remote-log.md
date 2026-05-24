---
'@coclaw/openclaw-coclaw': patch
---

feat(plugin): one-shot `abort.threw` remoteLog for diagnostic visibility

`coclaw.agent.abort` previously silenced both `logger.info` and any
remoteLog on `reason=abort-threw` after the noise-suppression change.
That left ops without any signal when the upstream `handle.abort()`
starts throwing persistently — the only failure mode that triggers a
500ms UI retry storm in the first place.

A module-level boolean flag now lets the handler emit one
`abort.threw sid=… error=…` remoteLog per gateway-process lifetime;
subsequent abort-threw ticks (same or different sessionId) stay
silent. `logger.info` remains suppressed for all abort-threw ticks.

The flag is exposed via `__resetAbortThrewReported` for tests; the
process-level semantics are explicitly asserted (one-shot across two
sessionIds, plus a reset path).
