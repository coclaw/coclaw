# API 迁移：bot → claw 命名

> **状态**：Server 侧已完成
> **关联**：`server/BOT_TO_CLAW_PLAN.md`（临时工作文档）

## 背景

CoClaw 最初沿用 OpenClaw 的 "bot" 术语，现将外部接口从 bot → claw 渐进迁移。
由于无法确保 plugin/UI 同步升级，采用**双写兼容**策略：Server 先在响应中同时提供新旧字段，旧客户端继续读旧字段不受影响，新客户端切换到新字段。

## 迁移策略

```
Server 兼容层完成 → 部署 → 验证旧版兼容 → Plugin 迁移 → UI 迁移 → （远期）移除旧字段
```

各阶段独立，可分别发版。移除旧字段需等所有客户端确认不再使用后再进行。

## Server 侧兼容层（已完成）

### Phase A：HTTP 响应 + WS 消息字段双写 ✅

所有含 `botId`/`bot` 的 HTTP 响应和 WS 消息中，新增同值的 `clawId`/`claw`。

| 端点 | 旧字段 | 新增字段 | commit |
|------|--------|----------|--------|
| `POST /api/v1/bots/bind` | `botId`, `bot { id, name }` | `clawId`, `claw { id, name }` | 527e336 |
| `GET /api/v1/bots/self` | `botId` | `clawId` | 527e336 |
| `POST /api/v1/bots/unbind` | `botId` | `clawId` | 527e336 |
| `POST /api/v1/bots/unbind-by-user` | `botId` | `clawId` | 527e336 |
| `POST /api/v1/bots/ws-ticket` | `botId` | `clawId` | 527e336 |
| `POST /api/v1/bots/binding-codes/wait` | `bot` | `claw` | 527e336 |
| `POST /api/v1/claws/claim-codes/wait` | `botId` | `clawId` | 527e336 |
| `POST /api/v1/claws/claim` | `botId`, `botName` | `clawId`, `clawName` | 527e336 |
| WS `bot.unbound` payload | `botId` | `clawId` | 527e336 |

### Phase B：SSE 双事件 + 路由别名 + WS 路径别名 ✅

**SSE 双事件**：每个 SSE 推送先发 `claw.*` 事件（新版 UI 消费），再发 `bot.*` 事件（旧版 UI 消费）。旧版 UI 对不识别的 `claw.*` 事件静默忽略（switch 无 default 分支）。

| SSE 事件 | 新版事件 | 旧版事件（保留） |
|----------|----------|-----------------|
| 全量快照 | `claw.snapshot` | `bot.snapshot` |
| 在线状态 | `claw.status`（字段 `clawId`） | `bot.status`（字段 `botId` + `clawId`） |
| 名称更新 | `claw.nameUpdated`（字段 `clawId`） | `bot.nameUpdated`（字段 `botId` + `clawId`） |
| 绑定 | `claw.bound`（字段 `claw`） | `bot.bound`（字段 `bot` + `claw`） |
| 解绑 | `claw.unbound`（字段 `clawId`） | `bot.unbound`（字段 `botId` + `clawId`） |

**HTTP 路由别名**：`/api/v1/claws/*` 路由与 `/api/v1/bots/*` 指向同一 handler（`app.js` 中 `clawBotRouter` 同时挂载到两个前缀）。

**WS 路径别名**：`/api/v1/claws/stream` 与 `/api/v1/bots/stream` 均可接入 WS 连接。

**SSE 路径别名**：`/api/v1/claws/status-stream` 与 `/api/v1/bots/status-stream` 均可接入 SSE 流（通过路由别名自动覆盖）。

## 客户端迁移（待实施）

### Phase C：Plugin 迁移

Plugin 切换到读 `clawId`/`claw`，不再依赖 `botId`/`bot`。

关键文件：
- `plugins/openclaw/src/common/bot-binding.js` — 读 `data.botId` → `data.clawId`
- `plugins/openclaw/src/realtime-bridge.js` — 读 `payload.botId` → `payload.clawId`（WS `bot.unbound` 消息）
- `plugins/openclaw/src/config.js` — 持久化 `botId` → `clawId`（需兼容旧配置文件）

### Phase D：UI 迁移

UI 切换到使用 `claw.*` 事件和 `clawId`/`claw` 字段。

