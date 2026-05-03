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

## device-identity.js 用 sync 裸 fs.writeFileSync（预存）

**发现日期**：2026-05-02（rpc-dc-stage1 C 阶段全局裸写扫描）
**关联**：plugins/openclaw/src/device-identity.js:110, 134

**问题**：`loadOrCreateDeviceIdentity` 的两处 `fs.writeFileSync(fp, ...)` 没有 atomic 保护，写入过程中崩溃会留下损坏的设备身份文件（含设备私钥）。下次启动 JSON.parse 失败 → regen 新身份 → 用户需要重新 enroll。

**影响**：极小概率但后果严重——用户看到的是"设备掉线，需重新绑定"。auto-upgrade 已修了 async 路径，sync 路径还差一个。

**修复方向**：在 `utils/atomic-write.js` 加一个 `atomicWriteFileSync`（write tmp + renameSync 模式），device-identity 两处替换。需评估 sync 上下文性能（设备身份初始化阶段无瓶颈）。

## auto-upgrade state read-modify-write 缺跨进程互斥（预存）

**发现日期**：2026-05-02（rpc-dc-stage1 C 阶段维度 3）
**关联**：plugins/openclaw/src/auto-upgrade/state.js（addSkippedVersion / updateLastCheck / updateLastUpgrade）+ updater.js（__reportLastUpgradeResult）

**问题**：parent (gateway) 和 worker (独立进程) 都会 read-modify-write `upgrade-state.json`。CLAUDE.md 强约束 "read-modify-write 必须 mutex"，但进程内 mutex 跨进程无效。当前靠 `isLocked` 守门挡住绝大多数并发（worker 跑期间 parent skip check），但极小窗口（worker spawn 与 lock 写入之间、stale lock 强制清理时）仍有理论丢字段风险。

**影响**：实测从未发生——窗口极窄、最坏后果是 lastCheck/lastUpgrade 丢一次记录、自然恢复。无数据损坏（atomic 写已保证）。

**修复方向**：用文件级 advisory lock（如 `proper-lockfile` 或 flock）保护 read-modify-write 段。改动跨进程协议，影响面大；当前接受现状，标 TODO 提示长尾。

## chat-history 缓存热身后 JSON 损坏吞异常保留旧缓存（预存）

**发现日期**：2026-05-02（rpc-dc-stage1 C 阶段维度 4）
**关联**：plugins/openclaw/src/chat-history-manager/manager.js:156-170 `__reloadFromDisk`

**问题**：cache 已热身后，磁盘文件被截断/损坏 → JSON.parse 抛 → catch 静默吞 → cache 保留旧数据。下次 list 返回过期数据；下次 recordArchived 把过期数据写回磁盘（用旧条目覆盖磁盘上的损坏内容——倒是恢复了）。

**影响**：list 暂时返回旧数据；写回时实际上修复了磁盘。对最终一致性无伤，但 list 短窗内不一致。

**修复方向**：`__reloadFromDisk` 区分 ENOENT（正常首次）vs JSON parse 失败（应重置为 emptyStore）。当前实现是 best-effort 兜底——可接受。

## topic-manager copyTranscript 用 fs.copyFile（非 atomic，预存）

**发现日期**：2026-05-02（rpc-dc-stage1 C 阶段维度 4）
**关联**：plugins/openclaw/src/topic-manager/manager.js:219-224

**问题**：`copyTranscript` 用 `fs.copyFile(src, dst)` 复制 jsonl 到目标路径。复制中途进程崩溃会留下半截文件，消费方读到损坏内容。

**影响**：极小概率（topic transcript 体积通常 < 1MB，copy 几乎瞬时完成）；最坏情况是 transcript 被截断。用户重试导出/导入即恢复。

**修复方向**：先 cp 到 `dst.<uuid>.tmp` 再 renameSync 到 dst（POSIX rename 原子）；或在复制完成后 fsync。

## bridge async listener 其他真隐患（C 阶段维度 1）

**发现日期**：2026-05-02
**关联**：realtime-bridge.js

