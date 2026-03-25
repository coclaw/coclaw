# Agent Run 全局生命周期设计

- **状态**：已确认，待实施
- **日期**：2026-03-25
- **关联问题**：切换页面后丢失 agent run 状态；返回页面无法恢复正在执行的 agent 信息

## 背景

### 问题

用户在 chat/topic 页面发送消息触发 agent 运行后，切换到其他页面再切回，界面无法展示正在执行的 agent 信息。只有 agent 运行结束后，重新进入页面或刷新 app 才能获取 agent 执行结果。

### 根因

Agent run 的全部状态（`streamingRunId`、`event:agent` 监听器、流式消息条目）均存储在 chatStore 中，而 chatStore 是"当前页面视图"的瞬态 store。`ChatPage.beforeUnmount()` 调用 `chatStore.cleanup()` 时无条件销毁所有状态，包括：

- 移除 `event:agent` 事件监听（后续服务端推送的事件被静默丢弃）
- 清除 `streamingRunId`（回到页面后无法识别活跃 run）
- 清空 `messages`（丢失乐观消息和流式内容）

而 WS 连接本身是全局的（`BotConnectionManager` 单例，per-bot 生命周期），服务端的 agent run 并未因 UI 离开而停止。**问题不在传输层，而在状态管理层。**

### 本质认识

> UI 中的相关 store 是 OpenClaw 对应实体的本地副本，通过事件驱动同步。

Agent run 是属于某个 chat/topic 的后台任务，其生命周期独立于页面视图。应当显式建模这一独立性。

## 方案：独立 agentRunsStore

### 核心思路

将 agent run 从 chatStore 的"页面级瞬态"中剥离，建立独立的全局 `agentRunsStore`，使 run 的生命周期不依赖于任何页面组件。

### 结构总览

```
BotConnection (per-bot, 全局)
  └─ event:agent 事件流
        │
        ▼
agentRunsStore (全局单例)               ← 新增
  ├─ runs: { [runId]: RunState }        ← 后台任务注册表
  ├─ runKeyIndex: { [runKey]: runId }   ← 按 chat/topic 查询
  ├─ __listeners: { [botId]: handler }  ← per-connection 事件路由
  └─ 调用 applyAgentEvent()            ← 提取的纯函数
        │
        ▼ (getter 合并)
chatStore (当前视图)
  ├─ messages: []                       ← 服务端加载的消息
  ├─ allMessages (getter)               ← messages + 活跃 run 的 streamingMsgs
  └─ isSending (getter)                 ← 从 agentRunsStore 派生
```

### RunState 结构

```js
{
  runId: string,          // 服务端返回的 runId（全局唯一）
  botId: string,          // 所属 bot
  runKey: string,         // chatSessionKey 或 sessionId（标识对话）
  topicMode: boolean,
  startTime: number,
  settled: boolean,       // lifecycle:end/error 后为 true
  streamingMsgs: [],      // 乐观 user 消息 + streaming bot 条目
}
```

索引方式：
- `runs[runId]` — 事件路由用（`event:agent` 携带 runId）
- `runKeyIndex[runKey]` → runId — chatStore 按对话查询用

### 事件监听器管理

per-connection 注册一个 handler，内部按 `payload.runId` 路由到对应 run：

- `__ensureListener(botId, conn)` — 首个 run 注册时调用
- `__removeListenerIfIdle(botId)` — 该 botId 下无活跃 run 时移除

单 handler + 内部路由（而非 per-run 多 handler）避免同一 connection 上的监听器膨胀，并为未来"处理非本端发起的 run"预留扩展点。

### 事件处理逻辑提取

将 chatStore 中 `__onAgentEvent` 的消息操作逻辑（~80 行）提取为纯函数：

```js
// utils/agent-stream.js

/**
 * 将 agent 流式事件应用到消息数组
 * @param {object[]} msgs - 消息数组（原地修改）
 * @param {object} payload - event:agent payload
 * @returns {{ changed: boolean, settled: boolean, error: boolean }}
 */
function applyAgentEvent(msgs, payload) { ... }
```

纯函数、无 store 依赖、独立可测试。内含从 chatStore 迁出的 `findStreamingBotEntry`、`ensureContentArray` 等辅助逻辑。

### chatStore 变化

**新增 getter**：

| Getter | 用途 |
|--------|------|
| `runKey` | `topicMode ? sessionId : chatSessionKey` |
| `allMessages` | `messages + agentRunsStore.getActiveRun(runKey)?.streamingMsgs` |
| `isSending` | `sending \|\| agentRunsStore.isRunning(runKey)` |

