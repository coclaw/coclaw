---
"@coclaw/openclaw-coclaw": patch
---

Add a 110-minute TTL to the auto-upgrade worker lock so the scheduler cannot be permanently blocked.

The lock (`~/.openclaw/coclaw/upgrade.lock`) previously relied solely on `process.kill(pid, 0)` liveness checks. Two rare-but-real scenarios could leave the lock forever "held": (1) the worker is killed by `SIGKILL` / OOM / power loss and never cleans up; (2) the OS recycles the dead worker's PID to an unrelated long-lived process (e.g. the gateway itself, or a system daemon), so `kill(pid, 0)` keeps succeeding. Under either scenario every subsequent hourly check short-circuits and auto-upgrade stays disabled until someone manually removes the lock file. The recent rollback-timeout widening (worst-case worker run ~36 min) makes the exposure window noticeably larger.

Fix: `isUpgradeLocked` now treats any lock whose recorded `ts` is older than 110 minutes — or whose `ts` is missing/unparseable — as stale and removes it. No process is killed; we only drop the lock file, because at TTL expiry the owning PID is almost always either already dead (current code path handles it) or has been reassigned to an unrelated process that we must not harm.

The TTL is ~3× the worst-case worker runtime, so a worker that genuinely runs long does not trip the cleanup. 110 min is deliberately chosen over an even 120 min: the scheduler polls every 60 min, and if the TTL landed on an integer multiple of that interval the lock age would sit right on the "not yet expired" boundary at the Nth poll (due to second-level jitter between lock write and poll), forcing the scheduler to wait an extra full hour until the N+1th poll. 110 min guarantees the 2nd poll after a stuck worker clears the lock. In the vanishingly unlikely event a real worker is still alive past 110 min, the scheduler will launch a parallel worker; any concurrent `plugins update` conflicts surface as install/rollback errors rather than permanent plugin damage — an acceptable price for regaining autonomous recovery. Lock ownership remains with the gateway (scheduler writes/reads/removes); the worker still does not touch the lock, preserving single-owner mental model.
