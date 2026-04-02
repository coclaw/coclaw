# CoClaw UI 状态恢复全景

> 适用范围：CoClaw UI
> 创建时间：2026-03-26
> 最后更新：2026-04-02

本文档记录 CoClaw UI 中所有状态恢复机制的设计与实现。大部分恢复逻辑是 Web 应用本身就需要的（网络异常、页面切换等），Capacitor 移动端只是放大了问题频率并引入少量特有处理。

---

## 1. 架构概览

```
用户操作 / 系统事件
  │
  ├── visibilitychange (Web 标准)
  ├── app:foreground / app:background (Capacitor 桥接)
  │
  ▼
┌─────────────────────────────────────────────────┐
│ 连接层                                            │
│  SignalingConnection (信令 WS, per-tab 单例)      │
│  BotConnection (RPC over DataChannel, per-bot)   │
│  SSE (bot 快照 + 状态推送 + 心跳超时检测)           │
└──────────┬──────────────────────────────────────┘
           │ 连接状态变化 → 触发数据恢复
           ▼
┌─────────────────────────────────────────────────┐
│ 数据层                                            │
│  botsStore → agentsStore / sessionsStore / topicsStore │
│  chatStore → messages / history                   │
│  agentRunsStore → streaming runs reconcile        │
└──────────┬──────────────────────────────────────┘
           │ 数据就绪 → 驱动 UI 更新
           ▼
┌─────────────────────────────────────────────────┐
│ UI 层                                             │
│  ChatPage connReady watcher / 前台恢复             │
│  Draft 持久化与恢复                                │
│  发送失败输入恢复                                   │
│  滚动位置管理                                      │
└─────────────────────────────────────────────────┘
```

---

## 2. 连接层恢复

### 2.1 信令 WS 自动重连（指数退避）

- **文件**：`services/signaling-connection.js`
- **触发**：WS `close` 事件且非主动断连
- **行为**：`__scheduleReconnect()` — 延迟从 1s 开始，每次翻倍，上限 30s，±30% 随机抖动
- **场景**：Web + Capacitor

### 2.2 信令 WS 心跳（ping/pong）

- **文件**：`services/signaling-connection.js`
- **参数**：每 25s 发送 `{ type: "ping" }`；任何入站消息重置 45s 超时计时器并更新 `__lastAliveAt`
- **判定**：连续 2 次 miss（~90s）→ `ws.close(4000, 'heartbeat_timeout')` → 触发自动重连
- **说明**：信令 WS 仅承载 SDP/ICE 信令和心跳，不承载业务 RPC。业务 RPC 走 DataChannel，其超时由 `BotConnection.request()` 独立控制
- **场景**：Web + Capacitor

### 2.3 前台恢复重连

- **文件**：`services/signaling-connection.js`（`__handleForegroundResume`）
- **触发**：`visibilitychange`（visible）、`app:foreground` 或 `network:online`，500ms 节流去重
- **分级策略**：

| 条件 | 行为 |
|------|------|
| WS 已断连（`state === 'disconnected'`） | 重置退避到 1s，立即重连 |
| 已连接 + 静默超过 45s（`ASSUME_DEAD_MS`） | `forceReconnect()`（关旧 WS、立即重建） |
| 已连接 + 静默超过 2.5s（`PROBE_TIMEOUT_MS`） | 发 probe ping，2.5s 无响应则 `forceReconnect()` |
| 已连接 + 静默 ≤ 2.5s | 无需操作 |

- 恢复后发出 `foreground-resume` 事件，由 `bots.store` 对每个 bot 执行 `__checkAndRecover()`（含 RTC 状态检测和重建）
- **场景**：Web + Capacitor

### 2.4 RTC ICE restart 与 full rebuild

- **文件**：`services/webrtc-connection.js`
- **触发**：ICE `connectionState` 变为 `failed`；或前台恢复时 PC 处于 `disconnected`
- **行为**：
  - ICE restart（最多 2 次）→ `createOffer({ iceRestart: true })`
  - Full rebuild（最多 3 次）→ 销毁旧 PeerConnection，重新协商
  - 全部用尽 → `state = 'failed'`，`clearRtc()` reject 所有挂起请求（`RTC_LOST`），等下次 WS 重连重试
- **场景**：Web + Capacitor

### 2.5 RTC 大 payload 处理（DataChannel 分片）

