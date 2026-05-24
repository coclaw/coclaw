# rpc DC 发送管道（FileBackedQueue / MemoryQueue + RpcDcSender + dc-chunking）

> 状态：B-stage2 已实施。**当前生产默认 `FileBackedQueue`（FBQ）**；`MemoryQueue` 保留作为紧急回退路径与运行时降级目标，模块级常量翻一行即可切回。两者接口完全镜像，admission 决策已统一为 `current ≥ threshold` 风格（允许 single overshoot），装配点单点切换。
> 对应代码：`src/utils/file-backed-queue.js` / `src/utils/memory-queue.js` / `src/webrtc/rpc-dc-sender.js` / `src/webrtc/dc-chunking.js`。
> 关联：[rpc-dc-file-queue.md](./rpc-dc-file-queue.md)（FBQ 文件回退队列设计 + B-stage2 集成决策）。

## 背景与定位

插件运行在 OpenClaw gateway 进程内，向每条 rpc DC 推送的 JSON 帧（gateway 广播事件、agent RPC 响应、文件 RPC 响应等）若不做应用层流控，遇到对端拥塞或 ICE restart 期间会迅速堆积导致 OOM。

发送链路是**两段式管道**，drop 诊断从队列剥离到外置监视器：

```
producer ─enqueue(jsonStr)─► Queue ─consumeLoop─► RpcDcSender ─dc.send─► DataChannel ─SCTP─► UI
                             │  (admission +     (HWM/LWM 流控 +
                             │   bypass 白名单)   分片协议)
                             └─onDrop(reason,size,err?)─► RpcDropMonitor
                                                          (drop 状态机 + close 汇总)
```

`Queue` 是抽象，运行时由 `FileBackedQueue`（生产默认）或 `MemoryQueue`（紧急回退路径 + queueDir 不可用时的运行时降级目标）实例化——两者接口完全镜像，admission 决策已统一为 `current ≥ threshold` 风格（允许 single overshoot），装配点单点切换（见下文"队列实现选择"）。每条 rpc DC 同时持有一个 Queue、一个 RpcDcSender、一个 RpcDropMonitor；中间由后台 `consumeLoop` 串起来。四件套绑定在 session 上：

- `session.rpcQueue` — Queue 实例（生产默认 FBQ；queueDir 不可用时降级 MemoryQueue）
- `session.rpcDcSender` — RpcDcSender 实例
- `session.rpcConsumeLoop` — 消费循环 Promise
- `session.rpcDropMonitor` — RpcDropMonitor 实例（drop 边沿状态机 + spill 边沿信号 + close 汇总）

生产路径（`broadcast()` / files RPC `sendFn`）统一经此出口；只有 probe-ack 故意绕过（见下文)。

**职责切分**：
- Queue：admission（容量阈值 + 单条硬上限）+ bypass 白名单 + 6 字段 stats。**纯业务无关容器，不输出任何日志/累计**——drop 事件经 `onDrop(reason, size, err?)` 回调外抛；FBQ 文件创建 / 删除经 `onSpillStart()` / `onSpillEnd(drainedBytes)` 边沿钩子外抛。FBQ 与 MemoryQueue 共用此契约，差异仅在物理存储（mem vs mem+disk）和容量阈值规模（10 MB mem vs 10 MB mem + 1 GB disk），admission 决策风格保持一致。详见 [rpc-dc-file-queue.md](./rpc-dc-file-queue.md) 的"接口红线"章节。
- RpcDcSender：分片（buildChunks）+ HWM/LWM 背压 + 错误协议。**不知道队列是什么。**
- RpcDropMonitor：消费 `onDrop` / `onSpillStart` / `onSpillEnd` 事件 → 边沿状态机（overflow-start/end / disk-cap-start / spill-start/end / fs-broken sticky / oversize / 未知）+ dropCount/dropBytes 累计 + close 汇总。**不知道队列内部结构。**`fs-error` reason 第三参 `err` 透传底层 errno，`disk-cap` reason 第三参 `{ memBytes, writtenBytes, diskCap }` 透传容量分量，让运维拿到真实诊断（红线 2 "丢失 / 延迟必须 loud 可观测" 的关键证据）。
- consumeLoop：把队列和 sender 接起来，出列后调 `monitor.maybeEmitOverflowEnd(queue.stats())` 检查"满→空"翻转，处理 sender 关闭后的退出。

## 为什么必须自建应用层分片

