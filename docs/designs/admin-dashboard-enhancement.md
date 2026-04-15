# 管理员仪表盘信息完善

> **状态**: 设计中
> **Issue**: #221
> **日期**: 2026-04-15

## 1. 背景与目标

当前管理员仪表盘仅展示用户维度统计（总用户数、今日新注册、今日活跃），与平台核心对象"实例（Claw）"脱节。目标：

1. 顶部统计卡片改为实例维度，用户统计降级到次要位置
2. 新增实例详情表（实例粒度行，可展开查看 agent × model 明细）
3. 新增完整可翻页/搜索的用户列表（含"绑定实例数"列）
4. 实例在线状态保持事件级实时性
5. 仪表盘做概览，完整列表拆到独立的「实例管理」「用户管理」子页

## 2. 设计决策

以下决策已通过 Issue #221 评论与 PM 对齐确认：

| 决策点 | 结论 | 依据 |
|---|---|---|
| 模型展示 | 实例粒度表格，展开行显示 agent × model 明细（默认收起） | PM 选 Q1-b 理解 B |
| 用户列表 | 完整可翻页/搜索 + "绑定实例数"列 | PM 选 Q2-B |
| 页面组织 | 仪表盘做概览 + 独立「实例管理」「用户管理」子页 | PM 选 Q3-B |
| OpenClaw 模型层级 | agent 级为主，claw 级有默认值可回退；plugin 调 `agents.list` RPC 采集 | OpenClaw 源码调研 |
| 模型变更事件 | OpenClaw 无专用模型事件；一期仅 bridge 启动时采集 | OpenClaw `GATEWAY_EVENTS` 无匹配 |
| 插件版本 | OpenClaw 不代查，plugin 自行上报 | 无 `plugins.list` RPC |

## 3. 数据模型变更

### 3.1 Prisma Schema — Claw 表新增字段

```prisma
model Claw {
	// ... existing fields ...
	hostName       String?   @db.VarChar(128)
	pluginVersion  String?   @db.VarChar(32)
	agentModels    Json?
}
```

`agentModels` JSON 结构：

```js
// null 表示 plugin 未上报（老版本 plugin 或尚未连接）
// [] 表示 claw 无 agent
[
	{ "id": "main", "name": "Main Agent", "model": "claude-opus-4" },
	{ "id": "project-a", "name": "Project A", "model": "claude-sonnet-4" }
]
```

其中 `model` 是 OpenClaw `resolveAgentEffectiveModelPrimary()` 后的有效主模型，已合并 claw 级默认。

### 3.2 `lastSeenAt` 修复

字段已存在但从未写入。在 `claw-ws-hub.js` 的 claw WebSocket 断开路径补写 `updateClaw(clawId, { lastSeenAt: new Date() })`。仅在 disconnect 时写一次，不在心跳中写，避免高频写库。

### 3.3 Migration 评估

- 纯 ADD COLUMN nullable，MySQL 在线 DDL 即时元数据变更，零停机
- 不修改/删除已有列，无数据迁移
- 向后兼容：老 plugin 不上报时新字段为 null，UI 展示 "—"

### 3.4 搜索性能说明

`GET /admin/claws` 和 `GET /admin/users` 的搜索使用 `LIKE '%keyword%'`（Prisma `contains`）。当前 Claw 和 User 表的 `name` 列均无独立索引，`LIKE '%keyword%'` 模式也无法利用 B-tree 索引。在预期规模（< 数千条记录）下，cursor 分页限定结果集 + 全扫 `name` 列的开销可接受。若规模超预期增长，可考虑前缀匹配（`startsWith`）或 MySQL FULLTEXT 索引。

## 4. Server API 设计

所有 admin 端点均受 `requireAdmin` 中间件保护（校验 `user.level === -100`）。

### 4.1 修改 `GET /api/v1/admin/dashboard`

返回结构：

```json
{
	"claws": { "total": 42, "online": 5, "todayNew": 2 },
	"users": { "total": 128, "todayNew": 3, "todayActive": 15 },
	"version": { "server": "0.12.14", "ui": "0.12.14", "plugin": null },
	"topActiveUsers": [{ "id": "...", "name": "...", "loginName": "...", "lastLoginAt": "..." }],
	"latestRegisteredUsers": [{ "id": "...", "name": "...", "loginName": "...", "createdAt": "..." }],
	"latestBoundClaws": [{ "id": "...", "name": "...", "userName": "...", "online": true, "createdAt": "..." }]
}
```

