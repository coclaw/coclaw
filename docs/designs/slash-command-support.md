# 斜杠命令支持

> 创建时间：2026-03-18
> 状态：草案
> 研究基础：`docs/openclaw-research/topic-feature-research.md`

---

## 一、概述

### 目标

使 CoClaw UI 能正确发送和处理 OpenClaw 的斜杠命令（`/new`、`/reset`、`/compact`、`/help`、`/subagents` 等），而非将其作为普通文本发给 LLM。

### 问题背景

CoClaw 当前通过 `agent()` RPC 发送所有消息。但 `agent()` 对斜杠命令的支持有限：

- **仅拦截 `/new` 和 `/reset`**（`agent.ts:316`，`RESET_COMMAND_RE`）——调用 `performGatewaySessionReset()`
- **其他所有斜杠命令**（`/compact`、`/help`、`/status`、`/subagents` 等）——**原样作为文本传给 LLM**，不被识别为命令

OpenClaw 的完整命令管线仅在 `chat.send()` 路径中生效（通过 `dispatchInboundMessage` → `handleCommands`）。

### 方案选择

| 方案 | 描述 | 优势 | 劣势 |
|------|------|------|------|
| **A. 混合路径** | 普通消息走 `agent()`，斜杠命令走 `chat.send()` | 改动最小；现有 agent 流程不变 | 需处理两种 RPC 的完成信号 |
| B. 全部走 `chat.send()` | 所有消息统一使用 `chat.send()` | 一套事件模型；斜杠命令自然工作 | 重写事件处理；`chat.send` 无 `extraSystemPrompt` |

**采用方案 A**——改动最小，风险可控。

---

## 二、OpenClaw 命令管线

### chat.send() 支持的命令

`chat.send()` 通过 `handleCommands`（`auto-reply/reply/commands-core.ts:173-203`）按顺序匹配以下处理器：

```
handlePluginCommand        handleBtwCommand
handleBashCommand          handleActivationCommand
handleSendPolicyCommand    handleFastCommand
handleUsageCommand         handleSessionCommand（/new, /reset）
handleRestartCommand       handleTtsCommands
handleHelpCommand          handleCommandsListCommand
handleStatusCommand        handleAllowlistCommand
handleApproveCommand       handleContextCommand
handleExportSessionCommand handleWhoamiCommand
handleSubagentsCommand     handleAcpCommand
handleConfigCommand        handleDebugCommand
handleModelsCommand        handleCompactCommand
handleAbortTrigger
```

所有命令在 `chat.send` 路径中都被正确拦截和处理。

### agent() 的局限

`agent()` handler（`gateway/server-methods/agent.ts`）仅在 line 316 匹配：

```js
const RESET_COMMAND_RE = /^\/(new|reset)(?:\s+([\s\S]*))?$/i;
```

其他斜杠命令不经过 `handleCommands`，直接传入 `agentCommandFromIngress` → `runEmbeddedPiAgent`，作为普通 user message 发给 LLM。

---

## 三、关键发现：runId 全链路一致

`chat.send()` 触发的 agent run 与 `agent()` 触发的 agent run 共享同一套 `event:agent` 广播。且 **runId 全链路一致**：

```
UI 生成 idempotencyKey (UUID)
  → chat.send({ sessionKey, message, idempotencyKey })
  → ACK: { runId: idempotencyKey, status: "started" }
       ↓ 如果命令触发了 agent run（如 /new hello）
  → agent run 使用同一个 runId                    [agent-runner-execution.ts:110]
  → event:agent 广播携带同一个 runId               [server-chat.ts:530-582]
```

**源码追踪**：
1. `clientRunId = p.idempotencyKey`（`chat.ts:1195`）
2. ACK 返回 `{ runId: clientRunId }`（`chat.ts:1258`）
3. `dispatchInboundMessage` 接收 `replyOptions.runId = clientRunId`（`chat.ts:1345`）
4. agent run 注册：`runId = params.opts?.runId ?? crypto.randomUUID()`（`agent-runner-execution.ts:110`）
5. 所有 `emitAgentEvent` 使用该 `runId`
6. `event:agent` 广播时无转换：`clientRunId = evt.runId`（`server-chat.ts:530`，因 `chatLink` 为 `undefined`）

**结论**：UI 可以用 `chat.send` ACK 中的 `runId` 直接匹配后续的 `event:agent` 事件。现有的 `__onAgentEvent` 处理逻辑**完全不需要改动**。

---

## 四、两类斜杠命令的事件模型

