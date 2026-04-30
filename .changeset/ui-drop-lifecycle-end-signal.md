---
"@coclaw/ui": patch
---

Drop `lifecycle:end` as an agent-run termination signal; switch the watcher probe to `agent.wait(timeoutMs=0)`.

Fixes a recurring "task incomplete + stop button gone but agent still running" symptom. OpenClaw emits multiple `lifecycle:end` events within a single completed run (compaction-retry, model-fallback, live-model-switch); the payload has no field that distinguishes a mid-run end from the true terminal one. Treating the first as terminal caused premature `endRun`, after which the dispatch entry guard silently dropped every subsequent streaming event.

Changes:
- `applyAgentEvent` (`utils/agent-stream.js`) no longer flags lifecycle events as `settled`. Lifecycle events are now side-effect-free; the dispatcher treats them like normal stream traffic, refreshing the idle timer.
- `agent-runs.store.js` removes `__onLifecycleEnd` and the lifecycle branch from `__dispatch`. End-of-run determination now relies on three signals: RPC second-phase response, `agent.wait(timeoutMs=0)` probe, and main RPC reject (DC physical death).
- The watcher's `__pollOnce` now calls `agent.wait` with `timeoutMs=0` so the server returns immediately without subscribing to the lifecycle stream. A `status='timeout'` with no `endedAt` re-arms the idle timer (now 60s) instead of recursing — this prevents a tight loop now that the probe returns immediately.

Residual exposure: the `agent.wait(0)` agent-job cache hit can still be transiently polluted by a mid-run lifecycle:end during the brief window before the next phase=start (compaction-retry 5–15s, model-fallback / live-switch <1s). A follow-up plugin-side registry of finalized runs based on the RPC response frame will close that window.
