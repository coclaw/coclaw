# 响应式状态架构整改

> 状态：已实施（bots.store 暴露 dcReady/connState 响应式状态，各 store 通过 computed/watch 消费）

## 背景与动机

### 问题现象

UI 层频繁出现"时序问题"：组件或 store 依赖的数据、连接未就绪，导致初始化链断裂、状态卡住。典型案例：

- **页面刷新时 loading 永久卡住**：ChatPage 挂载 → chatStore.activate() → BotConnection 尚未创建（botsStore.loadBots 未完成）→ `__registerConnStateListener()` 因 conn 为 null 静默失败 → `loading = true` 永久无法清除，用户看到"正在加载会话..."无限转圈
- 上述 bug 用 500ms retry 轮询修补 → 本质是 polling 一个非响应式对象，属 anti-pattern

### 根因分析

**BotConnection 是整个系统的神经中枢，但它是非响应式的 EventEmitter。**

在 Vue + Pinia 的前端架构中，状态管理应以响应式为核心——组件通过 computed 消费 store 状态，通过 watch 触发必要的副作用。但当前架构中，连接状态（connected/disconnected/connecting）这一最关键的底层状态，没有纳入响应式体系。5+ 个模块各自独立地手动注册 `conn.on('state')` 事件监听器来感知连接变化：

| 消费者 | 桥接方式 | 生命周期 | 去重机制 |
|--------|---------|---------|---------|
| botsStore.__listenForReady | conn.on('state') | 持久（不移除） | 模块级 `_listeningConnIds` Set |
| chatStore | conn.on('state') | 随 activate/dispose | `__connStateHandler` + 500ms retry |
| agentRunsStore | conn.on('event:agent') | 随活跃 run | `__listenerBotIds` Set |
| chatStore.sendSlashCommand | conn.on('event:chat') | 命令执行期间 | `__chatEventHandler` 字段 |
| chatStore.sendMessage | conn.on('state') 内联 | Promise settle 后 | 局部变量 |

每个消费者都在独立解决同一个问题："如何在正确的时机注册监听、如何避免重复、如何清理"。5 套实现，5 套 bug 风险。这些手动注册的事件监听器完全绕过了 Vue 的响应式依赖追踪，导致：

1. **隐式依赖**：模块间的依赖关系不可见，只能靠运行时的事件注册顺序"巧合对齐"
2. **注册时机脆弱**：conn 不存在时注册失败是静默的，没有后续重试（或需要手动加 retry）
3. **状态碎片化**：同一个 bot 的状态（online、connState、transportMode 等）散落在 botsStore 的 6 个独立 map 中

### 整改目标

> 以响应式为骨架，事件仅在边界。消除命令式事件管道导致的时序问题，让 Vue + Pinia 前端恢复到应有的样子。

### 整改原则

1. **事件→响应式的桥接只做一次，做在最上游**：BotConnectionManager 是唯一注册 `conn.on('state')` 并写入 Pinia store 的地方
2. **下游一律消费响应式状态**：所有 store / 组件通过 computed / watch 响应连接变化，不直接 `conn.on`
3. **per-bot 状态聚合为单一对象**：消除散落在 N 个 map 中的碎片化结构
4. **组件以消费计算属性为主**：watch 仅用于必要的副作用触发（如发起 RPC 加载数据）

---

## 现有架构要点

> 供新会话快速理解现状。

### 初始化链

```
AuthedLayout setup
  → useBotStatusSse(botsStore)     // 建立 SSE 连接监听 bot 上下线
    → SSE onopen → botsStore.loadBots()
      → HTTP 拉取 bot 列表 → botsStore.items 赋值
      → syncConnections(botIds) → BotConnectionManager 为每个 bot 创建 BotConnection
      → __listenForReady(botIds) → 为每个 conn 注册 state 监听
        → conn 变为 connected 时：loadAgents + loadAllSessions + loadAllTopics

ChatPage mounted（与上面并行）
  → chatStore watcher (immediate) → chatStore.activate()
    → __getConnection() → 可能返回 null（loadBots 未完成）
    → __registerConnStateListener() → conn null → 静默失败 ← BUG
```

### 关键模块

- **BotConnection**（`services/bot-connection.js`）：per-bot WS 连接，EventEmitter 模式，管理心跳、重连、RPC、probe 等。emits: `state`、`event:agent`、`event:chat`、`rtc`、`session-expired`、`bot-unbound`
- **BotConnectionManager**（`services/bot-connection-manager.js`）：全局单例，`Map<botId, BotConnection>` 的增删查。通过 `useBotConnections()` 访问
- **botsStore**（`stores/bots.store.js`）：bot 列表 + per-bot 运行时状态（6 个独立 map）+ `__listenForReady` 调度器
- **chatStore**（`stores/chat.store.js`）：工厂模式（`createChatStore(key, opts)`），~900 行，承担消息数据 + 加载状态 + 连接监听 + 发送编排 + 斜杠命令 + reconcile
- **agentRunsStore**（`stores/agent-runs.store.js`）：全局单例，管理 agent run 生命周期和流式消息

