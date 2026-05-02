# Agent Run 取消：分阶段实施方案

> **状态**：阶段 1、2、2.5、2.6、2.7、2.8 已完成；阶段 3 上游 issues 已提交（#66531 / #66532 / #66534 / #66535，2026-04-14），等待维护者反馈；合并后按末尾"CoClaw 侧适配路径"表渐进迁移
> **创建时间**：2026-04-14
> 阶段 1 commits：`5d3d97e` docs + `2bd7f3a` fix(ui)
> 阶段 2 commits：`3d21a5e` feat(plugin) + `17cc790` feat(ui)
> 阶段 2.5：UI 主导的 cancel 协调状态机（500ms 重试无 TTL）+ 插件诊断 patch 产品化 + remoteLog 触点（2026-04-15 实施完成）
> 阶段 2.6：pre-accept 窗口点取消的"假取消"bug 修复——挂起取消意图 + onAccepted 转交 accepted 分支（2026-04-17）
> 阶段 2.7：UI 容错强化 round 2——gone / not-supported 分支 try/catch + cancelGoneHint 文案修正（2026-05-02 commit `2ed71c7`）
> 阶段 2.8：plugin 启发式 gone fallback——侧门返 not-found 时按双时长闸门升格 gone（2026-05-02 commit `e0b4212`）
> **调研依据**：[`docs/openclaw-research/agent-run-cancellation.md`](../openclaw-research/agent-run-cancellation.md)（见 §6.7 注册时序空窗期）
> **上游遗留问题**：[`docs/openclaw-upstream-issues.md`](../openclaw-upstream-issues.md) "待提交：Agent Run 取消相关"章节

## 背景（3 行摘要）

当前 `cancelSend` 立即销毁前端 streamingMsgs，导致 main-agent-chat / topic 的用户气泡消逝；且 OpenClaw 底层 agent run 仍在跑，完成后结果不刷新。根因是 `cancelSend` 用了 `settle()` 硬清理、**且没有向服务端发真正的取消信号**——而 OpenClaw 上游既无 `agent.abort` RPC 也未在 `api.runtime.agent` 暴露 abort 接口。唯一的底层真取消能力是 `abortEmbeddedPiRun(sessionId)`，可通过 `globalThis[Symbol.for("openclaw.embeddedRunState")]` 侧门访问（自 OpenClaw `v2026.3.12` 起可用）。

## 取消的双重身份（重要）

随着方案推进，取消逐渐承担了**两个不同性质的职责**，本文档后续阶段都建立在这个认知上：

1. **用户特性**（阶段 1 / 2 / 2.5 / 2.6 / 2.7 的主要动机）——用户点 STOP 想终止当前 agent run，UI + plugin 协同发真终止信号、清状态、给反馈。
2. **"假跑"兜底**（阶段 2.8 的核心动机）——所谓"假跑"，指 UI 以为 run 还在跑（按钮显 STOP / 气泡显示思考中 / `isRunning(runKey)` 为 true），但**实际后端这个 run 已经结束 / 丢失 / 从来没注册成功**，UI 永远等不到 `lifecycle:end` 把它解开。这种状态下用户能感知到的唯一动作就是"点 STOP"——所以取消通道也成了假跑的最终救援路径。

阶段 2.8 引入的"启发式 gone fallback"就是这个第二职责的产物：plugin 端在侧门返 `not-found` 且 UI 等得够久时，主动把响应升格为 `gone`，让 UI 强制 settle 当前 run、把按钮还给用户。这种升格**是有意接受误判的**——宁可让一个其实还活着的 run 在后台跑完再被 ended guard 静默吃掉，也不要让用户卡在假跑里出不来。

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

## 阶段 2.6：pre-accept 窗口点取消的"假取消"bug 修复

### 症状

用户在 chat/topic 里点发送后、服务端回 accepted 之前（pre-accept 窗口）点 STOP：本地气泡瞬间消失看起来取消成功，但服务端的 agent run 实际会跑到底——几秒后气泡又冒出来、LLM 继续思考并流式输出到自然结束。

### 根因

