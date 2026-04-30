# OpenClaw Agent 事件流、RPC 与持久化时序

> 更新时间：2026-05-01
> 基于 OpenClaw 本地源码验证（`openclaw-repo/openclaw`）

---

## 一、Agent 事件流类型

agent 方法触发的 run 期间，网关以 `event: "agent"` 帧推送流式数据。

### 1. stream 取值与数据

| stream | 数据字段 | 广播方式 | 说明 |
|--------|----------|----------|------|
| `lifecycle` | `{ phase, startedAt?, endedAt?, error? }` | broadcast (所有客户端) | phase: start / end / error / fallback / fallback_cleared |
| `assistant` | `{ text, delta, mediaUrls? }` | broadcast | text 为完整累积文本（替换模式），delta 为增量 |
| `tool` | `{ phase, name, toolCallId, args?, result?, partialResult?, meta?, isError? }` | broadcastToConnIds (仅注册了 tool-events 能力的客户端) | phase: start / update / result |
| `thinking` | `{ text, delta }` | broadcast | 推理/思考流，text 为完整累积文本 |
| `compaction` | `{ phase }` | broadcast | phase: start / end |
| `error` | `{ reason, expected, received }` | broadcast | 网关合成，序列号间隙时触发 |

### 2. Tool 事件的 verbose 行为

网关在广播 tool 事件前，根据 `toolVerbose` 级别决定是否剥离数据（`server-chat.ts:541-551`）：

```
toolVerbose !== "full" 时：
  delete data.result
  delete data.partialResult
```

即使客户端声明了 `tool-events` 能力并注册为接收者，仍然只能收到不含 result 的 tool 事件。要获取完整 tool result 内容，需要从持久化的 JSONL 中读取。

### 3. Thinking 事件的实际可用性

`stream: "thinking"` 事件由 `pi-embedded-subscribe.ts:emitReasoningStream()` 发射。但**并非所有 agent 配置都会触发**——取决于模型是否产生了 thinking/reasoning 块。

实际观察（2026-03-16）：某次包含 tool 调用的 agent run，日志中未见 thinking 事件，但持久化消息的 content 数组中包含 `{ type: "thinking" }` 块。说明 thinking 内容可能不通过流式事件传递，仅存在于持久化消息中。

### 4. Tool-events 能力注册

客户端需在 gateway `connect` 请求的 `caps` 中声明 `"tool-events"`：

```json
{ "caps": ["tool-events"] }
```

网关在处理 `agent` 或 `chat.send` 请求时，会为声明了该能力的连接注册 tool 事件接收（`registerToolEventRecipient`）。

---

## 二、消息获取 RPC

### 1. `chat.history`（原生 UI 使用）

原生 UI 用于加载聊天历史的标准方法。

**参数**：
- `sessionKey`（string，必需）
- `limit`（number，可选，默认 200，上限 1000）

**返回**：
```json
{
  "sessionKey": "agent:main:main",
  "sessionId": "uuid",
  "messages": [...],
  "thinkingLevel": "verbose",
  "fastMode": false,
  "verboseLevel": "summary"
}
```

**与 `nativeui.sessions.get` 的区别**：
- `chat.history` 走网关自身处理器，对消息做清洗（strip 信封、截断长文本到 12000 字符、strip base64 图片数据、替换超大消息为占位符）
- `nativeui.sessions.get` 走 CoClaw 插件的 session manager，直接读原始 JSONL，无清洗
- `chat.history` 额外返回 `thinkingLevel`、`fastMode`、`verboseLevel` 元数据

### 2. `agent.wait`（等待 run 完成）

长轮询方式等待一个 agent run 完成。

**参数**：
- `runId`（string，必需）— 即 `idempotencyKey`
- `timeoutMs`（number，可选，默认 30000）

**返回**：
```json
{
  "runId": "uuid",
  "status": "ok" | "error" | "timeout",
  "startedAt": 1771572313559,
  "endedAt": 1771572320000,
  "error": "..."
}
```

`status` 实际取值仅 `ok` / `error` / `timeout`（`agent.ts:952-1039`）；`timeout` 同时混合了"真超时（活跃）"、"abort"（有 `endedAt`）、"runId 不存在"、"TTL 过期"四种情况，需结合 `startedAt` / `endedAt` 区分（详见 §四）。

