# Agent Run 取消：分阶段实施方案

> **状态**：阶段 1、2、2.5 已完成；阶段 3 上游 issues 已提交（#66531 / #66532 / #66534 / #66535，2026-04-14），等待维护者反馈；合并后按末尾"CoClaw 侧适配路径"表渐进迁移
> **创建时间**：2026-04-14
> 阶段 1 commits：`5d3d97e` docs + `2bd7f3a` fix(ui)
> 阶段 2 commits：`3d21a5e` feat(plugin) + `17cc790` feat(ui)
> 阶段 2.5：UI 主导的 cancel 协调状态机（500ms 重试无 TTL）+ 插件诊断 patch 产品化 + remoteLog 触点（2026-04-15 实施完成）
> **调研依据**：[`docs/openclaw-research/agent-run-cancellation.md`](../openclaw-research/agent-run-cancellation.md)（见 §6.7 注册时序空窗期）
> **上游遗留问题**：[`docs/openclaw-upstream-issues.md`](../openclaw-upstream-issues.md) "待提交：Agent Run 取消相关"章节

## 背景（3 行摘要）

当前 `cancelSend` 立即销毁前端 streamingMsgs，导致 main-agent-chat / topic 的用户气泡消逝；且 OpenClaw 底层 agent run 仍在跑，完成后结果不刷新。根因是 `cancelSend` 用了 `settle()` 硬清理、**且没有向服务端发真正的取消信号**——而 OpenClaw 上游既无 `agent.abort` RPC 也未在 `api.runtime.agent` 暴露 abort 接口。唯一的底层真取消能力是 `abortEmbeddedPiRun(sessionId)`，可通过 `globalThis[Symbol.for("openclaw.embeddedRunState")]` 侧门访问（自 OpenClaw `v2026.3.12` 起可用）。

---

## 核心原则

1. **语义对齐 qidianchat**：取消 = 发真正终止信号 → 服务端真 abort → UI 通过正常 reconcile 路径消化（CoClaw 的差异：允许用户边等待边输入，不锁定）。
2. **阶段独立**：阶段 1 不依赖阶段 2 / 3。即使阶段 2 运行时失败（侧门不存在），阶段 1 仍正常生效。
3. **不 reject 原 RPC Promise**：让 `agent()` 的 completion frame 正常到达，保留 `result.meta.aborted` 作为业务态判定依据（UI 可据此区分"被取消"vs"正常完成"）。

---

## 决策节点（已确认）

1. ✅ **阶段 1 `cancelSend` 新语义**：改为"保留气泡不消逝、保留 streamingMsgs、让原 RPC 自然完成"。取消后 `sending=false`、`__accepted=true`，`inputLocked=sending&&!__accepted=false`，输入框启用（与发消息过程中 accepted 后一致：允许 typing/准备下次消息的附件）；`isSending=sending||isRunning` 中 `isRunning` 仍为 true（`!run.settled`），发送按钮保持为 STOP 状态（并非禁用输入）。真正"取消 → 发送按钮恢复 SEND"在阶段 2 生效（真 abort → `lifecycle:end` 快速到达 → `completeSettle` → `isRunning=false`）。
2. ✅ **阶段 2 RPC 响应 shape**：插件 `coclaw.agent.abort` 用常规 `{ ok: true }` / `{ ok: false, reason }`，语义是"请求是否被接纳"；取消是否真生效由 `lifecycle:end` 事件反映，不放在 RPC 响应里。立即响应不等 `waitForEmbeddedPiRunEnd`。
3. ✅ **阶段 2 无版本门槛 + 纯 feature detection**：不读 OpenClaw 版本号；UI 端无条件调用 `coclaw.agent.abort`；插件端若侧门不存在直接返回 `{ ok: false, reason: 'not-supported' }`；UI 端对失败静默降级到阶段 1 行为。未来 OpenClaw 若删除 Symbol state，插件仍能工作（abort 失败但不抛错）。**不在 `coclaw.info` 暴露 `capabilities.agentAbort`**（无需）。
4. ✅ **`/compact` 处理**：UI 的 `/compact` 分支禁用取消按钮或显示"进行中不可中断"。
5. ✅ **上游 PR 提交主体**：由 CoClaw 团队通过 `openclaw-issue` skill 提。

---

## 阶段 1：前端纯本地修复（所有 OpenClaw 版本受益）

