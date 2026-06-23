---
"@coclaw/openclaw-coclaw": patch
---

Relax the auto-upgrade `lastUpgrade.error` truncation cap so the failure root cause is no longer cut from remote diagnostics. `worker.js` already tail-caps each of message/stdout/stderr at 500 chars (after redaction) into a `prefix: … | stdout: … | stderr: …` composite (~1547 max), but `state.js` then applied a second global `slice(-500)` to the whole composite before storing `lastUpgrade.error`. When the local CLI's stderr noise exceeded 500 chars, that global tail kept only the trailing stderr segment and dropped the mid-composite stdout failure (e.g. an npm 404), so the remote `upgrade.result error=…` report showed only stderr noise. The state-side cap is now 1600 (≥ the worker composite max) so a worker-formatted failure is never re-truncated, while still bounding error strings from other sources. The full untruncated error remains in the local `upgrade-log.jsonl`.