**内部机制**：`agent.ts:1006-1023` 两路 race：订阅 `onAgentEvent` lifecycle 流 + 订阅 dedupe map 唤醒。

**应用场景与限制**：
- WS 断连重连后跟踪正在执行的 agent run（`agent.wait(runId)` 等其完成）
- ⚠️ **不能保证 chat.history 已含最终消息**：lifecycle 分支可能在 gateway transcript 写盘前就 resolve（详见 §三、§五）。要确保 chat.history 拿到完整数据，应等 agent RPC 二阶段 res 帧而非 agent.wait 返回

### 3. `sessions.get`（网关内部）

读取原始 JSONL 消息。不在 `BASE_METHODS` 中但 handler 存在。

**参数**：`key`（sessionKey）、`limit`

### 4. 无按 runId 过滤的 RPC

目前没有 RPC 能只获取某一次 run 的消息——只能读取完整 session。

---

## 三、持久化时序（关键）

### 1. 两层持久化

OpenClaw 在 agent run 完成时存在**两层 JSONL 写入**，时序不重合：

| 层 | 写入函数 | 触发时机 | 含哪些字段 |
|---|---|---|---|
| pi 层（流式逐条） | `SessionManager.appendMessage`（pi 库内部） | 流式过程中：每个 `message_end` 事件即同步 `appendFileSync` 一行 | 完整字段，含 `stopReason` |
| gateway 层（最终对账） | `persistCliTurnTranscript` / `persistAcpTurnTranscript`（agent RPC 路径）→ `persistTextTurnTranscript` → `SessionManager.appendMessage`（`attempt-execution.ts:99-153`） | run 结束后，`agentCommandInternal` 在 `await` 链上同步写完才 return（`agent-command.ts:1094-1135`） | 完整 user + assistant 一对 |

**关键事实**：两层最终写入**同一个物理文件**（pi 的 `sessionFile` jsonl）。`chat.history` / `sessions.get` 通过 `readSessionMessages`（`session-utils.fs.ts:93-150`）每次 `fs.readFileSync` 解析，**无缓存**——只要文件写完，下一次 RPC 立即可见。

### 2. lifecycle:end 与 transcript 的时序

```
pi message_end → pi 同步写盘（pi 层完成）
              ↓
pi agent_end → handleAgentEnd → emitLifecycleTerminal()  ← lifecycle:end 事件 broadcast
              ↓
agent-command.ts: await persistCliTurnTranscript(...)     ← gateway 层写盘（晚于 lifecycle:end）
              ↓
await deliver... → return → respond(true, payload, ...)   ← agent RPC 二阶段 res 帧
```

- **lifecycle:end 事件 emit 早于 gateway 层写盘**：`agent-command.ts:966` 处 emit lifecycle，到 `:1094` 才 `await persistCliTurnTranscript`（CLI runner）。ACP runner 同理（`:534` end → `:540` persist）
- **lifecycle:end ≠ chat.history 可拉取最终消息**：拉到的可能是缺最终一条或缺 stopReason 的半成品
- **agent.wait race(lifecycle, dedupe)**：lifecycle 分支可能先 resolve（`agent.ts:1327`），同样不保证 transcript 已写完

### 3. lifecycle:end payload 字段保证

| 路径 | 文件:行 | 含 stopReason | 含 aborted |
|---|---|---|---|
| pi-embedded 主路径 | `pi-embedded-subscribe.handlers.lifecycle.ts:137-146` | **否** | **否** |
| CLI runner | `auto-reply/reply/agent-runner-execution.ts:1096-1104` | 否 | 否 |
| ACP 通用 | `agents/command/attempt-execution.ts:552-561` | 否 | 否 |
| Subagent fallback | `agents/agent-command.ts:966-976` | **是**（`result.meta.stopReason`） | **是** |
| Codex app-server | `extensions/codex/src/app-server/run-attempt.ts:683-687` | 否 | 仅 `finalAborted=true` 时有 |

**结论**：绝大多数路径下 lifecycle:end **不携带 stopReason**（上游 issue #66534 的根源）。UI 不应依赖 lifecycle:end 的 payload 字段判定 run 终态。

### 4. result.meta 字段也是 optional