### 目标

用户消息气泡不再消逝；agent run 完成后 UI 正常 reconcile 出结果。服务端 agent 仍会继续执行到完成（此阶段不处理）。

### 变更清单

#### 1.1 `ui/src/stores/agent-runs.store.js`

暴露 `__settleWithTransition` 为公共方法 `settleWithTransitionByKey(runKey)`：

- 接受 runKey，内部 resolve 为 runId 后调 `__settleWithTransition`
- 若找不到 run（未注册）或 run 已 settled，no-op

#### 1.2 `ui/src/stores/chat.store.js:662-691` (`cancelSend`)

改动点：

```
原：
  if (this.__cancelReject) { this.__cancelReject(err); this.__cancelReject = null; }
  if (this.__accepted) {
    useAgentRunsStore().settle(this.runKey);        // ← 硬清理
    // ...
    this.sending = false;
    this.__reconcileMessages();                     // ← 立即异步 reload
  } else { ... }

改：
  if (this.__accepted) {
    useAgentRunsStore().settleWithTransitionByKey(this.runKey);  // ← 软过渡
    this.sending = false;
    // 不 reject __cancelReject，让原 agent() RPC 自然完成
    // 不立即 reconcile，让 lifecycle:end 到达后走现有 completeSettle 流程
  } else {
    // 未 accepted 分支保持原样：__cleanupStreaming + sending=false
    this.__cleanupStreaming();
    this.sending = false;
    if (this.__cancelReject) { this.__cancelReject(err); this.__cancelReject = null; }
  }
```

**关键点**：
- 已 accepted 场景：不 reject 原 Promise、不立即 reload、用 settleWithTransition 保留 streamingMsgs
- 未 accepted 场景：仍需 reject（阻止 RPC 继续），因为服务端尚未开始

#### 1.3 注释 + 行为说明

在 `cancelSend` 顶部加注释：说明新语义是"释放 UI 挂起"而非"终止 run"；run 本身由 `lifecycle:end` 自然触发 completeSettle。

### 风险 & 缓解

- ⚠ **原 RPC Promise 迟迟不 settle**：`cancelPromise` 不再 reject（accepted 分支还会 nullify `__cancelReject` 槽位，避免后续 `cleanup()` 多余 reject），依赖 `agent()` completion frame 或 post-acceptance 30min timeout 最终 settle。正常路径，已有兜底。
- ⚠ **`completeSettle` 必须区分 settling 来源**：原 `completeSettle` 对任何 `settling=true` 的 run 无差别 cleanup。若 cancelSend 后还没到 `lifecycle:end`，任何独立 loadMessages（WS 闪断重连 → `ChatPage.__onConnReady` 的 silent reload、前台恢复、`activate` 重入的 idle reload）都会误清 streamingMsgs——刚要修的 bug 换个路径复现。**解法**：给 run 新增 `settlingReason: 'lifecycle' \| 'cancel'`，`settleWithTransitionByKey` 设 `'cancel'`；`__settleWithTransition`（由 lifecycle:end 触发）设 `'lifecycle'`；`completeSettle` 仅处理 `'lifecycle'`。
- ⚠ **handle-mismatch 保护已存在**：新旧 run 并存时互不干扰。
- ⚠ **30min post-acceptance 最终兜底**：cancel 进入 settling(cancel) 后若 `lifecycle:end` 永不到达（极端——网络完全失联且不恢复），由 `agent-runs.store` 的 30min timer 触发 `settle()` 硬清。这是已有机制。

### 测试

- **单元**：
  - `cancelSend` 已 accepted 后：`allMessages` 仍含 streamingMsgs；`run.settling=true`、`settlingReason='cancel'`；`sending=false`、`__cancelReject=null`、`isSending=true`（禁用输入）
  - `completeSettle` 对 `settlingReason='cancel'` no-op、对 `'lifecycle'` 正常清理
  - cancel 后独立 loadMessages 触发 → streamingMsgs 保留（P0 回归防护）
  - cancel 后 lifecycle:end 到达 → `__dispatch` 升级 reason 为 `'lifecycle'` → 再次 completeSettle 可清理
- **E2E**：发消息 → accepted → 立即点取消 → 验证用户气泡仍在 → （模拟 WS 闪断重连 / 切到后台再回来）→ 气泡仍在 → 等 agent 自然完成 → 消息最终正常显示

