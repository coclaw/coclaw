# 内容 header 扁平化 + 主题跟随系统（主目标 UI 改善）

> 状态：已评审钉死（fork 自审 + codex 外审 + 主线复核三视角）｜ 已实施 ｜ 2026-06-09
> 关联：与 [electron-custom-titlebar.md](electron-custom-titlebar.md) 同源拆分而来（原 `desktop-titlebar-coherence.md`）。本稿只收**主目标（web / Capacitor）受益、零 Electron 耦合、低风险**的两项独立改善；Electron 自定义标题栏那套（次要、尽力而为）单独成稿。
> 影响范围：仅 `ui/src/`（三处 header 底色 + 主题服务），**不碰 `ui/electron/`**。两项改动对浏览器/移动端都是改善或无感，不引入新脆弱面。

## 为什么拆出来单独做

桌面标题栏（Electron）是**次要、尽力而为**的目标；而下面两项是**主目标（web / Capacitor）**的直接改善，彼此独立、各自低风险、与 Electron 壳零耦合。把它们和复杂的 Electron 标题栏解绑、单独成稿单独 commit，便于先落地惠及现有浏览器/移动端用户，且回退风险趋零。

---

## 1. 内容 header 扁平化

### 问题

三个内容页的桌面 header（ChatPage / FileManagerPage / ModelConfigPage）用了 `bg-elevated` 填充，而其余 header 都不带 chrome 填充——admin 桌面 header 透明继承页底色（无 `bg-default` 无 `border-b`），移动端 header（`MobilePageHeader` / `MainList`）是 `bg-default` + 一道 `border-b`。那三处填充式 header 是少数派，宽屏浏览器下读作「凹陷/割裂」，是用户觉得「怪」的来源。根因：**该用 chrome 色的边界没划清**——内容层不该用填充色。

### 设计原则（两层 chrome 的内容层）

- **chrome 层**（`bg-elevated`）只留给真正独立的面（侧边栏、Electron 标题栏条）。
- **内容层**（`bg-default`）= 内容 header + 正文，靠 `border-b` hairline 分隔，**不靠填充色**。

### 改动

把三处桌面内容 header 的 `bg-elevated` 改为与正文同底色，保留 `border-b border-default` 作分隔：

- `ui/src/views/ChatPage.vue`（header 行）
- `ui/src/views/FileManagerPage.vue`（header 行）
- `ui/src/views/ModelConfigPage.vue`（header 行）

**硬清单——不参与本次扁平化**（`bg-elevated` 全量普查后的完整名单，避免日后被当遗漏改回）：
- 侧边栏（`DesktopSidebar`）、移动端底栏（`MobileBottomTabs`）的 `bg-elevated`：真·独立导航面（chrome 层），保留。
- `ManageClawsPage.vue` 的 `bg-elevated`：是内容卡片、非 header，保留。
- admin 桌面 header：本就**无填充**（无 `bg-*`、无 `border-b`，是 `max-w` 居中的页标题行，与三处全宽 sticky chrome 条是**不同模式**），透明继承页底色 `bg-default`，无需动；其中 `AdminNavTabs` 的 `bg-elevated` 是激活态 tab 的刻意点缀（chrome accent，非 header 填充），同样保留。
- 移动端 header（`MobilePageHeader`/`MainList`）：本就 `bg-default` + `border-b`，无需动。

收尾再扫一遍确认无新增 header 漏网（一致性穷举）。

### 风险

纯 CSS 底色改动、纯前端、所有端一致受益；移动端 header 本就 `bg-default` 故无感。无回退风险。

---

## 2. `auto` 主题实时跟随系统明暗

### 问题（预存缺口）

现状 `resolveAppliedTheme` 只在 `applyThemeMode` 被**显式调用**那一刻读 `matchMedia('(prefers-color-scheme: dark)')`，全应用**无变更监听**——故 `auto` 模式下系统运行中翻明暗时，`.dark` class、theme-color meta 都不刷新（要等下次改设置才生效）。这是所有端共有的预存缺口。

### 改动

- `src/services/theme-mode.js` 加模块级 `activeMode`（由 `applyThemeMode` 写入当前 mode）。
- 新增 `initThemeModeWatcher()`：注册 `matchMedia('(prefers-color-scheme: dark)')` 的 `change` 监听，回调里若 `activeMode === 'auto'` 则重跑 `applyThemeMode('auto')`。
- **落点必须是真·开机一次的 `src/main.js`（与 `initElectronApp(router)` 同档）+ 模块级 `initialized` 守卫（重复调用 no-op；该守卫同时兜住 Vite HMR 开发期重跑模块级代码，不止防冗余 boot 调用）**——切勿放在 `applyThemeMode` / `applyUserPreferences` 链上：`applyUserPreferences` 被多个高频入口调用——每次受保护路由导航（`router/index.js` beforeEach → `refreshSession`），以及登录 / 登出重置 / 注册 / 保存设置（`auth.store.js` 各入口）——「同处」会在每个入口重注册一个监听、无清理 → 监听器泄漏。泄漏面比「仅导航」更宽。
- 因 `.dark` + theme-color meta 都由 `applyThemeMode` 一处驱动，这一条监听让两者在 auto 实时切换时**同时**刷新。`MediaQueryList.addEventListener('change')` 在浏览器基线（Safari 15+ / Chrome 90+ / FF 90+）均支持。

