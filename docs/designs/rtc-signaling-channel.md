# RTC 信令通道设计

> 创建时间：2026-03-30
> 状态：草案
> 范围：UI ↔ Server 之间的 WebRTC 信令传输通道重构
> 前置：[WebRTC P2P 数据通道设计](webrtc-p2p-channel.md)

---

## 一、背景与动机

### 现状

当前 UI 通过 per-bot WebSocket（`/api/v1/bots/stream?botId=<id>`）与 Server 通信。该 WS 通道最初设计为承载 UI ↔ Plugin 的全部业务 RPC（Server 转发），后来增加了 RTC 信令职责。经过重构（v0.10.6+），业务 RPC 已完全迁移到 WebRTC DataChannel，WS 上仅剩：

- RTC 信令（`rtc:offer`/`answer`/`ice`/`ready`/`closed`）
- 应用层心跳（`ping`/`pong`）
- 少量管理消息（`session.expired`、`bot.unbound`）

### 问题

1. **connId 与 WS 生命周期绑定**：Server 为每条 UI WS 分配 `connId`，WS 重连后 connId 改变。Plugin 侧以 connId 为 session key，connId 变化导致 ICE restart 信令无法路由到已有 PeerConnection，只能 full rebuild

2. **per-bot WS 开销不合理**：WS 现在仅承载极稀疏的信令（建连时几条消息，之后几乎无流量），但用户绑定 N 个 bot 就维持 N 条 WS，各自独立心跳和重连

3. **信令丢失无感知**：`sendRaw()` 在 WS 不可用时静默丢弃信令，消耗 ICE restart 配额但实际未发出信令

### 目标

- 将 connId 从 WS 连接生命周期中解耦，使其在 WS 重连后保持不变
- 合并为 per-tab 单一 WS 信令通道，减少连接数和复杂度
- 新增独立模块，不影响现有 `bot-ws-hub.js`（保留其业务 RPC 转发能力，以备将来重新启用）

### 业界参考

| 系统 | 信令会话标识 | 重连机制 | 信令粒度 |
|------|-------------|---------|---------|
| LiveKit | `sid`（server 分配） | URL 参数 `reconnect=1&sid=X` | per-room WS |
| Janus | `session_id`（server 分配） | `claim` 消息重新绑定会话 | 单 WS + 多 session |
| mediasoup | 应用层自定义 | 应用层自行管理映射替换 | 不限定 |

本方案最接近 Janus 的 claim 模式（单 WS + 多 session），但采用更轻量的实现——Server 不维护 connId 过期状态，依赖 UI 侧的超时机制自然发现失效。

---

## 二、整体架构

```
UI Browser                          Server                          Plugin
──────────                          ──────                          ──────

                                    rtc-signal-router.js [新增]
                                    (connId → ws 路由表，纯数据模块)
                                         ▲          ▲
                                         │          │
SignalingConn ── WS /rtc/signal ──► rtc-signal-hub.js    bot-ws-hub.js
(per-tab,            │              [新增]               (改动 ≤3 行)
 单一 WS,            │                │                       │
 多 connId)          │                │  import forwardToBot   │
                     │                └──────────────────►─────┘
                     │
WebRtcConn ──── DataChannel ──────────────────────────────► Plugin
(per-bot)       (业务 RPC，不变)
```

### 依赖关系

```
rtc-signal-router.js          ← 无依赖（纯数据模块）
    ▲               ▲
    │               │
rtc-signal-hub.js   bot-ws-hub.js
    │
    └──► bot-ws-hub.js (forwardToBot)
    └──► turn.route.js (genTurnCreds)
```

所有依赖单向，无循环。`rtc-signal-router` 是两个 hub 模块的共享关注点（connId 路由），自然独立为独立模块。

### 模块职责

| 模块 | 职责 | 变更 |
|------|------|------|
| `rtc-signal-router.js` | connId → ws 路由表的增删查操作 | **新增**（纯数据模块） |
| `rtc-signal-hub.js` | UI 侧 RTC 信令 WS 管理、消息路由、TURN 凭证注入 | **新增** |
| `bot-ws-hub.js` | Bot(Plugin) WS 管理、业务 RPC 转发、Plugin→UI 信令路由 | **最小改动**（import router 的 lookup） |
| `SignalingConnection` (UI) | 单一信令 WS 管理、connId 管理、心跳、重连、resume | **新增** |
| `BotConnection` (UI) | RPC over DataChannel、WebRtcConnection 引用 | **精简**（移除 WS 管理） |

