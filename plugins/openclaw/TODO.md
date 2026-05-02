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

## oversize 与 queue-full 的 drop 分类翻面（行为微变，不修）

**发现日期**：2026-05-02（rpc-dc-stage1 deep-review round 2）
**关联**：memory-queue.js / rpc-dc-sender.js

**背景**：原 RpcSendQueue.send 的检查顺序是 buildChunks → oversize → admission，所以一条既超 50MB 又恰好队列满的消息总是先报 `single-msg-oversize`（warn 级 + 计入 dropped）。新架构里 admission 在 enqueue 阶段做、oversize 在 sender 阶段做，如果队列已经满了，oversize 消息会被 admission 当 queue-full 在 overflow 期间静默丢，永远走不到 sender 的 oversize 检查；如果队列空，oversize 在 sender 抛 warn 但**不计入 droppedCount**。

**影响**：诊断性下降。oversize（应用 bug 性质）原本有清晰的独立 warn，现在可能被 queue-full 静默吞掉；close 汇总数字也少了 sender 端的 build-fail/oversize 那部分。

**修复方向**（不修）：在 enqueue 入口加一道 oversize 预判（破坏 MemoryQueue 与 FBQ 的纯容器语义），或让 sender 在抛 oversize/build-fail 时回调 queue 的 drop 计数器（增加耦合）。当前接受现状——>50MB 消息属应用 bug 路径，触发条件极窄。

## 日志前缀变更：sender 侧 warn 从 [rpc-queue] 改为 [rpc-dc-sender]（行为微变，不修）

**发现日期**：2026-05-02（rpc-dc-stage1 deep-review round 2）
**关联**：rpc-dc-sender.js __safeWarn

**问题**：原 RpcSendQueue 内的所有 warn 都带 `[rpc-queue tag=]` 前缀。重构后：
- MemoryQueue 仍用 `[rpc-queue ...]`（overflow-start / overflow-end / onDrop-threw）
- RpcDcSender 用 `[rpc-dc-sender ...]`（drop reason=single-msg-oversize / build-chunks-failed / dc.send failed）
- consumeLoop 用 `${rtcTag} [${connId}] rpc-dc.send-failed code=...`

dump 已记 `rpc-queue.build-chunks-failed` → `rpc-dc-sender.build-chunks-failed`（remoteLog 事件名），但 warn 前缀的连带变化未列。

**影响**：监控/告警如按 `[rpc-queue]` 子串过滤会漏掉 sender 侧的 oversize/build-fail/dc.send-fail。

**修复方向**（不修）：保持现状（split 模块本身就是这次重构的目的）；如有监控告警需迁移，更新过滤条件即可。

## dump 文本 queueLen 数字含义改变（行为微变，不修）

**发现日期**：2026-05-02（rpc-dc-stage1 deep-review round 2）
**关联**：webrtc-peer.js __dumpSessionState

**问题**：dump 字面 `queueLen=N` 保留，但 N 的含义变了。
- 老 RpcSendQueue 的 `q.queue.length` 计入"非分片 JSON 字符串"+"分片消息的每个 chunk"。一条 100MB 消息分片后会贡献几万条
- 新 MemoryQueue 的 `stats().memCount` 计入"完整 JSON 字符串"。同一条 100MB 消息只贡献 1 条；分片在 sender 端按需做，不进 queue

**影响**：人工读 dump 时对队列压力的直觉判断会偏差。但 queueBytes 仍可作为压力的真实信号。

**修复方向**（不修）：等阶段 2 切 FBQ 时一并重审 dump 字段语义；也可考虑改名为 `queueMsgs=` 以提示语义。

## 同 session 第二条 rpc DC 覆盖三件套未关旧实例（cold path，不修）

**发现日期**：2026-05-02（rpc-dc-stage1 deep-review round 2）
**关联**：webrtc-peer.js __setupDataChannel

**问题**：`__setupDataChannel` 没有先 close 旧 rpcDcSender / destroy 旧 rpcQueue / await 旧 rpcConsumeLoop 就直接覆盖三个 session 字段。如果同 session 的 ondatachannel 又收到一条 `rpc` label 的 DC（UI 重建 DC），旧三件套变孤儿——consumeLoop 仍在 await 旧 queue 的 iterator，sender 仍持有旧 dc 引用。

**影响**：理论上的资源泄漏 + BAL 回调通过 `session.rpcDcSender` 动态取，新旧实例混用风险。但 UI 当前不会在同 PC 上重建 rpc DC，且 ICE restart 不重建 DC——属预防性问题。

**修复方向**（不修）：覆盖前先 close 旧三件套；或在 ondatachannel 内拒绝重复 rpc label。需结合 dc.onclose race（已记录）一起评估。

## __setupDataChannel 装配代码无 try/catch（防御性，不修）

**发现日期**：2026-05-02（rpc-dc-stage1 deep-review round 4）
**关联**：webrtc-peer.js __setupDataChannel

**问题**：MemoryQueue / RpcDcSender 构造抛出会留下半装配状态——例如 connId 含非法字符会让 MemoryQueue 抛 TypeError，此时 session.rpcQueue 未赋值但 dc 事件 handlers 已设。

**当前实现**：构造抛点在实践中触发不到——connId 由 UI 生成 `c_${UUID}` 格式总是满足 ID_RE；dc 是 ondatachannel 参数永不为 null。