WebRTC DataChannel 底层基于 SCTP，但 plugin 用的两个 WebRTC 库都**不提供透明的应用层大消息分片**：

- **pion-node**（主力）：`send()` 直通到 Go 侧 pion/webrtc。消息超过远端 SDP 声明的 `a=max-message-size` 时直接抛错。SCTP 传输层会把消息拆成多个 IP 包并透明重组，但 `max-message-size` 是**应用层硬上限**——超过即拒绝，不会自动切分。
- **werift**（兜底）：SCTP 层确实按 1200 字节自动分片并透明重组，`send()` 可传任意大小消息。但 werift 在 SDP 中声明 `max-message-size: 65536`，**远端按此拒收超大消息**。即使 werift 侧不报错，远端也会丢弃。

所以分片必须在应用层做。`dc-chunking.js` 的 `buildChunks` / `createReassembler` 实现了一套 5 字节头（1 flag + 4 msgId BE）的协议：

- `flag = 0x01` BEGIN，`0x00` MIDDLE，`0x02` END
- 普通（不分片）消息走 SCTP string 帧（PPID 51）；分片走 binary 帧（PPID 53）
- 分片阈值取自远端 SDP 的 `a=max-message-size`（`webrtc-peer.js` 解析）

**file DC 不走这套**——每个文件传输用一条独立的专用 DataChannel，`file-manager/handler.js` 自己做流式传输 + 背压控制，不需要 JSON 分片/重组。

## 阈值常量（一处真值）

定义在 `rpc-dc-sender.js` / `memory-queue.js` 顶部。这里只列约束语义，**具体数字以代码为准**——若文档与代码冲突，相信代码。

| 常量 | 数字（当前） | 含义 |
|---|---|---|
| `DC_HIGH_WATER_MARK` (sender) | 1 MB | `dc.bufferedAmount >= HIGH` 时 sender 阻塞等 BAL |
| `DC_LOW_WATER_MARK` (sender) | 256 KB | 设置 `dc.bufferedAmountLowThreshold`，触发 BAL 事件 |
| `MAX_SINGLE_MSG_BYTES` (sender) | 50 MB | 单条 payload 硬上限，超过抛 `MESSAGE_OVERSIZED` |
| `DEFAULT_MEM_BUDGET` (queue) | 10 MB | mem 桶阈值：`memBytes >= memBudget` 时 MemoryQueue drop（非 bypass）/ FBQ 转 spill；允许 single overshoot |
| `MAX_REASSEMBLY_BYTES` (chunking) | 50 MB | 接收端单条重组上限。与 sender 硬上限对齐 |
| `MAX_CHUNKS_PER_MSG` (chunking) | 10 000 | 单条消息最大分片数，防 BEGIN-without-END 泄漏 |

## RpcDcSender 错误协议

统一抛错带 `code` 字段，没有 silent return：

| code | 含义 | caller 行为 |
|---|---|---|
| `SENDER_CLOSED` | sender 已 close / DC 非 open / dc.send 抛 | consumeLoop 退出循环 |
| `MESSAGE_OVERSIZED` | 单条 payload > 50 MB | warn 后继续下一条 |
| `BUILD_CHUNKS_FAILED` | buildChunks 抛（如 maxMessageSize 太小） | warn + remoteLog 后继续下一条 |

consumeLoop 模板：

```js
for await (const str of session.rpcQueue) {
  try { await session.rpcDcSender.send(str); }
  catch (err) {
    if (err.code === 'SENDER_CLOSED') break;
    logger.warn?.(`rpc-dc.send-failed code=${err.code} size=${str.length}`);
  }
}
```

## drop 上报：仅边沿触发

drop 来源有两类，分别由不同组件上报，**不要混淆**：

### admission drop（队列容器）

| reason | 含义 | bypass 豁免 | 来源 |
|---|---|---|---|
| `oversize` | 单条超 `maxMessageBytes` 硬上限 | ❌ 不豁免 | FBQ + MemoryQueue |
| `queue-full` | `memBytes >= memBudget` 且非 bypass | ✅ 豁免（容量层） | MemoryQueue（mem 桶满即 drop） |
| `disk-cap` | `memBytes + writtenBytes >= diskCap` 且非 bypass | ✅ 豁免（容量层） | FBQ（mem + 已写文件总占用顶到 diskCap） |
| `fs-error` | spill 路径 IO 失败（write cb / mkdir / refill stat 同步路径直接 drop；writeStream emit error 异步路径仅置 `fsBroken`，由后续非 bypass enqueue 进 fsBroken 短路 drop 才报 `fs-error`） | ❌ 不豁免（IO 失败那一刻） | FBQ 独有；首次进 fsBroken 后续仅累加 |

