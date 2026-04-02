# WebRTC P2P 数据通道设计

> 创建时间：2026-03-23
> 最后更新：2026-03-25
> 状态：Phase 1-3 已实施，Phase 4 待实施
> 注意：Phase 1-2 实施后部分设计已被后续文档取代（信令重构、ICE restart 移除等），过时部分已在正文中标注。以代码为准。
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
| connId | ~~Server 为每个 WS 连接分配的唯一标识~~ → 当前由 UI 生成（`c_<uuid>`），跨 WS 重连持久保留 |
| ~~transportMode~~ | ~~UI 侧的传输模式标记~~ → 已移除，DataChannel 是唯一 RPC 通道 |

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
| 消息大小限制 | 已实现应用层分片/重组，无大小限制。发送端根据对端 SDP `a=max-message-size` 声明值自动分片，接收端透明重组。详见下方§5.3 |

### 5.1.1 RPC DataChannel 应用层分片协议

当消息的 UTF-8 字节长度超过对端声明的 `maxMessageSize` 时，发送端自动将消息切为多个二进制 chunk 发送；接收端透明重组后交付给上层。小于阈值的消息仍以 string 直接发送（零开销快路径）。

**消息类型区分**：接收端通过 `typeof event.data` 判断——`string` = 普通消息，`ArrayBuffer`/`Buffer` = 分片 chunk。

**二进制帧格式**（每个 chunk）：

```
Byte 0:    flag (0x01=BEGIN, 0x00=MIDDLE, 0x02=END)
Byte 1-4:  msgId (uint32 BE, 发送端自增计数器)
Byte 5+:   原始 JSON 字符串的 UTF-8 编码片段
```

- `msgId`：每个 DataChannel 实例维护独立计数器，从 1 自增，DC 断开即重置。当前有序 DC + 同步发送循环保证不交错，msgId 为未来支持交错分片预留。
- 不需要 `seq`：ordered DC 保证同一 msgId 的 chunk 按序到达。
- 防御措施：重组缓冲区上限 50MB、单消息最大 10000 个 chunk、DC 关闭时清空缓冲区。

**对端 maxMessageSize 获取方式**：
- 插件侧：从 UI 的 SDP offer 解析 `a=max-message-size:N`，默认 65536
- UI 侧：通过浏览器标准 API `pc.sctp.maxMessageSize` 获取（即 werift 在 SDP answer 中声明的值），默认 65536

**实现位置**：
- 插件侧：`plugins/openclaw/src/utils/dc-chunking.js`（`chunkAndSend` + `createReassembler`）
- UI 侧：`ui/src/utils/dc-chunking.js`（`buildChunks` + `createReassembler`）

### 5.2 临时通道：文件传输（Phase 3，已实施）

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

> **⚠ 已过时**：connId 机制已被 `rtc-signaling-channel.md` §3 取代。当前实现中 connId 由 UI 侧生成（格式 `c_<uuid>`），跨 WS 重连持久保留，不再与 WS 连接同生同灭。

**问题**：同一用户多个 tab 连同一 bot，Plugin 的 `rtc:answer` 必须精确投递到发起 offer 的那个 UI socket。

**方案**：~~Server 为每个 WS 连接分配 `connId`（格式：`c_<随机hex>`），挂在 socket 对象上。~~

| 方向 | 路由依据 |
|------|---------|
| UI → Plugin | `botId`（从 WS 连接上下文取） |
| Plugin → UI | `toConnId`（消息字段），Server 在 `uiSockets` 中查找匹配 socket |

~~`connId` 与 WS 连接同生同灭，重连后获得新 `connId`。~~

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

## 七、传输架构

### 核心原则

**DataChannel 是唯一的业务 RPC 通道。** WS 仅承载信令（`rtc:*`）和哨兵事件（`pong`、`session.expired`、`bot.unbound`），不传输业务 `req`/`res`/`event`。DC 未就绪时业务请求直接 reject（`DC_NOT_READY`），不 fallback 到 WS。

> **设计变更记录**：v0.10.6 及之前版本采用 `transportMode` 状态机管理 WS/RTC 双通道路由，
> WS 作为 fallback。实施后发现双通道并行引入大量分支逻辑（`viaRtc` 标记、模式切换、
> 选择性 reject、消息过滤），使通信代码脆弱且难以调试。简化为 DC-only 后净减 ~400 行代码。

### 消息流

