# Plugin TODO

## __forwardToServer 在 WS 断窗口期静默/丢信令的完整方案

**发现日期**：2026-05-08（codex-rescue review WS-PC 解耦方案时识别）
**关联 commit**：fix(plugin): keep WebRTC sessions across server WS reconnect; tighten heartbeat miss limit to 3

**问题**：`realtime-bridge.js` `__forwardToServer` 在 `serverWs` 不可用或 `send` 抛异常时，仅记本地 log 后丢弃 payload。WS 断窗口期 webrtcPeer 异步回调（trickle ICE candidate、`handleSignaling` 几个 await 之间触发的 `rtc:answer` / `rtc:restart-rejected` 等，ICE restart 应答与初次应答都走 `rtc:answer`）会被丢。

**为什么本次未一并修**：丢失对 plugin 端 PC 状态机不致命——UI 端 sig.state 恢复后会主动触发新一轮 ICE restart，重发完整 candidate set 与 SDP；plugin 端因保留了 webrtcPeer，新一轮 restart 直接走 `restartIce` 续上，不需要 rebuild。当前是观察项不是阻塞项。

**修复方向**：要么在断窗口期 queue 待发信令、重连后批量补发；要么在 SDP-bearing 信令发送失败时把对应 connId 标记为 failed，让下一轮 ICE restart 自然重启该 connId。需评估对端（UI / server）契约。

## MAX_SESSIONS=10 不是硬上限（all-active 时 evict 失败仍创建新 session）

**发现日期**：2026-05-08（codex-rescue review WS-PC 解耦方案时识别）
**关联**：`webrtc-peer.js` `__evictOldestFailed`

**问题**：`createSession` 撞 `MAX_SESSIONS` 时仅尝试淘汰 `connectionState === 'failed'` 的 session；若所有 session 都还活着（disconnected / checking / connected），evict 返回 false 但仍继续创建新 session。

**影响**：极端场景下 sessions 数会超过 10。常见路径不会触发（CoClaw UI rebuild 复用 connId、不增 session 数；多设备并发也罕见超 10）。WS-PC 解耦后 PC 跨重连保留，理论上窗口稍长但实战影响小。

**修复方向**：达到上限时拒绝新 offer 回 `rtc:offer-rejected reason=max_sessions`，或加 LRU 强制淘汰。

## Lazy init race：close handler 撞 `__webrtcPeerReady` pending

**发现日期**：2026-05-08（codex-rescue review 时识别）
**关联**：`realtime-bridge.js` close handler 4001/4003 分支与 `__initWebrtcPeer`

**问题**：4001/4003 destructive close 用 `if (this.webrtcPeer)` 判空跳过 closeAll；若此时 `__webrtcPeerReady` 仍 pending（lazy init 进行中），close handler 不会清理；稍后 init 完成把 webrtcPeer/fileHandler 赋上去，绕过清理留下无主实例。

**影响**：仅 4001/4003 路径（plugin 失资格 + 不重连），形成 leak 直到 plugin 重启或 stop()；不会影响新 sock 的服务（4001/4003 后无重连）。本次解耦方案未放大此 race。

**修复方向**：在 4001/4003 入口先 `await this.__webrtcPeerReady?.catch(()=>{})`，再走清理；或引入 generation token，pending init 在完成时检查 token 是否仍有效。

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

## race 测试标题与实现失配（PRE-EXISTING，Phase B-stage1 plan-2 deep-review 顺手抓出，不修）

**发现日期**：2026-05-03（rpc-queue-startup deep-review dim C）
**关联**：`plugins/openclaw/src/realtime-bridge.test.js:3451` / `:3498`

**问题**：两个测试标题写 "stop() called during preload (race protection)" / "stop() during pion preload"，但实现只手动 `bridge.started = false`，没真调 `bridge.stop()`。覆盖了"flag 已变 false"分支，但没走 stop 生命周期副作用（如清 timers / 关 ws）。

**为什么不修**：本次（plan-2）只是顺手注入了 stub 跳过 plan-2 fs 预热，没动这两条测试的语义；标题与实现失配是 plan-1 之前就存在的问题。

**修复方向**：要么把标题改为 "started=false during preload"（轻），要么把实现改为真调 `await bridge.stop()`（更重，但更覆盖到生命周期副作用）。

## setupDir() 全局污染 process.env / runtime（PRE-EXISTING，记录）

**发现日期**：2026-05-03（rpc-queue-startup deep-review dim C）
**关联**：`plugins/openclaw/src/realtime-bridge.test.js:65`

**问题**：`setupDir()` helper 修改 `process.env.OPENCLAW_STATE_DIR` / `OPENCLAW_CONFIG_PATH` / 删除 `COCLAW_TUNNEL_CONFIG_PATH`、调用 `setRuntime(null)`，但没有成对 restore；当前靠每个用例重设维持稳定，未来新增用例容易踩污染。

**修复方向**：helper 返回 restore fn，或抽 envSnapshot/restore 工具集中处理。属于测试基础设施层面，需要批量重构现有所有调用点。

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

## claw-paths runtime 改造遗留（2026-05-05 deep-review 抓出，预存）

### session-manager 不传 entry.sessionFile（PRE-EXISTING）

**发现日期**：2026-05-05（claw-paths-unify deep-review）
**锚点**：`plugins/openclaw/src/session-manager/manager.js:283-288` `resolveTranscriptFile`

**问题**：调 `resolveTranscriptPath(sessionId, agentId)` 时第三参数 `entry` 始终不传。OpenClaw 上游 `resolveSessionFilePath(sid, entry, opts)` 会先用 `entry.sessionFile` 字段决定 transcript 文件名，再回退到 `<sid>.jsonl`。当用户 / OpenClaw 把 `sessions.json` 索引里的 `sessionFile` 改名（reset 重命名、自定义命名）时，我们永远只看默认名，会读到空。

**为什么 PRE-EXISTING**：claw-paths runtime 改造前的旧代码 `nodePath.join(dir, '${sessionId}.jsonl')` 同样不感知 entry，本次重构未引入也未扩大。

