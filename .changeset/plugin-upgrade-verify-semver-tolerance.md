---
"@coclaw/openclaw-coclaw": patch
---

Auto-upgrade verification now accepts any installed version that is **greater than or equal to** the originally scheduled `toVersion`, not only a strict string match. Also records the **actually installed** version in `upgrade-state.json.lastUpgrade.to` (and `upgrade-log.jsonl`) instead of the scheduled target.

Motivation: between the moment the scheduler observes `latest=x` on the npm registry and the moment the worker actually runs `openclaw plugins update`, the dist-tag can advance to `x+1`. Under the old strict-equal verification this was reported as "version mismatch", triggering a rollback and permanently skipping `x` — even though the install had succeeded and produced an even newer version. The plugin would be stuck on the prior version until the next manual intervention.

The worker now uses the same semver comparison as the scheduler (locally duplicated to avoid cross-process imports from the gateway), and reports `version-too-old got=X want>=Y` as the failure reason when the observed version is still older than the target. Documentation in `docs/auto-upgrade.md` has been brought back in sync with the current single-path (upgradeHealth polling) verification flow.
