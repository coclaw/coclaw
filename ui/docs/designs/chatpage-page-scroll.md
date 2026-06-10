# ChatPage 内容区滚动 → 页面级滚动迁移设计稿

> 状态：方案成稿、暂缓实施（2026-06-11）。由 Plan subagent 产出，主线已初审。其中 Electron 滚动部分已按「修订（2026-06-11）」小节先行落地（[electron-custom-titlebar.md](electron-custom-titlebar.md) 已同步）；其余待重启实施时按本稿 + 修订节执行。

## 1. 背景

- 动机：Electron 客户端内容区滚动条悬在窗口中部难看，希望滚动条回到视口边缘，与 qidianchat（页滚已在 iOS 真机长期验证）一致。
- 代码已有预埋：ChatPage 头注释自称 h-dvh-safe 为临时方案（ChatPage.vue:2-8）；ChatInput footer 已写 `sticky bottom-0 z-10`（ChatInput.vue:2）；MobilePageHeader 已写 `sticky top-0 z-10`（MobilePageHeader.vue:2）。两处 sticky 当前不生效的根因是 ChatPage 根 `overflow-hidden`（ChatPage.vue:9）让 sticky 的滚动口落在一个不滚动的祖先上。
- 当年页滚失败根因（已考古复核）：AuthedLayout section 仅 min-height 不定高，ChatPage 根用 flex-1 时 flex-basis:0% 在不定高列解析为 max-content，整页被消息撑开、header/footer 滚出视口（chat-layout-fix SKILL.md:18-24）。**关键认知：那个「bug」的「页面随内容长高」在页滚架构下正是期望行为；当年缺的是 header/footer 的 sticky 兜底与配套滚动逻辑，而非页滚本身不可行。**

## 2. 目标布局架构（分端）

### 2.1 核心决策一：Capacitor 原生壳这次不动（推荐）

理由：
1. 壳内无可见滚动条，迁移零视觉收益（动机只关 Electron/Web）。
2. 壳内键盘链路（`keyboardDidShow→scrollIntoView` capacitor-app.js:194-210 + `resizeOnFullScreen` capacitor.config.ts:12-14 + h-dvh-safe 的 JS 覆盖 safe-area 变量）已稳定验证，页滚会重开 Android webview 键盘/safe-area 这摊工作。
3. 壳模式由 AuthedLayout 根 `h-dvh-safe overflow-hidden`（AuthedLayout.vue:100）统摄全部页面；动它意味着 TopicsPage/FileManagerPage 等全壳内页面联动审计。
4. 双模式的代码代价被一个小「scroller 适配器」收口为近零（见 §3），不会在十几个几何点上铺 if/else。

代价与对策：ChatPage 长期保留两种滚动模式。对策＝所有滚动几何/写入收口到单一 adapter，逻辑单路径；头注释与 chat-layout-fix skill 重写为新架构说明。

### 2.2 核心决策二：header/footer 用 sticky 而非 fixed（推荐）

| | sticky（选用） | fixed（qidianchat 路线） |
|---|---|---|
| 让位 | 在流内，零补偿 | 需动态 paddingTop：qidianchat 为此养了一个 ResizeObserver + setTimeout（Topic.vue:2862-2877），是其代码里最绕的一段 |
| 既有预埋 | ChatInput.vue:2、MobilePageHeader.vue:2 已写好 | 全推倒 |
| 浮动锚点 | footer 是 positioned，回底按钮/SlashCommandMenu 的 absolute 锚（ChatPage.vue:185-205）原样可用 | 需重锚 |
| 内容短于视口 | 配合 flex min-height，footer 仍贴底（见 §2.3） | 天然贴底 |
| iOS 橡皮筋 | 随文档弹动 | 现代 iOS 上 fixed 同样弹动，非差异点 |

sticky 生效三条件（落地时必须满足）：
1. sticky 元素到视口之间无 `overflow != visible` 祖先 → 删 ChatPage 根 `overflow-hidden`；body 的 `overflow-x: hidden`（main.css:53）因 body overflow 向 viewport 传播的特例不破坏 sticky，已核实无碍。
2. 保留 `bg-default` + `z-10` 防内容透底（两处预埋均已带）。
3. 桌面 header（ChatPage.vue:47，目前非 sticky）补 `sticky top-0`。

