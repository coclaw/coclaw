# CoClaw UI 状态恢复全景

> 适用范围：CoClaw UI
> 创建时间：2026-03-26
> 最后更新：2026-04-19

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
│  ClawConnection (RPC over DataChannel, per-claw)  │
│  SSE (claw 快照 + 状态推送 + 心跳超时检测)          │
└──────────┬──────────────────────────────────────┘
           │ 连接状态变化 → 触发数据恢复
           ▼
┌─────────────────────────────────────────────────┐
│ 数据层                                            │
│  clawsStore → agentsStore / sessionsStore / topicsStore │
│  chatStore → messages / history                   │
│  agentRunsStore → streaming runs reconcile        │
└──────────┬──────────────────────────────────────┘
           │ 数据就绪 → 驱动 UI 更新
           ▼
┌─────────────────────────────────────────────────┐
│ UI 层                                             │
│  ChatPage connReady watcher                       │
│  Dashboard / Claws / AuthedLayout app:foreground │
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
- **说明**：信令 WS 仅承载 SDP/ICE 信令和心跳，不承载业务 RPC。业务 RPC 走 DataChannel，其超时由 `ClawConnection.request()` 独立控制
- **场景**：Web + Capacitor

### 2.3 前台恢复重连

- **文件**：`services/signaling-connection.js`（`__handleForegroundResume`）
- **触发**：`app:foreground` 或 `network:online`（**不再监听 `visibilitychange`**——移动浏览器已由 `capacitor-app.js` 桥接成 `app:foreground`，桌面浏览器 tab 切换不应触发 WS 重建）
- **平台门控**：`app:foreground` 仅在 `isMobileOs` 时处理（Electron 桌面壳子的 app:foreground 跳过，因为桌面后台 WS 持续运行）
- **节流**：500ms 去重（`network:online` 豁免）
- **分级策略**：

| 条件 | 行为 |
|------|------|
| WS 已断连（`state === 'disconnected'`） | 重置退避到 1s，立即重连 |
| `state === 'connecting'` + 驻留 > 15s（`CONNECT_TIMEOUT_MS`） | `forceReconnect()`（视为卡死，通常发生在后台期间 TLS 握手停滞） |
| `state === 'connecting'` + 驻留 ≤ 15s | 不干预（等握手自然完成） |
| `network:online` + `typeChanged=true` | `forceReconnect()`（IP 可能变更，旧 TCP 几乎必死） |
| `network:online` + `typeChanged=false` + 静默 > 2.5s | 发 probe ping，失败则 forceReconnect |
| `network:online` + `typeChanged=false` + 静默 ≤ 2.5s | 跳过（心跳足以兜底） |
| `app:foreground` + 静默超过 45s（`ASSUME_DEAD_MS`） | `forceReconnect()` |
| `app:foreground` + 静默超过 2.5s | 发 probe ping，2.5s 无响应则 `forceReconnect()` |
| `app:foreground` + 静默 ≤ 2.5s | 无需操作 |

- signaling **不再对外 emit** `foreground-resume` 事件。RTC 恢复决策完全独立，claws.store 直接监听 window 的 `app:foreground` / `network:online` / `app:background`，详见 §2.4 和 §9
- **场景**：Web + Capacitor + 移动浏览器（后两者通过 `capacitor-app.js` 桥接提供 `app:foreground`）

#### `ensureConnected` 的新鲜度兜底

`SignalingConnection.ensureConnected()` 是 RTC 在发信令前的确保点。为防范"JS 层 state 盲信"（长后台后 TCP 实死但 `state === 'connected'` 尚未察觉、或 `connecting` 卡死），内置两条兜底规则：

- `state === 'connected'` 且距上次收消息 > 45s（`HB_TIMEOUT_MS`）→ 不信任，主动 `forceReconnect()` 并等待新 WS
- `state === 'connecting'` 且 `__stateEnteredAt` 驻留 > 15s（`CONNECT_TIMEOUT_MS`）→ 视为卡死，`forceReconnect()` 后再等

该兜底让 RTC 不再依赖"前台事件处理顺序"的隐含假设（即使 RTC 的 handler 比 WS 先跑，也能自己判断 WS 新鲜度）。两条规则对并发 caller 安全：首次 `forceReconnect` 同步把 state 切到 `disconnected → connecting` 并重置 `__stateEnteredAt`，后续 caller 观察到的 elapsed 已接近 0，不会重复 rebuild。

