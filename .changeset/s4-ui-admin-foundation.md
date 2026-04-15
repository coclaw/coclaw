---
"@coclaw/ui": minor
---

ui: admin 基础设施 + 仪表盘改造（实例维度 + 导航 tab）

- 仪表盘顶部三卡片改为实例维度（总数/在线/今日新增），用户卡片降级到次级位置
- 新增三条摘要列表（最近绑定实例 / 最近活跃用户 / 最新注册用户），每条带"查看全部 →"链接
- 新增 `admin.store.js`（dashboard/claws/users 三块 state + 全部 actions 含 SSE 事件应用）
- 新增 `admin-stream.js` SSE 客户端（心跳超时自动重连，响应 app:foreground / network:online）
- `admin.api.js` 新增 `fetchAdminClaws` / `fetchAdminUsers` / `adminStreamUrl`
- 新增桌面端 `AdminNavTabs` 组件（仪表盘 / 实例管理 / 用户管理）
- 新增 `/admin/claws` 和 `/admin/users` 路由（含 placeholder 页面，S5/S6 填充）
- i18n 从 `adminDashboard.*` 整体迁移到 `admin.{nav,common,dashboard,claws,users}.*`，12 语言同步（保留 `user.adminDashboard` 菜单入口 key）
