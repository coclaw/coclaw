# OpenClaw 消息 ID 通道与 Transcript 推送事件

> 更新时间：2026-05-09
> 基于 OpenClaw 本地源码核实（`openclaw-repo/`）+ 实际 jsonl 文件抽样（`~/.openclaw/agents/main/sessions/`）
> 关注点：CoClaw UI 如何精准追踪/对账 OpenClaw 持久化的每条 message

---

## 摘要

OpenClaw 在持久化层（pi-coding-agent SessionManager）每条 message 写入 jsonl 时都会生成一个 **session 内唯一的 8 字符 hex id**，并在 2026 年 3 月通过 `__openclaw.id` 字段把这个 id 暴露给外部 RPC 调用方，同时新增了 `session.message` WebSocket 事件**实时推送**每条落盘消息的快照（含 messageId）。

但能力分布不均：

- **pi-embedded runner**（CoClaw 主路径）：流式期间每条 message 落盘后立即 push 一次 `session.message`，UI 可以**实时**拿到 messageId
- **ACP / CLI runner**（CoClaw 也有用户用，例如 Claude Code 通过 ACP 接入）：run 结束后批量落盘，**完全不发** `session.message` push；id 只能通过 `loadMessages` 主动 pull 拉到

下游设计跨这两条路径时不能假设 push 通道一定可用。

---

## 一、JSONL Entry ID

### 1. 生成位置与格式

- 源码：`pi-coding-agent/dist/core/session-manager.js:13-21`、`580-590`
- 函数：`generateId(byId)` — 用 `randomUUID().slice(0, 8)` 生成，session 内查重；100 次冲突后回退到完整 UUID（实测样本中未出现过）
- 写入函数：`SessionManager.appendMessage(message)` 内部组装 `{ type:"message", id: generateId(byId), parentId, timestamp, message }` 后 `appendFileSync` 同步落盘

### 2. 实测样本

```
{"type":"session","version":3,"id":"6a2b10ea-529e-41c1-88e2-9b1610a96d52", ...}        ← session 头：完整 UUID
{"type":"message","id":"ab563680","parentId":"66494af6","timestamp":"2026-05-07T22:00:10.858Z","message":{"role":"user", ...}}
{"type":"message","id":"f4258a47","parentId":"6e9911dc","timestamp":"2026-05-07T22:00:21.474Z","message":{"role":"assistant", ...}}
{"type":"message","id":"760b805d","parentId":"f4258a47","timestamp":"2026-05-07T22:00:23.306Z","message":{"role":"toolResult","toolCallId":"call_7Nf...", ...}}
```

session 头是完整 UUID（即 sessionId 自身）；其余每行 entry（`message` / `model_change` / `thinking_level_change` / `custom` / `compaction` / 等）都带 8 字符 hex id。

### 3. 稳定性

- jsonl 是 append-only，写入后 entry 的 id 永不再变 → 多次读取拿到同一 id
- **session 内唯一**（写入时 collision-check）
- **跨 session 不保证唯一** —— 不同 jsonl 文件完全可能有相同 8 字符 id 撞车

也即：**真正的全局主键是 `(sessionId, messageId)` 复合键**，单 messageId 字段不全局唯一。

### 4. Gateway-injected 类消息也有 id

OpenClaw 自己注入的消息（abort partial、delivery-mirror、chat-transcript-inject、auto-reply 静默 ack 等）都走 `SessionManager.appendMessage` 落盘，pi 强制 `generateId`，**id 字段不会缺失**。来源：`gateway/server-methods/chat-transcript-inject.ts:102-115`、`config/sessions/transcript.ts:280-291`。

唯一例外：`role:"system"` 的 compaction divider 是服务端 `readSessionMessages` 在 fs 路径中**虚拟合成**的（不是单独写一行 jsonl），它的 `__openclaw.id` 取自对应 compaction entry 自己的 id（`gateway/session-utils.fs.ts:142-156`）—— 也是真 id，只是来源是 compaction entry 而非 message entry。

