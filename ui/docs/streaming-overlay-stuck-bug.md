# Streaming overlay 永久残留 bug（DC 失联场景）

> 创建时间：2026-05-02
> 状态：已知 bug，**暂不修复**（出现概率极低，影响面有限）
> 关联 TODO：`ui/TODO.md` #16、#31（合并入本文，原条目精简为索引）

## 一句话现象

agent run 进行中网络持续故障 ≥ 3 分钟（ICE restart 预算耗尽），UI 判 run 死，但那条"思考中…"动画（streaming overlay）**永远不消失**，唯一恢复路径是发新消息或重启 app。

## 1. 触发条件（窄）

必须同时满足：

1. agent run 已 accepted（onAccepted 已触发，run 已注册到 `agent-runs.store`）
2. **WebRTC DataChannel 物理死亡**——典型场景：
   - 信令 WS 仍能连接（手机有网络信号）
   - 但 ICE restart 预算耗尽（≥3 分钟无法恢复）
   - PC connectionState=failed → DC 关闭 → `__rejectAllPending('DC_CLOSED')` → agent RPC waiter reject
3. silent loadMessages 失败（DC 死了，conn 拿不到 ready 状态）

第 3 步是核心：DC 死 → endRun('failed') 必然伴随 loadMessages 失败，是同一根因的两个表现。

## 2. 用户视觉

- "思考中…"圈圈一直转
- 但**输入框是开的**（accepted 后就解锁了，跟 endRun 无关）
- 右下角显示**发送按钮**而不是终止按钮（`isSending=false`，系统已认为结束）
- 用户能继续打字、发新消息——发新消息时旧的 streamingMsgs 会被 supersede 清掉（自愈）

矛盾的画面：圈圈在转 = "还在跑"，发送按钮 = "已经可以发新消息"。多数用户会被吓得不敢动。

## 3. 完整链路

```
DC 死亡 → __rejectAllPending('DC_CLOSED')
       ↓
   agent RPC waiter reject
       ↓
   agent-runs.store.__onRpcFailed → __endRun(runId, 'failed')
       ↓
   run.ended=true, 24h __timer 被清, watcher 停
       ↓
   onEnd 回调 → finalResolve({accepted:true, endReason:'failed'})
       ↓
   chat.store runPromise.then → __awaitPersistAndDrop
       ↓
   loadMessages({silent:true})  ← getReadyConn=null → return false
       ↓
   if (ok) dropRun → 跳过
       ↓
   streamingMsgs 永久残留 → allMessages 仍合并 → "思考中" 动画一直转
```

## 4. 关键事实（核实于 2026-05-02）

### 4.1 streaming overlay 不响应 run 状态

`run.ended` 翻成 true 之后**没有任何代码去擦那条占位上的 `_streaming` 标记**。`__endRun` 只标 ended、停 watcher、清 24h timer，不动 streamingMsgs 数组。占位渲染的开关只看一处：streamingMsgs 中那条 entry 上有没有 `_streaming: true`（`session-msg-group.js:64-66`、`ChatMsgItem.vue:87,98`）。

只有两条路径能让圈圈停：
- `dropRun` 整个 streamingMsgs entry 一锅清（来自 `__awaitPersistAndDrop` 成功 / 24h timer / `__cleanupRun`）
- 主动擦 `_streaming` 标记（**当前代码没人做**）

### 4.2 dropRun 设计意图：microtask 原子窗口，不是"等几秒"

`__awaitPersistAndDrop`（`chat.store.js:1383-1386`）实现：
```js
async __awaitPersistAndDrop(res, runKey, runsStore) {
    const ok = await this.loadMessages({ silent: true });
    if (ok) runsStore.dropRun(runKey, res.runId);
}
```

await 完成后立刻调 dropRun，**中间没有任何 await**。Vue 响应式调度异步（microtask 队列）：
- `loadMessages` 内 `this.messages = serverMsgs` 触发响应式更新（排队到下个 microtask）
- 紧接着 dropRun → `__cleanupRun` 删 streamingMsgs entry（同 microtask 内同步执行，再次排队）
- Vue 把这两次变更合并到下一次 nextTick 的同一次重 render

**用户视角看不到中间状态**——render 只发生一次，已经包含了"messages 有 final + streamingMsgs 没占位"。"防闪烁"靠的是 microtask 原子窗口，不是真的"占位多留几秒等用户看"。

24h `POST_ACCEPT_TIMEOUT_MS` 兜底（`agent-runs.store.js:171-175`）实际无意义——用户不会等 24h。

