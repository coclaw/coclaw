# WebRTC P2P 数据通道设计

> 创建时间：2026-03-23
> 最后更新：2026-03-24
> 状态：Phase 1 & 2 已实施，Phase 3 & 4 待实施
> 范围：UI ↔ Plugin 之间的 WebRTC DataChannel 通信方案，含 P2P 直连与 TURN 中继兜底

---

## 一、概述

### 背景

当前 UI 与 Plugin 的通信完全经由 Server 中转（WebSocket）。对于 JSON-RPC 和小数据量场景已够用，但随着文件传输等大数据量需求出现，Server 中转的带宽成本和延迟成为瓶颈。

### 目标

在 UI 与 Plugin 之间建立 WebRTC DataChannel：

1. **优先 P2P 直连**：网络允许时直接通信，不经过 Server
2. **TURN 中继兜底**：P2P 不可达时通过 TURN 服务器透明中继
3. **多通道隔离**：RPC 消息与文件传输走独立 DataChannel，互不阻塞
4. **对应用层透明**：无论 P2P 还是 TURN 中继，上层业务代码无需感知

### 核心设计原则

- **WebRTC 自身降级足够**：TURN 是 WebRTC 内建兜底机制，WS 通道不承担数据传输降级职责
- **WS 通道保留**：用于信令传输和其它业务交互（认证、元数据等）
- P2P / TURN 的选择由 ICE 框架自动完成，应用层不干预
- Server 仅承担信令转发和 TURN 凭证分发，不参与数据通道

### 术语

| 术语 | 含义 |
|------|------|
| Signaling | WebRTC 建连前交换 SDP 和 ICE Candidate 的过程，复用现有 WS 通道 |
| STUN | 帮助端点发现自身公网地址的协议服务 |
| TURN | P2P 不可达时的数据中继服务 |
| ICE | 自动选择最优连接路径的框架（host → srflx → relay） |
| DataChannel | WebRTC 中用于传输任意数据的通道，基于 SCTP |
| connId | Server 为每个 WS 连接分配的唯一标识，用于信令精确路由 |
| transportMode | UI 侧的传输模式标记（`'rtc'` / `'ws'` / `null`），决定业务消息走哪条通道 |

---

## 二、整体架构

```
Browser (UI)                    Server (coclaw.net)                Plugin (OpenClaw 侧)
     |                               |                                  |
     |--- WebSocket (signaling) ---->|<--- WebSocket (signaling) -------|
     |                               |                                  |
     |  GET /api/v1/turn/creds |  (TURN 凭证随 rtc:offer 注入)     |
     |<---- { urls, username, cred } |                                  |
     |                               |                                  |
     |        coturn (STUN+TURN) 同机部署                                |
     |                               |                                  |
     |====== DataChannel "rpc" (P2P 直连，优先) ========================>|
     |====== DataChannel "file:<id>" (临时，per-transfer) =============>|
     |                               |                                  |
     |====== DataChannel (经 TURN 中继，fallback) ======================>|
     |              ^                                                    |
     |              |_ 对应用层透明，代码完全相同                           |
```

### Server 的三个角色

| 角色 | 职责 | 实现方式 |
|------|------|---------|
| Signaling | 转发 SDP offer/answer 和 ICE Candidate | 现有 WS，增加 `rtc:` 前缀消息类型 |
| STUN | 帮助 UI 和 Plugin 发现公网地址 | coturn（独立容器） |
| TURN | P2P 不通时透明中继数据 | coturn（同一实例） |

### 协议栈

```
应用数据（JSON-RPC / 文件分片）
  ↓
SCTP（消息分帧、可靠性、多流复用）
  ↓
DTLS（加密，WebRTC 强制）
  ↓
ICE（路径选择：直连 or TURN 中继）
  ↓
UDP（主要）/ TCP（降级）
```

---

## 三、技术选型

### Plugin 侧（Node.js）：werift

纯 TypeScript/JavaScript 实现，零原生依赖。**选择理由**：OpenClaw `npm install --ignore-scripts` 会跳过原生绑定库的 postinstall，werift 纯 JS 实现完全规避此问题。

关键注意事项：
- `iceServers.urls` **必须是单个 `string`**，不是数组，每个 URL 须拆分为独立对象
- 统一使用 W3C 回调风格（`pc.onicecandidate`）
- `dc.onmessage` 的 `event.data` 为 `string | Buffer`
- 获取 candidate 类型：`pc.iceTransports[0].connection.nominated?.localCandidate.type`
- `await pc.close()` 是异步方法

