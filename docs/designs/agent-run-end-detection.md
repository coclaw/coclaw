---
status: 已实施
owner: chat/topic agent run 结束判定重构
created: 2026-04-16
---

# Agent run 结束判定机制重构

## 0. 如何读本文档

本文档脱离聊天上下文独立可读。分两大部分：

- **事实清单**（§2-§3）：所有"经核实的重要结论"，每条标明源码锚点。修改实施时可以直接引用。
- **方案**（§4-§5）：基于事实清单得出的设计判断和改动清单。

## 1. 背景与问题

### 1.1 用户反馈的症状

用户在 chat/topic 内发出 agent run 请求后，约 30% 概率无法看到 run 结束——发送按钮一直显示"停止"状态、最后一条 bot 气泡一直"思考中"转圈。冷启动 UI 后才恢复。用户没有切后台，不是 Capacitor 生命周期问题。

### 1.2 真实范围

- 仅 agent() 路径（对话发消息）有此 bug
- 斜杠命令（chat.send）路径有自己的兜底，不是同一个问题
- 冷启动恢复的机制：进程重启后 agentRunsStore 内存态清零，`activate()` 直接走 `loadMessages` 从服务端拉完整数据

### 1.3 根因

现有代码判定"run 已结束"的信号只有一路：**DC 上 `event:agent` 的 lifecycle:end 事件**（`ui/src/utils/agent-stream.js:112-122` 里 `applyAgentEvent` 只在 `stream==='lifecycle'` 且 `phase==='end'|'error'` 时设 `settled=true`）。

但 agent() RPC 是两阶段响应，第二次响应（`status: 'ok'|'error'`）才是权威的终态信号，**代码完全没用它**——sendMessage 拿到第二次响应 resolve 后只是 `await __reconcileMessages()`（调 loadMessages 拉数据），不主动 settle run（见 `ui/src/stores/chat.store.js:577-580` 注释）。

事件丢失或时序异常时，run 卡在 `isRunning=true`，UI 一直"思考中"。

### 1.4 30% 概率的来源

RPC `res` 帧和 `event:agent` 帧虽走同一条 DC，但在 OpenClaw gateway 端是**两段独立发送代码**，顺序/可靠性不共享。DC 轻微抖动或上游 emit 逻辑有小 bug（见已提的上游 issue #66534），lifecycle:end 就会丢或晚到。

### 1.5 历史脉络证实

推测"agent() 的事件驱动判定是从 chat.send 那套架构沿用而来"—— §2.2 调研证实：chat.send 协议上只有一帧 res（started ack），没有第二次响应，所以 chat.send 时代"只信事件"是对的；但切到 agent() 两阶段后没意识到多了权威的第二次响应。

---

## 2. 事实清单（OpenClaw 侧）

所有条目均经源码核实，括号内为锚点。

### 2.1 agent.wait RPC 能力边界

**签名** — `openclaw-repo/src/gateway/server-methods/agent.ts:952-1039`
- 入参：`runId`（必填）、`timeoutMs`（默认 30_000）
- 出参：`{ runId, status, startedAt?, endedAt?, error? }`
- 参数校验失败才返 `ok:false`；其他情况都是 `ok:true + status:...`

**status 只有 3 个值**：`ok` / `error` / `timeout`。**没有 "running" / "aborted" / "notfound"**。

**timeout 混着 4 种情况**（核心坑）：
1. 真超时（run 还在跑）
2. runId 不存在（从未 register）
3. run 被 abort 了
4. TTL 过期（结束超 10 分钟）

**区分 timeout 的窍门**：看 `startedAt` / `endedAt` 字段
- abort：有 startedAt + endedAt
- 真超时（活跃）：无 endedAt
- 真超时（TTL 过期）：无 endedAt
- 不存在：无 startedAt、无 endedAt

**accepted/started/in_flight 类 dedupe 条目被主动忽略** —— `agent-wait-dedupe.ts:78-80`。所以 accepted 返回后立刻调 `agent.wait(runId, 0)` **必然 timeout**，不能据此判定 run 不存在。

**10 分钟硬编码 TTL** —— `AGENT_RUN_CACHE_TTL_MS = 10 * 60_000` 在 `agent-job.ts:3`。无配置项。TTL **从 run 真正结束瞬间开始算**（snapshot 写入时刻 = lifecycle end/error 事件处理瞬间），不是 sliding TTL。