### 2.3 各端布局

**Web（桌面+移动）**

```
AuthedLayout（不动）: root min-h-screen → .flex min-h-screen → section flex min-h-screen flex-col + safe-area padding
ChatPage 根:  relative flex flex-col + flex-1            ← 删 h-dvh-safe、删 overflow-hidden
  MobilePageHeader / 桌面 header:  sticky top-0 z-10 bg-default（桌面 header 补 sticky + 加 cc-page-sticky 标记类）
  main:  flex-1 overflow-x-hidden                        ← 删 min-h-0、删 overflow-y-auto、保留 ref 与 @wheel
  ChatInput footer:  sticky bottom-0 z-10 bg-default（已预埋，不动）
```

- 内容长 → 根随内容长高 → 文档滚动，滚动条贴视口右缘；sticky 钉住 header/footer。
- 内容短 → section min-h-screen + 根 flex-1 + main flex-1 的标准 flex sticky-footer 模式把 footer 压到视口底（TopicsPage.vue:2 已有同型「双性类」先例：定高父内滚、不定高父页滚）。
- min-h-screen 是 100vh 而非 dvh，iOS 工具栏展开时页面比可视区高一截——sticky bottom-0 以滚动口（布局视口）为基准，footer 仍可见，仅留工具栏高的可滚空白，可接受；不为此改 AuthedLayout（影响全站）。
- 当年崩坏的反向保险：新 e2e 断言「任意滚动位置 header.top≈0 且 footer.bottom≈innerHeight」（§7）。

**Electron（含自定义标题栏）**

- Electron 走 web 分支（platform.js:15,21：`isCapacitorApp=false`）。
- 标题栏是 `fixed top-0 z-[60]` 色带（ElectronTitleBar.vue:16），内容靠 `.cc-app-content{padding-top:38px}` 让位（main.css:124-126）。sticky top-0 的 header 滚动时会钻进标题栏下面 → 新增作用域规则（沿用 main.css:140-143 的 marker 模式）：
  ```css
  html.cc-electron-custom .cc-page-sticky { top: var(--cc-titlebar-h); }
  ```
  标记类挂两处：ChatPage 桌面 header、MobilePageHeader 根（后者顺带修好 Electron 窗口缩到 <768px 时所有子页面 header 钻标题栏的存量隐患——Electron minWidth=360，electron/main.js:61，MobilePageHeader 确实可在 Electron 出现）。
  注（主线初审补充）：`--cc-titlebar-h` 变量是否已定义待落地时核实，若无则在 main.css 标题栏作用域内一并定义。
- `html.cc-electron-custom .h-dvh-safe` 覆盖（main.css:131-138）迁移后只剩 Capacitor 用 h-dvh-safe、而 Capacitor 永不挂 cc-electron-custom → 该规则变死代码，随本次清理删除；`.min-h-screen` 覆盖（main.css:128-130）继续承载 AuthedLayout 链路，不动。
- toast 避让（main.css:145-147）、侧栏（main.css:140-143）不动。

**Capacitor 壳**：AuthedLayout.vue:100 与 ChatPage 壳分支（`flex-1 min-h-0` + main `flex-1 min-h-0 overflow-y-auto`）逐字节不变；sticky 在壳内继续惰性（根 overflow-hidden 保留在壳分支）。

**移动 Web**：同 Web 布局；键盘见 §6；Android 原生下拉刷新冲突见 §5。

**附带小项**：拖拽蒙层 `absolute inset-0 ... items-center justify-center`（ChatPage.vue:209-214）在根变高后提示文字会居中到屏外 → 改 `fixed inset-0`（z-20 仍低于标题栏 z-60；视觉上会盖到侧栏，可接受，pointer-events-none 无交互影响）。两个 pull 指示器本就 `fixed`（ChatPage.vue:92、AuthedLayout.vue:6），不动。

## 3. 滚动逻辑迁移：scroller 适配器

新建 `ui/src/utils/chat-scroller.js`：