| # | 锚点 | 问题 | 修向 |
|---|---|---|---|
| 1 | 826-834 | terminal res 的 `__dcPendingRequests.delete` 在 `await sendTo` 之前发生；await 期间若同 id 第二帧到来（理论上 server 不会重发），会走广播兜底而非单播 | delete 移到 await 之后 |
| 2 | 978 附近 `__handleGatewayRequestFromDc` | payload.method 不存在时，`JSON.stringify({ method: undefined })` 字段会被省略，gateway 拒绝/路由空 method | 入口校验 typeof method === 'string'，不合则返回 INVALID_REQUEST |
| 3 | 963-968 撞号处理 | 撞 reqId 时只删旧 entry，不通知旧发起方；旧响应会变广播被其他 connId 看到（潜在信息泄漏） | 撞号时也向旧 connId 发 DUPLICATE_REQUEST_ID 错误帧 |

**影响**：低概率边角，#2/#3 与 server 协议契约相关，需要确认是否真会触发。当前 listener 顶层 catch 已挡住主要爆炸路径，这三条收益小、改动有耦合，先记 TODO。

## file-manager handler 8 项预存问题（C 阶段维度 2）

**发现日期**：2026-05-02
**关联**：plugins/openclaw/src/file-manager/handler.js

| # | 锚点 | 问题 |
|---|---|---|
| 1 | 49-51, 247-249, 277-279, 602-618 | validatePath 不解析父目录 symlink，可越权写到 workspace 外（PATH_DENIED 漏判） |
| 2 | 121-129, 196-235, 253-280 | delete/create 先做文件操作再发 RPC 响应；响应丢失时副作用已发生，UI 重试会得到 NOT_FOUND/ALREADY_EXISTS |
| 3 | 320-349, 744-805 | file DC 只有"请求前 30s"超时，传输期 idle 不超时，半上传 tmp 文件可永久挂住 |
| 4 | 894-900, 503-506, 737-738 | sendError 不 await dc.close → 错误 JSON 可能在 close 前丢失 |
| 5 | 463-485 | GET 背压 low 事件早于 pausedNow=true 触发 → 永久卡 pause |
| 6 | 647-689, 744-779 | PUT/POST 接收侧 pendingQueue 无上限，慢磁盘下可被远端打满至 1GB → OOM |
| 7 | 629-635, 764-765, 799-800, 813-814, 836 | tmp 文件 unlink 失败无重试 → 残留磁盘 |
| 8 | 277-280, 136-140 | createFile 用 writeFile('') 直写最终路径，抛错时空文件留下 |

**影响**：均属预存边角，与 rpc DC 重构无关。

**修复方向**：每条独立修；建议优先级 1（安全） > 6（OOM 风险） > 4（错误响应丢失） > 其他。

## auto-upgrade worker 9 项预存问题（C 阶段维度 3）

**发现日期**：2026-05-02
**关联**：plugins/openclaw/src/auto-upgrade/

| # | 锚点 | 问题 | 严重度 |
|---|---|---|---|
| 1 | worker.js:121-191, updater.js:65-97, worker-backup.js:42-56 | kill -9/OOM 在备份后 + 替换文件期间发生 → stale lock 清理只删锁不恢复备份 → 残破插件 + 残留 .bak | Critical |
| 2 | worker-backup.js:52-56 | restore 先删 pluginDir 再 rename .bak → 中途崩溃整个插件目录消失 | High |
| 3 | worker.js:208-219 | restore 失败 + fallback install 失败 仍记录 result='rollback'（误导监控） | High |
| 4 | updater-spawn.js:45-66, updater.js:309-322 | child.pid undefined 时仍写 lock；async error/exit 未识别 | High |
| 5 | updater-check.js:63-77, worker-verify.js:24-38 | 自定义 semver 不支持 prerelease ordering / build metadata | Medium |
| 6 | updater-spawn.js:52-55 | worker stdio 被忽略，致命错误丢失 | Medium |
| 7 | worker-backup.js:22-34 | 备份无 checksum/manifest，损坏备份会被信任性 restore | Medium |
| 8 | updater-check.js:35-55 | 初次 check 不走 registry fallback，主 registry 故障即无更新 | Low |
| 9 | updater.js:17-25 | LOCK_TTL_MS 110min 接近 worker 最坏耗时，未来若超时矩阵增长，stale 清理可能起并行 worker | Low |

**影响**：均属预存边角。auto-upgrade 是 gateway 启动稳定性关键链路，1/2/3 风险较高。

**修复方向**：1/2 需要重设计 backup → 用 swap 模式；3 状态机加 rollback_failed；其他逐项处理。

## agent-run-response bypass 是否扩展到 lifecycle:end（产品决策待定）

**发现日期**：2026-05-02
**关联**：plugins/openclaw/src/webrtc/agent-run-response.js

