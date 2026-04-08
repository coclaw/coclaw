# @coclaw/server

CoClaw 后端服务 — 为 AI Agent 协作通讯平台提供 API、实时通信与数据持久化。

## 技术栈

- **运行时**: Node.js >= 20 (ESM)
- **Web 框架**: Express 5
- **认证**: Passport + express-session
- **ORM**: Prisma (MySQL)
- **实时通信**: WebSocket (ws) + SSE
- **校验**: Zod
- **单元测试**: Node.js 内置 test runner + c8 覆盖率
- **HTTP 测试**: supertest

## 开发命令

```bash
pnpm dev                      # 启动开发服务器 (nodemon 热重载)
pnpm start                    # 生产模式启动
pnpm check                    # 静态检查 (lint)
pnpm test                     # 单元测试 + 覆盖率 (90% 门槛)
pnpm verify                   # check + test
pnpm prisma:generate          # 生成 Prisma Client
pnpm prisma:migrate           # 创建新迁移
pnpm prisma:migrate:deploy    # 部署迁移 (生产)
pnpm prisma:studio            # Prisma 可视化管理
pnpm admin                    # CLI 管理工具 (用户管理)
pnpm account:create-test-local  # 创建测试账号
```

## 项目结构

```
server/
├── src/
│   ├── index.js              # 进程入口
│   ├── server.js             # HTTP 启动 + WS Hub 挂载
│   ├── app.js                # Express 应用工厂 (中间件、路由挂载)
│   ├── routes/               # 路由层 (*.route.js)
│   ├── services/             # 业务逻辑层 (*.svc.js)
│   ├── repos/                # 数据访问层 (*.repo.js)
│   ├── middlewares/          # Express 中间件
│   ├── validators/           # 输入校验
│   ├── config/               # 配置 (Passport 策略等)
│   ├── db/                   # Prisma 单例 + Session Store
│   ├── cli/                  # CLI 管理工具
│   ├── utils/                # 工具模块 (Snowflake ID、scrypt)
│   ├── claw-ws-hub.js        # Claw WebSocket 通信枢纽
│   ├── claw-status-sse.js    # Claw 在线状态 SSE 推送
│   ├── rtc-signal-hub.js     # WebRTC 信令服务
│   ├── rtc-signal-router.js  # RTC 连接路由表
│   ├── binding-wait-hub.js   # 用户发起绑定的长轮询枢纽
│   ├── claim-wait-hub.js     # Gateway 发起认领的长轮询枢纽
│   └── generated/            # Prisma Client 生成目录
├── prisma/
│   ├── schema.prisma         # 数据模型定义
│   └── migrations/           # 数据库迁移记录
├── scripts/                  # 辅助脚本
├── Dockerfile                # 多阶段 Docker 构建
├── entrypoint.sh             # 容器启动入口
└── .env.example              # 环境变量模板
```

## API 路由

所有 REST 接口前缀：`/api/v1`

| 路由文件 | 挂载路径 | 职责 |
|---------|---------|------|
| `info.route.js` | `/info` | 服务版本信息 |
| `auth.route.js` | `/auth` | 登录、注册、登出、会话检查 |
| `user.route.js` | `/user` | 用户资料与设置 |
| `claw-bot.route.js` | `/bots`, `/claws` | Claw 绑定/解绑、列表、重命名、SSE 状态、WS Ticket |
| `claw.route.js` | `/claws` | Claim Code 认领流程 (Gateway 发起) |
| `turn.route.js` | `/turn` | TURN 凭证生成 |
| `admin.route.js` | `/admin` | 管理员仪表盘 |

## 实时通信

| 模块 | 协议 | 职责 |
|------|------|------|
| `claw-ws-hub` | WebSocket | Claw 实例的持久连接管理、RPC 调用、上下线检测 |
| `claw-status-sse` | SSE | 向 UI 推送 Claw 在线/离线状态变更 |
| `rtc-signal-hub` | WebSocket | WebRTC 信令中转 (UI ↔ Claw) |
| `binding-wait-hub` | HTTP 长轮询 | 用户发起绑定码的结果等待 |
| `claim-wait-hub` | HTTP 长轮询 | Gateway 发起 Claim Code 的结果等待 |

## 数据模型

- **User** — 用户 (Snowflake ID, 角色等级)
- **LocalAuth** — 本地登录凭证 (loginName, scrypt 密码)
- **ExternalAuth** — 外部 OAuth 登录 (预留)
- **UserSetting** — 用户偏好设置
- **Claw** — 已绑定的 AI Agent 实例 (tokenHash 鉴权)
- **ClawBindingCode** — 用户发起的绑定码 (短时效)
- **ClawClaimCode** — Gateway 发起的认领码 (短时效)
- **ExpressSession** — 会话持久化

## 环境变量

参见 [.env.example](.env.example)，关键配置：

| 变量 | 说明 |
|------|------|
| `DB_URL` | MySQL 连接字符串 |
| `SHADOW_DB_URL` | Prisma 迁移 Shadow DB |
| `SESSION_SECRET` | Session 签名密钥 (生产必填) |
| `TURN_SECRET` | coturn HMAC 共享密钥 |
| `APP_DOMAIN` | 应用域名 |
| `ALLOWED_ORIGINS` | CORS 允许的 origin (逗号分隔) |
| `BINDING_CODE_EXPIRE_MINUTES` | 绑定码有效期 (默认 30 分钟) |
| `PORT` | 监听端口 (默认 3000) |
