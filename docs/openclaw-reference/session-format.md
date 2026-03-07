# OpenClaw Session JSONL 格式说明

> 本文档描述 OpenClaw 会话 JSONL 文件的数据格式，以及 CoClaw UI 基于此格式的分组渲染策略。

## 文件位置与命名

- 路径：`~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`
- 变体：
  - `<sessionId>.jsonl` — 活跃会话
  - `<sessionId>.jsonl.reset.<timestamp>` — 重置归档
  - `<sessionId>.jsonl.deleted.<timestamp>` — 已删除（列表时排除）

## JSONL 条目结构

每行一个 JSON 对象，顶层字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `string` | 条目类型。消息为 `"message"`，其他有 `"session"` / `"model_change"` / `"custom"` 等 |
| `id` | `string` | 条目唯一 ID |
| `message` | `object` | 当 `type === "message"` 时存在 |

## Message 对象

```jsonc
{
  "role": "user" | "assistant" | "toolResult",
  "content": ContentBlock[] | string,
  "timestamp": 1771572311573,       // 毫秒时间戳
  "model": "gpt-5.3-codex",         // assistant 独有
  "provider": "openai-codex",       // assistant 独有
  "api": "openai-codex-responses",  // assistant 独有
  "stopReason": "stop" | "toolUse", // assistant 独有
  "toolCallId": "call_xxx",         // toolResult 独有
  "toolName": "tool_name",          // toolResult 独有
  "isError": false                  // toolResult 独有
}
```

## Content Block 类型

### text
```json
{ "type": "text", "text": "回复内容" }
```

### thinking
```json
{ "type": "thinking", "thinking": "推理过程文本" }
```

### toolCall
```json
{
  "type": "toolCall",
  "id": "call_xxx",
  "name": "tool_name",
  "arguments": { "key": "value" }
}
```

> `role=user` 的 content 也可能是纯字符串而非数组。

## stopReason 语义

| 值 | 含义 |
|----|------|
| `stop` / `end_turn` | 模型自然结束，text blocks 为最终回复 |
| `toolUse` | 模型发起工具调用，后续会有 toolResult |

## runId 与 mid-task 中断

- OpenClaw 的 tool call 链形成一次"bot task"（用户发一次消息 → 模型经过 N 轮 tool call → 最终输出）
- 若 task 被 steer（中断），最后一条 assistant 的 `stopReason` 不会是 `stop`，而是 `toolUse` 后无后续 toolResult，直到下一条 user 消息
- CoClaw UI 将这种情况视为"任务未完成"

## CoClaw UI 分组渲染策略

### 目标

将扁平 JSONL 条目按 "user → bot task → user → bot task" 交替分组渲染。bot task 内部折叠中间过程，仅展示最终结果。

### 分组规则（思路 B — 按 role 切换分组）

1. 跳过 `type !== "message"` 的条目（session / model_change / custom 等）
2. 遇到 `role=user` → 结束当前 botTask（若有）、push user item、等待下一个 botTask
3. 遇到 `role=assistant` 或 `role=toolResult` → 归入当前 botTask

### 输出数据结构

```javascript
// User item
{ type: 'user', id, textContent, timestamp }

// Bot task item
{
  type: 'botTask',
  id,              // 首条 assistant 的 id
  resultText,      // stopReason=stop 的 assistant 的 text blocks（null 表示未完成）
  model,           // 最终 assistant 的 model
  timestamp,       // 最终 assistant 的 timestamp
  steps: [         // 中间过程
    { kind: 'thinking', text },
    { kind: 'toolCall', name },
    { kind: 'toolResult', text },
  ],
}
```

### 中间过程提取规则

- assistant 的 `thinking` blocks → `steps[kind=thinking]`
- assistant 的 `toolCall` blocks → `steps[kind=toolCall]`
- toolResult 的 text content → `steps[kind=toolResult]`
- 中间 assistant（`stopReason=toolUse`）的 text blocks（若有）也归入 steps
- `stopReason=stop/end_turn` 的 assistant：text blocks 提取为 `resultText`