```
业务 RPC：
UI  ──req──> DataChannel("rpc") ──────────────> Plugin ──> Gateway
UI  <──res── DataChannel("rpc") <────────────── Plugin <── Gateway
UI  <─event─ DataChannel("rpc") <────────────── Plugin <── Gateway

信令（WS）：
UI  ──rtc:offer/ice/ready/closed──> WS ──> Server ──> WS ──> Plugin
UI  <──rtc:answer/ice/closed────── WS <── Server <── WS <── Plugin

Plugin 仍将 res/event 广播给 Server WS（向后兼容），
Server 广播给 UI WS，但 UI 始终忽略 WS 上的业务消息。
```

### 连接流程

**首次连接**：

```
WS 首次连通
  → __fullInit 启动
  → await __ensureRtc（阻塞，最多 3 轮重试 × 15s 超时）
  → DC open → 业务 RPC 可用
  → checkPluginVersion、loadAgents 等后续初始化通过 DC 执行
  → 若所有重试耗尽 → __fullInit 失败，initialized 重置，等下次重试
```

**WS 重连**：

```
WS 重连
  → 异步发起 initRtc（单次尝试，含幂等守卫）
  → RTC 仍健康 → 函数提前返回
  → RTC 不存在/已 failed → 尝试新建
    → 成功 → DC 恢复，按断连时长决定是否刷新 stores
    → 失败 → 等待下次 WS 重连重试
```

### 超时时间

**15 秒**。TURN relay 建连通常 2-5 秒，15 秒足够覆盖慢网络。

### RTC 不可用时的功能限制

当 DC 未就绪时：
- 所有业务 RPC 请求 reject `DC_NOT_READY`
- 文件发送不可用（文件传输依赖独立 DC，无 RTC 则不可用）
- UI 显示"连接中"状态

### DataChannel 消息格式

复用现有 RPC 协议格式：

```javascript
// 请求（UI → Plugin）
{ type: "req", id: "ui-1711234567-1", method: "agent", params: { ... } }

// 响应（Plugin → UI）
{ type: "res", id: "ui-1711234567-1", ok: true, payload: { ... } }

// 事件（Plugin → UI）
{ type: "event", event: "agent", payload: { ... } }
```

### 用户状态呈现

| rtcState | 用户看到 | 说明 |
|---|---|---|
| `null` | 连接中 | WS 已通，RTC 建连中 |
| `'connected'` | 已连接 | 可选：小图标标记 P2P / Relay |
| `'failed'` | 连接失败 | 所有恢复尝试耗尽 |
| `'disconnected'` | 重连中... | ICE restart / rebuild 进行中 |

---

## 八、连接生命周期与恢复

### 8.1 ICE 层保活

WebRTC ICE 层自动发送 STUN Binding Indication（约 15-30s 间隔），**应用层不需要 ping/pong 心跳**。

### 8.2 RTC 连接恢复策略

> **⚠ 已过时**：UI 侧 ICE restart 已移除（`webrtc-connection.js` 注释"ICE restart 已移除"）。RTC `failed` 直接由 `bots.store.__scheduleRetry` 退避重试（初始 10s，×2 增长，最大 120s，最多 8 次），不再使用 ICE restart。

| 连接状态 | 处理方式 |
|----------|---------|
| `disconnected` | 等待 ICE 层自动恢复（短暂网络抖动通常自愈） |
| ~~`failed`~~ | ~~发起 ICE restart（`iceRestart: true`），保留 DataChannel 仅重新协商路径~~ |
| ~~ICE restart 失败~~ | ~~full rebuild（新 PeerConnection）~~ |
| full rebuild 耗尽 | reject 所有挂起请求（`RTC_LOST`），等待下次 WS 重连时重试 |

### 8.3 RTC 不可恢复的处理

```
RTC 不可恢复
  → clearRtc()：释放引用 + reject 所有挂起请求（error code: RTC_LOST）
  → 后续 request() 返回 DC_NOT_READY
  → 下次 WS 重连触发 initRtc 重新尝试建连
  → 用户可能需要重发消息
```

**不尝试续接正在进行的操作**。

| **不**触发恢复 | 条件 |
|---|---|
| RTC `disconnected` | ICE 层自动恢复中 |
| 单次 RTC `failed` | ICE restart 未耗尽 |
| WS 断开重连 | RTC 可能仍健康 |

### 8.4–8.6 信令通道相关恢复（已被取代）

> **注（2026-03-30 更新）**：§8.4–8.6 已被 [RTC 信令通道设计 §7](rtc-signaling-channel.md) 取代。关键变更：connId 由 UI 侧生成并在 WS 重连后持久保留；ICE restart 跨 WS 重连可用；"降级到 WS"已移除（DataChannel 是唯一 RPC 通道）。