- 原阶段 1 的 `cancelSend` **未 accepted 分支**走 reject `__cancelReject(USER_CANCELLED)` + `__cleanupStreaming` 清本地——只销毁 UI 不触达服务端；
- `agent()` RPC 没有"发送后取消"原语（`chat.abort` 只覆盖 `chat.send` 路径），前端无法撤回已发出的请求；
- server 后续仍会回 accepted 帧 → `runAgent` 的 onAccepted 里 `register` 把 run 挂进 agent-runs.store → `streamingMsgs` 引用原 `optimisticMsgs`（未被清理，仍在内存），通过 `allMessages` getter 重新混入消息列表；
- 原 `runPromise.then` 挂钩仍在等 run 自然结束（几秒到几分钟），完成后才 `loadMessages + dropRun`——期间 UI 表现为"气泡复活、agent 思考、完整回答"。

### 为什么不选"accepted 前直接禁用 STOP 按钮"

该方案最简单，但违反用户直觉——topic 冷启动要 10-30 秒，按钮显示可点却拒绝响应会更糟。用户发送后想反悔是合理诉求，系统应当接收而非拒绝。

### 方案：挂起取消意图 + onAccepted 转交

**核心思路**：pre-accept 点 STOP 时不假装取消，而是记录"用户想取消这次发送"的意图，让 STOP 按钮转"取消中"禁用态；等 onAccepted 到达后立刻转交已有的 accepted 分支协调流程，由 `coclaw.agent.abort` 轮询真正终止 run。

### 变更清单

#### 2.6.1 `ui/src/stores/chat.store.js`

- 新增 state `__pendingCancelIntent: false`
- `isCancelling` getter 改为 `!!this.__cancelling || this.__pendingCancelIntent`——覆盖两阶段
- `cancelSend()` pre-accept 分支拆两档：
  - **仍在上传**（`__uploadHandle` 存在）→ 只 cancel upload handle；其余由 sendMessage 的 CANCELLED catch 分支清理，行为不变
  - **上传完、RPC 在飞** → `__pendingCancelIntent = true` + remoteLog `cancel.intent` + 返回 null；不 reject `__cancelReject`、不清本地、不改 sending
- `sendMessage` 的 `onAccepted` 回调末尾：若 `__pendingCancelIntent=true`，清意图 + remoteLog `cancel.handoff` + 立刻再调 `this.cancelSend()`（此时 `__accepted=true` 走 accepted 分支）
- 多路清意图：
  - `sendMessage` catch 块顶部（发送以任何形式终结都丢弃意图）
  - `__clearCancelling(reason)` 顶部（覆盖 sendMessage / sendSlashCommand 开头的 superseded 场景）
  - `cleanup()`（页面卸载）

### 关键决策

1. **为什么不复用 `__cancelReject`/`__cancelling`**：语义不同。`__cancelReject` 代表"RPC 在飞的 reject 句柄"；`__cancelling` 是 accepted 后协调任务（含 sid/promise/tickTimer）。pre-accept 意图是独立的短命中间状态，用独立 boolean 最清晰。
2. **handoff 为何在 `onAccepted` 回调末尾而非 `agent-runs.store` 里**：意图是 UI 层概念，`agent-runs.store` 不应感知。handoff 在 chatStore.onAccepted 里，re-entrant 调用 cancelSend 干净。
3. **runKey 闭包稳定性**：sendMessage 顶部 `const runKey = this.runKey` 捕获；`this.runKey` 依赖 `sessionId`/`clawId`/`chatSessionKey`，都是 Identity 字段（store 创建后不变），无闭包过期风险。

### UX 影响

- **好**：用户点 STOP 不再看到"假成功"，agent 不会偷跑；server 端请求一旦被接纳，CoClaw 立刻发 abort 真终止
- **变**：原"pre-accept 取消 → 草稿自动恢复"语义消失（旧 e2e `chat-cancel-restore.e2e.spec.js` 的 UX 旅程）——这本来是基于"取消成功"假设的衍生体验，真相是消息已发送无法撤回。typo 修正场景用户需等协调完成后重新输入
- **等**：topic 冷启动 10-30 秒的 accepted 窗口，点 STOP 后用户会看见"取消中"spinner 持续到 accepted 到达。最坏 3 分钟由 pre-acceptance timeout 兜底清状态

### 边界场景

