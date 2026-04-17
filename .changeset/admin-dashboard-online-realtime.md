---
'@coclaw/server': minor
'@coclaw/ui': minor
---

admin Dashboard 在线实例数实时化 —— SSE 作为在线状态的唯一事实源，消除 Dashboard 页与 Claws 列表页之间的不一致。

- **server（API 响应结构调整）**：`GET /api/v1/admin/dashboard` 响应移除两个字段：`claws.online`（聚合在线数）与 `latestBoundClaws[].online`（每条布尔）。在线状态改由 `GET /api/v1/admin/stream`（已具备 `requireAdmin` 校验）独立提供。`/api/v1/admin/claws` 列表的 online 字段保留以作为 HTTP 首屏填充。旧版 UI 客户端访问新 server 时，Dashboard 在线数大卡片会显示空白而非数字，但不会崩溃。
- **ui**：SSE 订阅从页面组件上移到 Pinia `admin` store（引用计数），新增 `onlineClawIds: Set<string>`、`hasOnlineSnapshot`、`onlineClawCount`、`isClawOnline(id)`；连接生命周期由新建的 `AdminLayout` 父路由薄壳在 `/admin/*` 挂载/卸载时自动启停。Dashboard 大卡片在 SSE snapshot 到达前显示 `—` 占位符，snapshot 到达后切换为实时数字；Top 10 绿点改读 store 派生值。AdminClawsPage 不再直接订阅 SSE。
- **ui（权限守卫加固）**：路由 `beforeEach` 新增 `requiresAdmin` meta 校验，非 admin 用户访问 `/admin/*` 直接重定向到 `/home`，避免 AdminLayout 挂载后对 `/admin/stream` 发起无授权的 EventSource 握手。
- **ui（SSE 握手熔断）**：`admin-stream.js` 在从未 `onopen` 成功的情况下连续 3 次 `onerror` 则停止重连，避免非授权环境下的死循环。握手成功后错误不计入熔断计数。
- 保活机制不变（server 30s heartbeat / client 65s timeout）。
