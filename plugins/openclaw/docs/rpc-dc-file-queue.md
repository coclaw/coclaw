# rpc DC 文件回退发送队列（FileBackedQueue）

> 状态：FBQ 已实施（`src/utils/file-backed-queue.js`，100% 覆盖）；与 `RpcSendQueue` 的集成待实施
> 创建：2026-04-20
> 更新：2026-04-22（深度 review 后的鲁棒性修正：id 校验/flat 路径、async init、diskBytes 派生、fsBroken 粘性降级、head 指针 O(1) shift）

## 背景与动机

插件向 rpc DC 发送消息时，通过 `src/webrtc/rpc-send-queue.js` 的 `RpcSendQueue` 做应用层流控。当前 `RpcSendQueue` 有 10 MB 软上限（`MAX_QUEUE_BYTES`），超过时新消息被 drop。

随着对 **ICE restart 保持/恢复连接** 的依赖加深，积压场景会更频繁：

- 移动端 UI 长时间后台 → 网络不通 → 插件侧消息持续产生
- ICE restart 期间 DC 可用但对端不可达
- 10 MB 对于一次较长的后台窗口很容易被打满，之后全部丢弃

目标：引入一个**按 rpc DC 粒度**的文件回退队列，把积压从"内存 10 MB 软上限"扩展到"磁盘 GB 级硬上限"，让大多数后台/ICE 恢复场景不再丢消息。

## 定位与方案总览

**前置而非替换**。两个队列各司其职：

```
producer ─enqueue─► FileBackedQueue ─consumer─► RpcSendQueue ─► DC
                    (GB 级长尾缓冲)             (MB 级 DC 背压)
```

- `RpcSendQueue` 保持不变——继续抵抗 DC `bufferedAmount` 的瞬时高水位，维持分片原子性和 fast-path 直发
- `FileBackedQueue` 只负责"无法在短时间内送入 DC 的大量积压"
- 消费循环从文件队列拉 jsonStr，在 `RpcSendQueue` 有容量时喂给它

不替换 `RpcSendQueue` 的原因：它承担的 DC-level 流控（1 MB 高水位 / 256 KB 低水位 / `onbufferedamountlow` 驱动 drain）与"长尾积压落盘"是两个正交关注点，合并会把分片、原子入队、fast-path 等稳定逻辑复杂化。

## 存储单位：jsonStr（非 chunks）

文件队列存**准备发给 DC 的 jsonStr 原串**，不存分片后的 chunks。原因：

- `maxMessageSize` 在 renegotiate 时可能变化，已落盘的 chunks 会因此失效
- `RpcSendQueue.send(jsonStr)` 接口本身就接收 jsonStr，消费侧直接透传即可
- **零序列化开销**：队列对消息是透明 pass-through，读写均是字符串
- JSONL 换行分隔无歧义：`JSON.stringify()` 永远把字符串中的 `\n` 转义成 `\n`（两字符），不会输出裸换行

## 接口

```js
class FileBackedQueue {
  constructor({ dir, id, memBudget, diskCap, onDrop, logger })

  async init()                    // 必须在首次 enqueue/consume 前调用；幂等

  async enqueue(jsonStr)          // 异步；失败返回 false 并触发 onDrop

  [Symbol.asyncIterator]()        // 消费侧：for await (const msg of queue) { ... }

  stats()                         // { memCount, memBytes, diskBytes, spilled, fsBroken }

  async destroy()                 // 停写、关 FD、删文件、结束所有迭代器；幂等
  async clear()                   // 清空但实例仍可用；同时清 fsBroken

  [Symbol.asyncDispose]()         // 可选：等价于 destroy()，支持 await using
}
```

### 构造参数