- **文件**：`services/webrtc-connection.js`、`utils/dc-chunking.js`
- **机制**：DataChannel 通过分片（chunking）传输大 payload
- **流控**：发送端 high water mark 1MB / low water mark 256KB，超限时暂停发送，`bufferedamountlow` 恢复
- **DC 不可用**：`request()` 通过 `waitReady()` 自动等待连接恢复（connectTimeout 默认 30s），不再直接 reject
- **场景**：Web + Capacitor

### 2.6 SSE 恢复

- **文件**：`composables/use-bot-status-sse.js`
- **恢复路径**：
  - **浏览器原生重连**：`EventSource` 断开后自动重连
  - **前台恢复强制重建**：`app:foreground` / `network:online` → `restart()`，销毁旧 EventSource 并新建
  - 两种路径的 `onopen` 后 server 推送 `bot.snapshot` 全量快照，UI 通过 `applySnapshot()` 同步
- **SSE 重建不重置 botsStore**：`restart()` 仅销毁/重建 EventSource，不清空 `botsStore.byId`。旧数据保留直到新快照到达后被 `applySnapshot()` 全量替换。这避免了列表闪烁（清空→重填），也不影响正确性——新快照会修复所有不一致
- **场景**：Web + Capacitor

### 2.7 SSE 心跳与超时检测

- **文件**：`server/src/routes/bot.route.js`（Server）、`composables/use-bot-status-sse.js`（UI）
- **Server**：每 30s 发送 `data: {"event":"heartbeat"}\n\n` 应用层心跳
- **UI**：收到任何 SSE 消息（含心跳）重置 65s 超时计时器；超时未收到数据则自动 `restart()`
- **场景**：Web + Capacitor

---

## 3. 数据层恢复

### 3.1 重连后按断连时长刷新

- **文件**：`stores/bots.store.js`（`__refreshIfStale`）
- **触发**：RTC DataChannel 重建成功（`__ensureRtc` 或 `onRtcStateChange` 回调），且已初始化过（非首次），且断连时长 ≥ 5s（`BRIEF_DISCONNECT_MS`）
- **行为**：重新 `loadAgents()`、`loadAllSessions()`、`loadAllTopics()`、`loadDashboard()`（bot 列表由 SSE 快照维护）
- **短暂抖动（< 5s）**：跳过刷新，避免无意义开销
- **场景**：Web + Capacitor

### 3.2 首次连接完整初始化

- **文件**：`stores/bots.store.js`（`__fullInit`）
- **触发**：bot 首次 DC 就绪（`bot.initialized === false`）
- **行为**：插件版本检查 → `loadAgents()` + `loadAllSessions()` + `loadAllTopics()`
- **场景**：Web + Capacitor

### 3.3 connReady watcher 驱动消息加载

- **文件**：`views/ChatPage.vue`
- **计算属性**：`connReady` = `bot.online` + `bot.dcReady` + `agentVerified`（topic 模式跳过 agent 验证）
- **触发**：`connReady` 从 false 变为 true
- **行为**：
  - 调用 `chatStore.__reconcileSlashCommand()`
  - 首次加载：`loadMessages()` + `__loadChatHistory()`
  - 已加载过：`loadMessages({ silent: true })`
  - 设置 `__lastResumeAt` 防止与前台恢复去重
- **场景**：Web + Capacitor

### 3.4 ChatPage 前台恢复静默刷新

- **文件**：`views/ChatPage.vue`（`__handleForegroundResume`）
- **触发**：`visibilitychange`（visible）或 `app:foreground`，与 connReady watcher 2s 去重
- **行为**：若 `connReady` 已为 true，直接 `loadMessages({ silent: true })`。若 false，由 connReady watcher 处理
- **意义**：覆盖"WS 未断连的短暂后台"场景（connReady 无状态转换，watcher 不触发）
- **场景**：Web + Capacitor

### 3.5 SSE 快照全量同步

- **文件**：`composables/use-bot-status-sse.js`、`stores/bots.store.js`（`applySnapshot`）
- **触发**：SSE 连接/重连成功后，server 主动推送 `bot.snapshot` 事件
- **行为**：`botsStore.applySnapshot(items)` 全量更新 bot 列表（同步连接、清理已移除 bot 的 RTC/sessions/agentRuns）
- **SSE 是 bot 列表的唯一数据源**：无 HTTP 回退路径。SSE 与 HTTP 端点请求同一台 server、同一数据库，独立 HTTP 回退无额外容错价值
- **`fetched` 状态语义**：`applySnapshot` 设置 `fetched = true`，标记"bot 列表数据就绪"。在单次登录会话内 `fetched` 一旦为 `true` 不会再变回 `false`（SSE 重建只会触发新的 `applySnapshot` 覆盖数据，不会重置 `fetched`）。仅 logout 时 `botsStore.$reset()` 恢复初始状态
- **竞态保护**：server 端先 `await sendSnapshot()` 再 `registerSseClient()`，确保增量事件不会在快照之前到达客户端
- **场景**：Web + Capacitor

