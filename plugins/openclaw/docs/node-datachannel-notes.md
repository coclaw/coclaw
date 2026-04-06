# node-datachannel 使用笔记

> 记录使用 ndc 过程中遇到的问题、排查结论、重要发现和可用的测试方法。  
> **相关文档**：
> - [ndc 集成方案](node-datachannel-integration-plan.md) — prebuild bootstrap、werift 回退、实施差异
> - [大文件传输故障排查](../../../docs/designs/dc-file-transfer-issues.md) — Issue #226 完整分析
> - [WebRTC P2P 数据通道设计](../../../docs/designs/webrtc-p2p-channel.md) — 整体架构

## 版本与升级

### 当前版本

- node-datachannel：v0.32.2（2026-04-06 升级）
- libdatachannel：v0.24.2（内嵌于 ndc）
- `package.json` 使用精确版本号，禁止 `^`/`~` 前缀（预编译 binary 与 npm 版本必须严格一致）

### 升级流程

1. 更新 `package.json` 中的版本号
2. 更新 `scripts/download-ndc-prebuilds.sh` 中的 `VERSION`
3. 运行下载脚本获取新的预编译二进制（5 个平台）
4. `pnpm install` 更新 lockfile
5. 验证 `pnpm check` + `pnpm test`

注意：我们仅使用预编译二进制，不编译 ndc。下载脚本从 GitHub Releases 获取，覆盖 linux-x64/arm64、darwin-x64/arm64、win32-x64。

### v0.32.2 关键修复

1. **SCTP `sendReset()` 缓冲区对齐 UB**（libdatachannel issue #1509）— `sctptransport.cpp` 中 `srs_t*` 需要 4 字节对齐但 stack buffer 仅 1 字节对齐。DataChannel 关闭时触发，可导致崩溃或静默内存损坏
2. **ICE transport 析构竞态**（libdatachannel issue #1525）— `~IceTransport()` 运行时 libnice 回调仍可能触发，造成 use-after-free。PeerConnection 销毁时触发

这两个 bug 都在 PC/DC 关闭时触发，与 Issue #226 观察到的"PC 突然从 native 层被关闭"高度相关。

### v0.32.2 API 变更

无破坏性变更。唯一新增：`initLogger(level, callback)` 的可选 callback 参数（见下文"initLogger 诊断能力"章节）。

## 已知问题与限制

### 1. TSFN 队列无上限

**位置**：`node-datachannel/src/cpp/thread-safe-callback.cpp:15`

```cpp
tsfn = tsfn_t::New(env, ..., 0 /* unlimited queue */, 1);
```

libdatachannel 的 native I/O 线程通过 `BlockingCall` 将数据入队，队列无上限，`BlockingCall` 永远不阻塞。

**后果**：native 线程无限速地从 SCTP socket 读取数据入队，SCTP receive buffer 永远不会真正填满，**SCTP 层的网络流控被架空**。即使调用 `setSctpSettings()` 调整 `recvBufferSize` 也无法解决——瓶颈在 TSFN 层而非 SCTP 层。

**可控性**：不可控，需 ndc 上游修改。可能的上游方案：
- TSFN 队列支持上限配置（`max_queue_size` 参数化）
- `onMessage` 回调支持返回值控制（返回 false 时暂停从 SCTP socket 读取）

**缓解**：应用层 ws.write() 背压修复间接降低 V8 heap 堆积，给 SCTP 流控提供一些触发机会。

### 2. 事件循环饥饿

**位置**：`node-datachannel/dist/cjs/polyfill/RTCDataChannel.cjs:81-103`

TSFN 队列中的 N 个消息在同一个事件循环 turn 中同步执行所有回调。100MB 文件（~6400 个 16KB chunk）意味着 6400 次 `onmessage` 在一次 turn 中连续执行。

**缓解**：接收端的 onmessage 只做 `pendingQueue.push()`（极快），drainLoop 通过 `setImmediate` 让出 CPU，防止 gateway 饿死。

### 3. polyfill 缺陷

- 远端创建的 DC（通过 `ondatachannel`）从不从 `#dataChannels` Set 中移除（内存泄漏）
- `Blob` 类型的 `send()` 是异步的且无错误处理（`.then()` 无 `.catch()`）
- `send()` 不检查 max-message-size，超限由 native 层抛异常

### 4. 进程退出

