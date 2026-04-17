---
'@coclaw/ui': minor
---

解除 SSE `claw.online` 与 WebRTC DC 生命周期的耦合。

此前 SSE 推来 `claw.online=false` 时，UI 会同步清空 `dcReady`、将 `rtcPhase` 拍回 `idle` 并清掉退避重试，这让已排队的 RPC 无法触发重连、只能等 30s 超时，对应生产环境"agent 状态冻结、重发才恢复"的体感。

按通信模型设计意图，plugin↔server WS 与 UI↔plugin WebRTC DC 是两条独立通路。本次改动把 `claw.online` 降格为展示层字段，DC 生命周期只由 PC 自身状态驱动：

- `updateClawOnline(false)` 不再动 `dcReady` / `rtcPhase` / 退避 retry；改为轻触发 `__checkAndRecover(id, 'sse_offline')` 让 DC 自检——健在则 probe 通过无副作用，真坏则秒级拉起 ICE restart 或 rebuild（避免等浏览器 consent 超时 20–35s）
- `__ensureRtc` 内层循环、`__scheduleRetry`、`__handleNetworkOnline`、`__fullInit` 以及 `applySnapshot` 末尾的 "failed 重试" gate 均去掉 `!online` 守卫
- `applySnapshot` 的 `preserveOnline` 兜底删除——presence 单一来源，DC 状态独立驱动
- `ChatPage.connReady` 去掉 `claw.online`，只看 `dcReady`
- `__bridgeConn` 首次 init 入口的 `online` 判断保留（首次建连成本不低，用 presence 作启动先验合理），加注释区分"首次"和"持续维护"

文档同步：`docs/architecture/communication-model.md` §5.5 新增"claw.online 与 DC 生命周期的解耦"章节，`docs/designs/ice-restart-recovery.md` §6.5 重写，`ui/docs/state-recovery.md` 与 `ui/docs/chat-state-architecture.md` 对齐。