### Browser 侧

原生 WebRTC API。Capacitor WebView（Android Chromium / iOS WKWebView 14.3+）原生支持 DataChannel，无需额外插件。

### STUN/TURN 服务：coturn

工业标准实现，Docker 官方镜像。

---

## 四、连接模型

- **UI 是主叫方**（Offerer），**Plugin 是被叫方**（Answerer）
- 一个 UI 实例对一个 Plugin 建立**一条 PeerConnection**
- 同一用户多个浏览器 tab 各自独立建连（各有独立 connId）
- UI 确认 Plugin 在线（WS 通道已连通）后，**自动发起**建连

---

## 五、数据通道设计

### 5.1 持久通道：`rpc`

| 属性 | 值 |
|------|-----|
| 通道名 | `rpc` |
| 创建方 | UI（主叫方），WebRTC 连接建立时创建 |
| 生命周期 | 与 PeerConnection 相同 |
| 配置 | `ordered: true`（可靠有序） |
| 用途 | JSON-RPC 消息、文件操作控制消息（list / delete） |

### 5.2 临时通道：文件传输（Phase 3，待实施）

每次文件传输创建一条独立的临时 DataChannel（`file:<transferId>`），传输完成后关闭。

- 统一由 **UI 创建**（类似 HTTP client 发起连接）
- `ordered: true`，应用层分片（16KB）
- 监听 `bufferedamountlow` 事件流控
- DataChannel 创建极其廉价（仅新建 SCTP stream，无需重新 DTLS 握手），天然隔离多文件并发

> 详见 `file-management.md`。

---

## 六、信令协议

复用现有 WS 通道，新增 `rtc:` 前缀消息类型。

### 6.1 connId 机制

**问题**：同一用户多个 tab 连同一 bot，Plugin 的 `rtc:answer` 必须精确投递到发起 offer 的那个 UI socket。

**方案**：Server 为每个 WS 连接分配 `connId`（格式：`c_<随机hex>`），挂在 socket 对象上。

| 方向 | 路由依据 |
|------|---------|
| UI → Plugin | `botId`（从 WS 连接上下文取） |
| Plugin → UI | `toConnId`（消息字段），Server 在 `uiSockets` 中查找匹配 socket |

`connId` 与 WS 连接同生同灭，重连后获得新 `connId`。

### 6.2 信令消息类型

| 消息类型 | 方向 | 用途 |
|----------|------|------|
| `rtc:offer` | UI → Server → Plugin | SDP offer |
| `rtc:answer` | Plugin → Server → UI | SDP answer |
| `rtc:ice` | 双向 | ICE Candidate 交换 |
| `rtc:ready` | UI → Server | DataChannel 就绪通知 |
| `rtc:closed` | 双向 | WebRTC 连接断开通知 |

### 6.3 消息格式

```javascript
// UI → Plugin（Server 转发时自动附上 fromConnId + turnCreds）
{ type: "rtc:offer", payload: { sdp: "..." } }
// → Plugin 收到:
{ type: "rtc:offer", fromConnId: "c_a7f3", payload: { sdp: "..." }, turnCreds: { username, credential, ttl, urls } }

// Plugin → UI（通过 toConnId 定向投递）
{ type: "rtc:answer", toConnId: "c_a7f3", payload: { sdp: "..." } }

// ICE（双向，UI 发时无 fromConnId，Server 转发时附上；Plugin 发时带 toConnId）
{ type: "rtc:ice", payload: { candidate, sdpMid, sdpMLineIndex } }

// 状态通知
{ type: "rtc:ready" }   // UI → Plugin
{ type: "rtc:closed" }  // 双向
```

### 6.4 建连流程

```
UI (connId=c_a7f3)             Server                       Plugin
 |                            |                            |
 | GET /api/v1/turn/creds     |                            |
 |<--- { urls, user, cred } --|                            |
 |                            |                            |
 | -- rtc:offer ------------> | 附上 fromConnId + turnCreds |
 |                            | -- rtc:offer ------------> |
 |                            |                            |
 |                            | <-- rtc:answer             |
 | <-- rtc:answer ----------- |   (toConnId 定向投递)        |
 |                            |                            |
 | -- rtc:ice --------------> | -- rtc:ice --------------> |
 | <------------- rtc:ice --- | <------------- rtc:ice --- |
 |    （多轮交换）              |                            |
 |                            |                            |
 |========= DataChannel 建立（P2P 或 TURN）===========>    |
 |                            |                            |
 | -- rtc:ready ------------> | -- rtc:ready ------------> |
```