**问题**：当前 `isAgentRunResponse` 只命中 `type='res' + payload.runId`。OpenClaw 一次 agent run 会 emit 多次 lifecycle:end（compaction-retry / model-fallback / final），这些是 type='event' 帧，不命中白名单。队列满时 lifecycle:end 全 drop，UI 可能看不到运行结束信号导致"任务永远进行中"。

**影响**：严重时用户感知任务卡死，需手动取消。但仅在队列满（10MB 软上限）的极端拥塞场景触发。

**修复方向（待决策）**：
- 选项 A：扩展白名单命中 `type='event' + event='lifecycle:end' + payload.runId`
- 选项 B：让 producer 显式标记需 bypass 的帧（语义更清晰）
- 选项 C：保持现状（lifecycle:end 走 broadcast，UI 端需自己有兜底超时）

需先确认 UI 是否依赖 lifecycle:end 判定 run 结束 + 队列满频率。

## D 阶段记 TODO 不修的预存问题

### dc-chunking BEGIN-without-END pending Map 无总量上限

**发现日期**：2026-05-02（D 阶段 dim 4）
**关联**：plugins/openclaw/src/webrtc/dc-chunking.js createReassembler

**问题**：`pending` Map 没有总条目数 / 总字节数上限。peer 持续发送不同 msgId 的 FLAG_BEGIN 但不发 FLAG_END，每个 entry 都留在 Map 中（每个 1 chunk）。`MAX_REASSEMBLY_BYTES`/`MAX_CHUNKS_PER_MSG` 是单条消息粒度，跨条不护。

**影响**：理论上可被恶意 peer DoS 撑爆 reassembler 内存。但 CoClaw 的 DC 对端是受信 UI（不是公网随便接入），peer 关闭时 reassembler GC 释放。实际风险低。

**修复方向**：加 pending 总条数上限（如 100）+ 总字节数上限，或加 entry 级超时（首次 chunk 后 N 秒内无 END 则丢弃）。需要决策超时窗口（OpenClaw run 单条消息可能 > 60s）。

### dc-chunking msgId uint32 溢出未 wrap

**发现日期**：2026-05-02（D 阶段 dim 4）
**关联**：plugins/openclaw/src/webrtc/webrtc-peer.js session.nextMsgId++ + dc-chunking.js writeUInt32BE

**问题**：`session.nextMsgId++` 是无界整数，超过 `0xFFFFFFFF` 后 `writeUInt32BE` 抛 RangeError，该 session 此后所有分片发送失败。

**影响**：单条 session 需累计发送 ≥ 4×10⁹ 条分片消息才触发 — 实际不可达（DC 寿命有限）。

**修复方向**：`(session.nextMsgId + 1) >>> 0` 或显式模 0x100000000。

### webrtc-peer ICE restart 不刷新 TURN iceServers config

**发现日期**：2026-05-02（D 阶段 dim 2）
**关联**：plugins/openclaw/src/webrtc/webrtc-peer.js:185-244 __handleOffer ICE restart 分支

**问题**：ICE restart 时 `msg.turnCreds` 仅用于打 `credRemain` 日志，旧 PC 的 ICE config（含 TURN 凭证）没有更新。如果 TURN 凭证在通话中途过期，restart 后的 relay 候选用旧凭证失败。

**影响**：高 — 长通话过程跨 TURN 凭证 TTL 边界时，relay-only 路径恢复失败，UI 需全量 rebuild。但 TURN 凭证 TTL 一般较长（小时级），实际触发概率低。

**修复方向**：在 setRemoteDescription 之前调 `existing.pc.setConfiguration({ iceServers: rebuiltFromTurnCreds })`。需先验证 pion-node 与 werift 的 setConfiguration 实现一致性。

### pion preload 缺并发合并保护

**发现日期**：2026-05-02（D 阶段 dim 2）
**关联**：plugins/openclaw/src/webrtc/pion-preloader.js + realtime-bridge.js 调用点

**问题**：bridge 重启或多次直接调用 `preloadPion()` 时，每次都独立构造并启动新 `PionIpc` 实例，没有 in-flight Promise 合并。

**影响**：可能并发 spawn 多个 pion-ipc Go 子进程；被覆盖的那次 preload 结果没有 cleanup 归属。bridge 正常生命周期下不触发。

**修复方向**：`preloadPion` 内维护 in-flight Promise 引用，重入直接返回同一 Promise。

### ndc-preloader 残留路径产生误导日志

