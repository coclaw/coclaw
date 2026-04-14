# OpenClaw Agent Run 取消机制

> 更新时间：2026-04-14（再次校验，基于 OpenClaw commit `d7cc6f7643`，即 `v2026.4.14-beta.1+69`）
> 初版基于 commit `03523c65d5`；阶段 3 启动前已逐条核验，核心结论仍成立，差异见下文"再校验备注"
> 关联文档：[agent-event-streams-and-rpcs.md](./agent-event-streams-and-rpcs.md) · [gateway-protocols.md](./gateway-protocols.md)

## 结论速查

- OpenClaw **不提供** `agent.abort` RPC；`chat.abort` 仅覆盖 `chat.send` 路径，对 `agent()` RPC 发起的 run **无效**。
- OpenClaw 底层已有**真正可取消** agent run 的原语 `abortEmbeddedPiRun(sessionId)`，但 gateway 层未对外暴露，`api.runtime.agent` 也未导出。
- 存在一个**未文档化的侧门**：`globalThis[Symbol.for("openclaw.embeddedRunState")].activeRuns.get(sessionId)?.abort()`——自 v2026.3.12（2026-03-13 发版）起在所有版本中可用。
- 被取消的 `agent()` RPC **正常 resolve**（非 reject），completion 帧包含 `result.meta.aborted === true`。
- UI **无法**从 `lifecycle:end` 事件本身区分"取消"vs"正常完成"（payload 不带 `aborted` 字段）；需从 RPC 的 completion 帧或自管的业务状态判断。
- `/compact` 命令执行中**无法取消**——无 AbortController、不注册 `ACTIVE_EMBEDDED_RUNS`。

---

## 一、Agent run 注册与生命周期

所有由 `agent()` RPC 或 `chat.send` 触发的 agent run，最终都会进入统一的底层路径 `runAgentAttempt`（`src/agents/pi-embedded-runner/run/attempt.ts`），并在 attempt.ts:1421 调用：

```ts
setActiveEmbeddedRun(sessionId, queueHandle, sessionKey);
```

将 `EmbeddedPiQueueHandle` 注册到 `ACTIVE_EMBEDDED_RUNS`（Map<sessionId, handle>）。handle 结构（`pi-embedded-runner/runs.ts:20-27`）：

```ts
type EmbeddedPiQueueHandle = {
  kind?: "embedded";
  queueMessage: (text: string) => Promise<void>;
  isStreaming: () => boolean;
  isCompacting: () => boolean;
  cancel?: (reason?: "user_abort" | "restart" | "superseded") => void;
  abort: () => void;          // ← 真正的终止入口
};
```

`handle.abort()` 的行为（当前 `attempt.ts:1457-1468` 的 `abortRun`，同步返回；初版位置 1316-1328）：

1. `runAbortController.abort(reason)` — 信号扩散到 fetch 流、工具 `abortable()` 包装等
2. `abortCompaction()`（`attempt.ts:1443-1455`）— 若在 compacting，中止 compaction session
3. `void activeSession.abort()` — fire-and-forget，不等实际 idle

attempt 的 `finally` 块在 run 结束后清理：`unsubscribe()` → `clearActiveEmbeddedRun()`（当前 `attempt.ts:2316`）→ `notifyEmbeddedRunEnded()`（唤醒 `waitForEmbeddedPiRunEnd` 的等待者）。

---

## 二、三套互不相通的 run registry

| Registry | 键 | 持有 | 谁填充 | `chat.abort` 能否找到 |
|---|---|---|---|---|
| `context.chatAbortControllers` | `clientRunId` | `AbortController` | 仅 `chat.send` (`chat.ts:1313` 注册) | ✓ |
| `ACTIVE_EMBEDDED_RUNS`（侧门 symbol state） | `sessionId` | `EmbeddedPiQueueHandle`（含 `.abort()`） | 所有 embedded run（含 `agent()`、`chat.send`）(`runs.ts:60` 存储，`attempt.ts:1572` 调用 `setActiveEmbeddedRun`) | ✗ |
| `ReplyRunRegistry` | `sessionKey` | `ReplyOperation` + AbortController | auto-reply/followup 路径（`reply-run-registry.ts`） | 经 `abortChatRunBySessionId` fallback |

