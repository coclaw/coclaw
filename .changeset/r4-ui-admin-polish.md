---
"@coclaw/ui": patch
---

ui: admin 页面 review 微调（术语 / 视觉 / 交互）

**i18n（12 个 locale）**：
- `admin.nav.claws` / `admin.dashboard.totalClaws` / `admin.users.columnClawCount` / `admin.claws.columnName`：统一品牌化为 **Claws / Claw**（不再按各自语言翻译成"实例/Instance/インスタンス/…"）
- `admin.claws.title` / `admin.dashboard.sectionLatestClaws`：句中 Instance/实例 → Claws
- `admin.nav.dashboard`：本地化的"概览 / Overview / Übersicht / …"（原"工作台 / Dashboard"）
- `admin.dashboard.title` / `admin.users.title`：保留原文（仍为"管理工作台 / Admin Console / 用户管理 / User Management"等），供 MobilePageHeader 和稳定桌面 h1 使用

**AdminDashboardPage**：
- 移动 header `#actions` 新增 Claws / Users 图标导航按钮（`i-lucide-server` / `i-lucide-users`），仅总览页提供子页跳转入口，避免子页间乱跳
- 5 个卡片 `p-4 → p-3`，与移动优先间距一致
- 次级三卡片 `bg-elevated/60 → bg-elevated`，与主卡片背景统一

**AdminClawsPage**：
- 桌面 h1 改用 `admin.dashboard.title`，页面切换由右侧 nav tabs 高亮指示（不随页面变化抖动）
- 表格 `<md → <lg` 断点，让列宽更舒展
- UTable 通过 `:ui` 收紧 `th/td` padding 到 `p-2`，行加 `data-[selectable=true]:cursor-pointer`
- `:on-select="onRowSelect"` 让整行可点击展开（配合鼠标指针提示可点击）
- name-cell 的 `<button>` 降级为 `<span>`，避免嵌套交互元素；展开行 `<div>` 去掉多余 `py-2`
- `data().searchInput` 从 `adminStore.claws.search` 取 snapshot，替换原 mounted 里的 carriedSearch 赋值 + `clearTimeout` 兜底 dance，不再依赖 Vue watcher flush 时序

**AdminUsersPage**：
- 桌面 h1 改用 `admin.dashboard.title`（同 Claws 页）
- UTable `:ui="{ th: 'p-2', td: 'p-2' }"`
- `data().searchInput` 同样改为 store snapshot 初始化

**搜索框（两页共享）**：
- `size="md" → size="lg"` 更贴合移动优先触控目标
- `:ui="{ base: 'leading-normal' }"` 覆盖 Nuxt UI `text-base/5` 硬编码的 20px 行高，恢复 Tailwind 默认 1.5（24px），中英文混排不再挤
