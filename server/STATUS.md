# Server STATUS

## 2026-03-11
- **v0.2 整改 Stage 1（Server 适配）**：
  - WS 升级认证新增 session cookie 方式（UI 侧优先 cookie，ticket 兜底）
  - `app.js` 导出 `sessionMiddleware` 供 WS upgrade 使用
  - `bot-ws-hub.js` 新增 `authenticateUiSession(req)` — 在 WS upgrade 时运行 express-session 中间件解析 cookie
  - `bot-ws-hub.js` 新增 bot 侧 WS 协议级心跳（30s ping/pong，与 UI 侧对称）
  - `bot-ws-hub.js` 新增应用层 ping/pong：bot 发送 `{ type: "ping" }` 时直接回 `{ type: "pong" }`，不转发给 UI
  - UI 侧应用层 ping/pong 同理（已有）
  - check + test 通过（93 tests）；coverage 未通过（pre-existing，`bot-ws-hub.js` 无专用单测）

## 2026-02-28
- 绑定阶段命名语义收敛：
  - `POST /api/v1/bots/bind` 不再在路由层阻塞等待 `refreshBotName(..., timeout=9000)`。
  - bind 响应中的 `bot.name` 直接使用 `bindBot` 结果值（可为 `null`）。
- `bindBot` 输入校验调整：
  - `code` 必填；`name` 改为可选。
  - 插件侧未传 `name` 时，server 按 `null` 存储/返回，由 UI 执行 fallback 渲染。

## 2026-02-27
- 解绑流程调整为“先删记录，再踢连接”：
  - `unbindBotByUser` / `unbindBotByToken` 由 `inactive + token rotate` 改为直接删除 Bot 记录
  - 删除成功后由路由层调用 `notifyAndDisconnectBot(...)` 强制断开现有 ws 连接
  - 目标是避免“先踢后删”窗口内 bot 快速重连成功的竞态
- Prisma 模型同步收敛（仅改 schema，未执行 migrate）：
  - `Bot.name` 调整为可选字段 `String?`
  - `Bot.status` 在 `schema.prisma` 中改为注释（字段保留语义说明，不再作为当前实现依据）
- 代码侧同步移除对 `Bot.status` 的在线/鉴权依赖：
  - `list/getSelf/ws-ticket/ws-auth` 等路径不再读取或判断 `status`
  - 在线状态改为以内存 ws 连接池为准
- 已清理开发库历史解绑数据：按 `status = inactive` 删除 Bot 记录，共清理 3 条。
- 已执行 Prisma migrate（开发库）：
  - 迁移名：`20260227072823_bot_name_optional_drop_status`
  - 结果：`bot.status` 列已从开发库移除，`Bot.name` 调整为可空并已同步 Prisma Client
- `GET /api/v1/bots` 返回新增 `online` 字段：
  - 由 server 内存 ws 连接池实时计算（`bot-ws-hub`）
  - 不落库，不依赖 `lastSeenAt`
- 新增绑定等待链路（替代前端短周期轮询 bot 列表）：
  - `POST /api/v1/bots/binding-codes` 现在返回 `waitToken`
  - 新增 `POST /api/v1/bots/binding-codes/wait`（单次最长等待约 25s，可由前端循环调用至 code 过期）
  - bind 成功后 server 立即唤醒等待请求并返回 `BINDING_SUCCESS`
  - 客户端取消等待请求时，server 会尝试取消该 wait 并废弃未消费的 binding code（已绑定成功的临界情况按成功处理）
- 解除“单用户仅一个 Bot”实现限制：`bindBot` 绑定时不再复用 latest 记录，改为每次绑定创建新 Bot 记录（DB 原有模型已支持 1:N）。
- `POST /api/v1/bots/unbind-by-user` 语义调整为“按 botId 定向解绑”：
  - 请求体需提供 `botId`
  - 服务端校验 bot 归属当前 user 后执行 `inactive + token rotate`
- `POST /api/v1/bots/ws-ticket` 新增可选 `botId` 参数：
  - 传入时按指定 bot 建立 UI ticket（校验归属 + active）
  - 不传时保持向后兼容（fallback 到 latest active）
