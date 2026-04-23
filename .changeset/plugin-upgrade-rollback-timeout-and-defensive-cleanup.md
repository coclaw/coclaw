---
"@coclaw/openclaw-coclaw": patch
---

Tighten two leftover edges in the auto-upgrade worker:

- **Rollback fallback install timeout raised from 120 s to 10 min** (aligned with the forward `plugins update` timeout). The fallback path is only reached when the local backup is missing, so the situation is already anomalous; giving npm download the same budget it has on the upgrade path makes recovery far more likely to actually succeed instead of tripping the timer. Trade-off: the fallback flow uninstalls the plugin before reinstalling the old version, and the final `gateway restart` only fires after install completes. This widens the "uninstalled in `openclaw.json` but old code still live in the gateway process" inconsistency window from ~2 min to ~10 min — accepted as the lesser evil than aborting recovery halfway. Scheduler's hourly check honors the existing PID-keyed `upgrade.lock`, so no concurrent worker is spawned during this window.
- **Removed the `?? toVersion` fallback** when recording the installed version into `lastUpgrade.to` / `upgrade-log.jsonl`. Under the current `pollUpgradeHealth` contract `result.version` is guaranteed to be a string whenever `result.ok` is true, so the fallback was dead code. Worse, if that contract were ever broken, the fallback would silently paper the break over with the scheduled target version — turning a "verify succeeded without a version" bug into an invisible one. With the fallback gone, such a break would surface as `undefined` in state/logs, which is exactly what we want during diagnosis.
