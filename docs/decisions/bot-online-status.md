# Bot 在线状态感知与展示

> 创建日期：2026-03-03
> 最后更新：2026-04-02
> 状态：已实施（SSE 推送方案）

## 背景

UI 需要感知并展示已绑定 bot 的在线/离线状态。

## 决策过程

早期采用轮询方案（方案 A），后迁移至 SSE 推送方案（方案 B）。

### 方案 A：轮询（已弃用）

UI 定期调用 `GET /api/v1/bots`（30s 间隔，页面可见时才轮询）。简单可靠但不实时（0~30s 延迟），已被 SSE 方案取代。`GET /api/v1/bots` 端点保留作为后备。

### 方案 B：SSE 推送（当前方案）

选择 SSE 而非 WS 的理由：当前需求是单向（Server→UI）状态推送，SSE 原生支持自动重连，实现复杂度更低。

## 当前实现

### Server 端

**SSE 端点**：`GET /api/v1/bots/status-stream`（`bot.route.js`），session cookie 认证。

**核心模块**：`bot-status-sse.js`

- `sseClients: Map<userId, Set<Response>>` — 按用户管理 SSE 连接
- `registerSseClient(userId, res)` — 注册客户端，连接关闭时自动清理
- `sendSnapshot(userId, res)` — 推送全量 bot 快照（含在线状态）
- `sendToUser(userId, data)` — 向用户的所有 SSE 客户端推送增量事件

**事件触发链**：`bot-ws-hub.js` 中的 `botStatusEmitter` 发出 `status`/`nameUpdated` 事件 → `bot-status-sse.js` 监听后查找 bot 所属 userId → 推送到对应用户的 SSE 客户端。

**连接流程**：
1. 客户端建立 SSE 连接
2. Server 先推送 `bot.snapshot`（全量快照），再注册增量监听（避免增量事件被后到的快照覆盖）
3. 30s 间隔发送 `heartbeat` 事件，供客户端检测 SSE 健康

### SSE 事件清单

| 事件 | 触发时机 | Payload |
|------|---------|---------|
| `bot.snapshot` | 连接建立时 | `{ items: [{ id, name, online, lastSeenAt, createdAt, updatedAt }] }` |
| `bot.status` | bot 上线/下线 | `{ botId, online }` |
| `bot.nameUpdated` | bot 名称变更 | `{ botId, name }` |
| `bot.bound` | 新 bot 绑定 | `{ bot: { id, name, online, createdAt } }` |
| `bot.unbound` | bot 解绑 | `{ botId }` |
| `heartbeat` | 每 30s | `{}` |

其中 `bot.bound` 和 `bot.unbound` 由 `bot.route.js` 的绑定/解绑 handler 直接调用 `sendToUser()` 推送。

### UI 端

`bots.store` 在用户登录后建立 SSE 连接，监听上述事件实时更新 bot 列表和在线状态。`ManageBotsPage`、侧边栏 bot 列表等组件从 store 响应式读取。