### 3.6 Dashboard / ManageBots 前台恢复

- **文件**：`views/AdminDashboardPage.vue`、`views/ManageBotsPage.vue`
- **触发**：`visibilitychange`（visible）或 `app:foreground`，2s 节流去重
- **行为**：重新调用 `loadData()`，刷新 dashboard 统计数据
- **意义**：Dashboard 数据不像 ChatPage 那样有 connReady watcher 驱动，需要显式前台恢复
- **场景**：Web + Capacitor

### 3.7 loadAllSessions 增量合并

- **文件**：`stores/sessions.store.js`（`__doLoadAll`）
- **设计**：加载时仅替换本次查询到的 bot 的 sessions，保留未查询 bot 的已有 sessions
- **背景**：多 bot 分时重连时，先重连的 bot 触发 `loadAllSessions`，若整体替换会覆盖尚在重连中的 bot 的 sessions
- **附加**：无已连接 bot 时 skip 而非清空，避免短暂全断期间丢失数据
- **场景**：Web + Capacitor

### 3.8 MainList botListKey watcher

- **文件**：`components/MainList.vue`
- **触发**：bot 列表变化（增删/上线状态变化）
- **行为**：`loadAllAgents()` + `loadAllTopics()`
- **场景**：Web + Capacitor

### 3.9 chatStore 激活与重入

- **文件**：`views/ChatPage.vue`（chatStore watcher）
- **触发**：chatStore 计算属性变化（首次进入或路由切换导致 store 变更）
- **行为**：`store.activate()` — 首次初始化 → 加载消息；重新进入 → `loadMessages({ silent: true })`
- **场景**：Web + Capacitor

---

## 4. 消息发送与 Agent Run 恢复

### 4.1 sendMessage 断连自动重试

- **文件**：`stores/chat.store.js`
- **触发**：发送过程中 DC 断连（`isDisconnectError(err)`），且消息尚未被服务端 accepted，且未重试过
- **行为**：递归调用 `sendMessage`（携带相同 idempotencyKey），内层 `request()` 通过 `waitReady()` 自动等待连接恢复（connectTimeout 默认 30s）
- **场景**：Web + Capacitor

### 4.2 accepted 消息 reconcile

- **文件**：`stores/chat.store.js`
- **触发**：消息已被 accepted 但 agent 尚未完成时 DC 断连
- **行为**：settle run 并调用 `__reconcileMessages()`。`__reconcileMessages` 通过 `getReadyConn()` 检查连接——若 DC 未就绪则跳过，由后续 `__refreshIfStale` 在连接恢复时自动触发刷新
- **场景**：Web + Capacitor

### 4.3 Agent Run reconcile（僵尸 run 检测）

- **文件**：`stores/agent-runs.store.js`（`reconcileAfterLoad`）
- **触发**：`loadMessages` 成功后调用
- **行为**：检测两个条件同时满足的僵尸 run：
  1. 事件流已静默（`lastEventAt` 距今超过 3s）
  2. 服务端消息已包含 run 的最终结果（有 terminal `stopReason`）
  → settle 该 run
- **意义**：覆盖断连期间 `event:agent` 的 `lifecycle:end` 事件丢失的情况
- **场景**：Web + Capacitor

### 4.4 Slash command reconcile

- **文件**：`stores/chat.store.js`（`__reconcileSlashCommand`）
- **触发**：connReady watcher 或前台恢复时调用，检测到 `__slashCommandRunId` 不为 null
- **行为**：清理 slash command 状态（定时器、event:chat 监听器、本地乐观消息），resolve pending promise（非 reject）。后续 `loadMessages` 恢复正确状态
- **背景**：slash command 采用两阶段响应（RPC 立即返回 `{ status: "started" }`，完成通过 `event:chat` 广播），WS 重连后 `event:chat` 丢失会导致 UI 永久锁定在 `sending=true`
- **场景**：Web + Capacitor

---

## 5. UI 层恢复

### 5.1 输入草稿持久化与恢复