### 不变的部分

- Plugin 侧：无任何改动。仍通过 bot-ws-hub 的 bot WS 收发信令，以 `fromConnId` 为 session key
- DataChannel 业务 RPC：不变
- bot-ws-hub 中 Bot 连接管理、业务 RPC 转发、bot.unbound 等：保留原样

---

## 三、connId 设计

### 3.1 生成与归属

| 属性 | 设计 |
|------|------|
| 生成方 | UI 侧生成（`crypto.randomUUID()`） |
| 粒度 | per (tab, bot) — 每个 tab 对每个 bot 持有独立 connId |
| 格式 | `c_<uuid>`（保持 `c_` 前缀兼容现有 Plugin） |
| 存储 | UI 内存（页面生命周期内），不持久化到 localStorage |
| 唯一性 | Server 在注册时校验 connId 是否已被其他 WS 占用，冲突则拒绝 |

### 3.2 生命周期

connId 在 tab 生命周期内保持稳定——跨 WS 重连不变，跨 full rebuild 不变。

```
[unregistered]
    │
    │  UI 发送首条 rtc:* 消息（含 connId）
    ▼
[active]  ◄─── WS 重连后 resume / 发送 rtc:* 隐式恢复
    │
    │  WS 断开
    ▼
[unroutable]  ── connId 仍存在于 UI 内存，
    │             Server 侧路由条目已移除，
    │             Plugin→UI 信令无法投递
    │
    │  WS 重连 + resume / 发送 rtc:*
    ▼
[active]
    │
    │  UI 主动释放（bot 解绑/移除、tab 关闭）
    ▼
[released] → 清理
```

**核心规则**：

- connId 仅在 UI 主动释放时才失效（bot 解绑/移除、tab 关闭导致 WS close 无后续 resume）
- WS 断开不改变 connId 的有效性，只影响路由可达性
- Full rebuild（新 PC）复用同一 connId，Plugin 侧 `__handleOffer` 已有逻辑处理同 connId 新 offer（先 `closeByConnId` 再建新 session）
- Server 不维护 connId 过期/grace 状态，connId 路由表是纯 live 映射

### 3.3 Server 侧路由表

Server 的 connId 路由表仅记录 **当前可达** 的映射：

| 事件 | 操作 |
|------|------|
| 收到含 connId 的 rtc:\* 消息 | 注册/更新 `connId → { ws, botId, userId }` |
| 收到 `signal:resume` | 批量注册所有 connId |
| WS 断开 | 移除该 WS 下所有 connId 条目 |
| 收到 `rtc:closed` | 移除该 connId 条目 |
| bot 解绑（来自 bot-ws-hub 事件） | 移除该 botId 下所有 connId 条目 |

不涉及 grace period 或定时清理。Plugin 侧的 stale session 通过 ICE failure 自然清理（PC `failed` → Plugin `onconnectionstatechange` 删除 session）。

### 3.4 Tab 关闭后的清理

用户关闭 tab → WS close → Server 移除路由条目 → Plugin 侧 PC 失去 ICE 保活 → ~30s 后 `failed` → Plugin 自动清理 session。

无需 Server 主动通知 Plugin。延迟 ~30s 的 Plugin session 残留对系统无实质影响（仅占少量内存，且每用户通常仅 1-3 个 session）。

---

## 四、协议设计

### 4.1 WS 端点

```
GET /api/v1/rtc/signal
认证：session cookie（同现有 UI WS 认证）
```

无需 URL 参数。Server 从 session 中获取 userId。

### 4.2 消息类型总览

