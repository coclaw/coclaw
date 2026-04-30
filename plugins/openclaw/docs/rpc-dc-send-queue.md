# rpc DC 发送队列（RpcSendQueue）

> 状态：已实施；阶段 2 白名单（agent run 类 RPC 响应豁免软上限）实施中
> 创建：2026-05-01（基于既有实现汇总）
> 关联：[rpc-dc-file-queue.md](./rpc-dc-file-queue.md)（FileBackedQueue 长尾文件回退队列设计）

## 背景与定位

插件运行在 OpenClaw gateway 进程内，向每条 rpc DC 推送的 JSON 帧（网关广播事件、agent RPC 响应、文件 RPC 响应等）若不做应用层流控，遇到对端拥塞或 ICE restart 期间会迅速堆积导致 OOM。

`RpcSendQueue`（`src/webrtc/rpc-send-queue.js`）为每条 rpc DC 提供**应用层背压队列**：

```
producer ─send(jsonStr)─► RpcSendQueue ─dc.send─► DataChannel ─SCTP─► 对端
                          (流控 + 背压)
```

每条 rpc DC 一个独立实例，绑定到 `session.rpcSendQueue`（创建点 `webrtc-peer.js:491-498`）。

**单一职责**：抵抗 DC `bufferedAmount` 的瞬时高水位、维持分片原子性、提供 fast-path 同步直发。**不承担**：消息持久化、跨进程重启幸存、Promise 送达保证、自动重试。

## 阈值常量

定义在 `rpc-send-queue.js:19-25`：

| 常量 | 值 | 含义 |
|---|---|---|
| `DC_HIGH_WATER_MARK` | 1 MB | `dc.bufferedAmount >= HIGH` 时暂停 fast-path / drain |
| `DC_LOW_WATER_MARK` | 256 KB | 设置 `dc.bufferedAmountLowThreshold`，触发 `bufferedamountlow` 事件 |
| `MAX_QUEUE_BYTES` | 10 MB | 应用层队列**软上限**：超过新消息被 drop（白名单除外，见 §阶段 2） |
| `MAX_SINGLE_MSG_BYTES` | 50 MB | 单条消息**硬上限**：对齐 `dc-chunking.js MAX_REASSEMBLY_BYTES`，超过即 drop（白名单也不豁免） |

## send / drain 主流程

### send(jsonStr) 同步入口

```
1. 前置守卫：closed 或 dc.readyState !== 'open' → 返 false
2. 用 buildChunks 计算分片（若需要分片）和 totalBytes
3. 硬上限检查：totalBytes > MAX_SINGLE_MSG_BYTES → drop（每次 warn）
4. 软上限检查：queueBytes >= MAX_QUEUE_BYTES → drop（仅"空→满"翻转点 warn + remoteLog）
   ※ 阶段 2：白名单消息绕过此判定，强行入队
5. 不分片分支：
   ├─ 队列空 + bufferedAmount < HIGH → fast-path 同步直发
   └─ 否则 → 入队 { data: jsonStr, isString: true, bytes }
6. 分片分支：
   ├─ 队列空时尝试同步直发尽可能多的 chunk
   └─ 剩余 chunk 原子性入队（保证同消息分片连续，不被其他消息插入）
```

### drain（由 onbufferedamountlow 事件触发）

```
循环条件：queue 非空 + dc 仍 open + bufferedAmount < HIGH
出队：dc.send(item.data)、queueBytes -= item.bytes
满→未满 翻转：queueOverflowActive 翻 false 并 remoteLog overflow-end（带累计 dropped 数字）
```

### close（dc.onclose 调用）

幂等。清空队列，汇总 droppedCount/droppedBytes/residualChunks/residualBytes 一次 remoteLog。

## 字符串帧 vs 二进制帧分类型入队

队列元素**显式记录原始类型**：

```js
{ data: string | Buffer, isString: boolean, bytes: number }
```

drain 出口直接 `dc.send(item.data)`：string → SCTP string 帧（PPID 51）；Buffer → SCTP binary 帧（PPID 53）。

**早期 bug（已修，2026-04）**：早期实现把入队元素统一存 `Buffer`（包括把 JSON string 强转 `Buffer.from(jsonStr, 'utf8')`），drain 时按二进制帧发出。UI 端 reassembler 把 binary 帧当分片协议解析（前 5 字节读 flag + msgId），JSON 首字节 `{`（0x7B）既不是 BEGIN/MIDDLE/END flag，也匹配不到任何 pending msgId，**静默 drop**。

具体表现：UI 发消息后 stuck 在"任务未完成"+"输入框可用"，但 plugin 侧 OpenClaw run 还在跑——因为 `accepted` 等小响应帧被 reassembler 当残片扔了。

