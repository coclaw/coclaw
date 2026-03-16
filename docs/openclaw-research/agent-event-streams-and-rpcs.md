# OpenClaw Agent 事件流与相关 RPC

> 更新时间：2026-03-16
> 基于 OpenClaw 本地源码验证

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
  "status": "done" | "error" | "timeout",
  "startedAt": 1771572313559,
  "endedAt": 1771572320000,
  "error": "..."
}
```

**内部机制**：先检查 dedupe 缓存（已完成的 run 会被缓存），若未缓存则监听 lifecycle 事件直到 `phase: "end"` 或 `phase: "error"`。

**应用场景**：
- 确认 run 完成后再读取 `chat.history`，确保数据完整
- WS 断连重连后，对正在执行的 agent run 进行恢复跟踪：重连后用 `agent.wait(runId)` 等待其完成，然后刷新消息

### 3. `sessions.get`（网关内部）

读取原始 JSONL 消息。不在 `BASE_METHODS` 中但 handler 存在。

**参数**：`key`（sessionKey）、`limit`

### 4. 无按 runId 过滤的 RPC

目前没有 RPC 能只获取某一次 run 的消息——只能读取完整 session。

---

## 三、JSONL 写入时序

- OpenClaw 使用 `SessionManager.appendMessage()` 写入 JSONL，底层为 `fs.appendFileSync`（同步写入）
- 消息在 agent run 过程中逐条写入（tool call → tool result → assistant → ...），**不是** run 结束后批量写入
- `lifecycle:end` 事件在所有消息写入后才发射
- 因此，`lifecycle:end` 到达时 JSONL 文件已包含本次 run 的全部消息

---

## 四、原生 UI 的消息刷新策略

1. 流式期间：用 `event:chat`（delta）显示文本，用 `event:agent`（tool）显示工具卡片
2. 收到 `event:chat` 的 `state: "final"` 后：
   - 如果本次 run 有 tool 事件 → 调用 `chat.history` 重载完整历史
   - 如果没有 tool 事件 → 直接用 final 中附带的 message
3. 重载是原子替换 `chatMessages` 数组，避免闪烁
