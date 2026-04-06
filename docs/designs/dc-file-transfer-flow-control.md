# DataChannel 文件传输流控分析

> **状态**：分析完成，部分实施  
> **关联**：Issue #226（大文件传输失败）  
> **日期**：2026-04-06

## 问题背景

通过 WebRTC DataChannel 传输大文件时（≥30MB），偶发传输失败。故障表现为 Plugin 端 PeerConnection 从 native 层直接跳到 `closed` 状态，UI 端收到 `DC_CLOSED` 错误。

## 架构概述

### 两条 DataChannel 路径

- **rpc DC**（label="rpc"）：JSON-RPC 控制命令，使用 `dc-chunking.js` 分片
- **file DC**（label="file:\<transferId\>"）：每次传输创建独立 DC，`ordered: true`，原始二进制帧，不经过 dc-chunking

### 上传路径（UI → Plugin）

1. UI 创建 file DC → 发送 JSON 请求 `{ method: 'PUT'/'POST', size, ... }`
2. Plugin 回复 `{ ok: true }`
3. UI `sendChunks()`: 16KB 分片，`bufferedAmount > 256KB` 时等待 `bufferedamountlow`（阈值 64KB）
4. UI 发送 `{ done: true, bytes }`
5. Plugin 校验字节数，rename 临时文件，回复 `{ ok: true, bytes }`

### 下载路径（Plugin → UI）

Plugin 用 `fs.createReadStream` 流式发送，有 bufferedAmount 背压控制（`stream.pause()/resume()`）。

### 关键常量

| 常量 | UI (file-transfer.js) | Plugin (handler.js) |
|------|----------------------|---------------------|
| CHUNK_SIZE | 16384 (16KB) | 16384 (16KB) |
| HIGH_WATER_MARK | 262144 (256KB) | 262144 (256KB) |
| LOW_WATER_MARK | 65536 (64KB) | 65536 (64KB) |
| UPLOAD_READY_TIMEOUT | 15s | - |
| FILE_DC_TIMEOUT | - | 30s |
| MAX_UPLOAD_SIZE | 1GB | 1GB |

### 关键文件

- `ui/src/services/file-transfer.js` — UI 侧文件传输
- `ui/src/services/webrtc-connection.js` — UI 侧 WebRTC 连接管理
- `ui/src/stores/claws.store.js` — claw 状态管理，RTC 生命周期
- `plugins/openclaw/src/file-manager/handler.js` — Plugin 侧文件处理
- `plugins/openclaw/src/webrtc/webrtc-peer.js` — Plugin 侧 WebRTC peer 管理
- `plugins/openclaw/src/webrtc/dc-chunking.js` — rpc DC 分片协议

## 数据流路径与问题链

```
浏览器 (UI)                                         Plugin (OpenClaw Gateway)
─────────────                                       ────────────────────────
file.sendChunks()                                   
  ↓ 16KB chunks                                    
  ↓ bufferedAmount 流控                              
  ↓ (HIGH_WATER_MARK=256KB)                         
  ↓                                                 
  ↓ ─── SCTP / DTLS / ICE ───→  libdatachannel I/O 线程
                                    ↓ 急切 drain SCTP socket
                                    ↓ 入 TSFN 队列（无上限）
                                    ↓
                                 Node.js 事件循环
                                    ↓ 同步 drain 所有排队回调
                                    ↓ dc.onmessage × N
                                    ↓
                                 pendingQueue（中间缓冲）
                                    ↓ drainLoop + setImmediate
                                    ↓ ws.write() + drain 背压
                                    ↓
                                 磁盘 I/O
```

## 测试结果汇总

### node-datachannel loopback 测试 — 通过

两个 ndc PeerConnection 在同一进程中直连，30MB 在 0.56s 完成（~54 MB/s）。结论：库本身无问题。

### 下载（Plugin → Browser）— 通过

Playwright headless，30MB 在 788ms 完成（38 MB/s），无任何错误。

### 上传（Browser → Plugin）— 不稳定

| 测试条件 | 结果 |
|---------|------|
| 导航后立即上传（无等待） | 上传未触发（DC 未就绪） |
| 导航后等 dcReady=true 立即上传 | 有时成功，有时失败 |
| 导航后等 15s 再上传 | 成功（30MB，MD5 一致） |
| 100MB 文件，连接稳定时 | 多数成功 |

