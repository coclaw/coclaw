# Chat 状态管理架构

- **更新日期**：2026-04-02
- **适用范围**：`ui` 工作区中与 chat/topic 消息、agent run、连接状态、数据同步相关的全部状态管理

## 设计原则

> UI 中的相关 store 是 OpenClaw 对应实体的本地副本，通过事件驱动同步。

- Chat/topic 的消息状态独立于页面视图生命周期
- Agent run 是后台任务，其生命周期独立于发起它的页面
- Store 实例在导航间持续存活，切换页面不销毁数据
- 连接状态纳入 Pinia 响应式体系，下游一律通过 computed/watch 消费
- 禁止对含 `lastAliveAt` 等高频字段的对象使用 Vue deep watch——用 computed 收窄后再 watch

## 架构总览

```
SignalingConnection (per-bot, WebSocket)
  └─ 状态变化 → bots.store.__bridgeConn 桥接 → byId[botId] 响应式字段
  
WebRtcConnection (per-bot, DataChannel)
  └─ event:agent / event:chat 事件流
        │
        ▼ (bots.store.__bridgeConn 统一注册)
agentRunsStore (全局单例)
  ├─ runs: { [runId]: RunState }         ← 后台任务注册表
  ├─ runKeyIndex: { [runKey]: runId }    ← 按 chat/topic 查询
  └─ 调用 applyAgentEvent()             ← 纯函数（utils/agent-stream.js）
        │
        ▼ (getter 合并)
chatStoreManager (模块级单例)
  ├─ instances: Map<storeKey, ChatStore>
  ├─ topicLru: string[]                  ← topic LRU 淘汰序
  └─ get(storeKey, opts) → ChatStore     ← 惰性创建 + 缓存
        │
        ▼
ChatStore 实例 (per-chat/topic, Pinia store)
  ├─ messages: []                        ← 服务端加载的消息
  ├─ allMessages (getter)                ← messages + 活跃 run 的 streamingMsgs
  └─ isSending (getter)                  ← sending || agentRunsStore.isRunning(runKey)
        │
        ▼ (computed)
ChatPage
  ├─ chatStore (computed)                ← 由路由参数 + chatStoreManager 动态解析
  └─ connReady (computed)                ← bot.online + bot.dcReady + agentVerified
```

## 核心数据模型

### botsStore — 响应式连接状态

`stores/bots.store.js`

```javascript
state: () => ({
	byId: {},       // { [botId]: BotState }
	fetched: false, // SSE snapshot 至少完成一次
}),
getters: {
	items: (state) => Object.values(state.byId),
},
```

BotState 结构：

```javascript
{
	// 基础信息（HTTP/SSE 写入）
	id, name, online, lastSeenAt, createdAt, updatedAt,
	// RTC 生命周期（运行时写入）
	rtcPhase: 'idle',       // 'idle' | 'building' | 'ready' | 'recovering' | 'failed'
	lastAliveAt: 0,
	disconnectedAt: 0,
	dcReady: false,         // DataChannel 可用
	// 初始化标记
	initialized: false,     // 区分首次连接 vs 重连
	// 插件
	pluginVersionOk: null, pluginInfo: null, rtcTransportInfo: null,
}
```

**`__bridgeConn(botId)`**：在 `bots.store.js` 中注册，是唯一的连接状态桥接点。对每个 BotConnection：
- 注入 `conn.__onGetRtcPhase` / `conn.__onTriggerReconnect` 回调
- 统一注册 `conn.on('event:agent', payload => agentRunsStore.__dispatch(payload))`
- Bot 上线且未初始化时触发 `__fullInit`（加载 agents + sessions + topics + dashboard）

**`getReadyConn(botId)`**：导出的辅助函数，检查 `byId[botId]?.dcReady` 并返回 BotConnection 实例或 null。

### chatStoreManager — 多实例管理

`stores/chat-store-manager.js`

- `get(storeKey, opts)` 惰性创建 ChatStore 实例
- storeKey 格式：`session:${botId}:${agentId}` 或 `topic:${sessionId}`
- Chat 实例不淘汰（数量有限，包含历史 segments 等有价值缓存）
- Topic 实例 LRU 淘汰：上限 `MAX_TOPIC_INSTANCES = 10`，淘汰最久未用且无活跃 run 的实例

### ChatStore — per-chat/topic 消息状态

`stores/chat.store.js`，由 `createChatStore(storeKey, opts)` 工厂创建。

**关键 state**：
- Identity（创建时固定）：`botId`、`topicMode`、`chatSessionKey`、`sessionId`、`topicAgentId`
- 消息：`messages`、`currentSessionId`
- UI：`loading`、`sending`、`errorText`、`streamingRunId`、`resetting`
- 分页：`hasMoreMessages`、`messagesLoading`
- 历史懒加载：`historySessionIds`、`historySegments`、`historyLoading`、`historyExhausted`
- 文件上传：`uploadingFiles`、`uploadProgress`