| # | 场景 | 行为 |
|---|---|---|
| 1 | pre-accept 挂意图后用户再点 STOP | 幂等：`__pendingCancelIntent` 检查直接返回 null，不重复 remoteLog |
| 2 | pre-accept 挂意图后 cleanup（页面卸载） | 意图清除；`__cancelReject` 以 USER_CANCELLED reject；sendMessage catch 返回 `{accepted:false}`；server 若仍回 accepted，runPromise.then 挂钩仍会执行 dropRun 清理 |
| 3 | pre-accept 挂意图后 pre-acceptance timeout（180s）触发 | catch 清意图；throw PRE_ACCEPTANCE_TIMEOUT；与 B2 同样有 runPromise.then 兜底 |
| 4 | pre-accept 挂意图后 DC 断连触发 retry | catch 清意图 → 递归 sendMessage，新一轮入口 `__clearCancelling('superseded')` 再清意图，双保险 |
| 5 | pre-accept 挂意图后用户发新消息 | `sendMessage` 开头 `__clearCancelling('superseded')` 清意图；旧 sendMessage 在 isSending=true 下早退返回 `{accepted:false}`，不冲突 |
| 6 | onAccepted 迟到（超过 cleanup/timeout 之后） | register 仍会挂 run 到 agent-runs.store，`streamingMsgs` 短暂出现；runPromise.then 仍挂钩 → 等 run 自然结束 → dropRun 清理。与本修复前同类场景一致，不是新泄漏 |

### 测试覆盖

**单元（vitest）** `ui/src/stores/chat.store.test.js > useChatStore > cancelSend`：
- pre-accept RPC 在飞取消：挂意图、保留气泡、sending 不变、isCancelling=true
- pre-accept 挂意图后 cancelSend 幂等：第二次不抛错、标志位保持
- pre-accept 挂意图后 onAccepted 到达：转交 accepted 分支发 abort RPC、run.cancelled=true
- pre-accept 挂意图后 cleanup：意图清除
- pre-accept 挂意图后 __clearCancelling(superseded)：意图清除

**E2E** `ui/e2e/chat-cancel-restore.e2e.spec.js`：改为验证新行为——气泡保留、STOP 按钮转 loader 禁用、`__pendingCancelIntent` 为 true、cleanup 清意图

### 实施提交

- 单一 commit：`fix(ui): pre-accept cancel intent handoff (agent run true cancellation)` + changeset `chat-pre-accept-cancel-handoff.md`

---

## 阶段 2.7：UI 容错强化 + 文案修正（2026-05-02）

### 背景

阶段 2.5 的 cancel 协调状态机里，`gone` / `not-supported` 两个终态分支会调用 `runsStore.settleByCancel(...)` + `getSharedNotifier()?.info/warning(...)` + `i18n.global.t(...)` 三件事，然后才 `resolveFn(...)`。这串调用全部裸在 tick 异步函数体内——任意一个抛异常（注入的 notifier 实现 bug / 未来 i18n 切 strict 模式 / DI 桥未初始化等），后续语句被跳过，**`resolveFn` 永远不被调用，coord promise 永挂**。后果不是单次取消失败那么简单：`cancelSend` 的"幂等返已有 promise"路径（[`chat.store.js:752-754`](../../ui/src/stores/chat.store.js)）会让后续 cancelSend 拿到僵尸 promise，整个会话的取消按钮永久死锁。

同时 deep-review 维度 3 发现 `chat.cancelGoneHint` 文案过强——"the result will appear later" / "结果将稍后显示"暗示自动刷新，但实际 UI 在 gone 路径只触发**一次** `loadMessages`（`__awaitPersistAndDrop`），之后不会自动 refresh。文案与实际行为不符。

### 变更清单

#### 2.7.1 `ui/src/stores/chat.store.js`

`gone` 分支（`:925-949`）和 `not-supported` 分支（`:951-971`）改成：

```
cleanup();                                 // 状态机先清，与异常解耦
try {
  runsStore.settleByCancel(runKey, ...);
  getSharedNotifier()?.info({ title, description });
}
catch (e) {
  console.warn('[chat] cancelSend gone post-settle hook threw:', e?.message);
}
resolveFn({ ok: false, reason: 'gone' }); // 一定调到
return;
```

**关键不变量**：
- `cleanup()` 在 try 之外、`resolveFn` 在 catch 之外——状态机一定先清空、coord promise 一定 resolve；中间副作用是否成功只影响"用户能不能看到 toast"，不影响"取消按钮能否再次点击"
- catch 块**只 console.warn 不 remoteLog**——这是契约容错（理论上不该抛），打到本地 logger 足够诊断；上 remoteLog 反而可能放大影响范围

