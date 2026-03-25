# Chat 状态管理架构

- **日期**：2026-03-25
- **适用范围**：`ui` 工作区中与 chat/topic 消息、agent run、数据同步相关的全部状态管理

## 设计原则

> UI 中的相关 store 是 OpenClaw 对应实体的本地副本，通过事件驱动同步。

- Chat/topic 的消息状态独立于页面视图生命周期
- Agent run 是后台任务，其生命周期独立于发起它的页面
- Store 实例在导航间持续存活，切换页面不销毁数据
- 与 OpenClaw 的数据一致性**至少不比改造前差**，多数场景更优

## 架构总览

```
BotConnection (per-bot, 全局单例)
  └─ event:agent / event:chat 事件流
        │
        ▼
agentRunsStore (全局单例)
  ├─ runs: { [runId]: RunState }         ← 后台任务注册表
  ├─ runKeyIndex: { [runKey]: runId }    ← 按 chat/topic 查询
  ├─ __listeners: { [botId]: handler }   ← per-connection 事件路由
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
  ├─ isSending (getter)                  ← sending || agentRunsStore.isRunning(runKey)
  └─ 自管理 WS 重连监听
        │
        ▼ (computed)
ChatPage
  └─ chatStore (computed)                ← 由路由参数 + chatStoreManager 动态解析
```

## Phase 1：Agent Run 全局生命周期（已实施）

### 解决的问题

Agent run 状态（流式消息、事件监听器）原先耦合在 chatStore 中。用户导航离开后 `cleanup()` 销毁一切，run 丢失。

### 方案

**agentRunsStore**：全局 Pinia store，独立管理所有活跃的 agent run。

- **RunState** 包含：runId、botId、runKey、topicMode、streamingMsgs、超时定时器
- **双索引**：`runs[runId]`（事件路由）、`runKeyIndex[runKey]`（ChatStore 查询）
- **per-connection 单 handler**：内部按 `runId` 路由，避免监听器膨胀
- **30min 超时**：防止泄露的 run 永久占用内存

**applyAgentEvent()**：纯函数（`utils/agent-stream.js`），处理 assistant/tool/thinking/lifecycle 各类流式事件，原地修改消息数组。

**ChatStore 集成**：
- `sendMessage` 在 `onAccepted` 后将乐观消息移入 agentRunsStore
- `allMessages` getter 合并服务端消息 + 活跃 run 的 streamingMsgs
- `cleanup()` 不再销毁 agentRunsStore 中的 run

### 改进效果

| 场景 | 改造前 | 改造后 |
|------|--------|--------|
| 导航离开再返回（run 进行中） | 仅有服务端已有消息 | allMessages 自动合并流式内容 |
| 导航离开再返回（run 已结束） | 缺少 run 期间消息 | 静默刷新获取完整结果 |
| 用户取消发送后导航离开 | run 丢失 | run 继续后台执行 |

## Phase 2：多 ChatStore 实例（已实施）

### 解决的问题

单一 chatStore 在导航切换时同步清零再拉取，造成"白屏→loading→渲染"的 UX 退化、异步竞态、模式字段互斥复杂度。

### 方案

**chatStoreManager**：模块级单例（非 Pinia store），管理 ChatStore 实例的创建、缓存和淘汰。

- `get(storeKey, opts)`：惰性创建，存在则返回缓存
- storeKey 规则：`session:${botId}:${agentId}` 或 `topic:${sessionId}`
- **Chat 实例不淘汰**：数量有限，包含历史 segments 等有价值缓存
- **Topic 实例 LRU 淘汰**：上限 10 个，淘汰最久未用且无活跃 run 的实例

**ChatStore 工厂**（`createChatStore`）：每个实例在创建时注入 identity（botId、topicMode、chatSessionKey 等），不再有运行时模式切换。

- `activate()`：首次进入加载数据 + 注册 WS 重连监听；重新进入时静默刷新
- `cleanup()`：仅清理发送中的 promise/timer，**不销毁数据**
- `dispose()`：实例被淘汰时的完整清理（含注销 WS 监听）

**ChatPage**：

- `chatStore` 为 computed，由路由参数 + topicsStore 动态解析到对应实例
- `chatStore` watcher（`immediate: true`）自动调用 `store.activate()`
- `__validateRoute()` 仅做路由级合法性验证（bot/agent 存在性），不再驱动数据加载
- 删除了 `activateSession` / `activateTopic` / `__retryActivation` / 多个路由驱动 watcher

### 数据同步策略

