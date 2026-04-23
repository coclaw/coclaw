---
"@coclaw/openclaw-coclaw": patch
---

Make stale upgrade-lock cleanup failures observable (local warn + remoteLog upstream).

Previously every `fs.rm` call that cleaned a stale `upgrade.lock` swallowed errors with `.catch(() => {})`. Since `{ force: true }` already suppresses "file not found", any error reaching the catch is a real system-level failure — permission denied, read-only filesystem, lock path replaced by a directory, etc. Swallowing it was dangerous: if the cleanup failure co-occurs with a `writeUpgradeLock` failure (same underlying fault), the lock file retains the stale (expired) contents forever. Every subsequent hourly scheduler check then re-enters the same "judge as expired → fail to remove → spawn parallel worker" loop, piling up workers that race against each other on the same backup directory and state files. Before this change there was no local warn log and no remote signal, so the issue could only be diagnosed post-mortem.

Three stale-lock branches (`missing-pid`, `ttl-exceeded`, `pid-dead`) are now routed through a single `removeStaleLock(lockPath, reason, logger)` helper. On success it logs an info line as before; on failure it logs a `warn` with the reason and error message, and emits `upgrade.lock-cleanup-failed reason=<reason> msg=<err>` via `remoteLog` so server-side observability sees it. The helper itself does not throw, so the gateway-stability guarantee of `isUpgradeLocked` is preserved. The `reason` values are short tokens (no spaces) so they work as `key=value` fields in the remote-log wire format and are easy to bucket.

Incidental fix: the old code emitted `Stale lock removed` before attempting the removal, which meant the log claimed success even when the removal had actually failed. The new helper logs only on actual success.
