# UI Workspace Status

## 2026-03-17
- **Topic 管理功能（UI 侧）**：
  - 新增 `topics.store.js`：管理用户主动创建的独立话题（Topic），通过 `coclaw.topics.*` RPC 与插件交互
  - 修改 `chat.store.js`：新增 `topicMode` 双模式支持——topic 模式下使用 `coclaw.topics.getHistory` 加载消息、agent 请求只传 `sessionId`（不传 `sessionKey`）
  - 修改 `ChatPage.vue`：支持 topic 路由（`/topics/new`、`/topics/:topicId`）；"新建对话"按钮改为"新话题"（所有 ChatPage 均显示）；首轮完成后自动触发标题生成
  - 修改 `MainList.vue`：会话列表区（Group 3）从 sessions 改为 topics；agent 列表支持"活跃高亮"
  - 修改 `bots.store.js`：WS 连接就绪后同时加载 topics
  - 新增 i18n `topic.*` 命名空间
  - 新增 `topics.store.test.js`（20 测试），更新 `ChatPage.test.js`、`MainList.test.js`、`bots.store.test.js`
  - 全部测试通过（34 文件，620 测试），覆盖率达标
  - 插件侧 `coclaw.topics.*` RPC 尚在开发中，UI 侧已就绪待联调

## 2026-03-16
- **Android 切换 App 后 WS 断连导致"connection closed"错误修复**：
  - **根因**：`chat.store.js` sendMessage 的 catch 块缺少"已 accepted 但 agent 未完成时 WS 断连"分支，导致乐观消息被清除、错误直接抛给用户
  - **修复 1**（`chat.store.js`）：新增 `WS_CLOSED && __accepted && !__agentSettled` catch 分支——不报错、不清除乐观消息，等待 WS 重连后调 `__reconcileMessages()` 用服务端持久化数据替换本地条目
  - **修复 2**（`capacitor-app.js`）：在原生初始化流程中启动 `KeepAliveService` 前台服务（调用 `KeepAlive.start()`），减少 Android 后台杀进程概率。原生侧 `KeepAliveService.java`、`KeepAlivePlugin.java`、`MainActivity.java` 注册均已就绪，此前仅 JS 端未调用
  - 更新对应单元测试
  - 全部测试通过（33 文件，606 测试），覆盖率达标

## 2026-03-14
- **多 Agent 支持（UI 侧，Phase 2 + Phase 3）已完成**：
  - 新增 `agents.store.js`：管理 per-bot agent 列表，通过 `agents.list` + `agent.identity.get` RPC 获取完整 identity
  - 修改 `sessions.store.js`：按 agent 分别拉取 sessions，保留 `updatedAt` 字段
  - 修改 `chat.store.js`：动态解析 agentId（`__resolveAgentId`），`isMainSession` 改正则匹配，`resetChat`/`loadMessages`/`__reconcileMessages` 支持非 main agent
  - 修改 `bots.store.js`：连接就绪后先加载 agents 再加载 sessions
  - 修改 `MainList.vue`：agent 列表替代 bot 列表，session 列表按 `updatedAt` 降序排序，session item 根据 agentId 显示对应 agent 的 emoji/avatar
  - 修改 `ManageBotsPage.vue`：Claw 卡片内展示 agent 列表 + 对话按钮
  - 修改 `HomePage.vue`：默认 agent 导航
  - i18n 术语更新（机器人→Claw，新增 agents 命名空间）
  - avatar 渲染含 `isRenderableUrl` 校验（仅 `data:` 或 `http(s):` URL 用于 img）
  - 全部测试通过（33 文件，583 测试），覆盖率达标
  - 详见 `docs/architecture/multi-agent-support.md`

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

- [Android/WS] **Capacitor `appStateChange` 监听**：当 App 从后台回到前台时，主动检测 WS 连接状态，若已断连则立即触发重连 + reconcile，而非被动等待心跳超时。Capacitor `@capacitor/app` 的 `appStateChange` 事件已可用，需在 `capacitor-app.js` 中监听并通知 `BotConnectionManager`。
- [Android/WS] **WS 断连期间的 agent RPC 恢复**：当前修复仅处理了"已 accepted"场景的优雅降级（不报错、重连后 reconcile）。完整的 RPC 恢复（断连期间丢失的 streaming 事件补偿、断点续传）是更大的架构变动，需后续专项设计。
- [Android/WS] **WebSocket 下沉到原生层**：当前 WS 运行在 WebView JS 层，即使前台服务保活了进程，WebView 后台化后 JS 执行仍会被暂停/限制。若需要后台持续收消息（如推送通知），需将 WS 连接下沉到原生层（Java/Kotlin），或接入 FCM/厂商推送通道作为兜底。这是长期架构优化方向。
- 优化 `ChatPage` 消息渲染样式（角色分组、时间信息、滚动体验）。
- 在 MainList 增加”可续聊/只读”显式标记，降低 orphan 会话误操作。
- Split auth page into reusable components after prototype stage.
- Add route guards and auth-aware navigation.
- [Android/iOS] Overscroll 橡皮筋效果：当前 WebView 滚到边界时有浏览器默认的 overscroll 视觉效果，与原生 App 的 stretch 效果不一致。CSS `overscroll-behavior: none` 可去掉效果但会变成硬停；若要模拟原生 stretch 效果需 Android 原生层面处理。待后续决策。
- [Android/iOS] 文本选择行为：交互元素（按钮、导航等）长按时可能触发浏览器选区，与原生 App 行为不一致。内容区（聊天消息等）的长按复制已与原生一致，暂不处理。
- [Android] APK versionCode 约束：当前 `android/app/build.gradle` 中 `versionCode = 1`。由于采用远端 URL 加载模式（`server.url` 指向 `https://im.coclaw.net`），短期内无需发布新 APK。若将来必须发布新 APK（如新增权限、修改原生插件、升级 Capacitor 核心等），需手动递增 `versionCode`，否则无法覆盖安装。
- [Chat] Agent task 完成后步骤区不显示 tool result 内容和 thinking 内容：lifecycle:end 后的静默 loadMessages（count=77）已执行但 UI 未更新。已添加诊断日志（toolResults/thinkingMsgs 计数），待进一步定位是数据问题还是渲染问题。Thinking 事件在当前 agent 配置下可能不通过流式传递，仅存在于持久化消息。详见 `docs/openclaw-research/agent-event-streams-and-rpcs.md`。