- **文件**：`stores/draft.store.js`
- **存储后端**：Capacitor → `localStorage`（跨进程生命周期持久）；Web → `sessionStorage`（多窗口隔离）
- **storage key**：`coclaw:drafts:<userId>`（用户隔离）
- **持久化时机**：`beforeunload` + `visibilitychange:hidden` + `app:background`
- **恢复时机**：`initPersist()` → 立即 `restore()`；`onUserChanged()` → 切换用户存储空间
- **发送中保护**：发送前清空输入框但在 draftStore 保留 pending draft，accepted 后才清除。进程被 kill 后恢复仍可读取
- **场景**：Web + Capacitor

### 5.2 发送失败输入恢复

- **文件**：`views/ChatPage.vue`
- **触发**：`sendMessage` 返回 `accepted: false`，或抛出错误且 `__accepted === false`
- **行为**：将文本恢复到输入框，调用 `chatInput.restoreFiles(files)` 恢复附件
- **场景**：Web + Capacitor

### 5.3 消息变化自动滚动

- **文件**：`views/ChatPage.vue`
- **触发**：`chatMessages` 计算属性变化（新消息到达、加载完成）
- **行为**：`scrollToBottom()`
- **场景**：Web + Capacitor

### 5.4 登录/登出 draft 切换

- **文件**：`stores/auth.store.js`、`stores/draft.store.js`
- **触发**：login / register 成功、refreshSession 成功、logout
- **行为**：
  - 登录/注册：`draftStore.onUserChanged()` → 清空内存态 → 从新用户 storage key 恢复
  - 登出：先 `persist()` 当前用户草稿，再 `onUserChanged()` 切换
- **场景**：Web + Capacitor

---

## 6. 认证恢复

### 6.1 路由守卫刷新 session

- **文件**：`router/index.js`
- **触发**：每次导航到 `meta.requiresAuth === true` 的路由
- **行为**：`authStore.refreshSession()` → HTTP 请求验证 session → 未认证则重定向 `/login`（保留 `?redirect=` 原路径）
- **场景**：Web + Capacitor

### 6.2 ~~session.expired 事件~~（已移除）

> 历史上 Server 通过 per-bot WS 推送 `session.expired`，由 BotConnection 处理。当前架构中此路径不存在——session 过期统一由 HTTP 401 拦截（6.3）覆盖。

### 6.3 HTTP 401 统一拦截

- **文件**：`services/http.js`
- **触发**：任何非 `fetchSessionUser` 的 HTTP 请求返回 401
- **行为**：派发 `auth:session-expired` DOM 自定义事件（3s 节流去重）
- **设计**：使用 DOM 事件避免 http.js 与 router/store 的循环依赖
- **场景**：Web + Capacitor

### 6.4 ~~WS session-expired 桥接~~（已移除）

> 历史上 `bots.store.__bridgeConn` 将 BotConnection 的 `session-expired` 事件桥接为 DOM 事件。当前 `__bridgeConn` 仅处理 RTC 回调注入和 agent 事件分发，session 过期由 HTTP 401（6.3）统一处理。

### 6.5 auth:session-expired 统一监听

- **文件**：`layouts/AuthedLayout.vue`
- **触发**：`auth:session-expired` DOM 事件（来源：6.3 HTTP 401 或 6.4 WS session-expired）
- **行为**：调用 `authStore.logout()` 执行完整清理（disconnectAll、store reset、draft persist），然后跳转 `/login`（保留 `?redirect=`）。`logout()` 内部已处理 401（session 过期时 logout API 返回 401 属正常），外层 try/catch 兜底防止意外错误阻断跳转
- **场景**：Web + Capacitor

### 6.6 前台恢复刷新 session

- **文件**：`layouts/AuthedLayout.vue`
- **触发**：`visibilitychange`（visible）或 `app:foreground`
- **行为**：调用 `authStore.refreshSession()`，若 session 已过期则 401 → 6.3 → 6.5 自动跳转登录页
- **与路由守卫互补**：路由守卫覆盖"导航时验证"，此处覆盖"停留在页面不导航时的后台恢复验证"
- **场景**：Web + Capacitor

---

## 7. Capacitor 特有

### 7.1 app:foreground / app:background 事件桥接

- **文件**：`utils/capacitor-app.js`（`setupAppStateChange`）
- **行为**：将 Capacitor 原生 `appStateChange({ isActive })` 转义为标准 DOM 自定义事件 `app:foreground` / `app:background`
- **消费者**：SignalingConnection、SSE、ChatPage、AdminDashboardPage、ManageBotsPage、DraftStore、Router、AuthedLayout
- 消费者无需依赖 Capacitor SDK，只需监听标准 DOM 事件

### 7.x 网络变化桥接（network:online）