### botsStore 当前 state 结构

```javascript
items: []                // bot 列表 [{ id, name, online, ... }]
loading: false
fetched: false
pluginVersionOk: {}      // { [botId]: boolean }
pluginInfo: {}           // { [botId]: { version, clawVersion } }
transportModes: {}       // { [botId]: 'ws' | 'rtc' }
rtcStates: {}            // { [botId]: 'idle' | 'connecting' | ... }
rtcTransportInfo: {}     // { [botId]: { localType, ... } }
```

同一个 bot 的状态散落在 6 个 map 中，删除一个 bot 需清理每个 map（当前 `removeBotById` 逐个 destructure 清理）。

---

## 阶段一：响应式桥接与 botsStore 结构重构

### 1.1 botsStore 状态聚合

**现状**：per-bot 状态散落在 6 个独立 map。

**目标**：收敛为 `byId: { [botId]: BotState }`，一个 bot 的所有状态在一个对象中。

```javascript
// stores/bots.store.js
state: () => ({
	byId: {},       // { [botId]: BotState }
	loading: false,
	fetched: false,
}),
getters: {
	// 列表视图（供列表渲染和遍历用）
	items: (state) => Object.values(state.byId),
},
```

BotState 结构：

```javascript
{
	// 基础信息（HTTP 源，loadBots / SSE 事件写入）
	id: '1',
	name: 'MyClaw',
	online: true,
	lastSeenAt: null,
	createdAt: null,
	updatedAt: null,

	// 连接状态（BotConnectionManager 桥接写入）
	connState: 'disconnected',  // 'disconnected' | 'connecting' | 'connected'
	lastAliveAt: 0,             // 最后一次确认连接存活的时间戳
	disconnectedAt: 0,          // 最近一次断连时间戳

	// 初始化标记（__listenForReady 用于区分首次 vs 重连）
	initialized: false,

	// 传输与插件（运行时写入）
	transportMode: null,        // 'rtc' | 'ws' | null
	pluginVersionOk: null,      // true | false | null（未检测）
	pluginInfo: null,           // { version, clawVersion } | null
	rtcState: null,             // 'idle' | 'connecting' | 'connected' | 'failed' | 'closed' | null
	rtcTransportInfo: null,     // { localType, ... } | null
}
```

**消费方式**：

```javascript
// 面对单个 bot 的组件：通过 prop 或 computed 拿到 bot 对象
computed: {
	bot() { return this.botsStore.byId[this.botId]; },
	isConnected() { return this.bot?.connState === 'connected'; },
}

// 列表场景：直接用 items getter
<li v-for="bot in botsStore.items" :key="bot.id">...</li>
```

Vue 自动追踪 `botsStore.byId[id]` 的读取，任何字段变化都触发重算。无需函数式 getter，无时序问题。

删除 bot 时一行清理所有状态：`delete this.byId[botId]`

**涉及文件**：

| 文件 | 改动 |
|------|------|
| stores/bots.store.js | state 结构重构，所有 action 适配 byId |
| stores/bots.store.test.js | 全面适配 |
| views/ChatPage.vue | `botsStore.items.find(...)` → `botsStore.byId[id]` |
| views/ManageBotsPage.vue | 同上 + transportModes/rtcStates 路径迁移 |
| views/HomePage.vue | 适配 items getter |
| components/MainList.vue | 适配 items getter |
| stores/agents.store.js | `botsStore.items.find(...)` → `botsStore.byId[id]` |
| stores/dashboard.store.js | 同上 |
| services/webrtc-connection.js | botsStore 写入路径适配 |
| composables/use-bot-status-sse.js | addOrUpdateBot / updateBotOnline 适配 |
| stores/sessions.store.js | 使用 items getter，可能无需改动 |
| stores/topics.store.js | 同上 |

### 1.2 BotConnectionManager 桥接 + 1.3 connected 转换检测

**现状**：BotConnectionManager 是纯 JS 类，管理 `Map<botId, BotConnection>` 的增删查。各消费者自行 `conn.on('state')` 桥接。`__listenForReady` 使用模块级 `_listeningConnIds` / `_initializedBots` Set 手动管理持久 state 监听。

**目标**：在 botsStore 的 `__bridgeConn(botId)` action 内注册**唯一**的 conn state 监听，将连接状态实时写入 `botsStore.byId[botId]`，并在 connected 转换时直接触发 `__onBotConnected`。

