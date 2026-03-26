# CoClaw 业务前端

> 适用范围：`coclaw/ui` 及其子目录。
> 本文件仅包含“相对 CoClaw 根 AGENTS.md 的增量规则”。

严格遵循移动端优先的设计思路。

## 技术栈

- 构建工具: Vite
- 核心框架: Vue 3
- UI 组件库: Nuxt UI 4，但不使用 Nuxt 框架
- 当需要对 Nuxt UI 组件进行样式定制时，遵循 “由全局到局部” 的优先级策略
- 样式工具: Tailwind，当 Tailwind 无法表达时，优先以 inline style 进行微调，确有复杂样式需求时才编写 SCSS
- 状态管理: Pinia
- 路由管理: Vue Router
- 单元/组件测试: Vitest + Vue Test Utils
- 端到端(E2E)测试: Playwright
- 逻辑语言: 采用 JavaScript + jsdoc，不使用 TypeScript。
- 样式语言: SCSS（仅作为补充）。
- 包管理: pnpm（环境已启用 pnpm）

## 浏览器兼容性基线

最低支持版本（已配置于 `vite.config.js` 的 `build.target`）：

| 浏览器 | 最低版本 | 发布时间 |
|--------|---------|---------|
| Chrome | 90 | 2021.04 |
| Edge | 90 | 2021.04 |
| Safari | 14 | 2020.09 |
| Firefox | 90 | 2021.08 |

- 使用较新的 CSS 特性（如 `dvh`/`svh`/`lvh`、Container Queries 等）时，必须提供 fallback，确保在基线浏览器中功能可用
- `main.css` 中提供了 `.h-dvh-safe` 工具类（`@supports` 回退到 `vh`），需要动态视口高度时应使用该类而非 Tailwind 的 `h-dvh`

## 编程规范

- 组件风格：采用 Options API 风格，而非 Composition API 风格，不得使用 `<script setup>` 语法糖
- 允许在 `setup()` 钩子中调用 `UseVue` 等组合式函数
- 对于适合以函数式方式触发的对话框（如全局入口、跨组件打开），优先采用函数式打开（例如基于 `useOverlay`），避免仅用路由跳转或页面内状态耦合实现
- 禁止对大对象使用 Vue deep watch 来监听少量字段变化——应先用 computed 将关心的字段收窄为简单值，再 watch 该 computed

## 操作反馈（Notify）

- 操作反馈统一使用全局 `useNotify()` composable（基于 Nuxt UI `useToast`），除非特别场景，禁止在页面内用 inline 文本显示操作状态
- 若用户可通过界面变化直接感知操作结果（如切换主题/语言），则不必 notify
- 错误操作始终需要 notify

## 端到端测试 (E2E Testing)

- Bug 修复涉及 UI 行为时，须补充对应的 E2E 测试用例
- 当用户明确要求时才执行 E2E 测试
- 执行规范、编写约束、踩坑记录等详见 `e2e-test` skill

## 移动端子页面适配

- 非底部导航直达的子页面（如 AddBotPage、AboutPage、ChatPage），统一使用 `MobilePageHeader` 组件提供移动端 header（含返回按钮）
- `MobilePageHeader` 仅移动端可见（`md:hidden`），桌面端各页面自行处理标题展示
- 路由 meta 约定：
  - `isTopPage: true`：底部导航直达页（topics、bots、user），不显示返回按钮
  - `hideMobileNav: true`：子页面（chat、bots-add、about），隐藏底部导航
- 新建子页面时：引入 `MobilePageHeader`，设置路由 `hideMobileNav: true`，桌面端标题用 `hidden md:flex`

## 参考项目

本前端充分参考借鉴一个项目（用 qidianchat 或奇点慧语指代），尤其是 layout，及可对照的各组件的组织和交互方式上。实际上这两个项目高度相似，qidianchat 是与系统预置或用户自己创建的的机器人对话，而这个项目是与 OpenClaw agent 对话。

qidianchat 信息源
- qidianchat 代码组织在仓库根下的 `ref-projects/qidianchat`，需要时也阅读其代码
- 此 workspace 的 docs 下也存储了几个文档，如：`layout-reference.md`、`ui-refs-from-quasar-project.md`
- 需要时还可以爬取 qidianchat 项目（如用 playwright 爬取）。app 入口地址为 `https://127.0.0.1:8443/`。其 SSL 证书是自签名；用户名：test；密码：123456
