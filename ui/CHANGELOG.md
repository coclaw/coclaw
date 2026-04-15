# @coclaw/ui

## 0.15.0

### Minor Changes

- 64f17a8: ui: admin 基础设施 + 仪表盘改造（实例维度 + 导航 tab）

  - 仪表盘顶部三卡片改为实例维度（总数/在线/今日新增），用户卡片降级到次级位置
  - 新增三条摘要列表（最近绑定实例 / 最近活跃用户 / 最新注册用户），每条带"查看全部 →"链接
  - 新增 `admin.store.js`（dashboard/claws/users 三块 state + 全部 actions 含 SSE 事件应用）
  - 新增 `admin-stream.js` SSE 客户端（心跳超时自动重连，响应 app:foreground / network:online）
  - `admin.api.js` 新增 `fetchAdminClaws` / `fetchAdminUsers` / `adminStreamUrl`
  - 新增桌面端 `AdminNavTabs` 组件（仪表盘 / 实例管理 / 用户管理）
  - 新增 `/admin/claws` 和 `/admin/users` 路由（含 placeholder 页面，S5/S6 填充）
  - i18n 从 `adminDashboard.*` 整体迁移到 `admin.{nav,common,dashboard,claws,users}.*`，12 语言同步（保留 `user.adminDashboard` 菜单入口 key）

- 9f0f380: ui: admin 实例管理页 AdminClawsPage

  - 新建 `AdminClawsPage.vue`：UTable 展示实例列表（name/online/user/pluginVersion/createdAt），`#expanded` 槽显示 agent × model 明细（null → 「信息暂不可用」；[] → 「无 Agent」）
  - 顶部搜索框按名称过滤，300ms 去抖；输入变化时 `resetClaws()` 并重新拉取
  - 底部「加载更多」按钮（cursor 分页），仅在存在 `nextCursor` 时渲染
  - mount 时连接 admin SSE，`snapshot` / `claw.statusChanged` / `claw.infoUpdated` 分别映射到 store 的 `applyOnlineSnapshot` / `updateClawStatus` / `updateClawInfo`；`beforeUnmount` 关闭连接
  - 移动端降级为卡片列表，点击卡片切换展开状态显示 agent 明细
  - i18n 新增 `admin.claws.{searchPlaceholder,columnName,columnStatus,columnUser,columnVersion,columnCreatedAt,expandAgentName,expandModel,noAgentModels,emptyAgents}`，12 语言同步

- 943bf24: ui: admin 用户管理页 AdminUsersPage

  - 新建 `AdminUsersPage.vue`（替换原占位实现）：UTable 展示用户列表（name/loginName/clawCount/createdAt/lastLoginAt）
  - 顶部搜索框按用户名或登录名过滤，300ms 去抖；输入变化时 `resetUsers()` 并重新拉取
  - 底部「加载更多」按钮（cursor 分页），仅在存在 `nextCursor` 时渲染
  - 移动端降级为卡片列表，展示用户名、@登录名、绑定实例数、注册时间、最近登录
  - i18n 新增 `admin.users.{searchPlaceholder,columnName,columnLoginName,columnClawCount,columnCreatedAt,columnLastLogin}`，12 语言同步
  - 清理 `admin.common.comingSoon`：仅原占位页引用，AdminUsersPage 完全落地后该 key 成孤儿

### Patch Changes

- c91a917: server/ui: `coclaw.info.updated` 改为 patch 语义，修复改名时清空 pluginVersion/agentModels

  **问题**：plugin 的 `coclaw.info.patch` handler 仅广播 `{ name, hostName }`（按其 patch 命名所暗示）；但 server `applyClawInfoUpdate` 此前按"missing-as-null"当全量处理，导致用户每次从 UI 改名 → DB 清空 pluginVersion + agentModels → admin 仪表盘该 claw 行立即显示 "—" / "信息暂不可用"，直到 bridge 重连才恢复。

  **修复**（方向：按事件命名的 patch 语义，修 server 而不是让 plugin 被迫发全量）：

  - `server/src/claw-ws-hub.js` `applyClawInfoUpdate`：用 `Object.hasOwn(payload, key)` 逐字段判定，仅更新 payload 中实际出现的列；缺失字段保留 DB 原值。name 列的 hostName 回退仅当 payload 同时含 hostName 时应用（与 plugin 两个触发源的实际形态吻合）。
  - `server/src/claw-status-sse.js` `handleInfoUpdatedEvent`：patch 不含 name 字段时直接返回，不下发冗余的 user-facing `claw.nameUpdated`/`bot.nameUpdated` 事件。
  - `server/src/admin-sse.js` `handleInfoUpdatedEvent`：按 payload 实际含有的字段透传，wire 不再携带未变更字段。
  - `ui/src/services/admin-stream.js`：去掉 `?? null` 的字段补齐，保留 patch 中字段的存在/缺失语义，交由 `admin.store.updateClawInfo` 的 "skip undefined" 逻辑只覆盖本次实际变更字段。
  - `ui/src/views/AdminClawsPage.vue`：onInfoUpdated 回调从解构重组改为 `({ clawId, ...patch })`，避免 undefined 字段污染 patch。

  不向 plugin 施加"必须发全量"的约束；`__pushInstanceInfo()`（bridge connect 时的全量上报）和 `coclaw.info.patch` handler（仅发变更字段）两种形态在 patch 语义下都正确工作。

