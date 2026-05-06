# rpc DC 文件回退发送队列（FileBackedQueue）

> 状态：B-stage2 已实施。**当前生产默认 `MemoryQueue`**（FBQ 未充分本地验证前的紧急回退）；FBQ 装配路径在代码 + 测试中保留，模块级常量翻一行即可激活。详见 [rpc-dc-send-queue.md](./rpc-dc-send-queue.md) "队列实现选择"。
> 创建：2026-04-20
> 关键里程碑：plan-1（监视器外置） → plan-2（启动期 prep） → B-stage2（单点平替 FBQ）。详见末尾"演进史"章节。

## 背景与动机

插件向 rpc DC 发送消息时，通过 `src/webrtc/rpc-send-queue.js` 的 `RpcSendQueue` 做应用层流控。当前 `RpcSendQueue` 有 10 MB 软上限（`MAX_QUEUE_BYTES`），超过时新消息被 drop。

随着对 **ICE restart 保持/恢复连接** 的依赖加深，积压场景会更频繁：

- 移动端 UI 长时间后台 → 网络不通 → 插件侧消息持续产生
- ICE restart 期间 DC 可用但对端不可达
- 10 MB 对于一次较长的后台窗口很容易被打满，之后全部丢弃

目标：引入一个**按 rpc DC 粒度**的文件回退队列，把积压从"内存 10 MB 软上限"扩展到"磁盘 GB 级硬上限"，让大多数后台/ICE 恢复场景不再丢消息。

## 定位与方案总览

**单缓冲模型**：FBQ 是 rpc DC 路径上的唯一应用层缓冲，原 `RpcSendQueue` 重构为无应用层缓冲的发送器（更名 `RpcDcSender`）。整个发送路径形成经典的 `producer → queue → blocking writer` 模式：

```
producer → fbq.enqueue(str) → [for await of fbq] → await sender.send(str) → DC
                              (mem 8MB → disk 1GB)   (分片 + DC bufferedAmount 背压)
```

各组件分工：

- **`FileBackedQueue`**（`src/utils/file-backed-queue.js`）：业务无关的字符串容器，FIFO；mem 优先，超 `memBudget` 落盘；admission/drop 全在自己内部
- **`RpcDcSender`**（`src/webrtc/rpc-dc-sender.js`，重构自 `RpcSendQueue`）：贴着 DC 的发送器；分片、fast-path、`bufferedAmount` 背压；**不持有应用层缓冲**——`send()` 是阻塞式 socket-like 接口，DC 满就 await `bufferedamountlow`
- **消费循环**：`for await (const str of fbq) { await sender.send(str); }`——把两者串起来

### 心智模型：阻塞式 socket

对调用方而言，发送路径相当于：

```
fbq.enqueue(str)             // ≈ 应用层 mailbox
  ↓
for await (const str of fbq) // ≈ 后台 writer 流
  ↓
await sender.send(str)       // ≈ 阻塞式 socket.write()
```

`sender.send()` 等价于 Unix 上的阻塞式 `socket.send()`：

- 内核 send buffer 满 → 阻塞；DC `bufferedAmount` 满 → await `bufferedamountlow`
- 缓冲降下来 → 写入 → 返回；返回 = "已交给底层，后续不归我管"
- 唯一区别：DataChannel 没有透明分片（`max-message-size` 是应用层硬限），分片由 `RpcDcSender` 内部完成、对调用方不可见

### 早期方案（已废弃）

早期讨论曾考虑"前置不替换"模型——保留 `RpcSendQueue` 的 10 MB 内存队列，FBQ 串联在前。这个模型导致**两个独立的应用层缓冲并存**，每个都有自己的 admission / 水位 / 边沿日志，需要互相协调（`canAccept` / `acceptResumed` 接口）才能反压。最终采纳的单缓冲模型把"容器"职责完全收敛到 FBQ、把"贴 DC 发送"职责完全收敛到 sender，两者通过经典 queue + blocking writer 模式串联，状态机大幅简化。

## 存储单位：jsonStr（非 chunks）

文件队列存**准备发给 DC 的 jsonStr 原串**，不存分片后的 chunks。原因：

- `maxMessageSize` 在 renegotiate 时可能变化，已落盘的 chunks 会因此失效
- `RpcSendQueue.send(jsonStr)` 接口本身就接收 jsonStr，消费侧直接透传即可
- **零序列化开销**：队列对消息是透明 pass-through，读写均是字符串
- JSONL 换行分隔无歧义：`JSON.stringify()` 永远把字符串中的 `\n` 转义成 `\n`（两字符），不会输出裸换行

## 接口（B-stage2 完整契约）

```js
class FileBackedQueue {
  constructor({
    dir, id,
    memBudget,         // 内存持有字节数上限（默认 8 MB；webrtc-peer 装配时显式传 10 MB）
    diskCap,           // mem + disk 总字节数硬上限（默认 1 GB）
    maxMessageBytes,   // 单条硬上限（默认 Infinity；webrtc-peer 装配时显式传 50 MB）
    bypassAdmission,   // 谓词，命中则容量层 admission 豁免（不豁免 oversize / 物理 IO 失败）
    onDrop,            // (reason, size, err?) => void —— 'fs-error' 透传底层 err
    logger,
  })

  async init()                          // 必须在首次 enqueue/consume 前调用；幂等
  async enqueue(jsonStr)                // 异步；失败返回 false 并触发 onDrop
  [Symbol.asyncIterator]()              // 消费侧：for await (const msg of queue) { ... }
  stats()                               // { memCount, memBytes, diskBytes, writtenBytes, spilled, fsBroken }
  async destroy(onBeforeClear?)         // 停写、关 FD、删文件、结束所有迭代器；幂等。onBeforeClear 是同步钩子
  async clear()                         // 清空但实例仍可用；同时清 fsBroken / lastFsErr
  [Symbol.asyncDispose]()               // 等价于 destroy()，支持 await using
}
```