### 2.4 RTC ICE restart 与 full rebuild

- **文件**：`services/webrtc-connection.js`
- **设计文档**：`docs/designs/ice-restart-recovery.md`
- **触发**：ICE `connectionState` 变为 `failed`；或前台恢复时 PC 处于 `disconnected`
- **行为**：
  - ICE `disconnected` → 等待 ICE 自愈（5s 超时，`DISCONNECTED_TIMEOUT_MS`）
  - ICE restart（pion impl）→ 在现有 PC 上重新协商 ICE 层，DTLS/SCTP/DataChannel 保留。ICE check 失败后立即重试，总时间预算 90s（`ICE_RESTART_TIMEOUT_MS`），15s 安全网定时器补位（`ICE_RESTART_SAFETY_MS`）
  - Plugin 为 ndc/werift impl 时 → 立即收到 `rtc:restart-rejected`（reason=`impl_unsupported`）→ 跳过 restart，直接进入 rebuild
  - Restart 超时或被 reject → `state = 'failed'` → store 退避重试 → full rebuild（获取新 TURN 凭证，新建 PeerConnection）
- **场景**：Web + Capacitor

### 2.5 RTC 大 payload 处理（DataChannel 分片）

- **文件**：`services/webrtc-connection.js`、`utils/dc-chunking.js`
- **机制**：DataChannel 通过分片（chunking）传输大 payload
- **流控**：发送端 high water mark 1MB / low water mark 256KB，超限时暂停发送，`bufferedamountlow` 恢复
- **DC 不可用**：`request()` 通过 `waitReady()` 自动等待连接恢复（connectTimeout 默认 120s，覆盖 ICE restart 90s 预算），不再直接 reject；调用方可通过 `options.signal` 主动放弃等待
- **场景**：Web + Capacitor

### 2.6 SSE 恢复

- **文件**：`composables/use-claw-status-sse.js`
- **恢复路径**：
  - **浏览器原生重连**：`EventSource` 断开后自动重连
  - **前台恢复强制重建**：`app:foreground` / `network:online` → `restart()`，销毁旧 EventSource 并新建
  - 两种路径的 `onopen` 后 server 推送 `claw.snapshot` 全量快照，UI 通过 `applySnapshot()` 同步
- **SSE 重建不重置 clawsStore**：`restart()` 仅销毁/重建 EventSource，不清空 `clawsStore.byId`。旧数据保留直到新快照到达后被 `applySnapshot()` 全量替换。这避免了列表闪烁（清空→重填），也不影响正确性——新快照会修复所有不一致
- **场景**：Web + Capacitor

### 2.7 SSE 心跳与超时检测

- **文件**：`server/src/routes/bot.route.js`（Server）、`composables/use-claw-status-sse.js`（UI）
- **Server**：每 30s 发送 `data: {"event":"heartbeat"}\n\n` 应用层心跳
- **UI**：收到任何 SSE 消息（含心跳）重置 65s 超时计时器；超时未收到数据则自动 `restart()`
- **场景**：Web + Capacitor

---

## 3. 数据层恢复

### 3.1 重连后按断连时长刷新

- **文件**：`stores/claws.store.js`（`__refreshIfStale`）
- **触发**：RTC DataChannel 重建成功（`__ensureRtc` 或 `onRtcStateChange` 回调），且已初始化过（非首次），且断连时长 ≥ 30s（`BRIEF_DISCONNECT_MS`）
- **行为**：仅刷新当前 claw —— `loadAgents(id)`、`loadSessionsForClaw(id)`、`loadTopicsForClaw(id)`、`loadDashboard(id)`（claw 列表由 SSE 快照维护）
- **per-claw 局部刷新**：refresh / init 路径中的所有数据加载均按 claw 局部进行，避免多 claw 错峰恢复时全量横扫造成的 N² RPC 放大
- **短暂抖动（< 30s）**：跳过刷新，避免无意义开销。`disconnectedAt` 在 PC 进入 `restarting`/`failed`/`closed` 时打点，长后台恢复场景的 gap 远超 30s，不会被误吞
- **场景**：Web + Capacitor

### 3.2 首次连接完整初始化