| 消息类型 | 方向 | 用途 |
|----------|------|------|
| `signal:resume` | UI → Server | WS 重连后重新注册 connId 路由 |
| `signal:resumed` | Server → UI | 确认注册完成 |
| `rtc:offer` | UI → Server → Plugin | SDP offer |
| `rtc:answer` | Plugin → Server → UI | SDP answer |
| `rtc:ice` | 双向 | ICE Candidate 交换 |
| `rtc:ready` | UI → Server → Plugin | DataChannel 就绪通知 |
| `rtc:closed` | 双向 | 连接关闭通知 |
| `ping` / `pong` | 双向 | 应用层心跳 |

### 4.3 消息格式

**UI → Server**：

```js
// WS 重连后重新注册 connId（首条消息）
{
  type: 'signal:resume',
  connIds: {
    '<botId>': '<connId>',
    // ...可包含多个 bot
  }
}

// RTC 信令（每条携带 botId + connId）
{ type: 'rtc:offer', botId: '123', connId: 'c_xxx', payload: { sdp, iceRestart } }
{ type: 'rtc:ice',   botId: '123', connId: 'c_xxx', payload: { candidate, sdpMid, sdpMLineIndex } }
{ type: 'rtc:ready', botId: '123', connId: 'c_xxx' }
{ type: 'rtc:closed', botId: '123', connId: 'c_xxx' }

// 心跳
{ type: 'ping' }
```

**Server → UI**：

```js
// resume 确认
{ type: 'signal:resumed' }

// Plugin 回复的信令（透传，保持现有格式）
{ type: 'rtc:answer', toConnId: 'c_xxx', payload: { sdp } }
{ type: 'rtc:ice',    toConnId: 'c_xxx', payload: { candidate, sdpMid, sdpMLineIndex } }
{ type: 'rtc:closed', toConnId: 'c_xxx' }

// Bot 离线时信令转发失败通知（可选优化）
{ type: 'rtc:error', connId: 'c_xxx', code: 'BOT_OFFLINE' }

// 心跳
{ type: 'pong' }
```

**Server → Plugin**（经 bot-ws-hub 的 bot WS 转发，与现有格式完全一致）：

```js
{ type: 'rtc:offer', fromConnId: 'c_xxx', payload: { sdp }, turnCreds: { username, credential, ttl, urls } }
{ type: 'rtc:ice',   fromConnId: 'c_xxx', payload: { candidate, sdpMid, sdpMLineIndex } }
{ type: 'rtc:ready', fromConnId: 'c_xxx' }
{ type: 'rtc:closed', fromConnId: 'c_xxx' }
```

### 4.4 `signal:resume` 协议

**触发时机**：信令 WS 重连成功后，UI 发送的第一条消息。

**Server 处理**：

```
对 connIds 中的每个 { botId, connId }：
  验证 botId 归属 userId → 注册 connId → ws 路由条目
回复 { type: 'signal:resumed' }
```

**UI 处理 `signal:resumed`**：

信令通道已恢复，对每个 bot 检查 RTC 状态并触发恢复：
- RTC connected + DC ready → 无操作
- RTC disconnected → 触发 ICE restart（信令通道已恢复，可发出）
- RTC failed/closed → full rebuild（复用同一 connId）

### 4.5 首次信令与隐式注册

UI 首次对某 bot 发起 RTC 建连时，直接发送 `rtc:offer`。Server 处理：

```
收到 rtc:*（含 botId + connId）：
  if connId 未注册 → 验证 botId 归属 userId → 注册 → 处理消息
  if connId 已注册且属于当前 WS → 直接处理消息
  if connId 已被其他 WS 占用 → 拒绝
```

**隐式注册**：任何携带 connId 的 `rtc:*` 消息都会隐式注册/恢复路由条目。这意味着 WS 重连后即使不发 `signal:resume`，直接发 `rtc:offer` 也能正确工作。`signal:resume` 的价值在于**批量预注册**——确保 resume 到 rtc:offer 之间的窗口内 Plugin 回复（如 ICE candidate）能被正确投递。

### 4.6 Bot 离线时的快速通知（可选优化）

`forwardToBot` 返回 false（bot 离线）时，Server 可立即回复：

```js
{ type: 'rtc:error', connId: 'c_xxx', code: 'BOT_OFFLINE' }
```

UI 收到后可跳过 15s RTC 建连超时，立即标记该 bot 不可达。此为可选优化，不影响核心正确性。