**发现日期**：2026-05-02（D 阶段 dim 2）
**关联**：plugins/openclaw/src/webrtc/ndc-preloader.js + realtime-bridge.js 调用点

**问题**：pion 不可用时 bridge 仍调 `preloadNdc()`，但 `node-datachannel` npm 依赖已摘除，`require.resolve('node-datachannel')` 走入 `reason=unexpected` 分支，日志显示 ndc "unexpected 失败"，干扰排错。

**影响**：仅日志噪音，不影响 fallback 到 werift 的实际路径。

**修复方向**：删除 ndc-preloader.js 模块 + 调用点，让 fallback 直接走 werift。或 ndc 路径检测到包不存在时降级为 info。

### claw-binding 并发 bind/unbind R-M-W 跨调用竞态

**发现日期**：2026-05-02（D 阶段 dim 7）
**关联**：plugins/openclaw/src/common/claw-binding.js bindClaw / unbindClaw

**问题**：`bindingsMutex` 仅保护 config.js 的 writeConfig/clearConfig 内部 R-M-W；不保护 claw-binding 层的"读 → server 调用 → 写"完整序列。两个 CLI 进程或同时调用 RPC `coclaw.bind` 与 `coclaw.unbind` 时存在竞态。

**影响**：CLI 用户连按或脚本并发触发的边角场景。gateway 单进程 RPC 通常串行处理同名 method。

**修复方向**：跨模块暴露 mutex（claw-binding 持有自己的 mutex 包覆整个 bindClaw/unbindClaw），或文件级 advisory lock。

### BIND_LOCAL_WRITE_FAILED 错误码同时用于 bind 与 enroll 场景

**发现日期**：2026-05-02（D 阶段 round-3 review）
**关联**：plugins/openclaw/src/common/claw-binding.js bindClaw 81 + waitForClaimAndSave 163

**问题**：bindClaw 与 enroll 的 waitForClaimAndSave 都用同一错误码 `BIND_LOCAL_WRITE_FAILED` 标记本地写失败 + server 已发 token 的回滚场景。语义略不准（enroll 路径名为"BIND_..."），且未来若调用方需按场景做差异化处理（如 UI 展示 enroll 还是 bind 的失败信息），无法区分。

**影响**：当前 plugin index.js 中两个调用点都是 `.catch(err) → logger.warn`，不依赖 code 分支，运行时无问题。

**修复方向**：把 enroll 路径的错误码改为 `ENROLL_LOCAL_WRITE_FAILED`；或抽 `LOCAL_WRITE_FAILED` 共享码 + 用 message 区分。等到调用方需要差异化处理时再改。

### unbindClaw 已解绑时返回 NOT_BOUND 而非幂等成功

**发现日期**：2026-05-02（D 阶段 dim 7）
**关联**：plugins/openclaw/src/common/claw-binding.js:160-164

**问题**：unbindClaw 在本地 config.token 缺失时抛 `NOT_BOUND` 错误。脚本重试 / 用户连按 unbind 被当成失败。

**影响**：低 — 行为缺陷，非 bug。CLI 输出不友好。

**修复方向**：改为 `return { clawId: null, alreadyUnbound: true }`。需检查所有调用方对返回值的依赖。

## E 阶段（2026-05-02）跨模块 / 复杂改动 TODO

### restartRealtimeBridge / stopRealtimeBridge 缺串行化保护

**发现**：E1 codex-rescue 维度 1。
**锚点**：`plugins/openclaw/src/realtime-bridge.js:1438`（restartRealtimeBridge）/ `:1454`（stopRealtimeBridge）

**问题**：两次 restart 并发交错时，先创建的 bridge 被新引用覆盖，后续 stop 只停当前 singleton，旧 bridge 已 start 但引用丢失，无法清理。

**修复方向**：给 singleton 生命周期加 mutex / promise queue，串行化 restart/stop。

**为什么 TODO**：跨模块状态机锁，需整体设计 lifecycle 管理；现有测试只覆盖顺序 restart，需新增并发场景测试。

### bind/unbind 在缺 serverUrl 但有 token 时静默跳过远端解绑

**发现**：E1 codex-rescue 维度 1。
**锚点**：`plugins/openclaw/src/common/claw-binding.js:37`（`bindClaw`）/ `:195`（`unbindClaw`）

**问题**：legacy 或手动写入的 `bindings.json` 中存在 `{ token, clawId }` 但无 `serverUrl` 时，本地照样清理但远端不解绑，违反 unbind "强制不容错"契约的精神（实际 server 还有孤儿 claw）。

