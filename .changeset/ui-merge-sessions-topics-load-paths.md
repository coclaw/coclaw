---
"@coclaw/ui": patch
---

Merge `loadAllSessions` / `loadAllTopics` with their per-claw counterparts so that both entry points share the same `_perClawLoading` in-flight cache. Concurrent first-screen triggers (init / refresh / MainList watcher) no longer fire duplicate `sessions.list` and `coclaw.topics.list` RPCs against the gateway for the same claw. `_loadingPromise` is kept as an outer fast-path for back-to-back `loadAll*` callers.
