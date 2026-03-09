# CoClaw Monorepo STATUS

Last updated: 2026-02-28 00:42 (Asia/Shanghai)

## 1) Project Snapshot

CoClaw 当前主线目标：
- 让用户在 CoClaw UI 中“添加机器人（OpenClaw 实例）”
- 通过 8 位绑定码完成 `UI -> Server -> OpenClaw tunnel plugin` 的绑定
- 打通解绑与凭证失效后的自动收敛

当前阶段：**单机器人 MVP（每用户 1 个 Bot 记录）**。

---

## 2) Core Architecture & Decisions (Current)

### 2.1 Binding model
- 用户在前端点击生成绑定码（8位十进制，短时有效）。
- OpenClaw 侧执行 `/coclaw bind <code> --name ...` 完成绑定。
- Server 返回 `botId + token`，tunnel 本地写入配置。

### 2.2 Single-bot MVP semantics
- 每个用户仅维护 1 个 Bot 记录。
- 重绑不新建 Bot：复用现有记录，更新 `name`，并 rotate token。

### 2.3 Token strategy
- `Bot.tokenHash` 使用 `SHA-256` 原始摘要，DB 类型为 `BINARY(32)`。
- 服务端不存明文 token。
- 解绑/重绑均触发 token rotate，旧 token 立即失效。

### 2.4 Unbind auto-convergence (important)
已从 watchdog 轮询改为事件驱动：
1. Server 支持 bot 实时通道：`WS /api/v1/bots/stream?token=...`
2. 前端解绑/服务端解绑/重绑时，Server 对在线 bot：
   - 下发 `bot.unbound` 控制消息
   - 主动断开连接（close code 4001/4003）
3. Tunnel 插件收到消息或断连码后自动清理本地 token。
4. **本地无 token 时不主动连接 server**（避免未绑定实例空转连接）。

### 2.5 Sessions via transparent RPC relay (current)
- UI 不直接持有 OpenClaw 凭据；先用登录态向 Server 申请一次性 ws ticket：`POST /api/v1/bots/ws-ticket`。
- UI 使用 `WS /api/v1/bots/stream?role=ui&ticket=...` 建立到 Server 的 rpc 通道。
- Server 将 UI 的 `rpc.req` 透明转发给已绑定 bot 的 tunnel 连接。
- Tunnel 仅做桥接：通过本机 gateway websocket 转发到 OpenClaw gateway，再把 `res/event` 回传给 Server/UI。
- 业务层 gateway 方法统一由 `session-manager` 插件提供（例如 `nativeui.sessions.listAll` / `nativeui.sessions.get`）。
- 当前 UI 路由：
  - 列表页：`/topics` + `MainList`
  - 聊天页：`/chat/:sessionId?`

---

## 3) Module Status

## 3.0 Deployment prep (server + ui)
已完成一轮“公网服务器到位前”部署前置工作（仅方案与本地可落实项）：
- 新增部署骨架目录：`deploy/`
  - `deploy/docker-compose.yaml`
  - `deploy/nginx/nginx.conf` + `deploy/nginx/conf.d/coclaw.conf` + `deploy/nginx/includes/*`
  - `deploy/env/*.example` + `deploy/.env.example`
  - `deploy/certbot/`（ACME webroot + cert storage 挂载点）
  - `deploy/static/{www,ui}/releases`（含 `current` 约定）
- server 镜像策略已落地：`server/Dockerfile`（multi-stage，`node:22-slim`，运行时含 `curl`，含 USTC apt mirror 配置）
- compose 已支持构建代理参数注入（HTTP/HTTPS/SOCKS5 via `i.coclaw.net`）
- app 域名已迁移至 `im.coclaw.net`


## 3.1 `server`
已完成：
- Bot APIs：
  - `GET /api/v1/bots`（登录态）
  - `POST /api/v1/bots/binding-codes`（登录态）
  - `POST /api/v1/bots/bind`
  - `POST /api/v1/bots/unbind`（Bearer token）
  - `POST /api/v1/bots/unbind-by-user`（登录态）
  - `GET /api/v1/bots/self`（Bearer token）
- 实时通道：`WS /api/v1/bots/stream?token=...`
- 在 `rebind/unbind` 时通知并断开在线 bot 连接。

数据库与迁移：
- `Bot.tokenHash` 已使用 `Binary(32)`（迁移需真实执行）。

## 3.2 `ui`
已完成：
- `/bots` 绑定管理页（单机器人 MVP）
  - 查看当前 bot 状态
  - 生成绑定码 + 倒计时
  - 展示 OpenClaw 侧绑定命令提示
- 绑定检测成功后自动提示并清空当前 code 区块。
- 支持前端发起解绑：`POST /api/v1/bots/unbind-by-user`
- 解绑成功文案已调整为“OpenClaw 侧自动清理”。
- `MainList` 已接入动态会话列表：通过 ws ticket + rpc 调 `nativeui.sessions.listAll`。
- `ChatPage` 已支持按 path session 打开：`/chat/:sessionId?`。
- `ChatPage` 已支持文本续聊：调用 `chat.send(sessionKey, message)`；发送后刷新会话消息。
- 当前会话列表/消息加载策略：**MVP 全量加载，不做分页交互**。

## 3.3 `plugins/openclaw`
已完成：
- 插件已合并为单项目（`transport + session-manager + common`）。
- 插件模式实时桥接：
  - 有 token 才连 `WS /api/v1/bots/stream`
  - 收到 `bot.unbound` 或 close(4001/4003) 自动清理本地 token
- RPC 透传桥接：
  - 收到 server `rpc.req` -> 转发到本机 gateway websocket
  - 收到 gateway `res/event` -> 回传为 `rpc.res/rpc.event`
- Gateway method 由同一插件提供：
  - `nativeui.sessions.listAll`
  - `nativeui.sessions.get`
- 保留手动 `/coclaw unbind` 兜底；若 server 已解绑导致 `UNAUTHORIZED`，仍会本地清理成功。

---

## 4) What to verify first when resuming

1. DB 结构是否与 Prisma schema 一致（特别是 `Bot.tokenHash = BINARY(32)`）。
2. 绑定闭环：UI 生成 code -> tunnel bind -> UI 状态更新。
3. 解绑闭环：UI unbind -> server 推送/断连 -> tunnel 自动清理 token。
4. “未绑定不连 server”是否生效（本地 config 无 token 时无 ws 连接）。
5. session 列表与会话消息是否可在 `/topics` -> `/chat/:sessionId` 链路正常显示与续聊。

---

## 5) Current Risks / Notes

- 若本地数据库未应用结构迁移，会出现 tokenHash 写入异常（历史已遇到）。
- 当前为单机器人 MVP；历史多机器人数据仅兼容展示，不作为主流程。
- 真实网关/消息中继能力仍处于“绑定链路优先”阶段，transport 后续继续完善。

---

## 6) Suggested Next Steps

1. 为 realtime bridge 增补更系统的测试（消息通知、断连重连、无 token 不连接）。
2. UI 增加更明确的 bot 在线/离线状态反馈（基于 lastSeen/连接态）。
3. 明确并文档化 close code/reason 约定（user_unbind / token_rotated / blocked）。
4. 在 docs 中补一页“绑定与解绑时序图”。