`pi-embedded-runner/types.ts:108,127` 中 `aborted?: boolean`、`stopReason?: string` 均 optional。早期错误抛出（`agent-command.ts:1056-1067` lifecycle:error 直接 throw）走 `agent.ts:358` 的 `.catch` 分支返回 errorShape，不携带 `result.meta`。**UI 端的"校验 stopReason"判定逻辑要把缺失当兜底降级，不能假设一定有**。

### 5. result.payloads 不含 messageId / 偏移

`result.payloads` 只是文本 / 工具调用片段数组，**不含**消息在 transcript 中的 id 或行号偏移。UI 没有可靠 key 把 payloads 跟 transcript 中某条 assistant 精确对应——只能靠"最近一条 assistant"启发式匹配。

---

## 四、Agent RPC 二阶段响应

### 1. 协议形态

`agent` RPC 是两阶段，区别于 `chat.send`（fire-and-forget 单阶段）：

| 阶段 | 文件:行 | payload | 时机 |
|---|---|---|---|
| 第一阶段 accepted | `agent.ts:1078-1093` | `{ status: "accepted", runId, ... }` | 注册 abort controller 后**立即**发，作为 in-flight ack 写入 dedupe |
| 第二阶段 result | `agent.ts:319-346` | `{ runId, status: "ok", summary: "completed", result }`，含 `result.meta.stopReason` / `result.meta.aborted` / `result.payloads` | run 结束 + transcript 写完 + deliver 完成后 |

### 2. 同步串行强保证

第二阶段 res 帧由 `agentCommandFromIngress(...).then((result) => respond(true, payload, ...))` 触发；`agentCommandFromIngress` → `agentCommandInternal` 内部已 `await persistCliTurnTranscript` / `await persistAcpTurnTranscript`，再 await `deliverAgentCommandResult`，再 return。

**所以二阶段 res 帧一发出，transcript 一定已写完**——这是源码层面的同步 await 链保证，不是经验数字。

### 3. 与其他信号的时序对比

```
lifecycle:end 事件        ──→ broadcast 出去（早，不保证 transcript）
agent.wait race(lifecycle)──→ 可能跟 lifecycle 同时 resolve（不保证）
gateway transcript 写完   ──→ 必须等到这一步 chat.history 才能拉到完整数据
deliver + setGatewayDedupeEntry
agent RPC 二阶段 res 帧   ──→ 此时 transcript 必已写完（强保证）
```

二阶段 res 帧到达 ↔ `setGatewayDedupeEntry` 写 terminal payload（`agent.ts:335-343`）—— 后续重试或 `agent.wait` 都会优先命中这个缓存。

### 4. chat.send 路径不同

`chat.send` 是单帧 ack（`{ status: "started" }`，`chat.ts:1865`），**没有**二阶段 res；后续状态全靠 `chat:final` ws 事件（`emitChatFinal` → `broadcast("chat", ...)`）。

- `chat:final` 由 `appendAssistantTranscriptMessage` 之后触发（`chat.ts:2298`），**保证 transcript 已写完**
- 但 `chat:final` 仅在 chat.send 路径发，**agent RPC 路径不发**
- agent.wait 原生支持 chat.send 的 runId（`agent-wait-dedupe.ts:116,123,126` 同时查 `agent:` / `chat:` 两个 dedupe key），不需要单独的 `chat.wait`

---

## 五、信号选择决策（UI 用）

### 1. 信号汇总表

| 信号 | agent RPC 路径 | chat.send 路径 | transcript 已写完？ | 含 stopReason？ |
|---|---|---|---|---|
| `lifecycle:end` 事件 | 有 | 有 | **否** | 大多数路径否 |
| 二阶段 RPC res 帧（`status:"ok"`） | **有** | 无 | **是**（同步 await 保证） | 是（`result.meta`，但 optional） |
| `agent.wait` 长挂返回 | 有 | 有 | **不一定**（lifecycle 分支可能先 resolve） | 否（自身不带，需读 transcript） |
| `chat:final` ws 事件 | **无** | 有 | **是** | 是（`evtStopReason`） |
| `sessions.changed` ws 事件 | 有 | 有 | 跟 lifecycle 同步发 | 否 |

### 2. 决策建议