**LLM error 有 15 秒 grace window** —— `AGENT_RUN_ERROR_RETRY_GRACE_MS = 15_000` 在 `agent-job.ts:9`。瞬态 error 先挂起 15s，期间若出现 start 事件则撤销。

**等待机制是事件驱动不是轮询** —— `agent.ts:1006-1023` 两路并发 race：订阅 onAgentEvent lifecycle 流 + 订阅 dedupe map 唤醒。长挂 `timeoutMs=30_000` 对服务端压力极小，run 一终态立即唤醒 resolve。

**支持 fan-out** —— 多客户端同 runId 并发查询都会被 `notifyWaiters` 唤醒（`agent-wait-dedupe.ts:47-63`，测试 `agent-wait-dedupe.test.ts:261`）。

**不做会话归属校验** —— `agent.ts:952+` 只按 runId 索引，不校验 sessionKey / sessionId。任何知道 runId 的客户端都能查。

**协议稳定性**：`WRITE_SCOPE`，内部 API。近一年（`agent-job.ts` 最近改 2026-03-04，`agent-wait-dedupe.ts` 最近改 2026-03-13）只有内部重构，无破坏性签名变更。

### 2.2 chat.send 的 RPC 协议

**chat.send 是单阶段 RPC，只有一帧 res** —— `openclaw-repo/src/gateway/server-methods/chat.ts:1944-1948`。响应 payload 是 `{ runId, status: "started" }`，语义等价 agent() 的 accepted，**没有第二次响应**。协议上只能靠 `event:chat` 的 `state='final'/'error'` 判定终态。

**agent.wait 原生支持 chat.send 的 runId** —— `agent-wait-dedupe.ts:116,123,126` 同时查 `agent:${runId}` 和 `chat:${runId}` 两个 dedupe key。chat.send 完成时写入 `chat:${runId}` dedupe 会 `notifyWaiters(runId)` 唤醒 `agent.wait` 等待者（`agent-wait-dedupe.ts:206-221`）。

**chat run 与 agent run 共享状态机**：runId 命名空间共享，dedupe 同步，abort 控制器（chatAbortControllers）参与 agent.wait 的 `ignoreAgentTerminalSnapshot` 判定（`agent.ts:970-1003`）。**不需要单独的 chat.wait 方法**。

### 2.3 registration 时序（关键的空窗期）

**accepted/started 响应到 run 真正进入运行态有 4-30s+ 空窗期**（来自取消实施阶段 2.5 的实测记录）：
- main chat ~4s
- topic 10-30s+
- 空窗期在等 session/workspace/skills/provider 等异步准备

**具体时序**：

| 事件 | 时间 | 锚点 |
|---|---|---|
| 客户端收到 accepted/started | T0 | — |
| dedupe `agent:${idem}` 写入（status='accepted'）| T0 − 0ms（同步，在 respond 之前） | `agent.ts:797-806` |
| dedupe `chat:${runId}` 写入 | 从不在 started 阶段写入，只在 terminal 时写（`chat.ts:2252/2274/2305`） | — |
| `chatAbortControllers.set` | T0 − 0ms（同步） | `chat.ts:1935` |
| `activeRuns.set` via `setActiveEmbeddedRun` | T0 + 4s (main) ~ 10-30s (topic) | `attempt.ts:1572` |
| `lifecycle:phase="start"` emit | T0 + 4-30s+ | `pi-embedded-subscribe.handlers.lifecycle.ts:23-32` |

**空窗期内 agent.wait 的行为**：`agent.wait(runId, 0)` **永远返回 timeout**，因为 accepted 类 dedupe 被主动忽略；长挂 `agent.wait(runId, 30_000)` 会挂起等待，run 启动后若正常结束则正常唤醒。

**空窗期内没有可观测信号**：gateway 端不会为准备期发特殊 event。客户端能感知 "run 在等启动" 的唯一证据就是自己持有的 accepted 响应。若 setup 抛错会走 `dispatchAgentRunFromGateway.catch` 写 `status:"error"` dedupe（`agent.ts:262`），agent.wait 正常 resolve。

### 2.4 活跃 run 枚举能力缺失

逐行核实 `server-methods-list.ts` 的 134 个方法，**无 `runs.list` / `sessions.activeRuns` / `agent.runs` 任何一个**。

**4 份内部注册表"查得到但没暴露"**：

