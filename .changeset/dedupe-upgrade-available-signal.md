---
"@coclaw/openclaw-coclaw": patch
---

Deduplicate the `upgrade.available` diagnostic signal. A gateway stuck in a persistent upgrade-failure loop no longer re-emits the same remote log every check cycle — it now routes through the existing per-`(reason, toVersion)` gate-signal dedup, consistent with its sibling signals (`upgrade.skipped`, `source-skip`, etc.). The signal resets on gateway restart and re-emits when a newer version appears.