- **文件**：`stores/claws.store.js`（`__fullInit`）
- **触发**：claw 首次 DC 就绪（`claw.initialized === false`）
- **行为**：插件版本检查 → `loadAgents(id)` + `loadSessionsForClaw(id)` + `loadTopicsForClaw(id)` + `loadDashboard(id)`（per-claw，与 §3.1 一致）
- **场景**：Web + Capacitor

### 3.3 connReady watcher 驱动消息加载

- **文件**：`views/ChatPage.vue`
- **计算属性**：`connReady` = `claw.dcReady` + `agentVerified`（topic 模式跳过 agent 验证）。不读 `claw.online`——presence 不参与通信就绪判断，详见 `docs/architecture/communication-model.md` §5.5
- **触发**：`connReady` 从 false 变为 true
- **行为**：
  - 调用 `chatStore.__reconcileSlashCommand()`（清理挂起的 slash 命令）
  - 首次加载：`loadMessages()` + `__loadChatHistory()`
  - 已加载过：`loadMessages({ silent: true })`
- **场景**：Web + Capacitor
- **设计取舍**：ChatPage 不再监听 `visibilitychange` / `app:foreground`。消息刷新完全由 connReady 翻转驱动——DC 不断时 `event:agent` 实时推送、agentRunsStore 增量合并；DC 断后恢复时 connReady 翻转触发 silent reload。
  - 边界场景"DC 全程未断、应用层数据陈旧"由用户手动刷新或路由跳走再回来兜底（`chatStore.activate()` 重入分支会触发 silent reload）。生产数据（`tmp/connection-instability-analysis-2026-04-19.md`）显示该边界无观测到的发生频次，且原"前台恢复 silent reload"在 6h 25 次触发中零救回数据，故移除。

### 3.5 SSE 快照全量同步

- **文件**：`composables/use-claw-status-sse.js`、`stores/claws.store.js`（`applySnapshot`）
- **触发**：SSE 连接/重连成功后，server 主动推送 `claw.snapshot` 事件
- **行为**：`clawsStore.applySnapshot(items)` 全量更新 claw 列表（同步连接、清理已移除 claw 的 RTC/sessions/agentRuns）
- **SSE 是 claw 列表的唯一数据源**：无 HTTP 回退路径。SSE 与 HTTP 端点请求同一台 server、同一数据库，独立 HTTP 回退无额外容错价值
- **`fetched` 状态语义**：`applySnapshot` 设置 `fetched = true`，标记"claw 列表数据就绪"。在单次登录会话内 `fetched` 一旦为 `true` 不会再变回 `false`（SSE 重建只会触发新的 `applySnapshot` 覆盖数据，不会重置 `fetched`）。仅 logout 时 `clawsStore.$reset()` 恢复初始状态
- **竞态保护**：server 端先 `await sendSnapshot()` 再 `registerSseClient()`，确保增量事件不会在快照之前到达客户端
- **场景**：Web + Capacitor

### 3.6 Dashboard / ManageClaws 前台恢复

- **文件**：`views/AdminDashboardPage.vue`、`views/ManageClawsPage.vue`
- **触发**：`app:foreground`（移动浏览器经 `capacitor-app.js` 桥接 visibility 覆盖）；**不再监听 `visibilitychange`**——避免桌面 tab 切换的高频请求
- **freshness gate**：60 秒内不重复 `loadData()`；失败回退到 30 秒冷却（`__lastLoadedAt = now - 30s`）防服务端 5xx 时的重试风暴
- **意义**：Dashboard / Claws 数据不经 DC 推送，无 connReady 驱动，需显式前台恢复；同时桌面长驻用户可通过顶栏刷新按钮主动刷新
- **场景**：Web + Capacitor

### 3.7 sessions / topics 加载语义

- **文件**：`stores/sessions.store.js`、`stores/topics.store.js`
- **per-claw 路径**（重连恢复 / 首次 init）：`loadSessionsForClaw(id)` / `loadTopicsForClaw(id)` 仅替换该 claw 的数据，其他 claw 旧数据保留；同 claw 并发调用按 in-flight Map 合流；fetch 期间 claw 被移除则丢弃结果
- **全量路径**（MainList 列表渲染）：`loadAllTopics()` 走全量增量合并——仅替换本次查询到的 claw 的 topics，未查询/失败的 claw 旧数据保留。`loadAllSessions()` 当前无生产调用方（保留为内部接口）
- **附加**：无已连接 claw 时 skip 而非清空，避免短暂全断期间丢失数据
- **场景**：Web + Capacitor

