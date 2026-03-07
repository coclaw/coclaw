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

## 4) Binding sequence (current)

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

## 5) Unbind auto-convergence sequence (current)

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

## 6) UI session behavior (MVP)

- 会话列表：`nativeui.sessions.listAll`，当前前端按全量模式加载（不做分页交互）。
- 会话详情：`nativeui.sessions.get`，当前前端按全量模式加载（不做分页交互）。
- 续聊：`chat.send` 必须提供 `sessionKey`，因此仅 indexed session 可续聊；orphan session 默认只读。
- 路由约定：`/chat/:sessionId`（path 参数必填，不使用 query）。

---

## 7) Critical invariants

1. **Multi-bot by user**：同一 user 可绑定多条 Bot 记录。
2. **Token never stored in plaintext on server**：仅存 `SHA-256` hash (`BINARY(32)`)。
3. **Unbind/Rebind rotates token**：旧 token 立刻失效。
4. **No token, no server connection**：插件本地无 token 时，不主动建立 ws。

---

## 8) Practical troubleshooting checklist

1. DB 列类型是否正确：`Bot.tokenHash = BINARY(32)`。
2. UI 生成 code 后，OpenClaw bind 是否拿到 `botId + token`。
3. plugin 本地 config 是否写入 token。
4. ws 是否建立（有 token）并在解绑时收到 `bot.unbound` / `4001`。
5. 解绑后本地 token 是否自动清空。
