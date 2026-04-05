# CoClaw 架构总览

> 最后更新：2026-04-05

---

## 一、系统定位

CoClaw 让用户即使与 OpenClaw 处于网络隔离状态，也能通过 CoClaw 平台与其 OpenClaw 实例交互。产品形态类似 OpenClaw WebChat，但在平台能力（多设备、多 Agent、文件管理等）上做更深入扩展。

**核心术语**

| CoClaw 术语 | OpenClaw 对应 | 含义 |
|-------------|--------------|------|
| Claw | OpenClaw 实例 | 一个绑定到 CoClaw 的 OpenClaw 实例 |
| Agent | 顶层 Agent | 一个 Claw 下可有多个 Agent，各自独立 workspace 和 session |
| Chat | sessionKey | 持续对话流（`agent:<agentId>:main`） |
| Session | sessionId | Chat 中的一个片段，reset 产生新 session |
| Topic | 无对应 | 用户主动发起的独立对话，CoClaw 自管理 |

---

## 二、组件视图

```
┌──────────────────┐                           ┌──────────────────┐
│    CoClaw UI     │                           │  CoClaw Server   │
│    (Vue 3)       │──── HTTPS (REST) ────────▶│  (Express)       │
│                  │◀─── SSE /claws/status-stream│                 │
│                  │                           │                  │
│  SignalingConn ──│── WS /rtc/signal ────────▶│  rtc-signal-hub  │
│  (per-tab)       │                           │                  │
│                  │── WS /claws/stream?role=ui▶│  claw-ws-hub ◄──│── WS /claws/stream ── Plugin
│                  │   (ticket 认证, RPC 中继)   │  (双角色)        │   (token 认证)
│                  │                           │                  │
│  BotConnection ══│══ WebRTC DataChannel ═════│══════════════════════════════════════ Plugin
│  (per-bot)       │   (P2P 或 TURN 中继)       │                  │
└──────────────────┘                           └────────┬─────────┘
                                                        │
                                               MySQL (Prisma)
                                                        │
┌───────────────────────────────────────────────────────────────────┐
│  OpenClaw + @coclaw/openclaw-coclaw 插件                           │
│  - 绑定/解绑/认领 CLI                                              │
│  - Realtime bridge（WS → Server + Gateway，WebRTC → UI）          │
│  - Gateway RPC 透传（agent/session/file 等）                       │
└───────────────────────────────────────────────────────────────────┘
```

### 通信通道一览

| 通道 | 形态 | 职责 |
|------|------|------|
| REST | HTTPS | 认证、Claw 管理、绑定/认领 |
| SSE | `GET /claws/status-stream`，per-user | Claw 状态推送（上下线、绑定/解绑、名称更新） |
| Signaling WS | `WS /rtc/signal`，per-tab 单一 WS | SDP/ICE 信令交换、connId 管理、应用层心跳 |
| Claw WS（Plugin 侧） | `WS /claws/stream`，per-claw（Plugin ↔ Server） | Plugin 上行链路、控制消息、RTC 信令转发 |
| Claw WS（UI 侧） | `WS /claws/stream?role=ui`，per-tab（UI ↔ Server） | Server 中继 RPC（WebRTC 不可用时的备选路径）、RTC 信令转发。**当前 UI 未使用，作为保留能力存在** |
| RPC DataChannel | per-claw 持久 DC `"rpc"` | 所有业务 JSON-RPC（agent 交互、session 管理、文件元操作） |
| File DataChannel | per-transfer 临时 DC `"file:<id>"` | 二进制文件传输（独立于 RPC，互不阻塞） |

> 注：Server 同时接受 `/api/v1/bots/*` 和 `/api/v1/claws/*` 路径（路由别名），旧版客户端兼容。

详细通信模型见 [communication-model.md](communication-model.md)。

---

## 三、应用分层

```
Vue 组件层 ── 渲染 + 用户交互
     ↕ reactive (Pinia)
Pinia Store 层 ── 状态管理、RTC 生命周期编排、业务逻辑
     ↕ request() / on() / off()
Service 层（纯 JS）── BotConnection / SignalingConnection / WebRtcConnection / file-transfer
     ↕ WebSocket / WebRTC
CoClaw Server ── 信令路由、REST API、Claw WS hub
```

Service 层无 Vue 依赖，可独立测试。Store 层通过回调注入与 Service 层协作（如 `__onTriggerReconnect`），避免反向依赖。

---

## 四、绑定与认证

系统支持两种对称的绑定流程。

### 流程 A：用户主导（Binding）

用户在 UI 生成绑定码 → 在 OpenClaw CLI 执行 `openclaw coclaw bind <code>` → Plugin 提交绑定码到 Server → Server 签发 clawId + token。

### 流程 B：Plugin 主导（Claim / Enroll）

Plugin 在 OpenClaw CLI 执行 `openclaw coclaw enroll` → 生成认领码并显示 → 用户在 App 输入认领码 → Server 签发 clawId + token 返回给 Plugin。

### 认证模型

- **Server 不存明文 token**：仅存 SHA-256 hash（`BINARY(32)`）
- **无 token 不连接**：Plugin 本地无 token 时不主动建立任何连接

### 解绑自动收敛

1. Server **直接删除 Claw 记录**（tokenHash 随之消失）
2. 向在线 Plugin 发送 `claw.unbound` 控制消息 + close WS（4001）
3. Plugin 收到后自动清理本地 token
4. Plugin 离线时：下次重连认证失败 → 自动清理

---

## 五、核心不变式

1. **Multi-claw per user**：同一用户可绑定多个 Claw，每个 Claw 可有多个 Agent
2. **Token 安全**：Server 端只存 hash，传输全程 TLS
3. **解绑即删除**：Claw 记录直接删除，tokenHash 随之消失，旧凭证不可复用
4. **通信层透明**：P2P / TURN 中继对业务层完全透明
5. **连接自恢复**：断连后自动重建，业务层 `request()` 通过 `waitReady()` 等待连接就绪后发送

---

## 六、相关文档

| 文档 | 说明 |
|------|------|
| [communication-model.md](communication-model.md) | 通信模型详解：三层通道、两层超时、连接生命周期 |
| [gateway-agent-rpc-protocol.md](gateway-agent-rpc-protocol.md) | Agent 两阶段 RPC 协议规范 |
| [multi-agent-support.md](multi-agent-support.md) | 多 Agent 架构设计 |
