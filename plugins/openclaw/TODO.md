# Plugin TODO

## RPC handler 错误响应 `err.message` 透传可能泄露内部细节

**发现日期**：2026-05-15（D1 model-default deep-review 时识别）
**关联**：`plugins/openclaw/src/provider-auth/handlers.js` + `plugins/openclaw/src/model-default/handlers.js`

**问题**：handler catch 块里直接把 `String(err?.message ?? err)` 当作 RPC error message 透传，路径 / 内部函数名 / 栈片段可能随之外泄到 UI / server / 远端 log。具体调用方：

- provider-auth/handlers.js setApiKey / list / remove 三个 method 的 IO_FAILED 路径
- model-default/handlers.js set / list 的 IO_FAILED 路径

**为什么本期未一并修**：项目级遗留问题——provider-auth 同款，按"review 仅修本次引入"原则不动；同时 message 透传对开发者排错有用，纯遮蔽掉信息密度会下降。需要"分级脱敏"方案（如：识别 stack-like 片段才剪 / 白名单 message 字面量），不是单点改动。

**修复方向**：

- 在两处 helper（`respondIoFailed` / provider-auth 的同款）里加 message 净化：剪掉绝对路径、文件名、stack frame；保留前 N 字符的人类语义
- 或引入 plugin 级 "outbound error sanitizer" 集中处理；同步给 server 远端 log 也走一遍
- 实施前评估对调试体验的影响

---

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

## auto-upgrade state read-modify-write 缺跨进程互斥（预存）

**发现日期**：2026-05-02（rpc-dc-stage1 C 阶段维度 3）
**关联**：plugins/openclaw/src/auto-upgrade/state.js（addSkippedVersion / updateLastCheck / updateLastUpgrade）+ updater.js（__reportLastUpgradeResult）

**问题**：parent (gateway) 和 worker (独立进程) 都会 read-modify-write `upgrade-state.json`。CLAUDE.md 强约束 "read-modify-write 必须 mutex"，但进程内 mutex 跨进程无效。当前靠 `isLocked` 守门挡住绝大多数并发（worker 跑期间 parent skip check），但极小窗口（worker spawn 与 lock 写入之间、stale lock 强制清理时）仍有理论丢字段风险。

**影响**：实测从未发生——窗口极窄、最坏后果是 lastCheck/lastUpgrade 丢一次记录、自然恢复。无数据损坏（atomic 写已保证）。

**修复方向**：用文件级 advisory lock（如 `proper-lockfile` 或 flock）保护 read-modify-write 段。改动跨进程协议，影响面大；当前接受现状，标 TODO 提示长尾。

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

- **activeEnrollAbort 提前 set**（`index.js` enroll handler，预存；2026-05-24 评估）：`enrollClaw()` 同步抛错时 controller 残留，下一次 enroll 进来时 `cancelActiveEnroll` 会对死 controller 多 log 一行 "cancelling active enroll"。**仅日志噪音、无功能影响**（abort 一个无人 listen 的 controller 是 no-op）。2026-05-24 走过两轮补丁（defer 赋值 / early-set + catch identity guard），均不可靠且都被 revert：defer 削弱"第二次 enroll 立即取消第一次"语义、catch guard 是补丁式拼接。**根本方案**应是让 `enrollClaw` 自身消费 signal 并透传到 fetch，但窄窗口救一点的收益小、上层 CLI/gateway/server 三端语义需先讨论清楚，遂不立刻做；等下次有动机时一并设计。
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

### auto-upgrade vs claw-paths 部分注入不对称（防御性，本次新引入但不可达）

**锚点**：`plugins/openclaw/src/auto-upgrade/state.js:23-30` vs `src/claw-paths.js:24-29`

**问题**：runtime 是非空对象但 `runtime.state` 缺失这种"部分注入"形态下，claw-paths.js 抛错而 auto-upgrade/state.js 静默 fallback env/homedir，同一进程可能写到不同 state-dir。生产路径不可达（index.js 只在 full mode 调 setRuntime + 上游 runtime 形态固定），属防御性。

**修复方向**：auto-upgrade/state.js 加守卫——发现 runtime 对象存在但 .state.resolveStateDir 缺失时，与 claw-paths.js 行为对齐（抛错或委托给 clawStateDir）。

### session-manager 散落 c8 ignore 多条可补测（PRE-EXISTING 噪音）

**锚点**：`plugins/openclaw/src/session-manager/manager.js` 行 55 / 133 / 138 / 170 / 176 / 183 / 189 / 193 / 250 / 339

**问题**：多处裸 `c8 ignore next` 或简单 `?? fallback` 注释覆盖了可测的默认构造、malformed 内容、无效 index 条目、分页边界等分支。逐条补针对性测试可摘 ignore；与本次 claw-paths 改造无直接关系。

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

## sessions RPC handler 层缺独立测试（预存）

**发现日期**：2026-05-11（session-manager streaming jsonl deep-review）
**关联**：`src/index.js` 内 `coclaw.sessions.getById` / `nativeui.sessions.get` / `nativeui.sessions.listAll` 注册处

**问题**：当前 manager 层（`src/session-manager/manager.js`）有完整单测，但 plugin 通过 `registerGatewayMethod` 暴露给 server / UI 的 RPC handler 入口只验证了"已注册"，没覆盖：成功路径返回结构、参数缺失走 `respondInvalid`、manager 抛错时走 `respondError` 的 wrapping 行为。

**为什么本次未一并修**：与本次 streaming 改动无关；handler 层缺口在 manager 改造之前就存在，属预存测试缺口。

**修复方向**：在 `src/index.test.js` 或独立 `src/session-rpc.test.js` 内通过 `registerGatewayMethod` spy 调用各 handler，三类路径各覆盖一条。

**严重度**：Low（manager 层断言已经把核心行为锁住；handler 是薄包装，回归概率低）

## session-manager 既有测试断言不严（预存）