| 参数 | 含义 | 默认 |
|------|------|------|
| `dir` | 队列文件根目录 | 无默认，调用方提供 |
| `id` | 队列标识，用作文件名；字符集受限 `[A-Za-z0-9._-]+`，非 `.` `..` | 无默认 |
| `memBudget` | 内存持有字节数上限（软性，含 64B/条对象开销近似） | 8 MB |
| `diskCap` | 磁盘+内存总字节数硬上限（含分隔 `\n`） | 1 GB |
| `onDrop` | 拒入队时的回调 `(reason, size) => void` | 仅 warn |
| `logger` | pino 风格 logger | `console` |

### API 选择理由

- **构造纯字段初始化 + 显式异步 `init()`**：构造函数不触碰文件系统（零副作用、不阻塞 event loop），使用前需 `await q.init()` 完成残留清理；与 Node 流式 API（`createServer` 后 `listen()`、`createPool` 后 `initialize()`）的两阶段模式一致。首次溢出时才创建文件，维持 lazy 语义。
- **`destroy()` 而非 `close()`**：Node 生态里 `close()` 通常只关句柄不删文件（fs / sqlite / leveldb）。我们的场景是 PC 重建时整体清理，命名必须传达"彻底终结"。`destroy()` 与 Node streams 的"比 close 更狠的终结动作"语义方向一致。
- **`clear()` 而非 `purge()`**：与 `Map.clear` / `Set.clear` 对齐；同时重置 `fsBroken`，允许 FS 恢复后继续尝试落盘。
- **async iterator 消费模式**：消费循环代码最少，`destroy()` 让迭代器自然结束，原生支持 `break`/异常退出。优于手动 `while (!q.destroyed) { ... }` 轮询。

## 核心状态机

只有一个隐含状态：**文件里是否存在未消费数据**。铁律——**只要文件里还有未读数据，所有新消息就必须先写文件**。否则 FIFO 顺序被破坏。

### 入队

```
admission：若 memBytes + diskBytes + len(jsonStr) + 1 > diskCap
  → 拒绝，onDrop('disk-cap', size)，返回 false

if (!spilled) {
  if (pendingCount === 0 或 mem 容量够容纳本条)
    → 进内存队列   // safety valve：队列全空时首条无论多大都收，避免超大消息进退两难
}

若上一步没进 mem：
  if (fsBroken)
    → 拒绝，onDrop('fs-error', size)，返回 false   // 粘性降级，不再尝试 reopen
  if (!spilled)
    → 创建/打开文件；进入 spilled 状态
  追加到文件尾；失败则 onDrop('fs-error', size)
```

mem 容量判定包含 64B/条的对象开销估算，避免小消息洪水下 RSS 远超账面。

### 出队 / 消费

```
从内存头取一条交给消费者
取完后若 spilled 且内存有空间 → 异步 refill：
  从文件当前读 offset 流式读入若干行，推入内存，直到 memBudget 或 EOF
若 refill 读到 EOF 且读 offset 已追上写端 → 关文件、删文件，回到未溢出状态
```

### 不变量

- `memBytes + diskBytes + (size + 1) ≤ diskCap`（含待入条目的 `\n`）
- `diskBytes === writtenBytes - readOffset`（派生值，不单独维护）
- `spilled === true ⟺ 文件存在且有未消费字节`
- 所有 enqueue/dequeue/fs-error 清理均通过同一个 mutex 串行化，避免状态半截
- 崩溃导致的半截尾行：refill 时识别并丢弃，不影响前面

### FS 错误降级

写流 `'error'` 事件（异步）由 mutex 调度 `__handleFsError` 清理：关流、删文件、重置 `spilled/writtenBytes/readOffset`、置 `fsBroken=true`（粘性）、唤醒所有消费者。

- 此后溢出路径的 enqueue 全部 `drop('fs-error')`，不再尝试 reopen；
- 内存路径仍然可用，已在 mem 的消息继续交付；
- 上层应在感知降级后 destroy + 重建队列（或调 `clear()` 手动恢复尝试）；
- 粘性设计的理由：瞬时 FS 错误在 Node 环境下常指向系统性问题（fd 耗尽、磁盘满、权限变化），静默重试风暴只会掩盖根因。