**修复方向**：从 `readIndex(agentId)` 拿到 `entry`，传给 `resolveTranscriptPath` 第三参数。

### 上游 agents.<id>.store 自定义配置不被支持（PRE-EXISTING）

**发现日期**：2026-05-05
**锚点**：`plugins/openclaw/src/claw-paths.js:48-54` `sessionStorePath`

**问题**：调上游 `runtime.agent.session.resolveStorePath(undefined, { agentId })` 时 `store` 参数始终传 `undefined`，上游收到 undefined 走默认布局，agent 配置的 `agents.<id>.store` 自定义路径（绝对路径 / `{agentId}` 模板）被无视。

**为什么 PRE-EXISTING**：旧代码也没读 OpenClaw 配置；本次只是把"目标永远是默认布局"显式化、文档化。

**修复方向**：在 plugin runtime 拿 agent 配置（如 `runtime.config.loadConfig()?.agents?.[agentId]?.store`），传给 helper。需先核对 OpenClaw 暴露 agent 配置的稳定 API。

### chat-history-manager:39 c8 ignore 注释不准（PRE-EXISTING）

**锚点**：`plugins/openclaw/src/chat-history-manager/manager.js:39`

**问题**：注释说"测试始终注入"，实际测试不注入 `readFile` / `writeJsonFile`，走默认路径。当前 ignore 实际掩盖的是"truthy-LHS 那侧分支没有覆盖"。要么补一个注入 mock 的测试覆盖 LHS 分支，要么删掉 readFile/writeJsonFile 这两个 DI 注入点（生产+测试都不用）。

### setHomedir 测试 mock 大量变成"死 mock"（PRE-EXISTING 噪音）

**锚点**：`plugins/openclaw/src/realtime-bridge.test.js`、`src/common/claw-binding.test.js`、`src/plugin-mode.test.js`（共上百处 setHomedir 调用）

**问题**：claw-paths runtime 改造后生产代码不再读 `os.homedir()`，但测试里仍大量 `setHomedir(...)`。多数实例已是 mock 一个生产代码不再读取的全局 —— 噪音 + 误导。auto-upgrade worker 路径仍读 homedir，那部分 mock 仍有效。

**修复方向**：逐个排查，仅保留 auto-upgrade worker fallback 测试场景的 setHomedir，其余移除。需小心不破现有断言。

### bridge.start 后续路径未抓 pluginDir 抛错（防御性，预存）

**锚点**：`plugins/openclaw/src/realtime-bridge.js:1442` `await this.__connectIfNeeded()`

**问题**：`start()` 顶部 rpc-queues 启动期块用 try/catch 抓了 pluginDir 抛错，但同一函数后段 `__connectIfNeeded` → `getBindingsPath` → `pluginDir()` 链路没有 catch。生产中 runtime 必然已注入，pluginDir 不会抛——纯防御。

**修复方向**：把 `await this.__connectIfNeeded()` 也包进 try/catch + warn。或者干脆 fail-loud：runtime 缺失就让 service 注册整体失败。

### auto-upgrade vs claw-paths 部分注入不对称（防御性，本次新引入但不可达）

**锚点**：`plugins/openclaw/src/auto-upgrade/state.js:23-30` vs `src/claw-paths.js:24-29`

**问题**：runtime 是非空对象但 `runtime.state` 缺失这种"部分注入"形态下，claw-paths.js 抛错而 auto-upgrade/state.js 静默 fallback env/homedir，同一进程可能写到不同 state-dir。生产路径不可达（index.js 只在 full mode 调 setRuntime + 上游 runtime 形态固定），属防御性。

**修复方向**：auto-upgrade/state.js 加守卫——发现 runtime 对象存在但 .state.resolveStateDir 缺失时，与 claw-paths.js 行为对齐（抛错或委托给 clawStateDir）。

### session-manager 散落 c8 ignore 多条可补测（PRE-EXISTING 噪音）

**锚点**：`plugins/openclaw/src/session-manager/manager.js` 行 55 / 133 / 138 / 170 / 176 / 183 / 189 / 193 / 250 / 339

**问题**：多处裸 `c8 ignore next` 或简单 `?? fallback` 注释覆盖了可测的默认构造、malformed 内容、无效 index 条目、分页边界等分支。逐条补针对性测试可摘 ignore；与本次 claw-paths 改造无直接关系。

### connId 字符集隐式契约：含特殊字符时 rpc 队列构造抛错（PRE-EXISTING）

**发现日期**：2026-05-05（B-stage2 B9b codex round-1 抓出）

**锚点**：`plugins/openclaw/src/webrtc/webrtc-peer.js` 装配点 + `src/utils/file-backed-queue.js:25` / `src/utils/memory-queue.js:30`（共用 `^[A-Za-z0-9._-]+$` 校验）

**问题**：FBQ 与 MemoryQueue 都对构造 `id` 做字符集校验（防路径穿越）。webrtc-peer 装配 queue 时把 server 分配的 connId 直接 / 拼接进 id。若上游 server 改变 connId 格式引入特殊字符（如 `:` `/`），queue 构造会抛 TypeError，被 `__setupDataChannel.catch` 兜底 warn，但 session.rpcQueue 留 null → 该连接的 rpc 路径残废。

**B9b 后的状态**：fbq 模式 id = `${connId}-${ts}-${uuid8}`，仍以 connId 开头，问题无变化（PRE-EXISTING，与 B9b 无关）。

**修复方向**：要么在装配点 sanitize（`connId.replace(/[^A-Za-z0-9._-]/g, '_')`），要么明示文档化 server↔plugin 的 connId 字符集契约（`^[A-Za-z0-9._-]+$`）。当前 server 实际生成 `c_<digits>` 形态，符合契约——B9b 不修，仅在装配点加注释提示。

### sendPeerTransport 签名回滚后无重发触发器（PRE-EXISTING）