**修复方向**（不修）：包 try/catch 在 `if (session && dc.label === 'rpc')` 段内，失败时 warn + return 不赋值任何字段。属纯防御。

## ICE restart 跨 await 不重验 session 在 Map（预存）

**发现日期**：2026-05-02（rpc-dc-stage1 deep-review round 4）
**关联**：webrtc-peer.js __handleOffer ICE restart 分支

**问题**：ICE restart 路径含多次 await（setRemoteDescription / createAnswer / setLocalDescription），但每次 await 后没有重验 `this.__sessions.get(connId) === existing`。若中途另一路径删除/替换 session（closeAll / __evictOldestFailed / 第二轮 offer），旧 continuation 仍会更新已无效的 session。

**修复方向**（不修）：每个 await 后加 `if (this.__sessions.get(connId) !== existing) return;`。预存问题，本次重构未引入也未扩大。

## closeAll 用 Promise.all 无 per-session catch（预存）

**发现日期**：2026-05-02（rpc-dc-stage1 deep-review round 4）
**关联**：webrtc-peer.js closeAll

**问题**：`Promise.all(closing)` 任一 closeByConnId reject 整体 reject。其余 session 仍会跑（Promise.all 不中断已启动的），但调用方拿到 rejection。

**修复方向**（不修）：用 `Promise.allSettled` 或 `closing.map(p => p.catch(...))`。预存。

## __sendPeerTransport 失败后无重试调度（预存）

**发现日期**：2026-05-02（rpc-dc-stage1 deep-review round 4）
**关联**：webrtc-peer.js __sendPeerTransport

**问题**：sendTo 返回 false 时回滚 sig 允许重试，但重试依赖下次 dc.onopen 或 onselectedcandidatepairchange 事件。若 pair 已稳定、DC 已 open 过、此后这些事件不再触发，transport info 永远不重发。

**修复方向**（不修）：sendTo 失败后挂一个延迟重试，或在 onbufferedamountlow 恢复时检查 sig 为 null 再发。预存——sendTo 改 async 不引入新问题，仅在原本就失败的场景下不重试。

## 阶段 2 切换 FBQ 的 checklist（不止"一行 import 改"）

**发现日期**：2026-05-02（rpc-dc-stage1 deep-review round 2）
**关联**：阶段 2 计划

**问题**：dump 提到"几乎一行 import 改"。深度核对后发现实际需要协调改动至少 4 处：
1. **MemoryQueue 与 FBQ 的构造参数不同**：FBQ 需 `dir`、可选 `diskCap`，MemoryQueue 没有；webrtc-peer.js 的 new 处需补
2. **`__setupDataChannel` 当前 sync**：阶段 2 加 `await q.init()` 后函数变 async；调用方 `pc.ondatachannel`（line ~449）也需相应改造
3. **`__dumpSessionState` 读 `stats().droppedCount`**：FBQ 的 stats 不暴露此字段，会输出 `dropped=undefined`。需阶段 2 统一 stats 形态或在 dump 处 fallback
4. **RpcSendQueue 时代的 sender 侧 drop 是否需要重新对齐 close 汇总**：见上方 "oversize 与 queue-full" 条目

**修复方向**（不修，只记录）：阶段 2 启动时把这些点列成 checklist，避免临到切换才发现。

## bridge 不被通知 conn 关闭 → server 侧 pending request map 残留（预存）

**发现日期**：2026-05-02（rpc-dc-stage1 deep-review B 阶段维度 2 集成路径）
**关联**：realtime-bridge.js（gateway WS message handler 与 webrtcPeer 之间无 conn-closed 信号）

**问题**：webrtcPeer.closeByConnId 只清 plugin 侧 session 状态，没有回调 bridge。bridge 把 server 端发来的 RPC 请求映射到具体 connId 后，若该 conn 在 plugin 侧已断开，映射不会被主动清掉，要等 gateway 整体关闭或 TTL 才消失。

**影响**：bridge 内存里有过时映射；server 侧后续来的回包尝试 sendTo 已不存在的 conn → 静默 false。功能层面 UI 已重建会话恢复，但残留映射占内存且日志噪音。

**修复方向**：webrtcPeer 暴露 onConnClosed(connId) 回调；bridge 订阅后主动清掉该 conn 的所有挂起映射。

## files sendFn 不返回 boolean / Promise，response 入队失败被静默吞（预存）

**发现日期**：2026-05-02（rpc-dc-stage1 deep-review B 阶段维度 2 集成路径）
**关联**：webrtc-peer.js __setupDataChannel 内构造的 sendFn（line ~631）；file-manager/handler.js 调用处

**问题**：sendFn 是 sync void 接口（"历史是 sync void 接口"注释），内部对 enqueue 做 fire-and-forget `.catch()`。enqueue 返回 false（admission 拒绝、queue 已 destroy）时调用方完全无感。

**影响**：file RPC 内部已执行完毕但 response 被 queue-full 或 teardown 静默丢，UI 端只能等超时。预存——阶段 1 之前 sendFn 同样不暴露 boolean。

**修复方向**：sendFn 改返回 Promise<boolean>（或同步返回 enqueue 结果），file-manager handler 在 false 时打 `file.rpc.response-undeliverable` 日志或走重试。需斟酌签名变更对 file-manager 的影响。