- **agent RPC 路径**：等"二阶段 res 帧"再拉 chat.history（最强保证、零延迟）。其他 endRun 信号（lifecycle / wait）若先到，意味着可能命中 transcript 半写窗口
- **CoClaw 当前实现（阶段 1/2 现状）**：lifecycle:end 已**不在 endRun 信号链**（commit 62dfbbe 后拆除，原因详见 §八 lifecycle:end 多次 emit 行为）。endRun 三路信号：
  1. **信号 1**：主 `agent` RPC 二阶段 res 帧（`status: ok/error`）→ `__onRpcDone` → endRun('rpc')，最权威
  2. **信号 2**：事件流静默超 `IDLE_THRESHOLD_MS` 后 `agent.wait(timeoutMs=0)` 即时探测 → 拿到正经回答时 endRun('wait')。**阶段 2 实施中：`IDLE_THRESHOLD_MS` 暂存拉到 24h，本路径实质禁用**（详见 `docs/designs/agent-run-end-detection.md` §8）
  3. **信号 3**：主 RPC reject（DC 物理死亡 / 服务端 ok:false）→ `__onRpcFailed` → endRun('failed')
- **下游不依赖 wait 路径校验"transcript 是否写完"**：信号 1 由二阶段 res 帧驱动，源码层面 `await persistCliTurnTranscript` 已保证 transcript 写完（见 §四 §2）；信号 2 仅在阶段 2 之后由 plugin 专用查询 API 提供"已结束"语义后才会重新启用
- **chat.send 路径**（CoClaw 当前不走，仅参考）：等 `chat:final` ws 事件
- **进程崩溃 / kill -9**：上述任一事件都收不到——这是唯一无法通过事件感知的情形，需要 `agent.wait` timeout 或 24h 兜底 timer 作为最后保险
- **不要依赖 lifecycle:end payload 的 `stopReason`**：上游主路径不写。如需校验 stopReason 须从 transcript 读，且把"缺失"当降级路径处理

---

## 六、原生 UI 的消息刷新策略（仅参考）

OpenClaw 自带 webchat UI 的策略，CoClaw UI 不直接套用：

1. 流式期间：用 `event:chat`（delta）显示文本，用 `event:agent`（tool）显示工具卡片
2. 收到 `event:chat` 的 `state: "final"` 后：
   - 如果本次 run 有 tool 事件 → 调用 `chat.history` 重载完整历史
   - 如果没有 tool 事件 → 直接用 final 中附带的 message
3. 重载是原子替换 `chatMessages` 数组，避免闪烁

**注意**：原生 UI 走的是 chat.send 路径，靠 `chat:final` 触发刷新；CoClaw UI 走 agent RPC 路径，要靠二阶段 res 帧而非 chat:final。

---

## 七、Res 帧协议事实（CoClaw 强依赖）

CoClaw plugin 在 `realtime-bridge.js` 把网关 ws 收到的 res 帧透传 broadcast 给 UI DC。这条透传路径上的几个不可变协议事实：

### 1. Res 帧无 method 字段

OpenClaw JSON-RPC res 帧结构：`{ type: 'res', id, ok, payload }`，**没有 method 字段**。plugin 在透传时只能凭 `id` 关联，无法直接得知"这条 res 对应的 req method 是什么"。

**实际后果**：plugin 端要识别"这条 res 是不是 agent run 类响应"必须靠 payload 内容特征（如顶层 runId），不能用 method 名。

### 2. Payload 单层

`respond(ok, payload, error, ?meta)` 第 2 参数是 res 帧的 `payload` 字段值——单层。plugin 端代码上下文里整帧变量也常叫 `payload`，所以代码会出现 `payload?.payload?.runId` 这种"双层"写法，但**协议上只有一层 payload**，是变量名重复造成的视觉假象。

第 4 参数 meta 不进帧，仅供网关侧上下文使用（如审计日志），plugin / UI 都拿不到。

### 3. agent / agent.wait 全部 respond 分支 payload 顶层都含 runId

OpenClaw `agent.ts` 全部 6 个 respond 调用：

| 来源 | payload 顶层 |
|------|--------------|
| `agent.ts:1118` (accepted phase-1) | `{ runId, status: "accepted", acceptedAt }` |
| `agent.ts:354` (phase-2 ok) | `{ runId, status: "ok", summary, result }` |
| `agent.ts:382` (phase-2 error) | `{ runId, status: "error", summary }` |
| `agent.ts:1327` (wait dedupe 真终态) | `{ runId, status, startedAt, endedAt, error, stopReason, livenessState, yielded }` |
| `agent.ts:1378` (wait timeout) | `{ runId, status: "timeout" }` |
| `agent.ts:1384` (wait race 终态) | `{ runId, status, startedAt, endedAt, ... }` |