**为什么 TODO**：是否保留兼容旧格式属于设计决策（用户场景待确认）。需先和用户对齐：`serverUrl` 缺失时是直接报错，还是兜底用 default url。

### gateway pre-handshake send-fail 不入退避重试

**发现**：E2 codex-rescue。
**锚点**：`plugins/openclaw/src/realtime-bridge.js:669-672`（`__sendGatewayConnectRequest` catch）

**问题**：握手 connect 请求 send 抛错时只 warn + 清 reqId，未关 ws、未调 `__onGatewayAttemptFailed`，握手前 close handler 又被 `wasReady||connectFailReported` 守卫拦下，最终不入退避。

**为什么 TODO**：触发面极窄（ws send 在 OPEN 状态抛错少见）；改动需要谨慎覆盖握手三态机。先放一放，等真实环境观察到该路径触发再修。

### agentId 非字符串静默 fallback 'main'（多个 RPC handler）

**发现**：E3 codex-rescue。
**锚点**：`plugins/openclaw/index.js:323/393/516/541`、`plugins/openclaw/src/file-manager/handler.js:197`

**问题**：所有用 `params?.agentId?.trim?.() || 'main'` 的 handler 在 `agentId` 是数字 / 对象等非字符串值时静默 fallback `main`，可能让操作落到错误 workspace。

**修复方向**：抽 `normalizeAgentId(params)` helper：`undefined` / 空字符串才默认 `main`，其他非字符串值抛 `INVALID_INPUT`。

**为什么 TODO**：跨多 handler 一致性变更；需规划好统一 helper 后再批量替换并补测试。

### transport-adapter / message-model timestamp 静默回填

**发现**：E5 codex-rescue。
**锚点**：`plugins/openclaw/src/message-model.js:20-22`（normalizeInboundEnvelope）/ `:54-56`（buildOutboundEnvelope）

**问题**：present-but-invalid 的 `timestamp`（如 ISO 字符串）被替换为 `Date.now()`，原始时间语义丢失。

**为什么 TODO**：transport-adapter / message-model 当前仅被单测引用，未接生产路径；改动牵涉协议约定（要否兼容 ISO），等启用前再统一修。

### bind 进行中可被新 enroll 插入覆盖 config

**发现**：E 阶段 round-2 复查（codex-rescue High）。
**锚点**：`plugins/openclaw/index.js`（doBind / cancelActiveEnroll / coclaw.enroll handler）、`plugins/openclaw/src/common/claw-binding.js`（enrollClaw / waitForClaimAndSave）

**问题**：`bind` 在取消 enroll A 后立即把 `activeEnrollAbort` 置 null，自身仍在 `await bindClaw` 期间不会阻挡新进来的 enroll B；B 进入时 `enrollClaw` 仅检查"已持久化 config 是否 token"——bind 还没 writeCfg 完成，B 通过检查并最终也写一次 token。两条路径写 config 顺序不确定，可能产生 enroll-vs-bind config 覆盖。

**影响**：用户连续操作（先 enroll、再 bind）极少触发；自动化 / 多客户端并发更可能命中。当前 round-1 已修了 bind/unbind 主动 cancel enroll，但反向"bind 进行中拒绝新 enroll"未做。

**为什么 TODO**：跨 bind/unbind/enroll 三条路径的操作互斥需要统一 op generation 计数器或全局 mutex，属于跨模块状态机锁。round-1 的 `cancelActiveEnroll` 已解决主要单方向 race；剩余双向竞态留待统一规划 lifecycle 时一并修。

**Compact 后复盘（2026-05-02）**：经 origin/main 与 HEAD 对比，此问题在 origin/main（未引入 `cancelActiveEnroll` 之前）就已存在——bind/unbind 入口本就完全不感知活跃 enroll，并发即互踩。本次 `bd6dd61` / `df7ec73` 仅是缩窄了 race 窗口（入口主动取消旧 enroll + waitClaimCode 后多一次 abort 检查），并非引入或放大。属预存问题，发版前不修。

### waitForClaimAndSave writeCfg 期间 abort 信号无回滚（H3）

**发现**：F 阶段 deep-review compact 后 H2/H3 联合复盘（2026-05-02）。
**锚点**：`plugins/openclaw/src/common/claw-binding.js:155-180` `waitForClaimAndSave` 内 BOUND 数据分支

