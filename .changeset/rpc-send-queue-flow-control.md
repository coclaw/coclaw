---
"@coclaw/openclaw-coclaw": minor
---

feat(plugin): 为 rpc DC 引入应用层发送流控（RpcSendQueue）

- 每条 rpc DC 绑定一个 `RpcSendQueue` 实例，`broadcast` / files RPC sendFn 经此出口
- 阈值：HIGH=1MB / LOW=256KB 水位背压；队列软上限 10MB（单条可溢出）；单条硬上限 50MB
- 溢出静默丢弃（logger.warn 每次；remoteLog 仅状态转换汇总）
- probe-ack 故意绕过 queue，独立测量传输层健康
- 避免 pion/webrtc Go 侧 SCTP pendingQueue 无界堆积导致 gateway OOM
