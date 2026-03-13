# UI Workspace Status

## 2026-03-11
- **v0.2 实时通信架构整改（UI 侧，Stages 2/3/4）已完成**：
  - 新增 `BotConnection` 类（`services/bot-connection.js`）：per-bot 持久 WS 连接，含 RPC 两阶段协议、心跳（25s ping/45s timeout）、指数退避重连
  - 新增 `BotConnectionManager` 单例（`services/bot-connection-manager.js`）：管理所有 BotConnection 实例的生命周期
  - 新增 `chatStore`（`stores/chat.store.js`）：从 ChatPage 抽取的通信/消息/streaming 逻辑
  - 重构 `sessionsStore`：改用持久连接（`useBotConnections().get()`）替代临时 WS
  - 重构 `botsStore`：loadBots 后自动同步连接（`syncConnections`）
  - 重构 `authStore`：logout 时断开所有连接（`disconnectAll`）
  - 重写 `ChatPage.vue`：从 ~700 行精简到 ~230 行，纯 UI 层委托 chatStore
  - 移除 `gateway.ws.js` 及其测试（ticket 机制已废弃，改用 session cookie 认证）
  - 移除 `bots.api.js` 中的 `createBotWsTicket()`
  - 全部测试通过（30 文件，448 测试），覆盖率达标（statements 89.5%, branches 81.7%）
  - 详见 `docs/architecture/v0.2-realtime-refactor.md`

## 2026-02-28
- 完成一次多 bot 绑定回归测试（在 UI workspace 发起，使用测试账号 `test / 123456`）：
  - 连续执行 2 次绑定流程，成功新增 2 个 bot（列表计数从 1 -> 3）。
  - 通过 `GET /api/v1/bots` 可见新增 bot id，确认 server API 在插件合并后仍正常。
  - 测试结束后调用用户解绑接口清理测试 bot，列表恢复到初始数量（1）。

## 2026-02-27
- 绑定成功感知链路修复（AddBot -> MainList 实时联动）：
  - 新增 server wait API 链路：生成 binding code 后获取 `waitToken`，前端调用 `POST /api/v1/bots/binding-codes/wait` 等待结果。
  - 前端不再轮询 bot 列表检测绑定；改为等待 API 返回 `BINDING_SUCCESS`。
  - wait API 采用短长轮询方式（单次等待约 25s，前端循环到 code 过期），以规避反代长连接超时风险。
  - 引入 `bots` Pinia Store（`src/stores/bots.store.js`）作为 bot 列表单一数据源。
  - `AddBotPage` 绑定成功后直接写入 store（响应式生效），`MainList` / `ManageBotsPage` / `ChatPage` 直接消费 store。
  - 已移除额外的 `emit/on` 事件总线，减少状态同步复杂度。
- Bots API 调整：
  - `unbindBotByUser(botId)` 改为显式传 botId（对应 server 定向解绑）。
  - `createBotWsTicket(botId)` 支持传指定 botId。
- 网关 WS 客户端调整：`createGatewayRpcClient({ botId })`。
- `MainList` 调整为优先使用 active bot 建立 rpc 通道。
- `ChatPage` 在建立 rpc 前先拉取 bot 列表并选择 active bot；无 active bot 时给出明确提示。
- `ManageBotsPage` 从“单条状态卡片”改为“bot 列表管理”，支持逐条 active bot 解绑。
- i18n 新增 `chat.noActiveBot`（中英文）。

## 2026-02-23

- 生产/开发兼容性改造（API/WS 基地址策略）：
	- `src/services/auth.api.js`、`src/services/bots.api.js`、`src/services/gateway.ws.js` 已改为**优先 same-origin**（`window.location.origin`）
	- `VITE_API_BASE_URL` 仍可显式覆盖（用于特定调试）
	- 仅在非浏览器场景（如测试运行时）保留 `http://127.0.0.1:3000` 兜底，避免影响现有测试执行
- 已验证：`pnpm --filter @coclaw/ui test` 全部通过。

## Current

- Implemented Bots binding MVP page (`/bots`) for single-bot flow:
	- fetch bot status via `GET /api/v1/bots`
	- generate binding code via `POST /api/v1/bots/binding-codes`
	- display 8-digit code, expiry countdown, and OpenClaw bind command hint
	- show latest bot status card and keep legacy multi-bot data as warning-only
- Added API service: `src/services/bots.api.js`.
- Added bind-detection UX hint on Bots page:
	- after generating code, UI polls bot list for a short window
	- auto-prompts "绑定成功/重绑成功" when status changes are detected
	- auto-clears current binding code block after bind/rebind success