**发现日期**：2026-05-11（session-manager streaming jsonl deep-review）
**关联**：`src/session-manager/manager.test.js` 的 `getById - limit 限制返回最后 N 条`、`listAll/get should normalize bad inputs and missing dirs`

**问题**：
- `getById limit` 用例只断言首尾两条 message 的 content，中间消息错位/重复无法被发现。
- `normalize bad inputs` 用例靠超大 cursor 让 get 直接返回空页，旧 split 路径与新流式路径都会 pass，并未真正验证解析结果。

**为什么本次未一并修**：本次 streaming 用例已加完整顺序断言保护新路径；这两个既有用例的弱断言是 streaming 之前就有的，属预存。

**修复方向**：把首尾断言扩展为遍历所有 message 内容核对；`normalize` 用例增加一条"正常 cursor + 解析后内容正向核对"的断言。

**严重度**：Low（manager 层主流程已被新增的"跨 yield 阈值"用例 + 既有 CRLF 用例覆盖，弱断言用例属补强项）

## await 让出窗口下 connId 复用 → response 投递到新 session（预存架构问题）

**发现日期**：2026-05-11（session-manager streaming jsonl deep-review，codex-rescue R2 抓出）
**关联**：`src/realtime-bridge.js:1091`（`__dcPendingRequests.set`）、`src/realtime-bridge.js:895`（`sendTo` 投递）、memory `feedback_async_orphan_operation_pattern`

**问题**：UI 转发 RPC 路由表 `__dcPendingRequests` 只记 `reqId -> connId`。任何 RPC handler 内部 await 让出（含本次每 100 行的 setImmediate、旧的 `await fsp.readFile` 等）期间，同一 `connId` 可能被一个新建的 WebRTC session 复用——handler 跑完调 `sendTo(connId, payload)` 时会把旧请求的 response 投到新 session 的 DC。极端窗口里可能造成"答非所问"。

**为什么本次未一并修**：本次 streaming 改动**不放大风险量级**——旧 `readFile` 已经创造让出窗口；让出频率从"1 次/调用"提到"N 次/调用"但单次窗口仍是毫秒级，总暴露面积≈总耗时基本不变。问题本质是路由表缺 session 代数（generation）/ session 替换时未清表，是架构层预存问题。memory 已有 async-orphan 模式记录但治本方案未定。

**修复方向**：路由表存请求时同时记录"session 代数"标识；`sendTo` 前对比当前映射的 session 是否仍是发请求时那个，不匹配直接丢弃。或在 connId 对应 session 关闭/替换时主动清空该 connId 下所有 pending reqId。

**严重度**：Low（窗口窄、复用条件苛刻；但要根治需要架构层改动，纳入 async-orphan 治本方案讨论）

## webrtc-peer.test.js 2390 既有弱断言（预存）

**发现日期**：2026-05-11（信令串行化 per-connId deep-review，codex 测试 review 抓出 H1）
**关联**：`webrtc-peer.test.js` "ICE restart 复用现有 PC" 测试，line ~2390

**问题**：测试断言 `firstPc.setRemoteDescription.__called === undefined`——mock PC 从未定义 `__called` 属性，恒为 `undefined`，等于 `assert.equal(undefined, undefined)`，恒真。即便 SRD 完全没被调用也能通过。

**为什么本次未一并修**：与本次信令串行化无直接关系；该断言在 mutex-时代就已经是无效断言，属预存测试缺口。

**修复方向**：把 mock 的 `setRemoteDescription` 改成包装版（如 `mock.fn()` / 计数 wrapper），断言调用次数大于 0；或断言"setRemoteDescription 收到了 ICE-restart offer 的 sdp"等真实可验证的副作用。

**严重度**：Low（测试整体场景已被旁路断言覆盖——`PC.instances.length === 1`、`sent[0].type === 'rtc:answer'` 等仍保护核心行为）

## OpenClaw issue #80697 本地补丁需在上游修复后撤销