### 构造参数

| 参数 | 含义 | 默认 |
|------|------|------|
| `dir` | 队列文件根目录 | 无默认，调用方提供 |
| `id` | 队列标识，用作文件名；字符集受限 `[A-Za-z0-9._-]+`，非 `.` `..` | 无默认 |
| `memBudget` | 内存持有字节数上限（软性，含 64B/条对象开销近似）；必须是有限正数 | 8 MB |
| `diskCap` | mem + disk 总字节数硬上限（含分隔 `\n`）；必须是有限正数 | 1 GB |
| `maxMessageBytes` | 单条字节硬上限；超过即 drop（bypass 也不豁免）；必须是 `Infinity` 或有限正数 | `Infinity` |
| `bypassAdmission` | 白名单谓词 `(jsonStr) => boolean`，命中则容量层 admission 豁免；非函数收编为 null | 无 |
| `onDrop` | 拒入队回调 `(reason, size, err?) => void`；仅 `'fs-error'` reason 透传第三参 err | 仅 warn |
| `logger` | pino 风格 logger | `console` |

`memBudget` / `diskCap` / `maxMessageBytes` 在构造时 fail-fast：`Number.isFinite` 且 `> 0`，否则抛 `TypeError`（`maxMessageBytes` 额外允许 `Infinity`）。此约束避免 `NaN` 等退化值让 admission `>` 比较恒假、变相绕过硬上限。

`bypassAdmission` 非函数（含 undefined / null / 字符串等）一律收编为 null，保持向后兼容；谓词自身抛错时**保守 false**（视为非白名单 → drop），避免谓词 bug 让消息异常入队。

## 接口红线（B-stage2 稳定契约）

下面 7 条是**跨实现细节稳定的契约**，FBQ 与 MemoryQueue 共同遵守，未来重构都不应破坏：

### 1. 业务无关容器

谓词、路径、容量等业务相关参数全部从外部注入。FBQ / MemoryQueue 不内置任何业务规则——`bypassAdmission` 由调用方决定哪些消息白名单（webrtc-peer 装配时注入 `isAgentRunResponse`）；`onDrop` 由调用方决定 drop 怎么诊断；`dir` / `id` / `maxMessageBytes` 都是注入的。

**违反代价**：业务规则下沉到容器层会让"FBQ 切换到别的存储"或"换队列实现做实验"变得几乎不可能。

### 2. 丢失 / 延迟必须 loud 可观测

凡是连接活着但消息被拒收（oversize / queue-full / disk-cap / fs-error），必须经 `onDrop(reason, size, err?)` loud 上报，让外置 monitor 边沿状态机捕获。

**唯一例外（设计意图）**：`destroyed` 短路是 silent drop——`destroyed=true` 后 enqueue 直接返 false 且**不触发 onDrop**。理由：destroyed 意味着对应连接已死 / 正在清理，drop 是正确清理副作用，不需要 noisy 日志。loud-on-loss 红线只对"连接活着但拒收"场景生效。

### 3. bypassAdmission 仅豁免容量层 admission

白名单只豁免 `memBytes + writtenBytes + size > diskCap` 这条容量短路；**不豁免**单条上限（oversize）、**不豁免**物理 IO 失败（fsBroken）。

理由：单条上限对应接收端重组上限（DC 帧硬限），白名单消息超 50 MB 也无法被对端重组——豁免毫无意义；物理 IO 失败是硬故障，强行入队会让 backlog 假装存在但永远发不出去。

### 4. agent run 类响应识别条件硬编码

谓词形态固定为 `frame.type === 'res' && frame.payload?.runId 顶层存在`，**不扩到 lifecycle:end**。OpenClaw 一次 run 会 emit 多次 lifecycle:end（compaction-retry / model-fallback），扩进白名单会让 lifecycle 信号也越过软上限，破坏 admission 语义。

详见 [rpc-dc-send-queue.md](./rpc-dc-send-queue.md) "agent run 类 RPC 响应：admission bypass" 章节。

### 5. destroy onBeforeClear 是同步钩子

`destroy(onBeforeClear)` 在 mutex 内、`destroyed=true` 之后、清理 IO 之前**同步**调用钩子。钩子同步抛错被 swallow（不传染 destroy 契约）；**钩子返回 Promise 时其 rejection 不被捕获**——这是 silent gotcha，与 MemoryQueue 完全一致。调用方必须传同步函数。

理由：destroy 路径本身要求确定性结束（webrtc-peer 多处裸 await `rpcQueue.destroy`），不能让钩子的异步异常让 destroy reject 冒泡破坏 close 流程。这条限制保证四件套清理永远成功。

### 6. diskCap 走 deps 注入

bridge 启动期一次性测得 diskCap 后通过 `getDiskCap` fn deps 注入 webrtc-peer，FBQ 装配时调用取值。**不走 runtime getter / bridge 引用**——deps 注入的好处是可在测试中 mock 各分支（充裕 / 紧张 / 失败）。

null 兜底（`getDiskCap?.() ?? ONE_GB`）走 1 GB——保证 FBQ 在测得失败时仍能装配运行，不阻塞。

### 7. 同 connId race 在 FBQ 文件层隔离

FBQ id 加唯一后缀 `${connId}-${ts}-<uuid8>`，物理文件名隔离。**不入侵 webrtc-peer 信令路径**（不加 per-connId mutex / pendingClose Map），保持装配代码最小。详见下文"同 connId race 隔离设计"。

### API 选择理由

