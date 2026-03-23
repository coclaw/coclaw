# DataChannel 发送流控分析

> 创建时间：2026-03-24
> 状态：草案
> 前置文档：`webrtc-p2p-channel.md`、`webrtc-p2p-channel-phase2.md`
> 范围：WebRTC DataChannel 发送侧流控问题分析与方案

---

## 一、问题背景

Phase 2 已将 RPC 通信切换到 DataChannel。与 WebSocket 不同，DataChannel 的发送流控需要应用层参与：

- **WebSocket**：库（浏览器原生 / Node `ws`）将数据放入内部缓冲区，底层 TCP 栈负责流控（滑动窗口、拥塞控制）。应用层 fire-and-forget，库帮排队。
- **DataChannel**：基于 SCTP over DTLS over UDP，发送缓冲区有上限，溢出时行为因平台而异（浏览器抛异常，werift 无限入队）。应用层需要基于 `bufferedAmount` 机制自行控制发送节奏。

---

## 二、平台差异

### 浏览器原生 DataChannel

| 特性 | 行为 |
|------|------|
| `send()` 缓冲区满时 | 抛 `DOMException`（`OperationError`），通道**不关闭** |
| 缓冲区上限 | Chromium ~16 MiB（`bufferedAmount` 累计） |
| `bufferedAmount` | 只读属性，已入队但未发出的字节数 |
| `bufferedAmountLowThreshold` | 可设置，默认 0 |
| `bufferedamountlow` 事件 | `bufferedAmount` 从阈值以上降至阈值以下时触发 |

### werift（Plugin 侧，Node.js）

| 特性 | 行为 |
|------|------|
| `send()` 缓冲区满时 | **不抛异常、不阻塞**，数据推入无上限的 JS 数组 (`dataChannelQueue`) |
| 缓冲区上限 | 无（内存耗尽前一直入队） |
| `bufferedAmount` | 可读属性，`addBufferedAmount()` 准确维护 |
| `bufferedAmountLowThreshold` | getter/setter，默认 0 |
| `bufferedamountlow` 事件 | `dc.on("bufferedamountlow", cb)` 或 `dc.bufferedAmountLow.subscribe(cb)` |
| Stream API | **无**。DataChannel 仅 `send(Buffer \| string)`，无 pipe/stream/Writable 封装 |

---

## 三、场景分析

### 3.1 RPC 消息

RPC 消息为离散的 JSON 文本。多数消息较小（几百字节到几 KB），但部分响应可能较大，例如：

- `sessions.get()` / `coclaw.session.getById()` 返回完整对话历史
- 对话历史中可能包含 inline base64 编码的图片

单条消息可达几百 KB 甚至数 MB。

**Plugin 侧（发送响应）**：werift fire-and-forget，无限入队，对 RPC 场景的内存堆积可忽略。**无需额外处理。**

**Browser 侧（发送请求）**：当前 `bot-connection.js` 已有 try/catch 保护 `send()` 抛异常的情况，但行为是直接 reject 请求（`RTC_SEND_FAILED`）。虽然 UI→Plugin 方向的请求体通常很小，16MB 缓冲几乎不可能溢出，但为鲁棒性考虑，**应实现基于 `bufferedAmount` 的排队发送**，使请求在缓冲区释放后自动发出，而非直接失败。

### 3.2 文件传输（Phase 3，当前不实施）

文件可达 1GB（如视频），不可能全量加载到内存。

**Plugin 侧**：werift 无 Stream API，需自建流控：

```
文件 ReadStream → 分片（16-64KB）→ 检查 bufferedAmount → send() → 等 bufferedamountlow → 继续
```

利用 Node.js 的 `ReadStream` + werift 的 `bufferedAmount` / `bufferedamountlow` 事件协同实现背压。

**Browser 侧**：`File`（继承 `Blob`）不加载到内存，通过 `blob.stream()` 获取 `ReadableStream`，逐片读取后发送。同样需要基于 `bufferedAmount` / `bufferedamountlow` 的流控。

### 3.3 接收端

无流控问题。Phase 3 文件传输时可能需要 stream 优化以节约内存（如收到分片后流式写入而非全量拼接），但不属于发送流控范畴。

---

## 四、RPC 与文件传输的流控差异

| 维度 | RPC | 文件传输 |
|------|-----|----------|
| 数据模型 | 离散的完整消息 | 连续的 chunk 流 |
| 调用模式 | 排队等空位，逐条原子发送 | 控制源头 stream 的 pause/resume |
| 内存模型 | 消息已在内存中 | 不可全量加载，需流式读取 |
| 需要时间 | 现在（Phase 2） | Phase 3 |

两者的共同部分仅为"检查 `bufferedAmount`，满了等 `bufferedamountlow`"，抽象层过薄，**不做统一封装，各自内聚实现。**

---

## 五、结论与行动项

| 场景 | Plugin 侧 | Browser 侧 | 时间 |
|------|-----------|------------|------|
| RPC 发送 | 无需处理（werift fire-and-forget） | 实现 bufferedAmount 排队发送 | **现在** |
| 文件发送 | ReadStream + bufferedAmount 流控 | Blob.stream() + bufferedAmount 流控 | Phase 3 |
| 接收端 | 无需处理 | 无需处理 | — |

当前需实施：**Browser 侧 RPC DataChannel 发送流控**——在 `webrtc-connection.js` 的 `send()` 中增加 `bufferedAmount` 检查与排队机制，缓冲区空间不足时暂停发送，`bufferedamountlow` 触发后恢复。