```js
export function createElementScroller(el) { /* scrollTop(get/set)、scrollHeight、clientHeight 直通 el */ }
export function createPageScroller() {
  const se = () => document.scrollingElement; // 标准模式 = documentElement，基线全支持
  return { get scrollTop(){...}, set scrollTop(v){...}, get scrollHeight(){...},
           get clientHeight(){ return se().clientHeight; } }; // clientHeight 用 scrollingElement（排除滚动条），不用 innerHeight
}
```

- ChatPage `mounted` 选型：`this.__scroller = isCapacitorApp ? createElementScroller(main) : createPageScroller()`。
- 全部 13 处 `this.$refs.scrollContainer` 几何读写（ChatPage.vue:1142,1179,1184,1196,1204,1240,1256,1281 等）机械替换为 `this.__scroller`；挂载前调用的守卫由 `!el?.scrollTo` 改 `!this.__scroller`（语义等价，今天挂载前 $refs 也为空）。
- **scrollToBottom（:1141-1171）**：结构不动（force / userScrolledUp / __loadingHistory 锁 / nextTick+rAF 兜底 / __scrollReady 解锁全保留），仅把 `el.scrollTo({top: el.scrollHeight})` 换为 `scroller.scrollTop = scroller.scrollHeight`（同步赋值，行为 auto，免去 jsdom window.scrollTo 未实现的噪音）。qidianchat 的 scrollIntoView 兜底是为老浏览器兼容（dom-helper.js:67-69 注释），我们基线 Chrome90/Safari15 无此需求，不抄。
- **__scrollReady 首屏防闪（:106,:272）**：机制不依赖滚动源，页滚下依然成立——内容 visibility:hidden 直到 force 滚底完成；唯一变化是「闪」从 main 内变成文档级，遮挡范围相同（只遮 scrollContent）。保留。
- **事件挂载**：
  - `@wheel` 保留在 main（wheel 是冒泡事件，与谁滚动无关，页滚下照常命中，且天然限定「指针在消息区上方」的语义，与今天一致）。
  - `@scroll` 保留在 main（仅壳内触发）+ `mounted` 无条件加 `window.addEventListener('scroll', onScroll, {passive:true})`（仅 web 触发；壳内根 overflow-hidden，window 不滚，互不干扰）。两路共用同一 onScroll，内部只读 adapter。beforeUnmount 成对移除。
- **ResizeObserver（:683-692）**：保留观察 main + scrollContent（内容生长：流式、图片、表格）；新增观察 ChatInput 根（`this.$refs.chatInput?.$el`，覆盖「输入框撑高」——页滚下 footer 变高不再改变 main 几何，旧观察对象捕不到，见 §6）；新增 `window.addEventListener('resize')` → `__refreshFarFromBottom() + scrollToBottom()`（覆盖视口变化：窗口缩放、Android resizes-content 键盘）。壳内这些新增项冗余但幂等无害，不做平台分支。
- **底部判定（onScroll :1183-1192、__refreshFarFromBottom :1178-1182）**：公式不变，几何换 adapter；60px / 1 屏阈值语义不变（clientHeight 即视口高）。iOS 橡皮筋负 scrollTop 在 `dist>=60`、`scrollTop<=0` 判定下天然安全。

## 4. 历史加载位置保持（高风险区）

4 个入口的改写：

| 入口 | 现状 | 改法 |
|---|---|---|
| onScroll `scrollTop<50`（:1190） | el.scrollTop | adapter.scrollTop，window scroll 监听驱动 |
| wheel 且 `scrollTop<=0`（:1194-1199） | el | adapter；@wheel 原位保留 |
| 触屏下拉 __onPull*（:1202-1235，注册 :697-704） | touch 事件挂 main、`el.scrollTop>0` 早退 | touch 监听原位保留（触摸事件冒泡，不依赖谁滚动）；判定换 adapter.scrollTop |
| __autoFillHistory（:1238-1244） | `scrollHeight<=clientHeight` | adapter 同式；「文档不可滚→继续填」语义等价（页滚下 scrollHeight 含 header/footer，下限即 clientHeight，条件成立性不变） |

