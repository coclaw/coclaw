---
'@coclaw/openclaw-coclaw': patch
---

Fix: gateway WS close handler 把 `__clearAllLagProbes` / `gatewayPendingRequests.clear` / `__dcPendingRequests.clear` / 重连调度全部搬到 `this.gatewayWs !== ws` stale guard 之后。三个清理操作都是 per-bridge 共享状态；原先跑在 guard 前导致旧 ws close 会清掉新 ws 的 lag probes、pending RPC、DC 路由。per-WS log（disconnected / handshake info）保留在 guard 之前，因为它们用的是闭包局部变量。
