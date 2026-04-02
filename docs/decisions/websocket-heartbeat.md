# WebSocket 心跳机制分析与设计

> 最后更新：2026-04-02
> 注意：UI ↔ Server 链路已从 per-bot WS 迁移为 per-tab 信令 WS（`signaling-connection.js`），业务 RPC 走 WebRTC DataChannel。本文档 Section 1 的心跳机制仍然适用，但作用对象是信令通道而非业务 RPC 通道。Section 2-4 不受影响。

## 背景

CoClaw 的 WebSocket 链路包含 3 段：

```
UI ←ws(信令)→ Server ←ws→ Plugin(openclaw) ←ws→ OpenClaw Gateway
```

本文档记录各链路的心跳机制、已知问题、ws 库行为分析，以及 OpenClaw Gateway 的相关机制。

## 各链路心跳机制现状

### 1. UI → Server（信令 WS 客户端心跳）

| 项 | 说明 |
|---|---|
| 文件 | `ui/src/services/signaling-connection.js` |
| 类型 | 应用层（`{ type: 'ping' }` / `{ type: 'pong' }`） |
| Ping 间隔 | 25s |
| 超时策略 | 两层机制：常规 miss 计数（2 次 ≈ 90s）+ pending RPC 抑制（额外 4 轮 ≈ 180s，绝对上限 ~270s） |
| RPC 兜底超时 | 所有 `request()` 默认 30 分钟，确保 `__pending` 条目不会永远滞留 |
| 状态 | **已修复** |

### 1b. Server → UI（服务端侧）

| 项 | 说明 |
|---|---|
| 类型 | **无**（已移除） |
| 说明 | Server 不对 UI ws 做协议级心跳或主动断连。UI 客户端自行维护应用层心跳，半开连接由 UI 侧检测或用户刷新恢复 |
| 理由 | 避免大消息传输时误 terminate UI 连接，优先保证通信顺畅。当前规模下死 UI 连接的资源开销可忽略 |

### 2. Server → Plugin（服务端检测 bot 连接存活）

| 项 | 说明 |
|---|---|
| 文件 | `server/src/bot-ws-hub.js` |
| 类型 | 协议级 `ws.ping()` + `__isAlive` 标志 + 连续 miss 计数 |
| 间隔 | 45s |
| 超时判定 | `__isAlive === false` 时：`bufferedAmount > 0` 跳过（不计 miss）；否则 miss 计数 +1，连续 4 次 miss 才 terminate |
| 有效容忍窗口 | ~180s（4 × 45s），与 Plugin 侧对齐 |

Server 同时被动响应 plugin 发来的应用层心跳：收到 `{ type: 'ping' }` 后回复 `{ type: 'pong' }`（`bot-ws-hub.js:286-289`）。

### 3. Plugin → Server（插件检测 server 连接存活）

| 项 | 说明 |
|---|---|
| 文件 | `plugins/openclaw/src/realtime-bridge.js:103-126` |
| 类型 | 应用层（`{ type: 'ping' }` / `{ type: 'pong' }`） |
| Ping 间隔 | 25s |
| 超时 | 45s |
| 超时重置 | 收到任意 message 时 |
| 状态 | **已修复**：连续 miss 计数策略（`SERVER_HB_MAX_MISS = 4`，~3 分钟容忍） |

### 4. Plugin ↔ Gateway

| 项 | 说明 |
|---|---|
| 文件 | `plugins/openclaw/src/realtime-bridge.js:290-366` |
| CoClaw 侧 | **无心跳机制** |
| Gateway 侧 | 广播 `tick` 事件（每 30s），客户端可用于存活检测（见下文） |

## `ws` 库行为分析（v8.19.0）

### ws 不提供内置心跳

- `ws` 库**只提供 API 工具**（`.ping()` 方法、`'pong'` 事件），不会自动发送 ping 或检测超时
- 没有 `enableHeartbeat`、`pingInterval` 等配置项
- 所有心跳调度、超时判定、断连决策都是应用代码负责
- README 中的 `__isAlive` 模式只是推荐用法示例，不是内置功能

### ws 不自动分片