注意 `agent.ts:1118` 写法 `respond(true, accepted, undefined, { runId })` —— 第 4 参数的 `{ runId }` 是 meta 不进帧，但第 2 参数 `accepted` 这个 object 顶层本身就有 `runId` 字段。

`chat.send`（chat.ts:1968 / 2049 / 2063）顶层也含 runId（`{ runId, status: "in_flight"/"started" }`）。CoClaw UI 当前不走 chat.send 路径。

### 4. 其他 RPC 顶层 res payload 不含 runId

已扫 OpenClaw 全部 server-methods：`sessions.* / agents.* / topics.* / models.* / status / usage.cost / channels.status / coclaw.*`（CoClaw UI 实际在用的）res payload 顶层均无 runId。基于"payload 顶层有 runId"识别 agent run 类响应不会误命中。

---

## 八、lifecycle:end 一次 run 内会多次 emit

OpenClaw 一次 agent run 期间 `lifecycle:end` 事件会被发出**多次**，下游不能凭它判终态：

- **compaction-retry**：context 超限触发 `/compact` 后重启 run，重启前后各 emit 一次 lifecycle:end
- **model-fallback**：当前模型不可用切换到 fallback 模型时，切换前后各 emit 一次

**CoClaw 后果**：阶段 0 设计里"信号 2 lifecycle:end → 挂 RPC grace 等信号 1"会被中途 lifecycle:end 提前触发，phantom 收尾。

**应对**：阶段 1（commit 62dfbbe）拆除 lifecycle:end 作为 endRun 信号源，下游不再监听 lifecycle:end；endRun 信号收敛为"主 RPC 二阶段 res / wait 探测 / 主 RPC reject"三路（详见 §五 §2）。

**事实**：本节内容也记在内部 memory `reference_openclaw_multi_lifecycle_end.md`，OpenClaw 上游源码锚点见该 memory；CoClaw 设计层面的具体改动见 `docs/designs/agent-run-end-detection.md` §8.1。

---

## 九、agent.wait 内部 dedupe-first then race 与"两本本子失忆"

### 1. 内部行为

`agent.wait` 实现（`agent.ts:1297-1394`）分两关：

- **第一关同步翻"真终态登记" dedupe**（`agent-wait-dedupe.ts:138 readTerminalSnapshotFromGatewayDedupe`）：命中即 return，不再看后面
- **第二关 race**：dedupe 等待器 vs `waitForAgentJob`（`agent-job.ts:224-371`）。`timeoutMs=0` 时两条腿都同步短路（cache 命中 / dedupe 命中 / null），race 实际只能由 agent-job cache 决定胜负

### 2. 两个 TTL

| 数据源 | TTL | 锚点 |
|---|---|---|
| 终态登记（dedupe） | **5 分钟** | `server-constants.ts:26`，`server-maintenance.ts:84-97` 定时清扫 |
| agent-job cache | **10 分钟** | `agent-job.ts:4`，懒清理 |

agent-job cache 写入规则（`agent-job.ts:131-198`）：
- end 不带 aborted → 立刻写 "ok"
- end 带 aborted=true → 攥 15s（timeout retry grace）
- error → 攥 15s（error retry grace）
- 下一个 start → 清缓存 + 取消 grace

### 3. 响应字段：dedupe 路径与 race 路径返回字段完全一致

均为 `{ runId, status, startedAt, endedAt, error, stopReason, livenessState, yielded }`。客户端**无法从返回数据分辨来源**——这是为什么不能客户端选择"只信 dedupe"的关键。

### 4. "两本本子失忆"假阴性

run 实际已结束、距离结束已过 10 分钟时，两本本子都被清扫，后续 `wait(timeoutMs=0)` 必然返回 `status='timeout'` 且无 `endedAt`，**与"run 还在跑"无法分辨**。

CoClaw 阶段 1 暴露此问题（详见 `docs/designs/agent-run-end-detection.md` §8.2），阶段 2 通过"plugin 加白名单 + UI 暂存禁用 wait 探测"绕开（§8.3），后续由 plugin 专用查询 API 终结（§8.4）。

**事实**：本节内容也记在内部 memory `reference_openclaw_agent_wait_internals.md`。