**关键 getters**：
- `allMessages`：合并 `messages` + `agentRunsStore.getActiveRun(runKey).streamingMsgs`
- `isSending`：`sending || agentRunsStore.isRunning(runKey)`
- `runKey`：topic 模式用 `sessionId`，chat 模式用 `chatSessionKey`

**生命周期**：
- `activate()`：首次进入加载数据；再次进入静默刷新
- `cleanup()`：清理发送中的 promise/timer，**不销毁数据**
- `dispose()`：实例被 LRU 淘汰时的完整清理

### agentRunsStore — Agent Run 全局生命周期

`stores/agent-runs.store.js`

**State**：`runs: {}` (RunState by runId)、`runKeyIndex: {}` (runKey → runId)

**RunState 结构**：

```javascript
{
	runId, botId, runKey, topicMode,
	startTime,
	settled: false,     // 终态标记
	settling: false,    // 过渡态（lifecycle:end 已到达，等待 messages 刷新）
	lastEventAt: 0,     // 最后一次收到事件的时间戳
	streamingMsgs: [],  // 流式消息数组
	__conn,             // BotConnection 引用
	__timer,            // 30min 超时定时器
}
```

**关键常量**：
- `POST_ACCEPT_TIMEOUT_MS = 30 * 60_000`（30min 超时兜底）
- `STALE_RUN_MS = 3000`（事件流静默判定阈值）

**`reconcileAfterLoad(runKey, serverMessages)`**：重连后检测僵尸 run——`lastEventAt` 超过 3s 且服务端消息的最后一条 assistant 有终止 `stopReason`（非 `toolUse`）时 settle run。

## 消息流（Delta 模式）

> 流式事件直接以 delta 条目写入消息数组，消除虚拟消息概念，避免 `lifecycle:end` 时全量替换导致的 DOM 抖动。

### 乐观消息与流式标记

`sendMessage` 发送时立即追加两条本地条目到 `messages`：

```javascript
// 用户消息
{ _local: true, message: { role: 'user', content: text, timestamp } }
// 流式 bot 占位
{ _local: true, _streaming: true, _startTime: Date.now(),
  message: { role: 'assistant', content: '', stopReason: null } }
```

`onAccepted` 回调后，将 `_local` 条目从 `messages` 移入 `agentRunsStore.register()` 的 `streamingMsgs`。后续 delta 更新由 `agentRunsStore.__dispatch()` → `applyAgentEvent()`（`utils/agent-stream.js`）驱动。

### allMessages 合并

`allMessages` getter 动态合并 `messages`（服务端已持久化的）+ `agentRunsStore.getActiveRun(runKey).streamingMsgs`（活跃 run 的流式内容）。无活跃 run 时直接返回 `messages`。

### session-msg-group.js 流式支持

`groupSessionMessages` 识别条目上的 `_streaming` 和 `_startTime` 标记：
- 带 `_streaming` 的条目使 botTask 输出 `isStreaming: true`
- `_startTime` 传递到 `botTask.startTime`
- 流式 assistant 条目（`stopReason: null` + 空 content）不产出 `resultText`（表示"思考中"）

### lifecycle:end 两阶段处理

1. **settling 过渡态**（同步）：`agentRunsStore` 设 `run.settling = true`，`allMessages` getter 保留 streamingMsgs 直到下一次 messages 更新
2. **reconcile**（异步）：`chatStore.__reconcileMessages()` 静默调用 `loadMessages`，成功后调用 `__reconcileRunAfterLoad` 完成 settle 并清除 run

reconcile 替换 messages 不会抖动——streaming 标记已清除，DOM 已渲染为完成态，server 数据内容一致。

## 连接状态与重连恢复

### 连接感知增强（SignalingConnection）

`services/signaling-connection.js` 提供连接感知基础设施：

| 常量 | 值 | 含义 |
|---|---|---|
| `PROBE_TIMEOUT_MS` | 2500 | 前台恢复连接探测超时 |
| `ASSUME_DEAD_MS` | 45000 | 长后台假定连接已死阈值 |
| `FOREGROUND_THROTTLE_MS` | 500 | 前台恢复事件防重入节流 |
| `HB_PING_MS` | 25000 | 心跳 ping 间隔 |
| `HB_TIMEOUT_MS` | 45000 | 心跳未响应判定超时 |

- **`lastAliveAt`**：每次收到 WS 消息时在 `__resetHbTimeout()` 中更新
- **`probe()`**：发送 ping，`PROBE_TIMEOUT_MS` 内未收到任何消息则 `forceReconnect()`
- **`forceReconnect()`**：关闭当前 WS → 重置重连延迟 → 立即重连。pending RPC 在 close 事件中被自然 reject
- **前台恢复**：`visibilitychange` 和 `app:foreground` 共用 500ms 节流，按 `lastAliveAt` 分级处理（见下文"Capacitor 前台恢复"）