#### 2.7.2 12 个 i18n locale 的 `chat.cancelGoneHint`

| 旧文案（隐含自动刷新） | 新文案（提示用户主动检查） |
|---|---|
| en: "...the result will appear later." | "If it is still running in the background, you can check back later." |
| zh-CN: "...结果将稍后显示。" | "如仍在后台运行，可稍后回来查看。" |
| zh-TW: "...結果將稍後顯示。" | "如仍在背景執行，可稍後回來查看。" |
| 其余 9 个语言（es / hi / ko / de / vi / pt / ja / fr / ru）同步对齐 | 同语义 |

### 关键决策

1. **为什么 try 外放 cleanup**：状态机里的 `__cancelling` 字段一旦清空，幂等路径就走"建立新协调"分支（不是返回旧 promise）。即使 settle/notify 抛、resolveFn 仍 resolve，外层 coord promise 的消费者最坏拿到一个 stale 的 ok=false 结果，不会卡死。
2. **为什么 catch 只 console.warn 不抛 / 不 remoteLog**：抛会 propagate 回 tick 异步链路，与"resolveFn 一定调到"的契约自相矛盾；remoteLog 在生产侧 nuxt useNotify / vue-i18n 默认不抛的前提下应当几乎不触发，频繁 remoteLog 反而是噪音。
3. **为什么不延伸到 `immediate` / `run-ended` 分支**：这两个分支没有 notify 调用（`immediate` 只 console.info + remoteLog；`run-ended` 同），抛点窗口只有 `cleanup` 自身——`cleanup` 是同步赋值 null + clearTimeout，不会抛。

### TDD 复现

P1 复现测试（`ui/src/stores/chat.store.test.js` 内）：mock `notifier.info` 抛 `Error('toast crash')` → 触发 gone 分支 → 在挂 `process.on('unhandledRejection')` 隔离的环境下断言 coord promise 仍 resolve、`outcome.reason === 'gone'`。S1 场景测试：gone settle 后立刻新 sendMessage 不被破坏（关键技巧：阻塞 `sessions.get` 让 `__awaitPersistAndDrop` 中的 loadMessages 不完成，验证 register 内部 `__cleanupRun(oldRunId, 'superseded')` 路径能接管清理）。

### 实施提交

- 单一 commit `2ed71c7`：`fix(ui): harden cancel coordination notify hooks and soften gone hint`
- changeset `cancel-heuristic-ui-r2.md`（patch 级）

---

## 阶段 2.8：plugin 启发式 gone fallback（2026-05-02）

### 背景：取消作为"假跑"兜底

本阶段的定位是**取消的第二职责**——参见文档头部"取消的双重身份"小节。当 run 实际已经结束 / 丢失 / 从未注册成功，但 UI 收不到 `lifecycle:end`，会卡在"假跑"状态里：按钮显 STOP、`isRunning(runKey)` 为 true、用户除了点 STOP 没有其它动作可做。可问题是——侧门 abort 这一刻也是 `not-found`（因为 run 在 `activeRuns` 里本来就没有），UI 拿到 `not-found` 后按阶段 2.5 的设计是"继续 500ms tick 等"，**于是用户的 STOP 也卡在等里头**。需要一个机制让 plugin 在合适时机告诉 UI"别等了，这个 run 大概率已经死了"。

假跑的几条产生路径：

- 上游 `lifecycle:end` 在某些边界场景（compaction-retry / model-fallback）会 emit 多次，UI 不能凭它一次性判终态——需要配合 `agent.wait` 才能确认；如果配合的请求没送到 / 没回来，UI 就停在那
- DC 闪断 / 网络丢包让 completion frame / lifecycle:end 没送达
- `agent.wait` 内部有两套有限 TTL 的状态簿（活跃 5min / 已完成 10min），超时被驱逐后 `wait(0)` 与"run 还在跑"返回的形态难以区分

阶段 2.7 解决的是"settle 自身炸"（异常路径），本阶段解决的是"settle 永远等不到"（信号缺失）。两者一起把"用户点 STOP 后协调流程能走到终点"这个契约补完整。

### 设计要点