**prepend 补偿（:1256-1270、:1281-1291）**：算法原样保留——load 前快照 `prevScrollTop/prevScrollHeight`，nextTick 后**绝对赋值** `scrollTop = prev + (newH - prevH)`，仅几何源换 adapter。三浏览器矩阵：
- Safari（无 scroll anchoring）：绝对赋值独立算出正确目标，覆盖。
- Chrome/Firefox（文档级有锚定）：绝对赋值天然「盖住」锚定调整、不会双倍位移——这正是现有代码在元素容器上已验证过的同一技术（:1256-1259 注释）。另两重让锚定大概率根本不参与：规范规定滚动偏移为 0 时抑制锚定（拉历史常发生在顶部）；main 因 overflow-x-hidden 计算为 overflow-y:auto 成为嵌套滚动容器，其内部节点可能被排除出视口锚定候选。**方案不依赖任一锚定行为，显式补偿是唯一权威**；Chrome 实测无跳位列入待验证 V4。
- 身份比对防错位（targetStore 快照、__unmounted 检查 :1264,:1285）原样保留。

**与全局下拉刷新（use-pull-refresh）的冲突重审**：ChatPage 挂载即全局 suppress（ChatPage.vue:676、use-pull-refresh.js:37-48），页滚下依旧成立，无需改。注意一个潜伏细节：isScrolledToTop（use-pull-refresh.js:21-31）从触点向上找 `overflowY: auto|scroll` 祖先——迁移后 main 计算值为 auto 且 scrollTop 恒 0，该函数在 ChatPage 上会恒真；因 suppress 兜底无实际影响，但在 use-pull-refresh.js 加一行注释说明此依赖，防止未来撤 suppress 时踩坑。

**新增冲突（仅 Android Chrome 移动 web）**：页滚顶部下拉会触发浏览器原生 pull-to-refresh，与拉历史手势打架 → `html, body { overscroll-behavior-y: contain; }`（Chrome 63+；Safari 15 不识别属性、无害降级且 iOS 本无原生 PTR；contain 保留 iOS 局部回弹只断链）。顺带修复其他页面「自定义 PTR + 原生 PTR 双触发」的存量问题。真机验证列 V5。

## 5. 路由滚动治理

- **keep-alive：已核实不存在**——全 src 仅命中 Capacitor KeepAlive 原生插件（capacitor-app.js:212-217，是后台保活服务，与组件缓存无关）；App.vue:6 与 AuthedLayout.vue:30 的 router-view 均无 KeepAlive 包裹。无缓存恢复问题。
- router/index.js:146-149 加：
  ```js
  scrollBehavior(to, from, savedPosition) { return savedPosition || { top: 0 }; }
  ```
  - 新导航回顶：解决「从滚到很深的 chat 切去 Topics 列表残留滚动位」的新问题（迁移前 main 卸载即自然归零，迁移后位置在 window 上跨页残留）。
  - ChatPage 不做专门分支：进入后 `__onConnReady` 的 force 滚底（:1040-1048）是权威落点，scrollBehavior 的 top:0 只是消息加载前的过渡；返回（savedPosition）到 chat 同理被 force 滚底覆盖，与现状「切 chat 无滚动记忆」（:632-643 重置）一致。
  - 列表页返回恢复（savedPosition）是顺手的体验增量，异步内容下尽力而为即可，不做滚动恢复 promise（反过度设计；qidianchat 的恢复也是注释禁用态，Topic.vue:2326-2334）。
  - Capacitor 壳：window 不滚，scrollBehavior 写 top:0 为 no-op，内滚容器随组件卸载自然复位——零影响。

## 6. 移动端键盘

