---
'@coclaw/openclaw-coclaw': patch
---

Fix: server sock close handler 把 `__clearServerHeartbeat` 与 `__clearConnectTimer` 挪到 stale guard 之后。两个清理操作都是 per-bridge 全局单槽，原先跑在 guard 前导致旧 sock 的迟到 close 事件清掉了新 sock 的 heartbeat / connect timer。stop() 路径仍能正常清理（serverWs 已被设为 null，guard 不阻断）。
