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

```
server/
  src/
    routes/         # *.route.js
    services/       # *.svc.js，文件名后缀采用缩写
    repos/          # *.repo.js，目录和文件名后缀均采用缩写
		db/
		  prisma.js     # 单例文件，包括对可能的 prisma 扩展进行安装
			*.ext.js      # 可能的 prisma 扩展
		generated/
		  prisma/       # Prisma Client 生成目录
    middlewares/
    validators/
    config/
    app.js
    server.js
  prisma/
    schema.prisma
    migrations/
```

## 分层职责边界

- `*.route.js`：HTTP 入参与响应编排（可含轻量 handler），不写重业务规则
- `*.svc.js`：业务规则与流程编排
- `*.repo.js`：数据访问（Prisma 收口），避免在 route/svc 里散落 ORM 调用

## 技术栈

- Node.js + ESM（仅 `import/export`）
- Express + express-session + Passport
- Prisma + MySQL

## 其他约定

- REST API path 统一前缀：/api/v1
- 修订 prisma.schema 后，须用户确认后才能进行 migrate

## 单元测试覆盖率要求

server 工作区覆盖率门槛（90%）高于根 CLAUDE.md 基线，已固化在 `pnpm test` 命令中。