队列容器自身**不打日志、不计数**——通过 `onDrop(reason, size, err?)` 回调把事件外抛，由 `rpc-drop-monitor.js`（调用方注入）做边沿触发的状态机：

- 仅"空→满"和"满→空"两个翻转点打 log（warn + remoteLog 各一次）
- overflow 持续期间所有 admission drop **完全静默**，只累加 `droppedCount` / `droppedBytes`
- "满→空"翻转打 `overflow-end` 携带累计 dropped 数字
- `disk-cap` 第三参展开 `memBytes` / `writtenBytes` / `diskCap` 三分量到 log，让运维直接看到谁顶到 cap（而非误读为"文件满了"）
- close 时若仍有 dropped 累计或 residual，统一 remoteLog 一次 `rpc-queue.close`
- `rpc-queue.close` 字段 9 项：`dropped` / `droppedBytes` / `residualChunks` / `residualBytes` / `residualDiskBytes` / `residualWrittenBytes` / `fsBroken` / `spillActive` / `lastReason`（`lastReason` 无 drop 时为 `none`）。MemoryQueue 路径下 `residualDiskBytes` / `residualWrittenBytes` / `fsBroken` / `spillActive` 恒 `0/0/false/false`；FBQ 路径下承载磁盘残留 + 降级状态（`spillActive=true` 表示 destroy 时仍处于 spilled 中段，未走完 drain）

**为什么静默积累**：UI 离线 + ICE 失败 + DC 长时间不 drain 的场景，队列每秒可能被网关事件灌满 drop，逐条上报会刷屏远程日志。状态翻转点上报既能定位故障窗口，又能控制日志体积。

### spill 边沿信号（FBQ 独有）

`onSpillStart()` / `onSpillEnd(drainedBytes)` 是文件层翻转信号，与 admission drop 是不同维度：

- `spill-start`：FBQ `spilled` 翻转 false→true（首次创建文件落盘），监视器打 info + remoteLog
- `spill-end`：FBQ `spilled` 翻转 true→false 时打 info + remoteLog 含累计 `drainedBytes`；触发路径有两条——drain 完成（`__dropFile` 删文件）+ `clear()`（与 `__dropFile` 对称，wasSpilled snapshot 后调）
- 故障删档（`__handleFsError` 内的 `fs.rm`）/ 清理离场（`destroy`）**不**调 `onSpillEnd`，由 `fs-broken` / `close` 信号各自承载，避免语义混淆
- 监视器内置幂等：`spillActive` flag 让重复 active 不重 emit、未 active 时调 `onSpillEnd` 静默
- 边沿触发，不刷屏：mobile 端长时间后台再恢复的典型场景每条 DC 仅打两条（一上一下）

**与 `disk-cap-start` 的区分**：`disk-cap-start` 表示 admission 拒收（队列总占用顶到阈值），`spill-start` 表示物理文件被创建。两者完全独立——健康路径下 spill-start 频繁出现（mem 满转盘是常态）但 disk-cap-start 罕见（要积压到 1 GB）。

### sender drop（RpcDcSender）

`MESSAGE_OVERSIZED` / `BUILD_CHUNKS_FAILED` **每次单独 warn**——这是应用 bug 性质（消息体异常大或 maxMessageSize 协商出错），不属于队列压力，不应被 overflow 状态吞噬。也**不计入 queue 的 droppedCount**。

## agent run 类 RPC 响应：admission bypass

`bypassAdmission(jsonStr)` 谓词命中时，即使容量层已顶到上限（MemoryQueue 的 `memBytes >= memBudget` / FBQ 的 `memBytes + writtenBytes >= diskCap`）也强行入队。

### 为什么需要

UI 把 `agent.wait(timeoutMs=0)` 探测路径暂存禁用后（`IDLE_THRESHOLD_MS=24h`），endRun 唯一的正常信号源变成"主 `agent` RPC 二阶段 res 帧"。这条 res 帧若在网络降级（队列积压到容量上限）窗口被 drop，UI 永远收不到 endRun → phantom run 持续到 24h 硬超时。