- **有活跃 agent run**：allMessages 自动合并，无需额外处理
- **无活跃 run**：进入页面时静默刷新（`loadMessages({ silent: true })`）
- 最坏等同改造前（每次进入重新加载），最好用户看到缓存消息瞬间渲染

### 改进效果

| 场景 | 改造前 | 改造后 |
|------|--------|--------|
| Chat A → Chat B → Chat A | 白屏 → loading → 渲染 | 瞬间恢复缓存 + 后台静默刷新 |
| Topic 间来回切换 | 每次全量加载 | 缓存命中直接渲染（LRU 内） |
| WS 抖动 / 重连中切换页面 | 竞态导致数据混乱 | 各实例独立，无竞态 |
| 切回有活跃 run 的 chat/topic | 丢失流式内容 | allMessages 自动合并渲染 |

## Phase 3：连接断开恢复（已实施）

### 核心问题

WS 断连后各层状态的一致性恢复。连接层的自动重连已由 BotConnection（指数退避无限重试）和 RealtimeBridge（固定 10s 重试）覆盖。Phase 3 解决的不是"如何重连"，而是**重连后如何恢复状态一致性**。

断连影响三层状态：

| 层 | 状态持有者 | 断连影响 |
|---|---|---|
| UI → Server WS | BotConnection | 心跳超时/网络切断 → 事件流中断，RPC 失败 |
| Plugin → Server WS | RealtimeBridge | 与 UI 侧独立，可能同时或单独断连 |
| Plugin → Gateway WS | RealtimeBridge | 网关断连 → agent run 事件流中断 |

### Phase 1-2 已提供的保障

- agentRunsStore 的 run 条目在断连期间保留，streamingMsgs 冻结但不丢失，30min 超时兜底
- chatStore 实例不随导航销毁，缓存消息持续可见
- chatStore `__connStateHandler`：WS 重连后自动 `loadMessages({ silent: true })`
- sendMessage 断连处理：3 种场景（未 accepted / 已 accepted / 已 settled）各有 15s 等待 + 重试/reconcile

### 当前各 store 的重连刷新状态

| Store | 重连时是否刷新 | 问题 |
|---|---|---|
| chatStore | 是（`__connStateHandler`） | 无防抖/防重复；与 agentRunsStore 无 reconcile |
| agentRunsStore | 否 | 僵尸 run 依赖 30min 超时 |
| topicsStore | 否 | 断连期间的增删不可见 |
| sessionsStore | 否 | sessionId 列表可能过时 |
| agentsStore | 否 | agent 变更不可见（除非 bot 经历 offline→online） |
| dashboardStore | 否 | 无重连感知 |

### 3a：BotConnection 连接感知增强

**增加 `lastAliveAt` 时间戳**

在 `__resetHbTimeout()`（每次收到任何 WS 消息时调用）中设置 `this.__lastAliveAt = Date.now()`。提供"最后一次确认连接活着"的时间点，供 Capacitor 前台恢复策略使用。

**增加 `probe()` 方法**

发送 `{ type: 'ping' }`，设 `PROBE_TIMEOUT_MS`（2.5s）定时器。若定时器内收到任何消息（`__resetHbTimeout` 被调用，`lastAliveAt` 刷新），则判定连接存活。否则 `forceReconnect()`。

与心跳抑制的关系：probe 是独立于常规心跳的主动探测，不影响 `__hbMissCount`。probe 期间若有 pending RPC，仍然执行探测（pending RPC 的存在不应阻止前台恢复判断）。

**增加 `forceReconnect()` 方法**

关闭当前 WS（`this.__ws?.close()`）→ 重置重连延迟至 `INITIAL_RECONNECT_MS` → `__doConnect()`。与 `__onVisibilityChange` 类似，但不检查 `state === 'disconnected'`（因为连接可能仍显示 connected 但实际已死）。

pending RPC 处理：`forceReconnect()` 触发的 `close` 事件会自然走入已有的 pending RPC reject 流程（code: `WS_CLOSED`），无需额外处理。

**`app:foreground` 事件监听**

与 `visibilitychange` 并列，在 `connect()` 时注册、`__cleanup()` 时注销。防重入：两个事件共用一个 500ms 节流守卫，短时间内不重复执行。

**常量定义**

| 常量 | 值 | 含义 |
|---|---|---|
| `PROBE_TIMEOUT_MS` | 2500 | 前台恢复时的连接探测超时 |
| `ASSUME_DEAD_MS` | 45000 | 超过此时长无消息则假定连接已死，跳过探测 |

### 3b：重连后 agent run reconcile

**RunState 增加 `lastEventAt`**

