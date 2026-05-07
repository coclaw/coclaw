---
'@coclaw/openclaw-coclaw': patch
---

Mirror `rpc-queue.close` summary to the local logger so developers debugging on a single host can grep the close anomaly in the gateway log file. Previously `summarize()` only emitted via `remoteLog`, which routes to the server side — leaving operators on a local machine unable to see drop counts, residual bytes, fsBroken / spillActive flags, or `lastReason` at session teardown without server-side access.

The local emission uses the existing tagged form `[rpc-queue conn=X] close <fields>` (consistent with `overflow-start` / `disk-cap-start` / `spill-start` etc.), gated by the same `hasAnomaly` check so clean sessions stay silent. Field order and values are identical to the remoteLog counterpart so a single grep regex works against both sources.
