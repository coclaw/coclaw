---
'@coclaw/openclaw-coclaw': patch
---

Fix: gateway WS message handler 头部加 `this.gatewayWs !== ws` stale guard，与 server sock 的 open/message guard 对称。原先旧 gateway ws 关闭后若仍有迟到的 `connect.challenge` / `res` / `event` 帧到达，处理路径会写 `this.gatewayConnectReqId` / `this.gatewayReady` / 转发 res 等共享状态，污染当前 ws 的握手或 RPC 路由。