- 92aa515: ui: 修复 admin 页面 review 发现的两处数据一致性问题

  - `AdminClawsPage` / `AdminUsersPage`：重入页面时从 `adminStore.claws.search` / `adminStore.users.search` 回显 searchInput，避免"输入框空 / 列表仍按旧 search 过滤"的不同步状态
  - `auth.store.logout()`：末尾补 `useAdminStore().$reset()`，防止上一位管理员的 dashboard / claws / users 聚合数据和搜索词残留到下一位登录的管理员会话

- 1ec7337: ui: admin 页面 review 微调（术语 / 视觉 / 交互）

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

## 0.14.0

### Minor Changes

- 17cc790: feat(ui): 取消已 accepted 的消息时调用 `coclaw.agent.abort` RPC 真正终止服务端 run

  阶段 1 仅在 UI 端进入 `settling(cancel)` 过渡态保留气泡，服务端 agent run 会继续执行到完成。本次在 `cancelSend` 已 accepted 分支增加 `conn.request('coclaw.agent.abort', { sessionId })` 调用：

  - sessionId 优先用 `this.sessionId`（topic 模式 UUID），其次 `this.currentSessionId`（chat 模式从 `chat.history` 获取），两者均不可知时跳过 RPC 静默降级到纯阶段 1 行为
  - RPC 失败（插件/OpenClaw 不支持、sessionId 未在 activeRuns 等）均通过 `.catch` 静默吞掉，UI 不暴露错误
  - abort 成功后 OpenClaw 的 `lifecycle:end` 会快速到达，`__settleWithTransition` 升级 reason 为 `'lifecycle'`，随后 `completeSettle` 清理 run → `isSending=false` → 输入框解锁

  `/compact` 进行中的 run 在服务端不可中断（OpenClaw 未注册到 `ACTIVE_EMBEDDED_RUNS`），UI 通过新增 `ChatInput` 的 `cancelDisabled` prop + `ChatPage` 绑定 `chatStore?.__slashCommandType === '/compact'` 禁用取消按钮，避免用户点击后 UI 状态与服务端不一致。

  详见 `docs/designs/agent-run-cancellation.md` 阶段 2。

- 1b8a47c: feat(ui): 取消 RPC 结果按 reason notify + 输入框守卫精细化

  **取消 RPC 结果 notify**

  `cancelSend` 现在返回一个 Promise（已 accepted 分支），永远 resolve 为 `{ ok, reason? }` shape；RPC reject 被收敛为 `{ ok:false, reason:'rpc-error' }` 避免 unhandled rejection。`ChatPage.onCancelSend` 根据 reason 分支 notify：

  - `not-supported`（侧门不存在，OpenClaw 版本过旧）→ `notify.warning` 提示升级 OpenClaw
  - `abort-threw`（OpenClaw abort 抛异常）→ `notify.error` + `console.error`
  - `not-found` / `rpc-error`（竞态或底层已 notify）→ 静默
  - `ok: true` → 静默

  新增 i18n keys `chat.cancelNotSupported` / `chat.cancelAbortFailed`（12 种语言同步）。

  **accepted 后允许准备下次消息的附件**

  `ChatInput` 的 "+" 文件按钮从 `:disabled="sending || disabled"` 改为 `:disabled="disabled"`，与 textarea 对齐：pre-accepted 期间被 `disabled` 禁用（`inputLocked=sending&&!__accepted`），accepted 后可点击添加文件。

  **pre-accepted 期间禁止拖放文件**

  `ChatPage` 的 `__onDragOver` / `__onDrop` 新增 `inputLocked` 守卫，pre-accepted 窗口拒绝拖入（不 `preventDefault`，不开启拖拽蒙层）；accepted 后继续允许拖入。

  **设计文档**

  修正 `docs/designs/agent-run-cancellation.md` 决策 1 中"取消后输入框守卫禁用"的不准确描述——实际仅发送按钮保持 STOP 状态，输入框在 `__accepted=true` 时始终启用。