### 3.8 MainList clawListKey watcher

- **文件**：`components/MainList.vue`
- **触发**：claw 列表变化（增删/上线状态变化）
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
- **行为**：递归调用 `sendMessage`（携带相同 idempotencyKey），内层 `request()` 通过 `waitReady()` 自动等待连接恢复（connectTimeout 默认 120s）
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

> 历史上 Server 通过 per-claw WS 推送 `session.expired`，由 ClawConnection 处理。当前架构中此路径不存在——session 过期统一由 HTTP 401 拦截（6.3）覆盖。

### 6.3 HTTP 401 统一拦截

- **文件**：`services/http.js`
- **触发**：任何非 `fetchSessionUser` 的 HTTP 请求返回 401
- **行为**：派发 `auth:session-expired` DOM 自定义事件（3s 节流去重）
- **设计**：使用 DOM 事件避免 http.js 与 router/store 的循环依赖
- **场景**：Web + Capacitor

### 6.4 ~~WS session-expired 桥接~~（已移除）

> 历史上 `claws.store.__bridgeConn` 将 ClawConnection 的 `session-expired` 事件桥接为 DOM 事件。当前 `__bridgeConn` 仅处理 RTC 回调注入和 agent 事件分发，session 过期由 HTTP 401（6.3）统一处理。

### 6.5 auth:session-expired 统一监听

- **文件**：`layouts/AuthedLayout.vue`
- **触发**：`auth:session-expired` DOM 事件（来源：6.3 HTTP 401 或 6.4 WS session-expired）
- **行为**：调用 `authStore.logout()` 执行完整清理（disconnectAll、store reset、draft persist），然后跳转 `/login`（保留 `?redirect=`）。`logout()` 内部已处理 401（session 过期时 logout API 返回 401 属正常），外层 try/catch 兜底防止意外错误阻断跳转
- **场景**：Web + Capacitor

### 6.6 前台恢复刷新 session

- **文件**：`layouts/AuthedLayout.vue`
- **触发**：`app:foreground`（移动浏览器经 `capacitor-app.js` 桥接 visibility 覆盖）；**不再监听 `visibilitychange`**——桌面 tab 切换不再 churn session 验证
- **节流**：2s 节流（`app:foreground` 在 Capacitor 下可能多源派发，作幂等保险）
- **行为**：调用 `authStore.refreshSession()`，若 session 已过期则 401 → 6.3 → 6.5 自动跳转登录页
- **与路由守卫 + 401 拦截器互补**：路由守卫覆盖"导航时验证"，401 拦截器覆盖"任意 API 调用时验证"，此处覆盖"app 后台归来时的主动验证"
- **场景**：Web + Capacitor

---

## 7. Capacitor 特有

### 7.1 app:foreground / app:background 事件桥接

- **文件**：`utils/capacitor-app.js`
- **三个来源**：
  - **Capacitor 原生**（`setupAppStateChange`）：`appStateChange({ isActive })` → `app:foreground` / `app:background`
  - **Electron**（`electron-app.js`）：IPC 窗口可见事件 → 同样 DOM 事件
  - **移动浏览器**（模块级非原生 block）：`isMobileOs && !isNative` 时桥接 `document.visibilitychange` → `app:foreground` / `app:background`。这覆盖了 Android Chrome / iOS Safari 里直接访问 coclaw.net 的用户——OS 会冻结后台 tab 但浏览器不派发 app:foreground，桥接后所有只听 `app:foreground` 的模块（webrtc / claws / SSE / stream）也能正常恢复
- **桌面浏览器不桥接**：tab 切换不会挂起连接，桥接会带来无用的重建与日志噪音
- **消费者**：SignalingConnection、SSE、AdminDashboardPage、ManageClawsPage、DraftStore（`app:background` 持久化）、Router、AuthedLayout
  - **ChatPage 不在列**——消息刷新完全由 connReady watcher（DC 状态翻转）驱动，详见 §3.3