为此让"agent run 类 RPC 响应"绕过容量层：即使 queue overflow，也强行入队，确保 ICE restart 恢复后**有序送达** UI。

### 识别条件（硬编码、无状态）

由 `webrtc/agent-run-response.js` 提供：

```
frame.type === 'res' && frame.payload?.runId 顶层存在
```

- 不维护白名单表
- 不在 req 入口记 id↔method 映射
- bypassAdmission 内部 try-parse JSON，解析失败按非白名单处理
- 仅看 res 帧顶层 `payload.runId`，不递归扫描嵌套字段（防误命中）

### 为什么这条判定稳

OpenClaw 上游事实：

- `agent` / `agent.wait` 全部 6 个 respond 分支 payload 顶层都含 runId（这正是要保送的）
- `chat.send` rsp 顶层也含 runId。CoClaw UI 在斜杠命令路径调用 chat.send，会被识别属 false positive，但响应只有几十字节，加白只是让小帧优先送达，**无负面影响**
- `send` / `poll` / `sessions.send` / `sessions.steer` 顶层含 runId 但 CoClaw UI 不调，不会出现在队列里
- UI 实际在用的其他 RPC（`sessions.list/get/reset` / `chat.history` / `agents.*` / `topics.*` / `models.*` / `coclaw.*` 等）顶层均无 runId，不会被误识别

### 豁免行为

- **绕过容量层**：白名单消息直接入队，越过 MemoryQueue 的 `memBytes >= memBudget` / FBQ 的 `memBytes + writtenBytes >= diskCap`
- **FBQ fsBroken 降级模式额外豁免 mem 桶**：spill 不可用时 mem 桶事实上接管容量层，bypass 命中允许 overshoot 入队（与 MemoryQueue 镜像，保白名单不被误报 fs-error）
- **仍受单条硬上限约束**：`oversize` 检查对 bypass 也不豁免（接收端重组上限固定 50 MB，超了无意义）
- **仍受 IO 失败约束**：FBQ 的 `fs-error` 在物理写失败时仍 drop，bypass 不豁免——具体路径见上方 `### admission drop` 表 `fs-error` 行：mkdir / write callback err 同步直接 drop；writeStream emit error 异步路径仅置 `fsBroken`，由后续非 bypass enqueue 进 fsBroken 短路 drop 才报 `fs-error`
- **不计入 droppedCount/droppedBytes**：白名单绕过容量层时不算 drop
- **不影响 overflow 状态翻转**：状态翻转仍基于容量阈值判定；白名单消息让占用进一步增长是有意设计

## ICE restart 下的存活

`webrtc-peer.js __handleOffer` 的 ICE restart 分支：

- 守卫：仅 `__impl === 'pion'` 放行；非 pion impl 直接发 `rtc:restart-rejected`，UI 走 PC rebuild
- 路径：`existing.pc.setRemoteDescription({ type:'offer', sdp })` → `createAnswer` → `setLocalDescription` → 回 answer
- **不新建 PC、不新建 DC、不触发 `dc.onclose`**——三件套（rpcQueue / rpcDcSender / rpcConsumeLoop）全程不动
- `maxMessageSize` 在重协商时若变化，热更新到 `existing.rpcDcSender.maxMessageSize`（公开字段）；队列中已入队的 jsonStr 是未分片的字符串，由 sender 在出队时按当前 maxMessageSize 重新分片

PC 真正重建（非 ICE restart 路径）时 `dc.onclose` 触发 → `closeByConnId` 走串行三件套关闭：sender close → queue destroy → await consumeLoop。队列内残留消息丢失，由 monitor 的 close 汇总 remoteLog 诊断。

## probe-ack 故意绕过

probe 消息（用于测量传输层 SCTP/DTLS 健康）不走 Queue + RpcDcSender，**直接 `dc.send`**。

理由：probe 用于测量传输层健康，走应用层 queue 会把队列积压压力错误映射到"DC 不通"上。白名单逻辑也不影响这条独立路径。

## 队列实现选择（B-stage2）

装配点通过**模块级常量**单点切换，运行时再叠一层降级守卫：

```
模块级常量 RPC_QUEUE_IMPL = 'fbq' (生产默认) | 'mem'
   ↓
运行时叠加：useFbq = (RPC_QUEUE_IMPL === 'fbq') && !!queueDir
   ↓
实例化：new FileBackedQueue({ ... }) 或 new MemoryQueue({ ... })
```