### 8.7 TURN 凭证刷新

TURN 凭证有 TTL（默认 24h）。UI 在凭证剩余有效期不足 1h 时请求新凭证，下一次 ICE restart 时使用。已建立的 TURN allocation 不受凭证过期影响。

### 8.8 WebSocket 通道保留

WS 始终保持，职责：信令通道、业务交互（认证等）、Plugin-Server 连接。

### 8.9 连接路径日志

建连成功后记录 ICE candidate 类型（`host`=局域网直连、`srflx`=NAT 穿透 P2P、`relay`=TURN 中继），帮助排查连接路径。

### 8.10 恢复策略汇总

> **⚠ 部分已过时**：第 2-3 项 ICE restart 相关策略已不再使用，当前 RTC `failed` 直接走退避重试。

| # | 场景 | 处理 |
|---|------|------|
| 1 | RTC `disconnected` | 等待 ICE 自动恢复（10s 超时后升级 failed） |
| 2 | ~~RTC `failed`，信令 WS 在线~~ | ~~ICE restart（connId 不变，最多 5 次）~~ → 退避重试 full rebuild |
| 3 | ~~ICE restart 耗尽~~ | ~~full rebuild（复用 connId，最多 3 次）~~ → 退避重试（10s→120s，最多 8 次） |
| 4 | 退避重试耗尽 | reject 挂起请求（`RTC_LOST`），等下次 WS 重连重试 |
| 5 | 信令 WS 断开，RTC 仍 `connected` | RTC 不动，用户可继续交互 |
| 6 | 信令 WS 重连，RTC 仍 `connected` | 跳过 initRtc，RTC 继续工作 |
| 7 | 信令 WS 重连，RTC 已 `failed` | full rebuild（复用 connId） |
| 8 | 信令 WS 断开，RTC 也 `failed` | 等 WS 恢复后 full rebuild |
| 9 | 业务请求时 DC 未就绪 | reject `DC_NOT_READY` |

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

- `__rtc`（WebRtcConnection 引用），无 transportMode 状态机
- `request()` 仅走 DataChannel：DC ready → 发送；否则 reject `DC_NOT_READY`
- `__onMessage()`：仅处理信令/哨兵消息（`pong`、`rtc:*`、`session.expired`、`bot.unbound`），所有业务 `res`/`event` 始终忽略
- `__onRtcMessage(payload)`：处理 DataChannel 收到的 `res`/`event`，复用 `__handleRpcResponse`
- `clearRtc()`：释放 RTC 引用 + reject 所有挂起请求（`RTC_LOST`）
- WS close 时：不影响任何 pending（全在 DC 上）

#### WebRtcConnection

- `send(payload)` 和 `get isReady()`
- `onReady` 回调（在 `dc.onopen` 时触发，通知外部 DataChannel 可用）
- `dc.onmessage` 回调 `BotConnection.__onRtcMessage`

#### initRtc

封装在 `webrtc-connection.js` 模块级函数。核心逻辑：防重入守卫 → 15 秒超时定时器 → `rtc.onReady` 时 resolve `'rtc'` → 超时/失败时 resolve `'failed'`。无 WS fallback 路径。

#### bots.store

持久监听 WS 状态：首次 `connected` 执行 `__fullInit`（await `__ensureRtc` → 业务 RPC），后续 `connected` 触发单次 `initRtc`（非 `__ensureRtc`，避免多轮重试阻塞）。`removeBotById()` 清理 RTC 实例。

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
| RTC 建连中用户发消息 | reject `DC_NOT_READY`，UI 显示"连接中"状态 |
| RTC 中途断开（可恢复） | 挂起请求保持等待；ICE restart / rebuild 触发 |
| RTC 中途断开（不可恢复） | `clearRtc()` reject 所有挂起请求（`RTC_LOST`）；下次 WS 重连重试 |
| WS 断开但 RTC 健康 | 业务正常走 DC；WS close 不影响 pending |
| 多 tab 同时连接 | 各 tab 独立 DataChannel，Plugin broadcast 全部发送 |
| Plugin 重启 | 所有 RTC 断开，UI 走恢复流程 |
| Plugin 内部 RPC 响应 | ID 前缀为 `coclaw-gw-*` / `coclaw-agent-*`，被内部消费后 return，不广播 |
| Plugin 合成的错误响应 | 同时发给 Server WS 和 RTC broadcast |
| 两阶段 `agent` 请求中 RTC 断开 | pending reject (`RTC_LOST`) → chat.store 捕获错误 → 清理 event listener → 用户重发 |
| Plugin ICE candidates 先于 answer 到达 | UI 侧缓存到 `__pendingCandidates`，`setRemoteDescription` 完成后批量 `addIceCandidate` |