- **不引入 visualViewport，论证**：(1) qidianchat 同架构 iOS 真机多年零补偿代码，靠 WebKit「聚焦元素自动平移入视口」白捡（已核对其代码确无 visualViewport）；(2) 我们的粘底判定基于文档几何，键盘以 resizes-visual 方式出现时文档几何不变，逻辑天然不受扰动；(3) 用 visualViewport 手动重钉 footer 是与 UA 平移行为对抗的经典 jank 源。聚焦输入框在 sticky footer 内、footer 在文档末尾，WebKit 的 focus-reveal 即足够。
- **Android Chrome**：键盘默认 resize 行为（108+ 是否默认 resizes-visual）列待验证 V1；**无论结论如何**，在 index.html:5 viewport meta 追加 `interactive-widget=resizes-content` 把行为钉死为「布局视口缩小」→ 走 window resize → scrollToBottom 粘底，footer 永在键盘上方；iOS 忽略该字段。
- **iOS「打字撑高输入框」**：页滚下由新增的 footer ResizeObserver 触发 scrollToBottom（非 force，尊重 userScrolledUp）补齐被撑掉的底部距离。qidianchat 在 iOS 非微信浏览器禁了这条路径（Topic.vue:2839-2847），但其诱因绑定在「fixed footer + env(safe-area-inset-bottom) padding」组合上；我们 sticky footer 且浏览器态 env=0，不预防性照抄禁滚——先全平台启用，iOS 真机走查（V3），复现则按 qidianchat 先例加平台门控（一行 if），有成熟退路。
- **Capacitor**：不动（keyboardDidShow→scrollIntoView 链路原样，capacitor-app.js:194-210）。

## 7. 测试迁移

**单测（ChatPage.test.js，93 处 scrollContainer 引用，jsdom，platform mock isCapacitorApp:false :73-74）**
- 测试缝隙从「对 $refs.scrollContainer defineProperty（:1903-1996 模式）」改为「替换 `wrapper.vm.__scroller` 为普通 stub 对象 `{scrollTop, scrollHeight, clientHeight}`」——比现在的 defineProperty 体操更干净，~25 个用例机械迁移；scrollTo 断言改为断言 stub 的 scrollTop 终值。
- 新增：adapter 选型单测（web→page / capacitor→element）；router scrollBehavior 纯函数单测；ChatPage 根/main/header 类名 DOM 回归（参照 App.test.js:79-83 风格，锁「web 模式根无 overflow-hidden、header 含 sticky cc-page-sticky」）。

**e2e**
- `chat-layout-debug.e2e.spec.js`（断言语义反转，:62-71/:86-90）改为新不变量：注入 50 条 → 文档可滚（scrollingElement.scrollHeight > clientHeight）；main 不内滚（main.scrollHeight ≈ main.clientHeight）；**防「页面被撑开」复发的反向断言：window.scrollTo 到 0/中部/底部三个位置，每个位置断言可见 header.getBoundingClientRect().top ≈ 0（容差 1）且 footer.bottom ≈ innerHeight**——当年 bug 的表现恰是 header/footer 滚出视口，sticky 不变量直接覆盖；追加短内容态断言 footer.bottom ≈ innerHeight（flex 兜底没碎）；追加 Electron 形态：evaluate 给 html 挂 `cc-electron-custom` 类后断言 header.top ≈ 38（纯 CSS 可测）。
- `chat-back-to-bottom.e2e.spec.js`：helpers 的 main.scrollTop 操纵（:29-35）与 distFromBottom（:64-65）换 window/scrollingElement 几何，window 滚动天然派发 scroll 事件、可删手工 dispatchEvent。
- `pull-refresh.e2e.spec.js`：「确保滚到顶」（:166-169）改 `window.scrollTo(0,0)`；触摸合成与 suppress 断言不变。
- chat-layout-fix SKILL.md 与 ChatPage 头注释同步重写（新架构、新禁忌表：「web 模式禁止给 chat 根加 overflow-hidden/定高」）。

## 8. 渐进与回滚

**一把切，不加运行时开关**（符合反过度设计原则）：改动面收敛于 ChatPage 一页 + 少量 CSS/router，Capacitor 不动即天然保住一端基本盘；回滚 = git revert，无数据/协议耦合。PR 内分两个 commit 保 bisect 能力：
1. **Commit 1（零行为变化）**：引入 chat-scroller adapter，两模式都先走 element scroller；单测换 stub 缝隙；全绿——证明纯重构无回归。
2. **Commit 2（切换）**：web 模式换 page scroller + window scroll/resize 监听；模板类调整（根/main/桌面 header sticky/拖拽蒙层 fixed/cc-page-sticky 标记）；main.css 增 Electron sticky 偏移规则、删 h-dvh-safe electron 死规则、加 overscroll-behavior；viewport meta 加 interactive-widget；router scrollBehavior；e2e 三件迁移 + 新断言；注释/skill 重写。
3. **合并前置**：iOS Safari 真机（键盘、撑高输入框、橡皮筋）、Android Chrome 真机（键盘、原生 PTR）、Electron mac/win（标题栏偏移、<768px 窗口、滚动条位置）、Capacitor 壳回归（确认逐字节不变路径）。