### 产出（已完成）

commit `2bd7f3a` — `fix(ui): preserve message bubble on cancelSend via settling reason gate`（@coclaw/ui patch）

---

## 阶段 2：插件侧门 + UI 集成

### 目标

用户点取消时**真正终止**服务端 agent run，而非仅前端解挂。无版本门槛：侧门不存在则返回 `{ ok: false, reason: 'not-supported' }`，UI 静默降级到阶段 1 行为。

### 变更清单

#### 2.1 `plugins/openclaw/src/agent-abort.js`（新文件）

封装侧门访问的唯一入口，隔离 shape 依赖：

```js
const EMBEDDED_RUN_STATE_KEY = Symbol.for('openclaw.embeddedRunState');

export function abortAgentRun(sessionId) {
  const state = globalThis[EMBEDDED_RUN_STATE_KEY];
  if (!state || !state.activeRuns || typeof state.activeRuns.get !== 'function') {
    return { ok: false, reason: 'not-supported' };
  }
  const handle = state.activeRuns.get(sessionId);
  if (!handle) return { ok: false, reason: 'not-found' };
  try {
    handle.abort();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'abort-threw', error: String(err?.message ?? err) };
  }
}
```

对应单元测试用 mock `globalThis[Symbol.for('openclaw.embeddedRunState')]` 验证各分支（not-supported / not-found / ok / abort 抛异常）。

#### 2.2 `plugins/openclaw/index.js`

- 注册 RPC：`coclaw.agent.abort`
  - 入参 schema：`{ sessionId: string }`（手动验）
  - 处理：直接调 `abortAgentRun(params.sessionId)`，立即 respond 其结果
  - 权限：沿用现有插件 RPC 的默认 scope
- **不做启动时 feature detection，不在 `coclaw.info` 暴露 `capabilities.agentAbort`**——探测发生在每次调用时（侧门本身会返回 not-supported）

#### 2.3 `ui/src/stores/chat.store.js`（基于阶段 1 再扩展）

`cancelSend` 已 accepted 分支：

```
1. settleWithTransitionByKey(runKey)     // 阶段 1 动作
2. sessionId = this.sessionId || this.currentSessionId
   if sessionId:
     conn.request('coclaw.agent.abort', { sessionId })
       .catch(() => { /* 静默 */ })     // 无论 RPC 不存在还是返回 ok:false，都降级到阶段 1 行为
3. sending = false
```

- sessionId 可靠来源：
  - topic 模式：`this.sessionId`（UUID，始终有）✓
  - main-agent chat：`this.currentSessionId`（来自 `chat.history`，`loadMessages` 里同步）——**阶段 2 实施前先核实**：首条消息 accepted 后、loadMessages 跑完前，`currentSessionId` 可能为 null 或指向上一 session；需核实 `agent()` RPC 的 `onAccepted` payload 是否包含 sessionId，若有则优先用 payload 的 sessionId 作为 abort 目标
- 无需 capability gate：UI 无条件发 RPC，任何失败静默降级
- 失败场景：RPC 本身不存在（很老的 CoClaw 插件）、侧门不支持（很老的 OpenClaw）、sessionId 不在 activeRuns 中（竞态）、sessionId 本地无法获取（首消息 + currentSessionId 为 null + onAccepted payload 无 sessionId——降级为纯阶段 1 行为）

#### 2.4 斜杠命令（`/compact` UI 禁用取消）

`ui/src/components/ChatInput.vue` 或 `ChatPage.vue`：

- 当 `__slashCommandType` 匹配 `/compact` 时禁用取消按钮，或按钮改显示"处理中不可中断"的 tooltip
- 对其他斜杠命令（`/new` `/reset` `/help`）：短任务，通常无需取消

### 关键设计决策

- **侧门访问仅限 `activeRuns.get(sessionId)?.abort()`**，不读 waiters / snapshots 等其他字段（最小化 shape 依赖）
- **不 await 真正结束**：插件 RPC 立即响应；UI 依赖 `lifecycle:end` 的自然到达
- **无版本门槛 + 无 capability gate**：UI 无条件调用、插件按 shape 实际情况返回 ok/not-supported，失败静默降级。未来 OpenClaw 若删除 Symbol state，插件仍正常工作

### 风险 & 缓解