> 默认 `'fbq'` 启用磁盘回退队列；MemoryQueue 路径保留作为紧急回退（一行常量改回 `'mem'`）+ 运行时降级目标（queueDir 不可用时自动选）。代码 + 测试都保留两种装配路径（测试通过 `rpcQueueImpl: 'mem'` 构造选项显式覆盖）。

### 为什么是这种"开关 + 守卫"双层结构

- **模块级开关（紧急回退）**：FBQ 突发故障时改一行常量 `'fbq' → 'mem'` 即可全量切回 MemoryQueue，避免要回滚 PR 的压力（曾在 0.20.x 阶段使用过一次：FBQ 切换前的预防性回退）
- **运行时降级（自愈）**：bridge 启动期的"队列目录准备"（残留清理 + diskCap 测量，详见 [rpc-dc-file-queue.md](./rpc-dc-file-queue.md)）若失败则 `queueDir` 留 null，每次新装配 session 自动降级到 MemoryQueue——**FBQ 路径永不阻塞 webrtc 装配**
- **不进 env / 不进 plugin config**：任意可热更的开关都意味着运行时多分支，复杂度收益不匹配。模块级常量改完发新版即可，部署成本可接受

### 装配诊断

每个 session 装配成功后**仅**打一次本地 info + 一次 remoteLog `rtc.queue-impl conn=… impl=fbq|mem [fallback=queue-dir-null]`：

- 频率与连接频率挂钩，符合 remoteLog 红线（不高频）
- 让运维拿"实际跑哪种 queue"，而不是依赖代码常量推断——尤其是 fbq 静默降级到 mem 的场景
- log 在 stale 守卫之后才打——只对真正生效的 session 计数，被同 connId 二次 ondatachannel / closeByConnId 拒绝的 stale 装配不打 log

### MemoryQueue 留作可切回路径的产品价值

FBQ 默认运行后 MemoryQueue 不是死代码：

- **紧急回退路径**：模块级常量改 `'mem'` 一行回退到 plan-2 之前的内存实现
- **运行时自动降级目标**：queueDir 不可用时自动使用，不阻塞装配
- **dev/test 简化**：本地开发省启动期 fs prep，单元测试不需要构造 tmp 目录
- **接口对齐参考**：MemoryQueue 模块仍保持 100% 覆盖，作为 FBQ 接口契约的"镜像证人"——FBQ admission 风格已与 MemoryQueue 对齐（`current ≥ threshold` + single overshoot），任何接口偏移都能被 MemoryQueue 同款测试覆盖发现

## 生产路径 API

> 实际装配代码见 `webrtc-peer.js __setupDataChannel`。下面是骨架，省略了身份重核 / 闭包局部引用 / `bufferedAmountLowThreshold` 设置等细节。

