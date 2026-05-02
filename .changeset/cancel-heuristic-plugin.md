---
'@coclaw/openclaw-coclaw': minor
---

Add gone-fallback heuristic to `coclaw.agent.abort`:

- Accept new request fields `runDuration` and `abortDuration` (both ms, wall-clock) from UI.
- When the side-door abort returns `not-found` and both gates are met (`runDuration >= 3min` AND `abortDuration >= 1min`), upgrade the response to `{ ok: false, reason: 'gone' }` so the UI can settle the cancel coordination instead of ticking forever.
- Old UIs that omit the duration fields keep getting `not-found` (no behavior change, full backward compatibility).
- Emit `abort.gone sid=… runDur=… abortDur=…` remoteLog on each upgrade as an early signal to monitor heuristic accuracy.

The pure decision logic lives in the new `src/agent-cancel-heuristic.js` (thresholds exported as constants for tuning).
