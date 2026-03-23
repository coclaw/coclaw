# WebRTC P2P 数据通道设计

> 创建时间：2026-03-23
> 状态：草案
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
- **分阶段实施**：Phase 1 只建连不承载业务；Phase 2 将 RPC 切换到 DataChannel（详见 `webrtc-p2p-channel-phase2.md`）

### 术语

| 术语 | 含义 |
|------|------|
| Signaling | WebRTC 建连前交换 SDP 和 ICE Candidate 的过程，复用现有 WS 通道 |
| STUN | 帮助端点发现自身公网地址的协议服务 |
| TURN | P2P 不可达时的数据中继服务 |
| ICE | 自动选择最优连接路径的框架（host → srflx → relay） |
| DataChannel | WebRTC 中用于传输任意数据的通道，基于 SCTP |
| connId | Server 为每个 WS 连接分配的唯一标识，用于信令精确路由 |

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
| 用途 | JSON-RPC 消息、文件操作控制消息 |

> Phase 1：创建但不承载业务。Phase 2 启用 RPC 通信。

### 5.2 临时通道：文件传输（Phase 3）

每次文件传输创建一条独立的临时 DataChannel（`file:<transferId>`），传输完成后关闭。

- **谁发数据谁创建**（下载时 Plugin 创建，上传时 UI 创建）
- `ordered: true`，应用层分片（16-64KB）
- 监听 `bufferedamountlow` 事件流控
- DataChannel 创建极其廉价（仅新建 SCTP stream，无需重新 DTLS 握手），天然隔离多文件并发

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

## 七、连接生命周期与恢复

### 7.1 ICE 层保活

WebRTC ICE 层自动发送 STUN Binding Indication（约 15-30s 间隔），**应用层不需要 ping/pong 心跳**。

### 7.2 连接恢复策略

| 连接状态 | 处理方式 |
|----------|---------|
| `disconnected` | 等待 ICE 层自动恢复（短暂网络抖动通常自愈） |
| `failed` | 发起 ICE restart（`iceRestart: true`），保留 DataChannel 仅重新协商路径 |
| ICE restart 失败 | 关闭 PeerConnection，全新建连 |

### 7.3 TURN 凭证刷新

TURN 凭证有 TTL（默认 24h）。UI 在凭证剩余有效期不足 1h 时请求新凭证，下一次 ICE restart 时使用。已建立的 TURN allocation 不受凭证过期影响。

### 7.4 WebSocket 通道保留

WS 始终保持，职责：信令通道、业务交互（认证等）、Plugin-Server 连接。

### 7.5 连接路径日志

建连成功后记录 ICE candidate 类型（`host`=局域网直连、`srflx`=NAT 穿透 P2P、`relay`=TURN 中继），帮助排查连接路径。

---

## 八、各端实现架构

### 8.1 Server 侧

**TURN 凭证 API**：`GET /api/v1/turn/creds`，基于 `TURN_SECRET` 通过 HMAC-SHA1 生成临时凭证。Plugin 侧凭证由 Server 在转发 `rtc:offer` 时注入消息中。

**信令转发**：在 `bot-ws-hub.js` 中增加 `rtc:*` 类型路由。UI 来源按 `botId` 转发到 bot socket 并附上 `fromConnId`；Plugin 来源按 `toConnId` 定向投递到匹配的 UI socket。

### 8.2 Plugin 侧：WebRtcPeer 类

`plugins/openclaw/src/webrtc-peer.js`，由 `RealtimeBridge` 持有。

```
RealtimeBridge
├── serverWs       — CoClaw Server WS 连接（信令 + 业务消息）
├── gatewayWs      — OpenClaw Gateway WS 连接（本地，不变）
└── webrtcPeer     — WebRTC PeerConnection 管理（新增）
```

- 以 `connId` 为粒度管理多条 PeerConnection（`__sessions: Map<connId, { pc, rpcChannel }>`）
- 通过 `handleSignaling(msg)` 处理来自 Server 转发的信令
- WebRtcPeer 延迟创建（收到第一个 rtc: 消息时），通过构造函数 `PeerConnection` 参数支持依赖注入（测试用）

### 8.3 UI 侧：WebRtcConnection 类

`ui/src/services/webrtc-connection.js`，与 `BotConnection` 平级。

- `BotConnection` 新增 `sendRaw(payload)` 方法用于发送非 RPC 原始消息
- `BotConnection.__onMessage` 增加 `rtc:` 类型分发（emit `'rtc'` 事件）
- WebRTC 连接实例通过模块级 `rtcInstances` Map 管理（不放入 store）
- `botsStore` 新增 `rtcStates` / `rtcCandidateTypes` 用于 UI 展示
- 触发时机：`botsStore.__listenForReady()` 中 Plugin 在线后非阻塞发起

---

## 九、部署方案

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

## 十、分阶段实施计划

### Phase 1：基础设施（建连但不使用）

WebRTC DataChannel 成功建立并保持连接，验证 P2P/TURN 通路可用。DataChannel 不承载业务数据。

涉及模块：Server（TURN 凭证 API + 信令转发）→ Plugin（WebRtcPeer）/ UI（WebRtcConnection）→ 端到端验证。Step 4（Plugin）和 Step 5（UI）可并行。

### Phase 2：RPC 通道启用

详见 `webrtc-p2p-channel-phase2.md`。将 JSON-RPC 消息迁移到 DataChannel，WS 作为兜底。

### Phase 3：文件传输

临时 DataChannel 文件传输（`file:<id>`），含应用层分片/重组/流控。

### Phase 4：稳定性与优化

连接质量监控、TURN over TLS（按需启用）。

---

## 十一、风险与约束

| 风险 | 缓解措施 |
|------|---------|
| werift 性能不足 | 个人场景可接受；极端情况可切换到 node-datachannel |
| coturn 崩溃 | compose 自动重启 + 健康检查；P2P 直连不受影响 |
| 对称 NAT | TURN 自动兜底，对应用层透明 |
| 浏览器兼容性 | 现有 WS 通道保留，业务不受影响 |
| TURN 凭证过期 | UI 在过期前主动刷新 |
| werift 作为首个 runtime 依赖 | 纯 JS 实现，无原生编译开销，影响可控 |