**关键后果**：`chat.abort` 仅查 `chatAbortControllers`；`agent()` 不注册那里，所以 `chat.abort` 对 `agent()` run **无效**。唯一统一的底层原语是 `abortEmbeddedPiRun(sessionId)`（`runs.ts:118-179`），它先查 `ACTIVE_EMBEDDED_RUNS`，未命中时 fallback 到 `abortReplyRunBySessionId`——覆盖所有场景。

---

## 三、侧门访问路径

### 3.1 入口

```js
const state = globalThis[Symbol.for("openclaw.embeddedRunState")];
const handle = state?.activeRuns?.get(sessionId);
await handle?.abort();           // 真正 abort
await waitForReallyDrain();      // 可选：等真正结束
```

`Symbol.for(name)` 使用全局 symbol 注册表——跨 module、跨 bundler chunk 都解析为同一 symbol。这是 OpenClaw 有意设计的跨 chunk 状态共享点（`runs.ts:47-49` 注释："so busy/streaming checks stay consistent even when the bundler emits multiple copies of this module into separate chunks"）。

`resolveGlobalSingleton`（`src/shared/global-singleton.ts:4-12`）保证：首次调用写入 `globalThis[key]`，后续调用返回同一引用。插件在同进程内访问即为同一对象。

### 3.2 State shape（当前）

```ts
{
  activeRuns:       Map<sessionId, EmbeddedPiQueueHandle>,   // ★ 主入口
  snapshots:        Map<sessionId, ActiveEmbeddedRunSnapshot>,
  sessionIdsByKey:  Map<sessionKey, sessionId>,              // 反查
  waiters:          Map<sessionId, Set<EmbeddedRunWaiter>>,
  modelSwitchRequests: Map<sessionId, ...>,
}
```

### 3.3 版本范围与稳定性

- Symbol 引入 commit：`4ca84acf24`（2026-03-12，"fix(runtime): duplicate messages, share singleton state across bundled chunks #43683"）
- **最早包含的 release tag：`v2026.3.12`（tag 日期 2026-03-13 04:26 UTC）**
- 共 19 个 tag 包含该 commit（`v2026.3.12` 至 `v2026.3.24-beta.2`）
- Shape 演化（仅加法，无破坏性变更）：
  - `activeRuns + waiters`（原始）
  - `+ snapshots`（`9aac55d306`）
  - `+ modelSwitchRequests`（`7dd196ed74`，2026-03-27）
  - `+ sessionIdsByKey`（`cf65843787`，2026-04-05）
- `EmbeddedPiQueueHandle.abort` 自 `bcbfb357be`（2026-01-14）原始引入以来签名未变
- 旧版 OpenClaw（`< v2026.3.12`）访问 `globalThis[Symbol.for(...)]` 返回 `undefined`，链式可选访问安全——不抛错

### 3.4 CoClaw 插件版本约束现状

- `plugins/openclaw/package.json` 无 `peerDependencies`、无 OpenClaw 版本 pin
- `plugins/openclaw/index.js:257` 读 `api.runtime?.version` 仅用于 `coclaw.info` 展示，未做 gating
- **插件必须做运行时 feature detection**（探测 `globalThis[Symbol.for(...)]?.activeRuns`）才能安全启用侧门能力

---

## 四、`agent()` vs `chat.send` RPC 差异

### 4.1 Schema 对比

| 参数 | `agent()` | `chat.send` |
|---|---|---|
| `sessionKey` | optional | **required** |
| `sessionId` | ✓（topic 模式用） | **✗** |
| `extraSystemPrompt` | ✓ | **✗** |
| `agentId` / `provider` / `model` 覆盖 | ✓ | ✗（session 配置锁定） |
| `to` / `replyTo` / `threadId` / `groupId` / `lane` / `label` / `bestEffortDeliver` | ✓ | ✗ |
| `internalEvents`、`inputProvenance` | ✓ | ✗ |
| `originatingChannel/To/AccountId/ThreadId` | ✗ | ✓ |
| `systemProvenanceReceipt`（S2C 信物） | ✗ | ✓ |
| 自动注册 `AbortController` 至 `chatAbortControllers` | ✗ | ✓ |

### 4.2 执行路径

- 两者**底层相同**：都经 `runAgentAttempt` → `setActiveEmbeddedRun`，都触发同一套 `event:agent` 事件流
- 差异在 RPC 契约与控制层：
  - `agent()` 是两帧响应（accepted ack → completion frame），per-connection
  - `chat.send` 是一帧 started ack + 广播 `chat` 事件（`state: delta|final|aborted|error`），broadcast
  - `chat.send` 有内置 `/stop` 识别（`isChatStopCommandText`，~45 个多语言触发词，`abort-primitives.ts:3-46`），直接调 `abortChatRunsForSessionKeyWithPartials`