- 单测更新：`src/services/bot-binding.svc.test.js`（覆盖多 bot 绑定创建与按 botId 解绑）。

## 2026-02-23
- 新增部署环境适配（dev/prod 行为分离）：
  - `src/app.js` 在 `production` 下启用 `app.set('trust proxy', 1)`，匹配 Nginx 反代场景
  - 新增生产态 `SESSION_SECRET` 防呆：仍为默认值时直接抛错，避免弱配置上线
  - 新增可配置 HTTPS 防护开关（默认生产开启，`ENFORCE_HTTPS !== false`）：
    - 非 HTTPS 请求返回 `426 HTTPS_REQUIRED`
    - `GET /healthz` 放行（避免健康检查被误伤）
- 新增环境适配回归测试：`src/app.env-adaptation.test.js`
  - 覆盖 production 默认 secret 拦截
  - 覆盖 HTTPS guard（含 `/healthz` 放行、非 HTTPS 拒绝、反代 `X-Forwarded-Proto=https` 放行）
  - 覆盖 development 默认不强制 HTTPS
- `.env.example` 新增 `ENFORCE_HTTPS` 说明（生产默认 true，可显式设为 false 仅用于特殊排障）
- 已验证：`pnpm --filter @coclaw/server test` 全部通过。
- 继续完善 UI 会话接入链路（透明转发方案）：
  - `WS /api/v1/bots/stream` 现支持 UI 侧 `role=ui + ticket` 连接。
  - 新增 `POST /api/v1/bots/ws-ticket`，用于登录态申请一次性 ws ticket。
  - server 可在 UI <-> bot 之间透传 `rpc.req/rpc.res/rpc.event`。
- 维持控制面职责：`bot.unbound` 通知 + 强制断连，用于解绑/重绑自动收敛。

## 2026-02-22
- 新增“前端发起解绑”接口：`POST /api/v1/bots/unbind-by-user`（需登录）
  - 由用户会话直接解绑当前用户最新 Bot（置 `inactive` + rotate tokenHash）
- 新增 bot 自检接口：`GET /api/v1/bots/self`（Bearer token）
- 新增 bot 实时连接通道：`WS /api/v1/bots/stream`
  - bot 侧：`?token=...` 鉴权且要求 bot 处于 `active`
  - UI 侧：`?role=ui&ticket=...`（ticket 通过登录态接口申请）
  - 支持 server 在 UI <-> bot 之间透传 `rpc.req/rpc.res/rpc.event` 消息
  - 支持 server 侧向 bot 下发 `bot.unbound` 控制消息并主动断开连接
- 新增 UI ws ticket 接口：`POST /api/v1/bots/ws-ticket`（登录态，绑定且 active 时返回 ticket）
- `unbind-by-user` / `unbind` / `rebind` 场景会触发对应 bot 连接的通知+断连，保障在线实例即时收敛
- 绑定语义已调整为“单机器人 MVP”：`bindBot` 不再按 `userId + name` 查找，而是按 `userId` 复用最新 Bot 记录。
  - 二次绑定时复用原 Bot，更新 `name`，并 rotate `tokenHash`。
  - 新增仓储方法：`findLatestBotByUserId`。
  - 更新单测：`src/services/bot-binding.svc.test.js`（断言重绑时会覆盖名称）。
- Bot token 认证已从 `scrypt` 字符串改为 `SHA-256` 原始摘要（二进制 32 字节）：
  - `prisma/schema.prisma` 中 `Bot.tokenHash` 已改为 `Bytes @db.Binary(32) @unique`
  - `src/services/bot-binding.svc.js` 改为使用 `@paralleldrive/cuid2` 生成 token，并以 `crypto.createHash('sha256')` 计算 hash
  - 解绑校验改为按 `tokenHash` 直接查库，不再全表遍历校验
- 新增迁移：`prisma/migrations/20260222091500_bot_tokenhash_sha256_binary/migration.sql`
  - 当前按开发阶段策略，仅进行表结构迁移，不处理旧 `tokenHash` 字符串数据
- 用户自身资源路由已统一为无 `me` 版本：
  - `GET /api/v1/user`
  - `PATCH /api/v1/user`（支持更新 `User.name`、`User.avatar`）
  - `GET /api/v1/user/settings`
  - `PATCH /api/v1/user/settings`