- `WebSocket.send()` 始终以 `fin: true` 发送，整个消息作为单个 WebSocket 帧
- RFC 6455 允许 control frame 在 fragment 之间插入，但由于不分片，control frame 必须等当前 data frame 全部写完
- 没有配置项可启用自动分片

### 协议级 ping/pong 与应用层 ping/pong 面临相同的阻塞问题

两者最终都通过 `socket.write()` 写入同一个 Node.js writable stream：

- 大 data frame 字节未刷完时，后续 ping frame 排在其后（FIFO）
- `sendFrame()` 直接调用 `socket.write()`，无背压检查
- ping/pong 与 data frame 共享同一个 FIFO 队列（`Sender._queue`），无优先级机制
- 自动 pong（收到 ping 后）走与 `send()` 完全相同的 `Sender` 路径

关键源码位置：
- `node_modules/ws/lib/sender.js` — `sendFrame()`、`enqueue()`/`dequeue()` 机制
- `node_modules/ws/lib/websocket.js:1234-1239` — `receiverOnPing` 自动 pong 触发

### TCP 全双工但同方向 FIFO

- TCP 是全双工的：发送大消息**不阻塞接收**
- 但**同方向**的数据严格 FIFO：outbound ping 排在 outbound data 后面

### `bufferedAmount` 可用于辅助判断

`ws` 的 `WebSocket.bufferedAmount` 属性（只读）反映发送缓冲区积压量，可在心跳超时逻辑中用于判断"是否还有数据在发送中"。但 `ws` 内部不使用它做任何心跳相关判断。

## OpenClaw Gateway 的连接管理机制

> 来源：`openclaw-repo/openclaw` 源码

### 连接握手

1. 新 WebSocket 连接建立后，Gateway 发送 `connect.challenge` 事件（含 nonce）
2. 客户端需在 10s 内回复 `connect` 请求（`DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000`）
3. 握手成功后 Gateway 返回 `hello-ok`，包含 `policy.tickIntervalMs`（默认 30s）

### 存活检测：tick 事件（应用层）

- Gateway 每 30s 广播 `tick` 事件到所有连接客户端（`server-maintenance.ts:58-63`）
- `tick` 事件使用 `dropIfSlow: true`：对发送缓冲 >50MB 的客户端静默丢弃
- OpenClaw 官方 `GatewayClient` 实现 tick watchdog：
  - 若 `tickIntervalMs * 2`（60s）内未收到 tick，以 code 4000 关闭连接（`client.ts:453-475`）
- **Gateway 服务端不主动检测死连接**：完全依赖客户端通过 tick watchdog 自行发现并断连

### 无协议级 ping/pong

Gateway WebSocket 服务端（基于 `ws` 库）未使用 `ws.ping()`，无任何协议级心跳。

### 连接标识

- 每个连接分配 `connId`（server 生成的 UUID），非稳定客户端 ID
- 连接存储在 `Set<GatewayWsClient>` 中，无按客户端身份的重连续接机制
- 断连时从 Set 中删除，更新 presence 状态

## 问题总结

| 链路 | 风险 | 说明 |
|---|---|---|
| UI → Server | ✅ 已修复 | 两层心跳（miss 计数 + pending 抑制 + 绝对上限）；RPC 默认 30 分钟兜底超时；server 侧不主动 ping UI |
| Server → Plugin（协议级） | ✅ 已修复 | `bufferedAmount` 容错 + 重连淘汰旧连接 |
| Plugin → Server（应用层） | ✅ 已修复 | 连续 miss 计数策略（~3 分钟容忍） |
| Plugin ↔ Gateway | ✅ 无风险 | CoClaw 侧无心跳机制，不存在误判 |

## 为什么 Plugin 侧无法可靠感知大消息传输

Plugin 侧的心跳抑制不能简单复用 UI 侧的 "pending RPC" 策略，原因如下。

### 典型场景：UI 发送含 MB 级图像的 agent 请求

```
UI --[大消息]-→ Server --[转发]-→ Plugin --[转发]-→ Gateway
                        ↑ 这段因网络慢而耗时
```

