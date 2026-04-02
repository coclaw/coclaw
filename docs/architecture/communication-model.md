# CoClaw 通信模型

> 最后更新：2026-04-02
> 状态：已实施
> 范围：UI ↔ Plugin 的端到端通信架构，含信令、数据通道、超时与连接生命周期

---

## 一、总览

CoClaw 的通信架构可以用 **HTTP 客户端** 来类比理解：

| HTTP 概念 | CoClaw 对应 | 说明 |
|-----------|-------------|------|
| TCP 连接池 | Per-bot WebRTC 连接（`WebRtcConnection`） | 每个 bot 一条持久化 P2P 连接 |
| TCP keepalive | ICE keepalive + Signaling 心跳 | 连接保活由 WebRTC 框架和信令层分别负责 |
| HTTP request/response | JSON-RPC over DataChannel | 基于 `rpc` DC 的请求-响应模式 |
| HTTP client | `BotConnection` | 封装连接管理 + 请求发送，业务层无需关心底层连接状态 |
| `connectTimeout` | 等待 DC 就绪（`waitReady`） | 连接建立阶段的超时 |
| `requestTimeout` | 等待 RPC 响应 | 请求发送后到收到响应的超时 |

核心设计意图：**业务层像发 HTTP 请求一样调用 `conn.request()`，无需关心底层 WebRTC 连接是否已建立**。连接不可用时自动等待，超时后明确报错。

---

## 二、三层通道架构

```
UI Browser                         Server                        Plugin (OpenClaw)
──────────                         ──────                        ─────────────────

SignalingConnection ─── WS /rtc/signal ──► rtc-signal-hub ◄── WS /bots/stream ─── Plugin
(per-tab 单例,                             (信令路由)
 多 connId)

BotConnection ═══ DC "rpc" (持久) ════════════════════════════════► Gateway RPC
(per-bot)     ═══ DC "file:<id>" (临时, per-transfer) ═══════════► 文件读写
```

### 2.1 Signaling 通道（WebSocket）

- **连接形态**：per-tab 单一 WS（`SignalingConnection`），承载所有 bot 的信令
- **职责**：SDP/ICE 交换、connId 管理、应用层心跳（25s ping / 45s 超时）
- **不承载**业务数据——业务 RPC 和文件传输均走 DataChannel
- connId 由 UI 生成并 claim，WS 重连后通过 re-claim 恢复映射，避免 full rebuild

### 2.2 RPC 通道（DataChannel `rpc`）

- **连接形态**：per-bot 持久化 DataChannel，基于 SCTP，可靠有序
- **职责**：所有 JSON-RPC 请求-响应（agent 交互、session 管理、文件元操作等）
- **协议**：`{ type: "req", id, method, params }` → `{ type: "res", id, ok, payload }` + `{ type: "event", event, payload }`
- P2P 优先，不可达时自动经 TURN 中继，对应用层透明

### 2.3 File 通道（DataChannel `file:<transferId>`）

- **连接形态**：per-transfer 临时 DataChannel，传输完成即关闭
- **职责**：二进制文件传输（下载/上传/附件上传）
- **协议**：HTTP 语义映射——string 帧 = 控制信息（GET/PUT/POST + 状态码），binary 帧 = 数据
- 与 `rpc` DC 互不阻塞——大文件传输不影响 RPC 响应性

---

## 三、BotConnection 抽象

`BotConnection` 是业务层与通信层的唯一接口，每个 bot 对应一个实例。

### 3.1 核心职责

```
┌─────────────────────────────────────────────────┐
│                  BotConnection                    │
│                                                   │
│  request(method, params, options)                  │
│    → 自动 waitReady → 发送 RPC → 等待响应          │
│                                                   │
│  waitReady(timeoutMs)                              │
│    → DC 已就绪：立即返回                            │
│    → DC 未就绪：排队等待 setRtc() 触发              │
│    → rtcPhase='failed'：主动触发重连                │
│                                                   │
│  setRtc(rtcConn)   → resolve 所有 waiters          │
│  clearRtc()        → reject 所有 waiters + pending │
│  disconnect()      → close RTC + reject all        │
│                                                   │
│  on/off('event:<name>')  → 事件监听                │
└─────────────────────────────────────────────────┘
```

### 3.2 与 Store 层的协作

`bots.store` 通过注入回调实现跨层协作，避免 `BotConnection` 依赖 Vue 响应式系统：

- `__onTriggerReconnect`：`waitReady` 发现 `rtcPhase='failed'` 时调用，触发 RTC 重建（fire-and-forget）
- `__onGetRtcPhase`：读取当前 bot 的 `rtcPhase` 状态（`idle` / `building` / `ready` / `recovering` / `failed`）

### 3.3 连接获取的两种模式

| 模式 | 获取方式 | 语义 | 适用场景 |
|------|---------|------|---------|
| 等待模式 | `useBotConnections().get(botId)` + `request()` | 连接不可用时自动等待恢复 | 关键操作：发消息、重置会话、文件传输 |
| 快速失败模式 | `getReadyConn(botId)` | 连接不可用时立即返回 null | 非关键操作：加载消息列表、UI 渲染守卫 |

---

## 四、两层超时模型

`request()` 的超时分为两个独立阶段，**顺序执行、互不重叠**：

```
                 connectTimeout              requestTimeout
              ├────────────────────┤├──────────────────────────────┤
调用 request()                   DC 就绪                        收到响应
              │  等待连接建立/恢复  │  等待 RPC 响应               │
              │  (waitReady)       │  (pending promise)           │
```

### 4.1 connectTimeout（连接等待超时）

- 默认：30s（`DEFAULT_CONNECT_TIMEOUT_MS`）
- 触发条件：调用 `request()` 时 DC 尚未就绪
- 超时错误码：`CONNECT_TIMEOUT`
- 快速路径：DC 已就绪时跳过，直接进入发送阶段