Server 对 `rtc:*` 消息**仅做透传路由**，不解析 SDP/ICE 内容。

---

## 七、传输模式选择

### 核心原则

**传输模式一旦选定就固定**，不在两个通道之间动态切换。唯一例外是 RTC 不可恢复时的降级（属于"放弃旧通道并切换"）。

### 消息流

```
RTC 模式：
UI  ──req──> DataChannel("rpc") ──────────────> Plugin ──> Gateway
UI  <──res── DataChannel("rpc") <────────────── Plugin <── Gateway
UI  <─event─ DataChannel("rpc") <────────────── Plugin <── Gateway

Plugin 同时将 res/event 广播给 Server WS（向后兼容，暂时保留），
Server 继续广播给 UI WS，但 UI 在 RTC 模式下忽略这些 WS 业务消息。
（例外：协商期间通过 WS 发出的遗留请求，其 WS 响应仍会被正常处理。）

WS 降级模式：
UI  ──req──> WS ──> Server ──> WS ──> Plugin ──> Gateway
UI  <──res── WS <── Server <── WS <── Plugin <── Gateway
UI  <─event─ WS <── Server <── WS <── Plugin <── Gateway
```

### 选择流程

**首次连接**：

```
WS 首次连通
  → transportMode = null（协商中，业务请求通过 WS 兜底发送）
  → 后台异步发起 RTC 建连（initRtcAndSelectTransport），不阻塞业务初始化
  → 启动超时计时器（15 秒）

情况 A：RTC DataChannel open 在计时器内触发
  → transportMode = 'rtc'
  → 后续请求走 DataChannel；协商期间通过 WS 发出的遗留请求仍由 WS 响应处理

情况 B：计时器到期，RTC 未就绪
  → transportMode = 'ws'
  → 关闭/放弃 RTC 尝试
```

> **设计变更记录**：初版设计中 `transportMode === null` 时阻塞业务请求（reject `NOT_CONNECTED`）。
> 实施后发现 RTC 协商可能耗时 2-15 秒，阻塞期间用户无法交互，体验差。
> 改为 **null 时 WS 兜底**：业务请求立即通过 WS 发送，RTC 后台异步建连。

**WS 重连**：

```
WS 重连
  → transportMode 保持不变（不重置为 null，避免阻塞用户操作）
  → 异步发起 RTC 建连（含防重入守卫）
  → RTC 仍健康 → 函数提前返回
  → RTC 不存在/已 failed → 后台尝试新建
    → 成功：原子切换 transportMode = 'rtc'
    → 超时/失败：transportMode 保持 'ws'
```

> **关键**：transportMode 必须在 `dc.onopen`（DataChannel 实际可用）时设置，而非在 `pc.connectionState === 'connected'` 时设置。

### 超时时间

**15 秒**。TURN relay 建连通常 2-5 秒，15 秒足够覆盖慢网络。

### 降级粘性

一旦降级到 WS，**当前 WS 连接生命周期内不再尝试 RTC**。下次 WS 重连时重新尝试。

### DataChannel 消息格式

复用现有 WS RPC 协议格式，无需定义新协议：

```javascript
// 请求（UI → Plugin）
{ type: "req", id: "ui-1711234567-1", method: "agent", params: { ... } }

// 响应（Plugin → UI）
{ type: "res", id: "ui-1711234567-1", ok: true, payload: { ... } }

// 事件（Plugin → UI）
{ type: "event", event: "agent", payload: { ... } }
```

### 用户状态呈现

| transportMode | 用户看到 | 说明 |
|---|---|---|
| `null` | 已连接 | WS 已通，RTC 后台协商中，用户可正常交互 |
| `'rtc'` | 已连接 | 可选：小图标标记 P2P / Relay |
| `'ws'` | 已连接 | 可选：小图标标记"中继模式" |
| RTC 恢复中 | 重连中... | ICE restart / rebuild 进行中 |

---

## 八、连接生命周期与恢复

### 8.1 ICE 层保活

WebRTC ICE 层自动发送 STUN Binding Indication（约 15-30s 间隔），**应用层不需要 ping/pong 心跳**。

### 8.2 RTC 连接恢复策略