---

## 五、Server 侧实现

### 5.1 新增 `rtc-signal-router.js`（纯数据模块）

connId 路由表是 rtc-signal-hub 和 bot-ws-hub 的**共享关注点**，独立为纯数据模块，消除模块间的双向依赖。

**数据结构**：

```js
// connId → { ws, botId, userId }（live 路由表）
const routes = new Map();

// 反向索引：WS → Set<connId>（WS 断开时快速定位需移除的 connId）
const wsToConnIds = new WeakMap();
```

**导出**：

```js
// 注册/更新路由（首次注册时验证 connId 未被其他 WS 占用）
export function register(connId, ws, botId, userId) → boolean

// 移除单个 connId 路由
export function remove(connId)

// 移除某 WS 下所有 connId 路由（WS 断开时调用）
export function removeByWs(ws)

// 移除某 botId 下所有 connId 路由（bot 解绑时调用）
export function removeByBotId(botId)

// 查找并投递 Plugin→UI 信令
export function routeToUi(connId, payload) → boolean

// 查找路由条目（用于验证 connId 归属）
export function lookup(connId) → { ws, botId, userId } | null
```

无状态逻辑、无定时器、无副作用。

### 5.2 新增 `rtc-signal-hub.js`

**职责**：管理 UI 侧信令 WS 连接，处理消息路由。

**依赖**：

```js
import { register, remove, removeByWs, lookup } from './rtc-signal-router.js';
import { forwardToBot } from './bot-ws-hub.js';
import { genTurnCreds } from './routes/turn.route.js';
```

**导出**：

```js
export function attachRtcSignalHub(httpServer, { sessionMiddleware }) → void
```

**WS 生命周期**：

```
onUpgrade(/api/v1/rtc/signal)
  → 认证（session cookie）
  → on('message') → 消息路由
  → on('close') → removeByWs(ws)
```

**消息路由**：

| UI 消息类型 | Server 动作 |
|------------|------------|
| `ping` | 回复 `pong` |
| `signal:resume` | 批量 `register` connIds（逐个验证 botId 归属）→ 回复 `signal:resumed` |
| `rtc:offer` | `register` connId → 注入 TURN 凭证（`genTurnCreds`）→ 附 `fromConnId` → `forwardToBot(botId, payload)` |
| `rtc:ice` / `rtc:ready` | `lookup` connId → 附 `fromConnId` → `forwardToBot(botId, payload)` |
| `rtc:closed` | `lookup` connId → 附 `fromConnId` → `forwardToBot` → `remove` connId |

### 5.3 bot-ws-hub.js 最小改动

**新增 import**：

```js
import { routeToUi } from './rtc-signal-router.js';
```

**修改 `onBotMessage` 中 rtc:\* 路由**（~1 行）：

```js
// 现有代码（约 309 行）
if (payload.type === 'rtc:answer' || payload.type === 'rtc:ice' || payload.type === 'rtc:closed') {
  // 新增：优先通过新信令路由表投递
  if (routeToUi(payload.toConnId, payload)) return;
  // 现有逻辑保留（fallback：旧 per-bot WS 连接）
  const target = findUiSocketByConnId(botId, payload.toConnId);
  // ...
}
```

新增导出供 rtc-signal-hub 使用：

```js
export { forwardToBot };
```

改动总量：~3 行（1 行 import + 1 行路由 + 1 行 export）。无注册机制、无回调注入。

### 5.4 启动集成

在 `server.js` 中：

```js
import { attachRtcSignalHub } from './rtc-signal-hub.js';

// 在 attachBotWsHub 之后
attachRtcSignalHub(httpServer, { sessionMiddleware });
```

WS upgrade 路由通过 pathname 区分：
- `/api/v1/bots/stream` → bot-ws-hub（现有）
- `/api/v1/rtc/signal` → rtc-signal-hub（新增）

---

## 六、UI 侧影响

### 6.1 新增 `SignalingConnection`

Per-tab 单例，管理单一信令 WS，替代原来分散在各 BotConnection 中的 WS 信令职责。