`cleanup()` 函数需要在 gateway 停止时调用，否则 ThreadSafeCallback 可能阻止进程干净退出（ndc issue #366）。已在 `RealtimeBridge.stop()` 中处理。

### 5. 冒烟测试不能创建 PC 实例

创建 `RTCPeerConnection` 实例会启动 native threads。如果调用方没有显式调用 `cleanup()`，会阻止 Node 进程退出。preload 冒烟测试改为仅验证 `typeof RTCPeerConnection === 'function'`。

### 6. ESM 模块实例隔离

`--link` 安装模式下，symlink 导致 ESM 模块缓存命中不同 URL，`api.on()` 注册的 hook 回调和 RPC handler 可能运行在不同模块实例中。需要跨 hook/RPC 共享的状态必须通过磁盘文件中转。详见 `plugins/openclaw/CLAUDE.md` 的"Hook 与 Gateway Method 的模块实例隔离"章节。

## initLogger 诊断能力评估

v0.32.2 新增 `initLogger(level, callback)` 的可选 callback 参数，可捕获 libdatachannel 内部日志。

### 现有回调的局限

`onconnectionstatechange` 只给状态字符串（如 `"failed"`），不提供原因。以下四种故障在现有回调中表现完全相同：

- ICE 超时（TURN 不可达 / 无可用 candidate pair）
- DTLS 握手失败
- SCTP 心跳超时（网络中断）
- SCTP association 异常终止

`dc.onerror` 是 DC 级别最丰富的错误来源，会携带 libdatachannel 传出的错误字符串（如 `"Stream 1 reset, error: 111"`），但仅在 DC 自身出错时触发——PC 直接 drop 时可能只有 `onclose` 而无 `onerror`。

`oniceconnectionstatechange` 当前未注册（潜在信息遗漏）。

### initLogger 能补什么

在 `"Warning"` 级别，libdatachannel 在状态跳变前输出具体原因：

| 来源 | 示例日志 | 诊断价值 |
|------|---------|---------|
| ICE 层 | `"ICE failed"`, `"Candidate pair failed"` | 区分 TURN 不可达 vs 无 candidate pair |
| DTLS 层 | `"DTLS connection failed"` + OpenSSL 错误 | 区分证书问题 vs 握手超时 |
| SCTP 层 | `"SCTP association closed"`, `"T3-rtx timeout"` | 区分优雅关闭 vs 心跳超时 |
| PC 状态机 | Warning/Error 紧接在 `"failed"` 前 | 给出因果链 |

正常运行时几乎无输出（Warning 级别），仅故障时触发，开销极低。

### 限制

- **进程全局单例**：一次 `initLogger` 对所有 PC 实例生效
- **日志不带 connection ID**：多连接时需靠时间戳与状态变更事件关联

### 决策

暂不引入。v0.32.2 已修复已知 native 层 bug，先观察升级效果。若间歇性断连仍存在，再引入 initLogger 定向排查——届时以 `"Warning"` 级别接入，路由到 `remoteLog`。

## 测试方法

### loopback 测试（ndc 库本身）

两个 ndc PeerConnection 在同一 Node 进程中直连，验证库本身的数据传输能力。绕过网络层，隔离应用层问题。

- 30MB 在 0.56s 完成（~54 MB/s）
- 可用于验证 ndc 版本升级后的基本功能

### Playwright E2E 测试（端到端）

通过 Playwright headless 浏览器实际上传/下载文件，覆盖完整链路：

- **下载**：30MB 在 788ms 完成（38 MB/s），稳定
- **上传**：连接稳定时多数成功，但导航后立即上传可能不稳定（DC 未就绪 / SSE 重连触发 RTC 重建）
- 测试要点：等待 `dcReady=true` 后再上传；大文件（100MB+）测试需关注内存增长

### 单元测试（背压逻辑）

`handler.test.js` 中通过 mock DC 和 WriteStream 验证背压相关逻辑：

- mock `ws.write()` 返回 `false` 模拟背压
- 验证 `pendingQueue` + `drainLoop` 的正确行为
- 验证 `ws.write()` 同步抛异常时的 gateway 保护
- 验证 SIZE_EXCEEDED + drainLoop 竞态
- 验证 DC 在 ws.end 回调期间关闭的边界场景

### 关键排查技巧

