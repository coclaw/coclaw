# CoClaw 后端 Server（MVC 简化版）

> 适用范围：`coclaw/server` 及其子目录。
> 本文件仅包含“相对 CoClaw 根 AGENTS.md 的增量规则”。

## 架构/设计模式（重要）

- 后端采用 **传统 MVC 的简化实现**，不采用 DDD 及其变体
- 与经典 MVC 的差异（按本项目约定）：
  - **不单设 controllers 目录**
  - 路由处理逻辑直接放在 `*.route.js` 中
  - 为便于单测，handler 函数应定义在 `router.<method>()` 旁边并可被测试代码直接引用

## 目录与命名约定

- 入口 `src/index.js`（dev/start 均由它启动）；`app.js` 装配 Express 应用，`server.js` 装配 HTTP/WS 服务
- `src/routes/` 放 `*.route.js`；`src/services/` 放 `*.svc.js`；`src/repos/` 放 `*.repo.js`（目录与文件名后缀均用缩写）
- `src/db/prisma.js` 是 Prisma 客户端单例（如未来引入 prisma 扩展也在此安装）；`src/generated/` 为 Prisma Client 生成目录（lint 已忽略）
- 其余按职责归入 `src/middlewares|validators|config|utils|cli`；SSE/WS hub 类模块平铺在 `src/` 根（如 `claw-ws-hub.js`、`rtc-signal-hub.js`）
- Prisma schema 与迁移在 `prisma/`（`schema.prisma`、`migrations/`）

## 分层职责边界

- `*.route.js`：HTTP 入参与响应编排（可含轻量 handler），不写重业务规则
- `*.svc.js`：业务规则与流程编排
- `*.repo.js`：数据访问（Prisma 收口），避免在 route/svc 里散落 ORM 调用

## 技术栈

- Node.js + ESM（仅 `import/export`）
- Express 5（与 Express 4 行为差异较大）+ express-session + Passport
- Prisma + MySQL；入参校验用 zod；WebSocket 用 ws

## 其他约定

- REST API path 统一前缀：/api/v1
- 修订 schema.prisma 后，须用户确认后才能进行 migrate

## 跑单测前置

`pnpm test` 不会像 `pnpm dev` 那样自动拉起 dev docker。前置：mysql 已起、迁移已应用（`pnpm prisma:migrate:deploy`）、当前 shell 已 `export DB_URL=...`——别靠改 `.env` 影响单测，`node --test` 不读它。