**职责**：
- 信令 WS 连接管理（connect、reconnect、heartbeat）
- connId 管理（`Map<botId, connId>`，生成、持有）
- 信令消息收发（`sendSignaling(botId, type, payload)`）
- 重连后自动 resume（发送 `signal:resume`，处理 `signal:resumed`）
- 前台恢复（visibilitychange/app:foreground/network:online → WS probe + 通知 RTC 检查）

**对外接口**：

```js
// WebRtcConnection 发送信令（返回 false 表示 WS 不可用，信令未发出）
signalingConn.sendSignaling(botId, type, payload) → boolean

// 获取/创建某 bot 的 connId
signalingConn.getOrCreateConnId(botId) → string

// 释放某 bot 的 connId（bot 解绑/移除时）
signalingConn.releaseConnId(botId)

// 信令消息监听（WebRtcConnection 监听入站信令）
signalingConn.on('rtc', callback(botId, msg))

// WS 状态
signalingConn.state → 'disconnected' | 'connecting' | 'connected'

// 事件
signalingConn.on('state', callback(state))
signalingConn.on('resumed', callback())         // WS 重连 + resume 完成
signalingConn.on('foreground-resume', callback()) // 前台恢复，需检查 RTC
```

**心跳**：单套，沿用现有 BotConnection 的心跳策略（25s ping、45s timeout、2 次 miss 关闭）。

**重连**：沿用现有策略（指数退避 1s→30s，±30% jitter，前台恢复即时重连）。

### 6.2 BotConnection 精简

移除 WS 相关逻辑后，BotConnection 保留：
- WebRtcConnection 引用（`setRtc` / `clearRtc`）
- RPC over DataChannel（`request()` 方法不变）
- DataChannel 消息处理（`__onRtcMessage`）
- pending 请求管理（`__pending` Map）

不再包含：WS 创建/重连/心跳/probe、`sendRaw()`、`__onMessage`、`connect()`/`disconnect()` 中的 WS 部分。

`disconnect()` 语义调整为：关闭 RTC + reject pending + 通知 SignalingConnection 释放 connId。

### 6.3 WebRtcConnection 适配

信令发送从 `this.__botConn.sendRaw(payload)` 改为通过 SignalingConnection：

```js
// 之前
this.__botConn.sendRaw({ type: 'rtc:offer', payload: { sdp } });

// 之后（sendSignaling 内部附加 botId + connId）
signalingConn.sendSignaling(this.botId, 'rtc:offer', { sdp });
```

信令接收从监听 `botConn.on('rtc', ...)` 改为监听 `signalingConn.on('rtc', ...)`（按 botId 过滤）。

**sendSignaling 返回值处理**：调用方应检查返回值。返回 false 时**不消耗 ICE restart / rebuild 配额**。

### 6.4 bots store 适配

**connState 语义调整**：

对用户而言，真正关心的状态是 `dcReady`（能否发消息）。原 `connState`（per-bot WS 状态）退化为信令通道的全局状态，不再直接驱动 per-bot 的 UI 呈现。

**`waitForConnected` 及消息重试逻辑**需同步适配：从监听 `connState` 改为监听 `dcReady`。涉及文件：`src/utils/wait-connected.js`、`src/stores/chat.store.js`。

**WS 重连后 RTC 状态检查**：

监听 `signalingConn.on('resumed', ...)` 事件，对每个有 connId 的 bot 检查 RTC 状态：
- RTC connected + DC ready → 无操作
- RTC disconnected → 触发 ICE restart
- RTC failed/closed → full rebuild（复用同一 connId）

**前台恢复**：

监听 `signalingConn.on('foreground-resume', ...)` 事件，对每个 bot 的 RTC 进行存活检查（调用 `tryIceRestart()`）。与 SignalingConnection 自身的 WS probe **并行执行**，不串行依赖。

---

## 七、连接恢复策略更新

原策略（`webrtc-p2p-channel.md` §8）以 per-bot WS 为前提。更新后：

> **注**：本节替代 `webrtc-p2p-channel.md` §8.4-8.6 中与信令通道相关的描述。

### 7.1 信令 WS 断开恢复