- 已移除旧路径：
  - `GET /api/v1/user/me`
  - `PATCH /api/v1/user/me`
  - `PATCH /api/v1/user/me/settings`
- `GET /api/v1/auth/session` 的废弃指向已改为 `GET /api/v1/user`。
- 新增/更新单测：`src/routes/user.route.test.js`
  - 新增 `getCurrentUserSettingsHandler` 测试
  - 路由注册断言更新为 `/` 与 `/settings`，并断言不存在 `/me`

## 2026-02-19
- 新增 Bot 绑定相关路由：`src/routes/bot.route.js`
  - `GET /api/v1/bots`（需登录）
  - `POST /api/v1/bots/binding-codes`（需登录）
  - `POST /api/v1/bots/bind`
  - `POST /api/v1/bots/unbind`（Bearer Token）
- 新增绑定服务：`src/services/bot-binding.svc.js`
  - 生成 8 位 Binding Code（5 分钟有效）
  - 绑定时支持同名 Bot 重绑并 rotate token
  - 解绑时置 `status=inactive` 并 rotate tokenHash
  - `blocked` 状态按拒绝策略处理
- 新增数据访问层：
  - `src/repos/bot.repo.js`
  - `src/repos/bot-binding-code.repo.js`
- `src/app.js` 已挂载 `/api/v1/bots`。
- 新增单测：
  - `src/services/bot-binding.svc.test.js`
  - `src/routes/bot.route.test.js`

## 2026-02-16
- 新增测试账号创建脚本：`scripts/create-test-local-account.js`。
  - 默认创建本地账号：`loginName=test`、`password=123456`
  - 命令：`pnpm account:create-test-local`
  - 具备幂等行为：账号已存在时仅输出提示，不重复创建。
- `GET /api/v1/auth/session` 行为调整：未登录时返回 `200` + `{ user: null }`，不再返回 401，便于前端统一处理会话态。
- 新增路由单测：`src/routes/auth.route.test.js`（覆盖 `getCurrentSessionHandler` 的登录/未登录返回）。
- 新增系统级联调测试：`src/routes/auth.e2e.test.js`
  - 覆盖链路：`session(未登录) -> login -> session(已登录) -> logout -> session(未登录)`
  - 使用 `supertest` 维护会话 Cookie，确保可直接支撑前端联调。
- 新增本地认证（当前仅支持 `loginName + password`）：
  - 路由：`POST /api/v1/auth/local/login`
  - 会话：接入 `express-session + passport + passport-local`
  - 暂不支持其他本地标识（email/phone/workId）与 OAuth 登录
- 新增认证模块分层实现：
  - `src/routes/auth.route.js`
  - `src/services/local-auth.svc.js`
  - `src/services/id.svc.js`
  - `src/repos/local-auth.repo.js`
  - `src/repos/user.repo.js`
  - `src/config/passport.js`
  - `src/app.js`、`src/server.js`、`src/index.js`
- 本地密码校验使用 `src/utils/scrypt-password.js`；登录成功后更新 `User.lastLoginAt` 与 `LocalAuth.lastLoginAt`。
- 用户 ID 生成器已按当前约束落地：`src/services/id.svc.js`（对外暴露 `genUserId()`，隐藏 Snowflake 实例）
  - `workerBits = 0`
  - `workerId = 0`
  - `seqRandomBits = 10`
  - `seqBits` 与其余选项保持 `Snowflake` 默认值
- 新增单测：`src/services/local-auth.svc.test.js`（覆盖认证与账号创建关键路径）
- `local-auth.svc` 采用散装函数导出：`loginByLoginName`、`createLocalAccount`；不再暴露工厂函数。
- 评估了 generator provider `prisma-client`（目标：更友好的 ESM 打包）。在当前 `prisma@6.19.0` + JavaScript 项目下不适配：
  - 默认产物为 `*.ts`
  - 即便强制文件扩展名为 `.js`，生成内容仍包含 `export type` 等 TS 语法，Node 运行时报错