**核心思路**：plugin 端有一个独立观察角度——侧门 `activeRuns.get(sid)` 返 undefined 的"miss"包含两层语义：
1. 注册空窗（合法 not-found）：UI 应继续 tick
2. run 实际已结束/丢失但终态未送达 UI（病态 not-found）：UI 应主动收尾

单凭 plugin 自己看不出区别。但 UI 知道两个有用的墙钟时长：

- `runDuration`：从 `onAccepted` 到现在
- `abortDuration`：从首次 STOP 到现在

UI 把这两个时长**透传**给 plugin，plugin 用"双闸"启发判定：`runDuration ≥ 3min && abortDuration ≥ 1min` 且侧门返 not-found 时，把响应**升格为 `gone`**——告知 UI 主动 settleByCancel + 提示用户。

阈值偏保守，宁可让 UI 多 tick 几次也不误升格。

### 决策节点

1. ✅ **协议增量字段放在 RPC params，不放 channel 元数据**：`coclaw.agent.abort` 加 `runDuration` / `abortDuration`，对旧 plugin 无副作用（多余字段被忽略），对旧 UI 也无副作用（不发即 plugin 看到 undefined）。
2. ✅ **judgment 逻辑放 plugin 端不放 UI 端**：UI 已经在做协调状态机的复杂工作，再加阈值判定会让状态机膨胀；plugin 拿到全部信号后用纯函数决策更内聚。
3. ✅ **阈值常量硬编码不暴露配置**：3min / 1min 是基于 OpenClaw 当前观察 + 保守 buffer 选定，调阈值需要仔细的工程判断，不应通过插件 config 让用户随意调。后续如有强需求再按阶段 4 处理。
4. ✅ **判定逻辑提取成独立纯函数**：`agent-cancel-heuristic.js` 单独成模块，零 I/O 零 side effect，便于单测覆盖判定矩阵的每一个 case。
5. ✅ **handler 端做 `typeof === 'number'` 归一化、heuristic 内做 `Number.isFinite` 拒收**：双层职责不重叠——handler 把 string/null 归一化为 undefined（避免 remoteLog 字符串里出现 `runDur=null`），heuristic 拒收 NaN/Infinity（即使 caller 直传也不误升格）。

### 变更清单

#### 2.8.1 新文件 `plugins/openclaw/src/agent-cancel-heuristic.js`

```
export const RUN_DURATION_GONE_THRESHOLD_MS = 3 * 60 * 1000;
export const ABORT_DURATION_GONE_THRESHOLD_MS = 60 * 1000;

export function decideCancelResponse(abortResult, ctx) {
  if (abortResult.ok) return abortResult;                  // 透传 ok=true
  if (abortResult.reason !== 'not-found') return abortResult; // 透传 not-supported / abort-threw 等
  const runHit   = ...&& runDur   >= RUN_DURATION_GONE_THRESHOLD_MS;
  const abortHit = ...&& abortDur >= ABORT_DURATION_GONE_THRESHOLD_MS;
  if (runHit && abortHit) return { ok: false, reason: 'gone' }; // 升格
  return abortResult;                                       // 透传 not-found
}
```

#### 2.8.2 `plugins/openclaw/index.js` `coclaw.agent.abort` handler

```
const abortResult = abortAgentRun(sessionId);
const runDuration   = typeof params?.runDuration   === 'number' ? params.runDuration   : undefined;
const abortDuration = typeof params?.abortDuration === 'number' ? params.abortDuration : undefined;
const result = decideCancelResponse(abortResult, { runDuration, abortDuration });
// ...既有 logger.info / abort.success / abort.not-supported 触点保留
else if (result.reason === 'gone') {
  remoteLog(`abort.gone sid=${sessionId} runDur=${runDuration} abortDur=${abortDuration}`);
}
respond(true, result);
```

#### 2.8.3 UI 侧已有支持（阶段 2.5/2.6 落地时已就位）

- `ui/src/stores/chat.store.js:888-894` — tick 内每次实算 `now - acceptedAt` / `now - startedAt` 透传
- `ui/src/stores/chat.store.js:925-949` — `gone` 分支已在阶段 2.5 实现（含阶段 2.7 的 try/catch 容错）

### 判定矩阵