1. Server 调用 `ws.send(largeJSON)` 发给 plugin
2. WebSocket `message` 事件**只在整帧完全接收后**才触发；传输期间 plugin 收不到任何 `message`
3. Plugin 的心跳 ping（outbound）不受阻塞（TCP 全双工），成功发给 server
4. Server 收到 ping 后回复 pong——但 **pong 与大消息同方向**（server→plugin），被排在大消息后面
5. Plugin 收不到 pong，直到大消息传完
6. 若传输 >45s → 心跳超时误判

### `gatewayPendingRequests.size` 不可靠

- **大消息入方向**（server→plugin）：消息还没收完 → plugin 尚未向 gateway 发请求 → `gatewayPendingRequests.size === 0`
- **大消息出方向**（plugin→server，转发 gateway 响应）：gateway 请求已 resolve 并从 map 中删除 → `gatewayPendingRequests.size` 同样可能为 0

两个方向都不可靠。

### 防护能力的不对称

| 侧 | 能否感知 | 依据 |
|---|---|---|
| Server | **能** | 发送大消息后 `ws.bufferedAmount > 0`，可跳过协议级 ping 超时判定 |
| Plugin | **不能** | 标准 WebSocket API 无法得知"对方正在给我发大消息"或"我的 pong 被排队" |

**结论：Server 侧是唯一能可靠感知并容错的一方。** Plugin 侧应采用高容忍度策略，避免误判。

## 解决方案

### 原则

- **Server 侧**精确防护：利用 `bufferedAmount` 感知大消息传输，避免误 terminate
- **Plugin 侧**高容忍：server 几乎总是在线，plugin 侧心跳主要用于应对 server 极端故障（崩溃、网络断开），允许较长检测延迟

### 方案 1：Server 侧——协议级 ping + `bufferedAmount` 容错 + 连续 miss 计数

文件：`server/src/bot-ws-hub.js`

`bufferedAmount` 只能感知"server 正在发大消息"（server→bot），无法感知"bot 正在给 server 发大消息"（bot→server，pong 被排在大数据帧后面）。因此在 `bufferedAmount` 之外增加连续 miss 计数，两个方向均覆盖：

```js
ws.__isAlive = true;
ws.__pingMissCount = 0;
ws.on('pong', () => {
    ws.__isAlive = true;
    ws.__pingMissCount = 0;
});
const BOT_PING_INTERVAL_MS = 45_000;
const BOT_PING_MAX_MISS = 4;
const botPingInterval = setInterval(() => {
    if (!ws.__isAlive) {
        // server→bot 大消息传输中，跳过（不计 miss）
        if (ws.bufferedAmount > 0) {
            ws.ping();
            return;
        }
        ws.__pingMissCount++;
        if (ws.__pingMissCount < BOT_PING_MAX_MISS) {
            ws.ping();
            return;
        }
        clearInterval(botPingInterval);
        wsLogWarn(`bot ws ping timeout after ${ws.__pingMissCount} misses, terminating botId=${botId}`);
        ws.terminate();
        return;
    }
    ws.__isAlive = false;
    ws.__pingMissCount = 0;
    ws.ping();
}, BOT_PING_INTERVAL_MS);
```

**UI 侧不做协议级心跳**：server 不对 UI ws 发送 `ws.ping()`，也不主动 terminate。UI 客户端自行维护应用层心跳，半开连接由 UI 侧检测或用户刷新恢复。理由：避免大消息传输时误 terminate UI 连接，优先保证通信顺畅。

同时增加**重连淘汰旧连接**：新 bot socket 连接同一 botId 时，主动关闭该 botId 的旧 socket。避免半开连接残留在 `botSockets` Set 中导致消息发送到死连接。

### 方案 2：Plugin 侧——高容忍心跳（~3 分钟）

文件：`plugins/openclaw/src/realtime-bridge.js`

将当前的单次 45s 超时改为**连续 miss 计数**策略：

- Ping 间隔：保持 25s
- 单轮超时窗口：保持 45s
- 最大连续 miss：4 次（有效超时 ≈ 4 × 45s = 180s ≈ 3 分钟）
- 收到任意 message → 重置 miss 计数为 0

