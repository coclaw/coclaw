---
"@coclaw/ui": patch
---

Widen agent-run idle threshold to 24h to disable `agent.wait(timeoutMs=0)` probing.

The `agent.wait(0)` watcher path has a "two-cache forgetting" false-negative risk: when the gateway dedupe cache (5min TTL) and the agent-job cache (10min TTL) have both expired, `wait(0)` returns "still alive" for a run that has actually ended, leaving the run stuck on the UI side. Stretching `IDLE_THRESHOLD_MS` from 60s to 24h (= the run wall-clock TTL) makes the idle timer effectively unreachable: every run will already have ended via signal 1 (main RPC second-phase response) or signal 3 (DC death) well before that point. Run-end determination therefore relies entirely on signals 1 and 3 in this stage.

`__pollOnce`, the `agent.wait(timeoutMs=0)` call, the three-branch return handling, `waitPending`, and `TERMINAL_WAIT_STATUSES` are all kept verbatim so the watcher skeleton can be repointed to a future plugin-side "agent-run terminal-status" RPC by simply restoring the threshold to 60s.

Residual exposure: when the gateway-side phase-2 `res` is dropped or pre-empted and the data channel stays alive, the run cannot be settled in this stage. A follow-up plugin-side whitelist that exempts agent-run RPC responses from the send-queue soft-cap drop closes the dropped-frame branch; the pre-empted-RPC branch will be addressed by the future terminal-status RPC.
