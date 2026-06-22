# CoClaw 业务前端

> 适用范围：`coclaw/ui` 及其子目录。
> 本文件仅包含“相对 CoClaw 根 AGENTS.md 的增量规则”。

## 技术栈

- 构建工具: Vite（`pnpm dev` 会先跑仓库根 `scripts/ensure-dev-dockers.sh` 拉起 dev docker，再起 Vite，http://localhost:5173）
- 核心框架: Vue 3
- UI 组件库: Nuxt UI 4，但不使用 Nuxt 框架
- 定制 Nuxt UI 组件样式时，遵循“由全局到局部”的优先级策略；全局定制方法见仓库根 `.agents/skills/nuxt-ui-global-config/`
- 样式工具: Tailwind，当 Tailwind 无法表达时，优先以 inline style 进行微调，确有复杂样式需求时才编写 SCSS（仅作为补充）
- 状态管理: Pinia；路由管理: Vue Router
- 单元/组件测试: Vitest + Vue Test Utils；端到端(E2E)测试: Playwright

## 浏览器兼容性基线

最低支持版本（已配置于 `vite.config.js` 的 `build.target`）：Chrome 90 / Edge 90 / Safari 15 / Firefox 90。

- 使用较新的 CSS 特性（如 `dvh`/`svh`/`lvh`、Container Queries 等）时，必须提供 fallback，确保在基线浏览器中功能可用
- `src/assets/main.css` 中提供了 `.h-dvh-safe` 工具类（`@supports` 回退到 `vh`），需要动态视口高度时应使用该类而非 Tailwind 的 `h-dvh`

## 编程规范

- 组件风格：采用 Options API 风格，而非 Composition API 风格，不得使用 `<script setup>` 语法糖
- 允许在 `setup()` 钩子中调用组合式函数（如 VueUse 的工具函数、项目内 `useXxx` composable）
- 对于适合以函数式方式触发的对话框（如全局入口、跨组件打开），优先采用函数式打开（例如基于 `useOverlay`），避免仅用路由跳转或页面内状态耦合实现
- 禁止对大对象使用 Vue deep watch 来监听少量字段变化——应先用 computed 将关心的字段收窄为简单值，再 watch 该 computed

## 操作反馈（Notify）

- 操作反馈统一使用全局 `useNotify()`，错误始终需要 notify；何时该/不该 notify 及测试 mock 见仓库根 `.agents/skills/ui-notify/`

## 国际化（i18n）

- 语言包位于 `src/i18n/locales/`，每个语言一个文件
- 新增或修改 i18n key 时，必须同步更新该目录下的**所有**语言文件，不得遗漏

## remoteLog 远程诊断日志

- `remoteLog(text)` 函数（`src/services/remote-log.js`）用于将**重要诊断信息**推送到 CoClaw server，供开发者远程排查问题
- 仅用于关键事件（连接生命周期、系统状态恢复、关键业务状态变更），**禁止用于高频/冗余日志**
- 日志格式：`<模块>.<事件> key=value key=value`，如 `sig.connected`、`rtc.state conn=abc123 connected`

## 端到端测试 (E2E Testing)

- Bug 修复涉及 UI 行为时，须补充对应的 E2E 测试用例
- 当用户明确要求时才执行 E2E 测试
- 本机弹 Playwright / Electron 做可视化测试前，先告知用户这步验**原生外壳**还是**网页 UI**（决定能否锁屏 / 切走）；锁屏、焦点、多屏机制见 `e2e-test` skill

## Electron 桌面壳子

桌面壳一律 Electron；package.json 中的 `tauri:*` 脚本与 `src-tauri/` 当前不使用（桌面壳已定 Electron），保留以备未来可能重启用 Tauri，暂不删除。

- 壳子代码在 `ui/electron/`，ESM 主进程 + CommonJS preload（sandbox 要求 preload 必须是 `.cjs`）
- 本地开发需双终端：先 `pnpm dev`，另一终端 `pnpm electron:dev`（加载 http://localhost:5173；生产模式加载 https://im.coclaw.net）
- 壳子测试独立跑 `pnpm test:electron`（`vitest.electron.config.js`，node 环境）；`pnpm test` 含 src + electron
- 构建：`pnpm electron:build:win | win:portable | mac`，产物在 `ui/dist-electron/`。WSL2 构建 win 包需先装 wine；mac 包仅 macOS + 代码签名环境可构建；portable 不参与自动更新。签名/公证环境变量见 `ui/.env.example`
- 壳子版本独立于 `@coclaw/ui` 的 npm 版本，手工维护于 `ui/electron-builder.yaml` 的 `extraMetadata.version`，规则见 `docs/versioning.md` 的 “Electron 壳子版本独立维护” 小节
- 发布与分发流程见 `deploy/docs/desktop-releases.md`；iOS 构建见 `ui/docs/ios-build-release.md`
- 壳子架构、安全/权限模型、自动更新等完整设计见 `ui/docs/designs/electron-desktop-shell.md`

## 移动端子页面适配

- 非底部导航直达的子页面统一用 `MobilePageHeader` + 路由 meta 适配，规范见仓库根 `.agents/skills/mobile-subpage/`

## 参考项目

本前端充分参考借鉴 qidianchat（奇点慧语）项目，尤其是 layout 及可对照组件的组织和交互方式。两项目高度相似：qidianchat 是与系统预置或用户自建的机器人对话，本项目是与 OpenClaw agent 对话。

- qidianchat 代码在仓库根 `ref-projects/qidianchat`，需要时可阅读
- 对照参考文档见 `ui/docs/quasar-migration-reference.md`
- 需要时还可以爬取运行中的 qidianchat（如用 playwright）。app 入口 `https://127.0.0.1:8443/`，SSL 证书自签名；用户名：test；密码：123456
