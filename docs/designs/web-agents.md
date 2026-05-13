# Web Agent 功能设计

> 创建时间：2026-05-09
> 状态：设计中
> 范围：在 CoClaw 中提供对外部公共 AI 服务（豆包、DeepSeek、千问、Kimi、元宝）的统一入口
> 前置依赖：无（复用现有 `openExternalUrl` 跳转工具）
> 关联讨论：[issue#247](https://github.com/coclaw/coclaw/issues/247)（CLOSED-COMPLETED）

---

## 一、概述

### 背景

CoClaw 用户除了与 OpenClaw agent 对话，日常也会使用豆包、DeepSeek、千问、Kimi、元宝等公共 AI 服务。本功能在 CoClaw 内提供这些服务的统一入口，让用户从一个地方进入即可。

### 方案

- MainList 顶部固定一个"Web Agent"入口 item，点击弹出 Web Agent 选择对话框
- 对话框中列出预置 Web Agent，点击调起系统/外部浏览器跳转
- 服务端按用户记录每个 Web Agent 的点击次数与最近点击时间
- 用过的 Web Agent 出现在 MainList 的 Web Agents 分组，按最近点击排序

### 目标

1. 让用户在 CoClaw 内一站式访问主流公共 AI 服务
2. 入口轻量，不喧宾夺主
3. 数据模型预埋"用户自建"扩展空间

### 不在本期范围

经 issue#247 收敛阶段确认作废：

- 内嵌 WebView 容器（不自研双端原生 WebView）
- 独立 cookie 沙箱、多账号、自定义 UA、JS 注入
- "发到 Claw"协作通路（agent picker、追加草稿、inputLocked toast）
- 未读消息角标、登录态持久化
- 新用户引流闭环（issue#248 路径 C 留待后续设计）

第一版主动延后：

- 用户自建 Web Agent（schema 预埋，UI 不开放）
- 收纳页内显式分组（"推荐 / 我添加的"）
- 预置清单的运营后台
- "软下架"语义（保留点击历史的下架）——本期采用"硬下架=级联清空"

---

## 二、整体流程

```
用户在 MainList 看到顶部 "Web Agent" 入口
  → 点击弹出 Web Agent 选择对话框（窄屏全屏，宽屏居中）
  → 对话框列出 5 个预置 Web Agent
  → 用户点击某个 Web Agent
  → UI 调用 openExternalUrl(url) 跳转外部浏览器
       （Capacitor 走 Custom Tabs / SFSafariViewController；浏览器走 window.open(_blank)）
  → UI 同时 fire-and-forget 上报点击（POST /api/v1/web-agents/:id/click）
  → server 端 upsert WebAgentClick 记录（clickCount++、lastClickedAt = now）
  → 用户后续返回 CoClaw，MainList 中 Web Agents 分组出现该 Web Agent，按最近点击排序
```

---

## 三、UI 设计

### MainList 布局

```
┌──────────────────────────────────────┐
│  [Web Agent]  ──→ 选择对话框          │  ← 顶部固定入口（永远显示）
├──────────────────────────────────────┤
│  OC Agents 分组                       │
│  [OC chat A]                          │
│  [OC chat B]                          │
├──────────────────────────────────────┤
│  Web Agents 分组                      │  ← 已点过的 Web Agent，按最近点击排序
│  [豆包]                               │     用户没点过任何 Web Agent 时此分组不显示
│  [DeepSeek]                           │
│  [千问]                               │
├──────────────────────────────────────┤
│  Topics 分组                          │
│  [topic 1]                            │
└──────────────────────────────────────┘
```

要点：

- 顶部固定入口永远显示，无论用户是否点过任何 Web Agent
- 三个分组顺序写死：OC Agents → Web Agents → Topics
- 分组间隔复用 MainList 现有的分组分隔样式
- Web Agents 分组只显示用户点过的（`lastClickedAt != null`），按 `lastClickedAt DESC` 排序
- OC Agents 分组与 Web Agents 分组**不混排**——即使某 OC chat 5 分钟前刚有新消息，也不会冲到 Web Agent 上面

### Web Agent 选择对话框

采用 dialog（不走独立路由），符合 CoClaw 项目对"全局/跨组件入口对话框"的惯例（参考 `UserSettingsDialog` / `UserProfileDialog`）。

| 关注点 | 实现 |
|--------|------|
| 移动端 | `UModal` + `:fullscreen="isMobile"`，全屏；安全区适配 `safe-area-inset-top` / `safe-area-inset-bottom` |
| 桌面端 | 居中弹层，约定宽度 |
| 返回键 | 接入 `dialog-history.js`，移动端硬件返回键先关 dialog |
| 触发方式 | 函数式 `useWebAgentDialogs().openPickerDialog()`，不依赖路由 |
| 内容结构 | Dialog（壳） + Panel（内容）二分，与 `UserSettingsDialog`/`UserSettingsPanel` 一致 |

对话框内列表：

- 5 个预置 Web Agent，按 `sort ASC` 排序（用户自建第一版不存在；将来按 `(sort 是否为 null, sort, id)` JS 层排序——id 自增等价 createdAt FIFO，且 GET 已返）
- 列表项展示：图标 + 名称
- 点击列表项：`openExternalUrl(item.url)` + fire-and-forget 上报点击 → 关 dialog

### 图标资源

预置清单的图标走前端静态打包：`ui/src/assets/web-agents/<slug>.svg`：

- `deepseek.svg` / `doubao.svg` / `qwen.svg` / `kimi.svg` / `yuanbao.svg`

由产品/设计提供官方 logo。将来支持用户自建时，自建条目无 svg 资源，改用默认占位图（或扩展 `iconUrl` 字段，需 schema 迁移）。

---

## 四、数据模型

### Prisma schema（新增）

新增到 `server/prisma/schema.prisma`：

```prisma
// Web Agent 条目（系统预置 + 将来用户自建）
model WebAgent {
	id					Int @id @default(autoincrement()) @db.UnsignedInt

	userId			BigInt? @db.UnsignedBigInt // NULL 表示系统预置；非 NULL 表某用户自建（第一版不开放）
	user				User? @relation(fields: [userId], references: [id], onDelete: Cascade)

	slug				String? @db.VarChar(63) @unique // 仅预置使用，作为 syncPresets 稳定 key 与图标资源 key
	name				String @db.VarChar(128)
	url					String @db.VarChar(255)
	sort				Int? @db.UnsignedInt // 仅预置使用，决定收纳顺序

	createdAt		DateTime @default(now())
	updatedAt		DateTime @default(now()) @updatedAt

	clicks			WebAgentClick[]

	@@index([userId])
}

// 用户对某 Web Agent 的个人状态（per-user × per-WebAgent 一行）：点击账 + 隐藏状态 + 未来可能的其他偏好
model WebAgentClick {
	userId				BigInt @db.UnsignedBigInt
	webAgentId		Int @db.UnsignedInt
	user					User @relation(fields: [userId], references: [id], onDelete: Cascade)
	webAgent			WebAgent @relation(fields: [webAgentId], references: [id], onDelete: Cascade)

	clickCount		Int @default(0) @db.UnsignedInt
	lastClickedAt	DateTime @default(now())
	hiddenAt			DateTime? // 用户从最近列表隐藏该 Agent 的时间戳；NULL=未隐藏；再次点击时自动清空

	@@id([userId, webAgentId])
	@@index([userId, lastClickedAt(sort: Desc)])
}
```

### User 模型反向字段（必须）

Prisma 严格要求关系双向声明，需在现有 `User` model 中追加（注意保持现有缩进与对齐风格）：

```prisma
model User {
	...
	claws							Claw[]
	webAgents					WebAgent[]      // 新增
	webAgentClicks		WebAgentClick[] // 新增
	...
}
```

### 字段设计说明

- `WebAgent.userId` 用 `NULL` 表示系统预置；非 `NULL` 表某用户的自建条目。**单字段判定预置/自建**，不另立 `is_preset` 字段，避免冗余字段失同步
- `WebAgent.slug` 是预置条目的稳定 key——`server` 启动时 `syncPresets` 按 slug 匹配；UI 拼图标路径也用它。`@db.VarChar(63)` 与 `LocalAuth.loginName/workId` 等"短稳定标识"字段对齐。MySQL unique 允许多个 NULL，自建条目留 `NULL` 互不冲突
- `WebAgent.sort` 仅用于预置——表达运营给定的顺序，与"用户行为序"是两种性质的排序，故设为 nullable，自建条目不用
- `WebAgent.url` `@db.VarChar(255)`——常规 URL 长度上限
- **不加 `enabled / locked / disabledAt` 字段**——预置清单是代码常量，下架直接改代码 + 重启即可（`syncPresets` 会主动删 DB 里清单外的项）；用户自建第一版不存在；未来真有"软下架"运营治理需求再加（trivial migration）
- `WebAgent.id` 用自增 `Int UnsignedInt`：与 `ExternalAuth`/`ExpressSession` 等"辅助实体"风格一致；预置仅 5 条、用户自建未来也到不了几十万规模，UnsignedInt（~42 亿）远远够用，无需 Snowflake 的全局/分布式属性
- `WebAgentClick` 是用户对某 Web Agent 的个人状态聚合（不是事件流）。每个 (userId, webAgentId) 仅一行，承载点击账（`clickCount` / `lastClickedAt`） + 隐藏状态（`hiddenAt`）；未来若新增其它"用户对该 Agent 的偏好"也归入此表
- 表名沿用历史 `WebAgentClick`：考虑过 `UserWebAgent` / `WebAgentStat` / `WebAgentUsage` 等，但 `userId` 字面与 `WebAgent.userId`（自建归属）撞车，"Stat / Usage" 又把语义锁回单一维度；保留 `WebAgentClick` 不做表重命名迁移，靠表头注释拓宽语义
- `hiddenAt` 选 nullable `DateTime` 而非 boolean：与项目现有命名节奏（`lastClickedAt` / `lastSeenAt` / `lastLoginAt`）一致，同样存储成本顺手记下"何时隐藏"，将来若需排查/扩展无需再迁库；NULL = 未隐藏。重复隐藏幂等（每次刷成 `now`），不刻意保留"最早隐藏"信息
- 索引 `(userId, lastClickedAt DESC)` 用于加速 MainList 的 Web Agents 分组查询；`hiddenAt` 不建索引——前端按用户视角过滤的 list 规模天然有限（预置 5 项 + 未来用户自建），全列扫描成本可忽略
- 每次点击 `upsert` 的 `update` 分支同时把 `hiddenAt` 置为 `null`——这是"再次点击自动取消隐藏"的实现位置，前端不需要单独发请求；`create` 分支不显式设值（默认 NULL）
- `onDelete: Cascade` 的两条路径：
	- 删用户 → 自动清该用户的 WebAgent 自建条目 + 该用户所有点击记录
	- 删 WebAgent → 自动清该 Web Agent 的所有点击记录（被 `syncPresets` 下架时触发）

---

## 五、预置清单

### 清单常量

存放：`server/src/repos/web-agent.presets.js`

```js
export const PRESETS = [
	{ slug: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/',    sort: 1 },
	{ slug: 'doubao',   name: '豆包',     url: 'https://www.doubao.com/chat/',  sort: 2 },
	{ slug: 'qwen',     name: '千问',     url: 'https://www.qianwen.com/',      sort: 3 },
	{ slug: 'kimi',     name: 'Kimi',     url: 'https://www.kimi.com/',         sort: 4 },
	{ slug: 'yuanbao',  name: '元宝',     url: 'https://yuanbao.tencent.com/',  sort: 5 },
];
```

> 5 个 URL 已最终确认（2026-05-09）：千问选用国内版 `www.qianwen.com`（中文界面，原 `tongyi.aliyun.com` 收敛后的新主域）；Kimi 选用统一主域 `www.kimi.com`，原 `kimi.moonshot.cn` 已 302 跳转至此。海外的豆包对应品牌为独立的 Cici/Dola，不归类到本预置。

### Server 启动时双向同步

`server.js` 启动序列中调用 `webAgentRepo.syncPresets()`：

```js
// server/src/repos/web-agent.repo.js
export async function syncPresets() {
	const presetSlugs = PRESETS.map(p => p.slug);

	// 1. 先校验常量本身（fail-fast，常量错误必须立即暴露）
	validatePresets(PRESETS);

	// 2. 删除"DB 中存在但已不在 PRESETS 中"的预置项
	//    通过 onDelete: Cascade 自动级联清掉 WebAgentClick 中的对应记录
	//    注意：WHERE 必须限定 userId IS NULL，绝不能误删用户自建
	await prisma.webAgent.deleteMany({
		where: {
			userId: null,
			slug: { notIn: presetSlugs },
		},
	});

	// 3. upsert 当前 PRESETS（按 slug 匹配，重启幂等）
	for (const p of PRESETS) {
		await prisma.webAgent.upsert({
			where: { slug: p.slug },
			update: { name: p.name, url: p.url, sort: p.sort },
			create: { slug: p.slug, name: p.name, url: p.url, sort: p.sort, userId: null },
		});
	}
}

function validatePresets(presets) {
	const seen = new Set();
	for (const p of presets) {
		if (!p.slug || !p.name || !p.url) {
			throw new Error(`invalid preset: missing slug/name/url for ${JSON.stringify(p)}`);
		}
		if (seen.has(p.slug)) {
			throw new Error(`duplicate preset slug: ${p.slug}`);
		}
		seen.add(p.slug);
	}
}
```

特性：

- 按 slug 匹配，重启幂等
- 改预置数据（name/url/sort）跟版本走，重启即生效
- **下架时 DB 与 PRESETS 双向一致**：从 `PRESETS` 移除某条 → 重启后 DB 中对应 WebAgent 行被删除 → 该项的所有用户点击记录通过级联删除一并清空
- 常量本身错误（重复 slug、空字段）→ 启动时 throw，不让 server 起来（fail-fast）
- DB 不可达 → throw，阻止 server 启动（详见第八章"启动钩子"）

### 副作用说明

**下架某条预置 = 该条所有用户的点击数据清零**——因为 onDelete: Cascade 会级联清空 WebAgentClick 中的对应记录。第一版没有数据分析需求，这是可以接受的"硬下架"语义。将来若需要"软下架/暂时隐藏"，再加 `disabledAt DateTime?` 字段切换语义。

### 与 Cloudflare 无关

issue#247 早期讨论中曾以"是否在 Cloudflare 防护下"作为预置筛选条件，那是基于"内嵌 WebView + cookie 沙箱"旧方案的约束。本方案直接调系统浏览器跳转，目标站的 Cloudflare 验证由用户的浏览器自己处理，与 CoClaw 无关。后续若要新增 ChatGPT / Gemini / Claude.ai 等海外服务，只需扩展 `PRESETS` 常量即可。

---

## 六、API 设计

REST 前缀：`/api/v1/web-agents`

| Method | Path | 用途 | 鉴权 |
|--------|------|------|------|
| GET | `/api/v1/web-agents` | 获取预置 + 当前用户自建（将来）的 Web Agent 列表 | **公开**：未登录返回纯入口数据（lastClickedAt / hiddenAt 全 null）；登录后附带个人化字段 |
| POST | `/api/v1/web-agents/:id/click` | 上报一次点击（fire-and-forget），同时清空该 Agent 的 hiddenAt | 必须登录，否则 401 |
| POST | `/api/v1/web-agents/:id/hide` | 将该 Agent 从当前用户的最近列表隐藏（设置 hiddenAt = now） | 必须登录，否则 401 |

GET 公开访问的设计动因：CoClaw 把 Web Agent 列表当作"门户入口"，未登录用户也能看到预置清单并跳转到第三方 ChatBot。click / hide 涉及写入用户私有数据，仍强制登录。

### GET /api/v1/web-agents

返回可见的全部 Web Agent：登录用户拿到系统预置 + 该用户自建，并附带该用户的点击信息；未登录用户仅拿系统预置，`lastClickedAt` / `hiddenAt` 固定为 `null`。

响应：

```json
{
	"items": [
		{
			"id": 1,
			"slug": "deepseek",
			"name": "DeepSeek",
			"url": "https://chat.deepseek.com/",
			"sort": 1,
			"lastClickedAt": "2026-05-08T14:23:11.000Z",
			"hiddenAt": null
		},
		{
			"id": 2,
			"slug": "doubao",
			"name": "豆包",
			"url": "https://www.doubao.com/chat/",
			"sort": 2,
			"lastClickedAt": null,
			"hiddenAt": null
		}
	]
}
```

repo 层 prisma client 写法（不是裸 SQL JOIN）：

```js
// server/src/repos/web-agent.repo.js
export async function findAllForUser(userId) {
	// 匿名分支：只取预置，不查 WebAgentClick 表，个人化字段固定 null
	if (userId == null) {
		const agents = await prisma.webAgent.findMany({ where: { userId: null } });
		return agents.map(a => ({
			id: a.id, slug: a.slug, name: a.name, url: a.url, sort: a.sort,
			lastClickedAt: null, hiddenAt: null,
		}));
	}
	const agents = await prisma.webAgent.findMany({
		where: {
			OR: [
				{ userId: null },  // 系统预置
				{ userId },         // 当前用户自建
			],
		},
		include: {
			clicks: {
				where: { userId },
				select: { lastClickedAt: true, hiddenAt: true },
			},
		},
	});
	return agents.map(a => ({
		id: a.id,
		slug: a.slug,
		name: a.name,
		url: a.url,
		sort: a.sort,
		lastClickedAt: a.clicks[0]?.lastClickedAt ?? null,
		hiddenAt: a.clicks[0]?.hiddenAt ?? null,
	}));
}
```

UI 侧分两种用法：

- **选择对话框**：按 `sort ASC` 排序（v1 全是预置，sort 都非空；将来用户自建按 `(sort 是否为 null, sort, id)` 在前端 JS 排序，避免 prisma 不支持 NULLS LAST 的麻烦——id 自增等价 createdAt FIFO）。**选择对话框不读 `hiddenAt`**——隐藏只影响 MainList 列表，picker 永远展示全部可见 Agent
- **MainList Web Agents 分组**：过滤 `lastClickedAt != null && hiddenAt == null`，按 `lastClickedAt DESC` 排序

### POST /api/v1/web-agents/:id/click

请求 body：无
响应：`204 No Content`（成功）/ `404 Not Found`（id 对当前用户不可见）/ `401`（未登录）

**项目当前没有统一错误类映射**（参考 `claw-bot.route.js` / `claw.route.js` 等），路由层用既有 `code/message` 结构直接 `res.status(...)` 返回错误码。service 层返回 boolean，让 route handler 决定 HTTP 状态：

```js
// server/src/services/web-agent.svc.js
// 返回 true = 记录成功；返回 false = 不可见（让 route handler 决定 404）
export async function recordClick(userId, webAgentId) {
	const agent = await prisma.webAgent.findFirst({
		where: {
			id: webAgentId,
			OR: [
				{ userId: null },  // 系统预置（syncPresets 双向同步，DB 中 userId=NULL 的条目即"当前活跃预置"）
				{ userId },        // 当前用户自建
			],
		},
		select: { id: true },
	});
	if (!agent) return false;

	// 注意：update 分支显式将 hiddenAt 置为 null —— "再点取消隐藏"的实现位置
	await prisma.webAgentClick.upsert({
		where: { userId_webAgentId: { userId, webAgentId } },
		update: { clickCount: { increment: 1 }, lastClickedAt: new Date(), hiddenAt: null },
		create: { userId, webAgentId, clickCount: 1 },
	});
	return true;
}
```

### POST /api/v1/web-agents/:id/hide

请求 body：无
响应：`204 No Content`（成功）/ `404 Not Found`（id 对当前用户不可见，或当前用户从未点击过该 Agent）/ `401`（未登录）

将该 Agent 从当前用户的最近列表移除（不删数据，仅设 `hiddenAt = now`）。重复隐藏幂等。

```js
// server/src/services/web-agent.svc.js
// 返回 true = 已隐藏；false = 不可见或从未点击过（路由层映射 404）
export async function hide({ userId, webAgentId }) {
	const id = await findVisibleAgentId({ userId, webAgentId });
	if (id == null) return false;
	const affected = await setHiddenNow({ userId, webAgentId });
	return affected > 0;
}

// server/src/repos/web-agent.repo.js
// updateMany：命中 0 行不会凭空 INSERT，由 svc 转 false → route 转 404
export async function setHiddenNow({ userId, webAgentId, now = new Date() }) {
	const result = await prisma.webAgentClick.updateMany({
		where: { userId, webAgentId },
		data: { hiddenAt: now },
	});
	return result.count;
}
```

route handler 与 click 同型（`requireSession` + `parseWebAgentId` + 401/400/404/204）：

```js
// server/src/routes/web-agent.route.js
router.post('/:id/click', recordClickHandler);
router.post('/:id/hide', hideWebAgentHandler);

function parseWebAgentId(raw) {
	if (typeof raw !== 'string') return null;
	if (!/^[0-9]+$/.test(raw)) return null;
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0 || n > 4294967295) return null;
	return n;
}
```

注意点：

- prisma 复合主键 upsert 的 `where` 字段名是 `userId_webAgentId`（自动 camelCase 拼接），实施时不要手写错
- `:id` 必须 parse + 校验为正整数且不超 UnsignedInt 上界（非法 → 400 INVALID_INPUT），与现有路由（如 `claw-bot.route.js`）一致
- UI click 不等响应——上报失败不影响跳转
- UI hide 也是 fire-and-forget：本地立即把对应 item 的 `hiddenAt` 标成 `new Date().toISOString()`，请求失败仅 `console.warn`
- **并发首次点击的 P2002 已知容忍**：fire-and-forget 场景偶发"两端首次同时点同一条"会让 prisma upsert 走双 create 路径触发主键冲突，本期不处理（产品上极少发生，丢一次记录可接受）
- hide 使用 `updateMany` 而非 `update`：命中 0 行返回 `{ count: 0 }`，避免对从未点击过的 Agent 凭空 INSERT 一行只为承载 hiddenAt

---

## 七、UI 实现

### 文件结构（按现有项目惯例）

```
ui/src/
	components/
		MainList.vue                              ← 现有文件，新增顶部 "Web Agent" 入口 + Web Agents 分组渲染
		WebAgentItemActions.vue                   ← Web Agents 分组内 recent 项的尾部三点菜单（仅一项"移除"）
		web-agents/
			WebAgentPickerDialog.vue              ← 对话框壳（UModal + fullscreen 切换）
			WebAgentPickerPanel.vue               ← 对话框内容（5 项列表）
	composables/
		use-web-agent-dialogs.js                  ← 对外暴露 openPickerDialog()
	stores/
		web-agents.store.js                       ← Pinia store（命名复数，与 agents/claws/topics 一致）
	services/
		web-agents.api.js                         ← HTTP 调用层（命名 *.api.js，与 admin/auth/claws 一致）
	assets/
		web-agents/
			deepseek.svg / doubao.svg / qwen.svg / kimi.svg / yuanbao.svg
	i18n/locales/
		zh-CN.js / en.js / ja.js / ... (12 个文件全部同步新增 webAgents.* key)
```

### Pinia store

`stores/web-agents.store.js`：

```js
export const useWebAgentsStore = defineStore('webAgents', {
	state: () => ({
		items: [],          // [{ id, slug, name, url, sort, lastClickedAt, hiddenAt }]
		loaded: false,
	}),
	getters: {
		// 选择对话框用：所有条目，按 sort 排序（NULL 排最后），sort 同则按 id（自增等价 createdAt FIFO）
		pickerList(state) {
			return [...state.items].sort((a, b) => {
				const aSort = a.sort ?? Number.MAX_SAFE_INTEGER;
				const bSort = b.sort ?? Number.MAX_SAFE_INTEGER;
				if (aSort !== bSort) return aSort - bSort;
				return a.id - b.id;
			});
		},
		// MainList Web Agents 分组用：过滤已点过且未隐藏的，按最近点击降序
		recentlyClicked(state) {
			return state.items
				.filter(a => a.lastClickedAt != null && a.hiddenAt == null)
				.sort((a, b) => new Date(b.lastClickedAt) - new Date(a.lastClickedAt));
		},
	},
	actions: {
		async loadAll() { /* GET /api/v1/web-agents，merge 时取 lastClickedAt 较大值，避免覆盖刚发生的乐观更新 */ },
		recordClick(id) {
			// 1. 立即本地乐观更新 lastClickedAt = new Date()，并把 hiddenAt 清成 null（再点取消隐藏，与服务器最终状态对齐）
			// 2. fire-and-forget POST，.catch(err => log) 避免 unhandled rejection
		},
		hide(id) {
			// 1. 立即本地乐观把 hiddenAt 标为 new Date()，让 MainList 该项即时消失
			// 2. fire-and-forget POST /api/v1/web-agents/:id/hide，.catch(err => log)
		},
	},
});
```

注意点：

- store 名 `useWebAgentsStore`、文件 `web-agents.store.js`、Pinia id `webAgents` —— 全部复数，与现有 `useAgentsStore`/`useClawsStore`/`useTopicsStore` 命名风格一致
- `loadAll` merge 时取 `lastClickedAt` 较大值——避免 loadAll 旧响应在 recordClick / hide 之后到达时覆盖乐观时间戳
- `hiddenAt` 合并采用"以 lastClickedAt 为时序锚":
	- 若本地 `lastClickedAt` 严格新于服务器 → 本地 `hiddenAt`（已被 recordClick 清成 null）胜出
	- 否则 → 取 `max(prev.hiddenAt, server.hiddenAt)`，保护本地刚 fire 的 `hide()` 不被旧响应复活
- `recordClick`/`hide` 必须 catch fire-and-forget Promise，避免 unhandled rejection 噪音
- `recordClick`/`hide` 在 `!useAuthStore().user` 时整段跳过——匿名用户点 web agent 仅作外链入口，不进 MainList 也不打 server
- `loadAll` 用模块级 epoch 守护 in-flight 响应：`__resetWebAgentsInternals()`（被 auth.store 的 logout/login/register 调用）自增 epoch 并清 in-flight handle；旧 IIFE 的 `await` 返回后比对 epoch，不一致即丢弃整段响应，避免登出/换号后旧数据把刚 `$reset` 的 store 复活
- store 重置的触发点（auth.store.js）：**logout 清理链**（无论 API 成功/401/失败都跑本地清理）+ **login / register 成功分支**各调一次 `__resetWebAgentsInternals() + useWebAgentsStore().$reset()`。`refreshSession` 故意**不**重置——它与 MainList.mounted 的 loadAll 并发跑、共用同一 cookie，两者拿到的鉴权视图一致；若在这里 reset 会把 in-flight loadAll 的正确响应一并丢弃

### loadAll 触发时机与加载状态

- **`MainList.vue` mounted 时**调用一次 `loadAll()`（与现有 agents/topics 等 store 的预加载方式对齐），结果用于渲染 Web Agents 分组
- **`WebAgentPickerPanel.vue` mounted 时**再 `await store.loadAll()` 兜底（如果 store 已加载则 in-flight 去重直接返回，避免重复请求）
- store 内部维护 `loaded`/`loading`/`error` 状态：
	- `loading=true && items=[]` → Panel 显示骨架/loading
	- `items=[]` && `!loading` && `!error` → Panel 显示空态兜底（理论上预置非空不会触发）
	- `error != null` → Panel 显示重试按钮
- 参考现有 `agents.store.js` 的 loaded/loading 处理风格

### Composable

`composables/use-web-agent-dialogs.js`，结构对照 `composables/use-user-dialogs.js`：

```js
import { useOverlay } from '@nuxt/ui/composables';
import WebAgentPickerDialog from '../components/web-agents/WebAgentPickerDialog.vue';
import { pushDialogState } from '../utils/dialog-history.js';

let pickerDialog = null;

function ensureDialogInstance(overlay) {
	if (!pickerDialog) {
		pickerDialog = overlay.create(WebAgentPickerDialog, { destroyOnClose: false });
	}
}

function closeAllDialogs() {
	pickerDialog?.close();
}

export function useWebAgentDialogs() {
	const overlay = useOverlay();
	ensureDialogInstance(overlay);

	return {
		openPickerDialog() {
			pushDialogState(closeAllDialogs);
			pickerDialog?.open();
		},
	};
}
```

### Dialog 组件骨架

`components/web-agents/WebAgentPickerDialog.vue`：

```vue
<template>
	<UModal
		v-model:open="openProxy"
		:title="$t('webAgents.title')"
		description=" "
		:fullscreen="isMobile"
		:ui="isMobile ? safeAreaUi : undefined"
		@after:leave="$emit('after:leave')"
	>
		<template #body>
			<WebAgentPickerPanel @selected="handleClose" />
		</template>
	</UModal>
</template>
```

要点：

- 移动端 `:fullscreen="isMobile"`（`envStore.screen.ltMd`），全屏避免对话框窄屏不可读
- `safeAreaUi` 给顶部/底部追加 safe-area 内边距（与 `UserSettingsDialog` 完全一致）
- watch `open === false` 时 `popDialogState()`，接管移动端硬件返回键（参见现有 `UserSettingsDialog.vue` 写法）
- Panel 内点击列表项后触发 `selected` 事件，Dialog 监听并 close

### 入口接入 MainList

实际接入点是 `ui/src/components/MainList.vue`——这是真正承载主列表的组件，被 `views/TopicsPage.vue` 和 `components/DesktopSidebar.vue` 引用，改这一处即可同时生效于移动端 Topics 页与桌面端 Sidebar。

在 `MainList.vue` 顶部新增固定 "Web Agent" 入口 item，并在原 OC chat 列表后新增 "Web Agents 分组"，渲染 `useWebAgentsStore().recentlyClicked`：

```js
// MainList.vue 的 setup()
import { useWebAgentDialogs } from '../composables/use-web-agent-dialogs.js';
import { useWebAgentsStore } from '../stores/web-agents.store.js';

setup() {
	const { openPickerDialog } = useWebAgentDialogs();
	return { openPickerDialog, webAgentsStore: useWebAgentsStore() };
}
```

不走 `router.push`，避免引入无意义的 URL 状态。

### 隐藏交互（Web Agents 分组）

Web Agents 分组的 recent 项支持用户主动隐藏，结构和交互完全照搬 OC Agents / Topics 行：

- 行结构：外层 `<div class="group flex h-11 items-center …">`，内层左半段 `<button>`（承担点击 + `data-testid="web-agent-recent-${slug ?? 'custom-' + id}"`），尾部挂 `<WebAgentItemActions :web-agent-id>` —— 与 `AgentItemActions` / `TopicItemActions` 同款 `opacity-0 group-hover:opacity-100` 显隐
- 触屏环境（`@media (hover: none)`）通过 `.web-agent-actions` 选择器把 actions 强制可见（`opacity: 1`），与 `.topic-actions` / `.agent-actions` 一同维护
- `WebAgentItemActions.vue` 与 `TopicItemActions.vue` 同骨架：UPopover + 三点 `i-lucide-ellipsis` 触发器，菜单仅一项"移除"（`i-lucide-x` + `webAgents.removeFromRecent`）。点击调用 `useWebAgentsStore().hide(id)`
- **不发 toast、不弹二次确认**：项瞬间消失即用户能感知的反馈；数据没真删（picker 仍能调出来），不触发"破坏性"心智模型。符合项目规范"用户能直接感知不必 notify"

### i18n key

12 个语言文件（`de.js / en.js / es.js / fr.js / hi.js / ja.js / ko.js / pt.js / ru.js / vi.js / zh-CN.js / zh-TW.js`）全部同步新增：

```js
webAgents: {
	title: 'Web Agent',                   // 对话框标题
	entryName: 'Web Agent',               // MainList 顶部入口名称
	empty: '...',                          // 空态兜底（理论上预置非空时不触发）
	removeFromRecent: '...',               // 三点菜单"移除"项（中文：从列表移除）
}
```

namespace 复数 `webAgents.*`，与现有 `claws.*`/`topics.*`/`agents.*` 风格一致。

---

## 八、Server 实现

### 目录结构

```
server/src/
	routes/
		web-agent.route.js           ← 路由定义 + handler，handler 在 router.<method>() 旁可被测试 import
	services/
		web-agent.svc.js             ← 业务流程编排（recordClick 中的可见性校验在这一层）
	repos/
		web-agent.repo.js            ← Prisma 收口：syncPresets / findAllForUser
		web-agent.presets.js         ← 预置清单常量
```

> 注意：路由/服务文件名用单数（与现有 `claw.route.js`/`user.route.js` 等风格一致）；UI 侧 store/服务用复数（与 `agents.store.js`/`claws.api.js` 一致）。两边惯例不同，按各自规范。

### 启动钩子

`server.js` 现状是 `app.listen()` 之后再做附加动作（attachClawWsHub 等）。**`syncPresets` 必须改在 `app.listen()` 之前 await 完成**，否则会出现"早请求拿到旧/缺失数据"的窗口：

```js
// server/src/server.js（startServer 改 async）
import { syncPresets } from './repos/web-agent.repo.js';

export async function startServer() {
	const app = createApp();
	const port = Number(process.env.PORT ?? 3000);

	await syncPresets(); // 失败抛错 → 进程退出 → 由进程管理器重试

	const server = app.listen(port, () => {
		console.log(`[coclaw/server] listening on :${port}`);
	});

	attachClawWsHub(server, { sessionMiddleware: app.sessionMiddleware });
	attachRtcSignalHub(server, { sessionMiddleware: app.sessionMiddleware });
	startPluginLatestPolling();

	return server;
}
```

- 常量错误（重复 slug、空字段）→ `validatePresets` throw，阻止 server 启动（fail-fast）
- DB 不可达 → throw，阻止 server 启动（让进程管理器重试）

### 路由挂载

`server/src/app.js` 中 import 并 mount，与现有 `clawRouter` / `userRouter` 等的挂载方式一致：

```js
import { webAgentRouter } from './routes/web-agent.route.js';
// ...
app.use('/api/v1/web-agents', webAgentRouter);
```

---

## 九、迁移与部署

- 新建 prisma migration：含 `WebAgent` / `WebAgentClick` 两张新表 + `User` 上的反向关系字段（无 schema column 变更，仅是 prisma 客户端的关系映射）
- **按项目约定，schema 修订必须用户确认后才能 migrate**
- 部署：拉镜像 → 运行 migration → 启动 server（自动 syncPresets）
- 5 个 svg logo 资源由产品/设计提供，随 ui 包发布

---

## 十、扩展路径（将来）

第一版 schema/UI 已为以下扩展预留空间：

| 扩展 | schema 准备 | 实施时改动 |
|------|------------|-----------|
| 用户自建 Web Agent | `WebAgent.userId` 已可空 | 对话框加"添加"按钮 + POST API；自建条目 `sort=NULL` 落到列表末尾 |
| 收纳页"推荐 / 我添加"分组 | 同上 | UI 渲染分组（Panel 改造） |
| 自定义图标 | - | 新增 `iconUrl String?` 字段或扩展 iconKey 双形态（**需 schema 迁移**） |
| 软下架/暂时隐藏（保留点击历史） | - | 新增 `disabledAt DateTime?` 字段，syncPresets 改"清单外的标记 disabled 而非物理删"（**需 schema 迁移**） |
| 海外服务接入（ChatGPT/Gemini 等） | 无需 schema 变更 | 扩展 `PRESETS` 常量 |
| 团队级 / 分享 Web Agent | **未预留** | 当前 `userId NULL = 预置` 没有 scope/ownership 维度，真要做需要新增 `scope` 或 `teamId` 字段（**需 schema 迁移**） |
| 引流闭环（issue#248 路径 C） | - | 待整体设计后追加 |

---

## 十一、测试要点

> **涉及 E2E 测试时必须先加载 `e2e-test` skill**——其中包含执行命令、标签分类、编写规范和关键约束。

### Server 单测

`server/src/repos/web-agent.repo.test.js`：

- `syncPresets` 跑两次 DB 不变（idempotent）
- 修改 `PRESETS`（改 name/url/sort）后调用，update 字段生效
- 从 `PRESETS` 移除某条调用 → DB 中对应 WebAgent 行消失，且该项的所有 WebAgentClick 记录连带消失（级联删除验证）
- `PRESETS` 中含重复 slug → throw
- `PRESETS` 含空字段 → throw
- syncPresets 不会误删 `userId IS NOT NULL` 的用户自建条目
- `findAllForUser` 返回当前用户的预置 + 自建，含 lastClickedAt（点过/未点过两种 case）
- `findAllForUser` 返回值含 hiddenAt（没点过 / 点过未藏 / 点过已藏 三态）
- `incrementClick` 对已隐藏的行清空 hiddenAt（"再点取消隐藏"回归测试）
- `setHiddenNow` 命中现有 click 行刷 hiddenAt 并返回 1；不存在的 click 行返回 0 且不凭空 INSERT；重复隐藏幂等
- `setHiddenNow` where 仅命中当前 (userId, webAgentId) 一行，不殃及别人或别的 Agent

`server/src/services/web-agent.svc.test.js`：

- `hide` 不可见时返 false 且不调 setHiddenNow
- `hide` 可见但用户从未点击过该 Agent → setHiddenNow 命中 0 行 → 返 false
- `hide` 可见且 click 行存在 → 返 true 且调 setHiddenNow 透传 userId/webAgentId
- `hide` setHiddenNow 抛错时透传出去（不静默吞）

`server/src/routes/web-agent.route.test.js`：

- GET 未登录 → 200，仅预置项，`lastClickedAt` / `hiddenAt` 全 null
- GET 登录后正常返回 items
- POST `/click` 未登录 → 401
- POST `/click` 不可见 ID（不存在 / 别人的自建条目）→ 404
- POST `/click` 首次 → create 记录、clickCount=1
- POST `/click` 重复 → increment 计数 + 刷新 lastClickedAt
- POST `/hide` 未登录 → 401；id 非法/缺失 → 400；不可见或从未点击 → 404；成功 → 204；幂等再调一次仍 204

覆盖率门槛：≥90%。

### UI 单测

`stores/web-agents.store.test.js`：

- `recordClick` 后本地 lastClickedAt 立即更新，`recentlyClicked` 排序生效
- `recordClick` 同步把 hiddenAt 清成 null（再点取消隐藏）
- `loadAll` 后到达的旧响应不会覆盖更新的 lastClickedAt（merge 取 max）
- `loadAll` 旧响应不会覆盖本地刚 `hide()` 的 hiddenAt（hide 后到达旧响应仍保留乐观值）
- `loadAll` 旧响应不会复活本地刚通过 `recordClick` 清掉的 hiddenAt（lastClickedAt 时序锚）
- `recordClick` / `hide` 上报失败时 catch 兜底，不抛 unhandled rejection
- `pickerList` 按 sort 排序正确（NULL 排最后）
- `recentlyClicked` 过滤未点过 / 已隐藏的项 + 排序正确
- `hide(id)` 立即把对应 item 的 hiddenAt 标为 now，并 fire-and-forget POST `/api/v1/web-agents/:id/hide`

`composables/use-web-agent-dialogs.test.js`：

- 多次 open 复用同一 overlay 实例（destroyOnClose: false）
- `openPickerDialog()` 时调 `pushDialogState` 并打开 dialog
- `closeAllDialogs()` 关闭所有 dialog 实例

> **测试职责分层**：参考 `UserSettingsDialog.vue` + `use-user-dialogs.js`，composable 只负责 push 与单例管理；**`popDialogState` 是 Dialog 组件 watch open=false 时调用的**，不在 composable 测试中验证。

组件级（vue-test-utils）：

- `WebAgentPickerPanel` 渲染 store.pickerList，点击 item 触发 selected 事件 + 调 `recordClick`
- `WebAgentPickerPanel` 在 `loading=true && items=[]` 时显示 loading 占位
- `WebAgentPickerPanel` 在 `error != null` 时显示重试按钮
- `WebAgentPickerDialog` 在 ltMd 时 `:fullscreen=true`、桌面端 false
- `WebAgentPickerDialog` watch open 从 true → false 时调 `popDialogState`（即 Capacitor 硬件返回键关闭路径）
- `WebAgentPickerDialog` 安全区 `safeAreaUi` 仅在 ltMd 时应用
- `WebAgentItemActions` 渲染三点 trigger + 单一菜单项"移除"，点击调 `useWebAgentsStore().hide(id)` 并关闭菜单
- `MainList` Web Agents 分组每条 recent 项渲染尾部 actions 占位；`hiddenAt != null` 的条目不渲染

覆盖率门槛：branches ≥90%、其余 ≥95%。

### E2E

`ui/e2e/web-agents.e2e.spec.js`（命名遵循 `e2e-test` skill 约束）：

- MainList 顶部 "Web Agent" 入口可点击 → 弹出 dialog（`data-testid="web-agent-entry"`）
- Dialog 内容：5 个预置项按既定顺序 DeepSeek / 豆包 / 千问 / Kimi / 元宝（`data-testid="web-agent-item-${slug}"`）
- 点击某预置 → 触发外部跳转上报 + 关 dialog + MainList 中 Web Agents 分组出现该项在顶部
- 重新进入 dialog → list 顺序仍为 sort 顺序（不被点击行为影响）
- MainList Web Agents 分组某 recent 项 → 点击尾部三点 → 菜单出现"移除" → 点击 → 该项立即从分组消失
- 重新打开 picker → 点击同一项 → 关 picker → 该项又出现在 Web Agents 分组顶部（再次点击自动取消隐藏）

#### data-testid 列表

依赖可见文本会受 i18n 影响，**必须用 `data-testid` 定位**（与现有 E2E 一致）：

- `web-agent-entry` —— MainList 顶部入口 item
- `web-agent-picker-dialog` —— picker dialog 根节点
- `web-agent-item-${slug}` —— dialog 内每条预置项（slug = `deepseek` / `doubao` / `qwen` / `kimi` / `yuanbao`）
- `web-agent-recent-${slug}` —— MainList Web Agents 分组中的已点过项
- `web-agent-section-recent` —— Web Agents 分组容器（用于断言"无最近点击时不渲染"）
- `web-agent-actions-trigger-${id}` —— 已点过项尾部三点菜单 trigger
- `web-agent-actions-remove-${id}` —— 三点菜单内"移除"项

#### 外部跳转的 stub 方式

Web E2E（Playwright 浏览器环境）使用 `page.addInitScript` 拦截 `window.open`，记录跳转 URL 但不真实打开：

```js
await page.addInitScript(() => {
	window.__openedUrls = [];
	const origOpen = window.open.bind(window);
	window.open = (url, ...rest) => {
		window.__openedUrls.push(url);
		return null; // 不真实打开，避免新窗口干扰测试
	};
});
// 测试断言：
const urls = await page.evaluate(() => window.__openedUrls);
expect(urls).toContain('https://chat.deepseek.com/');
```

> Capacitor 原生环境的 `@capacitor/browser` 跳转**不在当前 Playwright E2E 范围**，由人工/设备测试覆盖。

---

## 十二、风险与待办

| 项 | 状态 |
|----|------|
| 5 个预置 Web Agent 的精确 URL 待用户最后确认 | 待办 |
| 5 个 SVG logo（deepseek/doubao/qwen/kimi/yuanbao）由产品/设计提供 | 待办 |
| MainList 三分组的视觉对齐（与 OC Agents 分组样式统一） | 实施时确认 |
| i18n 文案稿（12 个语言文件） | 实施时定稿 |
| MainList 顶部入口的视觉样式（图标、字号、与现有 chat item 对齐还是更轻量） | 实施时确认，参照 `qidianchat` 风格 |

### 已知容忍项

- **并发首次点击的 P2002**：fire-and-forget 场景偶发"两端首次同时点同一条"会让 prisma upsert 走双 create 路径触发主键冲突。第一版不处理，丢一次记录可接受（产品上极少发生，且后续点击会成功 upsert）。

---

## 十三、来源参考

- [issue#247](https://github.com/coclaw/coclaw/issues/247)（CLOSED-COMPLETED）—— 收敛后的最终方案以末尾关闭评论为准；前期讨论中关于"内嵌 WebView / cookie 沙箱 / 发到 Claw"等中间共识在结案时被整体推翻
- [issue#248](https://github.com/coclaw/coclaw/issues/248) —— 新用户引流路径 C 中关于 Web Agent 的角色描述（本期不实施）
- 项目内对话框模式参考：`ui/src/components/user/UserSettingsDialog.vue` + `ui/src/composables/use-user-dialogs.js`
