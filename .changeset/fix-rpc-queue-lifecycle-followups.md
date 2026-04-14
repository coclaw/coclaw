---
"@coclaw/openclaw-coclaw": patch
---

fix(plugin): rpc DC 生命周期与诊断收尾（深度 review followups）

- `closeByConnId`：显式关闭 `RpcSendQueue`（避免 `dc.onclose` 路径因 session 已 delete 而短路，导致 drop 汇总 remoteLog 缺失）
- ICE restart：重协商 SDP 后同步刷新 `remoteMaxMessageSize` 与 queue 分片阈值（避免 renegotiation 变更 `a=max-message-size` 时新消息按旧值错误分片）
- `rtc.dump` 诊断增加 `queueLen/queueBytes/dropped` 字段，便于定位队列积压
- `agent-abort`：`activeRuns.get()` 也纳入 try/catch，duck-typed 实现抛出时归入 `abort-threw`（原先仅保护 `handle.abort()`）