```js
// 四件套创建（webrtc-peer.js __setupDataChannel 内）
const monitor = createRpcDropMonitor({ connId, logger });

// queue 实例选择：'fbq' 模式（生产默认）+ queueDir 可用 → FBQ；'fbq' + queueDir null → 降级 mem；'mem' 模式 → mem
const useFbq = this.__rpcQueueImpl === 'fbq' && !!queueDir;
const queue = useFbq
  ? new FileBackedQueue({
      id: `${connId}-${Date.now()}-${randomUUID().slice(0,8)}`,  // 唯一后缀 → 同 connId race 物理隔离
      dir: queueDir,
      memBudget: 10 * 1024 * 1024,           // 10 MB mem 阈值；与 MemoryQueue 默认对齐
      diskCap: getDiskCap?.() ?? ONE_GB,     // mem + 已写文件总占用阈值；不是文件 size 上限（文件实际峰值约为 diskCap - memBudget）
      maxMessageBytes: MAX_SINGLE_MSG_BYTES, // 单条 50 MB 硬上限（与 sender 端对齐 + bypass 也不豁免）
      bypassAdmission: isAgentRunResponse,
      onDrop: monitor.onDrop,
      onSpillStart: monitor.onSpillStart,    // 文件创建边沿信号
      onSpillEnd: monitor.onSpillEnd,        // 文件 drain 删除边沿信号
      logger,
    })
  : new MemoryQueue({
      id: connId,
      maxMessageBytes: MAX_SINGLE_MSG_BYTES,
      bypassAdmission: isAgentRunResponse,
      onDrop: monitor.onDrop,
      logger,
      tag: `conn=${connId}`,
    });
await queue.init();                          // FBQ 承担 fs 残留清理；MemoryQueue 是 no-op
const sender = new RpcDcSender({
  dc,
  maxMessageSize: session.remoteMaxMessageSize,
  getNextMsgId: () => session.nextMsgId++,
  logger,
  tag: `conn=${connId}`,
});
session.rpcQueue = queue;
session.rpcDcSender = sender;
session.rpcDropMonitor = monitor;
session.rpcConsumeLoop = (async () => {
  try {
    for await (const str of queue) {
      try {
        await sender.send(str);
        monitor.maybeEmitOverflowEnd(queue.stats());  // 出列后检查"满→空"翻转
      } catch (err) {
        if (err.code === 'SENDER_CLOSED') break;
        logger.warn?.(`rpc-dc.send-failed code=${err.code} size=${str.length}`);
      }
    }
  } finally {
    sender.close();
    // summarize 走 destroy 的 onBeforeClear 同步钩子：在 mutex 内拿原子残留快照（含
    // in-flight broadcast 在 mutex 中排队的 enqueue），规避 sync `queue.stats()` 读漏
    await queue.destroy((residual) => monitor.summarize(residual)).catch(() => {});
  }
})();

// 生产侧入队（fire-and-forget）
session.rpcQueue.enqueue(jsonStr).catch(/* ... */);

// sendTo(connId, payload): Promise<boolean>
// 仅透传 admission 决策（accepted=true / queue-full=false）。
// build/oversize 失败发生在 sender 内部异步路径，sendTo 已 return true——caller 不应依赖返回值判最终送达。

// 关闭顺序（dc.onclose / closeByConnId 触发）
sender.close();
// destroy 的 onBeforeClear 是同步钩子——由 destroy 在自己的 mutex 内 fire，参数是
// 销毁时刻的残留快照（含 in-flight broadcast 在 mutex 中排队的 enqueue）。
// 用同步钩子是为修复 race：之前 `summarize(queue.stats())` 同步读看不到 mutex-queued enqueue。
// 异步 callback 的 rejection 不会被捕获——webrtc-peer 当前所有调用方都是同步函数。
await queue.destroy((residual) => monitor.summarize(residual)).catch(() => {});
await session.rpcConsumeLoop;
```

## 关键源码锚点

| 内容 | 位置 |
|------|------|
| `FileBackedQueue` 实现（生产路径默认） | `src/utils/file-backed-queue.js` |
| `MemoryQueue` 实现（接口对齐参考 + 紧急回退） | `src/utils/memory-queue.js` |
| `RpcDcSender` 实现 | `src/webrtc/rpc-dc-sender.js` |
| 分片协议（buildChunks / createReassembler） | `src/webrtc/dc-chunking.js` |
| 队列实现选择（`RPC_QUEUE_IMPL` 常量 + 装配点） | `src/webrtc/webrtc-peer.js __setupDataChannel` |
| 四件套关闭（`closeByConnId`） | `src/webrtc/webrtc-peer.js closeByConnId` |
| ICE restart 不重建 PC/DC | `src/webrtc/webrtc-peer.js __handleOffer` ICE restart 分支 |
| `broadcast()` 出口 | `src/webrtc/webrtc-peer.js broadcast` |
| `sendTo()` 单播出口 | `src/webrtc/webrtc-peer.js sendTo` |
| files RPC sendFn 出口 | `src/webrtc/webrtc-peer.js __setupDataChannel` 内 onFileRpc 回调 |
| 网关 ws → DC broadcast 透传 | `src/realtime-bridge.js` 内 onmessage broadcast 路径 |
| 启动期 queueDir 准备（`cleanupResiduals` + `measureDiskCap`） | `src/realtime-bridge.js bridge.start()` + `src/rpc-queue-startup.js` |
| agent run 响应识别 | `src/webrtc/agent-run-response.js` |
| drop 状态机（含 fs-error errno 透传） | `src/webrtc/rpc-drop-monitor.js` |

## 与 FileBackedQueue 的关系

`MemoryQueue` 是 10 MB 级 DC 背压队列；`FileBackedQueue` 是 10 MB mem + 1 GB disk 的长尾文件回退队列（详见 [rpc-dc-file-queue.md](./rpc-dc-file-queue.md)）。B-stage2 让装配点支持单点切换；FBQ 默认接管"长时间后台 / ICE 恢复"等慢消化场景的积压；sender 行为不变。