### 类型 1：触发 agent run 的命令

如 `/new hello`（reset 后以 `hello` 为首条消息启动 agent run）。

```
chat.send ACK: { runId, status: "started" }
  ↓
event:agent { runId, stream: "lifecycle", data: { phase: "start" } }
event:agent { runId, stream: "assistant", data: { text, delta } }
event:agent { runId, stream: "lifecycle", data: { phase: "end" } }
  ↓
event:chat  { runId, state: "final", message: { role: "assistant", ... } }
```

UI 处理流程：
1. 收到 ACK → 记录 `runId`，开始监听
2. `event:agent` 事件 → 现有 streaming 逻辑处理（零改动）
3. `event:chat` `state: "final"` → 标记完成

### 类型 2：不触发 agent run 的命令

如 `/compact`、`/help`、`/status`、`/subagents`、裸 `/new`（无尾部消息）等。

```
chat.send ACK: { runId, status: "started" }
  ↓
（无 event:agent 事件）
  ↓
event:chat  { runId, state: "final", message: { role: "assistant", content: [...] } }
```

UI 处理流程：
1. 收到 ACK → 记录 `runId`，开始监听
2. **无 `event:agent` 事件**
3. `event:chat` `state: "final"` → 提取 `message` 渲染为命令结果

### 统一处理逻辑

两种类型可以用同一套逻辑处理：

1. 发送 `chat.send()` → 记录 `runId`
2. 同时监听 `event:agent`（现有逻辑）和 `event:chat`
3. `event:agent` 按现有方式处理 streaming
4. `event:chat` `state: "final"` 作为**终结信号**
5. 若从未收到 `event:agent` 且直接收到 `event:chat` `final` → 纯命令结果，直接渲染

---

## 五、chat.send 的参数与 ACK

### 参数

```js
{
  method: 'chat.send',
  params: {
    sessionKey: 'agent:main:main',  // 必填
    message: '/compact',             // 必填（可为空字符串用于 reset）
    idempotencyKey: crypto.randomUUID(),  // 必填
    // thinking: 'enabled',          // 可选
    // deliver: false,               // chat.send 无此参数
    // attachments: [...],           // 可选
  }
}
```

**注意**：`chat.send` 没有 `deliver` 参数（webchat 路径不涉及外部渠道投递）。也没有 `extraSystemPrompt`。

### ACK 响应

```json
{ "runId": "<idempotencyKey>", "status": "started" }
```

与 `agent()` ACK 的 `{ runId, status: "accepted" }` 类似，但 status 值不同。

---

## 六、event:chat 事件格式

### delta（LLM 流式片段）

```json
{
  "runId": "...",
  "sessionKey": "agent:main:main",
  "seq": 1,
  "state": "delta",
  "message": {
    "role": "assistant",
    "content": [{ "type": "text", "text": "partial..." }],
    "timestamp": 1742000000
  }
}
```

限流：最多每 150ms 一条。

### final（完成）

```json
{
  "runId": "...",
  "sessionKey": "agent:main:main",
  "seq": 2,
  "state": "final",
  "stopReason": "end_turn",
  "message": {
    "role": "assistant",
    "content": [{ "type": "text", "text": "complete response" }],
    "timestamp": 1742000000
  }
}
```

对于纯斜杠命令（无 agent run），`message` 包含命令处理结果文本。`message` 在某些场景下可能缺失（如静默 reply）。

### error

```json
{
  "runId": "...",
  "sessionKey": "agent:main:main",
  "seq": 2,
  "state": "error",
  "errorMessage": "..."
}
```

---

## 七、UI 实现方案

### 7.1 发送逻辑

在 `chat.store.js` 的 `sendMessage` 中，发送前检测消息是否为斜杠命令：

```js
const isSlashCommand = /^\/\w/.test(text.trim());

if (this.topicMode) {
  agentParams.sessionId = this.sessionId;
  // topic 模式不支持斜杠命令（无 sessionKey），始终走 agent()
} else if (isSlashCommand) {
  // 斜杠命令走 chat.send
  return this.__sendViaChatSend(conn, text, this.chatSessionKey);
} else {
  agentParams.sessionKey = this.chatSessionKey;
  // 普通消息走 agent()
}
```

### 7.2 __sendViaChatSend 方法