| 注册表 | 源码位置 | 对外 RPC |
|---|---|---|
| `ACTIVE_EMBEDDED_RUNS` | `pi-embedded-runner/runs.ts:60` | 无 |
| `chatAbortControllers` | `gateway/server-runtime-state.ts:103,240` | 无 list，仅内部用于 abort 匹配 |
| `activeRunsByKey` / `activeKeysBySessionId` | `auto-reply/reply/reply-run-registry.ts:83-95` | 无 |
| `AGENT_RUN_JOBS`（agent-job 模块的终态 cache） | `agent-job.ts` | 仅 agent.wait 间接读 |

**sessions.subscribe 存在**（`sessions.ts:571-576`），`GATEWAY_EVENTS` 包含 `"agent"` 和 `"session.message"`（`server-methods-list.ts:143,145`）——后连上的客户端能订阅**未来**事件，**但没有 event replay 机制**（加入订阅前的事件永久丢失）。

**当前任务范围**：多端同步不是当前目标，所以列举能力缺失不阻塞本次实施。

### 2.5 首 token 延迟和事件流静默特征

**后端 LLM 空闲看门狗**：`DEFAULT_LLM_IDLE_TIMEOUT_SECONDS = 120` 在 `config/agent-timeout-defaults.ts:1`。LLM streaming iterator 在 120 秒内未推进（没拿到 token/chunk）会抛错并触发一次同模型重试（`llm-idle-timeout.ts:69-94`, `run.ts:131,1626-1628`）。

**同模型最多重试 1 次**：`MAX_SAME_MODEL_IDLE_TIMEOUT_RETRIES = 1`（`run.ts:131`）。这意味着**极端链路可能沉默 ~240s 才 emit error**。

**整 run 超时**：`DEFAULT_AGENT_TIMEOUT_SECONDS = 48h`（`timeoutsetup.ts:3`）。

**首 token 延迟经验分布**（综合源码注释和 CHANGELOG `openclaw-repo/CHANGELOG.md:247`）：
- 常见 3-15s
- 尾部 30-90s（算力紧张 + 关 thinking 时）
- 极端 120s 触发重试

**关 thinking 时**：Anthropic 不会 emit thinking delta 作 placeholder，所以 UI 可见流确实可能完全静默等首 token。

**中途事件流静默**：长 tool（Bash、HTTP、compaction）执行期间基本无中间进度事件。`/compact` 只有 compaction:start / compaction:end 两个端点，中间 LLM summarize 受同一个 120s 看门狗约束。典型 tool 执行 1-30s，极端 /compact 和长 Bash 可达 30-90s。

### 2.6 stopReason 语义（chat.history 判活依据）

**完整取值集**（`anthropic-transport-stream.ts:373-391` / `openai-transport-stream.ts:565-583`）：

| 值 | 含义 | 能否视为"结束" |
|---|---|---|
| `stop` | 正常 end_turn | ✅ |
| `length` | token 超限 | ✅ |
| `error` | LLM fail / refusal | ✅ |
| `aborted` | 用户/RPC/timeout 取消 | ✅（`chat.ts:1331` `persistAbortedPartials` 写入）|
| `toolUse` | 末尾是 tool_use | ❌ **中途态，run 可能仍在跑下一轮** |

**写入时序（重要）** —— 旧怀疑证伪：
1. pi-ai transport 在 `finalizeTransportStream` 把 `stopReason` 放进 AssistantMessage
2. pi-agent-core `onMessage` → `SessionManager.appendMessage`（monkey-patched `session-tool-result-guard.ts:241`）→ **同步 `fs.appendFileSync` 写入 JSONL**
3. **之后**才在 `pi-embedded-subscribe.handlers.lifecycle.ts:130-148` emit `lifecycle:end`

**结论**：最终 assistant 消息（含 stopReason）**先写完**，`lifecycle:end` **后发射**。这跟 29 天前 `project_bug1_3_agent_status.md` 怀疑的"lifecycle:end 先于消息写入"**相反**——至少在嵌入式 runner 路径上假设不成立。

**边界**：
- `/compact` 写入 `type='compaction'` 条目（**非 message**），`chat.history` 合成假 `role:'system'` 消息（`session-utils.fs.ts:127-141`）无 stopReason，**需跳过**
- **crash / OS kill 场景 stopReason 无法表达**：最后一条仍是上一轮的 stop 或中途 toolUse，只能靠 agent.wait 的 timeout 或外部信号判断

**chat.history 数据源**：每次调用 `fs.readFileSync` 整个 JSONL 文件（`session-utils.fs.ts:93-146`），非内存缓存、热更新。