### BotConnection 层

`services/bot-connection.js`

| 常量 | 值 | 含义 |
|---|---|---|
| `BRIEF_DISCONNECT_MS` | 5000 | 短暂抖动 vs 实质断连分界 |
| `DEFAULT_REQUEST_TIMEOUT_MS` | 30000 | RPC 请求超时 |
| `DEFAULT_CONNECT_TIMEOUT_MS` | 30000 | 连接超时 |

### ChatPage connReady 驱动

chatStore 不直接监听连接状态。消息加载由 ChatPage 的 `connReady` computed + watcher 驱动：

```javascript
connReady() {
	if (this.isNewTopic || !this.chatStore) return false;
	const bot = this.botsStore.byId[this.currentBotId];
	if (!bot || !bot.online) return false;
	if (!bot.dcReady) return false;
	if (this.isTopicRoute) return true;
	return this.agentVerified;
}
```

watcher 行为：
- `ready = true` 且 `__messagesLoaded = false` → 首次加载（`loadMessages()`）
- `ready = true` 且 `__messagesLoaded = true` → 重连静默刷新（`loadMessages({ silent: true })`）
- `ready = false` → 清除去重 guard，确保下次重连可再次触发

与 `__handleForegroundResume` 通过 `__lastResumeAt`（2s）去重，避免重复刷新。

### 重连后 Agent Run Reconcile

`loadMessages` 成功后调用 `__reconcileRunAfterLoad`：
1. `runsStore.completeSettle(runKey)` — 若 settling 则完成
2. `runsStore.stripLocalUserMsgs(runKey)` — 移除已被服务端持久化的乐观用户消息
3. `runsStore.reconcileAfterLoad(runKey, serverMessages)` — 检测僵尸 run

### 重连后批量状态刷新

`bots.store.__bridgeConn` 中记录 `disconnectedAt`。重连后计算 gap：

- **gap < `BRIEF_DISCONNECT_MS`（5s）**：短暂抖动，仅 `connReady` watcher 刷新当前 chatStore
- **gap >= `BRIEF_DISCONNECT_MS`**：实质断连，`__refreshIfStale` 触发 agents + sessions + topics 批量刷新（agents 优先，sessions/topics 并行）

### Capacitor 前台恢复

`utils/capacitor-app.js` `setupAppStateChange` 在 App 从后台切前台时 dispatch `app:foreground` 事件。

SignalingConnection 的分级恢复策略：

```
state === 'disconnected'  → 即时重连
state === 'connecting'    → 不干预
state === 'connected':
  elapsed > ASSUME_DEAD_MS (45s)           → forceReconnect（跳过探测）
  lastAliveAt > 0 && elapsed > PROBE_TIMEOUT_MS (2.5s)
                                           → probe() → 超时则 forceReconnect
  否则                                     → 无操作（连接正常）
```

ChatPage 的 `__handleForegroundResume` 在 WS 未断连时独立刷新数据（connReady 不转换时 watcher 不触发）。

### sendMessage 断连处理

断连错误码集合：`WS_CLOSED`、`DC_NOT_READY`、`DC_CLOSED`、`RTC_SEND_FAILED`、`RTC_LOST`、`CONNECT_TIMEOUT`

| 场景 | 处理 |
|------|------|
| 未 accepted + 未重试 | 清理状态后用同一 `idempotencyKey` 自动重试一次 |
| 已 accepted + 未 settled | 清理 streaming timer，`__reconcileMessages()` |
| 已 accepted + 已 settled | 静默吞掉（数据已安全） |

## Phase 4：跨终端数据同步（待分析）

### 目标

终端 A 的操作（发送消息、创建 topic、agent run 等）在终端 B 实时或准实时同步可见。

### 已知需同步的场景

**Agent Run**
- 未知 runId 的 `event:agent` 事件：agentRunsStore `__dispatch` 从"忽略"改为 auto-register
- `event:agent` 监听器从"首个 run 注册时"改为"连接建立时"（always-on）

**Chat（main 通道）**
- 其他端发送的用户消息
- chat 上的定时任务事件
- 同一 chat 两端同时发送的冲突处理（服务端序列化，本地通过 reconcile 对齐）

**Topic**
- 其他端新建/删除/修改 topic

**全局事件**
- OpenClaw 广播的连接级事件（bot 配置变更、agent 增删、插件更新等）
- Session reset 事件

### 数据一致性策略（初步方向）

- 实时事件驱动 + 兜底 reconcile（进入页面时静默刷新）
- 服务端为 source of truth，冲突时以服务端为准