- ⚠ **Symbol state shape 变更**：shape 自引入以来仅做加法，但无官方稳定性承诺。缓解：封装 `agent-abort.js` 的单一访问点、failsafe optional chaining、每次 OpenClaw 升级回归测试
- ⚠ **handle 替换竞态**：OpenClaw `setActiveEmbeddedRun` 不 abort 旧 handle。取消后立即发新消息（未来功能）需确保先 `lifecycle:end` 到达
- ⚠ **`/compact` 不可取消**：UI 主动禁用按钮（fallback）

### 测试

- **插件单元测试**（`plugins/openclaw/src/agent-abort.test.js`）：mock globalThis symbol state 的各种 shape（undefined、activeRuns 不存在、handle.abort 抛异常、正常 abort）
- **插件 RPC 测试**：验证 `coclaw.agent.abort` handler 的入参验证、响应 shape
- **集成测试**：CoClaw + OpenClaw 端到端：发消息 → accepted → 触发取消 → 通过 `openclaw logs --follow` 观察 abort 日志
- **降级测试**：mock 侧门缺失，验证 UI 降级到阶段 1 行为且不抛错

### 产出（已完成）

- commit `3d21a5e` — `feat(plugin): add coclaw.agent.abort RPC via embedded run side door`（@coclaw/openclaw-coclaw minor）
- commit `17cc790` — `feat(ui): call coclaw.agent.abort on user cancel + disable /compact cancel`（@coclaw/ui minor）

实施与设计的细节差异：
- sessionId 可靠性核实结果：`onAccepted` payload 只有 `{ runId, status, acceptedAt }`，**不含 sessionId**（见 `openclaw-repo/src/gateway/server-methods/agent.ts:767-771`），因此阶段 2 实际采用 `this.sessionId || this.currentSessionId`；chat 模式首条消息在 `chat.history` 尚未返回时 `currentSessionId` 可能为 null，此时跳过 RPC，降级为纯阶段 1 UI 行为（气泡保留但服务端 run 继续至完成）——设计允许的可接受退化
- `/compact` 禁用方案采用"禁用按钮"（`ChatInput` 新增 `cancelDisabled` prop），未加新 tooltip 与 i18n key，依赖 UButton 自带 disabled 样式
- `abortAgentRun` 的 `error` 字段用 `String(err?.message ?? err)` 而非 `String(err)`（对 Error 实例更清爽）

---

## 阶段 2.5：注册空窗期 race（已实施）

### 背景（事后发现）

**现象**：用户实测发现 topic 场景"永远不能取消"，main chat 场景"要等几秒才能取消"。经插件端 monkey-patch `activeRuns.set` / `.delete` 观察，定位到根因：

- `onAccepted` 由 gateway **毫秒级**返回，UI 据此点亮 STOP 按钮
- `setActiveEmbeddedRun`（`attempt.ts:1572`）必须等 attempt.ts 的主循环真正启动才调用——两者之间存在异步准备窗口
- 实测窗口：main chat 暖 workspace ~4 秒；topic 冷启动 10~30 秒+
- 窗口内 `ACTIVE_EMBEDDED_RUNS.get(sessionId)` 返回 undefined → 插件 `coclaw.agent.abort` 返回 `not-found` → UI 静默降级为纯阶段 1 行为（气泡保留但 run 跑完）