**问题**：`df7ec73` 在 `waitClaimCode` 返回后、`writeCfg` 开始前加了 `if (signal?.aborted)` 检查 + 服务端 token 回滚。但该检查只覆盖"abort 信号在 await waitClaimCode 期间到达"这一窗口；若 abort 在 `await writeCfg` 进行中或写完之后到达，本地 token 已经落盘，没有任何回滚路径。

**影响**：与 H2 同等结果——本地写入了"应被取消的 enroll"的 token，bridge 后续用错误身份连服务端。可恢复（用户重新 bind）。

**为什么 TODO**：单独修这一个窗口仍治不彻底（H2 未解、bind/bind 也未保护），需要与 H2 一起用 mutex 或 op generation 统一改造，属跨模块状态机锁，6-8 小时工作量 + 关键路径风险。

**Compact 后复盘（2026-05-02）**：origin/main 的 `waitForClaimAndSave` 完全没有 abort 检查，落盘动作直接发生——比当前 HEAD 的窗口更宽。本次仅是收紧、不是引入或放大，属预存问题。

### claw-binding rollback `.catch(()=>{})` 不防同步 throw

**发现**：E 阶段 round-2 复查（codex-rescue Low）。
**锚点**：`plugins/openclaw/src/common/claw-binding.js:76`、`:161`、`:173` 三处 `await unbindServer(...).catch(() => {})`

**问题**：`unbindServer`（axios 风格 async 函数）正常生产路径绝不会同步 throw，所以 `.catch()` 挂得正确。但若测试注入同步 throw 的 mock，`.catch()` 还没挂上 unhandled rejection 已逃逸。

**影响**：仅测试注入同步 throw 的非常规 mock 时才触发；生产路径完全安全。

**为什么 TODO**：避免过度设计——抽 try/catch helper 替换 3 处仅是为了"防御一种本不该发生的测试输入"。等真实场景需要时再统一改。

## G 阶段（2026-05-02）deep-review 发现且不修

### enroll cancel 不通知 server，mobile 后到 claim 留孤儿 claw（H, 本次引入）

**发现**：G 阶段 deep-review 维度 1（codex-rescue）。
**锚点**：`plugins/openclaw/index.js:208-216` `cancelActiveEnroll`、`plugins/openclaw/src/common/claw-binding.js:120-189` `waitForClaimAndSave`

**问题**：`cancelActiveEnroll()` 只在 plugin 端 abort 长轮询，不通知 server 失效 claim code。如果取消之后 mobile 端在 claim code 30 分钟过期之前还是 claim 上去，server 创建 claw + token 但 plugin 不再轮询取它 → server 留下死记录。`df7ec73` 的回滚只覆盖"长轮询返回 BOUND 之后、writeCfg 之前 abort 到达"窗口，覆盖不到"abort 之后才 claim"窗口。

**实际影响**：server DB 长尾死记录直到自然过期/server 自己清理；plugin 端业务无感；user-facing 影响极小。

**为什么 TODO**：origin/main 没有 cancelActiveEnroll，enroll 长轮询不会被中途取消，mobile 任何时候 claim 都有人取——所以是本次引入的 regression，但 user-facing 影响小。修法 A（server 加 invalidate-claim-code RPC）跨工作区；修法 B（plugin 端保留终态 watcher）增加复杂度。属 H2/H3 同家族，待统一规划 bind/enroll 状态机锁时一并处理。

### server message handler await 后未重验 sock identity（M，预存）

**发现**：G 阶段 deep-review 维度 3（codex-rescue）。
**锚点**：`plugins/openclaw/src/realtime-bridge.js:1213-1220` `rtc:` 分支 `await __webrtcPeerReady` + `await webrtcPeer.handleSignaling`

**问题**：入口 1197 行有 stale guard，但 1213-1220 两次 await 期间 `serverWs` 可能被 close handler 设 null 或换成新 sock。await 返回后会用旧消息内容调用当前 webrtcPeer。webrtcPeer 自身有大量 identity guard 兜底，实际穿透概率低。

**修复方向**：每次 await 后重验 `this.serverWs === sock && !this.intentionallyClosed`。

**为什么 TODO**：预存、穿透概率低、webrtcPeer 内部 guard 已兜底。

### webrtc-peer 几处 handler 缺 stale guard（L，预存）

**发现**：G 阶段 deep-review 维度 2（codex-rescue）。