- **构造纯字段初始化 + 显式异步 `init()`**：构造函数不触碰文件系统（零副作用、不阻塞 event loop），使用前需 `await q.init()` 完成残留清理；与 Node 流式 API（`createServer` 后 `listen()`、`createPool` 后 `initialize()`）的两阶段模式一致。首次溢出时才创建文件，维持 lazy 语义。
- **`destroy()` 而非 `close()`**：Node 生态里 `close()` 通常只关句柄不删文件（fs / sqlite / leveldb）。我们的场景是 PC 重建时整体清理，命名必须传达"彻底终结"。`destroy()` 与 Node streams 的"比 close 更狠的终结动作"语义方向一致。
- **`clear()` 而非 `purge()`**：与 `Map.clear` / `Set.clear` 对齐；同时重置 `fsBroken`，允许 FS 恢复后继续尝试落盘。
- **async iterator 消费模式**：消费循环代码最少，`destroy()` 让迭代器自然结束，原生支持 `break`/异常退出。优于手动 `while (!q.destroyed) { ... }` 轮询。

## 核心状态机

只有一个隐含状态：**文件里是否存在未消费数据**。铁律——**只要文件里还有未读数据，所有新消息就必须先写文件**。否则 FIFO 顺序被破坏。

### 入队

```
admission：若 memBytes + writtenBytes + len(jsonStr) + 1 > diskCap
  → 拒绝，onDrop('disk-cap', size)，返回 false
  （writtenBytes 是本次生命周期累计已写字节，在完全 drain 或 FS 降级时重置为 0）

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

- `memBytes + writtenBytes + (size + 1) ≤ diskCap`（含待入条目的 `\n`；以物理占用为准）
- `writtenBytes` 只在完全 drain（`__dropFile`）或 FS 降级（`__handleFsError`）时重置为 0
- `diskBytes === writtenBytes - readOffset`（暴露给消费者的 backlog 指标，派生值）
- `spilled === true ⟺ 文件存在且有未消费字节`
- 所有 enqueue/dequeue/fs-error 清理均通过同一个 mutex 串行化，避免状态半截
- 崩溃导致的半截尾行：refill 时识别并丢弃，不影响前面

**diskCap 语义**：硬上限指的是**物理文件 + 内存的总占用**，而不是 backlog（未消费字节）。代价是：持续背压场景下即便消费者在追赶，只要消费者还没追上写端触发 `__dropFile` 重置，admission 就持续以"已写总量"判定，可能 drop 部分新消息。这是有意选择，保证 diskCap 是真正的"磁盘不会超过这个数"。

### FS 错误降级

任何 FS 错误都收敛到 `__handleFsError`（mutex 内）：关流、删文件、重置 `spilled/writtenBytes/readOffset`、置 `fsBroken=true`（粘性）、唤醒所有消费者。触发路径包括：

- **写侧 `'error'` 事件**（异步）：listener 排队到 mutex 调度；
- **写侧前置 FS 失败**（`mkdir` / `rm`）：enqueue 检测到 `writeErr` 后直接在当前锁内调用；
- **写侧 `write` 回调 err**：enqueue 的 catch 块直接调用（覆盖 monkey-patch / cb 不 emit error 的路径）；
- **读侧 `stat` / 读流错误**（外部删文件、权限丢失等）：refill 的 catch 块调用，避免 `spilled=true / fsBroken=false` 的悬空态让消费者永久挂 waiter。

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
- **权限**：POSIX 下以 `0o700` 创建目录、`0o600` 创建文件（best-effort）。**已存在的目录不会被 chmod 收紧**——依赖其既有权限；**Windows** 下 mode 参数无 owner/group/other 语义，访问控制实际由父目录 NTFS ACL 决定。调用方若把 `dir` 放在可由其他本机用户读的目录下，需要自行保证目录权限

## 集成方案

### 队列文件存储位置

`FileBackedQueue` 的 `id` 用 `connId`（必须匹配 `[A-Za-z0-9._-]+`——UUID 形式天然满足），目录定为 `~/.openclaw/coclaw/rpc-queues/`：

- 走 `resolveStateDir() + CHANNEL_ID + 子目录` 约定，与 `bindings.json` 同根
- 复数命名 `rpc-queues/`，与既有 `chat-files/` / `topic-files/` 风格一致
- 一条 rpc DC 对应一个文件，路径形如 `~/.openclaw/coclaw/rpc-queues/{connId}.jsonl`

不再多套一层 `queues/rpc/`——眼下只有一种队列，YAGNI。

### 启动残留清理

**落点**：`coclaw-realtime-bridge` service 的 `start()` 开头，`this.started=true` 之后、`__preloadWebrtc()` 之前；封装在 `src/rpc-queue-startup.js` 的 `cleanupResiduals()`。

`start()` 自身按 async 顺序 await（清理完才进 RTC 准备）；远早于"第一次 rpc DC 建立"——后者要等 gateway WS 握手 + server 配对 UI + ICE 协商，链路最少几百 ms。bridge restart（unbind/bind 来回切）会再清一次，顺带覆盖账户切换后的旧残留。**不需要同步 fs**。

行为：

```
mkdir -p rpc-queues/
readdir rpc-queues/
filter *.jsonl    // 白名单，禁止一锅端整目录
逐个 unlink；单文件失败 → warn 跳过，不阻断 start
```

约束：

- **白名单删 `*.jsonl`**，不动其它文件，禁止 `rm -rf rpc-queues/`。预留未来在该目录放小账本（如 disk-cap drop 累计计数）的扩展空间
- **单文件 unlink 失败 warn + 跳过**：权限怪文件不能把 bridge.start 卡死
- CLI 上下文不会触发清理（plugin register 在 `mode !== 'full'` 时提前 return），天然规避 CLI ↔ gateway 并发竞争

### diskCap 自适应

封装在 `src/rpc-queue-startup.js` 的 `measureDiskCap()`，结果存到 `bridge.__diskCap`，通过 `getDiskCap: () => this.__diskCap` deps 注入 webrtc-peer 构造（B-stage2 决策 6：deps 注入而非 runtime getter，可在测试中显式 mock 各分支）。

启动清理完成后，对 `rpc-queues/` 目录做一次 `fs.statfs`（Node 18.15+ 提供，目标运行环境为 Node 20+），按可用空间动态计算每条 DC 的 `diskCap`：

```js
diskCap = min(1 GB, max(64 MB, free × 50%))
```

**思路**：

- 默认 1 GB，但磁盘临界（如剩余 < 2 GB）时自动收紧
- 留 50% 余量给系统其他用途——开机瞬间 free 不能代表运行期 free（用户可能下载、压缩、装软件）
- 下限 64 MB：哪怕磁盘极端紧张也保留最低缓冲容量

**为什么用 `rpc-queues/` 自己做 statfs**：自动定位到该路径所在的文件系统——即便用户把 `coclaw/` 单独挂载到某个分区上，结果也准确。

**只查一次**：避免 enqueue 热路径承担 syscall。运行期完全不查盘。

**跨平台**（`fs.statfs`，Node 18.15+ 提供，目标运行环境为 Node 20+）：

| 平台 | 实现 | 备注 |
|------|------|------|
| Linux | 直通 `statvfs(2)` | 字段全 |
| macOS | 直通 `statvfs(2)` | 字段全 |
| Windows | `GetDiskFreeSpaceExW` 模拟 | inode 字段是假的，但 `bavail × bsize` 真值 |

只取 `bavail × bsize`（可用字节），三平台都为真值。**失败回退**：statfs 抛错（ENOSYS / 容器特殊文件系统等怪环境）→ catch + warn + 回退固定 1 GB，**不让查盘失败成为 bridge.start 的阻断点**。

### 磁盘真打满的兜底

**集成层不在运行期做任何 statfs / 剩余空间检查**。完全依赖 FBQ 自身已有的 `__handleFsError`（`file-backed-queue.js:377`）：写入失败（包括 ENOSPC）触发后

1. 立刻关闭写流
2. `fs.rm` 删除当前队列文件 → **磁盘空间瞬间释放**
3. 进 `fsBroken` 粘性降级；后续溢出 enqueue 全部 drop

为什么不加预防式检查：

- 1 GB 上限本身已是相对用户磁盘红线足够小的保护
- ENOSPC 兜底是"自杀式释放"——磁盘真满时立刻让出空间，比预防式检查更可靠（预防式两次检查之间一样可能打满）
- 加运行期检查会增加复杂度（频次、阈值、测试 mock）但收益有限

不设**插件级总盘上限**作为有意识的接受场景：N 条并发 DC 理论占盘 = N × 单 DC `diskCap`，实际由 UI 在线数自然封顶（移动端通常 N ≤ 10）。通过 remoteLog 中 `disk-cap` drop 频率监控，超出预期再加。

### onDrop 风暴防护

FBQ 的两类 drop 都可能持续高频：`disk-cap`（盘到顶后每条新消息都 drop 一次）、`fs-error`（进 `fsBroken` 后每次溢出都 drop）。如果 `onDrop` 直接 `remoteLog`，长时间后台 + 大量推送的场景下能把 remoteLog 通道刷爆。

**对齐 `RpcSendQueue` 现有风格**——空→满 / 满→空 状态翻转点打一次，期间静默累加。**实现位置：集成层包一层 `onDrop` wrapper，FBQ 模块本身保持业务无关**。每条 DC 一个 wrapper 实例，状态独立。

#### 上报状态机

| 事件 | 上报时机 |
|------|---------|
| 第一次 `disk-cap` drop | 边沿：`fbq.disk-cap-start connId=X` |
| 持续 `disk-cap` drop | **静默累加** `droppedCount` / `droppedBytes` |
| **队列彻底清空**（`memCount === 0 && writtenBytes === 0`）且仍处于 disk-cap 命中状态 | 边沿：`fbq.disk-cap-end connId=X count=N bytes=M`，清零累计 |
| DC close / queue destroy 时仍处于 disk-cap 命中 | 兜底：同上格式打一次 summary |
| 第一次 `fs-error` drop（首次进 `fsBroken`） | `fbq.fs-broken connId=X` |
| 后续 `fs-error` drop | **静默累加** |
| destroy / clear（复位 `fsBroken`） | `fbq.fs-error-summary connId=X count=N bytes=M` |

#### "恢复"判定 = 队列彻底空

判定 `disk-cap-end` 边沿的条件取**最严格**的"队列空"——`memCount === 0 && writtenBytes === 0`（mem 和盘上未消费部分都为 0）。

为什么这是抗抖动 + 抗刷屏的最优解：

- **抖动几乎不可能触发**：要让 wrapper 在运行期反复打 start/end，必须经历"彻底清空 → 重新积压满 1 GB（diskCap）"。这是几分钟级的循环，不可能"每秒抖几次"
- **临界稳态下不刷屏**：贴边界工作（队列卡在 95% 高位反复 admission）时永远不满足"彻底空"——`disk-cap-end` 不打、新 drop 静默累加，刷屏被根除
- **没漏告警**：start 已通知运维异常出现；中间 admission 偶尔通过的小消息 enqueue 成功不会有新 drop（不刷屏），运维通过"start 之后没有新 drop 日志"也能间接判断已恢复
- **运行期及时性**：rpc DC 长生命周期内（ICE restart 不 close）队列彻底闲下来过一次就能打 end，不必拖到 DC close

> 候选其他方案（"第一次 enqueue 成功"翻转 / spilled 翻 false 翻转 / 仅 close 时 summary）在抖动概率、实现复杂度、信号及时性三者上都不如本方案——评估过程见提交历史。

#### 其它

- broadcast 群发场景下 N 条 DC 同时 drop 同一条消息会打 N 行 remoteLog——和 `RpcSendQueue` 现状一致，本方案不处理

### `RpcSendQueue` 重构为 `RpcDcSender`

文件位置：`src/webrtc/rpc-send-queue.js` → `src/webrtc/rpc-dc-sender.js`（连同 `.test.js` 一起重命名）。

**砍掉**：

- 应用层 10 MB 内存队列（`queue` / `queueBytes`）及其 admission
- `queueOverflowActive` 状态翻转
- `droppedCount` / `droppedBytes` 统计
- agent run 响应白名单豁免（FBQ 1 GB 上限下意义不大）

**保留**：

- DC 引用、`maxMessageSize`、`getNextMsgId`、`tag`、`logger`
- 分片（`buildChunks`）
- fast-path（DC 当前空着同步直发）
- `bufferedAmount` 背压（DC 满时 await `bufferedamountlow`）
- `closed` flag + 主动 reject waiter 的 close 协议（抛 `SENDER_CLOSED`）

**接口形态**：

```js
new RpcDcSender({ dc, maxMessageSize, getNextMsgId, logger, tag })
await sender.send(jsonStr)   // async：阻塞式 socket-like，DC 满就 await bufferedamountlow
sender.close()               // 幂等：清 listener + 唤醒所有 waiter
```

### 消费循环 + 优雅退出

每条 rpc DC 一个独立循环（DC 之间互不阻塞）。循环代码：

```js
for await (const str of fbq) {
  try {
    await sender.send(str);
  } catch (err) {
    if (err.code === 'SENDER_CLOSED') break;
    // 业务错误（如单条 oversize）：log 后继续，不阻断后续消息
    logger.warn?.(`rpc-dc.send-failed code=${err.code} size=${str.length} ...`);
  }
}
```

#### 退出协议（精确分工）

| 信号源 | 触发动作 | 循环响应 |
|--------|---------|---------|
| `fbq.destroy()` | iterator next 返回 `{ done: true }` | `for-await` **自动结束**——循环代码无需写任何东西 |
| `sender.close()` | 正在 await 的 `send` 抛 `SENDER_CLOSED` | catch 后 **显式 `break`** |

DC close handler 同时调两个：

```js
dc.onclose = () => {
  sender.close();
  fbq.destroy();
};
```

顺序无所谓——两边都 close-aware：
- `sender.close` 先：循环 catch `SENDER_CLOSED` break
- `fbq.destroy` 先：iterator 返回 done 自然结束

任何异常路径（DC 异常关、PC 重建、bridge 重启）触发，循环都不会僵死。

#### 单条消息发送失败

`sender.send` 抛错而非 silent drop——一致性上对齐阻塞式 socket 语义（"发不出去"应让调用方感知），错误日志在循环 catch 处统一打更便于带上下文（connId、消息大小、前几个字节）。当前已知的非 `SENDER_CLOSED` 错误：

| `err.code` | 触发 | 处理 |
|-----------|------|------|
| `MESSAGE_OVERSIZED` | 单条 > `MAX_SINGLE_MSG_BYTES`（50 MB，对端重组上限） | log + 跳过；后续消息继续 |
| `BUILD_CHUNKS_FAILED` | 分片失败（如 `maxMessageSize` 异常） | 同上 |

实际场景下 50 MB rpc 消息几乎不会发生（文件传输走专用 file DC，rpc 消息通常远小于 MB），但作为兜底必须存在。

#### 关键约束（容易踩坑）

- `sender.send` 里 await `bufferedamountlow` 的 Promise **必须在 `close()` 时被主动 reject**（带 `SENDER_CLOSED` code）——否则 DC 关掉后事件不再触发，那个 await 永远等不到，循环僵死
- **退出语义统一为"抛错"**：sender 不允许 silent return（close 后 send 静默 resolve）——会导致 sender 死、fbq 活的窗口期内循环空转 silent loss。所有"发不出去"统一抛错，由循环 catch 区分 `SENDER_CLOSED`（break）和业务错误（log + 继续）
- `fbq.destroy()` 返回 `{ done: true }` 而非抛错——符合 ECMAScript `for-await` 协议（Node Stream / Web ReadableStream 主流"关闭"语义）；FBQ 的真正异常路径靠 `fsBroken` 状态表达，不混在 destroy 里
- 不在循环里手写 `if (closed) break`——退出由两条上游各自的"关闭信号"驱动，循环代码内部只负责区分"sender 死"与"业务单条失败"

### 生产者改造

| 调用点 | 现状 | 改造后 |
|--------|------|--------|
| `webrtc-peer.js:112-125` `broadcast()` | `rpcSendQueue.send(jsonStr)` 同步 | `fbq.enqueue(jsonStr).catch(...)` fire-and-forget |
| `webrtc-peer.js:134-146` `sendTo()` | 同上 | 同上 |
| `webrtc-peer.js:520-528` files RPC `sendFn` | 同上 | 同上 |
| `realtime-bridge.js:780-795` gateway ws → DC 透传 | 同上 | 同上 |
| `webrtc-peer.js:508-511` probe-ack | `dc.send(...)` 直发 | **保持不变，旁路** |

- `enqueue()` 返回 Promise，按 fire-and-forget 处理，必须 `.catch()`（符合插件 CLAUDE.md 规范）
- **probe-ack 路径继续旁路**：不经 FBQ、不经 sender，直接 `dc.send()`，保留"仅测量传输层健康"语义

### 生命周期对齐

| 事件 | 动作 |
|------|------|
| rpc DC open | 创建 `RpcDcSender` + `FileBackedQueue`（await `init()`），启动消费循环 |
| ICE restart | 两者都保留实例与内容（详见下文"自动性"） |
| rpc DC close | `sender.close()` + `fbq.destroy()`；消费循环按退出协议结束 |
| `closeByConnId` | 同上 |
| PC 重建（新 connId） | 旧 PC 上的 DC 自然 close → 复用 DC close handler；新 PC 起新 FBQ + 新 sender |
| bridge restart（unbind/bind） | 上一轮 DC 已 close；`start()` 时再触发一次启动清理把残留 jsonl 全删 |

#### ICE restart 与 PC 重建的"自动性"

这两种恢复场景**不需要任何额外业务代码**——经典 blocking writer 模式 + 已有的 close 路径自然覆盖：

**ICE restart**（连接没死，只是网络路径换了）：

- DC 实例 + sender 实例 + FBQ 实例全部保留
- ICE 期间 DC.readyState 仍是 `'open'`，但底层 SCTP 收不到 ack → `bufferedAmount` 不降 → `sender.send` 自动卡在 await `bufferedamountlow`
- 消费循环自动挂起；ICE 恢复后 `bufferedAmount` 开始降，`bufferedamountlow` 触发，sender 自动续上
- **不需要写"ICE 期间暂停消费"之类的逻辑**——blocking writer 自带这个特性

**PC 重建**（旧 PC 死透了，起新 PC + 新 connId）：

- 旧 PC 上的 DC 自然 close → 走 DC close handler → `sender.close()` + `fbq.destroy()` 一气呵成（积压消息丢——对端可能已是不同设备，陈旧消息无意义；和"故意不做的事"中"跨 PC 复用队列"一致）
- 新 PC 用新 connId 起新 FBQ；启动清理残留 jsonl 由 bridge 启动时已覆盖（PC 重建期间不调 bridge.start，但旧 connId 的文件已在 DC close 时被 `fbq.destroy` 删除）
- **不需要写"PC 重建专用 FBQ 处置"逻辑**——复用现有 close 路径

### 同 connId race 隔离设计

webrtc-peer 处理"同一 connId 重建"的清理路径设计上必须先把 session 从 `__sessions` Map 删除、再 await `rpcQueue.destroy(...)`——`delete-first` 顺序让 dc.onclose 路径短路返回 undefined，避免晚到的 datachannel 装到正在销毁的 session 上。这个顺序不能改。

但此约束意味着在 `await destroy` 进行中（FBQ 切换后含 fs.rm + close stream，数十~数百 ms），同 connId 的新 offer 到达后会进入新装配路径，**看不到旧实例**。MemoryQueue 时代 destroy 是 microsec 级看不见；切磁盘后窗口暴露——如果新旧 FBQ 用相同文件名，两个实例并发 IO 同一文件，行为未定义。

**方案 A（采纳）**：FBQ 实例 id 加唯一后缀 `${connId}-${ts}-<uuid8>`，物理文件名隔离。改动 1 行；新旧实例完全不竞争同一文件路径；残留由 bridge 启动期 `cleanupResiduals` 统一扫掉（白名单 `*.jsonl` 已覆盖唯一后缀文件名）。

**备选 B（驳回）**：webrtc-peer 内部加 per-connId mutex 串行化"装配 / 销毁"——入侵 4-5 处信令路径（含 ICE restart），过度设计。

**备选 C（驳回）**：webrtc-peer 维护 `__pendingClose: Map<connId, Promise>`，新装配前 await 旧 close——比 B 轻但仍需改 handleOffer 入口，且要小心避免 await 死锁。

为何选 A：改动最小、隔离最干净、不入侵信令路径、与"最小切换"红线一致。

**MemoryQueue 路径不需要这个隔离**：MemoryQueue 不碰 fs，destroy 是同步级别的 mutex 切换；id 保持原 `connId`，无需后缀。装配点的代码自动处理"FBQ 加后缀 / mem 不加后缀"两种模式。

### queueDir 不可用降级

bridge 启动期 `cleanupResiduals` + `measureDiskCap` 任一失败时，**fbq 路径自动降级到 MemoryQueue 单 session**——FBQ 路径**永不阻塞** webrtc 装配。

**双层保护**：

1. **模块级开关**：`RPC_QUEUE_IMPL = 'mem'` 一行回退（紧急回退路径，详见 [rpc-dc-send-queue.md](./rpc-dc-send-queue.md) "队列实现选择"）
2. **运行时降级**：`useFbq = (RPC_QUEUE_IMPL === 'fbq') && !!queueDir`——bridge 把 `__queueDir` 暴露给 webrtc-peer 时强制要求"cleanup + measure 都成功"，任一失败 `__queueDir` 留 null，每次新装配自动选 MemoryQueue

**装配诊断**：每个 session 装配成功后**仅打一次** local info + remoteLog `rtc.queue-impl conn=… impl=fbq|mem [fallback=queue-dir-null]`，让运维拿到运行时实际路径（特别是静默降级到 mem 的场景）。频率与连接频率挂钩，不刷屏。

**为何不阻塞装配**：plugin 整体可用性优先于 fbq 单点最优——磁盘异常时 plugin 仍能用 mem 模式处理 RPC（10 MB 软上限），让 UI 通信不至于因 fs 问题完全瘫痪。运维通过装配日志感知"残废模式"，再决策修复磁盘。

## 相邻隐患（保留观察项）

`RpcDcSender.send()`（继承自原 `RpcSendQueue`）的 fast-path 循环中，若 `dc.send(chunks[i])` 抛异常，当前的吞错路径会把 **已发出去的 i-1 个 chunk 留在线上，剩余 chunk 既不入队也不补发**。接收端 reassembler 会收到永远等不到尾巴的半截消息。

- 触发条件窄：`dc.send` 抛通常意味着 DC 已经要关，实际影响小
- 模型 B 重构后这条隐患仍在 sender 内部，属于本次集成方案不修的 known gap
- 后续可考虑：sender.send fast-path 失败抛错 → 消费循环 catch 后把消息回写 FBQ 头部（需 FBQ 支持 head insert）——列在"后续扩展"项

## 故意不做的事

- **跨进程重启的持久化**：插件崩溃/重启后，文件里的旧消息直接丢弃。对端 PC 已失效，陈旧消息送到新对端无意义。
- **跨 PC 复用队列**：一个 rpc DC 对应一个队列实例；PC 重建整体重来。理论上可扩展，但 RTC 的 SCTP 发送缓冲本身就无法回收"已送入 libdatachannel/werift 但未到达对端"的数据，做不到真正的零丢失，收益不匹配复杂度。
- **消息送达保证**：与原 `RpcSendQueue` 一致，fire-and-forget。
- **集成层运行期 statfs / 磁盘剩余检查**：完全靠 FBQ 自身的 ENOSPC 自杀式降级兜底（见 §集成方案 §磁盘真打满的兜底）。
- **插件级总盘上限**：N 条 DC 累计占盘按 N × 单 DC `diskCap` 自然封顶；通过 remoteLog `disk-cap` drop 频率观察，超出预期再加。

## 默认参数依据

- **`memBudget = 8 MB`**：模型 B 下 FBQ 是唯一应用层缓冲，8 MB/连接的内存占用对绝大多数瞬时积压足够；超了再走磁盘。
- **`diskCap = 1 GB`**（构造时按 `min(1 GB, max(64 MB, free × 50%))` 自适应取下限）：对一条 rpc DC 的长尾积压足够；移动设备/服务器均不会因此逼近存储上限。
- **无 lowWaterMark**：队列头从内存弹，尾往文件追加，没有"抖动"风险，refill 由单次 dequeue 触发即可，不需要双阈值。

## 测试

遵循插件覆盖率门禁（lines 100% / functions 100% / branches 95% / statements 100%）。

### FBQ 模块层（已实施）

1. **纯内存路径**：enqueue / 迭代消费 / stats / clear / destroy
2. **溢出路径**：触发 spill → 继续 enqueue 走文件 → 消费清空 memory → refill → 文件 drain 完删文件 → 回到未溢出
3. **FIFO 不变量**：跨越 spill 边界、refill 边界、clear 后重新 enqueue，消费顺序必须与入队顺序一致
4. **磁盘上限**：构造满文件后 enqueue 返回 false + onDrop 触发，不抛错
5. **崩溃残留**：构造尾行半截的文件，`refill` 丢弃末行且消费前面的行
6. **destroy 幂等**：多次 `destroy()` 不抛；`destroy()` 后 enqueue 返回 false；进行中的迭代器 `for await` 自然结束（返回 `{ done: true }`）
7. **clear 语义**：清空后实例仍可继续 enqueue；文件删除；`fsBroken` 复位
8. **id 校验**：`..`、`/`、`\`、`\0`、空格等非法字符在构造期抛 `TypeError`
9. **init 幂等**：重复 `init()` 无副作用；`init` 前调用 `enqueue` 抛 `queue not initialized`
10. **FS 错误降级（关键回归）**：异步 `writeStream.on('error')` 后，即使"未成功落盘任何字节"场景下，consumer 也不会卡死；后续溢出 enqueue drop `fs-error`；`fsBroken=true`
11. **head 指针压缩**：大量 mem enqueue+消费后 `memQueue.length` 收敛，不线性增长

### 集成层

12. **启动清理** ✅（`src/rpc-queue-startup.test.js`）：bridge.start 后残留 `*.jsonl` 被清；非 jsonl 文件不动；单文件 unlink 失败被 warn 跳过、不阻断 start
13. **diskCap 自适应** ✅（`src/rpc-queue-startup.test.js`）：mock `fs.statfs` 各分支（充裕 / 紧张 / 抛错回退）；下限 64 MB / 上限 1 GB / `free × 50%` 三段
14. **`RpcDcSender` 单元** ✅（`src/webrtc/rpc-dc-sender.test.js`）：分片、fast-path、`bufferedAmount` 背压；阻塞式 `send()` 在 `bufferedamountlow` 触发后恢复；`close()` 让等待中的 `send()` 抛 `SENDER_CLOSED`（waiter 主动 reject）；单条 oversize 抛 `MESSAGE_OVERSIZED`
15. **消费循环退出** ✅（`src/webrtc/webrtc-peer.test.js`）：`fbq.destroy()` 让 `for-await` 自然结束；`sender.close()` 让正在 await `bufferedamountlow` 的 `send` 立刻返回
16. **`onDrop` wrapper 边沿状态机** ✅（`src/webrtc/rpc-drop-monitor.test.js`）：`disk-cap-start/end` / `fs-broken` / `fs-error-summary` 在持续 drop 期间静默累加，仅边沿点上报；`fs-error` reason 透传 `err` 第三参（B-stage2 已激活）
17. **B-stage2 关键测试** ✅：
    - 装配点队列实现选择：模块常量切换（当前 mem；'fbq' 模式 + queueDir 不可用自动降级 mem + 装配日志含 fallback 标记）+ 测试通过 `rpcQueueImpl` 构造选项覆盖
    - 同 connId 重建：两个 FBQ 实例 id / filePath 物理不同（race 隔离）
    - destroy onBeforeClear 同步钩子：mutex 内拿原子残留快照（含 in-flight enqueue），与 monitor.summarize 集成
    - bypassAdmission 完整边界：命中 / 谓词抛错保守 / 非函数 coerce / fsBroken 仍 drop（不豁免物理 IO 失败）
    - fs-error errno 透传：mkdir / writeStream error / write cb / refill stat 各路径都把底层 err 传到 onDrop 第三参；lastFsErr sticky（first wins）；clear / destroy 重置

### E2E 回归点

- 移动端长时间后台后回到前台，积压消息按序送达
- ICE restart 全程不丢消息
- 拔网测试：网络断开 5 分钟内积压上限内消息全部送达；超过上限按设计丢弃但有 remoteLog 边沿日志

## 文件清单（预期）

```
plugins/openclaw/src/utils/
├── file-backed-queue.js             # 已完成
└── file-backed-queue.test.js        # 已完成