---

## 十二、部署方案

### coturn 容器

- `deploy/compose.yaml` 中新增 coturn 服务，使用 `network_mode: host`（TURN 需分配 relay 端口池，逐个映射不现实）
- `--listening-ip` 和 `--relay-ip` 限定为 `TURN_INTERNAL_IP`，避免绑定到 Docker bridge 网络
- `--external-ip=${TURN_EXTERNAL_IP}/${TURN_INTERNAL_IP}`，告知 coturn 公网/内网 IP 的 NAT 映射关系（云主机环境必需）
- `--log-file=stdout`，日志输出到 stdout 由 Docker json-file 驱动收集

### 环境变量

| 变量 | 用途 |
|------|------|
| `TURN_SECRET` | Server 与 coturn 间的共享密钥 |
| `TURN_EXTERNAL_IP` | coturn 公网 IP |
| `TURN_INTERNAL_IP` | coturn 内网 IP（云主机 NAT 环境必填，即 eth0 的 VPC 地址） |
| `TURN_PORT` | coturn 监听端口（默认 3478） |
| `TURN_MIN_PORT` / `TURN_MAX_PORT` | TURN relay 端口范围（默认 50000-51000） |

### 防火墙

| 端口 | 协议 | 防火墙 label | 用途 |
|------|------|-------------|------|
| 3478 | UDP + TCP | `coturn listening (STUN/TURN)` | 客户端连接入口：地址发现 + 中继控制 + 中继数据 |
| 50000-51000 | UDP | `coturn relay pool` | 中继端口池：对端的数据入口 |

### 本地开发

WSL2 环境中 Browser 与 Plugin 处于不同网络命名空间，WSL2 不转发 UDP。本地 coturn 通过 TCP transport 中继解决此问题。非 WSL2 环境下 ICE 直接选择 host candidate 直连。

---

## 十三、实施阶段

| 阶段 | 内容 | 状态 |
|------|------|------|
| Phase 1 | 基础设施：WebRTC DataChannel 建连、P2P/TURN 通路验证 | **已完成** |
| Phase 2 | 通信切换：RPC 消息迁移到 DataChannel，WS 兜底 | **已完成** |
| Phase 3 | 文件传输：临时 DataChannel 文件传输（详见 `file-management.md`） | 待实施 |
| Phase 4 | TURN over TLS on 443 + 连接质量监控（详见 [`turn-over-tls.md`](turn-over-tls.md)） | 待实施 |

### Phase 4 概要

**TURN over TLS on 443**：将 TURN 流量通过 TLS 包裹在 443 端口传输，使其与 HTTPS 流量无法区分，穿透绝大多数限制性网络。采用双公网 IP 方案（nginx 和 coturn 各绑独立 IP），避免端口冲突和 nginx stream 的复杂度。coturn 使用独立域名（避免暴露 TURN 用途的中性名称）。

ICE 框架自动按优先级尝试所有路径（P2P → TURN UDP → TURN TCP → TURNS 443），应用层无需干预。

完整方案、实施步骤、风险评估详见 [`turn-over-tls.md`](turn-over-tls.md)。

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

---

## 十五、已知问题与 TODO

### 已修复（2026-03-25）

1. **ICE restart 处理错误**：Plugin 侧对 ICE restart offer 错误地创建新 PeerConnection，导致 DTLS fingerprint 不匹配，ICE restart 必定失败并引发循环重连。修复：UI 在 ICE restart offer 中添加 `iceRestart` 标记，Plugin 识别后在现有 PC 上 renegotiate。
2. **session 清理竞态**：`closeByConnId` 中旧 PC 的 `onconnectionstatechange` 异步触发时可能误删新注册的 session。修复：关闭前 detach 事件 handler + `onconnectionstatechange` 中校验 `pc` 归属。

### 已知限制

#### 同 NAT 场景下 P2P 降级为 TURN 中继（2026-03-25 确认）

**现象**：当 UI（浏览器）和 OpenClaw（Plugin）处于同一 NAT 后方时，WebRTC 无法建立 P2P 直连，总是回退到 TURN 中继。ICE 候选对显示 `local=relay/udp, remote=relay/udp`。

**根因（多层因素叠加）**：