- 消费者无需依赖 Capacitor SDK，只需监听标准 DOM 事件
- **去抖策略（设计取舍）**：**不做源头层 dedup**，统一由消费者侧各自节流
  - SignalingConnection 500ms、use-claw-status-sse 500ms、admin-stream 500ms 的节流是**跨事件协调**（`app:foreground` 与 `network:online` 共享同一个 `__lastAt` 时间戳），作用是"本模块 500ms 内两种恢复事件只做一轮"。源头按事件名 dedup 无法替代这一协调语义
  - Capacitor 原生 `appStateChange` 存在多发（Android 生命周期双回调、权限弹窗返回等），实际损害停留在"多一次幂等 probe"级别，消费者侧节流已足够吸收
  - **若未来仍要在源头做**：正确语义是**状态机式**（维护 `_lastState` + `_lastDispatchAt`，同状态窗口内丢、状态变化立即放行），而非 per-event-name 独立计时——后者会在 `fg→bg→fg` 500ms 内吞掉最后的状态转换

### 7.2 网络变化桥接（network:online）

- **文件**：`utils/capacitor-app.js`（`setupNetworkListener` + 模块级 Web online 桥接）
- **机制**：
  - **Capacitor**：`@capacitor/network` 的 `networkStatusChange` → 当 `connected === true` 时经源头去抖后派发 `network:online` DOM 事件
  - **Web**：浏览器原生 `online` 事件 → 同样桥接为 `network:online` DOM 事件（Web 路径另有 `wasOffline` gate，无前置 offline 不派发）
- **消费者**：SignalingConnection（即时 probe/重连）、SSE（restart）、claws.store（逐 claw 按状态分级恢复）
- **效果**：WiFi↔蜂窝切换或断网恢复后，WS 无条件 `forceReconnect()`。RTC 层按 PC 状态和网络类型变化分级处理（详见 §9 "RTC 前台恢复策略"）
- **源头去抖**（Capacitor 分支，`dispatchNetworkOnline`）：trailing-edge debounce，窗口 1200ms，`typeChanged` 做 OR 聚合
  - 每次事件重置窗口，无新事件到达后以聚合结果派发一次
  - `typeChanged=true`（wifi↔cellular）与其它事件一样聚合等待；Android 切网瞬间连发多个事件（观测到 wifi→cellular→wifi 间隔 500–900ms），1200ms 覆盖最坏样本，最终派发一次 `typeChanged=true` 足够驱动下游完整恢复
  - 窗口内 `count>1` 时记一条 `app.network merged count=N typeChanged=...` 诊断日志；原始 `networkStatusChange` 事件的 `remoteLog` 在去抖之前记录，诊断粒度不丢
  - 取舍：trailing-edge 在 WiFi 切换场景多延迟约 1.2s 派发，换来"多次事件只做一轮恢复"的稳定性；ICE restart 自身 offer→answer 量级远大于此，感知不到
- **消费者侧节流**（保留）：SignalingConnection 500ms 节流（`network:online` 豁免；连续触发由 `connecting` 状态自然防护）；SSE restart 500ms 节流（防 `app:foreground + network:online` 同时触发）

### 7.3 Deep Link 路由导航

- **文件**：`utils/capacitor-app.js`（`setupDeepLink`）、`utils/tauri-app.js`（`initDeepLink`）
- **触发**：`coclaw://` URL scheme 打开（通过 `App.addListener('appUrlOpen', ...)` 或 Tauri `onOpenUrl`）
- **行为**：解析 URL 路径后调用 `router.push()`，如 `coclaw://chat/bot1/main` → `/chat/bot1/main`
- **场景**：Capacitor (Android) + Tauri (Desktop)

### 7.4 冷启动路由恢复

- **文件**：`router/index.js`
- **机制**：
  - `app:background` → 保存 `router.currentRoute.value.fullPath` 到 `localStorage`（排除 login/register）
  - `app:foreground` → 清除（暖恢复不需要，路由仍在内存中）
  - 冷启动 → `router.beforeEach` 首次导航时读取并恢复，然后清除
- **auth 兼容**：恢复的路由若需要认证，由后续 beforeEach auth guard 正常处理
- **不恢复滚动位置**：消息列表始终 scroll-to-bottom，其他页面滚动位置不关键

### 7.5 KeepAlive 前台服务（Android）

- **文件**：`utils/capacitor-app.js`
- **行为**：通过 `registerPlugin('KeepAlive')` 启动 Android 前台服务（`FOREGROUND_SERVICE_DATA_SYNC`），降低进程被系统杀死的概率
- **限制**：保活的是原生进程，不是 WebView 的 JS 执行

