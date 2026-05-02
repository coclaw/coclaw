---
'@coclaw/openclaw-coclaw': patch
---

Fix: server sock close handler moves `__clearServerHeartbeat` and `__clearConnectTimer` to after the stale guard. Both cleanups touch per-bridge global single-slot state; running them before the guard meant a stale-sock late close event would wipe the new sock's heartbeat / connect timer. The `stop()` path still cleans up correctly since `serverWs` is already set to null and the guard does not block.