变更点：
- `claws` 新增 `todayNew`（`countClawsCreatedSince(todayStart)`）
- 新增 `latestBoundClaws` 短列表（最近 10 条绑定实例，含在线标记）
- `topActiveUsers` / `latestRegisteredUsers` 各缩减到 10 条（原分别 10 / 30）
- 移除遗留 `bots` 冗余字段（仅 service 层返回的 `claws` 的别名，UI 未引用 `bots`，移除无影响）

### 4.2 新增 `GET /api/v1/admin/claws`

分页实例列表，供实例管理页使用。

**查询参数**：

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `cursor` | string | — | 上一页最后一条的 id（Snowflake string） |
| `limit` | number | 50 | 每页条数，上限 100 |
| `search` | string | — | 按实例名称模糊搜索 |

**返回**：

```json
{
	"items": [
		{
			"id": "...",
			"name": "My Claw",
			"hostName": "ubuntu-server",
			"userId": "...",
			"userName": "Alice",
			"userLoginName": "alice",
			"online": true,
			"pluginVersion": "0.12.14",
			"agentModels": [{ "id": "main", "name": "Main", "model": "claude-opus-4" }],
			"createdAt": "2026-03-01T...",
			"lastSeenAt": "2026-04-10T..."
		}
	],
	"nextCursor": "..." 
}
```

`nextCursor` 为 null 表示无下一页。

**分页策略**：Snowflake ID 单调递增，`WHERE id < cursor ORDER BY id DESC LIMIT limit`。无 cursor 时取最新。

**online 标记**：service 层调用 `listOnlineClawIds()` 交叉标记，不在 DB 查询中。

**BigInt 序列化**：Snowflake ID 以 string 返回（与现有 `admin.repo.js` 一致）。

### 4.3 新增 `GET /api/v1/admin/users`

分页用户列表，供用户管理页使用。

**查询参数**：同 4.2（`cursor` / `limit` / `search`），search 按用户名或登录名模糊匹配。

**返回**：

```json
{
	"items": [
		{
			"id": "...",
			"name": "Alice",
			"loginName": "alice",
			"avatar": null,
			"clawCount": 2,
			"createdAt": "2026-02-01T...",
			"lastLoginAt": "2026-04-10T..."
		}
	],
	"nextCursor": "..."
}
```

`clawCount` 通过 Prisma `include: { _count: { select: { claws: true } } }` 获取。

### 4.4 新增 `GET /api/v1/admin/stream` (SSE)

Admin 专属 SSE 端点，提供实例在线状态的实时推送。

**事件类型**：

| 事件 | 触发时机 | data |
|---|---|---|
| `snapshot` | 连接建立时 | `{ onlineClawIds: string[] }` |
| `claw.statusChanged` | claw 上/下线 | `{ clawId: string, online: boolean }` |
| `claw.infoUpdated` | plugin 上报信息 | `{ clawId: string, name, hostName, pluginVersion, agentModels }` |

**实现**：新建独立模块 `server/src/admin-sse.js`（命名与现有基础设施模块 `claw-status-sse.js`、`claw-ws-hub.js` 一致，不属于 MVC 分层），不改动现有 `claw-status-sse.js`：

```
adminSseClients: Set<Response>

registerAdminSseClient(res):
  1. 设置 SSE headers
  2. 推送 snapshot（listOnlineClawIds()）
  3. 加入 adminSseClients
  4. res.on('close') 清理

clawStatusEmitter.on('status'):
  fan-out claw.statusChanged 到所有 admin clients

clawStatusEmitter.on('infoUpdated'):    // 新增事件类型
  fan-out claw.infoUpdated 到所有 admin clients
```

先 snapshot 再注册监听，保证快照→增量无缝衔接（与现有 `claw-status-sse.js` 同模式）。

### 4.5 `clawStatusEmitter` 事件变更

现有 `claw-ws-hub.js` 的 `coclaw.info.updated` 处理中，emit 事件名为 `nameUpdated`（`claw-status-sse.js:167` 监听）。本次将其**替换**为更通用的 `infoUpdated`：

