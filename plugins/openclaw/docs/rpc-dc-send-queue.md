# rpc DC 发送管道（MemoryQueue + RpcDcSender + dc-chunking）

> 状态：阶段 1 已实施（`MemoryQueue` 内存版 + `RpcDcSender` 阻塞式发送器）。FBQ 切换待实施。
> 对应代码：`src/utils/memory-queue.js` / `src/webrtc/rpc-dc-sender.js` / `src/webrtc/dc-chunking.js`。
> 关联：[rpc-dc-file-queue.md](./rpc-dc-file-queue.md)（FileBackedQueue 长尾文件回退队列设计）。

## 背景与定位

插件运行在 OpenClaw gateway 进程内，向每条 rpc DC 推送的 JSON 帧（gateway 广播事件、agent RPC 响应、文件 RPC 响应等）若不做应用层流控，遇到对端拥塞或 ICE restart 期间会迅速堆积导致 OOM。

阶段 1 把发送链路拆成**两段式管道**：

```
producer ─enqueue(jsonStr)─► MemoryQueue ─consumeLoop─► RpcDcSender ─dc.send─► DataChannel ─SCTP─► UI
                            (admission +              (HWM/LWM 流控 +
                             drop 状态机)              分片协议)
```

每条 rpc DC 同时持有一个 MemoryQueue 和一个 RpcDcSender；中间由后台 `consumeLoop` 串起来。三件套绑定在 session 上：

- `session.rpcQueue` — MemoryQueue 实例
- `session.rpcDcSender` — RpcDcSender 实例
- `session.rpcConsumeLoop` — 消费循环 Promise

生产路径（`broadcast()` / files RPC `sendFn`）统一经此出口；只有 probe-ack 故意绕过（见下文）。

**职责切分**：
- MemoryQueue：admission（10 MB 软上限）+ 单条硬上限校验 + bypass 白名单 + drop 计数。**不知道 DC 是什么。**
- RpcDcSender：分片（buildChunks）+ HWM/LWM 背压 + 错误协议。**不知道队列是什么。**
- consumeLoop：把两边接起来，处理 sender 关闭后的退出。

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
| `DEFAULT_MEM_BUDGET` (queue) | 10 MB | admission 软上限：`memBytes >= memBudget` 且非 bypass 时 drop |
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

### admission drop（MemoryQueue）

- `oversize`：单条超 hard cap（bypass 也不豁免）
- `queue-full`：`memBytes >= memBudget` 且未命中 bypass

MemoryQueue 自身**不打日志、不计数**——它通过 `onDrop(reason, size)` 回调把丢弃事件外抛，由 `rpc-drop-monitor.js`（调用方注入）做边沿触发的状态机：

- 仅"空→满"和"满→空"两个翻转点打 log（warn + remoteLog 各一次）
- overflow 持续期间所有 queue-full drop **完全静默**，只累加 `droppedCount` / `droppedBytes`
- "满→空"翻转打 `overflow-end` 携带累计 dropped 数字
- close 时若仍有 dropped 累计或 residual，统一 remoteLog 一次 `rpc-queue.close`
- `rpc-queue.close` 字段 8 项：`dropped` / `droppedBytes` / `residualChunks` / `residualBytes` / `residualDiskBytes` / `residualWrittenBytes` / `fsBroken` / `lastReason`。其中 `dropped/droppedBytes/lastReason` 在 B-stage1 阶段已生效（任何 drop 都会更新）；`residualDiskBytes/residualWrittenBytes/fsBroken` 是 B-stage2 切 FBQ 后才会非零/非默认（B-stage1 阶段恒 `0/0/false`）。**字段位预留是为了 monitor 模块在 B-stage2 切换时无需再改**

**为什么静默积累**：UI 离线 + ICE 失败 + DC 长时间不 drain 的场景，队列每秒可能被网关事件灌满 drop，逐条上报会刷屏远程日志。状态翻转点上报既能定位故障窗口，又能控制日志体积。

### sender drop（RpcDcSender）

`MESSAGE_OVERSIZED` / `BUILD_CHUNKS_FAILED` **每次单独 warn**——这是应用 bug 性质（消息体异常大或 maxMessageSize 协商出错），不属于队列压力，不应被 overflow 状态吞噬。也**不计入 queue 的 droppedCount**。

## agent run 类 RPC 响应：admission bypass

`MemoryQueue.bypassAdmission(jsonStr)` 谓词命中时，即使 queue 已满（`memBytes >= memBudget`）也强行入队。

### 为什么需要

UI 把 `agent.wait(timeoutMs=0)` 探测路径暂存禁用后（`IDLE_THRESHOLD_MS=24h`），endRun 唯一的正常信号源变成"主 `agent` RPC 二阶段 res 帧"。这条 res 帧若在网络降级（队列积压到软上限）窗口被 drop，UI 永远收不到 endRun → phantom run 持续到 24h 硬超时。

为此让"agent run 类 RPC 响应"绕过软上限：即使 queue overflow，也强行入队，确保 ICE restart 恢复后**有序送达** UI。

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

- **绕过软上限**：白名单消息直接入队，即使 `memBytes >= memBudget`
- **仍受单条硬上限约束**：`oversize` 检查对 bypass 也不豁免（接收端重组上限固定 50 MB，超了无意义）
- **不计入 droppedCount/droppedBytes**：白名单绕过软上限时不算 drop
- **不影响 overflow 状态翻转**：状态翻转仍基于 `memBytes >= memBudget` 判定；白名单消息让 memBytes 进一步增长是有意设计

