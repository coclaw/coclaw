---
"@coclaw/openclaw-coclaw": patch
---

Throttle rpc DC queue-full drop logs to state transitions only.

When a UI instance disconnects and ICE fails, the plugin-side rpc DataChannel can stay technically open while its application-layer send queue stays permanently full — `bufferedamountlow` never fires, so `__drain` never runs, and the queue never returns below `MAX_QUEUE_BYTES`. Every subsequent `send()` from gateway then takes the queue-full branch. Previously this branch emitted a `logger.warn('drop reason=queue-full ...')` line on every drop, while only `remoteLog overflow-start` was state-gated. In practice one stuck connection produced 1641 warn lines over 5+ hours, swamping the gateway log.

Both `logger` and `remoteLog` now fire only on the false→true and true→false transitions of `queueOverflowActive`. Drops while already in overflow are silently counted into `droppedCount` / `droppedBytes`; the cumulative numbers are reported on the next state flip (`overflow-end`, with matching `info` and remoteLog) or on `close()` (existing summary). `single-msg-oversize` drops still warn on every occurrence — they reflect application bugs rather than queue pressure, and aren't gated by `queueOverflowActive`. The 10 MB drop threshold and existing drain semantics are unchanged.