**sendMessage**：accepted 后不再自行注册 `event:agent` 监听，改为调用 `agentRunsStore.register()`，将乐观消息条目移入 run。post-acceptance timeout 移至 agentRunsStore。

**cleanup**：settle sendMessage 的 Promise（如之前），清理 UI 状态，**不再影响 agentRunsStore**。run 继续在后台接收事件。

**activate**：加载服务端消息后，检查 `agentRunsStore.getActiveRun(runKey)`，若有活跃 run 则 `allMessages` getter 自动合并流式内容。

**cancelSend**：用户主动取消 → `agentRunsStore.settle(runKey)` + reconcile。与 cleanup（导航离开）语义不同。

### 生命周期对比

| 场景 | 当前行为 | 新行为 |
|------|---------|--------|
| 发送消息，停留在页面 | stream → settle | 不变（run 在 agentRunsStore，allMessages 合并） |
| 发送消息，切走 | cleanup 销毁一切，run 丢失 | cleanup 只清 UI；run 继续接收事件 |
| 切走后切回（run 进行中） | 只有服务端已有消息 | loadMessages + allMessages 合并活跃 run 的 streamingMsgs |
| 切走后切回（run 已结束） | 缺少 run 期间的消息 | run settled、已清除；loadMessages 获取完整结果 |
| 用户主动取消 | cancelSend → cleanup streaming | cancelSend → agentRunsStore.settle → reconcile |
| App 切后台再切前台 | 同"切走后切回" | 同上，run 在 agentRunsStore 持续存活 |

### 文件变更范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `stores/agent-runs.store.js` | 新增 | ~120-150 行 |
| `utils/agent-stream.js` | 新增 | ~80 行，纯函数 |
| `stores/chat.store.js` | 修改 | sendMessage、cleanup、activate、新增 getters |
| `views/ChatPage.vue` | 修改 | `messages` → `allMessages`；`sending` → `isSending` |
| 测试文件 | 新增+修改 | |

## Phase 2：多 ChatStore 实例（已确认，紧随 Phase 1 实施）

- **状态**：已确认
- **决策日期**：2026-03-25

### 动机：单 chatStore 的结构性问题

Phase 1（agentRunsStore 拆分）解决了 agent run 生命周期问题，但 chatStore 自身的"单实例分时复用"模式仍存在以下结构性问题：

**1. "切换即销毁"导致的 UX 退化**

每次路由切换（chat A → chat B，或 chat → topic），`activateSession`/`activateTopic` 同步清零全部状态后发起 2-3 个 RPC 重新拉取。已懒加载的历史 segments 全部丢失。用户在两个对话间来回切换时，每次都是完整的"白屏→loading→渲染"流程。

**2. 重试机制的竞态风险**

ChatPage 保持 mounted，靠 5 个异步 watcher 驱动 `__activate()` 和 `__retryActivation()`。`__retryActivation` 用 `force: true` 绕过去重守卫。当 watcher 触发的 `activateSession` 的 `loadMessages()` 还在飞行中，retry 再次触发 `activateSession` 时，前一个 loadMessages 的响应会写入已被重置的 store。这在网络抖动或 WS 重连时可实际复现。

**3. 模式字段互斥**

chatStore 混合了 session 模式（`chatSessionKey`）和 topic 模式（`sessionId`/`topicMode`）的字段。每次切换都要把另一种模式的字段归零，增加每个方法的认知负担。

### 方案：per-chat/topic Store 实例 + 实例管理器

#### 核心结构

```
chatStoreManager (模块级单例，非 Pinia store)
  ├─ instances: Map<storeKey, PiniaChatStore>
  ├─ topicLru: string[]                        ← topic 实例的最近使用序
  ├─ get(storeKey) → store                     ← 创建或返回缓存实例
  ├─ evictTopics()                             ← 淘汰最久未用且无活跃 run 的 topic 实例
  └─ MAX_TOPIC_INSTANCES = 10                  ← topic 上限

每个 PiniaChatStore 实例:
  ├─ storeKey, botId, runKey, topicMode
  ├─ state: messages, loading, sending, errorText, history...
  ├─ getters: allMessages, isSending (查询 agentRunsStore)
  ├─ actions: loadMessages, sendMessage, cancelSend, loadOlderMessages...
  └─ 自管理 WS 重连监听
```

#### storeKey 规则