**发现日期**：2026-05-06（B-stage2 B10 deep-review 抓出）

**锚点**：`plugins/openclaw/src/webrtc/webrtc-peer.js:905-932`（`__sendPeerTransport`）+ `:635-644`（`dc.onopen` queueMicrotask 调用点）

**问题**：`__sendPeerTransport` 在 sendTo 失败时回滚 `__lastPeerTransportSig` 并注释"以便 dc.onopen 再次触发时重发"，但 `dc.onopen` 在 dc 生命周期内只触发一次——没有任何机制让它"再次触发"。失败后该 session 的 peer-transport 信息（candidate type / protocol / relay protocol）永久不会上报到 UI 诊断。

**触发条件**：dc.onopen 触发时 `session.rpcQueue` 尚未就绪——`sendTo` line 190 检查 `if (!q || ...) return false`。MemoryQueue 时代 `init()` 是异步 no-op-but-callable（plan-1 round-2 引入），微秒级完成；切到 FBQ 后 `init()` 包含 mkdir + readdir + cleanupResiduals + open writeStream，时间窗从 microtask 级放大到数十毫秒级。**B-stage2 B9b 让 PRE-EXISTING bug 从理论暴露变成实际易复现**，但 race 本身在 plan-1 round-2 引入 `init()` 后就已存在。

**影响**：仅 UI 诊断信息（peer transport 信号）丢失，不影响 RPC 业务。

## 跟踪 OpenClaw 上游契约演进对 auto-upgrade 的影响

**发现日期**：2026-05-06

**背景**：自动升级链路跨"gateway 进程内 spawner"和"detached worker 子进程"两段，对 OpenClaw 的依赖面分成两块。任何一块的契约变更都可能让自动升级整体失效或误回滚，需统一跟踪。

### 1. 账本格式（spawner 端依赖，已发生过事故）

**锚点**：`plugins/openclaw/src/auto-upgrade/updater.js` 的 `loadInstallRecord` / `INSTALLS_LEDGER_RELATIVE_PATH`

OpenClaw 2026.4.25 把插件安装记录从 `openclaw.json` 的 `plugins.installs` 迁移到独立账本 `<state-dir>/plugins/installs.json`（key `installRecords[<pluginId>]`），并在 `loadConfig()` 返回前剥掉老字段——这次 0.19.2 → 0.20.0 升不动就是这条契约变更触发的。当前 `loadInstallRecord` 硬编码新路径与字段名，新旧 gateway 兼容靠"账本不存在 → 回落到 loadConfig"互斥分流。

**风险**：上游若再搬家（路径/文件名/字段名变更）或 strip 行为收紧（连兜底字段都不返）会让自动升级再次失效。SDK 侧已有 `loadInstalledPluginIndexInstallRecordsSync` helper（`src/plugins/installed-plugin-index-record-reader.ts`），但需要插件先依赖 `@openclaw/plugin-sdk`，且该 helper 的最低 host 版本高于当前插件 `minHostVersion`。

**应对**：升级 OpenClaw 时关注 `src/plugins/installed-plugin-index-store-path.ts` / `installed-plugin-index-record-reader.ts` 是否变更；若 SDK 公开 install records helper 且最低 host 版本可接受，考虑切换到 SDK API。

### 2. CLI 契约（worker 端依赖，目前未踩坑）

worker 故意不读 OpenClaw 内部 state（pluginDir 由 spawner 通过 `--pluginDir` 传入），全程靠子进程调 `openclaw` CLI，因此对 CLI 行为强耦合：

| 调用 | 锚点 | 失败后果 |
|---|---|---|
| `openclaw plugins update <id>` | `worker.js:52` | 升级直接失败 → 回滚（不 skipVersion，按瞬态） |
| `openclaw plugins uninstall <id>` + `plugins install <pkg>@<ver>` | `worker.js:89/95` | 备份恢复失败时无兜底回滚 |
| `openclaw gateway restart` | `worker-verify.js:80` | 验证前 gateway 不被主动重启，依赖 watcher 自恢复 |
| `openclaw gateway call <method> --json` | `worker-verify.js:114` | 见下条 |
| `--json` 输出 = RPC result 原值（无 envelope） | 同上 | 若上游加 `{ok,result}` 包装，`JSON.parse(output).version` 取到 undefined → 一直 missing-version → 验证超时 → 误判为"新版本坏掉"并 skipVersion + 回滚 |

**风险等级**：CLI 子命令名长期稳定（CHANGELOG 没出现过重命名），但 `--json` 输出包装是历史相对短的接口，`docs/auto-upgrade.md` 里也标了"`coclaw.upgradeHealth` 返回格式 → 待定"。

**应对**：升级 OpenClaw 时关注 `src/cli/gateway-cli/call.ts` 与 `plugins-*.ts` 是否变更子命令名/参数 schema/输出格式；尤其留意 `gateway call --json` 是否加 envelope。如确实加包装，worker-verify 的解析需相应放开（兼容两种形态）。

**修复方向**：装配 rpcQueue 后主动调一次 `__sendPeerTransport(connId)`（条件：`session.pc.selectedCandidatePair` 已 nominate 完成），或在 sendTo 失败回滚 sig 后注册一个"等 rpcQueue 就绪重试"的钩子。

## 2026-05-06 deep-review（claw-config host adapter）抓出的预存问题

### updater.js loadInstallRecordFromLegacyConfig catch 静默无日志（PRE-EXISTING）

**锚点**：`plugins/openclaw/src/auto-upgrade/updater.js` 的 `loadInstallRecordFromLegacyConfig`

catch 直接 `return null`，没有任何 log / remoteLog 输出。后续 `shouldSkipAutoUpgrade()` 拿到 null 走 skip 分支时只有调度层的通用日志（`Skipping: not an npm-installed plugin`），无法区分"正常无记录"和"读 config 抛异常"。

**风险**：低概率场景下（host config reader 抛异常）的诊断盲区。本次 claw-config 改造延续了这个写法，没新引入。

