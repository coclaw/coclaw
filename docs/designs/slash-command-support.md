# 斜杠命令支持

> 创建时间：2026-03-18
> 实现时间：2026-03-18
> 状态：已实现（初期）
> 研究基础：`docs/openclaw-research/topic-feature-research.md`

---

## 一、概述

### 目标

使 CoClaw UI 能正确发送和处理 OpenClaw 的斜杠命令（`/new`、`/compact`、`/help` 等），而非将其作为普通文本发给 LLM。

### 问题背景

CoClaw 通过 `agent()` RPC 发送所有消息。但 `agent()` 对斜杠命令的支持有限：

- **仅拦截 `/new` 和 `/reset`**（`agent.ts:316`，`RESET_COMMAND_RE`）——调用 `performGatewaySessionReset()`
- **其他所有斜杠命令**（`/compact`、`/help`、`/status` 等）——**原样作为文本传给 LLM**，不被识别为命令

OpenClaw 的完整命令管线仅在 `chat.send()` 路径中生效（通过 `dispatchInboundMessage` → `handleCommands`）。

### 方案选择

| 方案 | 描述 | 优势 | 劣势 |
|------|------|------|------|
| **A. 混合路径** | 普通消息走 `agent()`，斜杠命令走 `chat.send()` | 改动最小；现有 agent 流程不变 | 需处理两种 RPC 的完成信号 |
| B. 全部走 `chat.send()` | 所有消息统一使用 `chat.send()` | 一套事件模型；斜杠命令自然工作 | 重写事件处理；`chat.send` 无 `extraSystemPrompt` |

**采用方案 A**——改动最小，风险可控。

### 实现范围

当前实现 2 个命令：`/compact`、`/new`。通过 UI 菜单按钮触发，暂不检测输入框中的斜杠前缀。`/help` 暂未启用。

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

## 三、关键发现：idempotencyKey 与 runId

`chat.send()` 和 `agent()` 都要求传入 `idempotencyKey`，且该值直接成为 `runId`，贯穿全链路。

### chat.send 路径

```
UI 生成 idempotencyKey (UUID)
  → chat.send({ sessionKey, message, idempotencyKey })
  → ACK: { runId: idempotencyKey, status: "started" }
       ↓ 如果命令触发了 agent run（如 /new hello）
  → agent run 使用同一个 runId                    [agent-runner-execution.ts:110]
  → event:agent 广播携带同一个 runId               [server-chat.ts:530-582]
  → event:chat final 使用同一个 runId              [server-chat.ts:470-488]
```

### agent() 路径

```
UI 生成 idempotencyKey (UUID)
  → agent({ message, idempotencyKey, ... })
  → const runId = idem;                           [agent.ts:450]
  → ACK: { runId, status: "accepted" }            [agent.ts:565]
  → event:agent 广播携带同一个 runId
```

---

## 四、架构决策：独立流程，仅 event:chat

### 问题：双事件监听的生命周期冲突

若斜杠命令同时监听 `event:agent` 和 `event:chat`，对于 `/new`（会触发 agent run）：

1. `event:agent` lifecycle `phase: "end"` → 触发 `__cleanupTimersAndListeners()` → 清除 `streamingRunId`、移除所有监听
2. 随后 `event:chat` `state: "final"` 到达 → 监听已被移除，无法处理后续逻辑

两套独立的完成处理逻辑会互相干扰。

### 解决方案：斜杠命令仅监听 event:chat

```
┌───────────────────────────────────────────────┐
│  普通消息:  sendMessage()                       │
│    → agent() RPC                               │
│    → event:agent 流式处理（现有逻辑，零改动）      │
│    → __reconcileMessages() → loadMessages()    │
├───────────────────────────────────────────────┤
│  斜杠命令:  sendSlashCommand()                  │
│    → chat.send() RPC                           │
│    → event:chat 完成处理（独立逻辑）              │
│    → 按命令类型后处理                             │
└───────────────────────────────────────────────┘
```

对于 `/new` 触发的 agent run（greeting），不做流式渲染，而是在 `event:chat final` 后调用 `loadMessages({ silent: true })` 一次性加载完整结果。

**取舍**：`/new` 的 greeting 不流式显示，用户感知上是"重置 → 短暂等待 → 消息刷新"。

> **⚠️ 已知限制**：`/new` 触发的 agent run 实际耗时可能较长——agent 会分析当前对话并形成持久记忆（session summary），而非仅生成简短 greeting。在此期间用户仅看到 sending 状态，无"思考中"等 agent 处理进度展示。需后续迭代解决 `event:agent` / `event:chat` 生命周期协调问题（见 TODO）。

---

## 五、event:chat 事件格式

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

## 六、UI 实现

### 6.1 操作入口：SlashCommandMenu 组件

**文件**：`src/components/chat/SlashCommandMenu.vue`