## 落盘布局

```
{dir}/{id}.jsonl        一条消息一行，尾部 '\n'
```

- 单文件，无子目录层级；`id` 经字符集校验后直接拼接，杜绝路径穿越
- **不持久化读指针**：读 offset 仅在内存
- **不跨生命周期复用**：`init()` 会异步清除同名残留文件（PC 重建时上层会新建 id，不会复用旧文件；但防御性清理残留）
- **写侧**：首次溢出时 lazy 打开 append 写流，`destroy()` / `clear()` / `__handleFsError` 时关闭并删除文件
- **读侧**：refill 时按需开 read stream 从 offset 读行

## 与 `RpcSendQueue` 的集成

### 需要对 `RpcSendQueue` 做的小改动

当前 `RpcSendQueue.send()` 返回 `false` 只在 `queueBytes ≥ MAX_QUEUE_BYTES` 时。消费循环要知道何时可以继续投递。新增：

- **`canAccept()` getter**：返回 `queueBytes < MAX_QUEUE_BYTES` 且未关闭
- **`onAcceptResumed` 事件/回调**：`queueBytes` 跨过"满→可接受"阈值时触发

消费循环：

```js
for await (const jsonStr of fbq) {
  while (!rpcSendQueue.canAccept()) {
    await once(rpcSendQueue, 'acceptResumed');  // 或 Promise 风格
  }
  rpcSendQueue.send(jsonStr);
}
```

### 生产者改动

当前同步调用点（`broadcast()` / `sendTo()` / files RPC 响应）改为：

```js
// 旧
rpcSendQueue.send(JSON.stringify(msg));

// 新
fbq.enqueue(JSON.stringify(msg)).catch(err => logger.warn?.(...));
```

- `enqueue()` 返回 Promise，按 fire-and-forget 处理，必须 `.catch()`（符合插件 CLAUDE.md 的 "fire-and-forget 必须 `.catch()`" 规范）
- **probe-ack 路径保持旁路**：继续直接 `dc.send()`，不经过文件队列和 `RpcSendQueue`，保留"仅测量传输层健康"的语义

### 生命周期对齐

| 事件 | 现行（RpcSendQueue 单独存在） | 新（两队列并存） |
|------|------|------|
| rpc DC open | 创建 `RpcSendQueue` | 创建 `RpcSendQueue` + `FileBackedQueue`（文件 lazy）；启动消费循环 |
| ICE restart | 保留队列实例 + 队列内容 | 两者都保留 |
| rpc DC close | `RpcSendQueue.close()` | `RpcSendQueue.close()` + `FileBackedQueue.destroy()`（删文件、结束消费循环）|
| `closeByConnId` | 同上 | 同上 |

`FileBackedQueue` 的 `id` 用 `connId`（必须匹配 `[A-Za-z0-9._-]+`——UUID 形式天然满足），目录建议 `~/.openclaw/coclaw/rpc-queue/`（走 `resolveStateDir()`，与 bindings.json 同根）；文件形如 `~/.openclaw/coclaw/rpc-queue/{connId}.jsonl`。

## 相邻隐患（非本方案引入，顺带记录）

`RpcSendQueue.send()` 的 fast-path 循环中，若 `dc.send(chunks[i])` 抛异常，当前实现直接 `return false`，**已发出去的 i-1 个 chunk 留在线上，剩余 chunk 既不入队也不补发**。接收端 reassembler 会收到永远等不到尾巴的半截消息。

- 触发条件窄：`dc.send` 抛通常意味着 DC 已经要关，实际影响小
- 本方案不修，但引入 `FileBackedQueue` 后消费循环能感知到 `send()` 返回 false，可在此基础上补一层"失败回退到文件"——作为后续增强项

