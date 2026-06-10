# Electron 自定义标题栏（作用域类模型）

> 状态：评审修订中（已折入两轮 codex + 独立 review 的发现，含 z 层级 `#app.isolate` 单值解；末轮确认中） ｜ 待实施 ｜ 2026-06-09
> 关联：[electron-desktop-shell.md](electron-desktop-shell.md)（壳子总体设计，本稿是其「自定义标题栏」专题增量）；**依赖** [header-flatten-auto-theme.md](header-flatten-auto-theme.md) 的 auto 主题 watcher（见「主题同步」）。
> 由原 `desktop-titlebar-coherence.md` 拆分并重构而来。
> 定位：**Electron 是次要、尽力而为的目标**；移动端（Capacitor）与 web 才是主目标。
> 影响范围：`ui/electron/`（主进程 + preload + ipc）+ `ui/src/`（标题栏组件 + App.vue 挂载逻辑 + 一段作用域 CSS + 三个惰性 marker 类：router-view 包裹 / 侧边栏 / toaster 视口）。

## 0. 硬约束（本稿的第一前提）

**本方案实施后，绝不能影响 web / Capacitor 的可用性，也不能让其变得脆弱、出现兼容性偶发问题。** Electron 标题栏是次要目标，不允许为它的观感去赌主目标的稳定性。本稿的架构选型（§3 作用域类）就是为满足这条约束而定。

## 1. 背景与问题

macOS Electron 下当前是**原生标题栏**（commit `9912b077` 把之前的 `hiddenInset` 删掉以止血红绿灯压内容）。由此顶部出现两条不同灰叠加：系统画的标题栏灰 ≠ 我们 `bg-elevated`（暗色 `#1b1b1b`）的侧边栏，红绿灯浮在系统那条上，观感割裂。浏览器无此系统条故不明显。

目标：走业界主流（VS Code / Slack / Linear / Discord）——**隐藏原生标题栏，但让系统继续画窗口按钮，我们只接管那条的背景与拖动**。不自己画按钮（`frame:false` 丢系统能力：Snap Layouts / 无障碍），也不给原生栏上色（mac 做不到）。

## 2. 为什么必须重构架构（而非沿用「全局变量减到每个满高根」）

拆分前的方案用一个全局 CSS 变量 `--electron-titlebar-h`（默认 0、custom 时 38px），把**每个满高根**（ChatPage 定高、侧边栏、AuthedLayout、登录/注册页）从干净的 `100vh`/`min-h-screen`/`h-dvh-safe` 改写成 `calc(100vh - var(...))`。多轮 review 反复在这套机制上捞出**只伤主目标**的 bug：

- 漏写 `:root` 静态默认 → 浏览器/Capacitor 下变量未定义 → CSS IACVT → `height` 退回 `auto` → ChatPage 定高塌、侧边栏失效（**主目标破版**）。
- App.vue 挂载逻辑未按 `custom` 收口 → 浏览器/Capacitor **每个用户**在挂载抛错。

根因：**那套机制把「Electron 专属功能」焊进了「全端共享的布局 CSS 与挂载路径」**——共享代码被改写后多了一层「靠默认值/守卫兜底」的脆弱面，漏一点就在浏览器/移动端偶发破版。这与 §0 的硬约束直接冲突。

## 3. 核心架构决策：作用域类隔离（把复杂度关进笼子）

**所有标题栏相关的布局偏移与复杂度，全部收进一个作用域类 `html.cc-electron-custom` 之下；web / Capacitor 永远不挂这个类，故其 CSS 行为逐字节不变、不可能被本功能改脆。**（精确表述：变的只是 **CSS 行为**——为让作用域覆盖有处可落，DOM 上会给所有端新增一个 router-view 包裹 wrapper、并连同侧边栏根 / toaster 视口共挂**三个惰性 marker 类**（`cc-app-content`/`cc-desktop-sidebar`/`cc-toaster-viewport`），它们无任何作用域规则命中、不改布局，但严格说不是「零 DOM 改动」，故主目标需补一条 DOM/layout 回归测，见 §10。）

- App.vue 仅在「自定义壳模式且非全屏」时给 `document.documentElement` 挂 `cc-electron-custom` 类。
- 一切偏移（内容下移、满高根减条高、侧边栏顶边、浮层避让）都写成 `html.cc-electron-custom <…> { … }` 的**作用域覆盖**。
- **不改业务页/布局的满高工具类**（不动 AuthedLayout / ChatPage / Login / Register / NuxtUiDemo / 侧边栏的 `min-h-screen`/`h-dvh-safe`/`h-screen`），改为在作用域下**覆盖工具类本身的行为**；只在 router-view 外层、侧边栏根、toaster 视口上各挂一个**壳级惰性 marker 类**（共三个：`cc-app-content`/`cc-desktop-sidebar`/`cc-toaster-viewport`；web 无规则命中、纯惰性，见 §5.2/§5.3）。

由此得到三个直接收益，正面回应 §0：

1. **主目标共享 CSS/布局行为不变、零新脆弱面**（DOM 上的 marker/wrapper 由 §10 回归锁住）：浏览器/Capacitor 匹配不到 `html.cc-electron-custom` → 那批 `min-h-screen`/`h-dvh-safe`/`h-screen` 工具类按 Tailwind 原义生效、与今天逐字节一致。**没有变量、没有 calc-with-var、没有 IACVT 风险。**
2. **闭集枚举的脆弱性消失**：作用域下覆盖的是**工具类**（见 §5.3），自动覆盖当前与未来所有用到这些工具类的满高根，无需逐页枚举、无需"漏一个就破版"的容错论证。
3. **失败模式搬了家**：万一某个 Electron 页面的偏移没覆盖到，坏的只是**那个 Electron 页面**（次要、尽力而为、可接受）——**永远不会是 web / Capacitor**。