## 9. 前提清单

已核实（关键项，file:line 见上文行内引用，此处汇总最 load-bearing 的）：
- 【已核实 ChatPage.vue:9,303-305】根双模式与 overflow-hidden 是 sticky 失效根因
- 【已核实 ChatInput.vue:2 / MobilePageHeader.vue:2】sticky 预埋存在且带 bg+z
- 【已核实 AuthedLayout.vue:98-123】web=min-h-screen 不定高、壳=h-dvh-safe overflow-hidden、section safe-area padding
- 【已核实 main.css:37-44,120-147 / ElectronTitleBar.vue:16 / App.vue:5】Electron 标题栏 fixed 38px + cc-app-content padding + marker 类覆盖机制
- 【已核实 ChatPage.vue:1141-1171,1183-1199,1202-1244,1256-1291】滚动/底判/4 入口/绝对赋值补偿全逻辑
- 【已核实 grep 全 src + App.vue:6 + AuthedLayout.vue:30】无组件级 keep-alive；【已核实 router/index.js:146-149】无 scrollBehavior
- 【已核实 use-pull-refresh.js:21-48 + ChatPage.vue:676】window.scrollY 回退与 suppress 机制
- 【已核实 dom-helper.js:67-78 / Topic.vue:2313-2336,2820-2823,2839-2877】qidianchat 页滚四件套（window 几何判底、document scroll 监听、对话框守卫、iOS 禁滚角落、fixed+padding 让位成本）
- 【已核实 vite.config.js:13】基线 Chrome90/Edge90/Safari15/FF90；【已核实 index.html:5】无 interactive-widget；【已核实 grep】全仓无 overscroll-behavior
- 【已核实 electron/main.js:61】minWidth 360 → Electron 会出现 MobilePageHeader
- 【已核实 TopicsPage.vue:2 / DesktopSidebar.vue:3】页滚先例类与 sticky 侧栏天然适配
- 【已核实 vitest.config.js:9 + ChatPage.test.js:73-74,1903-1996】jsdom、platform mock、93 处 scrollContainer mock 模式
- 【已核实 capacitor.config.ts:12-14 / capacitor-app.js:194-210】壳内键盘链路

待验证：见 §10 V1–V7。

## 10. 风险矩阵 + 验证计划

| 风险 | 级别 | 理由与对策 |
|---|---|---|
| 历史 prepend 位置保持（文档级首试 × 三浏览器锚定差异 × 4 入口） | 高 | 绝对赋值补偿已在元素级验证过同类问题；V4：Chrome/Safari/FF 手动拉历史观察跳位；e2e 补 prepend 位置保持断言 |
| iOS 移动 web 键盘 ×sticky footer（先例是 fixed footer，机制非完全同源） | 高 | V3 真机走查：聚焦弹键盘 footer 可见性、打字撑高是否复现 qidianchat glitch；退路=照抄平台门控禁滚一行 |
| Reka(Nuxt UI) modal body 锁滚与 window 滚动状态互踩（iOS position:fixed 式锁会把 scrollY 清零→userScrolledUp 误置） | 中 | V2：chat 滚中部开 ImgViewDialog 查 body 样式与 scrollY；若实锤，onScroll 加 data-scroll-locked 守卫（qidianchat Topic.vue:2820 同类先例） |
| Android Chrome 键盘 resize 默认行为不确定 | 中 | V1：真机比对 innerHeight vs visualViewport.height；方案用 interactive-widget=resizes-content 钉死，验证只为确认 meta 生效 |
| Electron sticky 偏移一致性穷举（chat 桌面 header + 全部 MobilePageHeader 页面 + <768px 窗口） | 中 | V7：Electron 实机缩放走查；cc-page-sticky 统一标记类 + e2e 挂类断言兜底 |
| 测试迁移面（93 处单测引用 + 3 个 e2e） | 中 | Commit 1 先迁缝隙再切行为，迁移机械化；V6 全套跑绿为门禁 |
| Android 原生 PTR 冲突 | 中 | overscroll-behavior-y: contain；V5 真机复测 |
| scrollBehavior / 列表页滚动残留 | 低 | 标准方案，chat 有 force 滚底权威落点兜底 |
| Capacitor 回归 | 低 | 壳路径逐字节不变 + adapter 单路径；壳内冒烟走查 |
| 桌面 Web Chrome/Edge/FF | 低 | 最简单路径，e2e 全覆盖 |