1. **NAT Hairpin 不支持**：双端通过公网 STUN 获取的 srflx 候选是同一个公网 IP，srflx 候选对的连通性检查需要路由器支持 NAT Hairpin（LAN→WAN→LAN 回路），许多家用和中小企业路由器不支持（如 TP-Link TL-R478G+），导致 srflx 候选对失败。
2. **Chrome mDNS 隐私策略**：桌面版 Chrome 的 host 候选使用 mDNS 混淆（如 `uuid.local`），Plugin 侧的 werift（Node.js）无法解析 `.local` 地址，导致 host 候选对无法建立。移动版 Chrome 不使用 mDNS（发送真实 LAN IP），但仍因其他因素失败。
3. **ICE peer-reflexive 机制**：标准 ICE 中，当 Chrome 向 werift 的 host 候选发送 STUN check 时，werift 应从源地址学到 Chrome 的真实 IP（prflx 候选），从而绕过 mDNS 限制。werift 已正确实现此机制（`ice.js:858-874`），在原生 Linux 环境中应能工作。

**WSL2 环境特有限制（2026-03-25 深度排查确认）**：

当 OpenClaw 运行在 WSL2（mirrored networking 模式）中时，存在额外的 UDP 入站限制：

| 协议 | LAN 设备 → WSL2 | 原因 |
|------|----------------|------|
| TCP | ✅ 通 | WSL2 mirrored 模式正确处理 TCP 入站 |
| UDP（已建立连接的返回） | ✅ 通 | NAT 状态跟踪允许返回流量（如 TURN relay） |
| UDP（新的入站） | ❌ 不通 | WSL2 mirrored 模式不转发来自 LAN 的新 UDP 入站 |

即使同时配置 Hyper-V 防火墙（`DefaultInboundAction=Allow`）和 Windows Defender 防火墙（允许入站 UDP），LAN 设备发来的新 UDP 包仍无法到达 WSL2 进程。这导致 ICE host/prflx 候选对的 STUN check 永远到达不了 werift，只有 TURN relay 可用。

**此限制不影响原生 Linux 上的 OpenClaw 部署。**

**对比验证**：

| 场景 | STUN 服务器 | 结果 | 原因 |
|------|-----------|------|------|
| 本地 dev server（coturn 在本地 Docker） | `stun:localhost:3478` | P2P（srflx/srflx） | STUN 返回本地地址，无需 hairpin |
| 公网 server + 不同 NAT | `stun:im.coclaw.net:3478` | P2P（srflx 或 host） | 正常场景，候选对可达 |
| 公网 server + 同 NAT + 原生 Linux | `stun:im.coclaw.net:3478` | P2P（prflx/host） | prflx 机制绕过 mDNS |
| 公网 server + 同 NAT + WSL2 | `stun:im.coclaw.net:3478` | **relay** | WSL2 阻止 UDP 入站 + 无 hairpin |

**影响范围**：

- 用户的 OpenClaw 通常部署在家中。回家后与 OpenClaw 同处一个 NAT，若路由器不支持 hairpin 且无 prflx 直通（如 WSL2 环境），通信被迫经由公网 TURN 中继
- 用户在外网（4G/5G、公司网络等）使用时不受影响 — 双端在不同 NAT，P2P 正常
- 在原生 Linux 上运行 OpenClaw 的用户，即使同 NAT，prflx 机制也应能实现 P2P

**潜在优化方向**（TODO）：

1. **在原生 Linux 环境验证 prflx**：在非 WSL2 的 Linux 设备上验证同 NAT 场景下 prflx 候选是否确实能让 P2P 工作
2. **mDNS 候选解析**：在 Plugin 侧集成 mDNS 解析（如 `multicast-dns` npm 包），使桌面版 Chrome 的 mDNS host 候选可被解析
3. **LAN 发现/注入机制**：检测同局域网场景，补充注入对方的 LAN IP 作为额外 ICE 候选
4. **引导用户启用路由器 NAT Hairpin**：部分路由器支持此功能但默认关闭

### TODO

1. ~~**RPC DataChannel 大消息分片**~~：✅ 已实现（§5.1.1）。两端均实现应用层分片/重组，所有 RPC 消息统一走 DataChannel，不再回退 WS。
2. ~~**大消息 WS 回退时的 `res` 双到达**~~：✅ 随 TODO-1 解决。不再有大消息 WS 回退路径，双到达问题不再存在。
3. **有序 DC 队头阻塞**：当传输大消息的分片序列（如 >1MB 的 session content）时，同一 DC 上的其他消息（如 agent 事件推送）会被阻塞在分片后面。P2P 直连影响可忽略（<100ms），TURN 中继场景下用户可感知（1-16s）。未来可为大请求/响应使用独立 DC 解决。
