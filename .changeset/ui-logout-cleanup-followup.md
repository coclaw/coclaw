---
'@coclaw/ui': patch
---

fix(ui): complete logout state cleanup for agent runs, chat stores, dashboard, file transfers, admin SSE, and 401 throttle

Previously logout left behind: per-run 24h timers and stream buffers (agent-runs),
cached chat/topic store instances with their event handlers (chat-store-manager),
per-claw dashboard data (dashboard), file transfer tasks with running async loops
(files), admin SSE `EventSource` + its `app:foreground`/`network:online` listeners
(admin store `$reset()` nulled the handle without calling `close()`), and the
module-level 3s `auth:session-expired` throttle timestamp in `http.js` which
could swallow the next user's first legitimate 401.

Adds `agentRunsStore.resetAll()`, `chatStoreManager.disposeAll()`,
`filesStore.cancelAll()`, `adminStore.teardownStream()` (forced close,
independent of the refcounted `stopStream`), and `resetAuthExpiredThrottle()`
in `http.js`. Wires them plus `dashboardStore.$reset()` into the logout
cleanup chain. Order matters: files cancel runs before disconnecting
the data channel so transfer-abort frames can be flushed; admin SSE teardown
runs before `admin.$reset()` so the `EventSource` and its window listeners
are actually released rather than orphaned.
