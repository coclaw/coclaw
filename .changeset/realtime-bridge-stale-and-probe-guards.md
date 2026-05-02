---
'@coclaw/openclaw-coclaw': patch
---

Fix: realtime bridge 加固两条边角路径：(1) server socket 的 `open` 与 `message` listener 头部加 `serverWs !== sock` 守卫，避免 reconnect 后旧 sock 迟到的 open 重设 sender / 心跳，迟到的 message 重置当前 sock 的心跳超时；(2) `__closeGatewayWs()` 主动关闭时立即调 `__clearAllLagProbes()`，不依赖 close 事件回调时序，避免 close 事件延迟期间 probe 仍在跑。