---

## 二、Pull 通道：通过 RPC 暴露

### 1. `attachOpenClawTranscriptMeta` 函数

- 定义：`gateway/session-utils.fs.ts:73`
- 行为：把 jsonl entry 的真实 id + seq 注入到返回的 message 对象上的 `__openclaw` 字段下：
  ```js
  message.__openclaw = { id: entry.id, seq: messageSeq }
  ```
- 调用点：`gateway/session-utils.fs.ts:127-158`（tree-form jsonl 路径）、`:161+`（v1 老格式 fallback）

### 2. 各 pull RPC 的暴露情况

| RPC | 路径 | message 上 id 字段位置 | 备注 |
|-----|------|---------------------|------|
| `chat.history` | `gateway/server-methods/chat.ts:1717-1724` | `message.__openclaw.id` | 走 readSessionMessages，含清洗（base64 剥离、长文本截断到 12000 字符） |
| `sessions.get` | `gateway/server-methods/sessions.ts:1628-1652` | `message.__openclaw.id` | 走 readSessionMessages，含清洗 |
| `coclaw.sessions.getById` | `plugins/openclaw/src/session-manager/manager.js:357-384` | **顶层 `id`**（jsonl 整行原样回传） | plugin 本地实现，跳过 OpenClaw 服务端清洗 |

**两种字段位置都是同一个 8 字符 id**——chat 模式的 `__openclaw.id` 和 topic 模式的顶层 `id` 数值完全一致，只是嵌套位置不同。

### 3. CoClaw UI 当前未使用真 id

`ui/src/utils/message-normalize.js:11-18` 的 `wrapOcMessages` 把 server 返回的 message 上的 `__openclaw.id` **直接丢弃**，自合成 `oc-${role}-${timestamp}` 当 id：

```js
return flatMessages.map((msg, i) => ({
    type: 'message',
    id: msg.timestamp ? `oc-${msg.role}-${msg.timestamp}` : `oc-${i}`,
    message: msg,
}));
```

合成 id 在单 chat 内确定性稳定（同 timestamp + 同 role → 同 id），但**跨 session/跨 chat 必撞**，**同毫秒同 role 也会撞**。

升级到真 id 是独立优化（与 X4 课题解耦）。

---

## 三、Push 通道：`session.message` WebSocket 事件

### 1. 触发机制

OpenClaw 用 monkey-patch 拦截 pi 的 `SessionManager.appendMessage`，在原函数返回（即写盘成功 + 拿到 entry id）后**同步**调用 `emitSessionTranscriptUpdate`：

- monkey-patch 安装：`agents/session-tool-result-guard.ts:268, 449-465, 475`
- 安装入口：`agents/pi-embedded-runner/run/attempt.ts:132`（仅 pi-embedded runner 路径调）
- emitter：`sessions/transcript-events.ts:21-52`

guard wrapper 同步串行（伪代码）：

```js
guardedAppend(msg):
  1. 各种 sanitize / cap / hook
  2. result = originalAppend(finalMessage)        ← pi 同步 appendFileSync 写 jsonl
  3. 从 result 拿到 entry id
  4. emitSessionTranscriptUpdate({ sessionFile, sessionKey, message: finalMessage, messageId: result })
                                                 ← 同步 listener.foreach 触发
  5. return result
```

- emit 严格在写盘**之后**：写盘抛异常 → emit 不会被调用，推送不会发出
- `messageId` 就是 jsonl 落盘的 8 字符 id（`appendMessage` 返回值），与 `pull` 通道拿到的 `__openclaw.id` 一致

### 2. WS 广播

- gateway listener 注册：`gateway/server-runtime-subscriptions.ts:92-94`
- 广播逻辑：`gateway/server-session-events.ts:91-150`
- 同时发出两条 WS 事件：
  - **`session.message`**：顶层带 `messageId` + `messageSeq`，message body 经 `projectChatDisplayMessage` 投影（含瘦身：text 默认裁到 8000 字符上限、image data 剥成 `{omitted:true, bytes}`、thinkingSignature 字段被删等）
  - **`sessions.changed` (phase=`message`)**：同样带 messageId + messageSeq，附加 sessionSnapshot