> **设计决策**：最初方案是在 bridge 写入 connState 后用 Vue `watch({ deep: true })` 检测转换。实施中发现 Vue watch 的 `deep: true` 在 getter 返回新对象时会在每次 getter 求值时都触发回调（无论值是否变化），配合 `__onAlive` 的高频 `lastAliveAt` 更新，导致无限循环。最终改为在 bridge 的 `conn.on('state')` 回调内直接检测 `prev !== 'connected' → 'connected'` 转换，更简洁且无副作用。

```javascript
// stores/bots.store.js __bridgeConn(botId)
__bridgeConn(botId) {
	const conn = useBotConnections().get(botId);
	if (!conn) return;
	if (_bridgedConns.get(botId) === conn) return; // 同实例不重复
	_bridgedConns.set(botId, conn);

	conn.on('state', (s) => {
		const bot = this.byId[botId];
		if (!bot) return;
		const prev = bot.connState;
		bot.connState = s;
		if (s === 'disconnected') bot.disconnectedAt = conn.disconnectedAt;
		// connected 转换 → 触发初始化/重连
		if (s === 'connected' && prev !== 'connected') {
			this.__onBotConnected(botId);
		}
	});

	// lastAliveAt 实时同步（通过 __onAlive 回调，每收到 WS 消息时触发）
	conn.__onAlive = (ts) => {
		const bot = this.byId[botId];
		if (bot) bot.lastAliveAt = ts;
	};

	// 同步当前状态（conn 可能已经 connected）
	if (bot && conn.state !== bot.connState) { /* ... 同上 */ }
}
```

桥接放在 `bots.store.js` 而非 `bot-connection-manager.js`，避免循环依赖（两者互相导入）。

`__onBotConnected(id)` 整合原 `fire` + 重连分支逻辑。"首次 vs 重连"通过 `byId[id].initialized` 字段判断。不需要 `_listeningConnIds` / `_initializedBots` Set。

**整改后 BotConnectionManager 的角色**：仍然存在，管理 BotConnection **实例**（WS 连接对象）。botsStore.byId 是这些实例的状态的**响应式镜像**。需要发 RPC 时仍通过 `useBotConnections().get(botId).request(...)` 获取实际 conn 实例。两者职责不同：conn 是 I/O 工具，store 是状态容器。

**涉及文件**：

| 文件 | 改动 |
|------|------|
| stores/bots.store.js | __bridgeConn + __onBotConnected，替代 __listenForReady |
| services/bot-connection.js | 新增 __onAlive 回调字段 |
| stores/bots.store.test.js | 适配 |

### 1.4 chatStore 去除连接监听，改由 ChatPage 响应式驱动

**现状**：chatStore 内部通过 `__registerConnStateListener` 手动注册 conn.on('state')，包含 500ms retry、3s debounce、re-check 逻辑。ChatPage 有 5 个 watcher，其中多个是在补偿 store 的不足。

**目标**：

- **移除** chatStore 的 `__registerConnStateListener` / `__unregisterConnStateListener` / `__connRetryTimer` / `__reconnectDebounceTimer`
- chatStore.activate() 简化：仅标记 `__initialized` + 若连接已就绪则立即 loadMessages
- **ChatPage** 新增 `connReady` 计算属性 + watcher 驱动消息加载（首次和重连）
- **保留** `isLoadingChat` 计算属性（显示层防御，基于 `__initialized` / `__messagesLoaded` / `allMessages.length` / `errorText` 推导）

ChatPage watcher 变化：

| watcher | 现状 | 目标 |
|---------|------|------|
| chatStore (immediate) | 触发 activate | 保留，activate 不再管理连接监听 |
| botsStore.items (deep) | 验证路由 | **替换为 `botIds` computed**（仅跟踪 bot 增删） |
| agentsStore.byBot (deep) | 验证路由 | **替换为 watch `agentVerified`**（已有精确 computed） |
| isBotOffline | 上线时 loadMessages | 保留 cancelSend，loadMessages **移至 connReady** |
| chatMessages | scrollToBottom | 保留 |
| **connReady**（新增） | — | 驱动消息加载和重连刷新 |

> **设计决策**：`botsStore.items` 和 `agentsStore.byBot` 的 deep watcher 均被替换。byId 聚合后 bot 对象包含高频更新的 `lastAliveAt` 字段，deep watcher 会被每条 WS 消息触发。正确做法：用 computed 将关心的字段收窄为简单值（如 `botIds` 字符串），再 watch 该 computed。此规则已写入 CLAUDE.md 编程规范。

```javascript
computed: {
	connReady() {
		if (this.isNewTopic || !this.chatStore) return false;
		const bot = this.botsStore.byId[this.currentBotId];
		if (!bot || !bot.online) return false;
		if (bot.connState !== 'connected') return false;
		if (this.isTopicRoute) return true;
		return this.agentVerified;
	},
},
watch: {
	connReady(ready) {
		if (!ready || !this.chatStore) return;
		if (!this.chatStore.__messagesLoaded) {
			this.chatStore.loadMessages();
		} else {
			this.chatStore.loadMessages({ silent: true });
		}
	},
},
```

