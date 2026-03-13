# CoClaw Current Architecture (One-page)

Last updated: 2026-03-06

## 1) Scope (current milestone)

当前里程碑只聚焦：
- UI 发起“添加机器人”
- 8 位绑定码完成绑定（UI -> Server -> OpenClaw tunnel）
- 前端/服务端解绑后，OpenClaw 侧自动收敛清理（无需用户手动命令）

约束：当前实现已支持**每用户多个 Bot 记录**；UI/会话入口默认选择一个 active bot 建立实时通道。

---

## 2) Component view

```text
┌────────────────┐       HTTPS        ┌────────────────────┐
│ CoClaw UI      │ ─────────────────▶ │ CoClaw Server      │
│ (Vue)          │                    │ (Express + Prisma) │
└────────────────┘                    └─────────┬──────────┘
                                                │
                                     MySQL      │
                                                ▼
                                       ┌─────────────────┐
                                       │ DB (Bot,        │
                                       │ BotBindingCode) │
                                       └─────────────────┘
                                                ▲
                                                │ HTTPS / WS
                                                │
┌────────────────────────────────────────────────────────────────┐
│ OpenClaw + @coclaw/openclaw-coclaw plugin                      │
│ - openclaw coclaw bind / unbind                               │
│ - local config (~/.openclaw/coclaw/bindings.json)             │
│ - realtime bridge (WS /api/v1/bots/stream?token=...)          │
│ - plugin <-> local gateway websocket bridge                   │
│ - session-manager provides business gateway methods            │
└────────────────────────────────────────────────────────────────┘
```

---

## 3) Key API / Protocol map

### UI -> Server
- `POST /api/v1/bots/binding-codes`：生成 8 位绑定码
- `POST /api/v1/bots/binding-codes/wait`：长轮询等待绑定完成
- `GET /api/v1/bots`：查询当前 bot 状态
- `GET /api/v1/bots/status-stream`：SSE 实时推送 bot 在线状态
- `POST /api/v1/bots/unbind-by-user`：前端按 botId 发起定向解绑
- `POST /api/v1/bots/ws-ticket`：申请 UI websocket 一次性 ticket（支持按 botId 指定目标 bot）

### Plugin -> Server
- `POST /api/v1/bots/bind`：code 换 `botId + token`
- `POST /api/v1/bots/unbind`：bot 主动解绑
- `GET /api/v1/bots/self`：自检（保留）
- `WS /api/v1/bots/stream?token=...`：实时控制通道

### UI/Server/Plugin RPC over WS
- UI -> Server (with ticket): `rpc.req`
- Server -> tunnel bot: transparent forward `rpc.req`
- tunnel -> local gateway ws: convert to gateway `req`
- gateway -> tunnel: `res/event`
- tunnel -> Server/UI: `rpc.res/rpc.event`

### Server -> Plugin (WS control)
- control message: `bot.unbound`
- close code:
  - `4001` token revoked / unbound
  - `4003` blocked

---

## 4) Server WebSocket 连接管理模型

文件：`server/src/bot-ws-hub.js`

### 数据结构

```js
botSockets: Map<botId, Set<WebSocket>>   // bot（plugin）端连接，key 为 botId
uiSockets:  Map<botId, Set<WebSocket>>   // UI 端连接，key 为 botId（非 userId）
```

两个 Map 均以 `botId` 为 key，value 为该 botId 下所有活跃 WebSocket 的 Set。

### 消息路由

| 方向 | 函数 | 行为 |
|---|---|---|
| bot → UI | `broadcastToUi(botId, payload)` | 遍历 `uiSockets[botId]` 的所有 ws，逐个 send |
| UI → bot | `forwardToBot(botId, payload)` | 遍历 `botSockets[botId]` 的所有 ws，逐个 send |

- 上行：UI 发送 `req`（带唯一 `id`）→ server 透传给 bot → bot 响应带相同 `id` → server broadcast 给所有 UI ws → 每个 UI 客户端按 `id` 匹配自己的 pending 请求
- 下行：bot 发送 `event` → server broadcast 给所有 UI ws → 所有窗口均收到