### 风险与注意

- 这是本稿**唯一一处主动改变 web / Capacitor 运行时行为**的改动（其余是 CSS 底色）。属改善（auto 模式更跟手），但仍需在浏览器 + Capacitor 上补 **auto 主题回归测试**，确认不引入闪烁/抖动等偶发问题。
- **Capacitor 连带效应（合意，但显式记下）**：`applyThemeMode` 内部会调 `syncStatusBarStyle`（`theme-mode.js`；web 上 `if(!isNative)return` 直接 no-op、不 await）。故 auto 模式下系统每次切明暗、watcher 重跑 `applyThemeMode('auto')`，会在 Capacitor 上连带刷新原生状态栏文字样式。这是期望行为（状态栏跟随主题）、非新增风险，但属本改动在 Capacitor 上的连带面，明确记下——auto 回归测试在 Capacitor 上应一并核状态栏样式跟随。
- 监听器泄漏是这里唯一的真坑，已用「开机一次 + 幂等守卫」钉死（见上）。

> 关联备注：Electron 的 Windows WCO 按钮色随主题刷新（[electron-custom-titlebar.md](electron-custom-titlebar.md) §主题同步）**依赖**本节的 watcher 来处理「auto 模式 + 系统实时切主题」时按钮色一并刷新。本节是其前置，先于它落地。

---

## 3. 测试计划

- `initThemeModeWatcher` 单测：`auto` mode 下模拟 matchMedia `change` → `applyThemeMode` 重跑（`.dark` 翻转、theme-color meta 刷新）；`dark`/`light` 固定 mode 下 `change` **不**触发重跑。
- `initThemeModeWatcher` **幂等性**：重复调用只注册一次监听（重复调 no-op）。
- E2E（浏览器可见）：三处 header 扁平后底色与正文一致、保留 `border-b` 分隔（方案对浏览器可见，靠 E2E 锁）。
- 浏览器 + Capacitor auto 主题回归：系统切明暗时 `.dark`/theme-color（及 Capacitor 原生状态栏样式）实时跟随、无闪烁。

## 4. 前提清单

**已核实（代码佐证，本轮 review 重核）**
- 待扁平的恰为 3 处内容 header（ChatPage/FileManagerPage/ModelConfigPage，均 `bg-elevated`+`border-b`）；`bg-elevated` 全量普查无其它内容 header 漏网。
- 移动端 header（`MobilePageHeader`/`MainList`）本就 `bg-default`+`border-b`；admin 桌面 header 本就无填充（`max-w` 居中页标题行，不同模式）；`DesktopSidebar`/`MobileBottomTabs` 是 chrome 导航面；`ManageClaws` 的是卡片——均不动。
- 主题唯一选点 `applyThemeMode`，已在此一处驱动 `.dark` class + `data-theme` 属性 + theme-color meta + Capacitor `syncStatusBarStyle` 四者（故 watcher 重跑即四者同步刷新；`syncStatusBarStyle` 在 web 上 no-op）。
- `resolveAppliedTheme` 仅 call 时读 `matchMedia`、全应用无 `change` 监听 → `initThemeModeWatcher` 监听 + 模块级 `activeMode` 均为净新增。`MediaQueryList.addEventListener('change')` 在项目基线（Safari 15+/Chrome 90+/FF 90+）均支持，无需 `addListener` 兜底。
- `src/main.js` 有真·开机一次的 `initElectronApp(router)` 同档序列，可挂幂等 watcher、不挂导航链；`applyUserPreferences` 另有登录/登出/注册/保存设置等多入口（`auth.store.js`），均不可作落点。

## 5. 实施与发布

1. 三处 header 扁平化 + 一致性穷举复扫（**可单独 commit**，纯 CSS 底色）。
2. `theme-mode.js` 的 `activeMode` + `initThemeModeWatcher`，落点 `src/main.js` 开机一次 + 幂等守卫。
3. 单测 + 浏览器/Capacitor auto 主题回归 + `pnpm check && pnpm test`。
4. **需 changeset**：改动落在 `ui/src/`、属 `@coclaw/ui` 包行为变更（按仓库 changeset 策略须声明）。本稿不碰 `ui/electron/`，与壳子版本无关。