- **首次 vs 重连**：`__messagesLoaded` 为 false 则首次，否则重连
- **3s debounce 不再需要**：Vue watch 在同一 tick 内只触发一次
- **时序问题消失**：不管 conn 先就绪还是 chatStore 先创建，computed 始终能在条件满足时正确求值

**涉及文件**：

| 文件 | 改动 |
|------|------|
| stores/chat.store.js | 移除连接监听相关代码（~60 行），简化 activate |
| stores/chat.store.test.js | 移除/适配相关测试 |
| views/ChatPage.vue | 新增 connReady，移除 isBotOffline watcher 中的 loadMessages 分支 |
| views/ChatPage.test.js | 适配 |

### 1.5 chatStore.sendMessage 重连等待改造

**现状**：sendMessage 内部有一段内联的 `conn.on('state', onState)` 等待重连逻辑（断连后 15s 等待重连再重试）。变动较小且独立。

**目标**：改为消费 `botsStore.byId[botId].connState` 的响应式变化。封装为工具函数：

```javascript
// utils/wait-connected.js
import { watch } from 'vue';

export function waitForConnected(botsStore, botId, timeoutMs = 15000) {
	return new Promise((resolve, reject) => {
		// 已经 connected 则立即 resolve
		if (botsStore.byId[botId]?.connState === 'connected') {
			resolve(); return;
		}
		const timer = setTimeout(() => { stop(); reject(new Error('reconnect timeout')); }, timeoutMs);
		const stop = watch(
			() => botsStore.byId[botId]?.connState,
			(s) => {
				if (s === 'connected') {
					clearTimeout(timer);
					stop();
					resolve();
				}
			},
		);
	});
}
```

chatStore.sendMessage 中 `conn.on('state', onState)` / `conn.off('state', onState)` 替换为 `await waitForConnected(botsStore, this.botId)`。

**涉及文件**：

| 文件 | 改动 |
|------|------|
| stores/chat.store.js | sendMessage 重连等待替换 |
| utils/wait-connected.js | 新增 |
| stores/chat.store.test.js | 适配 |

---

## 阶段二（后续）：chatStore 职责拆分

阶段一完成后 chatStore 的复杂度已显著降低（移除了连接监听、retry timer、debounce timer），但仍承担过多职责（数据容器 + 加载状态机 + RPC 调用 + 发送编排 + 斜杠命令 + reconcile）。

拆分方向：

- **消息数据层**：messages、historySegments、allMessages getter（保留在 chatStore）
- **发送编排**：sendMessage 的完整流程（可提取为独立 composable 或 service）
- **斜杠命令**：sendSlashCommand 及其事件监听（可提取）
- **加载状态**：由 ChatPage 计算属性推导（`isLoadingChat`），store 不再管理 loading 标志

---

## 阶段三（后续）：进一步收敛

### event:agent / event:chat 桥接集中化

当前 agentRunsStore 和 chatStore 各自管理 `conn.on('event:agent')` / `conn.on('event:chat')` 的注册和注销。可集中到 BotConnectionManager 桥接层：

```javascript
// bot-connection-manager.js connect() 内
conn.on('event:agent', (payload) => {
	useAgentRunsStore().__dispatch(payload);
});
```

agentRunsStore 不再需要 `__ensureListener` / `__removeListenerIfIdle` / `__listenerBotIds`。

event:chat（斜杠命令响应）较特殊——它是临时的，仅在命令执行期间监听。可通过 pub/sub 机制或 Promise 封装替代直接的 conn.on/off。

### BotConnectionManager 存废

整改后 BotConnectionManager 的剩余职责：管理 `Map<botId, BotConnection>` 的增删查 + 状态桥接。可考虑内联到 botsStore 的 action 中，或保留为轻量内部工具。不急于处理。

### bot → claw 渐进重命名

在架构稳定后，可逐步将 botsStore → clawsStore、botId → clawId 等命名统一。纯重命名操作，不涉及架构变化。

---

## 实施顺序

```
阶段一（已完成）：
  1.1 botsStore 结构重构（byId 聚合）
   ↓
  1.2+1.3 桥接 + connected 转换检测（合并，bridge 内直接检测）
   ↓
  1.4 chatStore 去除连接监听 + ChatPage connReady watcher + deep watcher 收窄
   ↓
  1.5 sendMessage 重连等待改造（waitForConnected 工具函数）

阶段二（后续）：chatStore 职责拆分
阶段三（后续）：事件桥接集中化 / BotConnectionManager 存废 / 重命名
```

阶段一已全部实施并通过测试（1054 tests passed）。