**修复方向**：catch 内补 `remoteLog('upgrade.legacy-config-read-failed msg=...')`，与同函数 `loadInstallRecord` 已有的三条 remoteLog 信号风格统一。

### realtime-bridge defaultResolveGatewayAuthToken catch 用 console.warn 而非 host logger（PRE-EXISTING）

**锚点**：`plugins/openclaw/src/realtime-bridge.js` 的 `defaultResolveGatewayAuthToken` catch 块

catch 调 `console.warn?.(...)` 而非 host 注入的 logger。项目惯例是用注入 logger（pino 风格 `logger.warn?.(...)`）。

**注意**：可能是有意为之——这个函数在 register 早期 / runtime 未注入完成时也可能被触达，那时 logger 可能不可用，console.warn 是兜底。修复前需先确认调用时序。

**修复方向**：若确认 logger 总可用，切到注入 logger；否则补一行注释解释为何用 console。

### file-handler resolveWorkspace 仍直接走 api.runtime.config.loadConfig（PRE-EXISTING）

**锚点**：`plugins/openclaw/index.js:642`（`resolveWorkspace` 内 `const cfg = api.runtime?.config?.loadConfig();`）

`eab42c5` 把 auto-upgrade legacy 路径与 gateway auth-token 解析都收口到 `getClawConfig()`，但 file-handler 这处 callsite 没跟上，仍直接调 `loadConfig`。在 OpenClaw 2026.4.27+ 上会触发 deprecation 警告，不破功能。

**修复方向**：改用 `getClawConfig()`（`src/claw-config.js`）；仅一行替换 + import 即可。下次顺手收口。

## 2026-05-06 deep-review（file-manager test setTimeout→waitFor 改造）抓出的预存问题

### __gatewayRpc 真 setTimeout 触发 settle 路径丢失端到端测试覆盖

**锚点**：`plugins/openclaw/src/realtime-bridge.js:379` 的 `setTimeout(() => settle({ ok: false, error: 'timeout' }), timeoutMs)`

**背景**：b106430 把 `ensureAgentSession should NOT reset on resolve timeout` 用例 stub 掉了 `__gatewayRpc`（避免等真 2s 定时器），节省 ~2s。后果：`__gatewayRpc` 自身的真 setTimeout 触发 settle 行为不再有用例端到端验证。

**注意**：c8 line coverage 仍 100%（setTimeout 注册行通过其他路径被执行；arrow function body 也算 covered）。但**真 timer fire → settle('timeout') → clearTimeout → delete pendingRequest** 的端到端行为没专门用例。`__gatewayAgentRpc` 是另一套独立实现，不复用 `__gatewayRpc`。

**修复尝试记录**：本次 review 试过补一条直测用例（`bridge.__gatewayRpc('any.method', {}, { timeoutMs: 10 })`），但 bridge.start() 后即使调 `drainEnsureAllAgentSessions` 也会让 event loop 残留 pending promise（连续两次报 `'Promise resolution is still pending but the event loop has already resolved'` + `cancelledByParent` 级联取消后续 ~140 个用例），暂未找到稳定 setup。已撤回。

**修复方向**：考虑直接 mock 一个 bridge 实例，手工设置 `gatewayWs` / `gatewayReady` 等内部状态，绕过 `bridge.start()` 的全套副作用；或拦截 `setTimeout`（参考 `RealtimeBridge should handle connect timeout` 的 timer 拦截 pattern）让 setTimeout 立即触发。

### handler.test.js 多处保留固定 sleep，等的是"不崩溃" / fire-and-forget 清理路径（PRE-EXISTING）

**锚点**：`plugins/openclaw/src/file-manager/handler.test.js` 中以下行保留 `await new Promise((r) => setTimeout(r, X))`：

- 约 line 1168、1174 — DC 取消用例：等 onclose / 临时文件清理
- 约 line 1265 — 等 ws.write callback 触发后的 done 处理
- 约 line 1399 — 等 createWriteStream 错误同步抛后的清理
- 约 line 1655、1659 — 等 dc.close 后续异步动作 / 等"未消息态"窗口
- 约 line 1723、1747、1751 — 上传过程中的多步同步状态翻转
- 约 line 2490 — 等 ws 异步 open + drainLoop 写入，避免 dc.onerror 与 ws.open 竞态

**特点**：这些等待普遍是"等几个 tick 让异步链路 / fire-and-forget 副作用走完"，没有正向完成信号可挂 predicate。本次 setTimeout→waitFor 大改造没动它们。

**风险**：在极慢 CI（高并发、低 IO）下，这些固定毫秒数可能不足，引入 flake；时长又都很短（10–50ms），实际影响概率低。

**修复方向**：逐条评估能否引入 mock hook（如 hook ws.destroy / hook safeUnlink / hook dc.close）让它们也变事件驱动；做不到的保留固定 sleep 但给出明确的"等的是什么"注释。

## 2026-05-07 FBQ bypass-overshoot round 2 deep-review 抓出的预存问题

### webrtc-peer.test 的 flushAsync 依赖固定圈数 setImmediate（PRE-EXISTING）

**锚点**：`plugins/openclaw/src/webrtc/webrtc-peer.test.js:19` 的 `flushAsync` helper

**问题**：当前实现是固定圈数 `setImmediate`，consumeLoop 或 setup 内部任何位置多一个 `await` 都可能让相关测试假通过或假失败。

**修复方向**：改成轮询具体可观测条件（如 `until queue.memBytes === 0` / `until session.rpcDcSender.flushed === true`）或等待事件 Promise，而非固定 tick 数。

### 部分 peer/session 测试缺 `t.after()` 清理（PRE-EXISTING）

**锚点**：`plugins/openclaw/src/webrtc/webrtc-peer.test.js` 多处构造 `peer` / 注入 `setupRpcDcSession` 但只在主路径调 `peer.closeAll()`；异常分支里 `closeAll` 可能被跳过。

**问题**：测试间可能泄漏 unref 定时器或 sender flush 回调；目前没有触发明显的 cross-test 干扰，但符合"测试本身可靠性"的隐患。