| 锚点 | 缺什么 |
|---|---|
| `webrtc-peer.js:388` `pc.onconnectionstatechange` | guard 在打日志之前应该挪到 logger 之前 |
| `webrtc-peer.js:671` `dc.onopen` | 没 stale DC guard，旧 DC open 仍会调 `__sendPeerTransport` |
| `webrtc-peer.js:705` `dc.onmessage` | handler 入口没有 stale DC guard（reassembler callback 内部已 guard，但 stale 数据仍喂进 reassembler.feed） |
| `webrtc-peer.js:700` `dc.onerror` | 没 stale guard |

**影响**：均 Low——日志噪音 / 老 reassembler 状态被无害修改。核心数据通道已经被 reassembler callback 的 identity guard（`4120b02`）兜住。

**修复方向**：每个 handler 入口加 `if (sess?.rpcChannel !== dc) return;` 或 PC 同款 guard。

**为什么 TODO**：预存边角，整体 stale-guard 体系已经正确兜住关键路径。

### G 阶段其它 Low 条目

- **斜杠命令 bind 在校验 code 之前调 cancelActiveEnroll**（`index.js:696` 附近，本次引入）：无效 code 也会先取消 enroll。修法：先校验 positionals[0] 再 doBind。
- **activeEnrollAbort 提前 set**（`index.js:306`，预存）：`enrollClaw()` 同步抛错时 controller 残留。修法：成功后再 set 或 catch 中清。
- **gateway message listener catch 内 logger 抛形成 unhandled rejection**（`realtime-bridge.js:860`，本次引入 `f983017`）：嵌套 try/catch 即可。
- **非法 DC gateway 请求带合法 id 时仍 broadcast 错误响应**（`realtime-bridge.js:966-984`，本次引入 `c545128`）：可改 unicast 当 connId 已知。
- **测试覆盖小缺口**（本次引入）：`dfdc277` 的 stale-PC 测试只覆盖 `onselectedcandidatepairchange`，未覆盖 `onicecandidate` / `onicegatheringstatechange`；`webrtc-peer.js:173` `sendTo` 的 enqueue-throw catch 路径未测。

**为什么 TODO**：均不影响发版正确性，待后续清理批次统一处理。

### atomic-write 系统断电场景的 fsync 加固（M，预存）

**发现**：G 阶段 deep-review 维度 4（codex-rescue）。
**锚点**：`plugins/openclaw/src/utils/atomic-write.js`（`atomicWriteFile` 与 `atomicWriteFileSync`）

**问题**：当前实现是 `writeFile(tmp) → rename`，rename 是原子 syscall，能防"进程崩溃"。但系统级断电（kernel panic / 拔电）下，tmp 文件的数据可能还在内核 buffer 没刷到磁盘，rename 完成但目标文件读到 0 字节或旧数据。同理父目录的 rename 元数据也可能未持久化。

**影响**：device-identity 私钥、settings、bindings、auto-upgrade state/lock/log 都过这条路；理论上系统断电后可能丢失最近一次写入。但这些数据全部可恢复（重新 bind / 重新生成 deviceId），且 plugin 跑在用户机器上，真"硬断电"极少发生。

**为什么 TODO（不修）**：曾尝试在 7fac52e 加 fsync(tmp) + fsync(父目录)，后回滚（ebffc1d）。原因：
- 价值低 —— 保护极罕见、可恢复场景
- 风险高 —— `tmpFh.sync()` 在某些环境（特殊 FS、网络存储、Windows 路径）可能抛错，未做 best-effort 兜底；atomic-write 抛错会让 auto-upgrade lock / state 写不下去，引入比原问题更危险的 regression
- 测试覆盖不足 —— 没法在普通文件系统上模拟"系统断电"

**修复方向（未来若做）**：
- fsync(tmp) 包成 best-effort try/catch + warn，失败不传播给 caller
- fsync 父目录已经是 best-effort（Windows 不支持 dir fd）
- 给 auto-upgrade 路径加专项测试覆盖 fsync 抛错场景
- 单独发一个补丁版本（不与 release 节奏混在一起）

### coclaw.agent.abort 对 abort-threw 每 tick 都打 logger.info（噪音，预存）

**发现**：Phase B deep-review 综合维度（codex-rescue 第 4 路）。

**锚点**：
- `plugins/openclaw/index.js:605-608` — handler 仅排除 `not-found`，其它 reason（含 `abort-threw`）每次都进 `logger.info?.()`
- `plugins/openclaw/src/agent-abort.js:23-34` — 侧门 abort handle 抛异常被捕获转 `abort-threw`
- `ui/src/stores/chat.store.js:972-973` — UI 把 `abort-threw` 与 `not-found` 一并 500ms tick 重试