详细分析见研究报告 [§6.7](../openclaw-research/agent-run-cancellation.md#67-注册时序accepted--setactiveembeddedrun-空窗期)。

**原阶段 2 设计的盲点**：假定 `onAccepted` 之后 `setActiveEmbeddedRun` 已发生——实际 UI 在空窗期发的 abort RPC 全部 not-found，阶段 2 的"真取消"能力只在用户**延迟点击**时生效。Topic 场景因冷启动更慢，用户在日常体感中"几乎永远点不到窗口内"。

### 需考虑的边界场景

1. **空窗期**：`activeRuns` 尚未注册 sessionId → 当前返回 `not-found`，run 会跑完。**核心场景**。
2. **结束后到达**：run 已 `clearActiveEmbeddedRun` → 也是 `not-found`，但含义"已完成，无需取消"。与空窗期对插件是**同一响应**、对 UX **含义不同**。
3. **网络延迟使 abort 晚到**：与 2 同——但若 run 在路径中间结束，状态变迁瞬间可能踩到空窗期。
4. **`runWithModelFallback` retry**：每次 retry 独立 set/clear，retry 之间 `activeRuns` 短暂为空（通常 ms 级，可忽略）。
5. **用户连续多次点 STOP**：应幂等，后续点击命中时若已在 pending 状态应直接返回 `{ ok: true }`（避免并发重复发 abort）。
6. **WS 闪断 / 插件重载**：pending 表丢失 → 原本在 pending 的 sessionId 再也不会被 abort。需要考虑 TTL 和 UI 端的重试语义。
7. **sessionId 不可知**（chat 模式首条消息、`currentSessionId` 尚未就绪）：UI 跳过 RPC，降级为纯阶段 1——这种情况 race window 问题也**不存在**（根本没发 RPC）。
8. **`/compact` 进行中**：已被 UI 禁用取消，与此 race 无关。
9. **插件 monkey-patch 失败 / OpenClaw 升级换 Map 实现**：方向 2（事件驱动）必须考虑回退到方向 1（轮询）。

### 上游粒度调研结论（2026-04-15，决定状态机粒度）

借 Explore subagent 复核 OpenClaw `runs.ts` / `attempt.ts` / `agent.ts` / `chat.ts` 的源码，确认：

1. **同 sessionId → run 是 1:1**：`ACTIVE_EMBEDDED_RUNS` 是 `Map<sessionId, EmbeddedPiQueueHandle>`，`setActiveEmbeddedRun`（`runs.ts:359`）直接 `.set` 覆盖旧 handle，旧 handle 不被 abort 但后续清理被 `clearActiveEmbeddedRun` 通过 handle 引用比对静默忽略（`runs.ts:387/398`，日志 `reason:run_replaced`）。`reply-run-registry.ts:205-206` 更严格——同 sessionKey 抛 `ReplyRunAlreadyActiveError`。
2. **run 中再发消息行为**取决于 reply queue 模式（`get-reply-run.ts:523-605`）：`interrupt`（abort 旧 + 立即新）/ `steer`/`steer-backlog`（注入当前 run 的 steering 队列）/ `followup`/`collect`（排队）。**任意模式下都不会有"两个 run 并发同一 sid"**。
3. `abortEmbeddedPiRun(sessionId)` 粒度 = 当前 in-flight 的单个 run（`runs.ts:139-154`）。
4. **handle 对象未暴露 `runId`**（`runs.ts:20-27`、`attempt.ts:1548-1562`），插件无法通过 `activeRuns.get(sid)` 反查对应 runId。
5. `chat.abort` 有 runId 级 abort（`chat-abort.ts:76`），但仅覆盖 `chat.send`，对 CoClaw 走的 `agent()` RPC **无效**。

**对方案的影响**：维持 sid 粒度协调，不做 `sid + runId` 细化（OpenClaw 也未提供入口）。queue 模式下 run A→B 转换时，A 的 `lifecycle:end` 到达 → UI 清除协调状态 → B 启动后无残留意图，自然不会被误 abort。

### 已实施方案：UI 主导 + 插件无状态

**核心原则**：谁能看到完整终止信号（accepted / lifecycle:end / completion / 用户操作），谁就该做决策。UI 是唯一同时持有这些信号的地方；插件只是"执行点"——能 abort 就 abort，不能就汇报失败。

#### 插件侧（`plugins/openclaw`）

- `coclaw.agent.abort` 单次同步查询：hit → `{ok:true}`；miss → `{ok:false, reason:'not-found'}`；shape 异常 → `{ok:false, reason:'not-supported'}`。**完全无状态**——不维护 pending 表、不轮询、不广播事件。
- 诊断 patch（`installAbortRegistryDiag`）从 `/* c8 ignore */` 临时代码**产品化**：保留 `activeRuns` / `sessionIdsByKey` / `replyRunRegistry.activeRunsByKey` / `replyRunRegistry.activeKeysBySessionId` 四个 Map 的 `.set` / `.delete` / `.clear` 拦截 + `logger.info` 输出。这一直作为 OpenClaw 侧门契约的"早期警报"——某天 `installed=` 列表少一项或 `abort.patch-failed` 出现，说明上游升级改了内部结构，需要适配。
- **remoteLog 触点**（`plugins/openclaw/src/remote-log.js`）：
  - `abort.patch installed=<csv> missing=<csv>` —— 启动时 patch 完成
  - `abort.patch-failed reason=<>` —— patch 抛异常
  - `abort.request sid=<>` —— 收到取消 RPC
  - `abort.success sid=<>` —— hit 且 `handle.abort()` 完成
  - `abort.not-supported sid=<>` —— 侧门缺失或 handle shape 变化（契约变更信号）

#### UI 侧（`ui/src/stores/chat.store.js`）

- 新增 state `__cancelling: { sid, promise, resolve, tickTimer, tickSeq } | null`
- 新增 getter `isCancelling`（返回 `!!__cancelling`）
- `cancelSend` accepted 分支重写：建立协调状态后委托 `__startCancelCoordination(sid, conn)`，按 `CANCEL_TICK_MS = 500` 间隔重试 RPC，**无 TTL**（生命期等于 run 生命期，由下列任一信号终止）：
  - RPC 返回 `ok=true` → resolve `{ ok: true, aborted: 'immediate' }`
  - RPC 返回 `not-supported` → resolve `{ ok: false, reason: 'not-supported' }`（静默降级）
  - 每次 tick 开头检查 `agentRunsStore.isRunning(runKey)`；为 false（lifecycle:end / completion frame / reconcileAfterLoad 任一路径触发）→ resolve `{ ok: false, reason: 'run-ended' }`
  - `sendMessage` / `sendSlashCommand` 入口调 `__clearCancelling('superseded')` → resolve `{ ok: false, reason: 'superseded' }`（用户发起新交互，旧取消意图被自身超越）
  - 其它响应（`not-found` / `abort-threw` / RPC reject）→ 调度 500ms 后下一次 tick
- 幂等：`cancelSend` 二次调用直接返回同一 promise（按钮已被 `cancelDisabled` 禁用，仍保留防御）
- `cleanup()` 同步清理 `__cancelling.tickTimer` 防止页面离开后继续重试
- `__clearCancelling(reason)` 统一终止入口：resolve 现有 promise 并清 tickTimer，供"新 send 超越旧取消"等场景调用
- **UI 关键日志**（`console.info`）：cancelSend 入口、immediate / not-supported / run-ended 终态；重试 miss 用 `console.debug`
- **UI remoteLog**：`cancel.start sid=<>` / `cancel.immediate sid=<> ticks=<>` / `cancel.not-supported sid=<>` / `cancel.run-ended sid=<>`

#### `ChatPage.vue`

- `cancel-disabled` prop = `__slashCommandType || isCancelling`——用户点击 STOP 后按钮立刻禁用，直到 run 结束
- `onCancelSend` 简化：终态剩 `immediate` / `not-supported` / `run-ended` / `superseded`，仅 `not-supported` notify warning，其余静默
- 删除阶段 2 的 `abort-threw` / `not-found` / `rpc-error` 处理（新状态机内部消化重试）

### 边界场景实际处理

| # | 场景 | 处理 |
|---|---|---|
| 1 | 空窗期 | tick 重试直到 setActiveEmbeddedRun 发生 → hit |
| 2 | run 已结束（abort 晚到 / 网络延迟） | 下一次 tick 检查 isRunning=false → run-ended，已 in-flight 的 RPC 到插件返回 miss，无副作用 |
| 3 | OpenClaw 永不注册（版本变更）| RPC 始终返回 `not-supported`（patch 失败 / shape 变 → abortAgentRun 触发 not-supported 分支）→ 立即终止 |
| 4 | retry 之间短空窗 | tick 自然处理（继续重试） |
| 5 | 用户连续多点 STOP | 第二次 cancelSend 返回同一 promise（按钮亦已禁用） |
| 6 | WS 闪断 | RPC reject → tick 继续重试，连接恢复后下次 RPC 命中或自然 run-ended |
| 7 | sid 不可知（chat 模式首条 chat.history 未返回） | 跳过 RPC，cancelSend 返回 null，降级为纯阶段 1 行为 |
| 8 | `/compact` 进行中 | UI 已禁用按钮，cancelSend 不会被调用 |
| 9 | run A→B（queue 模式 followup/interrupt）| A 的 lifecycle 过渡态下 tick 仍可能看到 isRunning=true；依赖 `sendMessage` 入口的 `__clearCancelling('superseded')` 强制终止旧协调，B 启动时无残留 |
| 10 | 同 sessionId 复用（chat 同 session 多次 send） | `sendMessage` / `sendSlashCommand` 入口即调 `__clearCancelling('superseded')`——否则旧 tick 在 ACTIVE_EMBEDDED_RUNS 命中新 run handle 时会误 abort（已修复，见 deep-review 发现）|

### 测试覆盖

**单元（vitest）**：`ui/src/stores/chat.store.test.js > useChatStore > cancelSend` 19 个 case，含：
- 未 accepted 取消（pre-acceptance）
- 已 accepted 取消进入 settling(cancel)
- chat 模式 sessionId 退回 currentSessionId
- sid/conn 不可用降级
- 所有终态：immediate / not-supported / run-ended
- 重试链：miss → miss → hit
- RPC reject → 重试 → run-ended
- 幂等（双击）：返回同一 promise
- cleanup() 清理 tickTimer
- remoteLog 触点验证（mock 捕获）

**插件单元**：`plugins/openclaw/src/agent-abort.test.js` + `plugins/openclaw/index.test.js`，覆盖：
- `installAbortRegistryDiag` 全部 4 个 Map 安装 / 部分 missing / shape 异常 / 已 patch 幂等
- patchMapLogging 的 `.set`/`.delete`/`.clear` 拦截
- key 序列化（含 JSON 抛异常 fallback）
- 不可 patch 的 Map（缺 `.delete`）走 missing
- abortAgentRun 的 not-found diag dump（含 reply registry 完整快照、各种缺失分支）
- coclaw.agent.abort handler 的 invalid-sid / not-supported / hit / miss 路径
- handler 自身 catch 分支（respond throw）
- 5 条 remoteLog 触点的实际触发

**手动集成**：留待 deep-review 后人工验证（topic 冷启 / chat 暖启动两种场景）。

### 当前局限 & 下一步

- **方案 5（上游新 API）**：最干净的方案是等上游 #66531 / #66532 合并，UI 直调 `agent.abort` 用 runId（onAccepted 帧返回的）、插件去侧门。短期内还要靠当前实现。
- **diag 日志频率**：每条用户消息触发 4 个 Map 各 1 次 `.set` + 1 次 `.delete` = 8 行 logger.info。仅本地 logger，不上 remoteLog，可接受；若实际负载下显得吵闹，再降级为 `logger.debug`。
- **i18n 清理**：阶段 2 的 `chat.cancelAbortFailed` 已从 12 种语言文件全删（deep-review 收尾——新契约下 `abort-threw` / `not-found` / `rpc-error` 都被 tick 内部消化，UI 不再暴露这些 reason）；保留 `chat.cancelNotSupported` + `chat.upgradeOpenClawHint` 用于 `not-supported` 终态的 notify。

### 实施提交

- 单一 commit（pending）：`fix(ui,plugin): UI-led cancel coordination + plugin diag patch productionalization`

---

## 阶段 3：上游 issues（长期去侧门化）

### 四条上游 issue（已提交）

基于 OpenClaw `v2026.4.14-beta.1+69`（commit `d7cc6f7643`）再校验后的改动范围。CoClaw 仅提交 issue，由 OpenClaw 维护者决定是否/何时实现；合并前保留阶段 2 的侧门 workaround。

| # | GitHub issue | 主题 | 类型 | 改动范围（建议修复要点） | CoClaw 受益 |
|---|---|---|---|---|---|
| 3a | [#66531](https://github.com/openclaw/openclaw/issues/66531) | 新增 `agent.abort` RPC | Feature | `src/gateway/server-methods/agent.ts`（新增 `"agent.abort"` handler，当前 `agentHandlers` 只有 `"agent"` / `"agent.identity.get"` / `"agent.wait"`）+ `src/gateway/protocol/schema/agent.ts` 新增 `AgentAbortParamsSchema` + tests（~150 行） | UI 可直调 `agent.abort`，插件 RPC 降为 fallback |
| 3b | [#66532](https://github.com/openclaw/openclaw/issues/66532) | `api.runtime.agent` 暴露 abort 家族 | Feature | `src/plugins/runtime/runtime-embedded-pi.runtime.ts`（现仅 export `runEmbeddedAgent`/`runEmbeddedPiAgent`，需加 `abortEmbeddedPiRun` / `waitForEmbeddedPiRunEnd` / `isEmbeddedPiRunActive` / `queueEmbeddedPiMessage`）+ `src/plugins/runtime/types-core.ts:49-73` 的 `PluginRuntimeCore["agent"]` 声明（~10 行增量） | 插件去侧门，改用 `api.runtime.agent.abortEmbeddedPiRun(...)` |
| 3c | [#66534](https://github.com/openclaw/openclaw/issues/66534) | `lifecycle:end` 带 `aborted` / `stopReason` | Bug | `src/agents/pi-embedded-subscribe.handlers.lifecycle.ts` 的 `handleAgentEnd` emit（当前 L130-148）新增字段；`agent-command.ts:919-934` 已有这两个字段可作为参考（~20 行） | UI 直接从事件区分 abort vs 完成，不再依赖 completion frame |
| 3d | [#66535](https://github.com/openclaw/openclaw/issues/66535) | `/compact` 可取消 | Bug | `src/auto-reply/reply/commands-compact.ts`（当前约 L72-145 调 `compactEmbeddedPiSession` 未传 `abortSignal` 未注册 registry）—— `CompactEmbeddedPiSessionParams.abortSignal` 类型已预留（`compact.types.ts:56`），**实际改动仅需补传参 + 注册 `ACTIVE_EMBEDDED_RUNS`**，比原估小 | UI 解除 `/compact` 取消禁用 |

### 提交策略

- 3a + 3b 同批提交（基础设施，互相独立但服务同一目标）—— ✅ 已作为 #66531 / #66532 提交（2026-04-14）
- 3c + 3d 作为后续改进 —— ✅ 已作为 #66534 / #66535 提交（同日）
- 每个 issue 合并后，CoClaw 侧按下方"适配路径"表渐进迁移

### CoClaw 侧适配路径

```
现状
  ↓ 阶段 1 完成
用户消息不消逝（全版本）
  ↓ 阶段 2 完成
真正取消（侧门支持的 OpenClaw 版本生效；其他版本静默降级）
  ↓ 上游 3a 合并
UI 直调 agent.abort；插件 RPC 保留 fallback（支持更旧版本）
  ↓ 上游 3b 合并
插件用 api.runtime.agent.abortEmbeddedPiRun；侧门保留 fallback（兼容未合并版本）
  ↓ 上游 3c 合并
UI 从 lifecycle:end 区分 abort；弃用 result.aborted 依赖
  ↓ 上游 3d 合并
UI 解除 /compact 取消禁用
```

---

## 实施顺序建议

1. ✅ 阶段 1：前端 settling(cancel) 过渡态修复（单一 PR，commits `5d3d97e` + `2bd7f3a`）
2. ✅ 阶段 2.1-2.2：插件 `agent-abort.js` + `coclaw.agent.abort` RPC（commit `3d21a5e`）
3. ✅ 阶段 2.3-2.5：UI 集成 RPC + `/compact` 禁用（commit `17cc790`）
4. ✅ 阶段 2.5：UI 主导的 cancel 协调状态机（500ms 重试，无 TTL）+ 插件 patch 产品化 + remoteLog 触点（2026-04-15）
5. ✅ 阶段 3：通过 `openclaw-issue` skill 提交 4 条上游 issue —— #66531 / #66532（feature）、#66534 / #66535（bug），2026-04-14
6. ⏳ 逐步迁移：等待上游合并后按下方"适配路径"表渐进迁移（定期通过 `openclaw-issue` skill 的"定期跟进"流程检查状态）

---

## 附：关键文件索引

### CoClaw 端（本仓库）

- `ui/src/stores/chat.store.js:662-691` — `cancelSend`（阶段 1 主战场）
- `ui/src/stores/agent-runs.store.js:121-128` — `settle`；`:157-168` — `__settleWithTransition`（需暴露）
- `ui/src/stores/chat.store.js:693-848` — `sendSlashCommand` + `__onChatEvent`（阶段 2.4 `/compact` 禁用位点的参考）
- `plugins/openclaw/index.js` — 插件入口（阶段 2.2 注册 RPC）
- `plugins/openclaw/package.json` — 无 OpenClaw 版本 pin（阶段 2 feature detection 必需）

### OpenClaw 端（仅参考，不修改）

完整索引见 [`docs/openclaw-research/agent-run-cancellation.md`](../openclaw-research/agent-run-cancellation.md) 末尾的"参考文件索引"章节。阶段 3 上游 PR 的改动位点均在调研报告中给出。