```
信令 WS 断开
  → SignalingConnection 自动重连（指数退避）
  → 重连成功 → 发送 signal:resume（批量注册所有 connId）
  → 收到 signal:resumed
  → 对每个 bot 按 RTC 状态触发恢复
```

### 7.2 RTC 恢复（依赖信令通道）

| 场景 | 信令 WS 状态 | 处理 |
|------|-------------|------|
| RTC disconnected | WS connected | 等待 ICE 自动恢复（10s 超时） |
| RTC failed, ICE restart | WS connected | 发送 ICE restart offer（connId 不变） |
| RTC failed, ICE restart | WS disconnected | **等待 WS 恢复**，resumed 后触发 ICE restart |
| ICE restart 耗尽 | WS connected | full rebuild（**复用 connId**，新 PC） |
| full rebuild 耗尽 | — | 标记 failed，等下次 WS 重连重试 |

### 7.3 sendSignaling 返回值处理

```js
sendSignaling(botId, type, payload) → boolean
```

调用方（WebRtcConnection）应检查返回值：
- `true`：信令已提交到 WS 发送缓冲区
- `false`：WS 不可用，信令未发出。**不消耗 ICE restart / rebuild 配额**，等待 WS 恢复后重试

### 7.4 恢复策略汇总

| # | 场景 | 处理 |
|---|------|------|
| 1 | RTC disconnected | 等待 ICE 自动恢复（10s） |
| 2 | RTC failed，WS 在线 | ICE restart（connId 不变，最多 5 次） |
| 3 | RTC failed，WS 离线 | 等 WS 恢复 + resumed 后再 ICE restart |
| 4 | ICE restart 耗尽 | full rebuild（复用 connId，新 PC，最多 3 次） |
| 5 | full rebuild 耗尽 | reject 挂起请求（`RTC_LOST`），等下次 WS 重连 |
| 6 | 信令 WS 断开 | 自动重连 + resume |
| 7 | 信令 WS 恢复 | resumed → 按 RTC 状态决定 ICE restart / rebuild / 无操作 |
| 8 | WS 断开但 RTC 仍 connected | RTC 不动，业务 RPC 通过 DC 继续工作 |
| 9 | bot 解绑 | 释放 connId + 关闭 RTC |

---

## 八、边界情况

| 场景 | 处理 |
|------|------|
| WS 断开期间 Plugin 发来 `rtc:answer` | `routeRtcToUi` 找不到 connId 路由条目（已在 WS 断开时移除）→ 投递失败，丢弃。UI 重连后 resumed 触发 RTC 恢复 |
| WS 重连后 resume 之前 Plugin 发来信令 | connId 路由尚未注册 → 投递失败。resume 到达后注册完成。窗口极短（ms 级） |
| 多 tab 同 bot | 各 tab 有独立 connId，互不冲突。Server 按 connId 精确投递 |
| 单 tab 刷新 | 旧 WS close → 路由条目移除 → Plugin PC 最终 ICE failed 自清理。新页面生成新 connId，full rebuild |
| bot 在 WS 断开期间解绑 | SSE 推送 bot.unbound → UI 清理。Server 移除该 bot 相关 connId 路由。WS 重连时 resume 中该 bot 的 connId 被忽略（botId 校验失败） |
| Server 重启 | 所有 connId 路由丢失。UI resume 重新注册，无需区分"恢复"和"首次注册"。Plugin 侧旧 session 通过 ICE failure 自清理 |
| connId 冲突 | Server 注册时检查 connId 是否已被其他 WS 占用，冲突则拒绝 |
| ICE restart 时 sendSignaling 返回 false | 不消耗 restart 配额，不升级到 full rebuild，等 WS 恢复 |
| Full rebuild 复用 connId | Plugin 收到同 connId 新 offer → `closeByConnId` 清理旧 session → 创建新 session。已有逻辑支持 |
| ICE restart 时 Plugin 已无 session（极端：WS+RTC 同时断开 >30s） | Plugin 对未知 connId 的 ICE restart offer 会 fall through 创建新 PC → DTLS 不匹配 → ICE failed → UI 恢复级联 → full rebuild。多耗 ~2-5s，可接受 |
| WS 重连后直接发 rtc:offer（跳过 resume） | 隐式注册 connId，正常工作。resume 的价值是批量预注册，避免此窗口内 Plugin 回复丢失 |
| Bot 离线时发送 rtc:offer | `forwardToBot` 返回 false。可选回复 `rtc:error`（`BOT_OFFLINE`）让 UI 快速感知，否则等 15s 超时 |
| 用户 session 过期 / logout | SignalingConnection 断开信令 WS 并停止重连；所有 connId 释放；Server 侧路由条目随 WS 关闭自动清理 |