这就是满足「不让主目标变脆」的关键：主目标根本不碰这套东西。

---

## 4. 壳子侧（`ui/electron/`）

### 4.1 主进程 + 平台决策模块

平台决策抽成**独立模块 `electron/window-chrome.js`**（ESM，与 `url-guard.js`/`locale.js` 同档）的纯函数 `buildWindowChrome(platform, { forceNative } = {})`，返回 `{ titleBarStyle, titleBarOverlay, custom }`——`custom`（本壳是否隐藏了原生栏）是**平台决策的单一真相源**。抽成独立模块的原因：`main.js` 顶层全是副作用（单实例锁 / `app.quit` / `registerProtocol` / `whenReady`），全仓无测试敢 import 它；本仓既定模式是把可测逻辑抽成独立模块（`url-guard`/`locale`/`ipc-handlers` 皆如此），纯函数留 `main.js` 内则 §10 的单测无从落地。

- **macOS**：`titleBarStyle:'hidden'` → 原生栏消失、系统保留红绿灯。
- **Windows**：`titleBarStyle:'hidden'` + `titleBarOverlay:{ color, symbolColor, height:38 }` → 系统以 WCO 画最小/最大/关闭，颜色由我们给。单写 `hidden` 会连按钮一起删，**必须**配 `titleBarOverlay`。
- **Linux**：本期不走（窗口装饰由桌面环境画、WCO 支持不统一），`custom:false`、保持原生栏。
- **backgroundColor**：设为 `#202122`（暗色 bg-default，app 默认主题 dark），避免 web 首帧前露白底闪。**取舍（如实记录）**：窗口创建期 main 拿不到用户已存主题，只能定一个固定色 → dark 用户受益（消除原白闪），但 light 用户新增一道暗闪（reload / 加载失败页时露 `#202122`，冷启多被 `show:false`+`ready-to-show` 遮住、reload 仍可见）；另 `#202122`（bg-default）与标题栏/侧边栏 `bg-elevated #1b1b1b` 还有一帧极轻色差，可接受、不另处理。固有取舍、不改实现。

`main.js` 据 `buildWindowChrome` 返回值设 `BrowserWindow` 选项，并把 `custom` 经 `webPreferences.additionalArguments`（如 `--cc-titlebar-custom=1`）下发给 preload。**平台判定 + §8 override 只此一处**，preload 只读不重算（§4.2）。

全屏：监听 `enter-full-screen`/`leave-full-screen` 转发渲染进程；另提供 `window:getFullScreen` handler 供渲染进程拉当前态。要点：①只认**原生全屏**——非全屏的 maximize/zoom（mac 绿钮填满但不进全屏）**不发**这两个事件，此时红绿灯/WCO 仍在、条必须保留（即「非全屏的 zoom/maximize 不摘类」）；②事件是 `isFullScreen` 唯一真相源、初值 `false`；③反向风险：`isFullScreen` 误卡 `true` 而窗口实为普通态 → 类被摘 → 红绿灯压内容（`9912b077` 复发），故事件不能漏/乱序，并配合当前态拉取（§4.2、§5.2）；④**逐窗口接线（两步分清、勿混为一句）**：`additionalArguments` 是**窗口创建期**写入——`new BrowserWindow({ webPreferences:{ additionalArguments:['--cc-titlebar-custom=1', …] } })` 时就定死，创建后无法再补；而 `attachWindowChromeEvents(win)` 是**窗口创建后**才调、只负责把 `enter/leave-full-screen` 监听挂到这个 `win` 上。两者都落在 `createWindow()` 内、对每个新建窗口各做一次——mac `activate` 在无窗口时会重建窗口，一次性全局注册会漏掉重建出来的新窗口。

### 4.2 preload（`preload.cjs`）

`electronAPI`（当前 `Object.freeze`，需扩字段；新增的 `titleBar` 子对象也一并 freeze，保持契约只读）新增：

- **`titleBar:{ custom }`**——壳子→web 的关键契约信号。**取自主进程实际决策、preload 不自行重算**：读 `process.argv` 里经 `additionalArguments` 下发的 `--cc-titlebar-custom` 标志（sandbox 化 preload 仍可读 `process.argv`，是 Electron 官方传值给沙箱 preload 的标准做法）。如此「平台判定 + §8 override」只在 `buildWindowChrome` 一处定，preload 永远反映壳真实状态。**反例（为何不让 preload 自己 `darwin||win32` 重算）**：§8 用 override 强制回落原生栏时，主进程已改回原生栏，但独立重算的 preload 仍得 `custom=true` → web 照挂类、照画条 → 在原生栏上叠加（`9912b077` 复发），回滚只生效一半。老壳 preload 无此读取逻辑 → web 读到 falsy → 不挂类、不画条、回落原生栏，零叠加。平台细分仍读现有 `electronAPI.platform`。
- **`setTitleBarOverlay(opts)`** → `invoke('window:setTitleBarOverlay', opts)`（仅 Windows 生效，主题同步用）。
- **`onFullScreenChange(cb)`** → 订阅 `window-fullscreen`（payload boolean），返回 unsubscribe（沿用现有 `subscribe` 封装）。
- **`getFullScreen()`** → `invoke('window:getFullScreen')` 向主进程拉当前全屏态（仿现有 `getPendingUpdate`）。**当前态必须经此 getter 取，不能用 preload 本地缓存式"订阅即回放"**——preload 是 reload 后的全新进程、不持有主进程全屏态，且 mac `setFullScreen` 异步、reload 不退全屏却也不再 emit `enter-full-screen`，本地缓存会在"全屏中 reload"下静默给出错误的非全屏值。**防陈旧覆盖**：getter 是异步 invoke，若 resolve 晚于已收到的实时 `enter/leave` 事件，旧值会覆盖新值（与项目"切主模型回跳=陈旧快照覆盖乐观值"同源）→ getter 结果只在"尚未收到任何 fullscreen 事件"时采用（一个 `primed` 标志，收到首个事件即置位、此后忽略 getter 回填）。