**发现日期**：2026-05-14（用户笔记本 chat 打开慢的排查）
**关联脚本**：`scripts/patch-openclaw-issue-80697.sh`
**上游 issue**：[#80697](https://github.com/openclaw/openclaw/issues/80697)
**研究文档**：`docs/openclaw-research/plugin-manifest-cache-mismatch.md`

**问题**：OpenClaw `getStatusSummary.buildSessionRows` 调用链不传 `workspaceDir`，进程级 plugin manifest snapshot cache 永久 mismatch，导致 `status / sessions.list / models.list / topics.list` 在 session 数多时每次卡 ~10-20s。CoClaw UI 启动 / RTC 重连时 `dashboard.store` 并发拉这几个 RPC，主线程被吃满，用户体验"点 chat 半天没数据"。

**已落地的本地 workaround**：`scripts/patch-openclaw-issue-80697.sh` 在 bundled dist `manifest-model-id-normalization-*.js` 的 `loadManifestModelIdNormalizationPolicies` 加 60s 进程级 fallback cache。实测笔记本 (758 sessions) `status --json` 从 20.5s → ~7s。

**OpenClaw 升级时的动作**：bundled dist 重生成、文件 hash 后缀会变（vite/rollup 输出）。脚本会自动定位新文件、检测幂等。但**升级版本如果改动了源码结构**（如重命名 `loadManifestModelIdNormalizationPolicies` 或调整 anchor 行），脚本会以 `[FAIL] 没找到 anchor` 退出，需要重对照研究文档调整 anchor 模板。

**撤销条件**：上游已修——#80697 转为 #78461 跟踪，PR #82814 已合入 main（2026-05-17）并随 `v2026.5.20`（2026-05-21）起释出。升 OpenClaw 至 ≥ `2026.5.20` 即可彻底退役本补丁：npm 全局升级会全量覆盖 dist，patch 和 `.bak` 一并消失，无需也无法跑 `--revert`。撤销后清理：删脚本 `scripts/patch-openclaw-issue-80697.sh` + 研究文档 `docs/openclaw-research/plugin-manifest-cache-mismatch.md` + 本条 TODO。仅当不升级 OpenClaw 但想撤回手工 patch 时，才用 `./scripts/patch-openclaw-issue-80697.sh --revert` 从 `.bak` 恢复。

**对终端用户的部署形态（尚未实施）**：当前脚本只在 CoClaw 仓库内，不会随 npm plugin 安装自动应用。若上游迟迟不修，可考虑：(a) 在 plugin `postinstall` 钩子里跑该脚本（但触碰用户 OpenClaw 安装目录有侵入性、需明确告知）；(b) 写到 `docs/troubleshooting.md` 让遇到同类问题的用户自助；(c) 维持现状，仅作为维护者排查手段。当前选择 (c)。


---

## bind rebind 测试的 mock `rebound: false` 与测试名不一致

**发现日期**：2026-05-16（Phase B 去 wrap 改造 deep-review codex-rescue B 实例识别）
**关联**：`plugins/openclaw/src/cli-registrar.test.js:168-184` `bind CLI should show previousClawId when rebinding`

**问题**：测试名暗示是 rebind 场景，但 mock 给的 `rebound: false`——`bindOk` 渲染时走 'bound' 分支（非 're-bound'），跟测试名传达的"rebind"语义对不上。当前测试仍通过是因为只断了 `previous Claw` 字符串（在 previousClawId 非空时永远出现，与 rebound 无关）。

**预存性**：本次改造未触碰这个测试逻辑，是原本就存在的测试设计混乱。

**修复方向**：

- 改 mock 给 `rebound: true` 让 fixture 跟测试名对齐
- 或重命名测试名为 `bind CLI should show previousClawId when given` 描述 previousClawId 处理本身（不绑定 rebind 语义）

---

## cli-registrar.test.js 没覆盖 JSON-shape gateway error 输出（已核实不存在）

**发现日期**：2026-05-16（Phase B 去 wrap 改造 deep-review codex-rescue B 实例识别）
**关联**：`plugins/openclaw/src/cli-registrar.test.js:26-29` `createRpcSpawn` error 路径

**结论**（2026-05-16 Phase C 核实关闭）：
经查阅上游 `openclaw-repo/src/cli/gateway-cli/register.ts:416-431` 的 `gateway call` 实现 + `runGatewayCommand` catch 链 + `defaultRuntime` (`openclaw-repo/src/runtime.ts:88`)：
- 成功路径：`defaultRuntime.writeJson(result)` → `JSON.stringify(result, null, 2)` 写 stdout
- 失败路径：`runGatewayCommand` catch → `defaultRuntime.error('${label}: ${message}')` → **console.error / stderr** + `exit(1)`

stdout 不会出现 JSON-shape 错误对象，C3 原始担心的形态不存在。无需补 fixture。

---

## helper chunk 边界检测在 pretty-print JSON 多 chunk 到达时可能误判

**发现日期**：2026-05-16（Phase C 核实 C3 时顺手识别）
**关联**：`plugins/openclaw/src/common/gateway-notify.js:107-113` chunk 监听 + `startGracePeriod`

**问题**：`child.stdout.on('data')` 累积 stdout 后判 `trimmed.startsWith('{') && trimmed.endsWith('}')` 即触发 `startGracePeriod()`；后者**同步调用 `parseResult()`** 并把结果钉死到 closure 里。

上游 `openclaw gateway call --json` 实际输出的是 pretty-printed JSON（缩进 2）。若 payload 含嵌套对象、且 stdout 分多 chunk 到达，**中间某次累积可能恰好在嵌套对象闭合的瞬间满足 startsWith/endsWith**——此时 stdout 整体仍是不完整 JSON，`JSON.parse` 抛、`parseResult` 退化到"非 JSON 兜底"返回 `{ ok: true }`（无 payload）。

**当前严重性**：低——
- 小 payload（bind/unbind/enroll 返回都 <300 字节）通常一次 chunk
- C1 已让 bindOk/unbindOk 容忍 undefined，触发后只是输出 `Claw (unknown) ...`，不再 crash
- 但 `setApiKey` 的 `apiKeySetOk({ provider, profileId: data?.profileId ?? '${provider}:default' })` 等其它 CLI 已经用 optional chain 兜底

**预存性**：与 Phase B 改 wrap 字段名无关，是 helper 自身的 chunk 边界处理设计缺陷，旧版同存在。

**2026-05-16 Phase D 失败尝试**（已回退）：曾以"推迟 `parseResult` 到 grace timer fire 时"修复（commit `e981fd3`），红测覆盖 nested 假闭合场景验证通过。但事后周边分析发现场景 E 退化——"chunk1 完整 JSON + chunk2 在 grace 内追加 stdout"（OpenClaw 子进程 WS 心跳 log / grace shutdown 提示等若落 stdout 即触发）原本由"快照锁定"返回成功 payload，修后变成 timer fire 时用被污染的 stdout 解析、落非 JSON 兜底丢失 payload。已回退该修复（.js 改动 + 红测 + 对应 changeset）。

**修复方向**（按周边影响排序）：

- **推荐**：在 startsWith/endsWith 触发 `startGracePeriod` 时**先尝试 `JSON.parse(stdout)`**，仅解析成功时启动 grace timer 并**钉死 snapshot**；失败则不启动 timer、等更多 chunk。此修法对全部 A/B/C/D/E 场景都不差于原行为，且顺手闭合"nested 假闭合 + chunk 在 grace 期外才到"边缘
- **不推荐**：推迟 `parseResult` 调用到 grace timer fire 时（已尝试 + 回退，详见上面失败尝试段）
- **不推荐**：移除早判、纯靠 `child.on('close')` 触发 `parseResult`——会让"永不优雅退出的子进程"等到总超时 10s 才返回结果，破坏 helper 当初引入 grace 期的设计意图

**实施前提**：写测试时务必同时覆盖场景 C（nested 假闭合 + grace 内补全）与场景 E（完整 JSON + 后续 chunk 追加），防止再次单面修法。

---

## patch 脚本健壮性补强

**发现日期**：2026-05-16（Phase D deep-review codex-rescue D 实例识别）
**关联**：`plugins/openclaw/scripts/patch-openclaw-issue-80697.sh`

**问题**：
- 脚本第 185 行用裸 `writeFileSync`，无 rename 原子写——半截写崩溃会留破损文件
- 第 109 行 usage 提到支持 `OPENCLAW_DIST` 环境变量，但 `find_openclaw_dist` 实际未读该 env
- rollback 仅在第 193 行的语法检查失败后触发；语义错误（patch 写错位置但 node 仍能 parse）会直接生效
- 无 OpenClaw 版本号 guard——升级后哨兵残留可能让 patch 静默跳过
- 无 `--dry-run` / `--verify` 模式

**严重性**：低——脚本是手动运行的 workaround；sentinel 提供基本幂等；有 `--revert` 入口。可在用户实际遇到升级失配时再补强。

**修复方向**：
- atomic write：`writeFileSync(tmp); rename(tmp, target)`
- 实现 `OPENCLAW_DIST` 读取
- 加 trap EXIT 兜底 rollback
- 哨兵字符串嵌入 OpenClaw 版本号，升级后哨兵失配触发 re-patch

---

## provider-auth 测试组合不足

**发现日期**：2026-05-16（Phase D deep-review codex-rescue B 实例识别）
**关联**：`plugins/openclaw/src/provider-auth/handlers.test.js`

**问题**：测试用例都是独立 stub，缺端到端连用场景：
- set → list 状态轮转（验证 set 完真的能在 list 里看到）
- remove → list 消失（验证 remove 完真的从 list 消失）
- 同一 profileId 并发 set（验证 SDK 锁正确性）

**严重性**：低——单点行为已覆盖；组合场景由 SDK 自身测试兜底。

**修复方向**：补三个 fixture，用真实 SDK helper（非 mock）跑一遍。

---

## model-default 测试 fixture 不真实

**发现日期**：2026-05-16（Phase D deep-review codex-rescue A 实例识别）
**关联**：`plugins/openclaw/src/model-default/persist.test.js:186-218` + `handlers.test.js:163-187 / :274-295`

**问题**：
- `persist.test.js:186-218` 清除单 agent override 的 fixture 初态不含 global default，与生产实态不符
- handlers.test.js set 和 list 各自独立调用，无 set → list 端到端串联

**严重性**：低——单点行为已覆盖；端到端有 cli-e2e-verify.sh 兜底。

**修复方向**：补两个 fixture：① 带 global default + 单 agent override 的初态，执行清除 agent override，验证 default 保留；② set handler → list handler 串行调用，验证状态同步。

---

## chat-history：孤儿 session 恢复时同 sid 可能在 list 中重复出现

**发现日期**：2026-05-17（chat-history 双源归档第二轮 deep-review R1 识别，pre-existing）
**关联**：`plugins/openclaw/src/chat-history-manager/manager.js:163-172`

**问题**：当 list 的 head 已归档（即没有未归档活跃头），传入的 `currentSessionId` 又恰好等于 list 中某条已归档项的 sessionId（孤儿 session resume 场景），`recordSessionTransition` 会走到一般路径 → 直接 `unshift({ sessionId: currentSessionId })` → 同一 sessionId 在 list 中出现两次（首位未归档 + 中间已归档）。

**严重性**：低——本轮双源归档化重构没有引入也没有加剧；仅在用户主动恢复一个早已归档的 session 后再次落到该路径才出现；list 是用户可见的 chat-history 索引，重复项会让 UI 出现一个孤儿 + 一个当前同 sid 的视觉重复，但功能不挂。

**修复方向**：
- `recordSessionTransition` 一般路径加 dedupe：unshift 前若 list 中已存在 `currentSessionId === currentSessionId` 的项，先 splice 掉那条已归档项再 unshift（保留时间戳？放弃归档时间？需想清楚）
- 或在 list RPC 出口对重复 sessionId 做 dedupe（保留 head，丢弃后面的）
- 配合一条 manager.test.js 的 T14 测试钉死该路径

**更新**（2026-05-17 第三轮 review M1 修复）：`recordSessionTransition` 已加入 stale 事件防御——`currentSessionId` 已存在于 list 任意位置时直接丢弃事件（manager.js 一般路径前的新增分支 + 测试 T14）。该防御覆盖了上述重复场景：resume 旧 session 本身不触发 `session_start` hook / `sessions.changed`（OpenClaw 上游 resume 不创建新 sid），但万一上游演进出 resume 也 emit 的路径，stale 防御会让 history 保持不变（而不是错位翻 head 制造重复）。本条 TODO 可视为已消解，保留以备追溯。

---

## chat-history 双源归档 follow-up F1：topic 模式与上游 sessions 体系的实际关系

**发现日期**：2026-05-17（第三轮 review 用户问询）→ 2026-05-17 二次调研修正
**关联**：`plugins/openclaw/index.js#handleSessionCreated` 的早返 guard、`plugins/openclaw/src/realtime-bridge.js` sessions.changed 分支

**原命题**（已被推翻一半）：topic 模式（`agent({ sessionId: <uuid> })` 不传 sessionKey）时 OpenClaw 完全不写 sessions.json、不 fire session_start、不 emit 任何 sessions.changed。

**调研结论**（精确到上游源码行）：

| 子命题 | 实际真相 | 上游锚点 |
|---|---|---|
| 不写 sessions.json | ❌ 不成立 | 内层 runner 在 `agents/command/session.ts:277-282` 用 `buildExplicitSessionIdSessionKey` 把 sessionId 伪造成 `agent:<agentId>:explicit:<sessionId>`，跑完后 `agent-command.ts:1241-1262` 走 updateSessionStore 写进 sessions.json |
| 不 fire session_start hook | ✅ 成立 | `emitGatewaySessionStartPluginHook` 在 agent.ts 全文无调用，仅 `session-reset-service.ts:680` + `sessions.ts:1326` 触发 |
| 不 emit sessions.changed | ❌ 部分不成立 | gateway 层 reason=create/send 守卫 `requestedSessionKey` 严，topic 跳过；但 transcript-update 链路（`config/sessions/transcript.ts:316` → `server-session-events.ts:107,153-165`）仍发 `sessions.changed { phase: "message" }` 事件，**无 reason 字段** |

**澄清 CoClaw 自身有没有"fake sessionKey"**：
- UI `ui/src/stores/chat.store.js:607-611`：topic 模式只设 `agentParams.sessionId`，**不设 sessionKey**（grep 全仓未找到任何 fake sessionKey 概念）
- UI→plugin 现走 WebRTC DC 直通（不经 server；server `claw-ws-hub.js` 那条 forwardToClaw 链路是废弃旧路），plugin 端拿到的 params 与 UI 发出时一致
- Plugin topic-manager 不参与 agent RPC 调用，只管 topic 元信息
- 所以 `agent:<id>:explicit:<sessionId>` 是**上游内层 runner 自造**的，CoClaw 全链路看不到（也不该看到）

**对 plugin 自身的影响**：**无**。两条防线刚好都挡得住：
- hook 路径：上游不 fire session_start，plugin 收不到
- sessions.changed 路径：plugin 在 `realtime-bridge.js:875` 严格判 `reason === 'create'`，topic 的 transcript-update 没 reason 字段，被过滤掉

**外溢副作用**（plugin 改不了，归上游设计）：
1. OpenClaw 自家 sessions.json + sessions list（webchat/dashboard）会被 topic 的 `agent:*:explicit:*` 历史 entries 占位污染
2. 上游 `sessions.changed` 事件复用同一频道发 `phase=message` 但**不带 reason 字段**——区分 reason 类型只能靠 reason 是否存在

**关于 explicit sessionKey 行为的引入时间**（2026-05-17 git archaeology）：

| 项 | 值 |
|---|---|
| 引入 commit | `cd36ff7483`（`fix: resume explicit session-id agent runs`，Peter Steinberger） |
| 日期 | 2026-04-04 |
| 首个含此 commit 的上游 tag | `v2026.4.5` |
| 动机 | 让 `openclaw agent --session-id <uuid>` 跑完后**能再次 resume 同一 sessionId**——必须有一个稳定 sessionKey 才能 store-and-lookup |
| 引入前行为（v2026.4.5 之前） | `agents/command/session.ts:149` 父节点版本：sessionId-only 时 `sessionKey=undefined`，下游 `agent-command.ts:540` 写盘守卫 `if (sessionStore && sessionKey)` 直接跳过——**sessions.json 不写** |
| caller opt-out | **无**——grep `persistExplicit` / `skipExplicitPersist` / `ephemeral.*session` 全无命中；`updateSessionStoreAfterAgentRun` 也无 opt-out 参数 |
| 兜底机制 | 通用 `session.maintenance.pruneAfter`（默认 30 天）+ `maxEntries`（默认 500），见 `src/config/sessions/store-maintenance.ts:20-21`；cron `session-reaper.ts` 执行。**不针对 explicit** |

**用户回忆得到验证**：CoClaw 最初支持 topic 时（早于 2026-04-04），sessions.json 不会因 topic 流量膨胀。当前 gateway 2026.5.7 已带 explicit 逻辑，且上游没开 caller flag 让外部 plugin 关掉。

**膨胀风险评估**：
- 重度 topic 用户：每 topic 一条 entry，长期累积；通用 maxEntries=500 触顶后 LRU 裁剪，不会无界膨胀，但 entry 周转会让"老 topic 突然恢复不出来"
- 轻度 topic 用户：30 天 prune 兜底足够

**可能的根治方向**（按代价从低到高）：
- (A) **等上游加 opt-out**：去上游提 issue / PR，给 agent RPC 加 `persistExplicit: false` 或类似 flag —— 受益面广，但周期长
- (B) **CoClaw 端调小 maintenance 上限**：通过 OpenClaw config 把 `session.maintenance.maxEntries` 压到更小（如 50）—— 治标但会牵连所有 session，可能误伤
- (C) **CoClaw 自管 topic transcript**：放弃用 OpenClaw 的 sessionId 体系驱动 topic transcript 写入，plugin 自己维护 topic .jsonl 不调上游 agent RPC —— 重构成本高，且失去上游 model 调用便利
- (D) **被动接受现状**：上游兜底机制能 capping，UX 上"老 topic 续不上"接受为已知行为

**待办**：
- [x] 此节内容并入 task #11 上游 issue 草稿（已记录在本 TODO 节）

**待办**：
- [x] CLI 实验交叉验证（2026-05-17）——结果完全命中预期：chat-history.json sha256 不变；sessions.json 新增 `agent:main:explicit:d623247e-4d48-4e0c-84ef-f79b1461d966` entry（71→72）；plugin 日志无 chat-history.missing-keys 或任何 handleSessionsCreated（旧名，5125818 重命名前的实验日志，现名 handleSessionCreated）相关 warn（reason='create' 严判完全静默 phase=message 流量）
- [x] 上述两个外溢副作用纳入上游 issue 草稿（2026-05-23）——草稿写在 `docs/upstream-issues/explicit-session-key-opt-out.md` + `docs/upstream-issues/sessions-changed-message-reason-field.md`（整目录 gitignored，draft-only 约定见该目录 README）；提交 GitHub 后登记到 `docs/openclaw-upstream-issues.md` 并删除本地草稿
- [ ] 多 agent topic 启用后复评：F1 实验只钉死了"main agent topic 路径不破"，若 CoClaw 解开 UI `chat.store.js` topicMode 分支让非 main agent 也能新建 topic（参考 `docs/decisions/topic-main-agent-constraint.md` §"2026-05-17 重评"），需要复跑实验验证非 main agent 的 explicit fake sessionKey 路径同样不撞穿 `reason === 'create'` 严判，并核查 chat-history 桶不被污染

---

## chat-history 双源归档 follow-up F2：核实 agent sessions 目录判定的覆盖配置

**发现日期**：2026-05-17（第三轮 review 用户问询）→ 2026-05-17 二次调研修正
**关联**：`plugins/openclaw/src/claw-paths.js`

**原命题**（已被推翻一半）：CoClaw 没接住 `agents.<id>.store` / `entry.sessionFile` 两个覆盖入口。

**调研结论**（精确到上游 schema）：

- **`agents.<id>.store` 字段根本不存在**——`openclaw-repo/src/config/zod-schema.agent-runtime.ts:889-961` 的 `AgentEntrySchema` 里没有 `store` 字段；之前的 follow-up 描述把这个字段当真存在，是认错对象
- 真正的旋钮是顶层 **`session.store`**（`zod-schema.session.ts:54` 定义为 `z.string().optional()`），支持绝对路径或 `{agentId}` 模板替换
- 另一个旋钮是 sessions-index **`entry.sessionFile`**（每 sessionsKey 单独覆盖文件名）
- `claw-paths.js:53` 调上游 `resolveStorePath(store, { agentId })` 时 store 写死 `undefined`，没接住顶层 `session.store`
- `session-manager/manager.js:187` 调 `resolveTranscriptPath(sid, agentId)` 时也漏传 entry，没接住 `entry.sessionFile`
- 上游 runtime API `rt.config.current()`（`types-core.ts:145-148`）已暴露读 `OpenClawConfig.session.store` 的能力，修补不缺 API

**影响范围**：仅当用户在 OpenClaw 配置里显式设置 `session.store` 把存储位置改到非默认目录时，CoClaw 自管文件（`coclaw-chat-history.json` / `coclaw-topics.json`）会落到默认 `<state-dir>/agents/<id>/sessions/`，OpenClaw 自家的 `sessions.json` / 单 session jsonl 落到用户指定位置——两边分家。

**严重性**：低——绝大多数用户走 OpenClaw 默认布局；上游也很少有人配 `session.store`。

**决策**：用户拍板"只记 TODO 暂不修"。

**未来修补方向**：
- `claw-paths.js` 的 `sessionStorePath` 读 `rt.config.current()?.session?.store` 喂 helper
- `session-manager.resolveTranscriptFile` 从 sessions.json 读出 entry 后透传 `entry.sessionFile`
- 加多 profile / 容器场景的 fixture 测试

**注**：AGENTS.md L29 措辞已修正，把 `agents.<id>.store` 改成顶层 `session.store` 并明确标注上游 schema 里没有 `agents.<id>.store` 字段。

---

## chat-history follow-up F4：cron / 其它非 main 形态的产品语义（待斟酌）

**发现日期**：2026-05-18 F3 调研附带（`openclaw-repo/src/sessions/session-key-utils.ts:58-64` `isCronSessionKey`）

**事实**：调研 F3 时发现 OpenClaw 现网除 `:subagent:` / `:explicit:` 之外还存在 `:cron:` 形态（定时任务）。chat-history 当前只挡 explicit / subagent，cron 形态会按普通 chat 入档。

**为什么暂不处理**：cron 形态本质属于"用户人机对话流"（用户配置的定时任务产生的对话），未来 UI 可能要展示这类 chat history。F3 用户原话："对于 cron，暂时也不过滤，这块再斟酌。毕竟也许以后也要展示 cron 这个 chat 的 history。"

**何时需要复评**：

- 若发现 cron 跑很高频导致 chat-history 文件无界增长（类似 F3 闭环前 subagent 的症状）
- 若 OpenClaw 给 cron sessionKey 也加了类似 subagent 的"创建但永不归档"语义，使得未归档头永久滞留
- 若 CoClaw 决定明确"chat-history 只索引用户主动发起的对话"，把 cron / IM 等程序起的也排除

**关联**：`plugins/openclaw/index.js#handleSessionCreated`（守卫位置）+ `openclaw-repo/src/sessions/session-key-utils.ts:58-64`（cron 形态判定参考）

## chat-history follow-up F5：register(mode='full') 热重载下两个 race 隐患

**发现日期**：2026-05-18（任务 #13 opus subagent 调研识别）
**关联 commit**：F3 后续主线验证调研

**背景**：OpenClaw config 热重载（任何 `plugins.*` 配置变更）会在**同进程内**重新走 plugin `register(mode='full')` 流程：
- 入口：`openclaw-repo/src/gateway/config-reload-plan.ts:123` `{ prefix:"plugins", kind:"hot", actions:["reload-plugins"…] }`
- 调度：`server-reload-handlers.ts:281-307` → `server.impl.ts:1131-1227 reloadAttachedGatewayPlugins`（旧 service stop → 新 register → 新 service start）
- loader：`plugins/loader.ts:2363-2368` cache miss → 重跑 `runPluginRegisterSync`

**正常路径安全**：`api.on` / `registerGatewayMethod` / `registerChannel` 走 `replaceAttachedPluginRuntime` 整体替换 registry；`registerService` 显式 `previousPluginServices.stop()` 在前；`realtime-bridge` 模块级 singleton 由 stop() 清空、新 start() 重建——无双实例并存。

**隐患 A — In-flight enroll 跨 reload 残留**：

`coclaw.enroll` / `/coclaw enroll` 的 `waitForClaimAndSave` 是 fire-and-forget 后台任务，闭包持有旧 register 时的 `restartBridge`（仍调模块级 `restartRealtimeBridge`）。reload 时只清新闭包里的 `activeEnrollAbort`；旧闭包仍在跑，认领回来后会把新 register 刚装好的 bridge 杀掉重起，且 `pluginConfig.serverUrl` 是旧 snapshot。

**修复方向**：enroll 闭包检测自身是否仍是 active 闭包（如比对 registration generation token），失活则放弃 restartBridge；或 reload 时显式 abort 所有 in-flight enroll 任务。

**隐患 B — 同源 JSON 文件 per-instance mutex 不互斥**：

reload 瞬间旧 register 的 RPC handler 可能仍在写 `coclaw-topics.json` / `coclaw-chat-history.json`；新 register 同时也能写。两份 manager 各自一套 `__mutexes`，互不相通。`atomicWriteJsonFile` 防半截写，但仍可能整段 JSON lost-update（旧 read → 新 read → 旧 write → 新 write 序列下旧 write 覆盖新内容）。

**修复方向**：mutex 改为基于文件路径的全进程级注册表（同路径不同实例共享同一把锁）；或所有 read-modify-write 改用 `flock` 文件锁；或 reload 时显式 await 所有 in-flight RPC handler。

**严重性**：低——用户主动改 `plugins.*` 配置且改的时机正好撞上 enroll / RPC handler in-flight 才会复现，极偶发。不阻塞当前发布。

## chat-history follow-up F6：chat-history.json 顺序异常实测（2/3 位时间戳倒置）

**发现日期**：2026-05-18（任务 #9 opus subagent 实测发现）
**关联**：`plugins/openclaw/src/chat-history-manager/manager.js#recordSessionTransition` splice 路径

**观测事实**：本机当前 chat-history.json（main agent，`agent:main:main` 键）顺序为：

| 位置 | sessionId | archivedAt | 时间戳含义 |
|---|---|---|---|
| 0 | `8af05d02-…` | 缺（未归档头） | 当前 current（subagent 实测 reset 后） |
| 1 | `21c7bd13-…` | 1777798486453 | 较旧 |
| 2 | `4abc9fc0-…` | 1779039659992 | 较新（被 reset 翻下去的） |

`manager.js` 文档约定"已归档项按归档时间新→旧"，但 1/2 位顺序倒置。

**怀疑**：历史 hook 路径里 `resumedFrom` 与文件 head 不一致时，splice(1, 0, ...) 把"补充归档目标"插在 0 之后但未把已归档的 head 重新排序——导致后续若 head 翻归档+插入新当前，原 head 的归档项被推到 1 位，更早的归档项留在 2 位。

**为什么不立即修**：F6 是观测项，不是阻塞 bug。当前 UI（`chat.store.js:1445-1447` 用 `archivedAt != null` 过滤未归档头）只关心"未归档头 vs 已归档"，不消费已归档项之间的顺序。但 list RPC 契约若被未来 UI 用作"按时间排序的历史索引"，会展示乱序。

**修复方向**：
- 路径一：splice 时按 `archivedAt` 二分插入，保证已归档段单调
- 路径二：list RPC 返回前对 archived 段按 `archivedAt desc` 排序（输入侧不严格，输出侧规整）
- 路径三：把 archived 段排序当作 manager 的 invariant，每次 persist 前重排（影响最小）

**严重性**：低——纯顺序问题，不丢数据；用户也明确表示本机是测试环境，可在 F6 修法决策后回归测试。

## getById 大文件一次性 readFile + 全量解析的内存/CPU 压力

**发现日期**：2026-05-19（getById fallback + 上限修复 deep review 综合实例识别）
**关联 commit**：fix(openclaw-plugin): include .deleted archives in getById fallback and lift 500-message cap

**问题**：`src/session-manager/manager.js` `getById` 拿掉 500 上限后，对几千条消息的长 transcript（可能数十 MB JSONL），`readTranscriptText` 用 `fsp.readFile` 一次性把整个文件读进内存，再 `iterTextLines` 逐行 JSON.parse 出 `messages` 数组，最后才（在传了正 limit 时）`slice(-N)`。即便调用方只想要尾部 N 条，也得先把整个文件 parse 完——内存峰值与 transcript 大小成正比，CPU 上也是无效解析。`iterTextLines` 有 `setImmediate` 让步避免单次 freeze event loop，但累计仍可能拖慢 gateway。

**为什么本期未修**：本次任务 scope 只在去掉 500 上限和 fallback 拓宽。UI 主要痛点已记在 `ui/TODO.md` 同名条目；plugin 侧优化是 UI 选了"传正 limit"路径后才能省的事。

**修复方向**：

- 在 `getById` 检测到 `useLimit === true` 时走"tail-only"分支：从文件末尾分块（如 64KB）反向读，扫到 `limitNum + 1` 条 message 行后停止解析。需要小心处理 CRLF / 跨块行边界。
- 或更激进：JSONL 按行落盘天然支持 tail，用 `fs.read(fd, ...)` + 自己的 line buffer 实现真正的"读够 N 条就停"。
- 暂不动 `get`，因为它走 `cursor + limit` 分页，行为差异更大。

## chat-history 双源乱序 A→B→C race：stale 防御吞掉中间段的归档信号（红测已 skip）

**发现日期**：2026-05-19（cron 顶替止血任务实施前 dump 整理）
**关联**：`plugins/openclaw/src/chat-history-manager/manager.test.js` 末尾 REPRO_LOST_ARCHIVED 用例（已 `{ skip: ... }`）

**现象**：在 A→B→C 三跳快速连翻的极端时序下（两条 `sessions.changed` 先到、两条 `session_start` hook 后到），第三条到达的 hook (current=B, archived=A) 因 currentSessionId 已不再是 list head，命中 `recordSessionTransition` 内的 stale 防御直接 return，**A 这一段从未被任何写盘路径记录**，永久缺失。

**为什么本期未修**：cron 顶替止血只覆盖 user A → cron B 单跳场景（现有"老 head 翻 archived + 新 sid unshift"路径正常工作）；A→B→C 三跳是更深层、独立于 cron 路径的双源 race，修法要重新设计 stale 判定 + 归档信号的去重链路，工作量与 cron 止血不在同一量级。

**修复方向**：让 stale 防御在 `archivedSessionId` 信号上下文中至少补登被漏归档的中间段（即便 head 已翻过）；可能需要在到达 `recordSessionTransition` 时合并 sessions.changed 与 hook 的乱序事件流，而不是直接 return。

**复测**：根因修复后 `unskip` 测试 `recordSessionTransition - REPRO 双源乱序：A→B→C ...`，期望 list = [C, B@arch, A@arch]。

**严重性**：低——需要极端时序（毫秒级三跳 + 双源到达顺序倒置）才触发，生产环境未观察到实例；红测仅作为根因修复的 fixture 保留。

## chat-history 启动期对账快照与并发事件路径的时序假设

**发现日期**：2026-05-19（cron 顶替止血 deep review codex-rescue 多实例点出）
**关联**：`plugins/openclaw/index.js` 启动期对账链 `chatHistoryManager.load → manager.listAllEntries → chatHistoryManager.reconcileAll`

**问题**：启动期对账是 fire-and-forget 的 Promise 链，`listAllEntries` 拿到的 entries 是某一刻的 sessions.json 快照。若在 reconcileAll 真正执行某条 entry 之前，事件路径（cron_changed hook / phase=message）已经为同一 sessionKey 写入了更新的 sid，reconcileAll 用旧快照走 `recordSessionTransition`，理论上可能把"已被事件正确归档的新 head"再次翻档。

**为什么本期未修**：实际触发难度极高——启动对账几乎与 register 同步发起；事件路径需要 gateway WS 握手完成后才能传到 plugin。在用户笔记本上的 systemd 常驻 gateway 场景里，握手在启动后才能完成，启动对账几乎肯定先于任何事件到达。`recordSessionTransition` 内部已 `__reloadFromDisk` + mutex 串行化，能吞掉多数 race；只有一种极端时序（启动对账 stage-2 已读 sessions.json 但 stage-3 还没拿到 mutex 期间，事件路径完成了一次 reset）才会触发，至今未观察到实例。

**修复方向**：reconcileAll 内每条写前再次 reload 磁盘，对比 entry.sessionId 与磁盘 head sid——磁盘 head 已是更新的（未归档）状态时跳过本条让事件路径赢。

**严重性**：低——理论盲点；触发难度高；recordSessionTransition 现有 reload+mutex 已吞掉多数 race。

## chat-history classifyChatHistorySessionKey 是黑名单策略（未来新 sessionKey 形态默认入档）

**发现日期**：2026-05-19（cron 顶替止血 deep review 第二轮 codex-rescue 提出）
**关联**：`plugins/openclaw/src/chat-history-manager/manager.js` `classifyChatHistorySessionKey`

**问题**：helper 用黑名单（explicit / subagent / cron）判定跳过，其他形态默认 `ok=true` 进 chat-history。若上游未来新增 `agent:<id>:debug:*` / `agent:<id>:replay:*` / 其它新 segment，会无声入档污染 chat-history。

**为什么本期未修**：黑名单策略对当前已知形态准确；改成白名单需要枚举所有合法 chat sessionKey 段（`main` / 用户自定义 channel 等），过度设计风险高于当前价值。属于"识别到才说"。

**修复方向**：上游确实加新 segment 形态时，及时把它加入黑名单（一行改动）。若上游频繁演进 segment 词表，考虑迁移到白名单 + 默认拒绝策略。

**严重性**：低——需要上游主动加新形态才会触发；可观测信号有 `chat-history.skip-*` 缺失。

## file-manager upload `done` 帧未进入终态，迟到 binary 可能凑足 declaredSize 后被吸纳进文件

**发现日期**：2026-05-25（read-only deep-review 2026-05-24 综合报告 #5）
**关联**：`plugins/openclaw/src/file-manager/handler.js:767-811` 上传模式下的 `dc.onmessage`

**问题**：收到 `{done:true}` 后只置 `doneReceived=true`，没有把 binary 通道锁死。后续到达的 binary 帧仍走 else 分支累加 `receivedBytes`、入队、由 drainLoop 写盘。若 done 早于全部 binary 到达 + 后续 binary 恰好把 `receivedBytes` 凑到 `declaredSize`，最终 size 校验通过、rename 成功——多写的字节被吸纳进目标文件。

**为什么本期未修**：协议宽松而非安全漏洞——上传方对自己 workspace 内容本就有完全权限；生产环境未观察到实例（正常客户端不会在 done 之后继续 send binary）。

**修复方向**：done 收到后置 terminal flag；后续 binary 帧直接丢弃，或走 `SIZE_EXCEEDED` 同款 reject 路径上报错误码。

**严重性**：低——协议宽松；无安全影响。

## `coclaw.files.create` lstat→writeFile 非原子，并发同名创建都"成功"

**发现日期**：2026-05-25（read-only deep-review 2026-05-24 综合报告 #6）
**关联**：`plugins/openclaw/src/file-manager/handler.js:265-280` 的 `coclaw.files.create` 路径

**问题**：check-then-act 两步分离——先 `_lstat` 抛 ENOENT 才走 `writeFile('')`。两个并发 create 同名文件的请求都能通过 lstat（都 ENOENT），随后两次 `writeFile` 都返回成功，第二次悄悄覆盖第一次的内容；两个调用方都拿到 `{}` 成功响应、UI 看到"两次 create 都成功"，但实际只剩一个空文件。

**修复方向**：用 `fsp.open(resolved, 'wx')` 走 exclusive create，第二个调用会拿到 `EEXIST` → 翻译为 `ALREADY_EXISTS` 错误码。

**严重性**：低——业务影响小；正常 UI 不会真的并发 create 同一路径。