```js
// 旧: clawStatusEmitter.emit('nameUpdated', { clawId, name });
// 新:
clawStatusEmitter.emit('infoUpdated', { clawId, name, hostName, pluginVersion, agentModels });
```

同步修改 `claw-status-sse.js:167` 的监听：`'nameUpdated'` → `'infoUpdated'`。该 handler 内部仅使用 `{ clawId, name }`，忽略其余字段即可，行为不变。

## 5. Plugin 变更

### 5.1 扩展 `coclaw.info.updated` payload

`realtime-bridge.js` 的 `__pushInstanceName()` 方法改名为 `__pushInstanceInfo()` 并扩展：

```js
async __pushInstanceInfo() {
	const settings = await readSettings();
	const name = settings.name ?? null;
	const hostName = getHostName();
	const pluginVersion = await getPluginVersion();
	const agentModels = await this.__collectAgentModels();
	broadcastPluginEvent('coclaw.info.updated', {
		name, hostName, pluginVersion, agentModels,
	});
}
```

### 5.2 Agent 模型采集

新增 `__collectAgentModels()` 方法：

```js
async __collectAgentModels() {
	try {
		const result = await this.__gatewayRpc('agents.list', {});
		return (result.agents || []).map(a => ({
			id: a.id,
			name: a.name ?? a.id,
			model: a.model?.primary ?? null,
		}));
	} catch {
		return null; // 采集失败不阻塞主流程
	}
}
```

**触发时机**：bridge 连接成功后调用（现有 `__pushInstanceName` 的调用点）。采集失败时 `agentModels` 为 null，不影响其他字段上报。

**一期不做**：`sessions.changed` 事件订阅 + 节流重采。原因：OpenClaw 配置级模型变更无推送事件，仅 session 级状态变更有事件，cost/benefit 不高。

### 5.3 pluginVersion 来源

已有 `plugin-version.js` 的 `getPluginVersion()` 方法（延迟读取 `package.json` 并缓存），直接使用。

## 6. UI 设计

### 6.1 页面结构与路由

| 页面 | 路由 | 组件 | meta |
|---|---|---|---|
| 仪表盘 | `/admin/dashboard` | `AdminDashboardPage.vue` (改造) | `requiresAuth, hideMobileNav` |
| 实例管理 | `/admin/claws` | `AdminClawsPage.vue` (新建) | `requiresAuth, hideMobileNav` |
| 用户管理 | `/admin/users` | `AdminUsersPage.vue` (新建) | `requiresAuth, hideMobileNav` |

### 6.2 Admin 页面间导航

桌面端：三个页面顶部共享 admin 导航 tab（仪表盘 / 实例管理 / 用户管理），使用 `UTabs` 的路由导航模式。`hidden md:flex`。

移动端：每个页面使用 `MobilePageHeader` 提供返回按钮。页面间通过仪表盘的"查看全部"链接或 MobilePageHeader 返回进行导航。

### 6.3 AdminDashboardPage 改造

**顶部卡片（Primary, grid-cols-3）**：
- 绑定实例总数
- 当前在线实例
- 今日新绑定

**次级卡片（grid-cols-3）**：
- 用户总数
- 今日新注册
- 今日活跃

**摘要列表（各 10 条，带"查看全部 →"链接）**：
- 最近绑定实例（名称 / 所属用户 / 在线状态 / 绑定时间）
- 最近活跃用户（名称 / 登录名 / 最近登录）
- 最新注册用户（名称 / 登录名 / 注册时间）

**数据刷新**：沿用现有 pull-on-mount + visibilitychange 机制（无 SSE）。仪表盘是概览页，聚合数字秒级延迟可接受。

### 6.4 AdminClawsPage

**表格列**：

| 列 | 字段 | 说明 |
|---|---|---|
| 实例名称 | `name` | 无名称时显示 hostName |
| 在线状态 | `online` | 绿/灰圆点 + 文字 |
| 所属用户 | `userName` / `userLoginName` | |
| 插件版本 | `pluginVersion` | null 时显示 "—" |
| 绑定时间 | `createdAt` | `formatTimeAgo` |

**展开行**（UTable `#expanded` slot）：

