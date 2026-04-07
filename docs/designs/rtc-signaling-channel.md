# RTC 信令通道设计

> 创建时间：2026-03-30
> 状态：Server 侧 + UI 侧均已实施
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

1. **connId 与 WS 生命周期绑定**：Server 为每条 UI WS 分配 `connId`，WS 重连后 connId 改变。Plugin 侧以 connId 为 session key，connId 变化时只能 full rebuild

2. **per-bot WS 开销不合理**：WS 现在仅承载极稀疏的信令（建连时几条消息，之后几乎无流量），但用户绑定 N 个 bot 就维持 N 条 WS，各自独立心跳和重连

3. **信令丢失无感知**：`sendRaw()` 在 WS 不可用时静默丢弃信令，且无法通知上层

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
| `rtc:offer` | UI → Server → Plugin | SDP offer |
| `rtc:answer` | Plugin → Server → UI | SDP answer |
| `rtc:ice` | 双向 | ICE Candidate 交换 |
| `rtc:ready` | UI → Server → Plugin | DataChannel 就绪通知 |
| `rtc:closed` | 双向 | 连接关闭通知 |
| `ping` / `pong` | 双向 | 应用层心跳 |

### 4.3 消息格式

**UI → Server**：

```js
// RTC 信令（每条携带 botId + connId，隐式注册路由）
{ type: 'rtc:offer', botId: '123', connId: 'c_xxx', payload: { sdp } }
{ type: 'rtc:ice',   botId: '123', connId: 'c_xxx', payload: { candidate, sdpMid, sdpMLineIndex } }
{ type: 'rtc:ready', botId: '123', connId: 'c_xxx' }
{ type: 'rtc:closed', botId: '123', connId: 'c_xxx' }

// 心跳
{ type: 'ping' }
```

**Server → UI**：

```js
// Plugin 回复的信令（透传）
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

### 4.4 connId 路由注册（隐式注册）

~~原设计包含 `signal:resume`/`signal:resumed` 协议用于 WS 重连后批量预注册 connId 路由。后分析发现此协议冗余：每条 `rtc:*` 消息已携带 connId 并触发隐式注册，且 Plugin 不会主动发信令（仅响应 offer），预注册窗口无实际价值。已移除。~~

Server 处理 `rtc:*` 消息时的路由注册：

```
收到 rtc:*（含 botId + connId）：
  if connId 未注册 → 验证 botId 归属 userId → 注册 → 处理消息
  if connId 已注册且属于当前 WS → 直接处理消息
  if connId 已被其他 WS 占用 → 拒绝