- Added user-initiated unbind on frontend:
	- call `POST /api/v1/bots/unbind-by-user`
	- show auto-cleanup message after success (OpenClaw side handles cleanup automatically)

- Initialized Vue 3 + Vite UI workspace.
- Integrated Nuxt UI 4 in Vue + Vite:
	- enabled `@nuxt/ui/vite` plugin
	- enabled `@nuxt/ui/vue-plugin` in app entry
	- wrapped root with `<UApp />`
	- added demo route `/nuxt-ui-demo` and component test
- Implemented local auth prototype page with:
	- login (`POST /api/v1/auth/local/login`)
	- logout (`POST /api/v1/auth/logout`)
	- session fetch (`GET /api/v1/auth/session`)
- Added Pinia auth store and axios-based auth API service.
- Added unit tests (Vitest) for auth store.
- Added E2E tests (Playwright) for auth flow collaborating with `server`.
- Completed reference frontend layout survey (desktop/mobile) and documented results in `docs/layout-reference.md`.
- Implemented mobile-first layout pages based on reference project:
	- `/login` (reference-style auth form)
	- `/chat` (desktop drawer + mobile chat header)
	- `/topics` (mobile navigation page + bottom tabs)
	- `/user` (mobile profile page with logout)
- Implemented desktop drawer bottom popup menu and logout flow.
- Updated Playwright auth flow to match new layout.
- Added layout utility tests for viewport route behavior.
- Refactored shared conversation list into `MainList.vue` to reuse between desktop drawer and mobile topics view.
- Switched mobile bottom navigation to Nuxt UI `UTabs` and aligned routes as `/topics` / `/bots` / `/user`.
- Implemented settings and user info as dialogs (aligned with reference behavior):
	- Added reusable dialog content components `UserSettingsPanel` / `UserProfilePanel`.
	- Added function-style dialog launcher `useUserDialogs()` based on Nuxt UI `useOverlay`.
	- Desktop user popup now functionally opens dialogs directly (no `/settings` or `/user` routes).
	- Mobile `我的` tab functionally opens full-screen profile dialog; profile panel can switch to settings dialog.
	- Preserved local-only password update UI and dangerous action confirm flow in dialog mode.
- Added reference capture notes in `docs/settings-user-reference.md`.
- Updated `MainList` header actions:
	- Always show clickable `添加机器人` entry.
	- Show clickable `管理机器人` entry on non-mobile only (`md` and above).
	- Keep mobile access to bots management via bottom tab labeled `机器人`.
- `MainList` 已接入会话动态加载（绑定 bot 场景）：
	- UI 先调用 `POST /api/v1/bots/ws-ticket` 获取一次性 ticket
	- 再通过 `WS /api/v1/bots/stream?role=ui&ticket=...` 建立 rpc 通道
	- 调用 `nativeui.sessions.listAll` 全量加载（MVP 无分页）并渲染会话列表（替换静态示例项）
- `/chat/:sessionId?` 已接入会话详情与续聊：
	- 基于 `nativeui.sessions.get` 全量加载该会话消息（MVP 无分页）
	- 文本输入调用 `chat.send` + `sessionKey` 实现续聊（仅支持 indexed session）

## Notes

- Default API base URL: `http://127.0.0.1:3000`
- E2E test account: `test / 123456`

## TODO

- 优化 `ChatPage` 消息渲染样式（角色分组、时间信息、滚动体验）。
- 在 MainList 增加”可续聊/只读”显式标记，降低 orphan 会话误操作。
- Split auth page into reusable components after prototype stage.
- Add route guards and auth-aware navigation.
- [Android/iOS] Overscroll 橡皮筋效果：当前 WebView 滚到边界时有浏览器默认的 overscroll 视觉效果，与原生 App 的 stretch 效果不一致。CSS `overscroll-behavior: none` 可去掉效果但会变成硬停；若要模拟原生 stretch 效果需 Android 原生层面处理。待后续决策。
- [Android/iOS] 文本选择行为：交互元素（按钮、导航等）长按时可能触发浏览器选区，与原生 App 行为不一致。内容区（聊天消息等）的长按复制已与原生一致，暂不处理。
- [Android] APK versionCode 约束：当前 `android/app/build.gradle` 中 `versionCode = 1`。由于采用远端 URL 加载模式（`server.url` 指向 `https://im.coclaw.net`），短期内无需发布新 APK。若将来必须发布新 APK（如新增权限、修改原生插件、升级 Capacitor 核心等），需手动递增 `versionCode`，否则无法覆盖安装。