| 连接状态 | 处理方式 |
|----------|---------|
| `disconnected` | 等待 ICE 层自动恢复（短暂网络抖动通常自愈） |
| `failed` | 发起 ICE restart（`iceRestart: true`），保留 DataChannel 仅重新协商路径 |
| ICE restart 失败 | full rebuild（新 PeerConnection） |
| full rebuild 耗尽 | 降级到 WS |

### 8.3 RTC 中途失败的降级处理

```
RTC 不可恢复
  → transportMode = 'ws'
  → reject 所有 viaRtc 的挂起请求（error code: RTC_LOST）
  → 后续请求自动走 WS
  → 用户可能需要重发消息
```

**不尝试续接正在进行的操作**，处理方式与 WS 断线重连一致。

#### Fallback 触发条件

| 触发 | 条件 |
|---|---|
| RTC 建连超时 | 15 秒内 DataChannel 未就绪 |
| RTC 不可恢复 | ICE restart（2次）+ full rebuild（3次）全部耗尽 |

| **不**触发 | 条件 |
|---|---|
| RTC `disconnected` | ICE 层自动恢复中 |
| 单次 RTC `failed` | ICE restart 未耗尽 |
| WS 断开重连 | RTC 可能仍健康 |

### 8.4 RTC 与 WS 解耦

RTC 独立管理，WS 断开重连不影响健康的 RTC 连接。

```
WS 断开重连
  │  若 RTC 仍然 connected → 无操作，RTC 继续工作
  │  若 RTC 不存在        → 重新执行传输选择流程
  │  若 RTC 已 failed     → 全新建连（full rebuild，新 connId）

RTC 自身恢复
  │  disconnected → 等 ICE 自动恢复
  │  failed       → ICE restart（需 WS 在线传信令）
  │              → 若 WS 此时也断了，等 WS 恢复后再 restart
  │  ICE restart 失败 → full rebuild
  │  full rebuild 耗尽 → 降级到 WS
```

### 8.5 connId 跨 WS 重连

WS 重连后 Server 分配新 `connId`，Plugin 侧 `WebRtcPeer.__sessions` 以旧 `connId` 为 key。

处理方案：
- RTC 仍 `connected`：无需信令，无问题
- RTC 已 `failed`：直接 full rebuild（新 PC、新 offer、新 connId），不尝试 ICE restart
- **ICE restart 仅在同一 WS 连接内使用**（connId 不变时）

### 8.6 WS 重连后重新触发传输选择

WS 状态监听器为**持久**监听，每次 WS `connected` 时调用 `initRtcAndSelectTransport`。该函数已有防重入守卫（RTC 健康时跳过），重复调用安全。

### 8.7 TURN 凭证刷新

TURN 凭证有 TTL（默认 24h）。UI 在凭证剩余有效期不足 1h 时请求新凭证，下一次 ICE restart 时使用。已建立的 TURN allocation 不受凭证过期影响。

### 8.8 WebSocket 通道保留

WS 始终保持，职责：信令通道、业务交互（认证等）、Plugin-Server 连接。

### 8.9 连接路径日志

建连成功后记录 ICE candidate 类型（`host`=局域网直连、`srflx`=NAT 穿透 P2P、`relay`=TURN 中继），帮助排查连接路径。

### 8.10 恢复策略汇总

| # | 场景 | 处理 |
|---|------|------|
| 1 | RTC `disconnected` | 等待 ICE 自动恢复 |
| 2 | RTC `failed`，WS 在线且 connId 未变 | ICE restart（最多 2 次） |
| 3 | ICE restart 耗尽 | full rebuild（最多 3 次） |
| 4 | full rebuild 耗尽 | 降级到 WS |
| 5 | WS 断开，RTC 仍 `connected` | RTC 不动，用户可继续交互 |
| 6 | WS 重连，RTC 仍 `connected` | 跳过 initRtcForBot，transportMode 不变 |
| 7 | WS 重连，RTC 已 `failed` | 直接 full rebuild（新 connId） |
| 8 | WS 断开，RTC 也 `failed` | 等 WS 恢复后 full rebuild |
| 9 | 业务请求时 transportMode 为 null | 通过 WS 兜底发送（WS 未连通时 reject `WS_CLOSED`） |

---

## 九、各端实现架构

### 9.1 Server 侧

**TURN 凭证 API**：`GET /api/v1/turn/creds`，基于 `TURN_SECRET` 通过 HMAC-SHA1 生成临时凭证。Plugin 侧凭证由 Server 在转发 `rtc:offer` 时注入消息中。