### 2.7 lifecycle:end 事件是否可靠

**广播机制**：`event:agent` 的 lifecycle:end 通过 gateway broadcast 给所有 WS 订阅方（`openclaw-repo/src/gateway/server-methods/chat.ts:1545,1589`），无 per-session 订阅、无 snapshot 回放。

**已知上游 bug**：`lifecycle:end` 在 pi-embedded 路径下的 fallback emit 被 `lifecycleEnded=true` 跳过（见已提上游 issue #66534），至少缺失 aborted/stopReason 字段；同一代码路径可能存在整个事件间歇性丢失的情况。

**意味着**：lifecycle:end 不能作为**唯一**的结束信号。

---

## 3. 事实清单（CoClaw UI 侧现状）

### 3.1 两阶段 RPC 的底层封装

**统一封装在底层**：`ui/src/services/claw-connection.js:136-171` 的 `request(method, params, options)` 通过"是否传入 `options.onAccepted`"区分单/两阶段：
- 无 onAccepted → 任何 ok=true 直接 resolve（单阶段）
- 有 onAccepted → accepted 状态调回调保留 waiter，TERMINAL_STATUSES（`ok` / `error`）才 resolve（两阶段）

**全仓库两阶段调用只有一处**：`ui/src/stores/chat.store.js:525` 的 `conn.request('agent', ...)`。其他 30+ 个 RPC 调用均为单阶段。

**没有拦截器/中间件层**可以统一观察所有两阶段 RPC 的 settle 事件——目前只有 `__handleRpcResponse` 内部单点分发。

### 3.2 agentRunsStore 的角色

`ui/src/stores/agent-runs.store.js` 是 per-run 全局状态机：
- 注册入口：**仅由** `chat.store.js:548` 的 onAccepted 调用 `runsStore.register(runId, ...)`
- 事件入口：`claws.store.js:311-314` 订阅 `event:agent` → `claw-lifecycle.js:69-74` → `agentRunsStore.__dispatch`（单点分发）
- 状态结构：`runs[runId]` 含 clawId/runKey/settled/settling/settlingReason/streamingMsgs/lastEventAt/__conn/__timer/__settleTimer/__loadInFlight
- 索引：`runKeyIndex[runKey]` → runId
- 清理：`__cleanupRun` 统一处理 timer 清除、blob URL revoke、索引删除

**结论**：agentRunsStore **已经**是结束判定的天然汇聚层。唯独缺"第二次 RPC 响应"这一路信号直通——目前靠 sendMessage resolve 后 `__reconcileMessages → loadMessages → __reconcileRunAfterLoad → completeSettle` 的间接链路。

### 3.3 当前"结束判定"逻辑分布（4 处分散）

| 信号源 | 现有处理路径 |
|---|---|
| lifecycle:end 事件 | DC event → claws.store 桥接 → agentRunsStore.__dispatch → applyAgentEvent 返回 settled → `__settleWithTransition` → `settling=true, settlingReason='lifecycle'` → 500ms fallback 调度 cleanup |
| 第二次 RPC 响应（agent 的 ok/error）| chat.store:524-563 Promise resolve → 只调 `__reconcileMessages()`（拉数据）**不直接 settle run** |
| Timer 兜底 | pre-acceptance 180s（chat.store:510）、post-acceptance 24h（chat.store:534 + agent-runs.store:117 双份）、settle fallback 500ms（agent-runs.store:209）|
| reconcile 兜底 | chat.store:1324 `__reconcileRunAfterLoad` → `completeSettle`（需 settling='lifecycle'）/ `reconcileAfterLoad`（基于 lastEventAt 保守启发式）|
| 用户取消 | chat.store:821-863 tick 协调 + `settleWithTransitionByKey`（阶段 2.5 已做）|

**reconcile 兜底的保守启发式（关键 bug 点）**：`reconcileAfterLoad` 在 `agent-runs.store.js:322-343` 用 `lastEventAt < STALE_RUN_MS (3000ms)` 或 `lastEventAt=0` 跳过 cleanup。在 sendMessage 的 RPC resolve 路径上，这条启发式把权威信号掐断了。

### 3.4 应保留 vs 应废弃

**保留**：
- `ClawConnection.request` 的两阶段分发机制（工作正常）
- `agentRunsStore` 的 register/runKeyIndex/streamingMsgs/__dispatch 基础设施
- 取消相关（阶段 1/2/2.5 已做好）：`__cancelling` / `__startCancelCoordination` / `settleWithTransitionByKey` 的 reason='cancel' 分支
- pre-acceptance 180s timer（accepted 之前的超时兜底仍必要）