**根因教训**：DataChannel 协议下 string 帧（PPID 51）和 binary 帧（PPID 53）是两种独立的应用层消息类型，对端按 PPID 分别解读。"统一类型化队列"必须在 drain 出口区分发送方式。

## ICE restart 下队列存活

CLAUDE.md 写"ICE restart 复用 DC 时队列自动保留"，代码依据如下：

`webrtc-peer.js:148-219` `__handleOffer` 的 ICE restart 分支：

- 守卫：仅 `__impl === 'pion'` 放行（其他 impl 发 `rtc:restart-rejected`，UI 走 PC rebuild 流程）
- 路径：`existing.pc.setRemoteDescription({ type: 'offer', sdp })` → `createAnswer` → `setLocalDescription` → 回 answer
- **不新建 PC、不新建 DC、不触发 `dc.onclose`**——`session.rpcSendQueue` 全程不动，`bufferedamountlow` 事件在 DC 重新可用后继续触发 drain
- `maxMessageSize` 可能在重协商时变化，同步刷新到 `existing.rpcSendQueue.maxMessageSize`（`webrtc-peer.js:181-184`）；队列中已入队的 chunks 按旧值分片保留，新消息用新值

PC 真正重建（非 ICE restart 路径）时 `dc.onclose` 触发 → `session.rpcSendQueue.close()` → 队列内残留消息丢失，由 close 时的 remoteLog 汇总诊断。

## 软上限 drop 的状态机：翻转点静默积累

`queueBytes >= MAX_QUEUE_BYTES` 时新消息（非白名单）被 drop。drop 上报策略：

- **仅"空→满"和"满→空"两个翻转点**打 log（warn + remoteLog 各一次）
- overflow 持续期间所有 queue-full drop **完全静默**，只累加 `droppedCount` / `droppedBytes`
- "满→空"翻转（drain 出口检测 `queueBytes < MAX_QUEUE_BYTES`）打 `overflow-end` 携带累计 dropped 数字
- close 时若仍有 dropped 累计或 residual，统一 remoteLog 一次 `rpc-queue.close`

**为什么静默积累**：UI 离线 + ICE 失败 + DC 长时间不 drain 的场景，队列每秒都可能被网关事件灌满 drop，逐条上报会刷屏远程日志。状态翻转点上报既能定位故障窗口，又能控制日志体积。

`single-msg-oversize` drop（硬上限）**不受 overflow 状态影响**，每次照常 warn——这是应用 bug 性质（消息体异常大），不代表队列压力。

## 阶段 2：agent run 类 RPC 响应白名单

> 状态：实施中（2026-05）
> 关联：`docs/designs/agent-run-end-detection.md` §8.3

### 动机

UI 阶段 2 把 `agent.wait(timeoutMs=0)` 探测路径暂存禁用（`IDLE_THRESHOLD_MS` 拉到 24h），endRun 唯一的正常信号源变成"主 `agent` RPC 二阶段 res 帧"。这条 res 帧若在网络降级（队列积压到软上限）窗口被 drop，UI 永远收不到 endRun 信号 → phantom run 持续到 24h 硬超时。

为此在软上限 drop 判定处给"agent run 类 RPC 响应"加豁免：即使队列已 overflow，这类消息也强行入队，确保等 ICE restart 恢复后**有序送达** UI。

### 识别条件（硬编码，无状态）

```
frame.type === 'res' && frame.payload?.runId 顶层存在
```

- 不维护白名单表
- 不在 req 入口记 id↔method 映射
- 在 `send(jsonStr)` 内部 try-parse JSON，解析失败按非白名单处理（兜底）
- 仅看 res 帧顶层 `payload.runId`，不递归扫描嵌套字段（防止误命中）

### 为什么这条判定稳