**信令转发**：在 `bot-ws-hub.js` 中增加 `rtc:*` 类型路由。UI 来源按 `botId` 转发到 bot socket 并附上 `fromConnId`；Plugin 来源按 `toConnId` 定向投递到匹配的 UI socket。

**Server 不参与 Phase 2 变更**——传输模式切换完全在 UI 与 Plugin 之间完成。

### 9.2 Plugin 侧：WebRtcPeer 类

`plugins/openclaw/src/webrtc-peer.js`，由 `RealtimeBridge` 持有。

```
RealtimeBridge
├── serverWs       — CoClaw Server WS 连接（信令 + 业务消息）
├── gatewayWs      — OpenClaw Gateway WS 连接（本地，不变）
└── webrtcPeer     — WebRTC PeerConnection 管理
```

- 以 `connId` 为粒度管理多条 PeerConnection（`__sessions: Map<connId, { pc, rpcChannel }>`）
- 通过 `handleSignaling(msg)` 处理来自 Server 转发的信令
- 延迟创建（收到第一个 rtc: 消息时），通过构造函数 `PeerConnection` 参数支持依赖注入（测试用）
- 构造函数 `onRequest` 回调：`(payload, connId) => void`，接收 DataChannel 上的业务请求
- `broadcast(payload)`：向所有已打开的 rpcChannel 广播 gateway 响应/事件
- `dc.onmessage`：解析 JSON，`type === 'req'` 时调用 `onRequest`

#### RealtimeBridge 集成

- 创建 WebRtcPeer 时传入 `onRequest`，复用 `__handleGatewayRequestFromServer` 处理
- gateway 响应/事件转发处追加 `webrtcPeer.broadcast(payload)`
- 合成的错误响应（`GATEWAY_OFFLINE` / `GATEWAY_SEND_FAILED`）也需 broadcast

> **注意**：不能统一替换 `__forwardToServer` 为 forward+broadcast helper，因为 `__forwardToServer` 也用于 RTC 信令消息回传，信令不应广播到 DataChannel。**仅在 gateway 业务响应/事件和合成错误响应处追加 broadcast。**

### 9.3 UI 侧

#### BotConnection

- `__transportMode`（`'rtc'` | `'ws'` | `null`）和 `__rtc`（WebRtcConnection 引用）
- `setTransportMode(mode)`：RTC → WS 降级时 reject 所有 `viaRtc` 挂起请求（code: `RTC_LOST`）
- `request()` 按 transportMode 分支发送：`'rtc'` 走 DataChannel、`'ws'` 或 `null` 走 WS 兜底
- `__onMessage()`：RTC 模式下忽略 WS 业务消息（`res`/`event`），但放行 `viaRtc === false` 的遗留请求响应；系统消息（`pong`、`rtc:*`、`session.expired`、`bot.unbound`）始终处理
- `__onRtcMessage(payload)`：处理 DataChannel 收到的 `res`/`event`，复用 `__handleRpcResponse`
- WS close 时：RTC 模式下仅 reject `viaRtc === false` 的请求，保留 RTC 请求

> **关键设计点**：`transportMode === 'ws'` 时消息收发路径与原 WS-only 完全一致，WS fallback 不是"新功能"而是"不启用新功能"。

#### WebRtcConnection

- `send(payload)` 和 `get isReady()`
- `onReady` 回调（在 `dc.onopen` 时触发，通知外部 DataChannel 可用）
- `dc.onmessage` 回调 `BotConnection.__onRtcMessage`

#### 传输选择编排（initRtcAndSelectTransport）

封装在 `webrtc-connection.js` 模块级函数。核心逻辑：防重入守卫 → 15 秒超时定时器 → `rtc.onReady` 时设 `'rtc'` → 超时/失败时设 `'ws'` → `rtc.onStateChange` 中 `failed` 时降级。

#### bots.store

持久监听 WS 状态：首次 `connected` 执行完整初始化（loadAgents 等），后续 `connected` 仅重新触发传输选择。`initRtcAndSelectTransport` 以 fire-and-forget 方式调用（不 await），不阻塞业务初始化。`removeBotById()` 需清理 `initializedBots`。

---

## 十、DataChannel 发送流控

### RPC 消息

RPC 消息为离散的 JSON 文本，多数较小（几百字节到几 KB），但部分响应可能较大（如包含 base64 图片的对话历史，可达数 MB）。