- 使用 `UDropdownMenu`（`content: { side: 'top', align: 'start' }`）
- 触发按钮：ghost/primary 的 `i-lucide-chevron-right` 图标按钮
- 定位：ChatInput footer 外部上方，`absolute bottom-full left-0`，透明背景不影响内容区

菜单项：

| label | icon | 命令 |
|-------|------|------|
| 压缩上下文 | `i-lucide-archive` | `/compact` |
| 重置会话 | `i-lucide-refresh-cw` | `/new` |
| 帮助 | `i-lucide-help-circle` | `/help` |

**可见性条件**（ChatPage `showSlashMenu` 计算属性）：
- 非 topic 路由（`!isTopicRoute`）
- 有 sessionKey（`!!chatStore.chatSessionKey`）

**禁用条件**：
- `chatStore.sending || isBotOffline || chatStore.loading`

### 6.2 ChatPage 布局

```html
<main>...messages...</main>
<div class="relative">
  <SlashCommandMenu
    v-if="showSlashMenu"
    class="absolute bottom-full left-0 z-10 pb-1"
    :disabled="chatStore.sending || isBotOffline || chatStore.loading"
    @command="onSlashCommand"
  />
  <ChatInput ... />
</div>
```

`onSlashCommand(cmd)` 调用 `chatStore.sendSlashCommand(cmd)`，通过 `try/catch` 捕获错误并 `notify.error`。

### 6.3 sendSlashCommand（chat.store.js）

核心流程：

```js
async sendSlashCommand(command) {
  // 前置守卫：conn 就绪 + 非 sending
  // 1. 设置 sending = true
  // 2. 生成 idempotencyKey，记录到 __slashCommandRunId
  // 3. 创建 settle Promise（__slashCommandResolve / __slashCommandReject）
  // 4. 注册 event:chat 监听（__chatEventHandler）
  // 5. 设置 30s 超时 → reject
  // 6. await conn.request('chat.send', { sessionKey, message, idempotencyKey })
  // 7. return settlePromise（等待 event:chat final/error 或超时）
}
```

**Promise 模型**：`sendSlashCommand` 返回的 Promise 在以下时机 settle：
- `event:chat state: "final"` → **resolve**
- `event:chat state: "error"` → **reject**（`SLASH_CMD_ERROR`）
- 30s 超时 → **reject**（`SLASH_CMD_TIMEOUT`）
- RPC 异常 → **reject**（原始错误）

这确保调用方（ChatPage）能通过 `try/catch` 捕获所有错误并给出用户反馈。

### 6.4 __onChatEvent 处理逻辑

```js
__onChatEvent(evt) {
  // 仅处理匹配 __slashCommandRunId 的事件
  if (evt.state === 'final') {
    cleanup → resolve
    // /new|/reset → 先快照旧 session（prevSessionId + prevMessages），
    //               再 loadMessages({ silent: true })；
    //               若 session 确实轮换，将旧消息追加为 historySegment
    // /compact    → loadMessages({ silent: true })
    // /help 等   → 本地追加 evt.message 为 assistant 消息
  }
  else if (evt.state === 'error') {
    cleanup → reject
  }
}
```

### 6.5 命令后处理

| 命令 | event:agent | event:chat final | 后处理 |
|------|:-----------:|:----------------:|--------|
| `/new` | 有（greeting agent run），但不监听 | 有 | 快照旧 session → `loadMessages({ silent: true })` → 本地追加旧消息为 `historySegment`；ChatPage 异步 fire-and-forget `__loadChatHistory()` |
| `/compact` | 无 | 有（结果消息） | `loadMessages({ silent: true })` |
| `/help` | 无 | 有（帮助文本） | 本地追加 `evt.message`，无需 reload |

### 6.6 /new 的 sessionId 边界处理

`chat.send('/new')` 执行 session reset 后，新的 `sessionId` **不会**出现在 `event:chat final` 响应中。

刷新机制：`loadMessages({ silent: true })` 内部调用 `chat.history` RPC，返回当前 sessionKey 对应的活跃 sessionId，自然更新 `currentSessionId`。

时序：

```
1. chat.send({ message: '/new', idempotencyKey })
2. ACK: { runId, status: "started" }
3. OpenClaw: reset session（新 sessionId 生成）+ greeting agent run
4. event:chat: state: "final"
5. __onChatEvent：
   a. 快照旧 session（prevSessionId + prevMessages，过滤 _local 乐观消息）
   b. loadMessages({ silent: true })
      → sessions.get 返回新 session 的消息
      → chat.history 返回新 sessionId → currentSessionId 更新
   c. 若 currentSessionId 确实变化且旧消息非空 → 追加为 historySegment（含去重）
6. ChatPage.onSlashCommand：异步 fire-and-forget __loadChatHistory() 刷新孤儿列表
```