**修复方向**：每个创建 peer 的 test 用 `t.after(async () => { await peer.closeAll(); })` 统一兜底，无论主路径分支如何均能关闭。

## 2026-05-07 FBQ 本机实测中发现的诊断盲点

### FBQ / monitor 都未统计 bypass overshoot 的次数与字节数

**发现日期**：2026-05-07（FBQ 本机实测 A 场景，跑 agent run 看不到 bypass 路径流量量级）

**锚点**：
- `plugins/openclaw/src/utils/file-backed-queue.js:184-190` bypass overshoot 入队路径无任何计数
- `plugins/openclaw/src/utils/file-backed-queue.js` `stats()` 只返回 memCount / memBytes / diskBytes / writtenBytes / spilled / fsBroken
- `plugins/openclaw/src/webrtc/rpc-drop-monitor.js` `getStats()` 当前返回 dropCount / dropBytes / overflowActive / spillActive / fsBroken / lastReason，仍然没有 bypass 计数

**问题**：degraded 模式下 bypass overshoot 是"豁免 admission 但没存账"的路径，运维侧无法知道它救了多少帧。健康路径下也无法区分入队的是 bypass 流量还是普通流量。close-log 的 `residualChunks` 只是关闭瞬间快照，算不上累计统计。

**影响**：bypass overshoot 是 round 1 修复的核心特殊路径，但缺乏正向流量观测——只能间接通过"`fsBroken=true` 但 `dropped=0` / `lastReason!=fs-error`"等组合推断曾经走过。一旦 bypass 流量持续大、mem 桶接近无界（红线 3 设计取舍接受 OOM 风险），运维只能看 RSS 增长后果，看不到原因。

**修复方向**：
- FBQ `enqueue` 增加 `__bypassEnqueueCount` / `__bypassEnqueueBytes` 累计字段，stats() 透出
- 可选：进一步细分 `__bypassOvershootCount`（仅 overshoot 路径触发）vs 普通 bypass 入队（memFits=true 时也豁免 diskCap admission，算 bypass 但不是 overshoot）
- monitor 不必参与（monitor 是 drop 视角，bypass 不是 drop）；bypass 统计放 FBQ 自身 stats 即可
- close-log 加 bypass 累计字段（与 dropped / residual 并列），让降级期间的 bypass 救援量级可观测

## 2026-05-08 FBQ/MemoryQueue 收口 deep-review 发现的预存问题

### 同 connId 多次 ondatachannel 并发 setup race

**发现日期**：2026-05-08（收口 deep-review 期间 codex-rescue 对 P1 装配段 nullify 修法做事前副作用评估时 surface）

**锚点**：
- `plugins/openclaw/src/webrtc/webrtc-peer.js:519` `__setupDataChannel` 是 fire-and-forget 调用（ondatachannel 回调 sync 段无法 await）
- `plugins/openclaw/src/webrtc/webrtc-peer.js:694-708` 装配段开头检查 `session.rpcDcSender || session.rpcQueue` 决定是否清旧实例

**问题**：sync nullify 修法把四字段先置 null 再 await 旧 destroy。**race**：第二次 ondatachannel 在 setup1 还没跑完时同 connId 又来一次（极罕见，但理论上 UI/Server 不正确实现可触发）：
- setup1 进入装配段，sync nullify 四字段，await 旧 destroy（卡在 mutex 异步）
- 同 tick setup2 触发 ondatachannel sync 段（rpcChannel 又被覆盖一次到第三个 dc）
- setup2 进装配段看 `session.rpcDcSender || session.rpcQueue` —— 都已 null（被 setup1 清空）→ 跳过整段清旧分支
- setup2 直接走"创建新 monitor + new Queue + queue.init() + ..."—— 与 setup1 await destroy 后将创建的新 queue 并存

**影响**：两个 setup 的 consumeLoop 同时跑，两个 queue 同时 wire 到 session，最后赋值的覆盖前一个，前一个泄漏。生产中没有已知触发场景（UI 不会在第一次 rpc DC 还没关闭时就发起第二次）。

**说明**：此 race 在 sync nullify 修法**之前**也已存在（旧代码下 setup2 也会进入 await destroy 但 destroy 内 fast-return，结果仍是双 setup 覆盖赋值）；nullify 不是引入根因，只是窗口更明显。codex 建议在 session 上挂 `rpcSetupInProgress` Promise，让后到 setup await 它——但这是引入新协调机制，违反"避免过度设计"原则。

**修复方向**（如未来真触发再做）：
- 在 session 上加 `rpcSetupInProgress` promise marker
- setup 进入装配段前先 `await session.rpcSetupInProgress`，再开始自己的 teardown-then-build
- setup 完成时清 marker

### `__handleFsError` 不 emit `onSpillEnd` → monitor `spillActive` 永远 true

**发现日期**：2026-05-08（发版 0.21.0 前最终兜底 deep-review 由 codex-rescue 实例 5 surface）

**锚点**：
- `plugins/openclaw/src/utils/file-backed-queue.js:478-495` `__handleFsError` 内 `this.spilled = false` 后没调 `__dispatchSpillEnd`
- `plugins/openclaw/src/utils/file-backed-queue.js:284` `clear()` 内 `wasSpilled` snapshot 后调 `__dispatchSpillEnd`（A2 修法），但读的是已被 `__handleFsError` 清掉的 `spilled` 字段——若先经 `__handleFsError` 再 `clear()`，`wasSpilled=false`，不再 dispatch
- `plugins/openclaw/src/webrtc/rpc-drop-monitor.js:131` `onSpillStart` 幂等守卫（`spillActive=true` 时直接 return）

**问题**：FS 故障粘性降级路径上，`__handleFsError` 把 `spilled` 翻 false 但**不通知 monitor**。monitor 的 `spillActive` 仍是 true。后续若调 `clear()` 也救不回（snapshot 看到 `wasSpilled=false`）。结果：monitor 的 `spillActive` 永远卡在 true，下一次"真实"`onSpillStart` 被幂等守卫吃掉。