两者接口完全镜像——同名构造选项（`memBudget` / `maxMessageBytes` / `bypassAdmission` / `onDrop` / `logger`，FBQ 额外有 `dir` / `id` / `diskCap` / `onSpillStart` / `onSpillEnd`）+ 同名实例方法（`init / enqueue / [Symbol.asyncIterator] / stats / clear / destroy`）+ `stats()` 同款 6 字段 + 同款 admission 决策风格（`current ≥ threshold` + single overshoot）——webrtc-peer 装配点的 `consumeLoop` / 4 处 `destroy(onBeforeClear)` / `enqueue` 调用对实例类型不可知（"鸭子类型"）。这是为何"模块级常量切回 mem"是真正一行的原因。

## race 处理总览

队列演进过程中沉淀了两个 race 修复，分别由不同模块承担。

### race A：`monitor.summarize` 看不到 in-flight enqueue

**触发**：`broadcast()` / `sendTo()` 是 fire-and-forget 异步入队（mutex withLock）；DC close 同步路径调 `monitor.summarize(queue.stats())` 时，mutex 队列里可能仍有未拿锁的 enqueue Promise——同步读 `queue.stats()` 看不到这些 in-flight 消息。

**修复**：把 `summarize` 从同步读 stats 改为走 `queue.destroy(onBeforeClear)` 同步钩子——destroy 在自己的 mutex 内 fire 钩子，参数是销毁时刻的原子残留快照。所有 in-flight enqueue 要么已落地（被快照看到 → summarize 计数），要么还没拿锁（destroyed=true 短路返回 false → silent drop，连接清理的正常副作用）。

### race B：同 connId 重建期 destroy / init 文件竞争（FBQ 独有）

**触发**：webrtc-peer 在 `closeByConnId` 内先 `__sessions.delete(connId)`、再 `await rpcQueue.destroy(...)`——`delete-first` 顺序不能改（让 dc.onclose 路径短路）。这意味着在 destroy 进行中（数十~数百 ms 的 fs.rm + close stream），同 connId 的新 offer 到达后会进入新装配路径，看不到旧实例。MemoryQueue 时代 destroy 是 microsec 级看不见；切磁盘后窗口暴露——如果新旧 FBQ 用相同文件名，两个实例并发 IO 同一文件。

**修复（决策 4，方案 A）**：FBQ 实例 id 加唯一后缀 `${connId}-${ts}-<uuid8>`，物理文件名不同，新旧实例完全隔离。残留由 bridge 启动期 `cleanupResiduals` 统一扫掉（白名单 `*.jsonl`）。

**为什么不用 webrtc-peer 内部 mutex（备选 B）/ pendingClose Map（备选 C）**：备选都要入侵 4-5 处信令路径（含 ICE restart），过度设计；FBQ 文件层物理隔离改动 1 行、零信令路径侵入，与"最小切换"红线一致。

详见 [rpc-dc-file-queue.md](./rpc-dc-file-queue.md) 的"同 connId race 隔离设计"章节。

## 失败场景与接受边界

- **plugin 进程重启**：FBQ 文件由 bridge 启动期 `cleanupResiduals` 统一扫掉（白名单 `*.jsonl`，含同 connId race 唯一后缀残留）。**不做跨进程持久化**——对端 PC 已失效，陈旧消息送到新对端无意义
- **DC 物理死亡 + 队列内消息未发完**：close 汇总 remoteLog 后丢弃；UI 端依赖主 RPC reject 信号兜底感知
- **bridge 启动期 queueDir 准备失败**：fbq 路径自动降级到 MemoryQueue，单 session 装配日志带 `fallback=queue-dir-null` 标记；plugin 在"残废模式"运行（rpc 路径 mem-only，10 MB 阈值），运维通过装配日志感知
- **白名单消息让 queueBytes 持续增长**：白名单豁免容量层但仍受单条 50 MB 硬上限约束（红线 3：bypass 仅豁免容量层 admission——含 fsBroken 降级模式 mem 桶；不豁免单条上限 / 实际写入失败那一刻）；FBQ 健康路径下 1 GB diskCap 对**非 bypass 流量**是真正阈值（允许 single overshoot；bypass 命中可越过阈值 + single overshoot 双层叠加），fsBroken 降级后 mem 桶事实上接管容量层但白名单可 overshoot（与 MemoryQueue 镜像）