---

## 8. 心跳与探测汇总

| 层 | 机制 | 间隔 | 超时判定 | 文件 |
|----|------|------|---------|------|
| UI → Server 信令 WS | `{ type: "ping" }` | 25s | 2 × 45s miss → close | `signaling-connection.js` |
| UI → Server 信令 WS | 前台 probe | 即时 | 2.5s 无响应 → forceReconnect | `signaling-connection.js` |
| Server → UI SSE | `data: {"event":"heartbeat"}` | 30s | UI 65s 无数据 → restart | `bot.route.js` / `use-claw-status-sse.js` |
| Plugin → Server WS | `{ type: "ping" }` | 25s | 4 × 45s miss → close | `realtime-bridge.js` |
| Server → Bot WS | `ws.ping()` 协议级 | 45s | 4 miss → terminate | `bot-ws-hub.js` |

---

## 9. 设计决策记录

### 信令心跳独立于业务 RPC

信令 WS 仅承载 SDP/ICE 信令和心跳，不承载业务 RPC。心跳超时判定简单明确：`HB_MAX_MISS = 2`（~90s）。业务 RPC 走 DataChannel，由 `ClawConnection.request()` 的两层超时（connectTimeout + requestTimeout）独立控制。

### app 级 vs tab 级事件的分工

- **app 级**（`app:foreground` / `app:background`）：连接层 + 数据层前台刷新用——SignalingConnection、webrtc-connection、claws.store、use-claw-status-sse、admin-stream、app-update、AdminDashboardPage、ManageClawsPage、AuthedLayout。三种真实环境（Capacitor、Electron、移动浏览器）通过 `capacitor-app.js` 统一桥接。**桌面浏览器不派发**（有意为之——tab 切换不是"app 恢复"）。
- **tab 级**（`visibilitychange`）：仅 `draft.store`（hidden 时持久化草稿）。其他原本兼用 visibility 的页面（ChatPage / AdminDashboardPage / ManageClawsPage / AuthedLayout）已收敛为 app 级，移除 tab 级监听以消除桌面 tab 切换的连锁请求噪音；ChatPage 进一步取消所有外部事件监听，消息刷新完全由 connReady watcher 驱动。

### 多信号去重

- **WS 层**（SignalingConnection）：`__lastForegroundAt` + 500ms（`network:online` 豁免；连续 network:online 由 `connecting` 状态分支自然防护）
- **RTC 层**（claws.store）：`network:online` 按 PC 状态 + 网络类型变化分级处理；`app:foreground` 短后台（<25s）跳过 probe；`_probeInProgress` 防止同一 claw 并发 probe
- **AdminDashboardPage / ManageClawsPage**：`__lastLoadedAt` + 60s freshness gate（成功后 = now；失败后 = now - 30s 等价 30s 冷却防 5xx 重试风暴）
- **AuthedLayout**：`__lastResumeAt` + 2s（多源派发幂等保险；refreshSession 频率天然低，不加 freshness gate）
- **ChatPage**：无（消息刷新仅由 connReady watcher 驱动，不再监听任何外部事件）

### 冷启动 vs 暖恢复的区分

不需要显式检测。冷启动时 JS VM 完全重建，`appStateChange` listener 尚未注册，不会收到 `app:foreground` 事件。`localStorage` 中残留的路由说明上次是非正常退出（OS kill），应恢复。暖恢复时 `app:foreground` 触发后立即清除保存的路由。

### RTC 前台恢复策略

RTC 恢复决策基于 PC 自身状态、DC probe 和两把正交的"全局闸"（`claw.online` SSE presence + `_sigOffline` 信令 WS 可达性）作为门控。**主真相源**：`docs/architecture/communication-model.md` §5.5 / §5.5.1。四个入口：

- **SSE `claw.online=false`** → `__handleClawGoOffline`（暂停该 claw 的所有 RTC 主动恢复）：
  - `syncDashboardOffline`（dashboard 展示层同步）+ `__clearRetry`（停退避定时器）+ `rtc.pauseRestart()`（停 restart timer / poll / keepalive；清预算字段；epoch++；置 `__restartPaused=true`）
  - **不动 `dcReady` / `rtcPhase` / `disconnectedAt` / PC**：presence 与 DC 生命周期正交（commit `4a05074` 原则——详见通信模型 §5.5）
  - **不再** probe / triggerRestart：plugin 离线时这些动作必然无效，等 online 回来再动