```

WS 重连后，`__bridgeConn`/`__ensureRtc` 触发 `__ensureRtc` → 发送 `rtc:offer` → Server 隐式注册 connId 路由。

### 4.5 Bot 离线时的快速通知（可选优化）

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
signalingConn.on('foreground-resume', callback({ source, elapsed })) // 前台恢复 / 网络切换，仅移动端或 network:online
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

**sendSignaling 返回值处理**：调用方应检查返回值。返回 false 时信令未发出，不视为 RTC 失败。

### 6.4 bots store 适配

**WS 与 DC 状态解耦**：

WS 仅是信令通道，其断连不影响 DataChannel 可用性。bots.store 不消费 WS `state` 事件：
- `bot.connState` 已移除，不再镜像 WS 状态
- `bot.rtcPhase` 替代 `connState` + `rtcState`，表示 RTC 生命周期：`'idle' | 'building' | 'ready' | 'recovering' | 'failed'`
- `bot.dcReady` 是 DC 可用的权威标记，仅由 RTC 事件控制（不受 WS 断连影响）
- `remote-log.js` 保留 WS `state` 监听（控制日志发送通道，合法用途）

**RTC 初始化触发**：

`__bridgeConn` 直接触发 `__fullInit`（对 online + 未初始化的 bot）。`__fullInit` 内部通过 `ensureConnected()` 透明等待 WS 就绪，无需依赖 WS 状态事件。

**`waitForConnected` 及消息重试逻辑**已适配：监听 `dcReady`。涉及文件：`src/utils/wait-connected.js`、`src/stores/chat.store.js`。

**前台恢复**：

监听 `signalingConn.on('foreground-resume', { source })` 事件。RTC 恢复决策完全基于 PC 自身状态，不依赖 WS 指标：
- `network:online` → RTC 层不做任何操作（ICE 在前台有自检测能力）
- `app:foreground` 且后台 < 25s → 跳过 probe（ICE 自恢复裕量充足）
- `app:foreground` 且后台 ≥ 25s → 对每个 dcReady 的 claw 执行 `__checkAndRecover`：
  - PC `failed`/`closed` → 直接 rebuild
  - PC `disconnected` → 不干预，交给 ICE 自恢复（5s 超时 → failed → `__scheduleRetry`）
  - PC `connected` → DC probe（3s）→ 成功: 不动 / 失败 + PC 仍 connected: 不动（plugin 可能繁忙）/ 失败 + PC 非 connected: rebuild

仅在移动端（Capacitor）的 visibility/app:foreground 或全平台 network:online 时发射 `foreground-resume`。桌面 visibilitychange 不触发（WebRTC 在桌面后台持续运行）。

**数据刷新**：RTC 恢复后通过 `__refreshIfStale` 按断连间隔判断是否刷新 agents/sessions/topics/dashboard。

> **注**：ICE restart 已移除 — werift 的实现不完整且可能产生僵尸连接。详见 `docs/study/webrtc-connection-research.md`。

---

## 七、连接恢复策略更新

原策略（`webrtc-p2p-channel.md` §8）以 per-bot WS 为前提。更新后：

> **注**：本节替代 `webrtc-p2p-channel.md` §8.4-8.6 中与信令通道相关的描述。

### 7.1 信令 WS 断开恢复

```
信令 WS 断开
  → SignalingConnection 自动重连（指数退避）
  → 重连成功后不触发 RTC 恢复（WS 与 DC 已解耦）
  → 下次发送 rtc:* 消息时隐式注册 connId 路由
```

### 7.2 RTC 恢复

| 场景 | 处理 |
|------|------|
| RTC disconnected | 等待 ICE 自动恢复（10s 超时后 → setState('failed')，交由外层退避重试） |
| RTC failed | 直接 setState('failed')；bots.store `__scheduleRetry` 退避重试（10s→120s 指数退避，最多 8 次，每次 `initRtc` 获取 fresh TURN 凭证），外部事件重置退避计数 |

> **注**：ICE restart 已移除。werift 的实现不完整（详见 `docs/study/webrtc-connection-research.md`）。RTC failed 时由外层 bots.store 退避重试，每次获取 fresh TURN 凭证重建连接。

### 7.3 前台恢复（RTC 层）

RTC 恢复决策完全基于 PC 自身状态和 DC probe，不依赖 WS 指标。

```
network:online
  └─ RTC 层不做任何操作（ICE 在前台有自检测能力）

app:foreground（Capacitor）
  │
  ├─ 后台 < 25s → 跳过（ICE 自恢复裕量充足）
  └─ 后台 ≥ 25s → __checkAndRecover：
       ├─ PC failed/closed → 直接 rebuild
       ├─ PC disconnected → 不干预（ICE 自恢复 + 5s 超时兜底）
       └─ PC connected → DC probe（3s）
            ├─ 成功 → 不动
            ├─ 失败 + PC 仍 connected → 不动（plugin 可能繁忙）
            └─ 失败 + PC 非 connected → rebuild
