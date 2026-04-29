---
'@coclaw/ui': patch
---

Emit remote diagnostic logs at every agent run termination point. `__endRun` now reports `agent.run.end runId=... reason=...` for all 10 reasons (`rpc` / `lifecycle` / `wait` / `failed` / `timeout` / `manual` / `superseded` / `claw-removed` / `logout` / `cleanup`); `dropRun` reports `agent.run.drop` when streaming placeholders are actually released; `register` reports `agent.run.preempt` linking the new and old runId when a same-runKey old run is superseded. This closes the observability gap (signals 1, 3, 5, 6 previously emitted no remote log), so when "task incomplete" is misjudged we can pinpoint which path drove the run-end from server logs alone.