---

## 九、TODO（待后续讨论确认）

### 初始化触发链路重建

当前 `__onBotConnected` 的触发依赖 per-bot WS 的 `state` 事件。迁移到单一信令 WS 后，此链路断裂。需要设计新的触发机制，确保以下场景正确工作：

- **首次初始化**：信令 WS 首次 connected + bot online（SSE）→ 触发 `__fullInit`
- **重连恢复**：信令 WS resumed → 对每个 online bot 检查 RTC 状态 → 触发恢复
- **bot 上线**：SSE 报告 bot online + 信令 WS 已 connected → 触发初始化/恢复

涉及 `bots.store.__onBotConnected`、`__fullInit`、`__ensureRtc`、`__bridgeConn` 等逻辑的重构。

### 用户 session 过期的处理

信令 WS 基于 session cookie 认证。用户 session 过期后：

- 信令 WS 重连时 server 返回 401 → SignalingConnection 需识别 auth 失败并停止重连
- 应触发 `auth:session-expired` 事件通知上层（等同于当前 per-bot WS 上的 `session.expired` 消息）
- 需区分 auth 失败（停止重连）与网络错误（继续重连）

---

## 十、实施范围

### Server 侧

| 文件 | 变更类型 | 内容 |
|------|---------|------|
| `src/rtc-signal-router.js` | 新增 | connId → ws 路由表（纯数据模块，增删查） |
| `src/rtc-signal-hub.js` | 新增 | 信令 WS 管理、消息路由、TURN 凭证注入 |
| `src/bot-ws-hub.js` | 最小改动 | import `routeToUi` + 导出 `forwardToBot`（≤3 行） |
| `src/server.js` | 小改动 | 引入并启动 `attachRtcSignalHub` |

### UI 侧

| 文件 | 变更类型 | 内容 |
|------|---------|------|
| `src/services/signaling-connection.js` | 新增 | SignalingConnection 类 |
| `src/services/bot-connection.js` | 重构 | 移除 WS 管理，保留 DC RPC |
| `src/services/bot-connection-manager.js` | 重构 | 简化（不再管理 WS 连接） |
| `src/services/webrtc-connection.js` | 适配 | 信令收发改用 SignalingConnection |
| `src/stores/bots.store.js` | 适配 | connState 语义、resumed 事件处理、前台恢复 |
| `src/utils/wait-connected.js` | 适配 | 从监听 connState 改为监听 dcReady |
| `src/stores/chat.store.js` | 适配 | 消息重试逻辑适配新的连接状态 |

### Plugin 侧

无改动。

---

## 十、风险与约束

| 风险 | 缓解 |
|------|------|
| Server 重启丢失所有 connId 路由 | UI resume 重新注册即可。Plugin 侧旧 session 通过 ICE failure 自清理（~30s），UI 的 RTC 恢复级联正常触发 full rebuild |
| 单一 WS 成为单点 | 与原来 per-bot WS 相比，单一 WS 断开影响所有 bot 的信令。但 RTC DataChannel 独立于 WS，业务 RPC 不受影响 |
| WS 断开期间信令丢失 | 不可避免，但 RTC 通常仍存活（ICE 层保活），WS 恢复后 ICE restart 可恢复 |
| connId client 生成的唯一性 | UUID v4 碰撞概率可忽略；Server 注册时做冲突检查兜底 |
| Plugin session 延迟清理（tab 关闭后 ~30s） | 资源占用极小（per-session 仅一个 PC 对象），每用户通常 1-3 个 session |
| ICE restart 在 Plugin session 已清理时浪费 ~2-5s | 仅在 WS+RTC 同时断开 >30s 的罕见场景发生。恢复级联自动 fall through 到 full rebuild |