- Session（chat）模式：`session:${botId}:${agentId}`
- Topic 模式：`topic:${sessionId}`

#### 淘汰策略

- **Chat 实例不淘汰**：chat 是长期对话流，数量有限（通常 1-2 个 bot × 少量 agent），且包含历史 segments 等有价值的缓存
- **Topic 实例 LRU 淘汰**：topic 数量可能持续增长。当 topic 实例数超过上限时，淘汰最久未用且无活跃 agent run 的实例。淘汰时 `$dispose()` 释放 Pinia store

#### ChatPage 的变化

```js
computed: {
    storeKey() {
        if (this.isNewTopic) return null; // 新 topic 尚无 storeKey
        if (this.isTopicRoute) return `topic:${this.currentSessionId}`;
        return `session:${this.routeBotId}:${this.routeAgentId}`;
    },
    activeStore() {
        if (!this.storeKey) return null;
        return chatStoreManager.get(this.storeKey);
    },
}
```

模板和方法中 `this.chatStore.xxx` → `this.activeStore.xxx`。route 变化时 `activeStore` 自动切换，Vue 响应式驱动 UI 更新，不需要 activate/cleanup 调用。

#### 数据同步策略

与 OpenClaw 的数据一致性采用简化处理：

- **有活跃 agent run 的 chat/topic**：通过 agentRunsStore 的流式事件实时同步，无需额外加载
- **无活跃 run 的 chat/topic**：进入页面时静默刷新一次（`loadMessages({ silent: true })`），确保与服务端对齐
- 最坏情况等同于改造前的行为（每次进入都重新加载），最好情况下用户看到缓存消息瞬间渲染、后台静默刷新

这保证了在任何时候的数据一致性不比改造前差，同时多数场景下 UX 显著优于改造前。

#### 消除的代码 vs 新增的代码

| 消除 | 估计行数 |
|------|---------|
| `activateSession` 状态重置逻辑 | ~26 行 |
| `activateTopic` 状态重置逻辑 | ~25 行 |
| `cleanup()` 全局清理 | ~30 行（大幅简化） |
| `__retryActivation` + 5 个异步 watcher | ~60 行 |
| 模式切换字段互斥清理 | 散布在多个方法中 |
| activate/retry 竞态问题 | 根本消除 |

| 新增 | 估计行数 |
|------|---------|
| chatStoreManager（创建、缓存、LRU 淘汰） | ~80 行 |
| Store factory（defineStore 工厂函数） | ~20 行 |
| ChatPage storeKey/activeStore computed | ~10 行 |

净效果：**删除的代码多于新增的代码，且消除了竞态风险类别。**

#### agentRunsStore 无需调整

已按 runKey 查询设计，各 store 实例通过各自的 `runKey` 查询 agentRunsStore，关系自然建立。

## Phase 3：跨终端同步（后续）

**目标**：终端 A 发起对话，终端 B 同步看到用户消息和 agent run 执行过程。

**方向**：

- `event:agent` 监听器从"首个 run 注册时"改为"连接建立时"（always-on）
- agentRunsStore 的 `__dispatch` 对未知 runId 的处理从 `return` 改为 auto-register：
  - 从 payload 中提取 runKey（需服务端在 `event:agent` 中携带 sessionKey/sessionId）
  - 自动创建 run 条目，开始缓冲流式消息
  - 通知对应 ChatStore（若存在）刷新
- 新增全局事件类型处理：
  - `event:user-message` — 远端用户消息，同步到对应 chat store
  - `event:topic-created` — 远端新建 topic，同步到 topicsStore
  - `event:session-reset` — 远端 reset，触发本地 session 刷新
- 冲突处理：同一 chat 两端同时发送 → 服务端序列化，本地通过 reconcile 对齐

**agentRunsStore 调整极小**：仅改变监听器注册时机和未知 runId 的分支逻辑。

## Capacitor 前后台切换

上述设计（Phase 1 + Phase 2）天然覆盖 Capacitor 环境下的 App 前后台切换场景：

- App 切到后台：WebSocket 可能断开，但 agentRunsStore 的 run 条目保留，chatStore 实例保留
- App 切回前台：WS 重连
  - 有活跃 run → allMessages 合并流式内容，继续接收事件
  - 无活跃 run → 静默刷新消息，确保与服务端对齐
  - run 在断连期间完成 → agentRunsStore 在重连后确认状态 → settle run → 静默刷新
- 与"页面导航离开再返回"完全同构，无需额外处理