**废弃**：
- `settleWithTransition` 的 reason='lifecycle' 流程 + `__scheduleSettleFallback`（500ms fallback）
- `completeSettle`（lifecycle 分支）
- `reconcileAfterLoad` + `STALE_RUN_MS` + `IDLE_RUN_MS` + `isRunIdle` + `lastEventAt` 的保守启发式
- chat.store 的 `activate` 里"僵尸 run 检测"分支（依赖 `isRunIdle`）
- chat.store 的 `__agentSettled` 状态位（若被新 watcher 统一管理则不再需要）
- agent-runs.store 里 `POST_ACCEPT_TIMEOUT_MS` 的 24h 后端兜底（新 watcher 会保证在合理时间内 cleanup）

---

## 4. 方案定稿

### 4.1 核心原则

"**RPC 是权威、事件是过程数据**"——对齐 HTTP/SSE 心智模型。HTTP 响应告诉你"结束了"，SSE 只是传进度。

### 4.2 三路结束信号

任一命中就 cleanup + 触发全量刷新（loadMessages）：

1. **第二次 RPC 响应**（最权威）—— agent() 的 `status: ok/error`；99% 正常 run 由此收尾
2. **lifecycle:end 事件**（辅助）—— DC 上的 event；与信号 1 可能有先后
3. **agent.wait 长挂唤醒**（兜底）—— 事件静默超阈值后启动的长挂查询

### 4.3 状态机

```
[已注册 run]
  ├─ 收到信号 1 或 2 → [已结束] → loadMessages + cleanup
  └─ 事件静默超 30s → [长挂查询中]
      ├─ agent.wait 返回 ok/error → [已结束] → loadMessages + cleanup
      ├─ agent.wait 返回 timeout + 有 endedAt → [已结束]（abort）→ loadMessages + cleanup
      ├─ agent.wait 返回 timeout（无 endedAt）
      │    ├─ accepted 距今未超 10 min → 起下一轮长挂
      │    └─ 超 10 min → [降级] → loadMessages 读 stopReason 兜底
      └─ 期间收到信号 1 或 2 → [已结束]（长挂查询被打断 / 忽略）
```

### 4.4 关键参数

| 参数 | 值 | 依据 |
|---|---|---|
| idle 阈值 | 30 秒 | 保守值覆盖首 token 慢（§2.5 尾部 30-90s 的正常范围）|
| agent.wait timeoutMs | 30_000 ms | 长挂不加压，服务端事件驱动（§2.1）|
| 长挂失败后等待 | 立即再起一轮 | 服务端无压力，不需要间隔 |
| TTL 降级阈值 | accepted 距今超 10 分钟 | §2.1 终态缓存 TTL 硬编码 |

### 4.5 改动清单

**新增** `ui/src/services/claw-connection.js`：

- `request()` 的 options 新增可选 `onSettled(payload)` 回调，在第二次 res 的 `waiter.resolve` 之前触发，参数是服务端响应 payload

**重构** `ui/src/stores/agent-runs.store.js`：

- 保留：`register` / `__dispatch` / `getActiveRun` / `isRunning` / `streamingMsgs` / `runKeyIndex` / `removeByClaw` / `settleWithTransitionByKey`（cancel 分支）/ `stripLocalUserMsgs`
- 新增：每个 run state 挂一个 `runWatcher` 对象
  - 职责：维护 idleTimer、pollTimer、lastEventAt、acceptedAt；接收三路信号；触发 `onRunEnd(runId, reason)` 
  - API：
    - `onRpcSettled(runId, payload)` —— 第一路信号
    - （lifecycle:end 仍走现有 `__dispatch` 后改调 watcher.onLifecycleEnd）—— 第二路信号
    - 内部 `pollOnce()` —— 第三路信号（发起 `conn.request('agent.wait', {runId, timeoutMs: 30_000})`）
  - 命名：按用户偏好使用 `runWatcher` / `onRunEnd` / `idleTimer` / `lastEventAt` / `pollOnce`，不用 settle/reconcile/transition
- 废弃：见 §3.4 列表

**精简** `ui/src/stores/chat.store.js`：