### 4.2 requestTimeout（请求响应超时）

- 默认：30s（`DEFAULT_REQUEST_TIMEOUT_MS`）
- 通过 `options.timeout` 覆盖，`timeout: 0` 表示永不超时
- 超时错误码：`RPC_TIMEOUT`
- DC 断开时由 `clearRtc()` 统一 reject（错误码 `RTC_LOST`）

### 4.3 业务层超时配置

不同 RPC 方法按业务特性配置不同的 requestTimeout：

| 超时 | 方法 | 理由 |
|------|------|------|
| 0（永不超时） | `agent` | 长时运行的 Agent 任务，自身有 180s/30min 超时管理 |
| 600s | `sessions.reset` | Agent 收尾工作（记忆处理等）可能耗时较长 |
| 300s | `coclaw.topics.generateTitle` | LLM 生成，耗时不可预测 |
| 120s | `sessions.get`、`coclaw.sessions.getById` | Session 内容可能较大 |
| 60s | `coclaw.topics.list`、`coclaw.chatHistory.list`、`coclaw.files.list`、`coclaw.files.delete` | 元数据列表或递归操作 |
| 30s（默认） | 其他所有 RPC | 轻量级操作 |

### 4.4 文件二进制传输的超时

文件二进制传输（`downloadFile`/`uploadFile`/`postFile`）使用 `waitReady()` 确保连接就绪后创建临时 DataChannel，传输阶段不设置超时——文件大小不可预知，且 DC 断开会自然终止传输。

---

## 五、连接生命周期

### 5.1 正常建连

```
1. bots.store 创建 BotConnection 实例
2. bots.store 通过 SignalingConnection 发起 RTC offer
3. ICE 协商完成，DataChannel 'rpc' 打开
4. bots.store 调用 conn.setRtc(rtcConn)
5. 所有 waitReady() 的等待者被 resolve
6. 排队中的 request() 开始发送
```

### 5.2 断连与恢复

```
DC 断开（网络抖动、前台恢复等）
  → bots.store 调用 conn.clearRtc()
  → 所有 pending request 被 reject (RTC_LOST)
  → 所有 readyWaiters 被 reject (RTC_LOST)
  → bots.store 发起 RTC 重建
  → 重建成功后调用 conn.setRtc(newRtcConn)
  → 新的 request() 可正常工作
```

### 5.3 前台恢复场景

移动端 App 或浏览器 Tab 从后台恢复时：

1. `SignalingConnection` 检测前台恢复事件
2. 探测 WS 连通性（probe ping，超时 2.5s）
3. WS 不通 → 重建 WS → re-claim connId
4. RTC 不通 → bots.store 触发 RTC 重建
5. 恢复期间的 `request()` 自动排队等待

### 5.4 RTC Phase 状态机

```
idle → building → ready ⇄ recovering
                    ↓         ↓
                  failed ← failed
```

- `idle`：初始状态，未开始建连
- `building`：正在协商 ICE/SDP
- `ready`：DC 已打开，可用
- `recovering`：检测到断连，正在重建
- `failed`：重试耗尽，需要外部触发重连

`waitReady()` 在 `failed` 状态下会自动调用 `__onTriggerReconnect` 触发新一轮重连尝试。

---

## 六、Agent 两阶段响应

`agent` 方法采用特殊的两阶段响应协议（详见 [gateway-agent-rpc-protocol.md](gateway-agent-rpc-protocol.md)）：

```
request(id) ──────────────────────────────────────────────────── time
             │                                                    │
             ▼ res(status=accepted)    events(stream)    res(status=ok/error)
             │  ← ack, 不 resolve      ← 流式推送        ← 终态, resolve/reject
```

- `status: "accepted"` — 中间态，通过 `onAccepted` 回调通知调用方
- `status: "ok"` / `"error"` — 终态，resolve 或 reject promise
- 执行期间通过 `event:agent` 推送流式数据（assistant/tool/thinking/lifecycle stream）
- `timeout: 0`——Agent 任务不设置客户端超时，由 Agent 自身管理执行超时

---

## 七、架构分层

```
┌──────────────────────────────────────────────────────┐
│                  Vue 组件层                             │
│  ChatPage / FileBrowser / ManageBotsPage / ...        │
│  只从 Store 读数据，通过 Store actions 触发操作          │
└────────────────────────┬─────────────────────────────┘
                         │ reactive (Pinia)
┌────────────────────────┴─────────────────────────────┐
│                  Pinia Store 层                         │
│  bots.store / chat.store / files.store / ...           │
│  状态管理、RTC 生命周期编排、业务逻辑                     │
└────────────────────────┬─────────────────────────────┘
                         │ 调用 request() / on() / off()
┌────────────────────────┴─────────────────────────────┐
│                  Service 层（纯 JS，无 Vue 依赖）       │
│  BotConnection ── 业务 RPC + 连接等待                   │
│  SignalingConnection ── 信令 WS + connId + 心跳        │
│  WebRtcConnection ── ICE/SCTP/DataChannel 管理         │
│  file-transfer ── 二进制文件传输（临时 DC）              │
└──────────────────────────────────────────────────────┘
```

Service 层的三个核心类各司其职：

| 类 | 粒度 | 职责 |
|----|------|------|
| `SignalingConnection` | per-tab 单例 | 信令 WS 生命周期、心跳、connId claim、前台恢复探测 |
| `WebRtcConnection` | per-bot | ICE 协商、SCTP 通道、DC 管理、连通性检测 |
| `BotConnection` | per-bot | 业务 RPC 抽象、连接等待、事件分发——**业务层唯一接口** |