> **设计要点**：旧 session 消息由客户端本地保存为 historySegment，不依赖服务端 `session_start` 钩子的异步磁盘写入（`coclaw-chat-history.json`）即时可见性。这避免了 WSL2 / 高延迟磁盘环境下的竞态条件。

### 6.7 清理与安全

- **`__cleanupSlashCommand(conn)`**：清理 timer、event:chat 监听、所有内部标志、resolve/reject 引用
- **`cleanup()`**（页面离开）：级联调用 `__cleanupSlashCommand`，确保不会泄漏监听或 timer
- **`sending` 守卫**：防止常规消息发送和斜杠命令并发
- **runId 过滤**：`__onChatEvent` 仅处理匹配 `__slashCommandRunId` 的事件，忽略其他 run 的事件

---

## 七、chat.send 对 session_start 钩子的影响

通过 `chat.send` 发送 `/new` 或 `/reset` 时，消息进入 auto-reply 管线（`commands-core.ts`），该路径**会触发 `session_start` 插件钩子**。

| 场景 | 之前（agent() 路径） | 之后（chat.send 路径） |
|------|:---:|:---:|
| 用户发 `/new` | `session_start` 不触发 | **触发** |
| 用户发 `/reset` | `session_start` 不触发 | **触发** |
| 自动过期 | 触发 | 触发（不变） |

---

## 八、文件变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/components/chat/SlashCommandMenu.vue` | 新建 | 斜杠命令菜单组件 |
| `src/views/ChatPage.vue` | 修改 | 引入菜单，`showSlashMenu` 计算属性，`onSlashCommand` 方法，布局调整 |
| `src/stores/chat.store.js` | 修改 | 新增 `sendSlashCommand`、`__onChatEvent`、`__cleanupSlashCommand`；`cleanup` 追加斜杠命令清理 |
| `src/i18n/locales/zh-CN.js` | 修改 | 新增 `slashCmd` 翻译键 |
| `src/i18n/locales/en.js` | 修改 | 新增 `slashCmd` 翻译键 |
| `src/stores/chat.store.test.js` | 修改 | 新增 8 个斜杠命令单元测试 |
| `e2e/slash-command.e2e.spec.js` | 新建 | 5 个 E2E 测试 |

---

## 九、TODO（后续迭代）

- 检测用户输入 `/` 前缀时自动弹出命令菜单
- 输入框内容作为斜杠命令参数（如 `/new hello`）
- `/new` agent run 流式渲染（需解决 event:agent / event:chat 生命周期协调；当前 agent 会执行 session summary 等耗时操作，用户无进度反馈）
- 斜杠命令的取消支持（stop 按钮）
- 更多命令扩展（`/status`、`/subagents` 等）
- **斜杠命令结果消息分组**：`/compact` 等命令的 server 返回消息（assistant role）因无前置 user message 分隔，被 `groupSessionMessages` 归入上一个 botTask。需在分组逻辑中识别命令结果消息并独立展示
- **宽屏展开按钮位置优化**：窄屏下按钮在 input row 左侧（当前位置）；宽屏下可考虑将按钮绝对定位到 footer 最左侧，不干扰 input row 布局
- **chat 路由重构**：将 `/chat/:sessionId` 改为 `/chat/:botId/:agentId`（对应 `agent:<agentId>:main` sessionKey），消除对 sessionId 的路由依赖。当前 `/new` 后需 `router.replace` 同步新 sessionId 作为缓解方案，根本方案是路由不再依赖会变的 sessionId

---

## 十、关键源码引用

| 用途 | 文件路径 |
|------|---------|
| agent() 斜杠命令拦截 | `openclaw-repo/src/gateway/server-methods/agent.ts:67,316-340` |
| agent() idempotencyKey → runId | `openclaw-repo/src/gateway/server-methods/agent.ts:196,450` |
| chat.send handler | `openclaw-repo/src/gateway/server-methods/chat.ts:1106-1503` |
| clientRunId 生成 | `openclaw-repo/src/gateway/server-methods/chat.ts:1195` |
| chat.send ACK | `openclaw-repo/src/gateway/server-methods/chat.ts:1258-1262` |
| runId 传递到 agent run | `openclaw-repo/src/gateway/server-methods/chat.ts:1345` → `agent-runner-execution.ts:110` |
| event:agent 广播（runId 不转换） | `openclaw-repo/src/gateway/server-chat.ts:530-582` |
| event:chat 广播（final） | `openclaw-repo/src/gateway/server-chat.ts:470-488` |
| 命令管线入口 | `openclaw-repo/src/auto-reply/reply/commands-core.ts:173-203` |
| chat.send 参数 schema | `openclaw-repo/src/gateway/protocol/schema/logs-chat.ts:34-47` |
| performGatewaySessionReset | `openclaw-repo/src/gateway/session-reset-service.ts:246-346` |

> 以上路径均基于本地同步的 OpenClaw 源码（`./openclaw-repo/openclaw/`）。