**当前不触发**：webrtc 路径下 FBQ 实例不调 `clear()`（peer 重建走 `destroy` 不走 `clear`），所以这条契约破坏不会被触发。但破坏了 FBQ ↔ monitor 的公共状态契约——一旦未来有路径在 FS 降级后调 `clear()` 恢复，monitor 状态机就错乱。

**修复方向**（如未来真触发再做）：
- `__handleFsError` 在 `this.spilled = false` 之后立即 `__dispatchSpillEnd(0)`（drainedBytes=0 因为 FS 故障删档不算 drain）
- 或者让 `clear()` 不依赖 `wasSpilled` 直接无条件 dispatch（但会破坏"未 spilled 时 emit onSpillEnd 是 bug"语义）
- 推荐前者——故障删档明确语义为"spill 中断"，与 drain/clear 的"spill 自然结束"并列

### 装配段 `new FileBackedQueue()` / `init()` 抛错时的静默缝隙

**发现日期**：2026-05-08（发版 0.21.0 前最终兜底 deep-review 由 codex-rescue 实例 4 surface）

**锚点**：
- `plugins/openclaw/src/webrtc/webrtc-peer.js:518` ondatachannel sync 段已经把 `session.rpcChannel` 切到新 dc（`readyState='open'`）
- `plugins/openclaw/src/webrtc/webrtc-peer.js:694-715` 装配段 sync nullify 四字段 + await 旧 destroy
- `plugins/openclaw/src/webrtc/webrtc-peer.js:727-754` 创建新 monitor / `new FileBackedQueue(...)` / `await queue.init()` / wire sender / consume loop —— **整段无局部 try/catch fallback**
- `plugins/openclaw/src/webrtc/webrtc-peer.js:519` 最外层 `__setupDataChannel(...).catch(...)`（fire-and-forget catch）

**问题**：装配段 nullify 之后若 `new FileBackedQueue()` 构造校验抛（`memBudget` / `diskCap` / `maxMessageBytes` 非有限正数）或 `init()` 抛（`fs.mkdir` 异常路径），异常被最外层 catch 兜住——此时 `session.rpcChannel=新 dc` 但 `rpcQueue=null` / `rpcDcSender=null` / 等四字段全 null。新消息进 broadcast 看 `rpcQueue=null` skip，**新 dc 开着但没有 queue 后端**，静默丢消息。

**当前不触发**：FBQ 构造校验抛只在 `getDiskCap()` 返回非有限正数时触发（misconfiguration / startup prep timeout 后 `__diskCap=null` 走 MemoryQueue 分支，不走 FBQ）。`init()` 的 `fs.mkdir` 在权限/磁盘异常下可能抛，但前置 `__measureRpcQueueDiskCap` 已 `statfs` 过，多数环境下不会再失败。

**修复方向**（如未来真触发再做）：
- 装配段 try/catch 包整段创建逻辑，catch 里 fallback 到 MemoryQueue（与 startup prep timeout 降级路径对齐），并 `logger.warn?.(...)` 记录
- 或者 catch 里保持四字段 null（已是该状态），但加 warn log 让运维侧看到"新 dc 装配失败"
- 推荐前者——保住 dc 可用性比"无 queue 静默"更对齐用户预期

## __pushInstanceInfo 失败回 agentModels=null 会清空 admin 仪表盘的 agent 列表

**发现日期**：2026-05-09（Round 2 step 2 deep-review 由 general-purpose subagent surface）

**锚点**：
- `plugins/openclaw/src/realtime-bridge.js:523-541` `__pushInstanceInfo` 主体
- `plugins/openclaw/src/realtime-bridge.js:547-563` `__collectAgentModels` 失败回 `null`
- `plugins/openclaw/docs/plugin-events.md` 关于 `coclaw.info.updated` 字段 patch 语义的描述

**问题**：`__pushInstanceInfo` 调 `__collectAgentModels` 失败时 payload 显式带 `agentModels: null` 推到 server。按 patch 语义出现的字段会更新（含 null），server / admin 据此覆写——也就是 admin 上 agent 列表会被 null 清空一次。`agents.list` 撞 3s timeout 或 gateway 高负载时就可能触发。

**当前不致命**：admin 上 agent 列表会被 null 覆盖，下次主动重推（gateway connect-ok / 外线 open 补推）才会用真实数据再覆盖回来——`agents.list` 单次 timeout 不会自动重试，admin 在两次 reconnect 之间会一直显示空列表。step 2 让外线 reconnect 也补推一次，触发面比 step 1 之前略大。

**修复方向**：`__collectAgentModels` 失败时 omit `agentModels` 字段（不要传 null），按 patch 语义保留旧值；或 server 端对 `agentModels === null` 单独不覆盖。

**预存问题**：step 2 之前 connect-ok 那次推送也一样会触发，本次未顺手修。

## gateway WS transport-level error 握手前发生时重试调度静默卡死

**发现日期**：2026-05-09（Round 2 step 2 deep-review 由 codex-rescue 综合实例 surface）

**锚点**：
- `plugins/openclaw/src/realtime-bridge.js:975-987` `ws.addEventListener('error', ...)` handler — 仅打日志 + 主动 close，没有标"connect-failed"
- `plugins/openclaw/src/realtime-bridge.js:963-973` close handler 重试调度的判定 `if (this.started && !this.__gatewayGaveUp && (wasReady || connectFailReported))`
- `connectFailReported` 仅在 `:812` 设置 true（v3 握手 res 的协议错误分支）

**问题**：gateway WS 在握手前发生 transport-level error（连接被拒、DNS 失败等）时，error handler 主动 ws.close(1011)，但 `connectFailReported` 没人设 true、`wasReady` 也是 false。close handler 的重试调度判定两个条件都不满足 → **静默不重试**，gatewayWs 卡在 null，新一轮 `__ensureGatewayConnection` 也不会自动调度。bridge 看似活着但内线永久断。