- **SSE `claw.online=true`（从 false 转来）** → `__resumeOnline`（按 PC 状态分派，仅 rebuild 触发 refresh）：
  - **refresh 规则**（唯一触发场景是 rebuild）：
    - rebuild 路径（`failed`/`closed`/`idle`/`connecting`/rtc 为 null）→ add 到 `_pendingForceRefreshOnRebuild`，`__ensureRtc` 成功时消费并 force refresh。rebuild 建全新 PC + 全新 SCTP，plugin 侧旧 DC 发送 buffer 的 rpc msg 会丢、plugin 可能换端，必须主动刷
    - DC 延续路径（`connected` / `restarting`，含 forceRestart=true 的 ICE restart 子场景）→ **不刷**。PC 没 rebuild、SCTP 延续时，plugin 侧缓冲的 rpc msg 会随 ICE 恢复自然送达 UI；主动 refresh 是冗余流量
  - **PC 状态分派**：
    - `restarting`（pause 冻结而来）→ `rtc.triggerRestart('online_resume')`，firstTrigger 分支重采 ufragSnap，全新 90s 预算
    - `connected` + paused → 默认 `resumeRecovery`；forceRestart 命中时升级为 `triggerRestart('online_resume')`
    - `connected` + 非 paused → `__ensureRtc` 早退（不单独刷 dashboard，DC 延续场景对称不刷）
    - 其余 → `__ensureRtc` 全量 rebuild；rebuild 成功由 `_pendingForceRefreshOnRebuild` consume 统一刷 dashboard/agents/sessions/topics
- `network:online` → `__handleNetworkOnline`（按 PC 状态 + 网络类型变化分级处理，offline claw 被 gate 挡住）：
  - **类型变化**（WiFi↔蜂窝，由 Capacitor Network plugin `connectionType` 检测）→ 对每个 online claw triggerRestart / rebuild。旧 ICE 路径必然失效
  - **类型未变 + PC `failed`/`closed`** → 直接 rebuild（加速长 offline 后恢复）
  - **类型未变 + PC `connected`/`disconnected`** → 跳过。ICE 在前台持续运行，有 consent check 自检测能力
- `app:foreground` 且后台 < 25s → 跳过 probe。OS 给 app ~5s 收尾 + ICE 30s consent 超时 = 25s 内 ICE 有充足自恢复裕量
- `app:foreground` 且后台 ≥ 25s → 执行 `__checkAndRecover`（offline claw 被 gate 挡住）：
  - PC `failed`/`closed` → 直接 rebuild
  - PC `disconnected` → 不干预，交给 ICE 自恢复（WebRtcConnection 内部 5s 超时后升级到 failed → `__scheduleRetry`）
  - PC `connected` → DC probe（3s 超时）：
    - probe 成功 → 连接健康，不操作
    - probe 失败 + PC 仍 `connected` → 不 rebuild（可能是 plugin 繁忙导致 probe-ack 延迟）
    - probe 失败 + PC 已变为非 `connected` → rebuild

`request()` 检测 DC 未就绪时通过 `waitReady()` 自动排队等待连接恢复（同时触发重连），对调用方透明。

**online 门控的不变式**：`claw.online=false` 期间所有 RTC 主动恢复动作（restart / rebuild / retry 调度 / probe）都暂停，预算/计数清零，PC 保留。**不动 `dcReady` / `rtcPhase` / `disconnectedAt`**：presence 与 DC 生命周期正交（详见主真相源 `docs/architecture/communication-model.md` §5.5）。online 回来视为新一轮恢复事件。

**网络类型检测机制**：Capacitor Network plugin 的 `connectionType` 仅区分 `wifi`/`cellular`/`none`/`unknown`。`_lastConnectionType` 仅在 `connected=true` 且类型为 `wifi` 或 `cellular` 时更新；`none`（offline）和 `unknown` 不更新，避免污染后续比较基线。类型变化信息通过 `network:online` 事件的 `detail.typeChanged` 字段传递。

**待实施优化**：向 server 请求 UI 侧 IP 变化检测，作为网络类型变化检测的补充（覆盖 VPN 等 connectionType 不变但 IP 变化的场景）。
