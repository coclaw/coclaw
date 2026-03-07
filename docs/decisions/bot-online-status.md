# Bot 在线状态感知与展示

> 创建日期：2026-03-03
> 状态：方案 A 已实施，方案 B 待实施

## 背景

UI 需要感知并展示已绑定 bot 的在线/离线状态。

## 现有架构分析

### Server 端已有能力

1. **`GET /api/v1/bots`** 已返回 `online: boolean`（`bot.route.js:88`），基于内存 `botSockets` Map 实时计算
2. **`bot-ws-hub.js`** 核心数据结构：
   - `botSockets: Map<botId, Set<WebSocket>>` — bot 端连接池
   - `uiSockets: Map<botId, Set<WebSocket>>` — UI 端连接池（per-bot，非 per-user）
   - `listOnlineBotIds()` — 返回所有在线 botId 的 Set
3. bot 连接/断开时执行 `registerSocket`/`unregisterSocket`（line 352-359），打日志但**不推送状态变更**
4. `refreshBotName(botId)` 在 bot 连接时自动调用，通过 RPC `agent.identity.get` 同步名称

### UI 端已有能力

1. **`bots.store.js`** 的 `addOrUpdateBot()` 已存储 `online: Boolean(bot.online)`，但无组件读取
2. **i18n** 已定义：`layout.botOffline`、`layout.bindFirst`、`chat.noActiveBot`
3. **无持久连接/轮询** — `loadBots()` 仅在页面挂载时调用一次
4. **`gateway.ws.js`** 中 `createGatewayRpcClient()` 是 per-bot、按需创建的 RPC 客户端，不适合用于跨 bot 状态监听

### 核心缺口

| 缺口 | 说明 |
|---|---|
| 无推送 | bot 上线/下线时，server 不通知 UI |
| 无持久监听 | UI 没有常驻连接接收状态变更 |
| 无展示 | `online` 字段存了但没渲染 |

## 方案 A：轮询（当前实施）

- UI 定期调用 `GET /api/v1/bots`（30s 间隔，页面可见时才轮询）
- **Server 无需改动**
- 在 `MainList.vue`、`ManageBotsPage.vue` 渲染 online/offline 状态指示器

### 优点
- 简单可靠，无 server 改动
- 适合当前阶段（用户量小、bot 数少）

### 缺点
- 不实时，有 0~30s 延迟
- 持续产生 HTTP 请求（虽然负载很轻）

## 方案 B：Server 推送（下一步实施）

### 需要解决的核心问题

当前 `uiSockets` 是 **per-bot** 的（Map key 为 botId），无法在某个 bot 上线/下线时通知到该用户的所有 UI 客户端。需要新增**用户级**的连接通道。

### 实施要点

#### Server 端改动

1. **新增用户级连接映射**：在 `bot-ws-hub.js` 中增加 `userSockets: Map<userId, Set<WebSocket>>`
   - 或者新建独立的 SSE/WS endpoint（如 `/api/v1/status/stream`），专门用于状态推送
2. **在 bot 连接/断开时广播**：
   - `registerSocket(botSockets, ...)` 之后，查找该 bot 所属 userId，向 `userSockets[userId]` 广播 `{ type: 'event', event: 'bot.status', payload: { botId, online: true } }`
   - `unregisterSocket(botSockets, ...)` 之后同理，广播 `online: false`
   - 注意：只在 bot 的**最后一个连接断开**时才发 offline（`set.size === 0`）
   - 注意：只在 bot 的**第一个连接建立**时才发 online（`set.size` 从 0 变 1）
3. **需要 bot → userId 的映射**：
   - 方式 a：在 `registerSocket` 时从 DB 查 bot.userId 并缓存
   - 方式 b：在 WS 鉴权成功后将 userId 附加到 socket metadata

#### UI 端改动

1. **建立持久连接**：在 `AuthedLayout` 或 App 层面建立一个用户级 WS/SSE 连接
2. **监听 `bot.status` 事件**：收到后更新 `bots.store` 中对应 bot 的 `online` 字段
3. **移除轮询逻辑**：替换方案 A 的定时器

#### 协议设计（建议）

```
// SSE 或 WS 方案

// 方向：Server → UI
// 事件类型：bot.status
{
  "type": "event",
  "event": "bot.status",
  "payload": {
    "botId": "123456789",
    "online": true,
    "name": "MyBot"       // 可选，连接时 refreshBotName 的结果
  }
}
```

#### SSE vs 用户级 WS 的选择

| 维度 | SSE | 用户级 WS |
|---|---|---|
| 方向 | 单向（Server→UI） | 双向 |
| 复杂度 | 较低 | 较高 |
| 浏览器支持 | 原生支持，自动重连 | 需手动重连 |
| 适用场景 | 纯状态推送 | 如果未来还需要用户级双向通信 |
| 建议 | **优先选择**（当前需求是单向的） | 如果有其他双向需求再考虑 |

### 关键文件清单

| 文件 | 作用 |
|---|---|
| `server/src/bot-ws-hub.js` | bot/UI WebSocket 管理中心，需增加用户级推送 |
| `server/src/routes/bot.route.js` | bot REST API，可能需新增 SSE endpoint |
| `ui/src/stores/bots.store.js` | bot 状态存储，需接收推送更新 |
| `ui/src/services/gateway.ws.js` | 现有 per-bot RPC 客户端，方案 B 可能需新建独立模块 |
| `ui/src/components/MainList.vue` | 侧边栏 bot 列表，需渲染状态指示器 |
| `ui/src/views/ManageBotsPage.vue` | bot 管理页，需渲染状态指示器 |
| `ui/src/layouts/AuthedLayout.vue` | 认证后布局，可在此建立持久连接 |
