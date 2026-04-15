---
"@coclaw/server": minor
---

server: admin dashboard 改造 + 实例/用户列表 + admin SSE

- `admin.repo.js` 新增 `countClawsCreatedSince` / `latestBoundClaws` / `listClawsPaginated` / `listUsersPaginated`（cursor 分页 + search）
- `admin-dashboard.svc.js` 改造返回结构：`claws` 新增 `todayNew`、新增 `latestBoundClaws`（在线标记）、`topActive/latestRegistered` 各 10 条、移除遗留 `bots` 别名
- `admin.route.js` 新增 `GET /admin/claws` / `/admin/users` / `/admin/stream`（均 `requireAdmin` 守门）
- 新增 `admin-sse.js`：admin 全局 SSE，转发 `clawStatusEmitter` 的 `status` / `infoUpdated` 为 `claw.statusChanged` / `claw.infoUpdated`