展示该实例的 agent × model 列表。`agentModels` 为 null 时提示"信息暂不可用"；为空数组时提示"无 agent"。

```
┌─ Agent 名称 ────────┬─ 当前模型 ──────────┐
│ Main Agent           │ claude-opus-4       │
│ Project A            │ claude-sonnet-4     │
└──────────────────────┴─────────────────────┘
```

**搜索**：顶部 `UInput` 搜索框，按实例名称过滤，去抖 300ms。搜索条件变化时自动调用 `resetClaws()` 清空已加载数据并重置 cursor，再重新 fetch。

**分页**：底部"加载更多"按钮（cursor 分页适配），非传统翻页。

**实时更新**：
- mount 时连接 `GET /api/v1/admin/stream` SSE
- `snapshot` → 标记初始在线集合
- `claw.statusChanged` → 更新 store 中对应 claw 的 `online` 字段
- `claw.infoUpdated` → 更新 store 中对应 claw 的 `pluginVersion` / `agentModels`
- unmount 时断开 SSE（`EventSource.close()`）

**移动端**：表格在 `< md` 断点降级为卡片列表；展开改为 accordion 交互。

### 6.5 AdminUsersPage

**表格列**：

| 列 | 字段 | 说明 |
|---|---|---|
| 用户名 | `name` | |
| 登录名 | `loginName` | |
| 绑定实例数 | `clawCount` | |
| 注册时间 | `createdAt` | `formatTimeAgo` |
| 最近登录 | `lastLoginAt` | `formatTimeAgo`，null 时 "—" |

**搜索**：按用户名或登录名，搜索变化时同样重置 cursor。**分页**：同 AdminClawsPage。**移动端**：卡片列表。

无 SSE（用户列表无实时需求）。

### 6.6 Pinia Store

新建 `ui/src/stores/admin.store.js`：

```
state:
  dashboard: null
  claws: { items: [], nextCursor: null, loading: false }
  users: { items: [], nextCursor: null, loading: false }

actions:
  fetchDashboard()
  fetchClaws({ cursor?, search? })
  fetchMoreClaws()
  resetClaws()
  fetchUsers({ cursor?, search? })
  fetchMoreUsers()
  resetUsers()
  updateClawStatus(clawId, online)
  updateClawInfo(clawId, { pluginVersion, agentModels, ... })
```

`updateClawStatus` / `updateClawInfo` 由 SSE 事件回调触发，直接修改 `claws.items` 中对应条目。

### 6.7 SSE 客户端

新建 `ui/src/services/admin-stream.js`：

```js
export function connectAdminStream({ onSnapshot, onStatusChanged, onInfoUpdated })
// 返回 { close() } 对象
// 内部用 EventSource，自动重连
```

AdminClawsPage 在 Options API 的 `mounted()` 中调用，`beforeUnmount()` 中 close。

### 6.8 组件风格约束

所有新建 Vue 组件必须使用 **Options API** 风格（`export default { ... }`），禁止 `<script setup>` 和 Composition API 风格。事件监听/断开放在 `mounted()` / `beforeUnmount()` 生命周期钩子中。

### 6.9 i18n

**前缀迁移**：现有 admin 相关 key 使用 `adminDashboard.*` 前缀（如 `adminDashboard.title`）。本次统一迁移到 `admin.*` 命名空间（`admin.dashboard.*`、`admin.claws.*`、`admin.users.*`），使三个子页的 key 组织更清晰。

迁移影响：
- `AdminDashboardPage.vue` 中 14 处 `$t('adminDashboard.*')` 引用需更新
- 菜单入口 `user.adminDashboard`（`en.js:69` 等）保留不动（不属于页面内 key）
- 旧 `adminDashboard.*` key 从 locale 文件中移除

新增 key 覆盖全部 12 个 locale 文件（`en / zh-CN / zh-TW / de / es / fr / hi / ja / ko / pt / ru / vi`）。

Key 分组：
- `admin.nav.dashboard / claws / users`
- `admin.dashboard.title / totalClaws / onlineClaws / todayNewClaws / totalUsers / todayNewUsers / todayActiveUsers / ...`
- `admin.claws.title / searchPlaceholder / columnName / columnStatus / columnUser / columnVersion / columnCreatedAt / expandAgentName / expandModel / noAgentModels / ...`
- `admin.users.title / searchPlaceholder / columnName / columnLoginName / columnClawCount / columnCreatedAt / columnLastLogin / ...`
- `admin.common.loadMore / noData / online / offline / viewAll / ...`