- a9e209f: fix(ui,plugin): UI 主导的 cancel 协调状态机解决注册空窗期 race；插件诊断 patch 产品化 + remoteLog 触点

  阶段 2 上线后实测发现 topic "永远不能取消"、main chat "要等几秒才能取消"。根因：`agent()` RPC 的 `onAccepted` 帧毫秒级返回（UI 亮 STOP）但 OpenClaw 的 `setActiveEmbeddedRun`（`attempt.ts:1572`）要等 session/workspace/skills/provider 等异步准备完成才执行——main chat ~4s，topic 冷启 10-30s+。窗口内 `coclaw.agent.abort` 全部返回 not-found。

  阶段 2.5 实施 UI 主导 + 插件无状态方案：

  **UI 侧（`ui/src/stores/chat.store.js`）**

  - 新增 state `__cancelling = { sid, promise, resolve, tickTimer, tickSeq } | null`
  - 新增 getter `isCancelling`
  - 新增内部方法 `__startCancelCoordination(sid, conn)`：按 `CANCEL_TICK_MS = 500` 重试 `coclaw.agent.abort` RPC，**无 TTL**（生命期=run 生命期）
  - 终止信号：RPC ok=true → `{ok:true, aborted:'immediate'}`；RPC `not-supported` → 立即静默降级；每 tick 头检 `agentRunsStore.isRunning(runKey)`=false → `{ok:false, reason:'run-ended'}`；`sendMessage`/`sendSlashCommand` 入口 `__clearCancelling('superseded')` → `{ok:false, reason:'superseded'}`（deep-review 发现：缺此分支则 chat 模式同 sessionId 的新 run 会被残留 tick 误 abort）
  - `cancelSend` accepted 分支幂等：二次调用返回同一 promise（按钮已被 `cancelDisabled` 禁用）
  - `cleanup()` 同步清理 `tickTimer` 防止页面离开后继续重试
  - `ChatPage.vue` 的 `cancel-disabled` 集成 `isCancelling`——用户点 STOP 后按钮立刻禁用直到 run 结束
  - `onCancelSend` 简化：终态 `immediate`/`run-ended` 静默，仅 `not-supported` notify warning
  - UI remoteLog 触点：`cancel.start` / `cancel.immediate` / `cancel.not-supported` / `cancel.run-ended`

  **插件侧（`plugins/openclaw/`）**

  - `coclaw.agent.abort` 保持单次同步查询 + 现有 logger.info；新增 5 条 remoteLog 触点：`abort.request` / `abort.success` / `abort.not-supported` / `abort.patch installed=...` / `abort.patch-failed reason=...`
  - `installAbortRegistryDiag` 从 `/* c8 ignore */` 临时诊断**产品化**为常驻 patch：监控 `embedded.activeRuns` / `embedded.sessionIdsByKey` / `reply.activeRunsByKey` / `reply.activeKeysBySessionId` 四个 Map 的 `.set`/`.delete`/`.clear`，输出 `[coclaw.diag] <label>.set/delete/clear` 本地日志；installed/missing 列表上报 remoteLog 作为 OpenClaw 内部契约变更早期警报
  - `agent-abort.js` 的 `describeReplyRunRegistry` 与 not-found diag dump 同步产品化（去 c8 ignore + 补单测覆盖各种缺失/异常分支）

  **调研依据**：subagent 复核 OpenClaw 源码确认 sessionId → run 是 1:1（`runs.ts:359` 直接覆盖），run 中再发消息走 reply queue 4 模式但**无并发同 sid**；handle 不带 runId、`chat.abort` 的 runId 路径不覆盖 `agent()` RPC；故 CoClaw 维持 sid 粒度协调。queue 模式下 run A→B 转换由 lifecycle:end 自然清除 UI 协调状态，无残留意图误伤 B。

  详见 `docs/designs/agent-run-cancellation.md` 阶段 2.5、`docs/openclaw-research/agent-run-cancellation.md` §6.7。