| `abortResult.ok` | `abortResult.reason` | runDur ≥ 3min | abortDur ≥ 1min | 输出 |
|---|---|---|---|---|
| true | — | — | — | `{ok:true}` |
| false | `not-supported` | — | — | `{ok:false, reason:'not-supported'}` |
| false | `not-found` | ✓ | ✓ | `{ok:false, reason:'gone'}`（升格） |
| false | `not-found` | 其它任意组合（含 undefined）| | `{ok:false, reason:'not-found'}`（保持） |
| false | `abort-threw` | — | — | `{ok:false, reason:'abort-threw', error}`（透传，不参与启发） |

### 协议向后兼容

- **新 plugin + 旧 UI**：UI 不发 `runDuration` / `abortDuration` → handler `typeof === 'number'` 都不命中 → ctx 字段全 undefined → heuristic 双闸永远不命中 → 保持透传 `not-found`，行为与升级前完全一致
- **旧 plugin + 新 UI**：UI 多发的两个字段被旧 plugin 忽略 → 旧 plugin 仍只调 `abortAgentRun` 直接 `respond(true, result)` → UI 收到 `not-found` 继续 tick，无任何 throw / 协议错配

### 边界场景

| # | 场景 | 处理 |
|---|---|---|
| 1 | 用户取消 short-running run（< 3min） | runDuration 永远 < 3min，永远不升格——必须等真终态信号或自然 run-ended |
| 2 | 用户取消 long-running run，侧门正常 hit | RPC 返回 ok=true，根本不进 not-found 分支，与启发无关 |
| 3 | run 跑超 3min，UI 刚点 STOP | abortDuration 远 < 1min，单闸不命中，保持 not-found 继续 tick |
| 4 | run 跑超 3min + STOP 等超 1min + 侧门仍 not-found | 双闸命中，升格 gone，UI 主动 settleByCancel |
| 5 | run 实际已结束但 UI tick 还没看到 isRunning=false | 双闸条件如满足则升格 gone（误判），UI settle 后续 lifecycle:end 到达被 ended guard 静默吃掉，无副作用 |
| 6 | 旧 UI 不传 duration | 永远 not-found，行为退化为阶段 2.5 |
| 7 | UI 误传字符串 / null / NaN / Infinity | handler typeof + heuristic isFinite 双层守卫归一化为 undefined，永远不升格 |

### 关键设计决策

1. **为什么阈值不开放配置**：阈值是基于 OpenClaw `lifecycle:end` 的 5min TTL（`agent.wait` 内部）反推的——3min run + 1min abort 等于 4min wall-clock，留 1min 余量给"边界 race"。开放配置会让用户调到不安全区间，带来更多 false-positive。
2. **为什么 abort-threw 不参与启发**：`abort-threw` 是侧门真的炸了（OpenClaw 内部状态损坏），UI 应当原样收到 reason 后继续 tick 重试——这与 not-found 的"信息不足"语义不同。
3. **`not-found` 升格为 `gone` 是有意的"误判允许"**：双闸是基于墙钟时间的启发，原理上无法 100% 分辨"还在跑"vs"已结束"。允许误判的成本：UI settle 一个其实还在后台跑的 run，气泡进入"已完成"状态；后续 server 若仍把 lifecycle:end 送到 UI，被 `__dispatch` 入口的 ended guard 静默吃掉。**用户感知是"取消生效"——不是"取消失败 + 神秘后台跑完"。**
4. **handler 升格 gone 时打 remoteLog**：单次取消最多触发一次（升格后 UI cleanup 退出 tick），不会形成洪水；同时是"启发判定准确性"的关键诊断信号。

### 测试覆盖

**插件单元** `plugins/openclaw/src/agent-cancel-heuristic.test.js`（13 个 case）：
- 阈值常量值断言
- ok 透传 / not-supported 透传 / abort-threw 透传（含 error 字段）
- not-found 双闸都达 → 升格 gone
- not-found 单闸命中（两个方向各一）→ 保持 not-found
- not-found 双闸都未达 → 保持 not-found
- 旧 UI ctx 缺 duration / ctx 完全缺失 → 保持 not-found
- 非数字 duration（string / null / NaN / Infinity）→ 保持 not-found