## 故意不做的事

- **跨进程重启的持久化**：插件崩溃/重启后，文件里的旧消息直接丢弃。对端 PC 已失效，陈旧消息送到新对端无意义。
- **跨 PC 复用队列**：一个 rpc DC 对应一个队列实例；PC 重建整体重来。理论上可扩展，但 RTC 的 SCTP 发送缓冲本身就无法回收"已送入 libdatachannel/werift 但未到达对端"的数据，做不到真正的零丢失，收益不匹配复杂度。
- **消息送达保证**：与 `RpcSendQueue` 一致，fire-and-forget。

## 默认参数依据

- **`memBudget = 8 MB`**：略小于 `RpcSendQueue` 的 10 MB 软上限。两者叠加的内存占用约 18 MB/连接，可接受。
- **`diskCap = 1 GB`**：对一条 rpc DC 的长尾积压足够；移动设备/服务器均不会因此逼近存储上限。
- **无 lowWaterMark**：队列头从内存弹，尾往文件追加，没有"抖动"风险，refill 由单次 dequeue 触发即可，不需要双阈值。

## 测试

遵循插件覆盖率门禁（lines 100% / functions 100% / branches 95% / statements 100%）。核心用例：

1. **纯内存路径**：enqueue / 迭代消费 / stats / clear / destroy
2. **溢出路径**：触发 spill → 继续 enqueue 走文件 → 消费清空 memory → refill → 文件 drain 完删文件 → 回到未溢出
3. **FIFO 不变量**：跨越 spill 边界、refill 边界、clear 后重新 enqueue，消费顺序必须与入队顺序一致
4. **磁盘上限**：构造满文件后 enqueue 返回 false + onDrop 触发，不抛错
5. **崩溃残留**：构造尾行半截的文件，`refill` 丢弃末行且消费前面的行
6. **destroy 幂等**：多次 `destroy()` 不抛；`destroy()` 后 enqueue 返回 false；进行中的迭代器 `for await` 自然结束
7. **clear 语义**：清空后实例仍可继续 enqueue；文件删除；`fsBroken` 复位
8. **id 校验**：`..`、`/`、`\`、`\0`、空格等非法字符在构造期抛 `TypeError`
9. **init 幂等**：重复 `init()` 无副作用；`init` 前调用 `enqueue` 抛 `queue not initialized`
10. **FS 错误降级（关键回归）**：异步 `writeStream.on('error')` 后，即使"未成功落盘任何字节"场景下，consumer 也不会卡死；后续溢出 enqueue drop `fs-error`；`fsBroken=true`
11. **head 指针压缩**：大量 mem enqueue+消费后 `memQueue.length` 收敛，不线性增长
12. **集成测试**：与修改后的 `RpcSendQueue` 组合，验证 canAccept 反压流正确、生命周期对齐、ICE restart 保留、DC close 销毁

## 文件清单（预期）

```
plugins/openclaw/src/utils/
├── file-backed-queue.js             # 已完成
└── file-backed-queue.test.js        # 已完成

plugins/openclaw/src/webrtc/
├── rpc-send-queue.js                # 待改：新增 canAccept / acceptResumed
├── rpc-send-queue.test.js           # 待改：补新接口测试
├── webrtc-peer.js                   # 待改：session 上挂 fileBackedQueue；生产者改走 enqueue
└── webrtc-peer.test.js              # 待改：生命周期 / ICE restart / close 集成断言
```

> 队列本身放在 `src/utils/`——作为业务无关纯工具，与 `atomic-write.js` / `mutex.js` 并列。WebRTC 集成侧逻辑另开文件挂接。

## 后续扩展（不在本次范围）

- `RpcSendQueue.send()` fast-path 失败时回退到文件队列
- 多 rpc DC 共享文件队列（用于跨 PC 恢复的极限场景）
- 导出队列状态到 `remoteLog`，用于可观测性