### 观察到的失败模式

典型失败日志（107MB 文件上传）：

```
file.up.err code=DC_CLOSED method=POST size=112869164 sent=104824832/112869164
  err=DataChannel closed during flow control
```

Plugin 端 PC 直接跳到 `closed`（非 `disconnected` → `failed` → `closed`），UI 约 6 秒后通过 ICE consent 检测到断连。数据传输完成约 93% 后停滞。

**关键发现**：Plugin 端 `rtc.state closed` 日志来自 `onconnectionstatechange` 回调（非代码主动调用 `pc.close()`），证实关闭由 native 层发起。

## 已确认的问题

### 1. ws.write() 忽略背压信号（已修复）

**位置**：`plugins/openclaw/src/file-manager/handler.js` — `receiveUpload()`

WriteStream 的 `highWaterMark` 设为 16KB。`ws.write()` 在内部缓冲超过此阈值时返回 `false`，但代码完全忽略返回值。

**影响**：WriteStream 内部缓冲无限增长。100MB 文件可堆积 ~100MB 的 Buffer 对象在 V8 heap。

**修复**：在 onmessage 和 ws.write 之间引入中间缓冲队列 `pendingQueue` + `drainLoop` 受控消费循环，尊重 `drain` 事件。每次 write 后通过 `setImmediate` 让出 CPU。

### 2. TSFN 队列无上限（node-datachannel 层，不可控）

**位置**：`node-datachannel/src/cpp/thread-safe-callback.cpp:15`

```cpp
tsfn = tsfn_t::New(env, ..., 0 /* unlimited queue */, 1);
```

libdatachannel 的 native I/O 线程通过 `BlockingCall` 将数据入队，队列无上限，`BlockingCall` 永远不阻塞。

**后果**：native 线程无限速地从 SCTP socket 读取数据入队，SCTP receive buffer 永远不会真正填满，**SCTP 层的网络流控被架空**。即使调用 `setSctpSettings()` 调整 `recvBufferSize` 也无法解决此问题——瓶颈在 TSFN 层而非 SCTP 层。

**可控性**：不可控。需要 node-datachannel 上游修改。

### 3. 事件循环饥饿（已缓解）

**位置**：`node-datachannel/dist/cjs/polyfill/RTCDataChannel.cjs:81-103`

TSFN 队列中的 N 个消息在同一个事件循环 turn 中同步执行所有回调。100MB 文件（~6400 个 16KB chunk）意味着 6400 次 `onmessage` 在一次 turn 中连续执行。

**缓解**：onmessage 只做 `pendingQueue.push()`（极快），drainLoop 通过 `setImmediate` 让出 CPU，防止 gateway 饿死。

### 4. 内存增长风险

数据在两个位置堆积：

- **Native heap**：TSFN 队列中的 `rtc::binary` 向量（每个 16KB）
- **V8 heap**：pendingQueue 中的 Buffer 对象（替代了原来 WriteStream 内部无限缓冲）

ws.write() 背压修复后，WriteStream 端的堆积被控制在 ~16KB。pendingQueue 的堆积仍存在（因 DataChannel 没有 `pause()` API），但间接给 SCTP 流控提供了触发机会。

## 修复方案详情

### 核心逻辑：分离接收与写入

```
onmessage(chunk):
  pendingQueue.push(chunk)     ← 极快，不阻塞
  scheduleDrain()              ← 幂等，只在无活跃消费时启动

drain 循环:
  取一个 chunk → ws.write()
  if write 返回 false → 等待 'drain' 事件
  每次 write 后 → setImmediate 让出 CPU（N=1）
  重复直到 pendingQueue 为空
  队列排空且 doneReceived → finishUpload()
```

### 状态变量

| 变量 | 用途 |
|------|------|
| `pendingQueue` | 中间缓冲，替代 WriteStream 内部无限缓冲 |
| `draining` | drain 循环是否活跃，防止重复启动 |
| `doneReceived` | UI 是否已发送完成信号 |
| `dcClosed` | DataChannel 是否已关闭 |
| `wsError` | WriteStream 是否出错 |
| `finishing` | finishUpload 是否已启动，防重入 |

### 设计决策