- 硬条件：`update.message !== undefined`（`server-session-events.ts:91-95`）。emit 时只传 sessionFile 字符串的不广播

### 3. 完整事件示例

```json
{
  "event": "session.message",
  "payload": {
    "sessionKey": "agent:main:main",
    "messageId": "ab563680",
    "messageSeq": 5,
    "message": {
      "role": "assistant",
      "content": [{"type": "text", "text": "Hello..."}],
      "provider": "anthropic",
      "model": "claude-sonnet-4-6",
      "timestamp": 1776504587545,
      "__openclaw": { "id": "ab563680", "seq": 5 }
    },
    "sessionId": "...", "kind": "...", "channel": "...", "status": "...", ...
  }
}
```

注意 `message.__openclaw.id` 与顶层 `messageId` 是同一个值。

### 4. 推送 payload 是"产出物快照"

每条 jsonl 行恰好对应**一次** `session.message` 推送。`message` body 是该行的完整最终内容经 `projectChatDisplayMessage` 投影的版本，**不是流式增量**——但也不是 jsonl 原文（含瘦身）。

要拿无瘦身的原文需要走 pull 通道（`sessions.get`、`chat.history` 也有清洗，但清洗规则不同；`coclaw.sessions.getById` 完全无清洗）。

---

## 四、各 RPC 入口下的 Push 行为差异

| RPC 入口 | user message push session.message？ | assistant push？ | 备注 |
|---------|----|----|---|
| `agent` (pi-embedded) | ✓ 带 messageId | ✓ 带 messageId | 走 guard 通道（CoClaw 主路径） |
| `agent` (ACP runner) | ✗ 不发 | ✗ 不发 | 走 `persistTextTurnTranscript` 兜底，emit 只传 sessionFile 字符串 |
| `agent` (CLI runner) | ✗ 不发 | ✗ 不发 | 同 ACP |
| `chat.send` | ✓ 但**无 messageId** 且 **早于落盘** | ✓ guard 通道（落盘后）| 见下文 §4.2 |
| `chat-transcript-inject` | ✓ 带 messageId | ✓ 带 messageId | 手动调 `emitSessionTranscriptUpdate({ message, messageId })`（不走 guard） |

### 4.1 ACP / CLI runner 不发 push 的原因

ACP / CLI runner 走 `persistTextTurnTranscript`：

- 源码：`agents/command/attempt-execution.ts:101-155`
- 入口：`agent-command.ts:551`（ACP）、`:1148`（CLI）
- 流程：`SessionManager.open(sessionFile)` 拿 raw SessionManager → `appendMessage` 写 user + assistant 各一条 → 最后 `emitSessionTranscriptUpdate(sessionFile)` 单参（line 153）
- guard 不装在这条路径上 → raw `appendMessage` 不触发 emit；最后那次 emit 只传字符串，被 gateway 端 `update.message===undefined` gate 掉

### 4.2 `chat.send` 路径的特殊性

`chat.send` handler `gateway/server-methods/chat.ts:1807` 在 dispatch 之前**单独** emit 一次 user transcript（`buildChatSendTranscriptMessage`，line 783, 2175），**不经过 appendMessage**：

- 推送的 `message` 是手动构造的 user message 对象，**不带 messageId**（因为还没落盘）
- 推送时机**早于落盘**：理论上断网/进程崩溃时会产生"幽灵 user message"（UI 收到推送但 jsonl 里永远没有）
- 落盘动作由后续 `dispatchInboundMessage → auto-reply → agent-command → pi-embedded runner` 完成；runner 内 guard `appendMessage` 时**可能再 emit 一次**同内容 user message（这次带 messageId）—— 重复推送的实际行为未在代码上钉死，需要实测对账