### 4.3 run 期间 UI 端持续收到 assistant 增量

不是 token-by-token，是**段-by-段**（每输出一段可见文字推一帧）。`data.text` 是**累积全文**，不是 delta（`pi-embedded-subscribe.handlers.messages.ts:565,607`）。UI 端 `applyAgentEvent`（`agent-stream.js:46-67`）每帧覆盖式重写——把 content 数组里的旧 text block 全 filter 掉，再塞回新的 `data.text` 整段。

其它流：
- **tool**：start / update / result 三种 phase 各一帧（`pi-embedded-subscribe.handlers.tools.ts:632-641 / 908-919`）
- **thinking**：覆盖最后一个 thinking block（`agent-stream.js:104-117`）
- **message_end**：还会单独再推一次最终 `stream:'assistant'`（`pi-embedded-subscribe.handlers.messages.ts:744-748`）

### 4.4 tool result 路径会 push 新的 streaming 占位

streamingMsgs 数组里**不只有最初一条占位**。tool 跑完后 `applyAgentEvent` 会 push 新的 streaming assistant entry 接力下一段（`agent-stream.js:84-99`）——所以 streamingMsgs 数组可能有多条 streaming entry。

### 4.5 streamingMsgs 真实价值

去掉占位会同时丢两类东西：
- **正在生成的当前段内容**：assistant 文字、thinking、tool call/result 序列——这些只在 run 期间通过 `event:agent` 实时写入 streamingMsgs，loadMessages 只能拿到上游已落盘的最终 transcript
- **"思考中"动画触发**：`_streaming === true` 是该标记的唯一来源

但只要 run 还活着、event 还在推，**占位会被新一帧自动重建并填充内容**（tool result 路径 push 新 entry）。所以"清掉占位"在正常 run 期间损失有限——主要损失是从清掉那一刻到下一帧 event 到达之间的几十~几百毫秒空窗。

**真正持续的损失只发生在 endRun + DC 永久死的场景**——再也不会有新 event 来重建占位，画面就一直空到下次 loadMessages 拉回 final（如果 conn 恢复的话）。

## 5. anchor 机制相关性

`anchorMsgId` 是发送瞬间记录的"server 已知的最后一条消息 id"（`chat.store.js:512-513`）。两个作用：

- **`allMessages` 插入位置**（`chat.store.js:141-156`）：把 streamingMsgs 插到 anchor 之后；anchor 找不到（被翻页截断或 reload 后消失）就 fallback 到末尾追加
- **`stripLocalUserMsgs` 决定是否摘掉乐观 user**（`agent-runs.store.js:522-571`）：loadMessages 回来后，看 anchor 之后是否已出现 server user message。出现了才把本地乐观 user 摘掉，并把 anchor **升级到 server 那条 user 上**——保持"user → 当前轮 botTask"的相邻关系

跟本 bug 直接交互的点：`stripLocalUserMsgs` 在 `run.ended` 时早返回（`agent-runs.store.js:526`）。也就是说 endRun 后任何 reconcile 路径想擦 streamingMsgs 都会被这个 guard 挡住——修复时如果走"摘 _streaming 标记"路线，需要绕开这个早返回。

"任务未完成"的兜底显示：当 botTask 既无 `isStreaming` 也无 `resultText` 时由 ChatMsgItem 渲染。anchor 错位场景下 `groupSessionMessages`（`session-msg-group.js:27-33`）顺序扫到 server 新 user 时会 finalize 上一组 botTask 并 push，残留 streamingClaw 被切成无 user 配对的 botTask，可能命中"任务未完成"分支。

## 6. 为什么本来设计的兜底全部失效

代码注释里写过两道兜底（`chat.store.js:1374-1378`），实际都失效：

| 兜底 | 失效原因 |
|------|---------|
| (a) 下次 activate / `__onConnReady` silent reload | `stripLocalUserMsgs` 在 `run.ended=true` 时早返回；`activate` / `__onConnReady` 的 silent reload 直接调 `loadMessages`，不走 `__awaitPersistAndDrop`，所以永远不会再 `dropRun` |
| (b) 24h `POST_ACCEPT_TIMEOUT_MS` timer | `__endRun` 触发时已被自己清掉（`agent-runs.store.js:443-446`） |

## 7. 修法选项（不下结论）

### 方案 A：失败路径补 30s 重试

`__awaitPersistAndDrop` 在 `ok=false` 分支挂一个 30s 重试 timer（或等 `__onConnReady` 触发 retry），retry 成功走正常 drop，retry 仍失败再打 `remoteLog` + 强制 drop。