## ICE restart 下的存活

`webrtc-peer.js __handleOffer` 的 ICE restart 分支：

- 守卫：仅 `__impl === 'pion'` 放行；非 pion impl 直接发 `rtc:restart-rejected`，UI 走 PC rebuild
- 路径：`existing.pc.setRemoteDescription({ type:'offer', sdp })` → `createAnswer` → `setLocalDescription` → 回 answer
- **不新建 PC、不新建 DC、不触发 `dc.onclose`**——三件套（rpcQueue / rpcDcSender / rpcConsumeLoop）全程不动
- `maxMessageSize` 在重协商时若变化，热更新到 `existing.rpcDcSender.maxMessageSize`（公开字段）；队列中已入队的 jsonStr 是未分片的字符串，由 sender 在出队时按当前 maxMessageSize 重新分片

PC 真正重建（非 ICE restart 路径）时 `dc.onclose` 触发 → `closeByConnId` 走串行三件套关闭：sender close → queue destroy → await consumeLoop。队列内残留消息丢失，由 monitor 的 close 汇总 remoteLog 诊断。

## probe-ack 故意绕过

probe 消息（用于测量传输层 SCTP/DTLS 健康）不走 MemoryQueue + RpcDcSender，**直接 `dc.send`**。

理由：probe 用于测量传输层健康，走应用层 queue 会把队列积压压力错误映射到"DC 不通"上。白名单逻辑也不影响这条独立路径。

## 生产路径 API

> 实际装配代码见 `webrtc-peer.js __setupDataChannel`。下面是骨架，省略了身份重核 / 闭包局部引用 / `bufferedAmountLowThreshold` 设置等细节。

```js
// 三件套创建（webrtc-peer.js __setupDataChannel 内）
const monitor = createRpcDropMonitor({ connId, logger });
const queue = new MemoryQueue({
  id: connId,
  maxMessageBytes: MAX_SINGLE_MSG_BYTES,    // 单条 50MB 硬上限
  bypassAdmission: isAgentRunResponse,
  onDrop: monitor.onDrop,                   // monitor 接管 drop 状态机
  logger,
  tag: `conn=${connId}`,
});
await queue.init();                          // FBQ 切换后承担 fs 残留清理；MemoryQueue 是 no-op
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
    monitor.summarize(queue.stats());
    await queue.destroy().catch(() => {});
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
| `MemoryQueue` 实现 | `src/utils/memory-queue.js` |
| `RpcDcSender` 实现 | `src/webrtc/rpc-dc-sender.js` |
| 分片协议（buildChunks / createReassembler） | `src/webrtc/dc-chunking.js` |
| 三件套创建 | `src/webrtc/webrtc-peer.js __setupDataChannel` |
| 三件套关闭（`closeByConnId`） | `src/webrtc/webrtc-peer.js closeByConnId` |
| ICE restart 不重建 PC/DC | `src/webrtc/webrtc-peer.js __handleOffer` ICE restart 分支 |
| `broadcast()` 出口 | `src/webrtc/webrtc-peer.js broadcast` |
| `sendTo()` 单播出口 | `src/webrtc/webrtc-peer.js sendTo` |
| files RPC sendFn 出口 | `src/webrtc/webrtc-peer.js __setupDataChannel` 内 onFileRpc 回调 |
| 网关 ws → DC broadcast 透传 | `src/realtime-bridge.js` 内 onmessage broadcast 路径 |
| agent run 响应识别 | `src/webrtc/agent-run-response.js` |
| drop 状态机 | `src/webrtc/rpc-drop-monitor.js` |

## 与 FileBackedQueue 的关系

`MemoryQueue` 是 MB 级 DC 背压队列；`FileBackedQueue`（FBQ，详见 [rpc-dc-file-queue.md](./rpc-dc-file-queue.md)）是 GB 级长尾文件回退队列。两者**接口完全对齐**——`enqueue / __nextIter / destroy / clear / stats` 6 字段全一致——下一阶段 FBQ 切换几乎是一行 import 改：

```js
- new MemoryQueue({ id, memBudget, ... })
+ new FileBackedQueue({ id, memBudget, dataDir, ... })
```

切换后 FBQ 接管"长时间后台 / ICE 恢复"等慢消化场景的积压，sender 行为不变。具体 checklist 见 `../TODO.md` "阶段 2 切换 FBQ" 条目。

## 失败场景与接受边界

- **plugin 进程重启**：当前 MemoryQueue 内存数据必丢，不引入持久化（FBQ 切换后磁盘部分跨重启幸存）
- **DC 物理死亡 + 队列内消息未发完**：close 汇总 remoteLog 后丢弃；UI 端依赖主 RPC reject（信号 3）兜底感知
- **白名单消息让 queueBytes 持续增长**：理论上无界（每条都豁免软上限），但实际由 gateway 广播频率和 agent run 数量自然封顶；硬上限 50 MB 仍约束单条；监控 remoteLog 中的 admission-bypass 信号即可

## 死代码备注

`dc-chunking.js` 的 `chunkAndSend` 仅 `dc-chunking.test.js` 在用，生产路径已全部改走 `RpcDcSender`。可删除——见 `../TODO.md` "chunkAndSend 是死代码"条目。