| 平台 | `send()` 缓冲区满时 | 处理 |
|------|---------------------|------|
| **Plugin（werift）** | 不抛异常，数据推入无上限 JS 数组 | 对 RPC 场景内存堆积可忽略，**无需额外处理** |
| **Browser** | 抛 `DOMException`，通道不关闭 | 实现基于 `bufferedAmount` 的排队发送 |

Browser 侧在 `webrtc-connection.js` 的 `send()` 中实现 `bufferedAmount` 检查与排队机制，缓冲区空间不足时暂停发送，`bufferedamountlow` 触发后恢复。

### 文件传输流控

详见 `file-management.md` 第 6.2 节。两端均需基于 `bufferedAmount` / `bufferedamountlow` 实现背压控制。

---

## 十一、边界情况

| 场景 | 处理 |
|------|------|
| RTC 协商中用户发消息 | 通过 WS 兜底发送，用户无感知等待 |
| null→rtc 过渡期间的 WS 遗留响应 | `__onMessage` 检查 pending map 中 `viaRtc === false` 的 waiter，匹配则正常处理，不丢弃 |
| null→rtc 过渡期间的 WS 遗留事件（event） | 可能丢失。窗口极窄（仅 `dc.onopen` → `setTransportMode('rtc')` 的瞬间），且 event 为尽力而为的推送，影响有限 |
| RTC 中途断开（可恢复） | 挂起请求保持等待；ICE restart / rebuild 触发 |
| RTC 中途断开（不可恢复） | 降级到 WS；reject 所有 `viaRtc` 请求（code: `RTC_LOST`） |
| WS 断开但 RTC 健康 | 业务正常走 RTC；WS pending 清理时跳过 `viaRtc` 请求 |
| 多 tab 同时连接 | 各 tab 独立 DataChannel，Plugin broadcast 全部发送 |
| Plugin 重启 | 所有 RTC 断开，UI 走恢复流程 |
| Plugin 内部 RPC 响应 | ID 前缀为 `coclaw-gw-*` / `coclaw-agent-*`，被内部消费后 return，不广播 |
| Plugin 合成的错误响应 | 同时发给 Server WS 和 RTC broadcast |
| 两阶段 `agent` 请求中 RTC 断开 | pending reject → chat.store 捕获错误 → 清理 event listener → 用户重发 |

---

## 十二、部署方案

### coturn 容器

- `deploy/compose.yaml` 中新增 coturn 服务，使用 `network_mode: host`（TURN 需分配 relay 端口池，逐个映射不现实）
- coturn 配置通过 envsubst 模板注入环境变量

### 环境变量

| 变量 | 用途 |
|------|------|
| `TURN_SECRET` | Server 与 coturn 间的共享密钥 |
| `TURN_EXTERNAL_IP` | coturn 公网 IP |
| `TURN_MIN_PORT` / `TURN_MAX_PORT` | TURN relay 端口范围（默认 50000-50500） |

### 防火墙

| 端口 | 协议 | 用途 |
|------|------|------|
| 3478 | UDP + TCP | STUN/TURN 监听 |
| 50000-50500 | UDP | TURN relay 端口池 |

### 本地开发

WSL2 环境中 Browser 与 Plugin 处于不同网络命名空间，WSL2 不转发 UDP。本地 coturn 通过 TCP transport 中继解决此问题。非 WSL2 环境下 ICE 直接选择 host candidate 直连。

---

## 十三、实施阶段

| 阶段 | 内容 | 状态 |
|------|------|------|
| Phase 1 | 基础设施：WebRTC DataChannel 建连、P2P/TURN 通路验证 | **已完成** |
| Phase 2 | 通信切换：RPC 消息迁移到 DataChannel，WS 兜底 | **已完成** |
| Phase 3 | 文件传输：临时 DataChannel 文件传输（详见 `file-management.md`） | 待实施 |
| Phase 4 | 稳定性与优化：连接质量监控、TURN over TLS | 待实施 |

---

## 十四、风险与约束

| 风险 | 缓解措施 |
|------|---------|
| werift 性能不足 | 个人场景可接受；极端情况可切换到 node-datachannel |
| coturn 崩溃 | compose 自动重启 + 健康检查；P2P 直连不受影响 |
| 对称 NAT | TURN 自动兜底，对应用层透明 |
| 浏览器兼容性 | 现有 WS 通道保留，业务不受影响 |
| TURN 凭证过期 | UI 在过期前主动刷新 |
| werift 作为首个 runtime 依赖 | 纯 JS 实现，无原生编译开销，影响可控 |
