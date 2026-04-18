---
'@coclaw/ui': patch
---

fix(ui): complete logout state cleanup for agent runs, chat stores, dashboard, and file transfers

Previously logout left behind: per-run 24h timers and stream buffers (agent-runs),
cached chat/topic store instances with their event handlers (chat-store-manager),
per-claw dashboard data (dashboard), and file transfer tasks with running async loops
(files). Next login as the same or a different user could observe stale data,
leaked timers firing into reset state, or background transfer loops spinning.

Adds `agentRunsStore.resetAll()`, `chatStoreManager.disposeAll()`,
`filesStore.cancelAll()`, and wires them plus `dashboardStore.$reset()` into the
logout cleanup chain. Order matters: files cancel runs before disconnecting
the data channel so transfer-abort frames can be flushed.