- `sendMessage` 的 `conn.request('agent', ...)` 调用新增 `onSettled` 回调，调 `agentRunsStore.onRpcSettled(runId, payload)`
- 删除：`__agentSettled`（改由 watcher 管）/ `__reconcileRunAfterLoad` 里对 `reconcileAfterLoad` 的调用 / `activate` 里依赖 `isRunIdle` 的分支 / `__streamingTimer` 的 post-acceptance 24h 分支
- 保留：pre-acceptance 180s timer、`__accepted`、`__cancelReject`、cancel 流程

**不动**：

- plugin 和 server 侧
- `sendSlashCommand`（chat.send 路径）——它协议上本来只能事件驱动，现有事件+超时兜底够用
- cancel 相关（阶段 1/2/2.5 已做好）

### 4.6 测试要点

单元测试：

- 三路信号各自单独命中能正确 settle（驱动 onRunEnd）
- 三路信号任意两路先后命中 → 去重，只触发一次 loadMessages
- 长挂查询返回各种 (status, endedAt) 组合的分支覆盖
- TTL 超期触发降级读 stopReason
- cancel 路径不被新 watcher 误伤
- 快速连发消息：旧 run 的 watcher 在新 run 注册时作废
- page unmount / chat 切换 / dispose 时 watcher 正确清理

E2E（选做）：

- 模拟 lifecycle:end 丢失 + RPC 正常 → 应正常结束
- 模拟 RPC 正常 + 事件正常 → 应正常结束（去重验证）
- 模拟事件流卡住 + RPC 未回（极端 race）→ 长挂兜底应能收尾

---

## 5. 遗留与后续

### 5.1 建议提的上游 issue（不阻塞本次实施）

1. `runs.list` 或 `sessions.activeRuns` —— 多端同步刚需
2. `sessions.subscribe` 增加"连上时回放最近事件"参数
3. `agent.wait` 增加 `running` status，区分"在跑"和"查不到"
4. 终态缓存 TTL 可配或延长（当前 10 分钟硬编码）

### 5.2 非本次改动但可跟进

- chat.send 路径也可以加 agent.wait 兜底（runId 命名空间共享，见 §2.2）。现有 24h 超时兜底过于保守，若未来要提升 chat 的体验，可以沿用本次 watcher 机制。

---

## 6. 实施备忘（与 §4 原方案的差异）

实施过程中根据进一步讨论，对 §4 方案做了 4 处调整：

1. **删除 TTL 降级分支**：原方案在 §4.3 状态机里设计了"长挂超 10 分钟未收到任何信号 → 读 stopReason 兜底"的降级路径。实际分析下来，OpenClaw 的 10 分钟 TTL 是已结束 run 的终态缓存时长，与 run 运行时长无关；正常路径 30s idle 启动长挂远早于 10 分钟，且 watcher 不限重试次数。极端组合（信号全丢 + 运行时间足够长到错过 10min）冷启动恢复即可。

2. **新增第四路结束信号：DC 错误 = 结束**：原方案三路（RPC 第二阶段 / lifecycle:end / 长挂结果）只覆盖正常完成路径，对 gateway 重启等异常场景无法收尾（DC 断后老 runId 在 server 已不存在，事件流不会再来）。新增"任何 RPC 错误（DC 断、send 失败、wait 超时等）→ endRun('failed')"，让 UI 状态在数秒内与服务端对齐。代价是纯网络短抖（通常被 ICE restart 接住，不会真的断 DC）也会被一刀切判定为结束，重连后 loadMessages 会拉到正确状态，体验损失可接受。

3. **架构折衷方案 (a)**：把 agent run 的"发起 + 生命周期管理"完全收敛到 `agentRunsStore.runAgent(...)` action，chat.store 只管消息构造、UI sending 状态、cancel 协调。通用 `claw-connection.js` 不动（不扩展 onSettled 回调），两阶段 RPC 的细节封装在 runAgent 内部。

4. **watcher 不感知 DC 状态**：依赖 RPC 错误信号（信号 4）自然冒泡，无需"sleep 重试 + 指数退避"的复杂逻辑。watcher 收到任何 wait 失败直接 endRun('failed')，conn.request 内部 waitReady 也只是底层透明逻辑。

**状态字段简化**：旧的 `settled / settling / settlingReason` 三字段简化为两个 boolean：
- `cancelled` —— 用户已取消，watcher 仍跑等真实终态信号；不影响 isRunning（让 cancel coordination tick 能继续）
- `ended` —— 终态信号已收到，watcher 已停，等待 chat.store 调 `dropRun(runKey)` 真正释放 entry