### Patch Changes

- abad747: feat(ui): cancel button shows spinner + "Cancelling…" tooltip while in flight

  用户点 STOP 后按钮原先只是禁用（透明度变化），桌面端 tooltip 仍然显示 "Stop sending" 误导用户，移动端无 hover 反馈完全感知不到取消请求是否被记录。

  改进：

  - `ChatInput.vue` 新增 `cancelling` boolean prop（默认 false）。当 `cancelling=true` 时 STOP 按钮：
    - 图标 `i-lucide-square` → `i-lucide-loader-circle`，配合 Nuxt UI `:ui="{ leadingIcon: 'animate-spin' }"` 持续旋转（移动端清晰可见）
    - tooltip 切到 `chat.cancelling` = "正在取消…" / "Cancelling…" 等
    - `disabled` 仍由 `cancelDisabled` 控制（防重复触发），与 `cancelling` 解耦——slash 命令场景 `cancelDisabled=true` 但 `cancelling=false` 保持原 square 图标
  - `ChatPage.vue` 透传 `:cancelling="!!chatStore?.isCancelling"`
  - 12 个 locale 新增 `chat.cancelling` 翻译

  测试：ChatInput.test.js 覆盖 cancelling=true/false 两个分支的 icon/tooltip/ui prop；ChatPage.test.js 覆盖 isCancelling 状态透传。

- b7a8ad7: fix(ui): 文件下载串行队列 + pending 状态可视化 + 失败诊断日志

  - `files.store` 新增 `__runDownloadQueue`：同一 (claw, agent) 下载串行执行，避免多 DC 并发把插件 SCTP 缓冲灌满导致 UI READY_TIMEOUT。
  - `files.store` 新增 `logTaskFailure` helper，覆盖 file-transfer 之外的失败路径（saveBlobToFile / Capacitor 权限错误等），并区分 `DOWNLOAD_FAILED` / `SAVE_FAILED` 阶段；UI 出现 failed 时一定能在 console + remoteLog 找到诊断信息。
  - `FileListItem` 新增 pending 分支，渲染「等待中…」+ 取消按钮；删除按钮在 pending 时也隐藏，避免误删排队中的任务。修复了上一版下载入队后 UI 无任何反馈、用户误以为「点击被忽略」的问题。
  - `FileUploadItem` 取消按钮图标与下载侧统一为 `i-lucide-circle-stop`。

- 2bd7f3a: fix(ui): 取消已 accepted 的消息时保留气泡、等 lifecycle:end 自然收敛

  当用户在 `agent accepted` 后点取消，原来 `cancelSend` 硬清理 `streamingMsgs` 并立即 `reconcileMessages`，由于服务端 run 仍在执行、user message 尚未持久化，导致用户消息气泡消逝，直到 run 真正结束时才恢复（main-agent-chat / topic 必现）。

  本次修复：

  - `agent-runs.store` 新增 `settlingReason: 'lifecycle' | 'cancel'` 字段区分 settling 来源；新增公共方法 `settleWithTransitionByKey(runKey)` 进入 `settling(cancel)` 过渡态但保留 streamingMsgs 与 30min 兜底 timer，不主动调度 500ms fallback
  - `completeSettle` 仅处理 `settlingReason='lifecycle'` 的 run，防止 WS 闪断重连 / 前台恢复 / activate 重入等独立 loadMessages 路径误清 `settling(cancel)` 状态下的 streamingMsgs
  - `__settleWithTransition`（由 lifecycle:end 触发）把 reason 升级为 `'lifecycle'`，解锁后续 completeSettle 清理
  - `cancelSend` 已 accepted 分支改用新方法：不 reject 原 `agent()` RPC Promise、nullify `__cancelReject` 槽位避免后续 cleanup 误 reject、不立即 reload messages
  - 此阶段 `isSending` 仍为 true（`isRunning` 判 `!settled`），输入框保持禁用；真正"取消后立即解锁"将在阶段 2 通过插件 `coclaw.agent.abort` 驱动 `lifecycle:end` 快速到达实现

  详见 `docs/designs/agent-run-cancellation.md` 阶段 1。