关键文件：
- `ui/src/composables/use-bot-status-sse.js` — switch 从 `bot.*` 改为 `claw.*` 事件名
- `ui/src/services/bots.api.js` — 读 `botId`/`botName` → `clawId`/`clawName`；URL 路径 `/api/v1/bots/*` → `/api/v1/claws/*`
- `ui/src/views/ClaimPage.vue` — 读 `botId` → `clawId`

### 远期：移除旧字段和旧路由

等所有客户端确认迁移完成后：
- 移除 HTTP 响应中的 `botId`/`bot`/`botName` 字段
- 移除 `/api/v1/bots/*` 路由（只保留 `/api/v1/claws/*`）
- 移除 WS 路径 `/api/v1/bots/stream`
- 移除 SSE `bot.*` 事件（只保留 `claw.*`）
- WS 消息类型 `bot.unbound` → `claw.unbound`
- Close reason `bot_unbound`/`bot_blocked` → `claw_unbound`/`claw_blocked`
- 错误码 `BOT_NOT_FOUND`/`BOT_OFFLINE` → `CLAW_NOT_FOUND`/`CLAW_OFFLINE`
- 查询参数 `?botId=` → `?clawId=`，`?role=bot` → `?role=claw`

## WS 信令中的 botId（三端联动）

WS 信令（RTC signaling）中的 `botId` 字段涉及 server + UI + plugin 三端。

### Server 侧兼容已完成 ✅

- `rtc-signal-hub.js`：使用 `payload.clawId || payload.botId` 兼容新旧客户端
- `rtc-signal-router.js`：路由表内部字段已从 `botId` 改为 `clawId`
- `claw-ws-hub.js`：UI session 鉴权同时接受 `?clawId=` 和 `?botId=` 查询参数

### UI 侧待迁移

- `signaling-connection.js:197,211` — 出站 RTC 消息中发送 `botId` → 改为 `clawId`
- `webrtc-connection.js:601` — 入站信令按 `botId` 过滤 → 改为 `clawId`
- WS 连接查询参数 `?botId=` → `?clawId=`

### Plugin 侧

Plugin 不直接在 RTC 信令消息中发送 `botId`（plugin 的 WS 连接已通过 token 鉴权绑定了 clawId），无需改动。

### WS 消息类型 + close reason 兼容 ✅

**`bot.unbound` / `claw.unbound` WS 消息类型**：
- `notifyAndDisconnectClaw`（server→plugin/UI）：先发 `claw.unbound` 再发 `bot.unbound`，新版 plugin 匹配前者，旧版匹配后者
- `onClawMessage`（plugin→server）：同时接受 `claw.unbound` 和 `bot.unbound`，新版 plugin 发前者，旧版发后者

**WS close reason**：
- `getWebSocketCloseCode` 同时接受 `claw_unbound`/`bot_unbound` → 4001 和 `claw_blocked`/`bot_blocked` → 4003
- Plugin/server 双方只检查数字 code（4001/4003），不解析 reason 字符串
- `onClawMessage` 的 close reason 根据收到的消息类型动态选择 `claw_unbound` 或 `bot_unbound`

## 暂不迁移的协议元素

以下留到远期一次性切换：

- HTTP 错误码（`BOT_NOT_FOUND`、`BOT_OFFLINE`）
- `?role=bot` 查询参数

## 验证要点

Server 兼容层部署后，需验证：

1. **旧版 Plugin**：绑定（bind/claim）、查询自身（self）、解绑（unbind）、WS 连接、bot.unbound 处理均正常
2. **旧版 UI**：SSE 事件接收（`bot.*` 事件仍正常触发）、WS ticket 获取、解绑操作均正常
3. **新增字段/事件不干扰**：旧版 UI 的 `claw.*` SSE/WS 事件被静默忽略；旧版 plugin 的多余 JSON 字段不影响（点访问，无 schema 校验）
4. **路由别名**：`/api/v1/claws/*` 可正常访问所有原 `/api/v1/bots/*` 端点
5. **WS 路径别名**：`/api/v1/claws/stream` 可正常建立 WS 连接
6. **WS 双消息**：旧版 plugin 收到 `claw.unbound` 时忽略，收到 `bot.unbound` 时正常处理
