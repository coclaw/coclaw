# Plugin TODO

## Bridge WS 断连不应 closeAll 所有 WebRTC session

**发现日期**：2026-04-14
**关联 commit**：fix(plugin): fix PionIpc listener leak and add failed session cleanup

**问题**：`realtime-bridge.js` 在 server WS 断连时调用 `webrtcPeer.closeAll()`，销毁所有 WebRTC PeerConnection。但 WebRTC 数据通道（P2P via TURN）独立于信令通道，现有 PC 在 server WS 短暂断连期间仍可正常工作。`closeAll` 导致不必要的连接中断。

**影响**：server 重启或网络抖动时，所有 UI 的 WebRTC 连接被强制断开，用户需重新建连。

**修复方向**：移除 WS 断连时的 `closeAll` 调用，依赖 per-connId 的 TTL timer 和 queue length 机制自然回收不再活跃的 session。需注意：
- WS 重连后信令路由恢复，现有 PC 应能继续使用
- 如果 server WS 长时间断开，PC 最终会因 ICE 失败进入 failed → TTL 回收
- 需评估是否有依赖 `closeAll` 重置状态的其他逻辑

**风险**：直接移除可能引入其他问题（如 bridge 重连后状态不一致），需谨慎评估。

## DC onclose 与 closeByConnId 的 race（旧 DC onclose 晚到误清理新 session）

**发现日期**：2026-05-02（rpc-dc-integration 阶段 1 deep-review 时识别）
**关联**：webrtc-peer.js 的 dc.onclose 路径

**问题**：`closeByConnId` 主动清理后，旧 DC 的 `onclose` 事件可能晚到。届时 connId 已被新 session 复用，`dc.onclose` handler 通过 `this.__sessions.get(connId)` 拿到的是**新 session**，进而错误地置空新 session 的 `rpcQueue / rpcDcSender / rpcChannel`。

**影响**：低概率但确切 bug。同 connId 短时间内 close+rebuild 时可能出现新 session 立刻被旧 DC 的 onclose 误清理。

**修复方向**：在 `dc.onclose` 内增加身份校验：`if (sess?.rpcChannel !== dc) return;`；或 `closeByConnId` 主动 detach 旧 dc.onclose handler。

**预存问题**：旧 RpcSendQueue 时代也存在，本次重构未引入。

## DC onerror 不触发清理 → consumeLoop 可能永挂

**发现日期**：2026-05-02
**关联**：webrtc-peer.js 的 dc.onerror

**问题**：DC `onerror` 仅打日志，清理依赖后续 `dc.onclose` 到来。如果某些 WebRTC 实现只触发 error 不触发 close，consumer 会卡在 sender BAL 等待中（虽然阶段 1 加了 finally 兜底，但仍依赖某种触发条件）。

**修复方向**：在 `dc.onerror` 中也触发 sender close + queue destroy，或给 BAL 等待加超时上限。

**预存问题**。

## realtime-bridge ws.message listener 缺外层 try/catch

**发现日期**：2026-05-02
**关联**：realtime-bridge.js:730

**问题**：阶段 1 把 listener 改 async 后，await 链路若抛异常会变成 unhandled promise rejection。当前内部已有局部 try/catch，sendTo 内部也有 try/catch，但其他分支如 `__stopLagProbe` 抛错没有兜底。

**修复方向**：listener body 加外层 try/catch 兜底，或拆 helper 函数把 await 链都包起来。

## chunkAndSend 是死代码

**发现日期**：2026-05-02
**关联**：dc-chunking.js:67 `chunkAndSend`

**问题**：阶段 1 后生产路径已全部改走 `RpcDcSender`，`chunkAndSend` 仅 `dc-chunking.test.js` 还在用。可删除。

**修复方向**：删除 `chunkAndSend` 导出 + 对应测试用例。低风险。

## sendTo 返回值语义微变（admission 通过即 true）

**发现日期**：2026-05-02
**关联**：webrtc-peer.js sendTo + realtime-bridge.js:833

**问题**：原 `RpcSendQueue.send` 在 build/oversize/queue-full 各场景返回 false；新 `sendTo` 仅在 queue-full（admission 拒绝）返回 false，build/oversize 失败发生在 sender 内部异步路径，sendTo 已 return true。realtime-bridge:833 用 `delivered` 打 log，build/oversize 场景不再产生 "undeliverable" log。

**影响**：仅 logger 输出层面，业务无感。caller 不基于返回值做退路决策。

**修复方向**（可选）：sendTo 内做 oversize/buildChunks 预校验后再 enqueue，让返回值真正反映"本条最终送达概率"。代价是破坏 admission 单一职责。

## 测试增强建议（阶段 1 deep-review 期间记录）

- ICE restart 期间 in-flight 消息送达端到端验证（webrtc-peer.test.js 新增 case）
- close 汇总日志的完整字面断言（含 dropped/droppedBytes/residualChunks/residualBytes 数值）
- bypassAdmission 集成测试增强：断言被丢的非白名单帧确实没到 dc.sent
- realtime-bridge.test.js:4098 的 5x setTimeout(0) flush 改成更确定的同步等待方式