### 多 UI 实例行为

同一用户打开多个浏览器窗口并连接同一 botId 时：

- 所有窗口的 ws 都在 `uiSockets[botId]` 的 Set 中，server **不区分**来自哪个窗口/session
- bot 的响应和事件 broadcast 到所有窗口——这是正确的，因为它们观察的是同一个 bot
- 请求-响应的正确性由客户端按 `id` 匹配保证，不依赖 server 做实例级路由
- 鉴权层面：`authenticateUiSession` 校验 `bot.userId === session.userId`，只有 bot owner 能连接

### Bot 连接管理

- **淘汰旧连接**：新 bot ws 连接同一 botId 时，先 terminate 该 botId 的所有旧 ws，避免半开连接残留
- **协议级心跳**：server 每 45s 对 bot ws 发送 `ws.ping()`，结合 `bufferedAmount` 容错 + 连续 miss 计数（最大 4 次，~180s），检测并清理死连接
- **UI 侧不主动 ping**：server 不对 UI ws 做协议级心跳或主动断连。UI 客户端自行维护应用层心跳（25s ping / 45s 超时），半开连接由 UI 侧检测或用户刷新恢复。理由：避免大消息传输时误 terminate UI 连接，优先保证通信顺畅

---

## 5) Binding sequence (current)

```text
User(UI)        UI            Server                 Plugin(OpenClaw)
   |             |               |                           |
   | Add Bot     |               |                           |
   |-----------> | POST /binding-codes                       |
   |             |-------------->| create code               |
   |             |<--------------| code + expiresAt          |
   | see code    |               |                           |
   | run /coclaw bind <code> in OpenClaw                    |
   |             |               | <----------- POST /bind --|
   |             |               | verify code, issue token  |
   |             |               | ------------> DB update   |
   |             |               | -- botId+token ---------> |
   |             |               |                           | write local config
   |             |               |                           | start WS bridge
   | refresh     | GET /bots     |                           |
   |             |-------------->|                           |
   |             |<--------------| active bot status         |
```

---

## 6) Unbind auto-convergence sequence (current)

### A. User unbind from frontend (online case)

```text
User(UI)        UI               Server                     Plugin
   |             |                  |                           |
   | Unbind      | POST /unbind-by-user                         |
   |-----------> |----------------->| set inactive + rotate     |
   |             |                  | send WS: bot.unbound ---->|
   |             |                  | close WS (4001) --------->|
   |             |<-----------------| 200 inactive              |
   | sees done   |                  |                           | auto clear local token
```

### B. Bot was offline when unbound

```text
Server marks inactive + rotates token while bot offline
Plugin later reconnects with old token -> auth fails / closed -> local token cleared
```

---

## 7) UI session behavior (MVP)

- 会话列表：`nativeui.sessions.listAll`，当前前端按全量模式加载（不做分页交互）。
- 会话详情：`nativeui.sessions.get`，当前前端按全量模式加载（不做分页交互）。
- 续聊：`chat.send` 必须提供 `sessionKey`，因此仅 indexed session 可续聊；orphan session 默认只读。
- 路由约定：`/chat/:sessionId`（path 参数必填，不使用 query）。

---

## 8) Critical invariants

1. **Multi-bot by user**：同一 user 可绑定多条 Bot 记录。
2. **Token never stored in plaintext on server**：仅存 `SHA-256` hash (`BINARY(32)`)。
3. **Unbind/Rebind rotates token**：旧 token 立刻失效。
4. **No token, no server connection**：插件本地无 token 时，不主动建立 ws。

---

## 9) Practical troubleshooting checklist

1. DB 列类型是否正确：`Bot.tokenHash = BINARY(32)`。
2. UI 生成 code 后，OpenClaw bind 是否拿到 `botId + token`。
3. plugin 本地 config 是否写入 token。
4. ws 是否建立（有 token）并在解绑时收到 `bot.unbound` / `4001`。
5. 解绑后本地 token 是否自动清空。
