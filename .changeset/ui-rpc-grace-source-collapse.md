---
"@coclaw/ui": patch
---

fix(ui): collapse "wait for persistence" into agent-runs source via rpc grace window

The Bug 1 follow-up review surfaced a fast-follow-up regression in the
prior `chat.store` fix: when the user sent a second message inside the
3s persist-wait window of the first, the second run's
`hasTerminalAssistantAfter(messages, anchorId)` check could match the
first run's just-persisted final assistant (it sits after the second
run's anchor by construction) and prematurely drop the second overlay
before its transcript was flushed. Root cause: the predicate had no
runId/turn discriminator, so any terminal assistant after the anchor
counted.

Move the "wait for persistence" responsibility from `chat.store` (which
can't reliably distinguish runs) to the source state machine
(`agent-runs.store`), which has authoritative `runId` context. When
`lifecycle:end` or `agent.wait` terminal status arrives, we no longer
fire `__endRun` immediately — we schedule a `RPC_GRACE_MS` (default 2s)
pending and wait for the `rpc` two-phase response (the only signal that
guarantees transcript is already flushed via the upstream synchronous
await chain). If the `rpc` response arrives within the window, we clear
the pending and run finishes as `endReason='rpc'`. If the window
elapses, we fall back to the originally-recorded reason. The `failed`
signal (DC closed / RPC error) skips the grace and ends immediately
since the second-phase response can't possibly arrive.

`chat.store.__awaitPersistAndDrop` is simplified accordingly: the
endReason-based slow/fast path split, the 1s + 2s sleep + retry, the
`hasTerminalAssistantAfter` predicate, and the `agent.run.persist-stale`
fallback log are all removed. The function now does a single
`loadMessages → dropRun`, identical for every endReason. Silent
loadMessages failures still preserve the overlay (24h watchdog +
activate/reconnect reload still cover the rare double-failure case).

A diagnostic `agent.run.rpc-grace-elapsed runId=… reason=lifecycle|wait`
remoteLog is emitted when the grace timer expires without an `rpc`
signal — this replaces the removed `persist-stale` log so we retain the
ability to observe upstream rpc-2nd-phase delivery anomalies and tune
`RPC_GRACE_MS` if needed.

The fast follow-up bug is eliminated because the source-side grace
delays `runPromise` resolve by up to 2s, during which `isRunning`
remains true and the user cannot send a new message — the timing window
that produced the predicate confusion never opens. The user-visible
cost is at most a 2s extension of the "thinking" overlay on slow rpc
paths; when rpc arrives early (the common case) the grace clears
immediately and overlay teardown is unchanged.