## 7. 分阶段实施

| 阶段 | 内容 | 涉及端 | 规模 | 前置 |
|---|---|---|---|---|
| 1 | Prisma 加字段 + migration；`lastSeenAt` 写入修复 | server | S | 无 |
| 2 | Plugin 扩展 `coclaw.info.updated` payload（pluginVersion + agentModels） | plugin | S | 无 |
| 3a | Server dashboard API 改造 + admin.repo 新增方法 | server | S | 阶段 1 |
| 3b | Server 新增 claws/users 分页列表 API + admin SSE | server | M | 阶段 1 |
| 4a | UI 仪表盘改造 + admin store + admin 导航 tab | ui | M | 阶段 3a |
| 4b | UI 实例管理页（含 SSE 订阅、展开行） | ui | M | 阶段 3b |
| 4c | UI 用户管理页 | ui | M | 阶段 3b |
| 4d | i18n 全语言覆盖 | ui | S | 阶段 4a-4c |

阶段 1 和 2 可并行。阶段 3a 和 3b 可并行。阶段 4a-4c 可并行（共用 store 但各自独立页面），4d 收尾。

## 8. 测试策略

各端覆盖率门禁按项目规范执行：

| 端 | 门禁 | 新增测试范围 |
|---|---|---|
| server | ≥ 90% | `admin.repo.js` 新方法、`admin-dashboard.svc.js` 改造、`admin.route.js` 新路由 handler、`admin-sse.js` 注册/推送/清理 |
| plugin | lines/func/stmt 100%, branches 95% | `__collectAgentModels` 方法、`__pushInstanceInfo` 扩展、`broadcastPluginEvent` payload 变更 |
| ui | branches ≥ 90%, 其余 ≥ 95% | `admin.store.js` 全 action、`AdminDashboardPage` 改造、`AdminClawsPage`（含展开行、SSE mock）、`AdminUsersPage`、`admin-stream.js` |

## 9. 不在本次范围内

| 项目 | 原因 |
|---|---|
| `claw.bound` / `claw.unbound` SSE 事件 | 增量收益低，新绑定/解绑频率低，刷新列表即可 |
| 模型切换实时推送 | OpenClaw 无 `models.changed` 事件，实现需轮询，成本高 |
| 表格多列排序 / 筛选 / CSV 导出 | 可后续迭代 |
| 用户 ↔ 实例交叉导航（点击跳转） | 可后续迭代 |

## 9. 关键文件索引

### 需要修改

| 文件 | 变更 |
|---|---|
| `server/prisma/schema.prisma` | Claw 表加 3 字段 |
| `server/src/claw-ws-hub.js` | info.updated 处理扩展 + lastSeenAt 写入 + emit infoUpdated（替换 nameUpdated） |
| `server/src/claw-status-sse.js` | 监听事件名 `nameUpdated` → `infoUpdated`（handler 逻辑不变） |
| `server/src/routes/admin.route.js` | 新增 3 个路由 |
| `server/src/services/admin-dashboard.svc.js` | dashboard 返回结构调整 |
| `server/src/repos/admin.repo.js` | 新增列表/计数方法 |
| `plugins/openclaw/src/realtime-bridge.js` | 扩展 __pushInstanceName → __pushInstanceInfo |
| `ui/src/views/AdminDashboardPage.vue` | 改造为概览 |
| `ui/src/services/admin.api.js` | 新增 3 个 API 方法 |
| `ui/src/router/index.js` | 新增 2 个 admin 路由 |
| `ui/src/i18n/locales/*.js` | 新增 admin key（12 个文件） |

### 需要新建

| 文件 | 用途 |
|---|---|
| `server/src/admin-sse.js` | Admin SSE 推送模块 |
| `ui/src/views/AdminClawsPage.vue` | 实例管理页 |
| `ui/src/views/AdminUsersPage.vue` | 用户管理页 |
| `ui/src/stores/admin.store.js` | Admin Pinia store |
| `ui/src/services/admin-stream.js` | Admin SSE 客户端 |