```js
async __sendViaChatSend(conn, message, sessionKey) {
  const idempotencyKey = crypto.randomUUID();

  // 注册 event:chat 监听
  const chatEventHandler = (evt) => {
    if (evt.runId !== idempotencyKey) return;
    if (evt.state === 'final') {
      // 完成：渲染命令结果
      conn.off('event:chat', chatEventHandler);
      conn.off('event:agent', this.__onAgentEvent);
      this.__finalizeChatSend(evt);
    } else if (evt.state === 'error') {
      conn.off('event:chat', chatEventHandler);
      conn.off('event:agent', this.__onAgentEvent);
      this.__handleChatSendError(evt);
    }
  };

  // 同时监听 event:agent（处理 /new <message> 等触发 agent run 的场景）
  conn.on('event:agent', this.__onAgentEvent);
  conn.on('event:chat', chatEventHandler);

  this.streamingRunId = idempotencyKey;

  const ack = await conn.request('chat.send', {
    sessionKey,
    message,
    idempotencyKey,
  });
  // ack.runId === idempotencyKey
}
```

### 7.3 命令结果渲染

对于不触发 agent run 的命令（`/compact`、`/help` 等），`event:chat` `final` 中的 `message` 直接作为 assistant 消息追加到消息列表：

```js
__finalizeChatSend(evt) {
  this.sending = false;
  this.streamingRunId = null;
  if (evt.message) {
    this.messages.push({
      type: 'message',
      id: `chat-${evt.runId}`,
      message: evt.message,
    });
  }
  // 对于 /new：重新加载消息（session 已 reset）
  // 对于 /compact：重新加载消息（transcript 已压缩）
}
```

### 7.4 特殊命令的后处理

| 命令 | 后处理 |
|------|--------|
| `/new`、`/reset` | 重新调用 `loadMessages()` 刷新消息列表；重新获取 `currentSessionId`；刷新 chat history |
| `/compact` | 重新调用 `loadMessages()` 刷新消息列表 |
| `/help`、`/status` 等 | 无特殊处理，命令结果已渲染 |

命令类型的判断可以基于发送时的原始消息文本（`/^\/new(\s|$)/` 等正则匹配）。

---

## 八、chat.send 对 session_start 钩子的影响

通过 `chat.send` 发送 `/new` 或 `/reset` 时，消息进入 auto-reply 管线（`commands-core.ts`），该路径**会触发 `session_start` 插件钩子**。这解决了 `chat-history-tracking.md` 中标记的 TODO——切换到 `chat.send` 后，session reset 的钩子缺口自然消除。

| 场景 | 之前（agent() 路径） | 之后（chat.send 路径） |
|------|:---:|:---:|
| 用户发 `/new` | `session_start` 不触发 | **✓ 触发** |
| 用户发 `/reset` | `session_start` 不触发 | **✓ 触发** |
| 自动过期 | ✓ 触发 | ✓ 触发（不变） |

---

## 九、实施步骤

1. **chat.store.js**：`sendMessage` 中添加斜杠命令检测，分流到 `__sendViaChatSend`
2. **chat.store.js**：实现 `__sendViaChatSend` 方法（`chat.send` RPC + `event:chat` 监听 + `event:agent` 复用）
3. **chat.store.js**：实现 `__finalizeChatSend` 和 `__handleChatSendError`
4. **chat.store.js**：实现特殊命令后处理（`/new` → reload，`/compact` → reload）
5. **ChatPage.vue**：可能需要在 reconcile 中处理 `/new` 导致的 session 变更（currentSessionId 更新、路由更新）
6. **测试**：覆盖 `/new`、`/new <message>`、`/compact`、`/help` 等场景

---

## 十、关键源码引用

| 用途 | 文件路径 |
|------|---------|
| agent() 斜杠命令拦截 | `src/gateway/server-methods/agent.ts:67,316-340` |
| chat.send handler | `src/gateway/server-methods/chat.ts:1106-1503` |
| clientRunId 生成 | `src/gateway/server-methods/chat.ts:1195` |
| chat.send ACK | `src/gateway/server-methods/chat.ts:1258-1262` |
| runId 传递到 agent run | `src/gateway/server-methods/chat.ts:1345` → `agent-runner-execution.ts:110` |
| event:agent 广播（runId 不转换） | `src/gateway/server-chat.ts:530-582` |
| event:chat 广播（final） | `src/gateway/server-chat.ts:470-488` |
| 命令管线入口 | `src/auto-reply/reply/commands-core.ts:173-203` |
| chat.send 参数 schema | `src/gateway/protocol/schema/logs-chat.ts:34-47` |

> 以上路径均基于本地同步的 OpenClaw 源码（`./openclaw-repo/openclaw/`）。