### 4.3 ipc-handlers（`ipc-handlers.js`）

- 新增 `window:setTitleBarOverlay`：取当前窗口，**仅在该窗口确实启用了 WCO 时**才调 `win.setTitleBarOverlay(opts)`，否则静默忽略（不要只判 `win32`）。**耦合备注**：`setTitleBarOverlay` 要求窗口创建时已启用 WCO 否则崩（Electron #34137）。正常 Windows custom 壳恒创建即带 `titleBarOverlay`，前提满足；但 **`forceNative` 就是「Windows 跳过 `titleBarOverlay`」那条路径**——此时 `custom:false`，theme-mode 那侧的 `custom` 门已挡住调用，故经正常调用链不会崩；handler 这道「按 WCO 是否启用再调」的护栏是防直接/未来调用方绕过 `custom` 门。**落地（须写具体、别留"记下"悬空）**：用一个模块级 `WeakSet<BrowserWindow>`（创建窗口启用 WCO 时 `add(win)`），或从 `window-chrome.js` 导出 `isWindowWcoEnabled(win)`；把它经 `registerIpcHandlers(getWin, isWcoEnabled)` 传进来，handler 判 `win && isWcoEnabled(win)` 才调——不要只判 `win32`（`win32 + forceNative` 时窗口没 WCO，只判平台会崩）。
- 新增 `window:getFullScreen`：返回 `win.isFullScreen()`。

---

## 5. Web 侧（`ui/src/`）

### 5.1 标题栏条组件