plugins/openclaw/src/webrtc/
├── rpc-dc-sender.js                 # 重构自 rpc-send-queue.js：砍 10MB 缓冲、白名单、drop 统计；保留分片/fast-path/背压；send 改 async 阻塞式
├── rpc-dc-sender.test.js            # 同步重命名 + 改测
├── webrtc-peer.js                   # session 上挂 fileBackedQueue + rpcDcSender；启动消费循环 + onDrop wrapper；生产者改走 enqueue；DC close handler 调 sender.close + fbq.destroy
└── webrtc-peer.test.js              # 生命周期 / ICE restart / close 集成断言

plugins/openclaw/src/realtime-bridge.js  # bridge.start 开头加启动清理 + 一次 statfs 算 diskCap；gateway ws → DC 透传改走 enqueue
```

> 队列本身放在 `src/utils/`——作为业务无关纯工具，与 `atomic-write.js` / `mutex.js` 并列。`RpcDcSender` 与 webrtc 集成侧逻辑放在 `src/webrtc/`。

## 后续扩展（不在本次范围）

- `RpcDcSender.send()` fast-path 失败时把消息回写 FBQ 头部（需 FBQ 支持 head insert）
- 多 rpc DC 共享文件队列（用于跨 PC 恢复的极限场景）
- 导出队列状态到 `remoteLog`，用于可观测性

## 演进史

记录每个阶段**为什么做、解决了什么问题、留下什么 hooks**——便于后续读者理解为何 FBQ 不是一开始就长成现在这个样子。

### 阶段 0：原 `RpcSendQueue`（前 plan-1）

`webrtc-peer` 内部的 `RpcSendQueue` 同时承担应用层缓冲（10 MB 软上限）+ 分片 + 背压 + drop 诊断。监控逻辑（`droppedCount` / `droppedBytes` / overflow 状态翻转）和容器逻辑混在一个类里。问题：

- 切到 FBQ 时容器要换实现，但 drop 诊断会跟着丢
- 测试很难只测容器或只测诊断，覆盖率难达标
- 接口边界不清，业务规则（agent run 白名单）下沉到容器内

### 阶段 1：plan-1 监视器外置 + 容器接口契约定型

把 drop 诊断从 `RpcSendQueue` 剥离到独立的 `rpc-drop-monitor`：

- 容器（`MemoryQueue`）保留 admission + 单条上限 + bypass 白名单 + 6 字段 stats，**完全无日志 / 无累计**——drop 经 `onDrop(reason, size)` 外抛
- `RpcDcSender` 重构为"不持有应用层缓冲"的阻塞式发送器
- monitor 边沿状态机消费 `onDrop` + 读 `queue.stats()`，做"满→空"翻转 / close 汇总
- monitor 接口为 FBQ 切换预留位（`onDrop` 第三参 `err` 当时未激活）

**关键 race 修复（plan-1 round-2）**：把 monitor.summarize 从同步读 stats 改为走 `queue.destroy(onBeforeClear)` 同步钩子，规避 in-flight enqueue 看不到的窗口。MemoryQueue.destroy 接 onBeforeClear 接口同步落地。

**为何把诊断外置**：FBQ 切换时容器换实现，诊断不变即可——避免一次大重构。也让两条独立测试套件（FBQ / monitor）都能维持 100% 覆盖。

### 阶段 2：plan-2 启动期 prep（不消费）

`bridge.start()` 添加 FBQ 切换前置工作：

- 创建 `<pluginDir>/rpc-queues/` 目录
- `cleanupResiduals()`：白名单 `*.jsonl` 清理（防 plugin 异常退出留残留 / 跨 bind 切换留旧账户文件）
- `measureDiskCap()`：一次性 `fs.statfs` 测算 diskCap，存到 `bridge.__diskCap`

**当时不消费**：MemoryQueue 阶段 `bridge.__diskCap` 闲置，`rpc-queues/` 也无文件可清。但 prep 路径完整跑过——B-stage2 切 FBQ 时只缺最后一步"实例化 FBQ"。

**为何提前 prep**：把启动期的 fs IO 与 webrtc 装配解耦，让 webrtc-peer 装配点的 FBQ 创建可以是 microsecond 级（不带 fs cleanup / measure 阻塞）；同时让"prep 失败"成为单一感知点（bridge 启动期 try/catch），不影响装配。

### 阶段 3：B-stage2 单点平替 FBQ

把 webrtc-peer 装配点的 `new MemoryQueue` 替换为 `new FileBackedQueue`，配套 plan-1 监视器接口扩展（`onDrop` 第三参 `err` 激活）+ plan-2 prep 接线（`getDiskCap` deps + `queueDir` 注入）：

- **FBQ 接口扩展**：加 `bypassAdmission`（与 MemoryQueue 镜像）+ `lastFsErr` sticky 缓存 + `onDrop(reason, size, err?)` 第三参 + `destroy(onBeforeClear)` 同步钩子 + `maxMessageBytes` 单条硬上限
- **webrtc-peer 装配点**：模块级常量 `RPC_QUEUE_IMPL`（B-stage2 切换为 `'fbq'`，紧急回退期间临时为 `'mem'`）+ 构造选项 `rpcQueueImpl` 测试覆盖 + `useFbq` 运行时降级守卫 + 装配诊断日志
- **同 connId race 隔离**：FBQ id 加唯一后缀 `${connId}-${ts}-<uuid8>` 物理隔离
- **MemoryQueue 保留为可切回路径**：模块级开关一行回退 + queueDir 不可用自动降级 + dev/test 简化 + 接口对齐镜像

**关键设计取舍记录**：

- **取舍 1：是否在 webrtc-peer 加 per-connId mutex 解决 race?** 否——决策 4 选方案 A（FBQ 文件名唯一后缀），改动 1 行 + 不入侵信令路径
- **取舍 2：MemoryQueue 切完后是否删除?** 否——决策 8 保留作为可切回路径，模块级开关 / 运行时降级 / dev/test 简化都受益
- **取舍 3：diskCap 注入路径走 runtime getter 还是 deps?** 选 deps 注入——决策 6，可在测试中 mock 各分支
- **取舍 4：destroy onBeforeClear 异步钩子要不要支持?** 否——决策 5 限定同步钩子，与 MemoryQueue 完全镜像，async rejection 不被捕获是 silent gotcha
- **取舍 5：bypassAdmission 是否扩到 lifecycle:end?** 否——红线 4，OpenClaw 一次 run 多次 emit lifecycle:end 会破坏白名单语义