```

桌面 visibilitychange 不触发 RTC 恢复（WebRTC 在桌面后台持续运行）。
主机休眠/待机 → TODO（现由被动恢复路径覆盖：PC disconnected 5s → setState('failed') → 外层退避重试）。

**待实施优化**：检测到网络类型变化（WiFi↔蜂窝）时触发 probe，加速真实网络切换场景的恢复（当前依赖 ICE 自检测 ~10s）。

### 7.4 sendSignaling 返回值处理

```js
sendSignaling(botId, type, payload) → boolean
```

调用方（WebRtcConnection）应检查返回值：
- `true`：信令已提交到 WS 发送缓冲区
- `false`：WS 不可用，信令未发出。等待 WS 恢复后重试

### 7.5 恢复策略汇总

| # | 场景 | 处理 |
|---|------|------|
| 1 | RTC disconnected | 等待 ICE 自动恢复（10s 后升级 → setState('failed')，交由外层退避重试） |
| 2 | RTC failed | 直接 setState('failed')；bots.store `__scheduleRetry` 退避重试（10s→120s，最多 8 次，每次 `initRtc` 获取 fresh TURN 凭证），外部事件重置退避 |
| 4 | 信令 WS 断开 | 自动重连；不影响 DC 可用性（dcReady 不变） |
| 5 | 信令 WS 恢复 | 不触发 RTC 恢复（WS 与 DC 解耦） |
| 6 | WS 断开但 RTC 仍 connected | RTC 不动，业务 RPC 通过 DC 继续工作 |
| 7 | 前台恢复（app:foreground ≥ 25s） | PC 状态分流 + DC probe（含双重确认）→ 详见 §7.3 |
| 7b | network:online（前台时） | RTC 不操作，信任 ICE 自检测 |
| 8 | bot 解绑 | 释放 connId + 关闭 RTC |

---

## 八、ensureConnected：信令通道可用性保障

> 状态：已实施（阶段二：lastAliveAt 判断优化）

### 8.1 动机

将"确保信令通道可用"收敛为 SignalingConnection 上的阻塞原语，避免应对逻辑散布在多处。

核心问题：

1. **offer 静默丢弃**：`__buildPeerConnection` 中 `sendSignaling` 返回值未检查，offer 写入死连接的 socket buffer → 15s 空等
2. **WS 假活未检测**：WS 表面 connected 但 TCP 已死（NAT 映射过期等），心跳检测最慢需 ~90s
3. **verify 路径优化**：`verify: true` 现基于 `lastAliveAt` 判断 WS 存活性，WS 最近有活动（< PROBE_TIMEOUT_MS）则信任，避免不必要的 forceReconnect

### 8.2 设计：阻塞式 ensureConnected 原语

将"确保信令通道可用"收敛为 SignalingConnection 上的一个阻塞原语：

```js
/**
 * 确保信令 WS 可用。
 * @param {object} [opts]
 * @param {boolean} [opts.verify=false] - true 时主动验证连接活性（用于 RTC 恢复场景）
 * @param {number} [opts.timeoutMs=15000] - 等待超时
 * @returns {Promise<void>} resolve 表示 WS 已 connected；reject 表示超时或主动断开
 */