**当前不易触发**：本机 OpenClaw gateway 是同进程嵌入，本地 WS 连接极少 transport error。但 IPC over WS / 容器化场景下可能撞到。

**修复方向**：error handler 内主动设 `connectFailReported = true` + `__gatewayLastReason = 'ws_error'`，让 close handler 走重试路径；或独立调用 `__onGatewayAttemptFailed('ws-error')`。

**预存问题**：step 1 之前就存在（step 1 仅移除了外线 gate `serverWs && serverWs.readyState === 1`），不是 Round 2 引入，但 Round 2 让内线独立后这个长尾问题会更显眼（外线无法兜底重启内线了）。

## docs/rpc-routing.md 与 step 1 实际行为不一致

**发现日期**：2026-05-09（Round 2 step 2 deep-review surface）

**锚点**：
- `plugins/openclaw/docs/rpc-routing.md:62` 写"网关 ws close（含手动调 `__closeGatewayWs` / ws 自己 close handler）| `clear()`，timer 留着"
- 实际 step 1 已改为：网关 ws close 不再清 P2P 路由表（`__dcPendingRequests` / `__runEventRoutes`）；只有显式销毁路径（`bridge.stop()` / `refresh()`）才 clear

**问题**：文档与代码语义不符，跟着文档实现的人会以为"网关掉线就清表"，实际 step 1 后两者已独立。

**修复方向**：把"网关 ws close → clear()"那行改成"`bridge.stop()` / `refresh()` → `destroy()`/`clear()`；网关 ws close handler 仅清 lag probes 和 gateway pending RPC，不清路由表"。

**预存问题**：step 1 漏改文档，本次顺手发现，不修。

## pion-ipc SIGTERM 退出码 + watchdog 误打 schedule restart 噪声

**发现日期**：2026-05-09（Round 2 系统级测试 gateway 重启日志分析）

**锚点**：
- `@coclaw/pion-ipc`（Go 二进制）SIGTERM 处理路径 + exit code 决定逻辑
- `node_modules/.../@coclaw/pion-node@0.3.0/src/pion-ipc.js:308` `_handleProcessExit` / line 329 `_scheduleRestart`
- gateway 重启时 plugin stop hook 与 OS 进程组信号传播的时序

**现象**：gateway 收到 SIGTERM 重启时，gateway 日志会出现这一串噪声：
- `[pion-ipc] [stderr] received signal, shutting down signal:15`
- `[pion-ipc] [stderr] ERROR service exited with error: context canceled`
- `[pion-ipc] process exited code=1 signal=null`
- `[pion-ipc] watchdog: restart #1 in 200ms`

但 watchdog 计划的 200ms 重启实际不会发生——plugin stop 路径稍后调到的 `ipc.stop()` 会把 `_stopped/_intentionalStop` 标记上并清掉 `_restartTimer`。

**根因层次**：
- OS 把 SIGTERM 群发给整个进程组 → pion-ipc Go 子进程**先于** plugin stop hook 调到 `ipc.stop()` 之前被杀
- Go 端把 `context.Canceled` 当 ERROR 返回主进程并 exit code=1（应当 exit 0）
- pion-node 的 `_handleProcessExit` 看到 `_intentionalStop=false`（plugin 还没来得及调 stop），按崩溃路径 schedule watchdog restart 并打 log
- 紧跟 plugin stop 调到 `ipc.stop()`，把 watchdog 拆掉，**实际没有真重启**

**影响**：仅日志噪声，不影响功能。但容易让分析者误判为异常退出 + 真重启。

**修复方向**（不在 plugin 层）：
- **首选 · pion-ipc Go**：SIGTERM 路径走优雅退出，把 `context.Canceled` 视为已知关闭原因，exit 0；不要打 ERROR 级 service 退出 log
- **备选 · pion-node**：spawn pion-ipc 时放进独立进程组（`detached: true` / 设 `setpgid`），避免 OS SIGTERM 群发波及子进程，由 pion-node 主动按节奏 stop
- plugin 层无更优解——已在 stop hook 内 await `ipc.stop()`，无法更早抢救（被 OpenClaw gateway shutdown 触发时机决定）

**预存问题**：非 plugin 自身 bug，不在本仓库修；plugin 作为下游观察者跟踪上游修复。

## 自动升级与 OpenClaw 插件 hub 形成双源（hub 上线前必须决策）

**发现日期**：2026-05-09（pre-hub release 设计 review）

**锚点**：
- `src/auto-upgrade/updater.js:269` `scheduler.start()`
- `src/auto-upgrade/updater.js:218-220` 唯一 opt-out（`OPENCLAW_NIX_MODE=1`）
- `docs/auto-upgrade.md` 立项动机段落：上游当时无 plugin hub

**问题**：插件每小时自检 npm + spawn worker 改 `openclaw.json` + 触发 gateway restart，这套是在"OpenClaw 没有 plugin hub"前提下设计的。发到 hub 上线后，hub 自己也管版本（清单、签名、灰度、回滚），plugin 还自带升级逻辑就形成两个升级源：hub 装 v0.21、plugin 半小时后又自己升到 v0.22；用户在 hub 端禁掉某版本，半夜 plugin 又把它装回来；hub 想灰度时 plugin 越权改 `openclaw.json`。当前唯一 opt-out 盯的是 nix 环境，识别不到 hub 装机。

**触发场景**：hub 接管插件分发；用户在 hub 端禁用/锁定某版本；多设备同步要求版本一致；企业管理员锁版本。

**修复方向**：
- 默认行为改为 opt-in（设置开关或 env），hub 装机路径下默认关；npm 直装可保留默认开
- 现有 `source==='npm'` 判定不足以区分"hub 装"vs"npm 直装"，需要 OpenClaw 上游补 install source 字段（`hub` / `npm` / `path` / `archive`）
- 这是发布到 hub 前的**前提级决策**——保留 / 让位 / 改 opt-in 必须先选一条，不是发布后小修