**streamingMsgs 闪烁守卫**：旧的 `__loadInFlight + __settleTimer + __scheduleSettleFallback(500ms)` 协调被替换为更直白的两阶段 cleanup：信号到达 → endRun → run.ended=true 但 entry 保留；chat.store 拿到 runPromise resolve 后 await loadMessages → dropRun → 真正释放。

### 5.3 关键源码锚点索引

**UI 侧（实施后）**：
- `ui/src/stores/agent-runs.store.js` — runAgent + dropRun + watcher（四路结束信号协调）
- `ui/src/stores/chat.store.js` — sendMessage 调 runAgent；runPromise.then 兜底 cleanup
- `ui/src/services/claw-connection.js:136-252` — request + __handleRpcResponse（未改动，两阶段 RPC 通用机制）
- `ui/src/utils/agent-stream.js:112-122` — applyAgentEvent lifecycle 分支
- `ui/src/stores/claw-lifecycle.js:69-74` — dispatchAgentEvent 桥接
- `ui/src/stores/claws.store.js:311-314` — event:agent DC 事件桥接入口

**OpenClaw 侧**：
- `openclaw-repo/src/gateway/server-methods/agent.ts:952-1039` — agent.wait 实现
- `openclaw-repo/src/gateway/server-methods/agent.ts:791-806` — agent accepted dedupe 写入
- `openclaw-repo/src/gateway/server-methods/agent-job.ts:3,9,11,32-42,95` — TTL 常量 + cache 管理
- `openclaw-repo/src/gateway/server-methods/agent-wait-dedupe.ts:78-80` — 忽略非终态 dedupe
- `openclaw-repo/src/gateway/server-methods/agent-wait-dedupe.ts:110-146,206-221` — 两 key 查询 + notifyWaiters
- `openclaw-repo/src/gateway/server-methods/chat.ts:1935-1948` — chat.send started 响应
- `openclaw-repo/src/gateway/server-methods/chat.ts:2252,2274,2305` — chat terminal dedupe 写入
- `openclaw-repo/src/agents/pi-embedded-runner/run/attempt.ts:1572` — activeRuns.set 时机
- `openclaw-repo/src/agents/pi-embedded-subscribe.handlers.lifecycle.ts:130-148` — lifecycle:end emit 时机
- `openclaw-repo/src/agents/session-tool-result-guard.ts:241-253` — 最终消息持久化
- `openclaw-repo/src/config/agent-timeout-defaults.ts:1` — 120s LLM 空闲看门狗
- `openclaw-repo/src/gateway/server-methods/agent-wait-dedupe.test.ts` — agent.wait 测试套件
- `openclaw-repo/src/gateway/server-chat.gateway-server-chat.test.ts:904-1041` — agent.wait 覆盖 chat run 的 e2e 测试

---

## 7. 已知局限（实施后复核发现）

实施完成后针对方案做了一轮独立复核（不依赖实施讨论记忆），发现以下遗留问题。经评估**严重性远低于原 bug**，暂不修复，记录待后续处理。

### 7.1 loadMessages 静默失败时 dropRun 误释放 streamingMsgs

**现象** —— `chat.store.js:542-549` 的 `runPromise.then` 在 `await loadMessages` 后**无条件**调 `dropRun`：

```js
runPromise.then(async (res) => {
    if (res?.accepted) {
        await this.loadMessages({ silent: true });
        runsStore.dropRun(runKey, res.runId);  // ← 不检查 loadMessages 是否成功
    }
})
```

`loadMessages` 的静默失败路径（`getReadyConn` 返 null / `sessions.get` 抛错被 catch 吞掉）内部 `return false` 不抛。此时 `this.messages` **未被更新**（silent 模式下 catch 分支连 errorText 都不写），但 `dropRun` 仍会释放 `streamingMsgs` —— UI 丢失当前这轮的 user 消息和 assistant 回复，回退到发送前的状态。

**触发条件（低概率）**：
- DC 恰好在 run 结束瞬间断开（信号 4 `endRun('failed')` 触发后，loadMessages 里 `getReadyConn` 立即返 null）
- `sessions.get` RPC 偶发失败（服务端 fs 读错、请求超时等，极罕见）

**最坏后果**：
- UI 临时显示不一致（当前这轮消息看不见）
- **数据不丢**：服务端 JSONL 已写完（见 §2.6）
- **无内存泄漏**：dropRun 正常释放 streamingMsgs
- 影响仅限 UI 短暂状态错位

