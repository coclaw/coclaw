# WebRTC P2P 数据通道设计 — Phase 2：通信切换

> 创建时间：2026-03-23
> 状态：草案
> 前置文档：`webrtc-p2p-channel.md`（整体架构与 Phase 1）
> 范围：将 UI ↔ Plugin 的业务通信从 WS 中转切换为 RTC DataChannel 直连，WS 作为兜底

---

## 一、概述

### 目标

Phase 1 已建立 WebRTC DataChannel 基础设施。Phase 2 的核心任务是**将业务 RPC 通信切换到 DataChannel**：

1. UI 优先通过 RTC DataChannel 与 Plugin 通信
2. RTC 不可用时自动降级到 WS 中转
3. Plugin 同时接受 RTC 和 WS 来源的请求

### 不在范围内

- 文件传输（Phase 3）
- APK 前后台切换导致的 JS 暂停 / WebRTC 断开（后续独立课题）
- 停止 Plugin 向 Server WS 的业务广播（Phase 2 完成后单独处理）
- SSE 通道调整

---

## 二、消息流变更

### Phase 1（现状）

```
UI  ──req──> WS ──> Server ──> WS ──> Plugin ──> Gateway
UI  <──res── WS <── Server <── WS <── Plugin <── Gateway
UI  <─event─ WS <── Server <── WS <── Plugin <── Gateway
```

### Phase 2（RTC 模式）

```
UI  ──req──> DataChannel("rpc") ──────────────> Plugin ──> Gateway
UI  <──res── DataChannel("rpc") <────────────── Plugin <── Gateway
UI  <─event─ DataChannel("rpc") <────────────── Plugin <── Gateway

Plugin 同时将 res/event 广播给 Server WS（向后兼容，暂时保留），
Server 继续广播给 UI WS，但 UI 在 RTC 模式下忽略这些 WS 业务消息。
```

### Phase 2（WS 降级模式）

与 Phase 1 完全一致，RTC 不参与业务通信。

---

## 三、传输模式选择

### 核心原则

**传输模式一旦选定就固定**，不在两个通道之间动态切换。唯一例外是 RTC 不可恢复时的降级（属于"放弃旧通道并切换"）。

### 选择流程

**首次连接**：

```
WS 首次连通
  → transportMode = null（连接中，不允许业务请求）
  → 异步发起 RTC 建连（initRtcAndSelectTransport）
  → 启动超时计时器（15 秒）

情况 A：RTC DataChannel open 在计时器内触发
  → transportMode = 'rtc'

情况 B：计时器到期，RTC 未就绪
  → transportMode = 'ws'
  → 关闭/放弃 RTC 尝试
```

**WS 重连**（与首次不同）：

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

### 用户状态呈现

| transportMode | 用户看到 | 说明 |
|---|---|---|
| `null` | 连接中... | WS 已通，正在尝试 RTC |
| `'rtc'` | 已连接 | 可选：小图标标记 P2P / Relay |
| `'ws'` | 已连接 | 可选：小图标标记"中继模式" |
| RTC 恢复中 | 重连中... | ICE restart / rebuild 进行中 |

---

## 四、RTC 中途失败的降级处理

### 处理

```
RTC 不可恢复
  → transportMode = 'ws'
  → reject 所有 viaRtc 的挂起请求（error code: RTC_LOST）
  → 后续请求自动走 WS
  → 用户可能需要重发消息
```

**不尝试续接正在进行的操作**，处理方式与 WS 断线重连一致。

### Fallback 触发条件

| 触发 | 条件 |
|---|---|
| RTC 建连超时 | 15 秒内 DataChannel 未就绪 |
| RTC 不可恢复 | ICE restart（2次）+ full rebuild（3次）全部耗尽 |

| **不**触发 | 条件 |
|---|---|
| RTC `disconnected` | ICE 层自动恢复中 |
| 单次 RTC `failed` | ICE restart 未耗尽 |
| WS 断开重连 | RTC 可能仍健康 |

---

## 五、RTC 连接生命周期

### 与 WS 解耦

Phase 2 中 **RTC 独立管理**，WS 断开重连不影响健康的 RTC 连接。

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

### connId 跨 WS 重连

WS 重连后 Server 分配新 `connId`，Plugin 侧 `WebRtcPeer.__sessions` 以旧 `connId` 为 key。

处理方案：
- RTC 仍 `connected`：无需信令，无问题
- RTC 已 `failed`：直接 full rebuild（新 PC、新 offer、新 connId），不尝试 ICE restart
- **ICE restart 仅在同一 WS 连接内使用**（connId 不变时）

### WS 重连后重新触发传输选择

Phase 1 的 WS `'state'` 监听器是一次性的。Phase 2 需要**持久**的 WS 状态监听器，每次 WS `connected` 时调用 `initRtcAndSelectTransport`。该函数已有防重入守卫（RTC 健康时跳过），重复调用安全。

### 恢复策略汇总

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
| 9 | 业务请求时 transportMode 为 null | reject，UI 层提示"连接中" |

---

## 六、DataChannel 消息格式

复用现有 WS RPC 协议格式，无需定义新协议：

```javascript
// 请求（UI → Plugin）
{ type: "req", id: "ui-1711234567-1", method: "agent", params: { ... } }

// 响应（Plugin → UI）
{ type: "res", id: "ui-1711234567-1", ok: true, payload: { ... } }

// 事件（Plugin → UI）
{ type: "event", event: "agent", payload: { ... } }
```