### 4.3 Topic 模式下 sessionKey 合成

`agent()` 传 `sessionId: <uuid>`、`sessionKey: undefined` 时，下游 `resolveSessionKeyForRequest`（`agents/command/session.ts:153-158`）合成：

```
agent:${normalizeAgentId(agentId) || "main"}:explicit:${sessionId}
```

此合成 key 传到 `setActiveEmbeddedRun`，**同时**注册到 `activeRuns` 和 `sessionIdsByKey`。但 CoClaw 插件通常直接用 sessionId 调 `activeRuns.get(sessionId)`，无需关心合成 key 的 shape。

---

## 五、事件与 RPC 响应：abort 的外在表现

### 5.1 `lifecycle` 事件

两个发射源：
1. **Subscription 层** `pi-embedded-subscribe.handlers.lifecycle.ts:handleAgentEnd`（当前约 L39 起，发 emit 在 L130-148）
   - 发 `{phase: "end", livenessState?, replayInvalid?, endedAt}`（正常）或 `{phase: "error", error}`（有 stopReason === "error" 时）
   - **不带 `aborted`、不带 `stopReason`**
2. **Command 层 fallback** `agent-command.ts` 内 `lifecycleEnded` 标志相关的 emit（当前约 L843-1013 范围，原位置 L818-833）
   - 发 `{phase: "end", aborted, stopReason, startedAt, endedAt}`
   - **仅当源 1 未发射时才触发**（由 `lifecycleEnded` 标志控制）

⚠️ **关键陷阱**：`handleAgentEnd` 会回调 `onAgentEvent`，直接置 `lifecycleEnded = true`（当前 `agent-command.ts:910`），导致源 2 的 emit **永远不触发**——原 agent 入口的主路径收到的 `lifecycle:end` 对 abort 和正常完成看起来完全相同。

**再校验备注（2026-04-14）**：`agent-command.ts:919-934` 的 fallback emit **已含 `aborted: result.meta.aborted ?? false` 和 `stopReason`**，但它仍被 `lifecycleEnded=true` 跳过。真正的缺口在 `pi-embedded-subscribe.handlers.lifecycle.ts:handleAgentEnd` —— 该路径 emit 时未读 `lastAssistant.stopReason`、未从 attempt 结果取 `aborted`。因此上游 PR 3c 的**精准修复位点**是 `handleAgentEnd`，而非 agent-command（agent-command 已写好字段，只是触发分支进不去）。

**结果**：UI 收到的 `lifecycle:end` payload 对 abort 和正常完成**看起来完全相同**。

### 5.2 UI 区分 abort 的可靠路径

| 路径 | 可用场景 | 字段 |
|---|---|---|
| `agent()` RPC completion frame | `agent()` 请求方 | `result.meta.aborted`、`result.meta.stopReason === "aborted"` |
| `event:chat` 广播 | `chat.send` 路径 | `state: "aborted"` / `state: "final"` |
| CoClaw 自发业务事件 | 统一 | 插件广播 `coclaw.run.aborted` 等 |

⚠️ **对 UI 的含义**：
- CoClaw 若 reject 原 `agent()` RPC Promise（如用 `Promise.race` + `cancelPromise`），**会丢失 completion frame 的 aborted 标志**
- 推荐：cancelSend 发 abort 信号后，**不 reject 原 RPC Promise**，让其自然 resolve 到带 `aborted` 的 completion

### 5.3 被取消的 `agent()` RPC

- `runAgentAttempt` 在 abort 时**不抛**，返回 `{ aborted: true, messagesSnapshot, ... }`
- `dispatchAgentRunFromGateway`（`server-methods/agent.ts:188-264`）走 `.then(result => respond(true, {...}))`
- UI 的 `conn.request('agent', ...)` **正常 resolve**
- 如果 RPC 已 reject，`event:agent` 事件流（独立通道）仍正常到达 UI

---

## 六、边界行为与陷阱

### 6.1 幂等性
- `handle.abort()` 重复调用安全：`AbortController.abort()` 及 `activeSession.abort()` 均幂等
- `abortEmbeddedPiRun(sessionId)` 对不存在 sessionId 返回 `false`，不抛
- `handle.abort()` 被 runs.ts:137-142 的 try/catch 包裹，额外保底