OpenClaw 上游事实（详见 [agent-event-streams-and-rpcs.md §七](../../../docs/openclaw-research/agent-event-streams-and-rpcs.md#七res-帧协议事实)）：

- `agent` / `agent.wait` 全部 6 个 respond 分支 payload 顶层都含 runId（**期望被识别**，正是要保送的 agent run 响应）
- `chat.send` rsp 顶层也含 runId。**CoClaw UI 在斜杠命令路径调用 chat.send**（`ui/src/stores/chat.store.js:928`），其响应会被识别属 false positive，但响应帧只有几十字节、加白只是让小帧优先送达，无负面影响
- 还有几个方法的响应顶层含 runId 但 **CoClaw UI 不调**，因此不会出现在 send queue 里、不构成 false positive：
  - `send` / `poll`（`send.ts buildGatewayDeliveryPayload` 顶层第一字段即 runId）
  - `sessions.send` / `sessions.steer`（透传 chat.send 的 payload，spread 后含顶层 runId）
- UI 实际在用的其他 RPC（`sessions.list` / `sessions.get` / `sessions.reset` / `chat.history` / `agents.*` / `topics.*` / `models.*` / `status` / `usage.cost` / `channels.status` / `coclaw.*`）res payload 顶层均无 runId，**不会被白名单误识别**

### 豁免行为

- **绕过软上限 10MB 判定**：白名单消息直接入队，即使 `queueBytes >= MAX_QUEUE_BYTES`
- **仍受硬上限 50MB 约束**：白名单消息超过单条硬上限照样 drop（硬上限是接收端重组上限，超过无意义）
- **不计入 droppedCount/droppedBytes**：白名单消息绕过软上限时不算 drop
- **不影响 queueOverflowActive 翻转语义**：状态翻转仍基于 `queueBytes >= MAX` 判定，白名单消息让 queueBytes 进一步增长是有意设计

### 调用方接口不变

调用方（`broadcast` / `sendTo` / files RPC `sendFn`）仍调 `queue.send(jsonStr)`，不需要传额外参数。识别完全在 `send()` 内部完成。这避免了 `broadcast()` / `sendTo()` 的接口改动。

### probe-ack 故意绕过

`webrtc-peer.js:508-511` 中 probe 消息不走 RpcSendQueue，直接 `dc.send`：probe 用于测量传输层（SCTP/DTLS）健康，走应用层 queue 会把队列积压压力错误映射到"DC 不通"上。白名单逻辑也不影响这条独立路径。

## 与 FileBackedQueue 的关系

`RpcSendQueue` 是 MB 级的 DC 背压队列；`FileBackedQueue`（FBQ，详见 [rpc-dc-file-queue.md](./rpc-dc-file-queue.md)）是 GB 级长尾文件回退队列。两者前后串联（FBQ 已实施，与 RpcSendQueue 集成待定）：

```
producer ─enqueue─► FileBackedQueue ─consumer─► RpcSendQueue ─► DC
                    (GB 级长尾缓冲)             (MB 级 DC 背压)
```

集成后 FBQ 接管"长时间后台 / ICE 恢复"等慢消化场景的积压，RpcSendQueue 专注瞬时高水位流控。两者不替换、各司其职。

## API 摘要

```js
// 实例创建（webrtc-peer.js __setupDataChannel 内）
session.rpcSendQueue = new RpcSendQueue({
  dc,                    // DataChannel
  maxMessageSize,        // 对端 SDP 声明的 a=max-message-size
  getNextMsgId,          // 分片 msgId 生成器
  logger,                // pino 风格
  tag,                   // 诊断 tag（通常是 connId）
});

// 同步发送（fire-and-forget）
const accepted = queue.send(jsonStr);   // true=已入队/直发, false=被 drop

// 由 dc.onbufferedamountlow 触发
queue.onBufferedAmountLow();

// dc.onclose 调用（幂等）
queue.close();
```

## 关键源码锚点

| 内容 | 位置 |
|------|------|
| `RpcSendQueue` 实现 | `src/webrtc/rpc-send-queue.js` |
| 实例创建 | `src/webrtc/webrtc-peer.js:491-498` |
| `dc.onclose` close queue | `src/webrtc/webrtc-peer.js:548-558` |
| `broadcast()` 出口 | `src/webrtc/webrtc-peer.js:112-125` |
| `sendTo()` 单播出口 | `src/webrtc/webrtc-peer.js:134-146` |
| ICE restart 不重建 PC/DC | `src/webrtc/webrtc-peer.js:148-219` |
| 网关 ws → DC broadcast 透传 | `src/realtime-bridge.js:780-795` |
| files RPC sendFn 出口 | `src/webrtc/webrtc-peer.js:520-528` |

## 失败场景与接受边界

- **plugin daemon 重启**：内存队列必丢，不引入持久化（FBQ 也只缓冲已序列化 jsonStr，不跨进程）。这是已知接受场景
- **DC 物理死亡 + 队列内消息未发完**：close() 汇总 remoteLog 后丢弃；UI 端依赖主 RPC reject（信号 3）兜底感知
- **白名单消息让 queueBytes 持续增长**：理论上无界（每条都豁免软上限），但实际由网关广播频率和 agent run 数量自然封顶；硬上限 50MB 仍约束单条；若发现内存压力可监控 remoteLog 中的 `whitelisted message exceeded soft cap` 类信号（实施时按需添加）