- bf8ee23: fix(ui): 修复多 claw 共用同名 agent 时活跃 run 跨 claw 串显

  当用户连接多个 claw 且各自存在同名 agent（如默认 `main`）时，一个 claw 的 "思考中 N 秒" 计数和流式内容会同时出现在其它 claw 的 chat 页面。根因是 `agent-runs.store` 的 `runKeyIndex` 使用 `chatSessionKey`（形如 `agent:main:main`，不含 clawId）作为全局扁平 key，多 claw 同名 agent 在索引中发生碰撞，`register` 时甚至会互相驱逐对方的活跃 run。

  本次修复将 chat 模式的 runKey 改为 `${clawId}::${chatSessionKey}`，topic 模式仍沿用 sessionId（uuid 天然唯一）。同步修改 `AgentCard.vue`、`ManageClawsPage.vue` 中独立构造 runKey 的三处位置。

- 3f9c0ef: fix(ui): 拉长 agent run / 斜杠命令 / 标题生成超时，避免长任务被前端过早中断

  - **post-acceptance timeout**：30min → 24h（`POST_ACCEPT_TIMEOUT_MS`）。客户端等待 `lifecycle:end` 的 fallback 超时与 OpenClaw agent run 生命周期对齐；正常路径下 run 由事件驱动 settle，此 timer 只作 WS 丢事件 / OpenClaw 崩溃的兜底清理
  - **`/compact` 斜杠命令**：10min → 24h（`POST_ACCEPT_TIMEOUT_MS`）。`/compact` 触发服务端 LLM 摘要可跑很久，前端不应先于服务端超时；`/new` / `/reset` 保持 10min（sessions.reset 是秒级操作），其它斜杠命令保持 5min
  - **生成 topic 标题的 RPC 超时**：5min → 10min，给插件内部 agentRpc（同步提高到 5min）留足 buffer

  `POST_ACCEPT_TIMEOUT_MS` 从 `agent-runs.store.js` export，供 `chat.store.js` 复用；相关测试用该常量替换原硬编码 `30 * 60_000`。

- a0f4b5e: fix(ui): disable STOP for all slash commands & gate desktop mic button

  - 斜杠命令（`/new`、`/reset`、`/help` 等）无服务端取消通道，点击 STOP 仅清本地乐观消息而不会中断服务端命令。原先只 disable `/compact` 的 STOP，其它斜杠命令的 STOP 可点击但无效。现在统一：任何斜杠命令进行中 STOP 按钮禁用，避免"按了没用"的错觉。
  - 桌面麦克风按钮此前未跟随 `disabled` prop —— claw 离线 / 预 accepted 期间仍可点击开始录音。现在按钮绑定 `:disabled="disabled"`，`onStartDesktopRecording` 头部早退，与 textarea / `+` 按钮 / 触屏"按住说话"对齐。

- 698c838: fix(ui): 大文件上传中途被 keepalive 误杀（DC_CLOSED during flow control）

  `webrtc-connection.createDataChannel` 在 file DC 上新增 `bufferedamountlow` 监听，与现有 `message` 监听一起更新 `__lastDcActivityAt`。

  **Why**：keepalive 的活动宽限只在入向 `message` 时记账。上传场景下 file DC 几乎没有入站消息，rpc DC probe 又因 SCTP 出向被 file 数据塞满迟迟不返回 ack，宽限内没有活动证据 → keepalive 关闭整个 PC → 正在 await BAL 的 sendChunks 被强制 reject 为 `DC_CLOSED`。BAL 触发等价于"出向字节真实进入网络"——是上传时唯一可信的 SCTP liveness 信号，把它纳入活动统计即可消除误杀，且不削弱 keepalive 对真实 SCTP 假死的检测能力。