新组件 `ElectronTitleBar.vue`（**Options API**，遵 `ui/CLAUDE.md` 不用 `<script setup>`）：满窗宽、高 `var(--cc-titlebar-h)`（作用域内常量，见 §5.3）、`bg-elevated`、可拖动（同写 `app-region:drag` 与 `-webkit-app-region:drag`，新旧 Electron 都认）、`fixed top-0 inset-x-0 z-[60]`（盖在两列之上、不占流、不随内容滚动——OS 按钮固定在窗角，条也必须固定；`z-[60]` 取值与「为何只需这一个 z」的原理见 §5.4）。**条内内容（v1.1 修订，推翻最初「留空」决策）**：Windows（`platform === 'win32'`）在条左侧渲染品牌 logo+产品名——v1 留空后 Windows 端标题栏左侧空荡、不符合 Windows 惯例（系统栏/微软规范/主流自定义栏应用均为 icon 居左），故改放品牌并配套隐藏侧边栏品牌（§7）。尺寸间距按微软 title bar 规范（[titlebar-design](https://learn.microsoft.com/en-us/windows/apps/design/basics/titlebar-design)）：icon 16×16 距左 16px、标题文字距 icon 16px、caption 12px regular；品牌**不可点**、随整条拖拽区（不加 no-drag）、`aria-hidden` 维持。mac/Linux 条内仍留空（mac 身份由系统菜单栏+侧边栏承载，主流 mac 应用无「交通灯旁放品牌」先例）。`platform` 由 App.vue 取 `electronAPI.platform` 经 prop 下发，本组件仍不访问 Electron API（下款约束不破）。渲染门控：**父级（App.vue）先 `v-if="custom"`——web/Capacitor 下 `custom` 恒 false、本组件根本不被实例化/执行**（见 §5.2，杜绝其未来新增的生命周期/样式副作用经共享路径泄漏主目标）；本组件自身再 `v-if="!isFullScreen"`（`isFullScreen` 由 App.vue 作 prop 传入，子组件不自订阅 IPC）。**本组件不得在模块顶层或生命周期里访问 `window.electronAPI`/Electron API**——即便被 web 误导入，执行也须无副作用。

### 5.2 App.vue：类的唯一持有者 + 挂载时序

App.vue 是 `custom`/`isFullScreen` 的唯一持有者与 `cc-electron-custom` 类的唯一写入处（避免多处订阅产生两份状态、瞬时不一致）。template 现状仅 `<UApp :toaster><router-view/></UApp>`、router-view 外无包裹容器；script 已有 `mounted(){ initResize() }` / `beforeUnmount(){ destroyResize() }`，新逻辑须**并入既有钩子、勿覆盖**。

落地清单：

1. `<UApp>` 内挂 `<ElectronTitleBar v-if="custom" :is-full-screen="isFullScreen" />`——**父级 `v-if="custom"` 是关键的主目标护栏**：web/Capacitor 下 `custom` 恒 false、组件不被实例化（仅靠组件内部 v-if 仍会实例化、仍经共享路径）；组件内再 `v-if="!isFullScreen"` 处理全屏收起。
2. 给 `<router-view>` 套一层带 marker 类 `cc-app-content` 的包裹容器；**该 wrapper 必须是纯空壳——只挂 `cc-app-content` 这一个类，不带 `flex`/`grid`/`height`/`overflow`/`display:contents` 等任何样式**，故 web 上除多一个透明节点外零影响（作用域规则不命中、不改布局）。
3. 新增 `data` 持 `custom`/`isFullScreen`，**`custom` 初值 `false`、`isFullScreen` 初值 `false`**（`custom` 初值 false 保证父级 `v-if` 在收口判定前不误挂组件）。
4. **标题栏逻辑抽成独立方法 `initElectronTitlebar()`，在既有 `mounted` 里 `initResize()` 之后调用**——**切勿把 `if(!custom)return` 放到 `mounted` 顶部**，那会连 `initResize()` 一起跳过、桌面浏览器的 resize 初始化就没了；早返回只守住 `initElectronTitlebar()` 自己。方法内**顺序与同步性是关键（多轮 review 反复踩到的危险区）**：
   - **先 `const api = window.electronAPI; const custom = !!api?.titleBar?.custom; if (!custom) return;` 一道收口**——**必须走 `window.electronAPI`**：裸标识符 `electronAPI` 在浏览器是未声明全局、可选链也救不了、会直接抛 `ReferenceError`，等于每个浏览器用户在挂载抛错（恰是本架构要防的主目标破版从 JS 这层钻回来）。浏览器/Capacitor 下 `window.electronAPI` 为 undefined、老壳无 `titleBar` 字段；`custom===true` 这一个门同时兜住浏览器/Capacitor/老壳/Linux/原生栏/forceNative 全部"无条"分支。**收口通过后立即写 `this.custom = true`（data）**——否则根类虽挂上、但 `data.custom` 仍是 false，父级 `v-if="custom"` 不会挂出 `<ElectronTitleBar>`（条不渲染）。
   - **再在同步段内（任何 `await` 之前）按 `custom && !isFullScreen`（用 `isFullScreen` 同步默认值 `false`）给 `documentElement` 挂 `cc-electron-custom` 类**。Vue 初始挂载同步、首帧 paint 在整棵 mounted 跑完之后——类在同步段内挂上，作用域 CSS 即生效、首帧就让出 38px、不压内容。**切勿"先 `await getFullScreen()` 再挂类"**：那会把挂类推到 await 之后、可能晚于首帧 paint，自定义壳首帧无偏移 → 红绿灯/WCO 压内容（`9912b077` 复发在用户看到的第一帧、一两帧后才自纠；打包壳+真实 IPC 延迟下偶现，单测测不到）。
   - **紧接着、仍在同步段（`getFullScreen()` 之前）订阅 `onFullScreenChange` 接管实时事件**——订阅必须早于 getter，否则「挂类后、getter 前后」这段窗口里漏掉的 enter/leave 事件无从补回。
   - **最后异步 `getFullScreen()` 仅用于纠正"冷启即处于全屏"这一少数态**（resolve 后若为全屏则摘类）。**防陈旧覆盖**：先订阅后 getter，`primed` 标志在收到首个实时事件即置位、此后忽略 getter 回填（getter 若晚于实时事件 resolve，旧值不得覆盖新值）。最坏：冷启即全屏时首帧短暂多一条空带、随即塌缩——**无害方向**（远好于内容压按钮）。
5. **类的增删走 `isFullScreen` 的同步 watcher（`flush:'pre'`，与渲染同一次 flush）、禁止 defer 到 `requestAnimationFrame`/`setTimeout`/`flush:'post'`**——否则条 `v-if` 与作用域 CSS 跨帧 desync，离开全屏瞬间出现"红绿灯已回、留白还在/已无"的一帧压内容。
6. 在既有 `beforeUnmount` 内追加退订，**并 `document.documentElement.classList.remove('cc-electron-custom')`**——否则 HMR / 单测 / 异常重挂会把类残留在 `<html>` 上。

> **最易踩**：用裸 `electronAPI` 而非 `window.electronAPI`（浏览器全员 `ReferenceError`）、把 `if(!custom)return` 放到 `mounted` 顶部从而跳过 `initResize`、漏 `if(!custom)return` 收口、把挂类放到 await 之后（自定义壳首帧压内容）、订阅晚于 getter（漏全屏事件）、把类增删 defer 到下一帧（离开全屏一帧压内容）、漏退订或漏摘根类、新钩子覆盖掉 `initResize`/`destroyResize`。注意：只要 `window.electronAPI` 收口正确，即便其余 JS 全错，**也只伤 Electron**——web/Capacitor 因 `if(!custom)return` 直接返回、且根本没有作用域 CSS 命中。

### 5.3 作用域 CSS（本方案的隔离落点）

写在 `main.css`（或专用 `electron-titlebar.css`），**全部挂在 `html.cc-electron-custom` 之下**。**必须**作为不分层（非 `@layer`）的 author 规则写：Tailwind v4 把 utilities 放进 `@layer utilities`，未分层 author 规则优先级高于具名 layer 规则，故 `html.cc-electron-custom .min-h-screen` 能稳定盖过 `.min-h-screen`（已核实：项目 `main.css` 先 `@import "tailwindcss"`/`@import "@nuxt/ui"` 再写项目规则；`.h-dvh-safe` 本身也是项目的未分层规则，作用域版特异性更高、vh 与 100dvh 两分支都赢）。**禁止 `!important` / Tailwind important 模式**（会与作用域覆盖互相打架）：

```css
/* web / Capacitor 永不挂 cc-electron-custom → 以下规则对它们完全不存在 */
html.cc-electron-custom {
  --cc-titlebar-h: 38px;            /* 作用域内常量；web 看不到、无 IACVT 风险 */
}
/* 内容区让出条高（marker，惰性挂在 router-view 包裹容器上） */
html.cc-electron-custom .cc-app-content { padding-top: var(--cc-titlebar-h); }
/* 满高根：覆盖工具类本身 → 自动覆盖当前+未来所有用到它们的根，无需逐页改 */
html.cc-electron-custom .min-h-screen { min-height: calc(100vh - var(--cc-titlebar-h)); }
html.cc-electron-custom .h-dvh-safe   { height: calc(100vh - var(--cc-titlebar-h)); }
@supports (height: 100dvh) {
  html.cc-electron-custom .h-dvh-safe { height: calc(100dvh - var(--cc-titlebar-h)); }
}
/* 侧边栏：sticky 顶边下移 + 高度减条（marker，惰性挂在侧边栏根上） */
html.cc-electron-custom .cc-desktop-sidebar { top: var(--cc-titlebar-h); height: calc(100vh - var(--cc-titlebar-h)); }
/* 顶部浮层避让（toast teleport 到 body、仍是 html 后代，故能命中；+1rem 保留 Nuxt UI 默认 top-4 的 16px 视觉间距） */
html.cc-electron-custom .cc-toaster-viewport { top: calc(var(--cc-titlebar-h) + 1rem + var(--safe-area-inset-top, 0px)); }
```

要点：
- `min-h-screen` / `h-dvh-safe` 靠**覆盖工具类**自动覆盖全部满高根（闭集枚举不再是脆弱点；`h-dvh-safe` 的 Capacitor 分支在 Electron 下不渲染、互不干扰）。
- 内容包裹容器、侧边栏根、toaster 视口各需一个**惰性 marker 类**（`cc-app-content` / `cc-desktop-sidebar` / `cc-toaster-viewport`，共三个），因它们要调 `padding`/`top`、无法靠覆盖通用工具类精确命中；marker 在 web 上无任何作用域规则匹配，纯惰性。
- 变量 `--cc-titlebar-h` 只定义在作用域内，web 路径**完全没有**这个变量，从根上杜绝 IACVT。
- 全屏时摘掉 `cc-electron-custom` 类 → 以上全部失效 → 内容用满视口（全屏本就无条、无红绿灯），正确。

### 5.4 顶部浮层避让（自定义壳模式必做）

**toaster 避让**：桌面 toast 默认在右上（`App.vue` toasterConfig 桌面端 `top-right`），与 Windows WCO 同处右上、系统层永在 web 之上 → 不偏移则 toast 顶部/关闭按钮被系统按钮压（**Windows 必然碰撞**）。§5.3 的 `.cc-toaster-viewport` 偏移即为此（mac 同样需要以清开那条 38px bar）。落地需给 toaster 视口容器加 `cc-toaster-viewport` marker。列入 §10 测试 + §9 Windows 冒烟验收。

**z 层级：标题栏条只需 `z-[60]` 这一个值，不碰任何浮层 z（关键、前几轮 review 在此判错过）**。条只是「背景色带 + 拖动区」，系统画的红绿灯/WCO 是 OS 层、永远浮在整个 webview 之上、与 web 的 z 无关、永远可点。期望次序：`页面内容 < 标题栏条 < Nuxt UI 浮层 < toast`（浮层/toast 盖住条的色带是可接受的——OS 按钮仍在最上、关窗不受影响）。

**为何只需给条一个 `z-[60]`、不必抬升任何浮层**（前几轮判错的根因是漏看了 `#app` 的层叠隔离）：
- `index.html` 的 `<div id="app" class="isolate">` 即 `isolation:isolate`，**`#app` 自成一个层叠上下文**。条挂在 `#app` 内（`<UApp>` 内），其 z **被关在 `#app` 上下文里**——只与 `#app` 内页面内容比高低。页面内固定/sticky 元素 z 现状最高到 `z-50`（如 AuthedLayout、移动端下拉刷新/语音层），故条取 **`z-[60]`** 即稳压所有页面内容。
- Nuxt UI 浮层（modal/popover/select…）**全部 teleport 到 `body`**（已核实：项目无 `:portal="false"`，`usePortal` 默认 `to:'body'`；项目仅用 UModal/UPopover/USelect，均 teleport）。它们是 `#app` 的**根级兄弟、DOM 在 `#app` 之后**，故无论其 z 是 auto 还是别的，都**整体画在 `#app` 子树（含条）之上**——条天然在浮层之下，**无需给浮层加任何 z**；toast 视口 `z-[100]` 同理在最上。
- 结论：**不动 Nuxt UI 浮层主题、不加任何全局或作用域浮层 z 规则、不需要 grep 红线**。期望次序由「`#app.isolate` + 浮层 teleport 到 body」天然成立，条只管 `z-[60]` 压过页面内容这一件事。

**caveat（写明）**：此结论依赖三点——`#app` 保持 `isolate`、浮层保持 teleport 到 body、**且标题栏条本身留在 `<UApp>`/`#app` 内、绝不 `Teleport` 到 body**（否则条逃出隔离、与浮层同根上下文，`z-[60]` 反而压过 z-auto 浮层、模型失效）。若将来某浮层显式 `:portal="false"`（渲染进 `#app` 内），它会与条同上下文、可能被 `z-[60]` 盖住，那时须由该浮层自行让出条高；目前全项目无此用法。

**toaster 偏移仍要保留**：toast `z-[100]` 在条之上、且桌面默认右上与 WCO 同处，故仍须 §5.3 的 `.cc-toaster-viewport` 偏移清开按钮区（与本 z 结论无关、不可省）。**实机门禁**：modal（居中/fullscreen）、popover、select、toast 不被条遮、关闭按钮可点——并入 §8 release-blocking 实机逐项验。

## 6. 主题同步（Windows WCO 按钮色，`src/services/theme-mode.js`）

`applyThemeMode()` 是全应用切 `.dark` 的唯一选点。尾部追加：若 `window.electronAPI?.titleBar?.custom` 且平台 Windows，按 `appliedTheme` 调 `setTitleBarOverlay({ color, symbolColor, height:38 })`（同样**必须走 `window.electronAPI`**，理由见 §5.2）。

色值用**静态映射**（仿现有 `THEME_COLORS`，不读 DOM），已钉死成具体常量：`dark → { color:'#1b1b1b'（对应 main.css .dark --ui-bg-elevated）, symbolColor:近白 }`，`light → { color:'#f1f5f9', symbolColor:深色 }`。**`light` 的 `#f1f5f9` 来源（注释须写明）**：项目只覆盖了 `.dark` 的 elevated、且 `vite.config.js` 的 brand palette 只配了 primary/success/error/warning、**没配 neutral** → neutral 走 Nuxt UI 默认值 **`slate`**（已核实打包 app config 为 `neutral:"slate"`；注意 `old-neutral` 仅当 neutral 配成 `"neutral"` 时才生效，本项目不命中），故 light 走 `--ui-bg-elevated = --ui-color-neutral-100 = slate-100 ≈ #f1f5f9`。它是无 main.css 锚点的硬编码，**Nuxt UI 升级改默认 neutral、或项目将来配置 neutral 时须重新核对**；§10 色值断言即断这两个设计常量。mac 红绿灯彩色、系统自适应，无需同步。

三条约束：① **显式给色是必需**——Windows 上 `titleBarOverlay` 不显式给色不会跟随系统暗色（Electron #45958，won't-fix）；② **best-effort**——`setTitleBarOverlay` 走 `invoke`、失败会重抛 renderer，必须 `.catch(()=>{})` 吞掉，绝不影响 `.dark`/meta 主链；③ **首帧**——WCO 初值硬编码暗色，对**已登录** light 用户首次 `applyThemeMode(light)` 要等 `refreshSession`（HTTP 往返）才触发，慢网下深色按钮可持续到该调用 resolve（数秒、非"一瞬"）；登出/默认态 dark、与硬编码一致、无此问题。纯 Windows、纯按钮区观感，可接受。

> **依赖（限定范围）**：只有「auto 模式 + 系统实时切主题」时按钮色随之刷新这一项依赖 [header-flatten-auto-theme.md](header-flatten-auto-theme.md) 的 `initThemeModeWatcher`——它让 `.dark`+meta+WCO 色由 `applyThemeMode` 一处在 auto 切换时同时刷新，无需为 WCO 单独加监听，故那份先落地。**但静态 dark/light 映射本身不依赖该 watcher**（登录态切换即生效），即本稿不把主目标的主题行为变更捆进自己的阻断路径；WCO 的 auto 实时跟随是非阻断增强。

## 7. 品牌处理（`DesktopSidebar.vue`）

> **v1.1 修订（2026-06-10，用户确认）**：v1 曾因「标题栏条留空、不重复」把 `showSidebarBrand` 简化为恒显；现标题栏 Windows 分支改放品牌（§5.1），该前提失效，**恢复平台门控**。

`showSidebarBrand = !(isElectronApp && envStore.isWin)`：Windows Electron 隐藏侧边栏品牌行——品牌已在标题栏左侧（自定义栏自绘；`forceNative` 原生栏则系统自带 icon+标题，两种栏态都不重复）；macOS Electron / Linux Electron / 各浏览器保留（mac 标题栏不放品牌，侧边栏是窗口内唯一品牌锚点）。配套：品牌行隐藏时 `MainList` 补 `pt-2`（8px）顶间距，避免首个导航项贴顶（沿用 `ea4cd645` 的间距决策）。

## 8. 回滚与发布门禁（壳级决策不可 web 热修）

`titleBarStyle:'hidden'` 是**窗口创建期的壳级决策**，web 改不动它——条本身的**细节** bug（拖动手感/留白微调）web 能热修，但**壳级问题只能重发安装包 + 等用户更新**。最坏在 Windows：某 Win/Electron 组合 WCO 没画出按钮 → "原生栏没了 + 按钮也没画"（#34137 已被"创建即启用 WCO"规避，此处防更一般的壳级翻车）。

> **⚠️ 回退红线（hidden-bar 壳一旦在野即生效）**：web 那层"挂 `cc-electron-custom` 类 + 作用域 CSS + 画条"与壳的隐藏栏**强耦合、是不可独立回退的地板**——别被"web 能热修"误导成"标题栏出问题就 revert 掉 web 这层"。在已装隐藏栏壳的机器上，web 一旦退到此地板以下（不挂类/不画条），立刻落进 §9 版本错配第三行（红绿灯/WCO 压内容、`9912b077` 复发）。**真要应急回退标题栏，必须走 `forceNative` 重出安装包（或下方远端 kill-switch），不能只 revert web。** 首发期在野壳为 0、正向部署也安全，故此红线只在"壳已铺开 + 事后回退"时触发——正是测试/首发期不暴露、最易被运维误操作的时序。

- **发布前硬门禁（release-blocking）**：真机验"Windows 主流 Win10/11 上 WCO 画出三个按钮、随主题实时重绘、`env(titlebar-area-*)` 几何可读、§5.4 toaster 偏移后右上 toast 清开按钮区、**modal（居中/fullscreen）/popover/select/toast 均不被标题栏条遮挡且关闭按钮可点（验 §5.4 的 `#app.isolate` z 模型实际成立）**；mac 红绿灯正常"——**过不了不发**，写进发布 checklist。
- **保留一行回落能力**：`buildWindowChrome(platform,{ forceNative })` 收一个**构建期** override（`main.js` 读 env/常量传入，非运行时用户可切——打包后 env 对终端用户不可达），强制回落原生栏。因 `custom` 取自此处决策并经 `additionalArguments` 同步下发 preload，override 一处翻转、壳与 web 一起回落，无半回滚。价值：纠正版只需改一行 + 重出包。**⚠️ 若面向已在野用户出应急 `forceNative` 包，必须递增壳子版本（`extraMetadata.version`）**——electron-updater 按版本号判更新，同版本号不会被当成更新推送、已装用户收不到回退包（这是 §12「钉死 1.0.0 不 bump」的明确例外，见该处）。
- **OS 兜底**：即便按钮缺失，Windows 仍可 Alt+F4 / 任务栏关窗 / Alt+Space 系统菜单，mac 仍有应用菜单——降级、非死锁。
- **可选加固（v1 不强求）**：远端 kill-switch——壳启动读一个轻量 remote flag 决定 `hidden` 还是原生栏，线上出问题不必等重发、下次启动即回落。代价是远端基建 + 长期维护原生栏路径；前三道已压低风险且失败可 OS 兜底，v1 可不做。

## 9. 版本错配（壳子 ⇄ web 独立发布）

壳子始终加载远端最新 web（`im.coclaw.net`），安装的壳子版本与远端 web 版本相互独立、可错配。

| web | 壳子 | 结果 |
|---|---|---|
| 新 | 新（自定义栏） | ✓ 正确 |
| 新 | 老（原生栏） | ✓ web 读不到 `titleBar.custom` → 不挂类/不画条 → 原生栏正常 |
| 老 | 新（隐藏栏） | ✗ web 不挂类/不画条/不偏移 → 红绿灯/WCO 压内容（`9912b077` 复发） |

- **缓解一（信号）**：前端一律凭 `window.electronAPI?.titleBar?.custom` 决定挂不挂类，绝不凭 `isMac/isWin` 猜——把前两行钉死为正确。
- **缓解二（发布次序）**：**先部署并验证线上新 web，壳子的更新清单 `latest*.yml` 最后才传**。客户端启动约 30s 后自动查更新、`latest*.yml` no-cache，故把它当最后一道开关，新壳永远配到已上线的新 web，第三行不落到真实用户处。首发同理：先上线 web、再放出安装包下载。须写进 release 流程硬步骤。（注意此开关只覆盖**开启了自动更新的非 portable 安装包**；portable 版与关掉自动更新的用户不走 `latest*.yml`，须靠正向发布次序兜住、不能指望事后撤清单做回退。）
- **缓解三（回退红线）**：缓解二管正向次序；反向见 §8 回退红线——hidden-bar 壳在野后 web 不可退到地板以下。

## 10. 测试计划

- `buildWindowChrome(platform,opts)` 纯函数单测（独立模块、脱离 main.js bootstrap）：win/mac/linux 三分支 `titleBarStyle`/`titleBarOverlay`/`custom` 正确；`forceNative:true` 三平台均回落（`custom:false`、无 `hidden`）。
- `ipc-handlers.test.js`：`window:setTitleBarOverlay` 三类——窗口启用 WCO 时调到；`win32` 但 `forceNative`/未启用 WCO 时**不调**（防 #34137 崩）；非 Windows 不调；`window:getFullScreen` 返回 `win.isFullScreen()`。
- `theme-mode` 单测：Electron+Windows+custom 时 dark/light 切换各触发一次 `setTitleBarOverlay` 且色值正确（light 断言 §6 钉死的设计常量、非随手取的实现常量）；非 Windows / 非 custom 不触发。（auto 实时跟随由 header-flatten-auto-theme 稿的 `initThemeModeWatcher` 测覆盖。）
- `ElectronTitleBar.vue` 组件测：`isFullScreen` 真时不渲染、否则渲染且具 `app-region:drag`（本组件不再收 `custom` prop——父级 `custom` gate 由 App.vue 测覆盖：`custom=false` 时根本不挂出 `<ElectronTitleBar>`）；品牌分支：`platform='win32'` 渲染 logo+产品名且尺寸间距类符合微软规范（16×16 / 距左 16px / 距 icon 16px / 12px），`darwin`/缺省不渲染品牌。
- **App.vue 浏览器路径回归测（主目标保护，关键）**：`electronAPI` undefined（浏览器）时 mounted **不抛、不挂 `cc-electron-custom` 类、不订阅 `onFullScreenChange`**——锁住 `if(!custom)return` 收口。
- **App.vue 首帧同步（M-1）**：把 `getFullScreen` mock 成未决 promise，断言 custom 下 mounted 返回时 `documentElement` 已挂 `cc-electron-custom` 类（锁"同步先挂、异步只纠正全屏"）。
- 全屏：`isFullScreen` 初值 false；maximize（非原生全屏）不摘类；当前态经 `getFullScreen()`（非缓存）；`primed` 后实时事件不被陈旧 getter 回填覆盖。
- `showSidebarBrand` 平台门控回归锁（v1.1：Windows Electron 隐藏+`pt-2` 补偿；web / macOS Electron 保留、无 `pt-2`）。
- **生命周期/降级补项**：mounted 不跳过 `initResize`、`beforeUnmount` 调 `destroyResize` 且摘掉 `cc-electron-custom` 根类；`getFullScreen()` reject 时不抛、不影响挂类；`setTitleBarOverlay` reject 被 `.catch` 吞掉、不影响 `.dark`；preload 精确解析 `--cc-titlebar-custom=1`（无此 arg → falsy）；订阅 `onFullScreenChange` 早于 `getFullScreen()`。
- **DOM 回归（主目标，配合 §3 精确表述）**：浏览器/Capacitor 下 marker/wrapper 节点虽新增但不改布局——补一条各路由 DOM/layout（或关键容器结构）回归，锁住「惰性 marker 不影响主目标布局」。
- E2E：浏览器里 `titleBar.custom` 恒 falsy、不挂类，故标题栏条 E2E 测不到（靠组件/单测）。
- **打包壳冒烟（发布门禁，非单测能替代）**：mac/Windows 打包壳截图验 reload、全屏中 reload、`activate` 重建窗口、modal/popover/select/toast 不被条遮（slideover/drawer/tooltip 当前项目未用，引入时一并验）、首帧不压内容——单测只能证明 mounted 返回时类已挂，证不了打包壳真实首帧。

## 11. 前提清单

**已核实（代码佐证，沿用拆分前结论）**
- `isElectronApp`、`envStore.isMac/isWin` 可用；preload 现无标题栏字段（净新增）、`subscribe` 封装可复用、`Object.freeze` 需扩字段。
- `additionalArguments` 注入到渲染进程 `process.argv`、沙箱 preload 可读（electron.d.ts v41.0.2 核实，官方传值标准做法）。
- `main.js` 顶层重副作用、无单测 → 抽 `buildWindowChrome` 独立模块才能单测（既定模式）。
- 满高根工具类分布（`min-h-screen` = AuthedLayout×3 + Login/Register/NuxtUiDemo；`h-dvh-safe` 非 Cap = ChatPage；`h-screen` = 侧边栏）已核实；作用域覆盖工具类即全覆盖，且**主目标不命中**。
- App.vue 现状（`<UApp><router-view/></UApp>` + 既有 `mounted/beforeUnmount`）。
- `main.js` 当前无 `titleBarStyle`，`show:false`+`ready-to-show` 等与本改动不冲突。
- 项目惯例一律走 `window.electronAPI`/`globalThis.electronAPI`（见 `src/utils/platform.js`），无裸 `electronAPI` 写法——设计稿代码片段须同此（首轮 review 实证）。
- Tailwind v4 未分层 author 规则稳定盖过 `@layer utilities`（已核实 `main.css` import 次序与 tailwindcss 打包结构；首轮 review 实证）。
- z 层叠现状（两轮 review 实证、决定 §5.4 的 `z-[60]` 单值解）：`#app` 带 `class="isolate"`（`isolation:isolate`，自成层叠上下文，index.html）；Nuxt UI 浮层全部 teleport 到 `body`（无 `:portal="false"`，`usePortal` 默认 `to:'body'`；项目仅用 UModal/UPopover/USelect）；toaster 视口 `z-[100]`、modal/popover 面板自身无 z-index。→ 条挂 `#app` 内、z 被隔离，只需 `z-[60]` 压过页面内固定层（现状最高 `z-50`）；浮层经 teleport 天然在 `#app` 之上，无需改任何浮层 z。

**待验证（需 mac/Windows 实机，本环境无法）**
- **【release-blocking，见 §8】** Windows Win10/11：WCO 画出三按钮、随主题重绘、`env(titlebar-area-*)` 可读、toaster 偏移后清开按钮区。
- mac：红绿灯在 38px 条内贴合（`app-region:drag` 不挡其点击属 VS Code/Slack 标准做法，仍冒烟）；`enter/leave-full-screen` 触发、条正确收起；全屏中启动/reload 当前态拉取正确；maximize 下条保留。
- mac：ChatPage 在 custom 下输入栏不被顶出屏（截图验收）。
- 顶部浮层避让：modal/popover/select/toast 与条互不遮挡（§5.4）。
- App 根 + 作用域 CSS 下各路由（login/register/about/admin/ChatPage）无多余过滚/无输入栏截断、sticky 正常，跑构建逐路由确认。

## 12. 实施顺序

1. 壳子侧：`electron/window-chrome.js`（纯函数）+ `main.js` 据其设窗口选项并经 `additionalArguments` 下发 `custom` + preload `titleBar`/`setTitleBarOverlay`/`onFullScreenChange`/`getFullScreen` + ipc 两个 handler。（先有信号）
2. Web 侧：`ElectronTitleBar` + App.vue 挂载逻辑（**严格按 §5.2 的收口/同步纪律**：`window.electronAPI` 收口 + `this.custom=true` + 抽出 `initElectronTitlebar()`（`initResize` 不跳过）→ 同步挂类 → 同步订阅 `onFullScreenChange` → `getFullScreen()` 异步纠正全屏 → 同步 watcher 不 defer → 卸载摘根类，全部并入既有钩子；`<ElectronTitleBar>` 由父级 `v-if="custom"` 门控、wrapper 为纯空壳）+ §5.3 作用域 CSS（含三个惰性 marker：router-view 包裹 / 侧边栏 / toaster 视口）+ §5.4 条 `z-[60]`（不碰浮层 z）与 toaster 偏移 + §6 主题同步（WCO 色，light=`#f1f5f9` 钉死）+ §7 `showSidebarBrand` 简化。
3. 单测（尤其 **App.vue 浏览器路径不挂类不抛**、M-1 首帧同步）+ mac 实机验 + `pnpm check && pnpm test`。
4. 发布：**先上线并验证新 web、`latest*.yml` 最后才传**（§9），过 §8 的 Windows WCO 硬门禁。
   - **需 changeset**：改动落在 `ui/`（`src/` 标题栏组件/挂载逻辑/作用域 CSS + `electron/` 壳子码），均 `@coclaw/ui` 包行为变更（一条 changeset 同时覆盖壳子改动，是已定调整）。
   - **壳子版本 `extraMetadata.version` 暂不 bump、维持 `1.0.0`**：electron/capacitor 客户端尚未正式发布，版本钉死在 `1.0.0`；待正式发布后由用户示意才按 `docs/versioning.md` 恢复正常 bump。**例外**：一旦已有在野壳、又要出应急 `forceNative` 回退包推给已装用户，则必须递增版本号（见 §8），否则 electron-updater 不当成更新。