- **每次 write 后让出一次 CPU（N=1）**：setImmediate 开销微秒级，对吞吐量无影响，保证 gateway 最佳响应性
- **不引入额外的内存上限**：DataChannel 无 `pause()` API，数据无论如何会到达内存。通过 ws.write() 背压间接让 SCTP 流控有机会生效
- **drainLoop 中 ws.write() 加 try/catch**：防止 ws 被销毁后写入导致 gateway 崩溃
- **所有异常退出路径设置 wsError + 清空队列**：确保 drainLoop 安全停止

### 诊断日志

新增 `remoteLog` 日志覆盖文件传输全生命周期：

| 事件 | 格式 |
|------|------|
| 传输开始 | `file.up.start conn=<id> id=<transferId> method=<PUT/POST> size=<bytes>` |
| 进度 | `file.up.progress ... 25%/50%/75% received=<n>/<total> bp=<count>` |
| 成功 | `file.up.ok ... bytes=<n> elapsed=<ms> bp=<count>` |
| 失败 | `file.up.fail ... reason=<reason> received=<n>/<total> elapsed=<ms>` |
| 超限拒绝 | `file.up.reject ... reason=size-exceeded received=<n>` |

## 下载方向（对比）

`handleGet()`（Plugin → UI）的流控已正确实现：

```javascript
stream.on('data', (chunk) => {
  dc.send(chunk);
  if (dc.bufferedAmount > HIGH_WATER_MARK) stream.pause();
});
dc.onbufferedamountlow = () => stream.resume();
```

这是标准的生产者-消费者背压模式。上传方向的修复在接收端实现了对称的模式。

## 发现的附带问题

### SSE 导航断连（待修复）

每次 SPA 路由导航（如 /home → /files）时：
1. SSE 连接断开
2. SSE 重连 → 新 `claw.snapshot` → `applySnapshot`
3. 触发 RTC 重建（旧 PC 关闭，新 PC 创建）

这导致每次页面切换都有一次不必要的 RTC 重建。重建后的第一个连接在有文件传输时可能不稳定。

### node-datachannel polyfill 缺陷

- 远端创建的 DC（通过 `ondatachannel`）从不从 `#dataChannels` Set 中移除（内存泄漏）
- `Blob` 类型的 `send()` 是异步的且无错误处理（.then() 无 .catch()）
- `send()` 不检查 max-message-size，超限由 native 层抛异常

## node-datachannel 版本与升级

### 版本状态

当前：v0.32.1（libdatachannel v0.24.0）  
最新：v0.32.2（libdatachannel v0.24.2）

### v0.32.2 关键修复

1. **SCTP `sendReset()` 缓冲区对齐 UB**（libdatachannel issue #1509）— `sctptransport.cpp` 中 `srs_t*` 需要 4 字节对齐但 stack buffer 仅 1 字节对齐。DataChannel 关闭时触发，可导致崩溃或静默内存损坏
2. **ICE transport 析构竞态**（libdatachannel issue #1525）— `~IceTransport()` 运行时 libnice 回调仍可能触发，造成 use-after-free。PeerConnection 销毁时触发

这两个 bug 都在 PC/DC 关闭时触发，与观察到的"PC 突然从 native 层被关闭"高度相关。**升级 ndc 可能根治间歇性连接关闭问题。**

### 升级注意

项目使用 `vendor/ndc-prebuilds/` 中的预编译二进制（当前嵌入 libdatachannel v0.24.0）。升级需要：
1. 更新 npm 包到 v0.32.2
2. 重新构建所有 5 个平台的 prebuild 二进制（linux-x64, darwin-arm64 等）

## 未来优化方向

### UI 侧发送节流

在 UI 的 `sendChunks()` 中添加主动让步（如每 chunk 后 `await new Promise(r => setTimeout(r, 0))`），可降低 Plugin 端的瞬时接收压力。与 Plugin 端背压修复互补。

### node-datachannel 上游

- 提 issue 建议 TSFN 队列支持上限配置（`max_queue_size` 参数化）
- 或建议在 `onMessage` 回调中支持返回值控制（返回 false 时暂停从 SCTP socket 读取）

### 升级 ndc 到 v0.32.2

修复 native 层已知 bug。需重新构建 prebuild 二进制。