- 1eeb742: fix(ui): 修复僵尸 agent run 导致 UI 计时器空转、输出卡住 (#235)

  当 `lifecycle:end` 事件丢失时，agent run 进入僵尸态（unsettled），使 `isSending` 永远为 true，进而阻断所有可能触发 `reconcileAfterLoad` 的 `loadMessages` 路径，形成死锁。
  本次修复在 `agent-runs.store` 增加 `isRunIdle` 检测（事件流静默 ≥10s），并在三个入口（chat.store activate 重入、ChatPage **onConnReady 重连、**handleForegroundResume 前台恢复）放行强制静默刷新，由 `reconcileAfterLoad` 的双重安全检查（事件流静默 + 服务端确认完成）兜底防止误清理活跃 run。

- 61d28fe: refactor(ui): 统一进度指示为通用 ProgressRing 圆形组件

  - 新增 `src/components/ProgressRing.vue`:精确还原 Quasar `q-circular-progress` 几何公式(viewBox = 100/(1−thickness/2), radius = 50, strokeWidth = thickness/2 × viewBox);双模式(value 0~1 确定态 / null 不定态);Nuxt UI 语义色 + ARIA 1.2 属性
  - `ChatInput`:移除手写 SVG 进度圈,改用 `<ProgressRing>`;`__filePercent` → `__fileProgress`(直接传 0~1);轨道由 `stroke-muted/30` 升级为 `stroke-muted` 不透明,解决原"残缺感"
  - `FileUploadItem` / `FileListItem`:条形进度 → 圆形,与 action 按钮并列,对移动端更友好;FileListItem 下载新增中央百分比显示
  - 配套 32 个 ProgressRing 单元测试 + 联动测试断言更新
  - 后续改进项(a11y i18n、窄屏验证、测试增强等)登记于 `ui/TODO.md`

- 397b36f: fix(ui,plugin): review followups for agent run cancellation

  deep review 发现的一致性/稳健性改进：

  - **ui**: 触屏"按住说话"按钮 gating 与 textarea / "+" 按钮对齐，改为仅受 `disabled` 控制（`sending` 单独禁用违反"accepted 后允许准备下次消息附件"的设计意图）
  - **ui**: `cancelSend` accepted 分支新增 settling(cancel) 守卫，避免双击 STOP / watcher 重入（如 `isClawOffline`）导致重复 `coclaw.agent.abort` RPC
  - **plugin**: `agent-abort.js` 增加 `typeof handle.abort !== 'function'` shape 守卫，归类为 `not-supported`（而非 `abort-threw`），让 UI notify 显示"升级 OpenClaw"而不是"执行失败"
  - **ui**: `POST_ACCEPT_TIMEOUT_MS` 注释修正 —— 这是客户端侧 fallback 上限，非与后端 run 生命周期对齐
  - 文档：`docs/architecture/communication-model.md` 超时表同步到最新值（agent post-accept 30min → 24h；generateTitle 300s → 600s，含层级说明）
  - 测试：补 `conn=null` 降级、双击 STOP 守卫、`title-gen.js` 传递 `timeoutMs=300_000` 断言、触屏语音按钮 gating

## 0.11.3

### Patch Changes

- ui: add cloud deploy guide, debug build variant, reconnection optimization, remove per-bot inline loading
  server: simplify coverage config, raise test coverage to 90%+

## 0.9.4

### Patch Changes

- feat: 管理员仪表盘新增最新注册用户列表；服务端新增插件版本号返回及 loginName 查询
- fix: 管理员仪表盘修复版本号显示、用户名为空、在线数未展示、文案优化；Dashboard 频道名称显示及花费隐藏；统一 **APP_VERSION** 变量

## 0.9.0

### Minor Changes

- 7044e4f: feat: 机器人页面升级为 Agent Dashboard（Phase 1）

  - 新增实例总览卡片（InstanceOverview）：展示名称、在线状态、本月花费、频道状态、版本信息
  - 新增 Agent 卡片瀑布流（AgentCard）：展示身份、模型标签、能力矩阵、tokens/会话/最近活跃
  - 能力标签从 OpenClaw gateway tools.catalog 动态映射
  - 模型标签从 models.list 动态生成
  - 并行 RPC 聚合，部分失败优雅降级
  - 离线 bot 显示简化版 fallback header
  - 完善 i18n 支持（中文 + 英文）

## 0.1.1

### Patch Changes

- 0cf6cec: fix(ui,server): add WS heartbeat and improve chat disconnect resilience

  - UI WS client: 25s ping / 45s timeout heartbeat to detect silent disconnections on mobile
  - Server: respond to application-level ping/pong + WS protocol-level ping for UI connections
  - ChatPage: 30s pre-acceptance timeout to prevent infinite "thinking" state
  - ChatPage: suppress duplicate error toasts when timeout/lifecycle:end already handled
  - ChatPage: lifecycle:end uses fresh WS connection for refresh; preserves user message on failure

- fix(server,ui): accumulated fixes since changeset adoption

  - server: extend binding code expiry from 5 to 30 minutes
  - server,ui: push bot name update via SSE after bridge connects
  - ui: update plugin id to openclaw-coclaw and improve AddBot page layout
  - ui: distinguish bot offline from unbound in ChatPage notification
  - ui: remove redundant bind-success notify and guard unbind double-click
  - plugin,ui: fix new-chat failure and missing session for agent:main:main