- 结论：当前保持 `provider = "prisma-client-js"`；待后续升级 Prisma 7 并明确配套迁移方案后再切换。
- 备注：Node.js 项目本身可以支持 TS 代码（例如通过 `tsx`/`ts-node` 运行时或构建链路转译），当前问题是本仓库尚未引入对应运行/构建配置；后续可在统一技术方案下再推进。
- 为避免 `prisma migrate dev` 进入“输入 migration 名称”的交互，新增脚本 `scripts/prisma-migrate-dev.js`，`prisma:migrate` 已切换为非交互封装：
  - 显式传名：`pnpm prisma:migrate -- --name <migration_name>`
  - 未传名：自动使用 `migration_YYYYMMDD_HHMMSS`
- 已生成并应用首个迁移：`prisma/migrations/20260216144941_init_auth_tables/migration.sql`（`User` / `LocalAuth` / `ExternalAuth` 三表 + 外键/索引）。
- 为 `prisma migrate dev` 增加 shadow 库配置：`datasource db.shadowDatabaseUrl = env("SHADOW_DB_URL")`；本地开发使用 `coclaw_shadow`。
- 鉴于登录时间语义，已将 `User.lastLoginAt` 与 `ExternalAuth.lastLoginAt` 调整为可选 `DateTime?`，并移除 `@updatedAt`（仅在登录成功时由应用层显式更新）。
- `ExternalAuth` 的唯一键当前保持 `@@unique([oauthType, oauthId])`（满足现阶段 1:1 认证实现）。
- 已记录后续事项：若扩展到同 provider 多 app 或 1:N 账号绑定，需评估并升级唯一约束策略（如纳入 `oauthAppId`）。
- 新增 Prisma 基础环境：
  - 依赖：`prisma@6.19.0`、`@prisma/client@6.19.0`
  - Schema：`prisma/schema.prisma`（`mysql` + `DB_URL`，暂不定义 model）
  - Prisma Client 生成目录：`src/generated/prisma`
  - Prisma 单例：`src/db/prisma.js`
  - 环境变量示例：`.env.example`（`DB_URL`）
- 新增 Prisma 常用脚本：
  - `pnpm prisma:format`
  - `pnpm prisma:validate`
  - `pnpm prisma:generate`
  - `pnpm prisma:migrate`
  - `pnpm prisma:migrate:deploy`
  - `pnpm prisma:studio`
- 补齐 server 技术栈依赖：
  - Web/API：`express`、`cors`、`helmet`、`morgan`
  - Session/Auth：`express-session`、`passport`、`passport-local`
  - Infra：`dotenv`、`axios`、`zod`
- package 脚本与配置增强：
  - 新增 `engines.node >= 20`
  - 新增 `start`、`check`、`verify`
  - `dev` 切换为 `nodemon` + `NODE_ENV=development`
- VSCode Prisma 扩展兼容设置：
  - `.vscode/settings.json` 设置 `prisma.pinToPrisma6 = true`（避免 v7 LSP 对 v6 schema 产生误报）

## 2026-02-15
- 本地开发 MySQL 容器已建立（Docker Compose）。
- Compose 文件：`../infra/docker/docker-compose.dev.yaml`
- 容器名：`coclaw-mysql`
- 镜像：`mysql:8.0.36-bookworm`
- 端口：`3306:3306`
- 数据卷：`coclaw_mysql_data`
- 环境变量示例：`../infra/docker/.env.mysql.dev.example`
- 新增基础设施模块：`src/utils/snowflake.js`（Snowflake ID 生成器）。
- 支持能力：自定义 epoch、worker/seq 位数、`ms|s` 时间单位、随机 seq 起始（默认开启）、时钟回拨直接抛错。
- 提供接口：实例方法 `nextId()`；静态标准实例 `Snowflake.standard` 与静态方法 `Snowflake.genId()`。
- 单测：`src/utils/snowflake.test.js`，覆盖随机回滚、防重、溢出等待、回拨异常与参数校验等路径，`snowflake.js` 覆盖率 100%（lines/functions/branches/statements）。

启动命令：
```bash
docker compose --env-file infra/docker/.env.mysql.dev -f infra/docker/docker-compose.dev.yaml up -d mysql
```