async ensureConnected({ verify = false, timeoutMs = 15000 } = {})
```

行为：

| WS 当前状态 | verify=false | verify=true |
|------------|-------------|------------|
| `connected` + 近期有消息（<5s） | 立即返回 | 立即返回（冷却期内） |
| `connected` + 无近期消息 | 立即返回 | 探测存活 / force-reconnect，然后返回 |
| `connecting` | 等待 connected | 等待 connected |
| `disconnected` | 触发连接 + 等待 | 触发连接 + 等待 |
| `intentionalClose` | reject | reject |

### 8.3 verify 模式：WS 假活检测

当 `verify=true` 时，ensureConnected 会主动验证 WS 连接活性：

**阶段一（已废弃）**：~~直接 force-reconnect（简单粗暴，适用于用户量少的阶段）~~

```js
// 已被阶段二取代
if (this.__state === 'connected' && verify) {
    if (Date.now() - this.__lastVerifiedAt < VERIFY_COOLDOWN_MS) return; // 冷却
    this.forceReconnect();
    return this.__waitForConnected(timeoutMs);
}
```

**阶段二（当前实施）**：先探测，探测失败再 force-reconnect

```js
if (this.__state === 'connected' && verify) {
    if (Date.now() - this.__lastVerifiedAt < VERIFY_COOLDOWN_MS) return;
    const elapsed = Date.now() - this.__lastAliveAt;
    if (elapsed < PROBE_TIMEOUT_MS) { this.__lastVerifiedAt = Date.now(); return; }
    const alive = await this.__probeAsync(PROBE_TIMEOUT_MS);
    if (alive) { this.__lastVerifiedAt = Date.now(); return; }
    this.forceReconnect();
    return this.__waitForConnected(timeoutMs);
}
```

阶段二中各场景耗时对比：

| WS 状态 | 耗时 |
|---------|------|
| 健康 + 近期有消息 | 0ms |
| 健康 + 无近期消息 | ~10-50ms（ping RTT） |
| 假活 | ~2.5s（探测超时）+ ~100-500ms（重连） |
| 已断开 | 等重连时间 |

vs 当前（无 ensureConnected）：假活场景 → offer 静默丢弃 → **15s 空等**。

### 8.4 冷却机制

防止重试循环中重复 force-reconnect：

- `__lastVerifiedAt`：上次 verify 成功完成的时间戳
- 冷却窗口：5s（`VERIFY_COOLDOWN_MS`）
- 在冷却期内，`verify=true` 视同 `verify=false`（直接返回）

典型场景：`__ensureRtc` 的 3 轮重试 → 第 1 轮 verify + reconnect → 第 2、3 轮命中冷却 → 零额外开销。

### 8.5 使用位置

ensureConnected 仅用在**发送 offer 之前**（流程的发起点）：

| 调用位置 | verify | 说明 |
|---------|--------|------|
| `__buildPeerConnection`（build/rebuild） | true | offer 是建连的发起消息，必须到达 |

后续的 ICE candidate（`rtc:ice`）和状态通知（`rtc:ready`、`rtc:closed`）不使用 ensureConnected：
- ICE candidate 是异步多条 trickle，部分丢失可容忍（通常有冗余 candidate）
- `rtc:ready` / `rtc:closed` 是通知性质，丢失不影响功能

### 8.6 重入安全

| 场景 | 行为 | 安全性 |
|------|------|--------|
| build 期间旧 PC 触发 rebuild | `__buildPeerConnection` 先清理旧 PC（detach 事件）再 await → 窗口消除 | ✅ |
| 多 bot 同时 build | 第一个触发 forceReconnect，后续者 state=connecting → 加入等待 | ✅ |
| `__ensureRtc` 重试循环 | 第 2+ 轮命中冷却 → 跳过 verify | ✅ |

关键设计：`forceReconnect` 只在 `state === 'connected'` 时触发。`state` 为 `connecting` 或 `disconnected` 时仅等待，不重复触发重连。

### 8.7 对恢复策略的简化

引入 ensureConnected 后，§7 中多处 WS 可用性相关的应对逻辑已收敛：

| 原有逻辑 | 变化 |
|---------|------|
| `__onIceFailed` 的恢复决策 | 简化 — ICE restart 已移除，直接 `setState('failed')`，由外层 bots.store 退避重试接管恢复 |
| `__ensureRtc` 循环的 `sigConn.state !== 'connected'` bail-out | 移除 — `initRtc` 内部 await ensureConnected 自然阻塞或超时 |
| sendSignaling 返回值处理 | 简化 — 由 ensureConnected 在上游保障 WS 可用，sendSignaling 返回值退化为防御性检查 |
| WS 恢复后 RTC 恢复入口 | WS 状态不再触发 RTC 恢复；恢复由外部事件（foreground-resume、bot online）和被动检测驱动 |

---

## 九、边界情况

| 场景 | 处理 |
|------|------|
| WS 断开期间 Plugin 发来 `rtc:answer` | `routeRtcToUi` 找不到 connId 路由条目（已在 WS 断开时移除）→ 投递失败，丢弃。DC 被动恢复或前台恢复触发 `__ensureRtc` → `rtc:offer` 隐式注册路由 |
| WS 重连后首条 rtc:offer 之前 Plugin 发来信令 | connId 路由尚未注册 → 投递失败。Plugin 不会主动发信令（仅响应 offer），实际中此窗口无流量 |
| 多 tab 同 bot | 各 tab 有独立 connId，互不冲突。Server 按 connId 精确投递 |
| 单 tab 刷新 | 旧 WS close → 路由条目移除 → Plugin PC 最终 ICE failed 自清理。新页面生成新 connId，full rebuild |
| bot 在 WS 断开期间解绑 | SSE 推送 bot.unbound → UI 清理。Server 移除该 bot 相关 connId 路由。已移除的 bot 不会触发恢复 |
| Server 重启 | 所有 connId 路由丢失。UI `__ensureRtc` → `rtc:offer` 隐式重新注册。Plugin 侧旧 session 通过 ICE failure 自清理 |
| connId 冲突 | Server 注册时检查 connId 是否已被其他 WS 占用，冲突则拒绝 |
| Full rebuild 复用 connId | Plugin 收到同 connId 新 offer → `closeByConnId` 清理旧 session → 创建新 session。已有逻辑支持 |
| WS 重连后发 rtc:offer | 隐式注册 connId，正常工作。`signal:resume` 已移除，隐式注册是唯一路由恢复方式 |
| Bot 离线时发送 rtc:offer | `forwardToBot` 返回 false。可选回复 `rtc:error`（`BOT_OFFLINE`）让 UI 快速感知，否则等 15s 超时 |
| 用户 session 过期 / logout | SignalingConnection 断开信令 WS 并停止重连；所有 connId 释放；Server 侧路由条目随 WS 关闭自动清理 |

---

## 十、TODO（待后续讨论确认）

### ~~初始化触发链路重建~~ ✅ 已完成

WS 与 DC 状态已解耦。初始化/恢复触发机制：

- **首次初始化**：`__bridgeConn` 直接触发 `__fullInit`（对 online + 未初始化的 bot），`ensureConnected()` 内部透明等待 WS 就绪
- **前台/网络恢复**：`foreground-resume` 事件 → `__checkAndRecover` → DC probe / rebuild
- **被动恢复**：WebRtcConnection 内部 disconnected 10s → setState('failed') → bots.store 退避重试
- **bot 上线**：`updateBotOnline` → `__fullInit`（未初始化）或 `__ensureRtc`（已初始化）
- **数据刷新**：`__refreshIfStale` 在 RTC 恢复后按断连间隔自动触发

### 用户 session 过期的处理

信令 WS 基于 session cookie 认证。用户 session 过期后：

- 信令 WS 重连时 server 返回 401 → SignalingConnection 需识别 auth 失败并停止重连
- 应触发 `auth:session-expired` 事件通知上层（等同于当前 per-bot WS 上的 `session.expired` 消息）
- 需区分 auth 失败（停止重连）与网络错误（继续重连）

---

## 十一、实施范围

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
| `src/stores/bots.store.js` | 重构 | WS/DC 状态解耦：移除 connState（改用 rtcPhase）、移除 WS state 消费、DC probe 恢复 |
| `src/utils/wait-connected.js` | 适配 | 监听 dcReady（已完成） |
| `src/stores/chat.store.js` | 适配 | 消息重试逻辑适配新的连接状态 |

### Plugin 侧

无改动。

---

## 十二、风险与约束

| 风险 | 缓解 |
|------|------|
| Server 重启丢失所有 connId 路由 | UI `__ensureRtc` → `rtc:offer` 隐式重新注册。Plugin 侧旧 session 通过 ICE failure 自清理（~30s），UI 的 RTC 恢复级联正常触发 full rebuild |
| 单一 WS 成为单点 | 与原来 per-bot WS 相比，单一 WS 断开影响所有 bot 的信令。但 RTC DataChannel 独立于 WS，业务 RPC 不受影响 |
| WS 断开期间信令丢失 | 不可避免，但 RTC 通常仍存活（ICE 层保活），WS 恢复后 `__ensureRtc` full rebuild 恢复 |
| connId client 生成的唯一性 | UUID v4 碰撞概率可忽略；Server 注册时做冲突检查兜底 |
| Plugin session 延迟清理（tab 关闭后 ~30s） | 资源占用极小（per-session 仅一个 PC 对象），每用户通常 1-3 个 session |