在 `__dispatch` 处理每个事件时更新 `run.lastEventAt = Date.now()`。用于判断事件流是否仍活跃。

**loadMessages 后的 reconcile 逻辑**

loadMessages 成功后，检查该 chatStore 的 runKey 是否有活跃 run。若有，判断是否应 settle：

1. 服务端消息是否已包含该 run 的最终结果 — 检查服务端消息中最后一条 assistant 消息的 `stopReason` 是否为终止类型（`stop` / `maxTokens` / `endTurn`，而非 `toolUse`）
2. 事件流是否已静默 — `Date.now() - run.lastEventAt > STALE_RUN_MS`

两者同时满足时 settle run，以服务端消息为准。

| 常量 | 值 | 含义 |
|---|---|---|
| `STALE_RUN_MS` | 3000 | 事件流静默超过此时长视为已停止 |

**竞态场景处理**

场景 A — loadMessages 期间 `lifecycle:end` 到达：
- `__cleanupRun` 移除 run → allMessages 短暂丢失 streamingMsgs → loadMessages 完成后 messages 补齐
- 引入过渡态：`__cleanupRun` 在删除 run 前设置 `run.settling = true`，`allMessages` getter 在 settling 状态下保留 streamingMsgs 直到下一次 messages 更新。messages 更新（由 loadMessages 或 Vue reactivity 触发）后清除 settling 标记并真正删除 run

场景 B — run 断连期间已完成，重连后无 `lifecycle:end`：
- loadMessages 返回完整结果 → reconcile 逻辑检测到服务端有最终消息 + 事件流静默 → settle
- 因为 settle 发生在 loadMessages 之后（messages 已是最新），不存在内容消失问题

场景 C — loadMessages 期间 events 持续到达（run 仍在进行）：
- lastEventAt 持续更新 → STALE_RUN_MS 检查不通过 → 不 settle
- allMessages 正常合并，无异常

### 3c：chatStore 重连刷新防抖

**loadMessages 飞行中守卫**

若已有 silent loadMessages 请求在飞行中，后续 silent 调用复用同一 promise，避免并发请求。

```
if (this.__silentLoadPromise && silent) return this.__silentLoadPromise;
```

**`__connStateHandler` debounce**

对重连触发的 loadMessages 增加 debounce，短时间内多次重连只触发一次刷新。

| 常量 | 值 | 含义 |
|---|---|---|
| `RECONNECT_REFRESH_DEBOUNCE_MS` | 3000 | 重连刷新去抖时间 |

参考：Slack ~2s、Discord 1-5s jitter、Linear ~3s。选择 3s，对移动弱网友好且不影响体验。

### 3d：重连后批量状态刷新

**断连时长感知**

BotConnection 在状态变为 `disconnected` 时记录 `__disconnectedAt = Date.now()`。重连后计算 gap = 重连时间 - 断连时间。

| 常量 | 值 | 含义 |
|---|---|---|
| `BRIEF_DISCONNECT_MS` | 5000 | 短暂抖动 vs 实质断连的分界 |

参考：Slack ~5s、Signal ~3s、Telegram ~7s。选择 5s 作为平衡值。

**分级刷新策略**

- **gap < BRIEF_DISCONNECT_MS**（短暂抖动）：仅刷新当前可见的 chatStore（已由 `__connStateHandler` 覆盖）
- **gap >= BRIEF_DISCONNECT_MS**（实质断连）：在 `botsStore.__listenForReady` 的重连分支中，增加 topics + sessions + agents 的刷新

刷新顺序：agents → sessions/topics 并行。agents 优先是因为 ChatPage 路由验证依赖 agent 数据。

### 3e：Capacitor 前台恢复

**不在壳子层维持连接**。恢复逻辑完全在 web 层执行。不依赖 FCM / APNs 等推送通道。

**事件传递**

`capacitor-app.js` 中 `setupAppStateChange` 在 `isActive` 从 false → true 时，dispatch 自定义事件：

```js
window.dispatchEvent(new CustomEvent('app:foreground'));
```

BotConnection 在 `connect()` 时监听此事件，`__cleanup()` 时注销。

**分级恢复策略**

```
onAppForeground():
  // 500ms 节流：visibilitychange 和 app:foreground 共用，短时间内不重复执行
  if state === 'disconnected':
    → 即时重连（与 visibilitychange 同）
  elif state === 'connecting':
    → 不干预
  elif state === 'connected':
    elapsed = Date.now() - lastAliveAt
    if elapsed > ASSUME_DEAD_MS (45s):
      → forceReconnect()（不浪费时间探测）
    elif lastAliveAt > 0 && elapsed > PROBE_TIMEOUT_MS (2.5s):
      → probe(timeout: PROBE_TIMEOUT_MS)
        成功 → 连接存活，无需操作
        超时 → forceReconnect()
    else:
      → 无操作（最近收到过消息，连接正常）
```

