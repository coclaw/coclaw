# Agent Run 取消：分阶段实施方案

> **状态**：阶段 1 已完成（commits `5d3d97e` docs + `2bd7f3a` fix(ui)），阶段 2 待启动（2026-04-14）
> **创建时间**：2026-04-14
> **调研依据**：[`docs/openclaw-research/agent-run-cancellation.md`](../openclaw-research/agent-run-cancellation.md)
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

1. ✅ **阶段 1 `cancelSend` 新语义**：改为"保留气泡不消逝、保留 streamingMsgs、让原 RPC 自然完成"，**不额外解锁输入**——因 `isSending = sending || isRunning(runKey)` 而 `isRunning` 判 `!run.settled`（`settling=true` 时仍为 true），阶段 1 下用户在取消后依然被输入框守卫禁用，这是预期行为。真正"取消 → 立即解锁"在阶段 2 生效（真 abort → `lifecycle:end` 快速到达 → `completeSettle` → `isRunning=false`）。
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

### 产出

PR 1（patch，影响用户可见行为）：
> `fix(ui): preserve message bubble on cancelSend via settling(cancel) reason gate`

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
    return { ok: false, reason: 'abort-threw', error: String(err) };
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

### 产出

- PR 2a — `feat(plugin): add coclaw.agent.abort RPC using embedded run side door`
- PR 2b — `feat(ui): call coclaw.agent.abort on user cancel (silent fallback)`

---

## 阶段 3：上游 PR（长期去侧门化）

### 四个并列 PR

| # | PR 主题 | 改动范围 | CoClaw 受益 |
|---|---|---|---|
| 3a | 新增 `agent.abort` RPC | `server-methods/agent.ts` + schema + tests（~150 行） | UI 可直调 `agent.abort`，插件 RPC 降为 fallback |
| 3b | `api.runtime.agent` 暴露 abort 家族 | `runtime-embedded-pi.runtime.ts` + `types-core.ts`（~10 行增量） | 插件去侧门，改用 `api.runtime.agent.abortEmbeddedPiRun(...)` |
| 3c | `lifecycle:end` 带 `aborted` / `stopReason` | `pi-embedded-subscribe.handlers.lifecycle.ts`（~20 行） | UI 直接从事件区分 abort vs 完成，不再依赖 completion frame |
| 3d | `/compact` 可取消 | `commands-compact.ts` + `compact.ts`（较大改动） | UI 解除 `/compact` 取消禁用 |

### 提交策略

- 3a + 3b **同时提交**（基础设施，互相独立但服务同一目标）
- 3c 和 3d 作为后续改进，不阻塞
- 每合并一个，CoClaw 侧渐进迁移

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

1. **立即启动**：阶段 1（PR 1）——无外部依赖，单一 PR 完成
2. **阶段 1 合并后**：阶段 2.1-2.2（插件 `agent-abort.js` + RPC）作为 PR 2a，独立于 UI
3. **PR 2a 合并后**：阶段 2.3-2.5（UI 集成 + `/compact` 禁用）作为 PR 2b
4. **并行**：通过 `openclaw-issue` skill 提 3a / 3b 的 feature request，排队等合并
5. **逐步迁移**：上游合并后按上表路径做 CoClaw 适配

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