```js
// 常量调整
const SERVER_HB_PING_MS = 25_000;
const SERVER_HB_TIMEOUT_MS = 45_000;
const SERVER_HB_MAX_MISS = 4; // 连续 4 次无响应才断连（~3 分钟）

__startServerHeartbeat(sock) {
    this.__clearServerHeartbeat();
    this.__serverHbMissCount = 0;
    this.serverHbInterval = setInterval(() => {
        if (sock.readyState === 1) {
            try { sock.send(JSON.stringify({ type: 'ping' })); } catch {}
        }
    }, SERVER_HB_PING_MS);
    this.serverHbInterval.unref?.();
    this.__resetServerHbTimeout(sock);
}

__resetServerHbTimeout(sock) {
    this.__serverHbMissCount = 0; // 收到消息 → 重置
    if (this.serverHbTimer) clearTimeout(this.serverHbTimer);
    this.serverHbTimer = setTimeout(() => {
        this.__onServerHbMiss(sock);
    }, SERVER_HB_TIMEOUT_MS);
    this.serverHbTimer.unref?.();
}

__onServerHbMiss(sock) {
    this.__serverHbMissCount++;
    if (this.__serverHbMissCount < SERVER_HB_MAX_MISS) {
        this.__logDebug(
            `server heartbeat miss ${this.__serverHbMissCount}/${SERVER_HB_MAX_MISS}, will retry`
        );
        // 补发一次 ping，继续等下一轮
        if (sock.readyState === 1) {
            try { sock.send(JSON.stringify({ type: 'ping' })); } catch {}
        }
        this.serverHbTimer = setTimeout(() => {
            this.__onServerHbMiss(sock);
        }, SERVER_HB_TIMEOUT_MS);
        this.serverHbTimer.unref?.();
        return;
    }
    this.logger.warn?.(
        `[coclaw] server ws heartbeat timeout after ${this.__serverHbMissCount} consecutive misses, closing`
    );
    try { sock.close(4000, 'heartbeat_timeout'); } catch {}
}
```

### 方案 3：UI 侧——两层心跳（miss + pending 抑制）

文件：`ui/src/services/signaling-connection.js`

UI 侧环境特殊（移动端弱网），且能通过 `__pending` 感知 RPC 是否在进行中，因此采用两层机制：

- **第一层（常规容忍）**：连续 2 次 miss（~90s）给弱网一次额外机会
- **第二层（pending 抑制）**：miss 达到 2 时，若 `__pending.size > 0` 则继续容忍，额外最多 4 轮（~180s），绝对上限 ~270s

状态管理仅用单一计数器 `__hbMissCount`，判定逻辑：

```js
const canRetry =
    this.__hbMissCount < HB_MAX_MISS ||
    (this.__pending.size > 0 && this.__hbMissCount < HB_MAX_MISS + HB_SUPPRESS_LIMIT);
```

| 场景 | 容忍时间 |
|---|---|
| 无 pending RPC | ~90s（2 × 45s） |
| 有 pending，连接真死 | ~270s（绝对上限） |
| 有 pending，连接活着 | 无限（pong 持续到达，missCount 持续重置） |

**RPC 默认超时**：所有 `request()` 调用始终设置 timer（显式 timeout 优先，否则默认 30 分钟），确保 `__pending` 条目不会永远滞留。超时后的迟到响应在 `__handleRpcResponse` 中被静默忽略（`if (!waiter) return`）。

### 方案 4：Plugin ↔ Gateway——不变

CoClaw 侧无心跳机制，不存在误判问题。Gateway 的 `tick` 事件可用于未来增加存活检测，当前不需要。

### 变更影响范围

| 文件 | 变更 |
|---|---|
| `server/src/bot-ws-hub.js` | 协议级 ping（45s）+ `bufferedAmount` 容错 + 连续 miss 计数（4 次，~180s）；移除 UI 侧心跳；重连淘汰旧连接 |
| `plugins/openclaw/src/realtime-bridge.js` | 心跳改为连续 miss 计数策略（~3 分钟容忍） |
| `ui/src/services/signaling-connection.js` | 两层心跳（miss + pending 抑制 + 绝对上限）；RPC 默认 30 分钟兜底超时 |
| 各处测试文件 | 配套更新 |