**与 visibilitychange 的关系**

Capacitor WebView 切前台时也可能触发 `visibilitychange`。两个事件共用 500ms 节流守卫，避免重复执行。在 Android 上 `appStateChange` 比 `visibilitychange` 更可靠（部分 OEM ROM 不触发或延迟触发 visibilitychange）。

**与心跳抑制（HB_SUPPRESS_LIMIT）的关系**

心跳抑制在有 pending RPC 时将容忍延长到 ~270s。前台恢复的 `probe()` / `forceReconnect()` 不受心跳抑制影响——即使有 pending RPC，前台恢复仍按自身阈值（`ASSUME_DEAD_MS`）判断。理由：用户已回到前台，体验优先于等待 pending RPC 自然超时。pending RPC 在 `forceReconnect()` 触发的 `close` 事件中被自然 reject。

### 实施顺序

3a → 3b + 3c 并行 → 3d → 3e

3a 为基础设施（`lastAliveAt`、`probe`、`forceReconnect`）。3b（run reconcile）和 3c（防抖）互不依赖。3d 依赖 3a 的 `__disconnectedAt`。3e 依赖 3a 的 `lastAliveAt` 和 `probe`。

### 常量汇总

| 常量 | 值 | 所在模块 | 含义 |
|---|---|---|---|
| `PROBE_TIMEOUT_MS` | 2500 | BotConnection | 连接探测超时 |
| `ASSUME_DEAD_MS` | 45000 | BotConnection | 长后台假定连接已死阈值 |
| `STALE_RUN_MS` | 3000 | agentRunsStore | 事件流静默判定阈值 |
| `RECONNECT_REFRESH_DEBOUNCE_MS` | 3000 | chatStore | 重连刷新去抖 |
| `BRIEF_DISCONNECT_MS` | 5000 | BotConnection | 短暂抖动 vs 实质断连分界 |
| `FOREGROUND_THROTTLE_MS` | 500 | BotConnection | 前台恢复事件防重入节流 |

## Phase 4：跨终端数据同步（待分析）

### 目标

终端 A 的操作（发送消息、创建 topic、agent run 等）在终端 B 实时或准实时同步可见。

### 已知需同步的场景

**Agent Run**

- 监听其他端发起的 agent RPC 请求及响应。请求线索是否可监听取决于 OpenClaw 的事件广播机制，需届时调研
- 未知 runId 的 `event:agent` 事件：agentRunsStore 的 `__dispatch` 从"忽略"改为 auto-register，从 payload 提取 runKey 自动创建 run 条目
- `event:agent` 监听器从"首个 run 注册时"改为"连接建立时"（always-on），以捕获非本端发起的 run

**Chat（main 通道）**

- 其他端发送的用户消息
- chat 上的定时任务（scheduled task）事件
- 定时任务 sessionKey 上的事件（目前未渲染，最终需展示）
- 同一 chat 两端同时发送的冲突处理（服务端序列化，本地通过 reconcile 对齐）

**Topic**

- 其他端新建 topic
- 其他端删除 topic
- 其他端修改 topic 标题（含 generateTitle 自动命名）

**全局事件**

- OpenClaw 广播的连接级事件（如 bot 配置变更、agent 增删、插件更新等）
- Session reset 事件——远端 reset 应触发本地对应 ChatStore 刷新
- 其它 OpenClaw 未来可能新增的广播事件

### 数据一致性策略（初步方向）

- **实时事件驱动**：能监听的事件实时更新本地 store
- **兜底 reconcile**：进入页面时仍做静默刷新，保证即使遗漏事件也能最终一致
- **冲突优先级**：服务端为 source of truth，本地状态在收到冲突信号时以服务端为准

### 前置调研

- OpenClaw 目前提供哪些广播事件
- 事件 payload 中是否携带足够信息（如 sessionKey/sessionId）供本地路由
- 是否需要向 OpenClaw 上游提出新的事件类型需求

### 架构影响

- agentRunsStore：`__dispatch` 增加未知 runId 的 auto-register 分支；监听器注册时机前移
- chatStoreManager：可能需要根据远端事件为尚未打开的 chat/topic 预创建 store（或仅更新标记/计数）
- topicsStore：新增事件驱动的 CRUD 同步
- 新增全局事件调度层（或扩展 BotConnectionManager）统一处理跨终端事件路由