CoClaw UI 主对话用 `agent` RPC（不走 chat.send），仅斜杠命令路径调 chat.send（`ui/src/stores/chat.store.js:928`）；这条路径上的 user 推送特殊性目前不影响 CoClaw。

---

## 五、落盘时序

### 1. pi-embedded：流式逐条实时落盘

pi 在 run 内部把每条 message 转成 `message_end` 事件，逐条调 `appendMessage`：

```
event: message_end (role=assistant) → appendMessage → appendFileSync 写盘 → emit session.message
event: message_end (role=toolResult) → 同上
... 一直到 run 结束
```

源码：`pi-coding-agent/dist/core/agent-session.js:298-309`、`session-manager.js:560-566`。

**用户视角**：跑到第 4 个 tool call 时，前 3 条 assistant/toolResult **已经在 jsonl 里**（fsync 后断电也丢不掉）。

### 2. ACP / CLI runner：run 结束批量落盘

`persistTextTurnTranscript` 在 run 结束时一次性 append 一条 user + 一条 assistant。run 期间 jsonl 没有本轮内容；只有 run 结束后才一并落盘。

### 3. 首条 assistant 之前的 user message 缓冲

pi 有条特殊规则（`session-manager.js:549-566`）：本 session 文件里若还**没有任何 assistant 条目**，当前 entry 留在 `fileEntries` 内存数组中**暂不刷盘**；等第一条 assistant message 落地，再把缓冲里的 user/system 一次性 flush。同一个 SessionManager 实例的整个生命周期内只首次走这条路径。

**对外可观察的影响**：

- `agent` RPC 收到 phase-1 `accepted` 响应那一刻，jsonl 里**还没有**这条 user message（accepted respond 在 dispatch 之前，line `agent.ts:1103-1118`）
- 用户消息真正落盘 + 推送 `session.message`，发生在**第一条 assistant message_end 触发的同一刻**
- 极端情况：run accepted 后还没出第一条 assistant 就 crash → user message 还在内存缓冲 → jsonl 文件可能根本没创建过

### 4. session.message 推送丢失/损坏的情形

- jsonl 写成功但 listener 异常：`transcript-events.ts:46-50` 有 try/catch 包住，单 listener 异常不影响其他
- 慢连接：`server-session-events.ts:130` 用 `dropIfSlow` 保护，慢连接会丢这条 → UI 重新拉 history 可恢复（不是数据损坏）
- 进程崩溃：写盘已 fsync，但 emit 未跑 → 下次 UI 进来 loadMessages 即可看到

---

## 六、与 Agent Stream 事件的关系

| 通道 | 类型 | 频率 | 时序 | 用途 |
|------|------|------|------|------|
| `agent` stream (`stream:"assistant"`) | 流式 chunk | 一条 message 多次 emit（text_delta / text_end / done 各 phase 一次） | 在 message_end 之前持续 emit | 边写边播 |
| `session.message` WS 事件 | 产出物快照 | 一条 message 一次 emit | message_end → appendMessage **写盘后**立即 emit | 落盘后对账 |

### 触发时序图（pi-embedded）

```
pi 内部 message_start
  → emit (OpenClaw handleMessageStart：不发 stream，仅初始化)
pi 内部 message_update × N
  → emit (OpenClaw handleMessageUpdate：emit "agent" stream "assistant" phase=...) × N
pi 内部 message_end
  → emit (OpenClaw handleMessageEnd：可能再 emit 一次最终累积 stream)  ← agent stream 最后一帧
  → appendMessage → appendFileSync 写盘
  → emitSessionTranscriptUpdate(messageId=entry.id)                   ← session.message 推送
```

agent stream 最后一帧（含 final 完整 text）在 session.message **之前** emit，中间隔几个 microtask（同 macrotask 内顺序稳定）。

### Phase 字段语义校正

agent stream `stream:"assistant"` 数据里的 phase 字段 **不是** `streaming/final` 这种"流阶段"标识，而是 OpenAI Responses 风格的 `commentary` / `final_answer`（reasoning vs answer 区分）。