---

## 七、各端变更概要

### 7.1 UI 侧

#### BotConnection

- 新增 `__transportMode`（`'rtc'` | `'ws'` | `null`）和 `__rtc`（WebRtcConnection 引用）
- `setTransportMode(mode)`：RTC → WS 降级时 reject 所有 `viaRtc` 挂起请求（code: `RTC_LOST`）
- `request()` 按 transportMode 分支发送：`'rtc'` 走 DataChannel、`'ws'` 走 WS、`null` reject
- `__onMessage()`：RTC 模式下忽略 WS 业务消息（`res`/`event`），系统消息（`pong`、`rtc:*`、`session.expired`、`bot.unbound`）始终处理
- 新增 `__onRtcMessage(payload)`：处理 DataChannel 收到的 `res`/`event`，复用 `__handleRpcResponse`
- WS close 时：RTC 模式下仅 reject `viaRtc === false` 的请求，保留 RTC 请求；`__cleanup()` 中的 `__rejectAllPending` 不需要此判断（完整拆除场景）

> **关键设计点**：`transportMode === 'ws'` 时消息收发路径与 Phase 1 完全一致，WS fallback 不是"新功能"而是"不启用新功能"。

#### WebRtcConnection

- 新增 `send(payload)` 和 `get isReady()`
- 新增 `onReady` 回调（在 `dc.onopen` 时触发，通知外部 DataChannel 可用）
- `dc.onmessage` 改为回调 `BotConnection.__onRtcMessage`

#### 传输选择编排（initRtcAndSelectTransport）

封装在 `webrtc-connection.js` 模块级函数，取代原 `initRtcForBot`。核心逻辑：防重入守卫 → 15 秒超时定时器 → `rtc.onReady` 时设 `'rtc'` → 超时/失败时设 `'ws'` → `rtc.onStateChange` 中 `failed` 时降级。

#### bots.store

持久监听 WS 状态（替换一次性监听）：首次 `connected` 执行完整初始化（loadAgents 等），后续 `connected` 仅重新触发传输选择。`removeBotById()` 需清理 `initializedBots`。

### 7.2 Plugin 侧

#### WebRtcPeer

- 构造函数新增 `onRequest` 回调：`(payload, connId) => void`
- 新增 `broadcast(payload)`：向所有已打开的 rpcChannel 广播
- `dc.onmessage`：解析 JSON，`type === 'req'` 时调用 `onRequest`

#### RealtimeBridge

- 创建 WebRtcPeer 时传入 `onRequest`，复用现有 `__handleGatewayRequestFromServer` 处理
- gateway 响应/事件转发处追加 `webrtcPeer.broadcast(payload)`
- `__handleGatewayRequestFromServer` 中合成的错误响应（`GATEWAY_OFFLINE` / `GATEWAY_SEND_FAILED`）也需 broadcast

> **注意**：不能统一替换 `__forwardToServer` 为 forward+broadcast helper，因为 `__forwardToServer` 也用于 RTC 信令消息回传，信令不应广播到 DataChannel。**仅在 gateway 业务响应/事件和合成错误响应处追加 broadcast。**

### 7.3 Server 侧

**无变更。**

---

## 八、边界情况

| 场景 | 处理 |
|------|------|
| RTC 未就绪时用户发消息 | reject（code: `NOT_CONNECTED`），UI 提示"连接中" |
| RTC 中途断开（可恢复） | 挂起请求保持等待；ICE restart / rebuild 触发 |
| RTC 中途断开（不可恢复） | 降级到 WS；reject 所有 `viaRtc` 请求（code: `RTC_LOST`） |
| WS 断开但 RTC 健康 | 业务正常走 RTC；WS pending 清理时跳过 `viaRtc` 请求 |
| 多 tab 同时连接 | 各 tab 独立 DataChannel，Plugin broadcast 全部发送 |
| Plugin 重启 | 所有 RTC 断开，UI 走恢复流程 |
| Plugin 内部 RPC 响应 | ID 前缀为 `coclaw-gw-*` / `coclaw-agent-*`，被内部消费后 return，不广播 |
| Plugin 合成的错误响应 | 同时发给 Server WS 和 RTC broadcast |
| 两阶段 `agent` 请求中 RTC 断开 | pending reject → chat.store 捕获错误 → 清理 event listener → 用户重发 |

---

## 九、变更影响汇总

| 模块 | 变更量 | 说明 |
|---|---|---|
| `ui/services/bot-connection.js` | 中等 | transportMode + request 分支 + RTC 消息处理 + WS 消息过滤 |
| `ui/services/webrtc-connection.js` | 低 | send/isReady/onReady + dc.onmessage 回调 |
| `ui/stores/bots.store.js` | 低-中 | 持久 WS 监听器 + 传输选择编排 |
| `plugins/openclaw/src/webrtc-peer.js` | 低 | onRequest + broadcast + dc.onmessage 解析 |
| `plugins/openclaw/src/realtime-bridge.js` | 低 | onRequest 接入 + broadcast 调用 |
| `server/` | 零 | 无变更 |

### 实施顺序

1. **Plugin 侧**（独立，无 UI 依赖）：WebRtcPeer → RealtimeBridge → 测试
2. **UI 侧**（依赖 Plugin 完成）：BotConnection → WebRtcConnection → bots.store → 测试
3. **端到端验证**