### 6.2 Handle 替换
`setActiveEmbeddedRun`（`runs.ts:340-357`）直接 `ACTIVE_EMBEDDED_RUNS.set(sessionId, newHandle)`，**不 abort 旧 handle**。`clearActiveEmbeddedRun`（369-387）通过 `get() !== handle` 识别并跳过误删。

⚠️ **含义**：若 CoClaw 在 abort 后立即对同 sessionId 发新消息（触发新 run），**旧 run 仍在后台继续**直到自己的 finally 执行。`waitForEmbeddedPiRunEnd` 是唯一确保"真正停了"的信号。

### 6.3 `/compact` 不可取消
当前 `commands-compact.ts` 内 `/compact` handler 约 L72-145：
- `/compact` 进入时先 `abortEmbeddedPiRun(sessionId) + waitForEmbeddedPiRunEnd(sessionId, 15_000)` 中止**当前** run
- 然后调 `compactEmbeddedPiSession({...})`，**不传 `abortSignal`**、**不调 `setActiveEmbeddedRun`**
- 结果：进行中的 compaction **无法被取消**，仅靠 `compactionTimeoutMs` 兜底
- `/compact` 影响 CoClaw UX：用户发 `/compact` 时，当前 agent run 会被 **强制中止 + 等待 15s**，前端的 streamingMsgs 与事件流会被打断

**再校验备注（2026-04-14）**：`CompactEmbeddedPiSessionParams` 的类型声明（`src/agents/pi-embedded-runner/compact.types.ts:56`）已新增 `abortSignal?: AbortSignal` 字段；`compact.ts:520` 的 `prepareCompactionSessionAgent` 也已接受 `runAbortController.signal`。换言之上游已预留"接收外部 abort 信号"的接口通道，但 `commands-compact.ts` 调用点仍未传 signal、也未调用 `setActiveEmbeddedRun`。**因此 PR 3d 的改动面比原设想小**：只需在 commands-compact 层构造 AbortController、传入 `abortSignal` 并注册到 `ACTIVE_EMBEDDED_RUNS`，底层类型无需再改。

### 6.4 队列未清空
`activeSession.abort()` 仅"wait for idle"，不清空 `queueMessage` 提交的 steering messages。OpenClaw 源码从未调用 `activeSession.clearQueue()`。队列最终随 session dispose 消失，但 abort 后的极短窗口内，`queueEmbeddedPiMessage` 可能仍能接受消息投入已废弃的队列。

### 6.5 竞态窗口
- abort 信号扩散 → `activeSession.abort()` Promise 解析：毫秒级但非零
- `runAbortController.abort()` 同步；下游 fetch/工具 abort 实际生效异步
- `isStreaming()` 可能在 abort 触发后仍短暂返回 true

### 6.6 典型 abort 结束延时
- `attempt.ts:1465-1475` 有 10s `abortWarnTimer`（仍 streaming 就警告）——说明 OpenClaw 内部预期 << 10s
- `commands-compact.ts:88` 用 15s 作为保守 `waitForEmbeddedPiRunEnd` 超时
- CoClaw 插件 RPC 推荐 5–10s 超时

---

## 七、CoClaw 集成建议

### 7.1 推荐的取消信号流
```
UI cancel 按钮
  → conn.request('coclaw.agent.abort', { sessionId })   （插件 RPC）
  → 插件:
      1. state = globalThis[Symbol.for("openclaw.embeddedRunState")]
      2. handle = state?.activeRuns?.get(sessionId)
      3. handle?.abort()
      4. await waitForEmbeddedPiRunEnd(sessionId, 10_000)  // 可选但建议
      5. 响应 { aborted: true, waited: true }
  → UI 端：
      - 不 reject 原 `agent()` RPC Promise（让 completion frame 到达）
      - 依赖 agentRunsStore 的 __settleWithTransition 等待 lifecycle:end
      - 从 completion frame 的 result.meta.aborted 区分"被取消"
```

### 7.2 Feature detection
插件启动时探测：
```js
const state = globalThis[Symbol.for("openclaw.embeddedRunState")];
const abortSupported = !!state?.activeRuns;
// 在 coclaw.bind 响应或 coclaw.info 里暴露 `capabilities.agentAbort = abortSupported`
```