- **文件**：`utils/capacitor-app.js`（`setupNetworkListener` + 模块级 Web online 桥接）
- **机制**：
  - **Capacitor**：`@capacitor/network` 的 `networkStatusChange` → 当 `connected === true` 时派发 `network:online` DOM 事件
  - **Web**：浏览器原生 `online` 事件 → 同样桥接为 `network:online` DOM 事件
- **消费者**：SignalingConnection（即时 probe/重连）、SSE（restart）
- **效果**：WiFi↔蜂窝切换或断网恢复后，无需等待心跳超时（~90s），可立即检测并恢复连接
- **去重**：BotConnection 的 `__handleForegroundResume` 已有 500ms 节流，`network:online` + `app:foreground` 同时到达时自动去重

### 7.2 Deep Link 路由导航

- **文件**：`utils/capacitor-app.js`（`setupDeepLink`）、`utils/tauri-app.js`（`initDeepLink`）
- **触发**：`coclaw://` URL scheme 打开（通过 `App.addListener('appUrlOpen', ...)` 或 Tauri `onOpenUrl`）
- **行为**：解析 URL 路径后调用 `router.push()`，如 `coclaw://chat/bot1/main` → `/chat/bot1/main`
- **场景**：Capacitor (Android) + Tauri (Desktop)

### 7.3 冷启动路由恢复

- **文件**：`router/index.js`
- **机制**：
  - `app:background` → 保存 `router.currentRoute.value.fullPath` 到 `localStorage`（排除 login/register）
  - `app:foreground` → 清除（暖恢复不需要，路由仍在内存中）
  - 冷启动 → `router.beforeEach` 首次导航时读取并恢复，然后清除
- **auth 兼容**：恢复的路由若需要认证，由后续 beforeEach auth guard 正常处理
- **不恢复滚动位置**：消息列表始终 scroll-to-bottom，其他页面滚动位置不关键

### 7.4 KeepAlive 前台服务（Android）

- **文件**：`utils/capacitor-app.js`
- **行为**：通过 `registerPlugin('KeepAlive')` 启动 Android 前台服务（`FOREGROUND_SERVICE_DATA_SYNC`），降低进程被系统杀死的概率
- **限制**：保活的是原生进程，不是 WebView 的 JS 执行

---

## 8. 心跳与探测汇总

| 层 | 机制 | 间隔 | 超时判定 | 文件 |
|----|------|------|---------|------|
| UI → Server 信令 WS | `{ type: "ping" }` | 25s | 2 × 45s miss → close | `signaling-connection.js` |
| UI → Server 信令 WS | 前台 probe | 即时 | 2.5s 无响应 → forceReconnect | `signaling-connection.js` |
| Server → UI SSE | `data: {"event":"heartbeat"}` | 30s | UI 65s 无数据 → restart | `bot.route.js` / `use-bot-status-sse.js` |
| Plugin → Server WS | `{ type: "ping" }` | 25s | 4 × 45s miss → close | `realtime-bridge.js` |
| Server → Bot WS | `ws.ping()` 协议级 | 45s | 4 miss → terminate | `bot-ws-hub.js` |

---

## 9. 设计决策记录

### 信令心跳独立于业务 RPC

信令 WS 仅承载 SDP/ICE 信令和心跳，不承载业务 RPC。心跳超时判定简单明确：`HB_MAX_MISS = 2`（~90s）。业务 RPC 走 DataChannel，由 `BotConnection.request()` 的两层超时（connectTimeout + requestTimeout）独立控制。

### visibilitychange + app:foreground + network:online 多信号去重

三个信号取并集，通过时间戳节流去重：
- SignalingConnection：`__lastForegroundAt` + 500ms
- ChatPage：`__lastResumeAt` + 2s（connReady watcher 触发时也更新此时间戳）

### 冷启动 vs 暖恢复的区分

不需要显式检测。冷启动时 JS VM 完全重建，`appStateChange` listener 尚未注册，不会收到 `app:foreground` 事件。`localStorage` 中残留的路由说明上次是非正常退出（OS kill），应恢复。暖恢复时 `app:foreground` 触发后立即清除保存的路由。

### RTC 前台恢复策略

UDP NAT 超时（30s~2min）远短于 TCP（5~30min），中等后台后 RTC DTLS 通道大概率失效而信令 WS 仍存活。`request()` 检测 DC 未就绪时通过 `waitReady()` 自动排队等待连接恢复（同时触发重连），对调用方透明。前台恢复时 `bots.store.__checkAndRecover()` 对 `disconnected` 状态主动触发 RTC 重建（而非等 `failed`），节省 2-5s。