待验证条目汇总：
- V1 Android Chrome 108+ 键盘默认 resize 行为（真机比对 innerHeight vs visualViewport.height）。
- V2 Reka modal body 锁滚是否 iOS 上清零 window scrollY（滚中部开 ImgViewDialog 查 body 样式）；若实锤加 data-scroll-locked 守卫。
- V3 iOS 真机：sticky footer + 键盘、打字撑高是否复现 qidianchat safe-area glitch；退路一行平台门控。
- V4 Chrome 文档级拉历史无双倍位移（绝对赋值盖锚定在文档级实测）。
- V5 overscroll-behavior-y contain 真机压住 Android 原生 PTR。
- V6 单测全套迁移后跑绿（93 处引用）。
- V7 Electron mac/win 实机：标题栏偏移、<768px 窗口 MobilePageHeader、滚动条贴右缘。

总体结论：**可行，建议一把切**（两 commit、无运行时开关），真机验证（V1/V3/V5/V7）为合并前置条件；最大的两块不确定性（prepend 补偿、iOS 键盘）都有已验证的同源技术或一行级退路。

## 修订（2026-06-11）：Electron 改走「内容滚动容器」，本稿 Electron 部分相应调整

Electron 存量诊断（独立调查）确认：非聊天页的 document 滚动条贯穿标题栏（Windows 上滚动条上箭头还被系统窗口控件盖住不可点）、暗色主题滚动条为亮色（缺 color-scheme）。决策：先行落地「color-scheme: dark 一行 + Electron 作用域内容滚动容器（.cc-app-content margin-top:38px + height:calc(100vh-38px) + overflow-y:auto，body overflow hidden 兜底，侧栏规则 top:38→0）」。对本稿的影响：

- §2.3 Electron 小节的 `cc-page-sticky` 偏移规则**作废**——容器滚动下 sticky 天然锚到标题栏下缘，无需标记类。
- §3 适配器 web 分支在 Electron 下指向 `.cc-app-content` 容器而非 document.scrollingElement（adapter 抽象天然容纳）；浏览器 web 仍走 document。
- §5 scrollBehavior 原生只管 window；Electron 容器滚动的跨页复位需经 adapter/afterEach 落到容器（注：跨页滚动位残留今天就存在，非新增）。
- 待验证新增：Reka modal 锁滚对容器失效（退路 `body[data-scroll-locked] .cc-app-content{overflow:hidden}`）、全屏切换摘 cc-electron-custom 类导致滚动器切换、UApp 是否插入定位/overflow 真实节点。
- Windows 截图「顶部花屏条/左缘残影」高概率为 frameless 窗口不可见 resize 边框的截图假象，待实机核实，三路线均不治也不需治。
- 高 modal 顶缘可滑入标题栏下 38px 且不可点（预存边角），顺手补一条 electron 作用域 max-height 避让规则。

## 主线初审补充（leader 终审备忘）

- `--cc-titlebar-h` CSS 变量存在性未核实，落地时若无需在 main.css 定义（38px 单一来源）。
- Electron Windows 经典滚动条会一直延伸到窗口顶（穿过标题栏视觉区）——页滚后文档滚动条贴窗口右缘全高，mac overlay 滚动条无此问题；Windows 上属可接受的常规外观，V7 走查时顺带确认观感。