- 定义：`shared/chat-message-content.ts:22-91`
- 来源：从 message 顶层 `phase` 字段或 content 数组里 text 块的 `textSignature` JSON 解析
- **绝大多数 provider 不带 phase**——UI 拿到的多半是 `undefined`

要分"流式中 vs 终态"得**靠事件出现顺序**（多次 message_update 后接一次 message_end → session.message），不是 phase 字段。

### Tool 通道独立

tool stream（`stream:"tool"` / `stream:"item"`）跟 session.message 是两条独立通道：

- tool stream phase：`start / update / delta / end`（`pi-embedded-subscribe.handlers.tools.ts:634/743/785/910`）
- 一条 toolResult message 落盘 → 推 session.message (role=`toolResult`)；同时 tool stream 已经 emit 过多次 `update / delta / end`
- itemId 形如 `tool:<toolCallId>`（`buildToolItemId`）—— 跟 jsonl 8-char id 不是同一回事
- 但 **toolCallId 是共享钥匙**：assistant message 的 `content[].type=tool_use` 块 id 和 toolResult message 的 `tool_use_id` 字段都是同一个 toolCallId，可以用它把 stream 跟 session.message 关联

---

## 七、引入版本时间线

OpenClaw 用 git tag 触发 `npm publish`（`.github/workflows/openclaw-npm-release.yml`），git tag = npm 包版本号。