**触发场景**：OpenClaw 上游 handle.abort() 持续抛异常（如 internal state 损坏），UI 持续 500ms tick → plugin 每 tick 打一行 `[coclaw.agent.abort] result … reason=abort-threw error=…`，造成日志洪水。

**为什么 TODO（不修）**：
- 这是 pre-existing 行为，Phase B 没动这段判断分支
- 真实触发概率低（要求 OpenClaw handle 持续抛）
- 修复需要扩展"reason 状态翻转"逻辑（仅在 reason 翻转时打），与 not-supported / gone 的"一次性升格"语义不一致，需要单独设计 per-session reason 缓存
- 不阻塞 Phase B 收尾

**修复方向（未来若做）**：
- handler 内维护 per-sessionId 的 lastReason cache（弱引用 / TTL 自动清理）
- 仅在 `result.reason` 与 lastReason 不同时打 info / remoteLog
- 或者更简单：把 `abort-threw` 也加入静默列表（与 not-found 同级），损失部分诊断价值换取噪音控制
- 同时考虑 UI 侧是否要给 abort-threw 加重试次数上限（dump 第三段提到的"过度重试"风险）

## A1 异步装配引入的"handler 已挂、字段未挂"理论窗口（Phase B 切 FBQ 时一并补 warn）

**发现日期**：2026-05-03（rpc-dc Phase A1+A2 deep-review）
**关联**：`plugins/openclaw/src/webrtc/webrtc-peer.js` `__setupDataChannel`

**问题**：Phase A1 把 `__setupDataChannel` 改 async 后，handler 顺序倒过来——A1 之前是"先做三件套（赋字段）后挂 handlers"，A1 之后是"先挂 handlers 后 await queue.init() 才赋字段"。结果：dc.onopen / dc.onmessage 在 await init() 期间触发时，`session.rpcQueue` 还是 null，下游有两条 silent drop 路径：
1. **file sendFn** `sess?.rpcQueue?.enqueue(...)` 在 rpcQueue 为 null 时 short-circuit 返回 undefined，没有任何 log，违反"丢消息必须 loud 可观测"红线
2. **dc.onopen → __sendPeerTransport** 在 init 期触发时 sendTo 返回 false，peer-transport 诊断信息丢失，没有 retry

**MemoryQueue 阶段为什么不触发**：MemoryQueue.init() 是 async no-op（仅消耗 1 microtask），dc.onopen / dc.onmessage 由 SCTP 握手异步触发（native ms 级），microtask 必然在 SCTP 完成之前 resolve。实测 race 窗口宽度 ≈ 0。

**Phase B 切 FBQ 时为什么会成为现实**：FBQ.init() 做 fs.rm + createWriteStream，可能数 ms 到数十 ms，与 SCTP 握手时间重叠，理论窗口 → 现实窗口。

**修复方向（Phase B 时一并做）**：
- file sendFn 加 null check + warn 日志（`rpcQueue not ready, dropped file response`）
- __sendPeerTransport 在 sendTo 返回 false 时打 warn 或一次性 retry（peer-transport 是诊断信息，丢失影响小）
- 等 Phase B 引入 RpcDropMonitor 后，把这两条 silent drop 也作为 reason 上报

## Fire-and-forget `.catch()` 内 logger.warn 自身可能抛 unhandled rejection（项目通用模式，不修）

**发现日期**：2026-05-03（同上 deep-review）
**关联**：`plugins/openclaw/src/webrtc/webrtc-peer.js:489-491`（A1 新加），项目里大量 `this.logger.warn?.(...)` 调用

**问题**：A1 把 `pc.ondatachannel` 改 fire-and-forget，`.catch()` 内调 `this.logger.warn?.(...)` 没有 try/catch 包。如果 logger 实例本身抛错，这个 .catch 返回的 Promise reject 进 unhandled rejection。

**为什么不修**：项目里大量 `logger.warn?.(...)` 调用都没用 try/catch 包，单独包此一处不合理；应在项目层面统一决策（要么所有 logger 调用都包 try/catch，要么接受 logger 自身抛是极冷防御路径）。pino logger 内部错误处理很完备，实际触发概率近零。

**修复方向（项目层面若决策）**：考虑导出统一的 `safeWarn(logger, msg)` helper，所有 fire-and-forget 链路统一调用。