**插件集成** `plugins/openclaw/index.test.js`（5 个新 case）：
- 双闸都达升格 gone（payload + abort.gone remoteLog + logger.info 三重断言）
- 单闸命中保持 not-found（payload + remoteLog 静默）
- 旧 UI 不传 duration（payload + remoteLog 静默）
- 非数字 duration 处理（payload + remoteLog 不出现脏字面值）
- **多 tick 进展场景**：同一 sessionId 顺序发 4 个 tick，前 3 双闸未达保持 not-found（plugin 静默），第 4 个双闸达升格 gone（打 1 条 abort.gone）——验证生产中真实的 cancel 旅程

**总覆盖率**：plugin 工作区 lines/funcs/stmts 100%、branches ≥95%；新模块 100/100/100/100。

### deep-review 摘要

4 路并行（3 路 codex-rescue + 1 路 opus 接替失败维度），结论：
- **真问题 1**（codex 测试场景维度）：缺 multi-tick 进展场景测试 → 已补
- **真问题 2**（codex 综合维度）：handler 对 `abort-threw` 每次 500ms tick 都打 logger.info，违反噪音控制 → 核实为 pre-existing（阶段 2.5 的 logger 判定逻辑就有），按 deep-review skill 记入 `plugins/openclaw/TODO.md` 不在本阶段修
- **opus 接替维度**：双层 number 守卫（handler typeof + heuristic isFinite）核实为有意分工不冗余；handler try/catch 兜底完整无新引入异常路径
- **未采纳**的建议：`above-threshold` 测试（分支覆盖性质）、mirror one-gate handler 集成测试（heuristic 单元测试已覆盖两个方向）、`runDur` → `runDurMs` 字段命名（与 UI 侧 `cancel.gone` 对称，cosmetic 不在本轮范围）

### 实施提交

- 单一 commit `e0b4212`：`feat(plugin): heuristic gone fallback for coclaw.agent.abort`
- changeset `cancel-heuristic-plugin.md`（minor 级——新增能力 + 新增协议字段语义）
- 预存问题 TODO 条目：`plugins/openclaw/TODO.md` "coclaw.agent.abort 对 abort-threw 每 tick 都打 logger.info（噪音，预存）"

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
5. ✅ 阶段 2.6：pre-accept 取消假取消修复——挂意图 + onAccepted 转交（2026-04-17）
6. ✅ 阶段 2.7：UI 容错强化 round 2——gone / not-supported 分支 try/catch + cancelGoneHint 文案修正（2026-05-02 commit `2ed71c7`）
7. ✅ 阶段 2.8：plugin 启发式 gone fallback——双时长闸门把 not-found 升格 gone（2026-05-02 commit `e0b4212`）
8. ✅ 阶段 3：通过 `openclaw-issue` skill 提交 4 条上游 issue —— #66531 / #66532（feature）、#66534 / #66535（bug），2026-04-14
9. ⏳ 逐步迁移：等待上游合并后按下方"适配路径"表渐进迁移（定期通过 `openclaw-issue` skill 的"定期跟进"流程检查状态）

---

## 附：关键文件索引

### CoClaw 端（本仓库）

- `ui/src/stores/chat.store.js` — `cancelSend` + `__startCancelCoordination` + `gone` / `not-supported` 终态分支（阶段 1 / 2.5 / 2.7 主战场，行号随重构变动以代码为准）
- `ui/src/stores/agent-runs.store.js` — `settle` / `settleByCancel` / `__settleWithTransition`（settle/transition API）
- `ui/src/i18n/locales/*.js` — `chat.cancelGone` + `chat.cancelGoneHint` + `chat.cancelNotSupported` + `chat.upgradeOpenClawHint`（阶段 2.7 文案修正后语义为"check back later"）
- `plugins/openclaw/index.js` — 插件入口 + `coclaw.agent.abort` handler（阶段 2.2 / 2.8）
- `plugins/openclaw/src/agent-abort.js` — 侧门 abort 实际入口（阶段 2.1）
- `plugins/openclaw/src/agent-cancel-heuristic.js` — 启发判定纯函数 + 阈值常量（阶段 2.8 新增）
- `plugins/openclaw/package.json` — 无 OpenClaw 版本 pin（阶段 2 feature detection 必需）

### OpenClaw 端（仅参考，不修改）

完整索引见 [`docs/openclaw-research/agent-run-cancellation.md`](../openclaw-research/agent-run-cancellation.md) 末尾的"参考文件索引"章节。阶段 3 上游 PR 的改动位点均在调研报告中给出。