| 能力 | Commit | 提交日期 | 首个含此 commit 的发布版本 |
|------|--------|---------|--------------------------|
| pi `generateId` + 写 jsonl entry id（v2/v3 session 格式） | pi 原生 | 早于 2026-01 | 早于 `openclaw@2026.1.12` |
| `session-tool-result-guard.ts` monkey-patch（拦截 appendMessage）| `f5d5661a` | 2026-01-12 | `openclaw@2026.1.12` |
| `transcript-events.ts` emitter | `0e49dca5` | 2026-01-17 | `openclaw@2026.1.20` |
| `attachOpenClawTranscriptMeta`（暴露 `__openclaw.id`）| `7b61ca1b06` (PR #50101) | 2026-03-18 | `openclaw@2026.3.22-beta.1` / `2026.3.22` |
| **`session.message` WS 事件首次广播** | `7b61ca1b06`（含 `ee2563a38b`）| 2026-03-18 | `openclaw@2026.3.22-beta.1` / `2026.3.22` |
| emit payload 含 `messageId` 字段 | `7b61ca1b06` | 2026-03-18 | `openclaw@2026.3.22-beta.1` / `2026.3.22` |
| user message 也参与 transcript 事件推送 | `7b61ca1b06`（含 `c612ba2720`）| 2026-03-18 | `openclaw@2026.3.22-beta.1` / `2026.3.22` |
| transcript event payload 修复（多 session/子 agent 场景）| `762afb1bf0` | 2026-03-27 | `openclaw@2026.3.28-beta.1` / `2026.3.28` |

### 综合最低版本

下游想用"messageId 通道（push + pull）+ 暴露 __openclaw.id"：

- **基础场景（仅主 session）**：≥ `openclaw@2026.3.22`
- **多 session / 子 agent / 分叉对话场景**：≥ `openclaw@2026.3.28`

---

## 八、关键局限与陷阱

1. **ACP / CLI runner 完全不发 `session.message`**——id 通道在这两条路径上是 pull-only。CoClaw 用户里有人通过 ACP 接入 Claude Code（截图证据：openclaw.json 含 `"acp": { "enabled": true, "defaultAgent": "claude" }` + agent list 的 `"id": "claude", "name": "Claude Code"`），下游设计不能假设 push 通道一定可用
2. **chat.send 路径 user message eager push 无 messageId 且早于落盘**——理论上有"幽灵 user message"风险（推送出去但 jsonl 永远没有），CoClaw UI 主对话不走这条所以不影响
3. **chat.send 可能重复 emit 同内容 user message**（eager push + 后续 runner guard 二次 append）—— 实际行为未在代码上钉死，需要实测对账
4. **session.message 的 message body 经 `projectChatDisplayMessage` 投影（瘦身）**——text 默认 8000 字符上限、image data 剥成 `{omitted:true, bytes}`、thinkingSignature 删除等。不能直接当 jsonl 原文用
5. **chat.history / sessions.get 也有清洗**（`session-utils.fs.ts` 内的 strip 长文本到 12000 字符、剥 base64 等）—— 跟 push 投影规则不同，但也不是原文。无清洗只有 `coclaw.sessions.getById`（plugin 本地实现）
6. **8 字符 id 不全局唯一**——session 内唯一，跨 session 必撞。需要全局主键时用 `(sessionId, messageId)` 复合键
7. **首条 assistant 之前的 user message 不刷盘**——`agent` RPC accepted 那一刻 jsonl 还没这条 user；要等第一条 assistant message_end 才一并 flush + emit
8. **session.message 的订阅可能需要 `sessions.messages.subscribe` opt-in**——`server-session-events.ts:96-105` 只广播给 `sessionEventSubscribers` / `sessionMessageSubscribers` 里登记的 connId。CoClaw plugin 当前是 catch-all 转发非 agent 事件（`plugins/openclaw/src/realtime-bridge.js:902-918`），**catch-all 是否真能收到 session.message 未实测**

---

## 九、关键代码锚点

- pi 流式落盘核心：`pi-coding-agent/dist/core/agent-session.js:298-309`、`session-manager.js:549-589`
- OpenClaw monkey-patch：`openclaw-repo/src/agents/session-tool-result-guard.ts:268, 449-465, 475`
- guard 安装入口：`openclaw-repo/src/agents/pi-embedded-runner/run/attempt.ts:132`（`guardSessionManager` 调用点）
- emitter：`openclaw-repo/src/sessions/transcript-events.ts:3-52`
- WS 转发：`openclaw-repo/src/gateway/server-session-events.ts:91-151`
- chat-display-projection（推送 message 投影）：`openclaw-repo/src/gateway/chat-display-projection.ts:1-130`
- `__openclaw.id` 注入（pull 通道）：`openclaw-repo/src/gateway/session-utils.fs.ts:73, 127-158`
- chat.history / sessions.get：`openclaw-repo/src/gateway/server-methods/chat.ts:1717-1724`、`server-methods/sessions.ts:1628-1652`
- coclaw.sessions.getById（topic 模式）：`plugins/openclaw/src/session-manager/manager.js:357-384`
- ACP / CLI runner 兜底批量路径：`openclaw-repo/src/agents/command/attempt-execution.ts:101-155`
- chat.send eager user push：`openclaw-repo/src/gateway/server-methods/chat.ts:1807, 2172-2175, 783`
- chat-transcript-inject 手动 emit：`openclaw-repo/src/gateway/server-methods/chat-transcript-inject.ts:102-115`

---

## 十、与 CoClaw 设计的关联

- **X4 课题**（`ui/TODO.md` 末尾）：streamingMsgs 接管策略重设计依赖本文 §三 / §四 的 push 能力差异——pi-embedded 路径下能用 push 通道挂 id，ACP 路径下只能 pull。X4 设计需考虑两路径统一
- **wrapOcMessages 升级到真 id**（独立优化）：`ui/src/utils/message-normalize.js:11-18` 当前丢弃 `__openclaw.id` 自合成，升级后可解掉 `ui/TODO.md` 内 #30 / #62 / #63 等多条预存 bug
- **agent-event-streams-and-rpcs.md**（同目录）：覆盖 agent stream / agent.wait / 持久化时序的 lifecycle:end 视角；本文是 message id / transcript push 视角，二者互补
- **transcript-message-taxonomy.md**（同目录）：覆盖 jsonl 内消息分类（A 类真模型回复 vs B 类系统注入、HEARTBEAT_OK 等）；本文不重复，只关注 id 通道