**严重度**：Block release（双源会在 hub 上线第一天就打架）

## 大文件上传接收侧无内存上限（最坏可打崩 gateway）

**发现日期**：2026-05-09（pre-hub release 设计 review）

**锚点**：
- `src/file-manager/handler.js:648-778` `receiveUpload` 内 `pendingQueue.push()`
- push 前无长度 / 字节水位检查；仅在 error / abort 路径清空

**问题**：UI 经独立 file DC 上传时，进来的二进制块先入内存队列 `pendingQueue`、再由 `drainLoop` 异步刷盘。声明上限 1GB，但中间无内存水位封口——磁盘慢/卡盘时队列持续堆积，最坏打爆 gateway 进程内存把整个 OpenClaw 拖崩。

**触发场景**：公网用户群里慢盘 / WSL / 杀毒扫描插一脚 / 老硬件并不罕见，撞概率不低；不需要恶意构造。

**修复方向**：
- 给 `pendingQueue` 加内存字节水位（HWM/LWM）：超 HWM 暂停 ack DC 数据帧、磁盘追上后再放行
- 与 UI 端约定一套"接收侧反压"信令帧（当前 file DC 没有这一层）
- 极端时直接拒绝继续接收（reason=receiver-busy）让 UI 重试

**严重度**：Block release（公网用户群有真实概率把 gateway 打崩）

## realtime-bridge 是 1700 行的上帝模块

**发现日期**：2026-05-09（pre-hub release 设计 review）

**锚点**：
- `src/realtime-bridge.js`（1693 行，单 class `RealtimeBridge`）
- 同时承载：双 WS 桥接 + WebRTC 信令路由 + 设备握手 v3 + server/gateway 双心跳 + 退避重连状态机 + agent run lag 探针 + 插件事件广播 + UI→gateway 请求路由表 + run-event 路由表 + rpc-queue 启动期清理钩子 + bind 后 token 撤销

**问题**：单类承载十多组互不相关的状态字段，后果有三：1）改一处牵动其他状态机——TODO 中 listener-async / restart 串行化 / pre-handshake send-fail / connect-timer / lazy init race 等多条都源自此模块；2）任何子系统的测试都要先把整套 mock 起来；3）后来人理解成本高，docs 必须额外写"双 WS"+"三种连接状态"+"三张路由表"才能讲清。是模块边界过粗的设计债。

**触发场景**：每次需要在 bridge 内修 bug 都暴露。

**修复方向**：
- 发布前最低线：明确划分"哪些函数是导出的稳定 API、哪些是内部"——避免 hub 版被外部依赖把内部细节锁死
- 中期：切出 2 个能独立测的子模块（gateway-ws 握手机 + lag-probe / WebRTC 信令路由器）
- 越拖代码越粘合越难拆；当前测试覆盖率已稳，是动手好窗口

**严重度**：Should fix（不阻塞发布，但是长期负担）

## 占位/已停用代码会随 npm 包发到 hub

**发现日期**：2026-05-09（pre-hub release 设计 review）

**锚点**：
- `src/webrtc/ndc-preloader.js`（旧 node-datachannel 路径，依赖已摘除，运行不命中）
- `src/transport-adapter.js` + `src/message-model.js`（"未来通过 channel outbound 收发消息"的预留适配层，主路径不经过）
- `src/channel-plugin.js:42-51` `outbound.sendText` 占位 + `status.defaultRuntime.running: true` 写死
- `package.json` `files` 字段为 `src/**/*.js`，会把上述一并发到 npm

**问题**：
1. 包体增大、装机时间略长
2. OpenClaw 未来给 channel outbound 加 schema 校验时，这些占位会变成噪音报错源
3. `outbound.sendText` 返回 `coclaw-${Date.now()}` 形式 messageId——上游真接通那天会被识别为"成功投递但不可追溯"，比明确的 `not-implemented` 错误更难排查
4. `status.defaultRuntime.running: true` 写死，admin 看到永远绿、掩盖 bridge 真实状态

**修复方向**：
- 删 `webrtc/ndc-preloader.js`、`transport-adapter.js`、`message-model.js` 及对应测试（`docs/architecture.md:172-178` 已标"别花时间读"）
- `channel-plugin.js` 保留但 `sendText` 改成显式 throw `not-implemented`（含 error code）
- `status.defaultRuntime.running` 接到 bridge 实状态（singleton 启动且 server WS alive）

**严重度**：Should fix（hub 发布前清干净一波，避免噪音随包扩散）

## `--link` 双实例陷阱在桥接层与其它 module-level 单例上未系统排查

**发现日期**：2026-05-09（pre-hub release 设计 review）

**锚点**：
- `docs/gateway-method-conventions.md:66-93`（双实例陷阱原理说明）
- `src/realtime-bridge.js` module-level `let singleton`
- `src/runtime.js` 单例、`src/plugin-version.js` 缓存等其他 module-level 状态点

**问题**：CLAUDE.md 已明确 `--link` 模式下 hook 与 RPC handler 跑在不同 ESM 实例。`topic-manager` / `chat-history-manager` 已用"磁盘中转"覆盖，但 `realtime-bridge` 自己是 module-level singleton——hook 路径与 RPC 路径分别 import 时会拿到两个 singleton。当前没出事是因为没人在 hook 里调 bridge 导出函数；**没有显式的隔离审查清单**，"现在没用就没问题"在公网发布版本里风险不可控。

**触发场景**：未来给 plugin 加新 hook（`session_start` / `resume` / `lifecycle:end` / 任意 `api.on`）时调用 bridge 模块导出函数。

**修复方向**：
- 把所有 module-level 单例（`singleton` / `runtime` / 缓存）盘一遍标"link-safe / link-unsafe"清单
- link-unsafe 的导出函数加注释提示"不要在 hook 路径调用"
- 或把所有跨 hook/RPC 共享状态强制走"磁盘中转"模式

**严重度**：Should fix（埋雷，日后加 hook 时容易踩）