- Plugin 端 `rtc.state closed` 来自 `onconnectionstatechange` 回调 → 关闭由 native 层发起（非代码主动 `pc.close()`）
- PC 直接跳到 `closed`（而非 `disconnected` → `failed` → `closed`）是 ndc native 层 bug 的典型特征
- UI 端通过 ICE consent 检测断连，通常延迟约 6 秒
- `remoteLog` 的 `file.up.progress` 日志中 `bp=<count>` 反映 ws.write() 背压触发次数，数值高表示磁盘 I/O 跟不上

## Node.js WebRTC 生态概况

> 调研时间：2026-04-06

### 大厂 Node.js SDK 的 WebRTC 方案

绝大多数大厂在 Node.js 服务端**不走 WebRTC**：

- **OpenAI Realtime** — 浏览器用原生 `RTCPeerConnection`；Node.js 自动降级为 WebSocket（`ws` 包）。`@openai/agents-realtime` 的 WebRTC 代码以 `/// <reference lib="dom" />` 开头，Node.js 环境构造时直接 throw
- **LiveKit** `@livekit/rtc-node` — 唯一例外。自建 Rust FFI 层封装 Google libwebrtc，通过 per-platform npm 包分发预编译二进制（`@livekit/rtc-node-linux-x64-gnu` 等）
- **Twilio / Daily / Agora / Vonage / Amazon Chime** — Node.js SDK 仅做 REST API / token 管理，WebRTC 连接在浏览器端
- **mediasoup** — SFU 场景，完全自研 C++ media worker

### Node.js WebRTC 包对比

| 包 | 底层库 | 二进制大小 | 状态 | 周下载 |
|---|--------|----------|------|-------|
| **`node-datachannel`**（我们在用） | libdatachannel（轻量 C++17） | ~8.7MB | 活跃维护 | ~42k |
| **`@roamhq/wrtc`** | Chromium WebRTC M106 | ~28MB | 活跃维护 | ~18k |
| `wrtc`（原版） | Chromium WebRTC M87 | - | **已废弃**（2021） | ~28k（遗留） |
| `werift` | 纯 TypeScript 自实现 | 无需编译 | 基本停滞 | ~8k |

### @roamhq/wrtc 评估（备选排除）

**背景**：WonderInventions（Roam，$40M 融资）维护的 `node-webrtc` fork，4 名 npm 维护者。v0.10.0（2026-03-10）修复了关键 segfault 问题。

**对我们项目不可用的原因**：

| 问题 | 说明 |
|------|------|
| **`onbufferedamountlow` 未实现** | 致命缺陷——我们的文件传输双向流控都依赖此事件。C++ 层有 `SendThresholdCallback`，但未暴露到 JS binding |
| **`bufferedAmountLowThreshold` 未实现** | 同上，只能轮询 `bufferedAmount` |
| **无 `cleanup()` API** | 进程退出时可能 segfault/hang（`napi_add_env_cleanup_hook` 自动但不可靠），需 `process.exit()` 强退 |
| **`maxMessageSize` 始终 null** | 无法从 JS 查询 SCTP 限制 |
| 二进制 28MB（ndc 8.7MB 的 3.2x） | 部署体积大 |
| 无 Alpine/musl 支持 | 容器部署受限 |
| DC `onopen` 事件不合规 | 缺少 `event.channel`（issue #46） |

**值得关注的架构优势**：使用 `uv_async_send` 而非 TSFN 桥接 native 线程与 Node.js 事件循环，`uv_async_send` 有合并特性（多次 send 合并为一次唤醒），**不存在 TSFN 无限队列问题**。

**结论**：因 `onbufferedamountlow` 未实现，不适合作为我们的备选。如果未来 ndc 出现不可接受的问题需要迁移，需权衡大量流控代码改造成本。

### 为什么 node-datachannel 适合我们

- **DataChannel 专注**：libdatachannel 为 DataChannel 场景设计，无音视频编解码包袱
- **轻量二进制**：8.7MB vs Chromium 方案的 28MB+
- **完整的 DataChannel API**：`bufferedAmount`、`onbufferedamountlow`、`bufferedAmountLowThreshold` 均正确实现
- **polyfill 兼容层**：可直接用于 simple-peer 等库
- **musl/Alpine 支持**：提供单独的 musl 预编译包
- **活跃维护**：发布频率高于 @roamhq/wrtc

**已知的代价**（需持续关注）：
- TSFN 队列无上限（见本文档"已知问题"章节）
- polyfill 层存在缺陷（DC 内存泄漏、Blob send 无错误处理等）
- 事件循环饥饿需应用层缓解