**自愈路径**（多数场景秒级恢复）：
- `connReady` watcher（DC 重连即触发新 loadMessages，见 `ChatPage.vue:459-470`）
- `app:foreground` / `visibilitychange` handler
- `activate` re-entry（用户导航离开再回来）

**极端情况**：DC 永久不恢复且用户不做任何操作 → 消息持续看不见；此时处境等价于原 bug 冷启恢复（app 重启后 activate → loadMessages 成功）。

**严重性对比**：

| 维度 | 原 bug | 本限制 |
|---|---|---|
| 概率 | ~30%（用户反馈） | <1%（估计） |
| 现象 | 永久"思考中" | 消息临时消失 |
| 自愈 | 需冷启 | 多数自动 |
| 用户感知 | 明显卡住 | 无声（潜在重发困惑） |

原 bug 从 ~30% 永久卡死降为 <1% 临时不一致，量级显著降低；"无声"这一点比原 bug 更易混淆，但整体仍在可接受范围。

### 7.2 为什么不能简单 fix

直觉方案 `if (ok) dropRun(...)` **会引入更糟的新 bug**：

- `runPromise.then` 由 `finalPromise` 驱动，每个 run 只触发一次
- loadMessages 失败后 streamingMsgs 保留，但**没有后续 drop 机制**
- 当 `connReady` watcher / foreground / activate 后来触发 loadMessages 成功时，`this.messages` 被更新包含这轮完整数据，而 streamingMsgs 仍然存活
- `allMessages = [...this.messages, ...streamingMsgs]` → **消息重复显示**（user 和 assistant 各出现两次）

比原问题更糟。简单 fix 不可取。

### 7.3 正确的修复方向（未来处理）

把 dropRun 的职责从 `runPromise.then` 上移到 `__reconcileRunAfterLoad`，与 `stripLocalUserMsgs` 并列成为 loadMessages 成功后的统一状态校准点：

```js
// chat.store.js
__reconcileRunAfterLoad(serverMessages) {
    const runsStore = useAgentRunsStore();
    runsStore.stripLocalUserMsgs(this.runKey, serverMessages);
    // 新增：run 已 ended 时释放 entry（此处与 this.messages 更新同属一个 reactivity tick）
    const run = runsStore.getActiveRun(this.runKey);
    if (run?.ended) {
        runsStore.dropRun(this.runKey, run.runId);
    }
}

// chat.store.js:542-549 改为只触发加载
runPromise.then(async (res) => {
    if (res?.accepted) {
        await this.loadMessages({ silent: true });
        // drop 由 __reconcileRunAfterLoad 统一处理
    }
}).catch((e) => console.debug('[chat] runPromise rejected:', e?.message));
```

**安全性论证**：
- loadMessages 失败 → streamingMsgs 保留 → 后续任何成功 loadMessages 自动清，无需重试机制
- `this.messages` 更新和 dropRun 在同一 reactivity tick 内同步执行，UI 无中间态闪烁
- `dropRun` 内部有 `runKeyIndex` 校验和 `expectedRunId` 校验，多处调用幂等
- supersede 路径（register 内部主动 `__cleanupRun`）不受影响，与此钩子解耦

**暂不实施的原因**：
- 测试覆盖需要补：loadMessages 失败保留 streamingMsgs、后续成功 loadMessages 触发 drop、supersede 后新旧 run 的 drop 幂等性、cancel 路径不受影响等
- 相对原 bug 的严重性降幅大，正确 fix 的 review/测试成本与当前收益不平衡
- 修复时需参考此处的时序分析，避免再次选择简单但错误的方向

### 7.4 相关 pre-existing 竞态：loadMessages 飞行中共享导致 run2 数据陈旧

Run1 ended → `runPromise1.then` 启动 `loadMessages` A 飞行中；用户快速发 msg 2，run2 register 后快速 ended；`runPromise2.then` 的 `await loadMessages` 复用 A（`__silentLoadPromise` 守卫机制，`chat.store.js:202-209`）→ A 带回的是 run1 ended 时刻的数据，不含 run2 → `dropRun(run2)` 释放 streamingMsgs 后 UI 丢 run2 内容。

实施前后都存在，不由本次设计引入，依赖后续 loadMessages 自愈（connReady/foreground/activate 任一触发即恢复）。严重性低于 §7.1，修复代价高（需要"loadMessages 发起时刻 vs run.endedAt"比较机制），建议保持现状。