### 7.3 UI 区分取消
- 优先：`agent()` RPC completion frame 的 `result.aborted`
- 兜底：插件可额外广播 `coclaw.run.aborted` 业务事件（`api.runtime` 内已有 broadcast 机制，见 `plugins/openclaw/index.js:294` 的 `broadcastPluginEvent('coclaw.info.updated', ...)` 范例）

### 7.4 斜杠命令路径
- 普通 `/new`、`/reset`、`/help`：短任务，无需取消
- `/compact`：**UI 应明确不支持取消**（或告知用户"进行中，无法中断"）
- `/stop`（或多语言等价）：其实是**内置取消触发**，chat.send handler 直接调 `abortChatRunsForSessionKeyWithPartials`——CoClaw 可以把"取消按钮"降级方案映射到发送 `/stop`（但仅覆盖 chat.send 路径）

---

## 八、已知上游遗留问题（见 `docs/openclaw-upstream-issues.md`）

| 问题 | 影响 | 建议修复 |
|---|---|---|
| 缺 `agent.abort` RPC | 外部客户端（含 CoClaw UI）无官方取消入口 | 添加新 RPC，接受 `{runId}` 或 `{sessionId}`，内部调 `abortEmbeddedPiRun` |
| `api.runtime.agent` 未暴露 `abortEmbeddedPiRun` 等 | 插件只能走侧门 symbol，非正式契约 | `runtime-embedded-pi.runtime.ts` 额外 re-export `abortEmbeddedPiRun`、`waitForEmbeddedPiRunEnd`、`isEmbeddedPiRunActive`（`src/agents/pi-embedded.ts` 已 re-export，只需 plumb 到 runtime） |
| `lifecycle:end` 缺 `aborted` / `stopReason` | 客户端无法通过事件区分取消 vs 完成 | `handleAgentEnd` 读 `lastAssistant.stopReason` 并包含进 payload |
| `/compact` 不可取消 | UX 缺陷；长 compaction 期间用户无解 | `compactEmbeddedPiSession` 接受并尊重 `abortSignal`，或注册到 `ACTIVE_EMBEDDED_RUNS` |

---

## 参考文件索引

- `src/agents/pi-embedded-runner/runs.ts` — 侧门 state、`abortEmbeddedPiRun`、`waitForEmbeddedPiRunEnd`
- `src/agents/pi-embedded-runner/run/attempt.ts:1316-1328` — `abortRun` 实现
- `src/agents/pi-embedded-runner/run/attempt.ts:1421` — `setActiveEmbeddedRun` 注册点
- `src/agents/pi-embedded-runner/run/attempt.ts:1989-2014` — 清理 finally
- `src/agents/pi-embedded-subscribe.handlers.lifecycle.ts:38-104` — `handleAgentEnd` 事件发射
- `src/agents/agent-command.ts:803-833` — `lifecycleEnded` 标志 + fallback emit（被 skip 的那个）
- `src/agents/agent-command.ts:981-1003` — `agentCommandFromIngress` 入口
- `src/agents/command/session.ts:50-52, 153-158` — topic 模式 sessionKey 合成
- `src/gateway/server-methods/agent.ts:188-264` — `dispatchAgentRunFromGateway` 两帧响应
- `src/gateway/server-methods/agent.ts:266-855` — `agent()` handler
- `src/gateway/server-methods/chat.ts:1257-1337` — `chat.abort` handler
- `src/gateway/server-methods/chat.ts:1413-1474` — `chat.send` 内置 stop 识别
- `src/gateway/server-methods/chat.ts:1531-1540` — `chat.send` 注册 AbortController
- `src/gateway/chat-abort.ts:76-108` — `abortChatRunById` 实现
- `src/gateway/protocol/schema/agent.ts:80-111` — `AgentParamsSchema`
- `src/gateway/protocol/schema/logs-chat.ts:35-52` — `ChatSendParamsSchema`
- `src/auto-reply/reply/commands-compact.ts:65-130` — `/compact` handler（不可取消）
- `src/auto-reply/reply/abort-primitives.ts:3-46, 51-83` — `/stop` 多语言识别
- `src/plugins/runtime/runtime-embedded-pi.runtime.ts` — 插件 runtime wrapper（当前仅暴露 `runEmbeddedPiAgent`）
- `src/shared/global-singleton.ts` — `resolveGlobalSingleton`
- `src/agents/pi-embedded.ts` — 已 re-export `abortEmbeddedPiRun` 等（插件 runtime 未传递）
