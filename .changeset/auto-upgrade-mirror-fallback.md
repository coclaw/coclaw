---
'@coclaw/openclaw-coclaw': minor
---

Harden plugin auto-upgrade against slow npm downloads and registry-side throttling, fixing the upgrade loop observed on slow / firewalled networks.

- Raise the `openclaw plugins update` execution timeout from 2 minutes to 10 minutes, so first-time installs of native deps (e.g. `node-datachannel`) no longer get killed mid-download.
- Add a one-shot reverse-mirror retry: if the first attempt fails (timeout / 429 / network error), the worker reads the user's current `npm config get registry` and retries once with the opposite side — `npmjs.org` users fall back to `registry.npmmirror.com`, and `npmmirror` users fall back to `registry.npmjs.org`. Either side being healthy is enough to escape the failure.
- Increase the scheduler's first-check delay from 5 minutes to 60 minutes (effective range 60-120 minutes random). Prevents the failed-upgrade → gateway-restart → re-check cycle from disturbing gateway availability every few minutes when an upgrade keeps failing.
- Preserve the original `skipVersion: false` semantics on update-command failures: failures are still treated as transient and re-attempted on the next cycle (now an hour later, not minutes).