**影响面**：仅改 `__awaitPersistAndDrop`，链路简单。强制 drop 时会丢失 streamingMsgs 中已积累的内容。

### 方案 B：activate / `__onConnReady` silent reload 后补 reconcile 路径

成功 reload 后调 `dropEndedRunIfTerminal(runKey, runId)`：发现 run 已 ended 但还在 runKeyIndex → drop。

**影响面**：动 `activate` / `__onConnReady` 的 reconcile 链路；要保证不误清还在跑的 run。

### 方案 C：失败路径不调 dropRun，改成"摘 _streaming 标记"

把占位的 `_streaming` / `_pending` 摘掉，转成"已完成 botTask"留在视图：
- 已收到 message_end → 渲染成完整回复
- 没收到 final → 渲染为"任务未完成"（兜底 UI 已存在）

**影响面**：
- 需要可观测信号区分"是否已收到 message_end"——目前 `applyAgentEvent` 不区分中间帧和终态帧（都是 `stream:'assistant'`，可能要靠 `stopReason` 之类字段）
- 需要绕开 `stripLocalUserMsgs` 的 `run.ended` 早返回 guard
- 圈圈停转、内容不丢，体验最好；改动面最大

### 方案 D：endRun 时同步清 streamingMsgs

最暴力，治本但耦合 endRun 与 UI 渲染，且失去原子窗口（rpc 快路径 endRun 时 loadMessages 还没回来，会真的闪烁）。**不推荐**。

## 8. 为什么暂不修

1. 触发条件窄：需要 ≥3 分钟持续网络故障且信令 WS 仍连
2. 用户能自愈：发新消息即清掉旧 streamingMsgs（runKey supersede）
3. 影响面有限：输入框、发送按钮、新消息流程都正常工作，只是有个"幽灵圈圈"
4. 修法涉及环节多：anchor / stripLocalUserMsgs / loadMessages / dropRun / message_end 信号 / 影响面评估都要细做
5. 修复时必须配套补单元测试，工作量比表面看起来大

## 9. 关键源码锚点速查

### UI 端
- `ui/src/stores/chat.store.js:469-478` — optimisticClaw 构造（`_streaming: true` 来源）
- `ui/src/stores/chat.store.js:512-514` — anchorMsgId 计算 + optimisticMsgs 传递
- `ui/src/stores/chat.store.js:135-156` — `allMessages` getter（按 anchor 合并）
- `ui/src/stores/chat.store.js:1383-1386` — `__awaitPersistAndDrop`（核心 bug 点）
- `ui/src/stores/chat.store.js:245-249` — `loadMessages` getReadyConn=null 早返回 false
- `ui/src/stores/agent-runs.store.js:425-455` — `__endRun`（清 24h timer，不动 streamingMsgs）
- `ui/src/stores/agent-runs.store.js:171-175` — 24h `POST_ACCEPT_TIMEOUT_MS` 兜底
- `ui/src/stores/agent-runs.store.js:270-277` — `dropRun`
- `ui/src/stores/agent-runs.store.js:463-476` — `__dispatch`（路由 event:agent 到 applyAgentEvent）
- `ui/src/stores/agent-runs.store.js:522-571` — `stripLocalUserMsgs`（line 526 ended 早返回）
- `ui/src/utils/agent-stream.js:46-121` — `applyAgentEvent`（增量流处理）
- `ui/src/utils/session-msg-group.js:14-90` — 渲染分组（`isStreaming` 触发条件）
- `ui/src/services/claw-connection.js:362-377` — `__rejectAllPending`（信号 4）
- `ui/src/services/webrtc-connection.js:734-752` — `dc.onclose` 触发 reject

### 上游事件源
- `openclaw-repo/src/agents/pi-embedded-subscribe.handlers.messages.ts:565,605-626` — assistant 中间段 emit（`data.text` 是累积全文）
- `openclaw-repo/src/agents/pi-embedded-subscribe.handlers.messages.ts:728-755` — message_end emit
- `openclaw-repo/src/agents/pi-embedded-subscribe.handlers.tools.ts:632-641 / 908-919` — tool start / result emit

### 链路中转
- `plugins/openclaw/src/realtime-bridge.js:810-846` — bridge 转发 event 到 DC
- `ui/src/stores/claws.store.js:595-598` — UI 桥接入口（`__bridgeConn` → `agentRunsStore.__dispatch`）
