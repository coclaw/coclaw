# Topic（独立话题）功能：OpenClaw 机制研究与方案建议

> 更新时间：2026-03-16
> 基于 OpenClaw 本地源码验证，结合 CoClaw 集成需求

---

## 一、背景与需求概述

CoClaw 需要实现 ChatBot 主流的"新建对话"能力——用户在 UI 中主动新建一个独立话题（Topic），与当前 main sessionKey 的对话完全隔离。

### 核心设计思路

使用 `agent(sessionId=<新UUID>)` 发起独立 session，**不传 sessionKey**，不干扰 OpenClaw 对 main sessionKey → sessionId 关系的控制。为统一术语，用户主动新建的独立对话称为 **Topic**。

### 需要解决的关键问题

1. **Topic 追踪**：如何记录并在 UI 中展示用户创建的 Topic
2. **对话标题生成**：首轮交互完成后自动生成恰当的对话标题
3. **历史 session 链追踪**：追踪 main sessionKey 因 reset 产生的所有历史 session，支持懒加载式的对话历史浏览

---

## 二、agent() RPC 的 sessionId 机制

### 1. 关键参数

| 参数 | 必填 | 说明 |
|------|:----:|------|
| `message` | 是 | 用户消息内容 |
| `idempotencyKey` | 是 | 幂等键，用于请求去重 |
| `sessionId` | 否 | 指定 session UUID |
| `sessionKey` | 否 | 指定逻辑路由标识（如 `agent:main:main`） |
| `extraSystemPrompt` | 否 | 额外系统提示词（仅对当次运行生效） |
| `agentId` | 否 | 目标 agent（默认 `main`） |
| `deliver` | 否 | 是否向外部渠道投递响应 |

完整定义：`src/gateway/protocol/schema/agent.ts:74-103`

### 2. 仅传 sessionId（不传 sessionKey）的行为

这是 Topic 功能的核心调用方式。完整代码路径：

**Gateway handler**（`src/gateway/server-methods/agent.ts`）：
- `requestedSessionKeyRaw` 为空 → 跳过 session key 解析和 `sessions.json` 写入（lines 350-448 整个 block 被跳过）
- `resolvedSessionId` 直接使用调用方传入的 UUID（line 309）

**Session 解析**（`src/commands/agent/session.ts:resolveSession`）：
- 尝试在 `sessions.json` 中反向查找匹配该 UUID 的条目（lines 70-81）
- 若为全新 UUID，查找无果，`sessionKey` 保持 `undefined`
- `sessionId` 使用调用方传入的值（line 144：`opts.sessionId?.trim() || ...`）

**最终结果**：

| 行为 | 说明 |
|------|------|
| sessions.json | **不写入任何条目**——`updateSessionStore` 受 `if (sessionStore && sessionKey)` 守卫 |
| transcript 文件 | 自动创建 `<sessionId>.jsonl`，位于 `~/.openclaw/agents/<agentId>/sessions/` |
| 上下文 | 全新干净上下文（无历史消息） |
| 后续追加 | 再次传入同一 `sessionId` 可续写该 session（上下文累积） |

### 3. sessionKey 格式校验

OpenClaw 对 sessionKey 有严格的结构要求：

**核心解析**（`src/sessions/session-key-utils.ts:12-32`，`parseAgentSessionKey`）：
- 必须以 `agent:` 开头
- 至少三段：`agent:<agentId>:<rest>`
- `<rest>` 可以是任意非空的冒号分隔字符串

**格式分类**（`src/routing/session-key.ts:78-87`，`classifySessionKeyShape`）：

| 分类 | 含义 | 示例 |
|------|------|------|
| `"agent"` | 合法的 `agent:x:y...` 格式 | `agent:main:main` |
| `"malformed_agent"` | 以 `agent:` 开头但结构不完整 → **被拒绝** | `agent:main`（仅 2 段） |
| `"legacy_or_alias"` | 不以 `agent:` 开头 → 允许通过，被转换 | `coclaw:title-gen:xxx` |
| `"missing"` | 空值 | `""` |

非 `agent:` 开头的 key 会被 `toAgentStoreSessionKey` 自动转换为 `agent:<agentId>:<原始key>`（`src/routing/session-key.ts:53-71`）。

### 4. 同一 sessionKey 重复调用时的上下文行为

当 `sessionKey` 指向的 session 仍处于"fresh"状态（未过期）时，每次调用都会复用同一个 `sessionId`，LLM 能看到所有历史消息。**上下文会持续累积**，直到 session 过期或被显式 reset。

### 5. agentId 参数与多 Agent 路由约束

> 补充时间：2026-03-17。基于 gateway handler 源码逐行追踪验证。

#### agentId 参数的行为

`agent()` RPC 接受可选的 `agentId` 参数（`src/gateway/protocol/schema/agent.ts:74-103`）。但传入 `agentId` 时会**自动派生 sessionKey**，覆盖调用方的 sessionId。

完整路径（`src/gateway/server-methods/agent.ts`）：

1. **line 289-294**：若未显式传 `sessionKey`，调用 `resolveExplicitAgentSessionKey({ cfg, agentId })`
2. 该函数（`src/config/sessions/main-session.ts:40-49`）在 `agentId` 非空时**必定返回** `agent:<agentId>:main`
3. **line 350**：进入 `if (requestedSessionKey)` 分支，按 sessionKey 解析 session store
4. **line 420**：`resolvedSessionId = sessionId`——调用方传入的 `request.sessionId` 被 store 中的 sessionId **无条件覆盖**
5. **line 425-437**：向 `sessions.json` 写入/更新该 sessionKey 条目

#### 各传参组合的实际行为

| 传参 | sessionId 是否被尊重 | agent 路由 | 写 sessions.json | .jsonl 位置 |
|------|:---:|:---:|:---:|---|
| 只传 `sessionId` | ✓ | 默认 main | ✗ | `main/sessions/` |
| 传 `agentId`（无 key） | ✗（被覆盖） | ✓ | ✓ | `<agentId>/sessions/` |
| 传 `sessionKey` | ✗（被覆盖） | ✓ | ✓ | 由 key 解析 |
| 传 `agentId` + `sessionId` | ✗（sessionId 被覆盖） | ✓ | ✓ | `<agentId>/sessions/` |
| 传 `sessionKey` + `sessionId` | ✗（sessionId 被覆盖） | ✓ | ✓ | 由 key 解析 |

#### 核心约束

**不存在"指定 agent + 使用自定义 sessionId + 不写 sessions.json"的方式。** `sessionKey` 为 `""`、`null`、`undefined` 均会触发 agentId → sessionKey 自动派生。

#### 对 Topic 功能的影响

当前设计（`agent(sessionId=<uuid>)` 不传 sessionKey）只能路由到 main agent。多 agent topic 需要通过 sessionKey（如 `agent:<agentId>:coclaw-<topicId>`）实现，但会：
- 在 sessions.json 中创建条目（每个 topic 一条）
- sessionId 由 gateway 分配（非调用方控制）
- topic .jsonl 纳入 OpenClaw 维护剪裁范围

#### 备选方案：sessionKey-per-topic

若未来需要多 agent topic 支持，可使用 `agent:<agentId>:coclaw-<topicId>` 格式的 sessionKey：
- 每个 topic 对应独立 sessionKey → 独立 sessionId → 独立 .jsonl → 独立上下文
- 正确路由到目标 agent
- **代价**：sessions.json 中出现 topic 条目；sessionId 由 gateway 生成（topic 元信息需增加 sessionId 字段）；.jsonl 受 OpenClaw 维护剪裁影响（`mode=enforce` 时可能被清理）
- 需评估 sessions.json 膨胀风险及 .jsonl 保护策略

---

## 三、Session 生命周期钩子

OpenClaw 在 session reset 时提供三个插件钩子，按触发顺序排列：

### 1. `before_reset`

**event payload**（`src/plugins/types.ts:644-649`）：
```
{
  sessionFile?: string      // 旧 transcript 文件路径
  messages?: unknown[]      // 旧 transcript 中的所有已解析消息
  reason?: string           // "new" | "reset"
}
```

**context**（`PluginHookAgentContext`）：
```
{
  agentId, sessionKey, sessionId(旧), workspaceDir, trigger, channelId
}
```

触发位置：`src/auto-reply/reply/commands-core.ts:96-136`

### 2. `session_end`

**event payload**（`src/plugins/types.ts:789-794`）：
```
{
  sessionId: string         // 旧 sessionId（即将被替换的）
  sessionKey?: string
  messageCount: number      // 目前始终为 0（未实现）
  durationMs?: number       // 未填充
}
```

**context**（`PluginHookSessionContext`）：
```
{
  agentId, sessionId(旧), sessionKey
}
```

触发位置：`src/auto-reply/reply/session.ts:578-587`，仅当 `previousSessionEntry.sessionId !== 新sessionId` 时触发。

### 3. `session_start`

**event payload**（`src/plugins/types.ts:774-786`）：
```
{
  sessionId: string         // 新 sessionId
  sessionKey?: string
  resumedFrom?: string      // 旧 sessionId ← 链追踪的关键字段
}
```

**context**（`PluginHookSessionContext`）：
```
{
  agentId, sessionId(新), sessionKey
}
```

触发位置：`src/auto-reply/reply/session.ts:591-598`

`resumedFrom` 在存在旧 session 被替换时填充，首次创建 session（无前任）时为 `undefined`。

### 4. Fire-and-forget 机制

三个钩子的调用方式相同（以 `session_start` 为例）：

```js
void hookRunner.runSessionStart(payload.event, payload.context).catch(() => {});
```

- `void` + 无 `await` = 调用方**不等待**钩子完成
- 钩子函数内部的 `async/await` **正常工作**——异步操作会执行完成
- 但**时序无保证**：钩子可能在新 session 的首条消息已处理完之后才完成
- 钩子抛出的错误被静默捕获，不影响调用方流程

所有钩子通过 `runVoidHook` 执行（`src/plugins/hooks.ts:203-224`），多个处理器**并行**运行（`Promise.all`）。

### 5. 触发矩阵

| 触发场景 | `before_reset` | `session_end` | `session_start` |
|----------|:-:|:-:|:-:|
| `/new`、`/reset` 通过 `chat.send` | ✓ | ✓ | ✓ |
| `/new`、`/reset` 通过 `agent()` RPC | ✗ | ✗ | ✗ |
| `sessions.reset` RPC | ✗ | ✗ | ✗ |
| 自动过期（daily/idle reset） | ✓ | ✓ | ✓ |
| 首次创建 session（无前任） | ✗ | ✗ | ✓ |

**关键区分**：`/new` 和 `/reset` 是斜杠命令，作为 `message` 内容发送。通过不同 RPC 方法发送时走不同代码路径：

- **`chat.send({ message: "/new" })`**：消息进入 auto-reply 流水线，由 `commands-core.ts` 匹配 `/^\/(new|reset)(?:\s|$)/` 处理 → **触发全部插件钩子**
- **`agent({ message: "/new" })`**：在 gateway handler 层（`agent.ts:316`）由 `RESET_COMMAND_RE` 匹配，调用 `performGatewaySessionReset()` → **不触发插件钩子**（走 RPC reset 路径）

OpenClaw WebChat UI 使用 `chat.send()`，因此 `/new` 会触发钩子。CoClaw 当前通过 `agent()` RPC 转发消息（realtime-bridge 透传），因此 `/new` **不触发钩子**。

### 6. 不存在 `sessions.new` RPC

OpenClaw 的 session 相关 RPC 方法完整列表（`src/gateway/server-methods-list.ts`）：

```
sessions.list / sessions.preview / sessions.patch
sessions.reset / sessions.delete / sessions.compact
sessions.get / sessions.resolve
```

没有 `sessions.new`。"新建 session"的语义完全通过 `/new` 斜杠命令或 `sessions.reset` RPC 实现。

---

## 四、Session 文件管理

### 1. 三种重命名及其触发条件

所有重命名都是**通过 sessionKey → sessionId 索引关系的定向操作**，不是文件系统扫描。重命名函数为 `archiveFileOnDisk(filePath, reason)`（`src/gateway/session-utils.fs.ts:177-182`），生成的文件名格式为 `<原文件名>.<reason>.<ISO时间戳>`。

#### `.jsonl.reset.<ts>`

| 触发场景 | 代码位置 |
|----------|---------|
| `/new`、`/reset` 斜杠命令或自动过期（消息进入 auto-reply 流水线） | `src/auto-reply/reply/session.ts:547` |
| `sessions.reset` RPC（显式 API 调用） | `src/gateway/session-reset-service.ts:332` |

**语义**：sessionKey 的 session 被"轮换"——旧 sessionId 的 transcript 被归档，sessionKey 获得新 sessionId。旧文件保留在磁盘上。

**注意**：session 自动过期（如按日 reset、空闲超时）也归档为 `.reset`，不是 `.deleted`。过期判断发生在下一条消息到达时（`evaluateSessionFreshness`），不是定时扫描。

#### `.jsonl.deleted.<ts>`

| 触发场景 | 代码位置 |
|----------|---------|
| `sessions.delete` RPC 显式调用（如 UI 中删除 session） | `src/gateway/server-methods/sessions.ts:304` |
| 维护剪裁：`mode=enforce` 时过期条目（>30天）或超上限（>500条）被移除 | `src/config/sessions/store.ts:408` |
| Cron 隔离运行的 session 自动清理（内部调用 `sessions.delete`） | subagent 生命周期管理 |

**语义**：session 条目被从 `sessions.json` 中**删除**，transcript 文件被归档。

维护剪裁不是独立的定时任务，而是嵌入在每次 `updateSessionStore` 写入流程中（`saveSessionStoreUnlocked`）。仅在 `mode=enforce` 时执行，默认 `mode=warn` 不执行任何删除。

Cron 隔离运行 session 的清理：每次 cron agentTurn 完成后，其 announce 流程中会自动调用 `sessions.delete`（`cleanup: "delete"`），将运行过程中产生的 transcript 归档为 `.deleted`。

#### `.jsonl.bak.<ts>`

| 触发场景 | 代码位置 |
|----------|---------|
| `sessions.compact` RPC 显式调用 | `src/gateway/server-methods/sessions.ts:418` |

**语义**：transcript 文件**行数压缩**——当 `.jsonl` 超过 `maxLines`（默认 400 行）时，原文件备份为 `.bak`，只保留最后 `maxLines` 行写回原路径。这是纯粹的磁盘管理操作，**不是 AI 上下文压缩**（AI 层面的 context compaction 是 LLM 侧行为，不涉及文件重命名）。此操作不自动执行，仅在显式 RPC 调用时触发。

### 2. 自动清理策略

#### 配置参数

| 参数 | 配置键 | 默认值 |
|------|--------|--------|
| 维护模式 | `session.maintenance.mode` | `"warn"`（仅警告，**不执行删除**） |
| 过期时间 | `session.maintenance.pruneAfter` | 30 天 |
| 最大条目数 | `session.maintenance.maxEntries` | 500 |
| reset 归档保留 | `session.maintenance.resetArchiveRetention` | 同 pruneAfter（30 天） |
| 磁盘预算 | `session.maintenance.maxDiskBytes` | `null`（**禁用**） |

类型定义：`src/config/zod-schema.session.ts:72-143`

#### 清理流程（仅 `mode=enforce` 时生效）

```
每次 updateSessionStore 写入时 → saveSessionStoreUnlocked
  → pruneStaleEntries：移除过期条目（>pruneAfter）
  → capEntryCount：移除超出上限的条目（>maxEntries）
  → archiveRemovedSessionTranscripts：将被移除条目的 .jsonl 重命名为 .jsonl.deleted.<ts>
  → cleanupArchivedSessionTranscripts：删除超过保留期的 .deleted.* 和 .reset.* 归档文件
  → enforceDiskBudget：若 maxDiskBytes 启用且超限，删除未引用的文件
```

#### 磁盘预算清理的文件匹配规则

磁盘预算是唯一会进行**文件系统扫描**的清理机制（`src/config/sessions/disk-budget.ts`）。扫描候选队列由以下规则决定（`src/config/sessions/artifacts.ts`）：

- `isSessionArchiveArtifactName()`：匹配 `*.jsonl.reset.*`、`*.jsonl.deleted.*`、`*.jsonl.bak.*`、`sessions.json.bak.*`
- `isPrimarySessionTranscriptFileName()`：匹配 `*.jsonl`（但排除 `sessions.json` 和归档文件）

**不被任何清理机制触及的文件**：
- `sessions.json`（索引文件本身）
- 任何 `.json` 文件（如 `topics.json`、`session-chains.json`）——不匹配 `.jsonl` 后缀
- 任何非 `.jsonl` 扩展名的文件

### 3. 对 Topic .jsonl 文件的影响

我们用 `agent(sessionId=<uuid>)` 创建的 Topic session 文件：

| 风险 | 默认配置 | `enforce` 模式 | `enforce` + `maxDiskBytes` |
|------|:--------:|:--------------:|:--------------------------:|
| 被重命名为 .reset/.deleted/.bak | ✗ | ✗ | ✗ |
| 被自动删除 | ✗ | ✗ | **可能**（作为未引用 .jsonl 被优先清理） |

**不会被重命名**的原因：三种重命名都通过 `sessionKey → sessionId` 索引关系定位目标文件。Topic session 从未写入 `sessions.json`，没有任何 sessionKey 指向它们。

**可能被删除**的场景：磁盘预算清理会扫描文件系统，将未被 `sessions.json` 引用的 `.jsonl` 文件列为候选。但此功能默认禁用（`maxDiskBytes=null`）。

**sidecar .json 文件完全安全**：`topics.json` 等不匹配任何清理模式。

---

## 五、历史 Session 链追踪

### 1. OpenClaw 现状：无持久化链追踪

OpenClaw 不提供跨 reset 的 session 历史追踪：

| 数据源 | 是否包含链信息 |
|--------|:----------:|
| `sessions.json` 条目 | ✗ — 只存当前 `sessionId`，reset 后直接覆盖 |
| `.jsonl` 文件头 | ✗ — 只有 `{ type, version, id(=sessionId), timestamp, cwd }`，无 sessionKey |
| `session_start` 钩子 | ✓ — `resumedFrom` 字段携带旧 sessionId，但不持久化 |
| 文件系统归档 | 间接 — `.jsonl.reset.<ts>` 文件名中含旧 sessionId，但无指向原 sessionKey 的指针 |

没有 `previousSessionId`、`history`、`chain`、`parent` 等任何持久化字段。

### 2. 可行的追踪方案

利用 `session_start` 钩子的 `resumedFrom` 字段在插件中自行构建持久化链：

```js
// 插件注册 session_start 钩子
api.on('session_start', async (event, context) => {
  if (!event.resumedFrom) return; // 首次创建，无前任
  // 将 { sessionKey, oldSessionId, newSessionId, timestamp } 追加到 sidecar 文件
  await appendToChainFile(context.sessionKey, {
    from: event.resumedFrom,
    to: event.sessionId,
    at: Date.now()
  });
});
```

### 3. 注意事项

- **`agent()` 路径的 `/new` 不触发钩子**：CoClaw 当前通过 `agent()` 转发消息，用户在 CoClaw 中发送 `/new` 时走 `performGatewaySessionReset()`，不触发 `session_start`。需要在转发层拦截 `/new` 命令并主动维护链，或改为通过 `chat.send` 发送 reset 命令。
- **fire-and-forget 时序**：钩子执行不阻塞主流程，但对链追踪场景影响不大（前端不会在 reset 瞬间查询链数据）。
- **自动过期**（daily/idle reset）**会触发钩子**：这是最需要追踪的场景，钩子可正常捕获。

---

## 六、标题生成接口能力

### 1. OpenClaw 现有的标题机制

`deriveSessionTitle`（`src/gateway/session-utils.ts:152-178`）：
- 读取 transcript 中首条用户消息，截取前 60 字符
- 纯文本截取，**非 AI 生成**
- 通过 `sessions.list({ includeDerivedTitles: true })` 暴露

CoClaw 插件的 `session-manager/manager.js` 中 `deriveTitle()` 实现了相同逻辑。

### 2. agent() 的 extraSystemPrompt

`agent()` RPC 接受 `extraSystemPrompt` 参数（`src/gateway/protocol/schema/agent.ts`），该提示词被注入到当次运行的系统提示中（`src/gateway/server-methods/agent.ts:619`）。

这为标题生成提供了基础能力：可以通过 `extraSystemPrompt` 指示 agent 生成标题。

### 3. 无轻量级 LLM 调用路径

OpenClaw 架构中**所有产生 LLM 响应的路径都走完整 agent 流水线**（`agentCommandFromIngress`）：
- `agent` RPC
- `chat.send` RPC
- `POST /v1/chat/completions` HTTP（默认禁用，配置键 `gateway.http.endpoints.chatCompletions.enabled`）
- `POST /v1/responses` HTTP（默认禁用）

不存在绕过 agent 循环的"直接调 LLM"方法。

### 4. chat.send 不支持 extraSystemPrompt

`ChatSendParamsSchema`（`src/gateway/protocol/schema/logs-chat.ts:34-47`）不包含 `extraSystemPrompt` 字段。标题生成必须通过 `agent()` 路径。

---

## 七、方案建议

### 7.1 Topic 创建

**推荐**：`agent(sessionId=<新UUID>)`，不传 `sessionKey`。

| 优势 | 说明 |
|------|------|
| 干净隔离 | 完全独立于 OpenClaw sessionKey 体系 |
| 零索引 | 不在 sessions.json 中创建条目，无管理负担 |
| 可续写 | 后续传入同一 sessionId 可继续对话（上下文累积） |
| 无垃圾 | 不产生不需要的 sessionKey 映射 |

### 7.2 Topic 追踪

| 方案 | 描述 | 优势 | 劣势 |
|------|------|------|------|
| **A. 前端 RPC 注册** | 前端完成首轮交互后调用插件 RPC（如 `nativeui.topics.register`）注册 Topic | 语义明确，前端掌控生命周期 | 多一次 RPC，需处理失败 |
| B. 插件 `agent_end` 钩子 | 在钩子中检测 `trigger==="user"` 且 sessionId 未在索引中 | 全自动 | 可能误判非 CoClaw 发起的请求 |
| C. Server 侧追踪 | CoClaw server 维护 Topic 列表 | 与 OpenClaw 完全解耦 | 增加 server 持久化职责 |

**推荐方案 A**，可辅以方案 B 做兜底。

**存储位置**：插件侧 sidecar 文件（如 `~/.openclaw/agents/<agentId>/sessions/topics.json`），通过 `registerGatewayMethod` 注册查询接口供前端调用。该 `.json` 文件不受 OpenClaw 任何清理机制影响。

### 7.3 标题生成

| 方案 | 描述 | 优势 | 劣势 |
|------|------|------|------|
| **A. 独立 session + extraSystemPrompt** | 用 `agent(sessionId=<新UUID>, extraSystemPrompt="生成标题")` 在独立 session 中请求 | 不污染 Topic transcript；利用现有能力 | 产生临时 .jsonl 文件（体积极小） |
| B. 在 Topic 中注入 extraSystemPrompt | 用户发送首条消息时携带 extraSystemPrompt，指示 agent 在响应末尾附加标题行（特殊前缀） | 仅一次请求，无额外 session | 污染 transcript；需渲染过滤 |
| C. 在 Topic session 追加请求 | 首轮完成后向同一 sessionId 追加"请生成标题"消息 | 标题基于完整对话 | 严重污染 transcript |

**推荐方案 A**。

实现要点：
- `message` 中应包含**用户消息 + assistant 响应**，这样生成的标题质量更高
- 每次标题生成使用新的 UUID 作为 `sessionId`，确保干净上下文、不累积历史
- 不传 `sessionKey`，避免在 `sessions.json` 中产生条目
- 生成的临时 `.jsonl` 文件体积极小（仅一轮对话），在默认配置下不会被自动清理

### 7.4 Main sessionKey 历史 session 链追踪

**推荐**：利用 `session_start` 钩子的 `resumedFrom` 字段，在插件中持久化链关系。

**注意项**：
- CoClaw 当前通过 `agent()` RPC 转发消息，用户发 `/new` 时走 `performGatewaySessionReset()`，**不触发 `session_start` 钩子**
- 需要在 CoClaw 的消息转发层拦截 `/new`、`/reset` 命令，在 reset 完成后主动记录链关系
- 或者改为通过 `chat.send` 发送 reset 命令（但这涉及较大的架构调整）
- 自动过期（daily/idle reset）的场景可通过钩子正常捕获

---

## 八、插件内发起 agent 请求的机制

### 1. 通过 gateway WebSocket 直接发送 RPC（主选）

插件的 realtime-bridge 持有与 OpenClaw gateway 的直连 WebSocket。插件已有自主发起 RPC 的先例（`ensureAgentSession` 中调用 `sessions.resolve` / `sessions.reset`）。

通过该连接发送 `agent()` 请求时，需处理**两阶段响应**：
1. 第一阶段：`{ status: "accepted", runId }` — 表示请求被接受
2. 第二阶段：`{ status: "ok", result: { payloads: [{ text }] } }` — agent 运行完成，`result.payloads[0].text` 是 assistant 的文本回复

两次响应共享同一个请求 `id`。调用方需等待第二阶段才能获取最终结果。

**优势**：不依赖任何内部 API，使用标准 gateway RPC 协议；`sessionId` 模式不会在 `sessions.json` 中创建条目。

**agent 两阶段响应**的实现位于 `src/gateway/server-methods/agent.ts`：
- 第一阶段：line 579，`respond(true, { runId, status: "accepted", acceptedAt })`
- 第二阶段：lines 104-122，`respond(true, { runId, status: "ok", summary: "completed", result })`

### 2. `api.runtime.subagent` 官方插件 API（备选）

OpenClaw 提供了 `api.runtime.subagent` 作为插件内发起 agent 任务的官方 API：

```js
// 在 registerGatewayMethod handler 内可用（依赖 AsyncLocalStorage 的 gateway request scope）
const { runId } = await api.runtime.subagent.run({
  sessionKey,          // 必须为 sessionKey，不支持 sessionId
  message,
  extraSystemPrompt,
  deliver: false
});
const { status } = await api.runtime.subagent.waitForRun({ runId, timeoutMs: 30000 });
const { messages } = await api.runtime.subagent.getSessionMessages({ sessionKey, limit: 1 });
await api.runtime.subagent.deleteSession({ sessionKey, deleteTranscript: true });
```

类型定义：`src/plugins/runtime/types.ts:51-63`
实现：`src/gateway/server-plugins.ts:117-148`

**注意事项**：
- **只接受 `sessionKey`，不接受 `sessionId`**——无法利用"复制 .jsonl"方式传递上下文，需从原 transcript 中提取内容通过 `message` 参数传入
- **`waitForRun` 不返回文本**——返回 `{ status: "ok"|"error"|"timeout" }`，需额外调用 `getSessionMessages` 获取标题
- **会在 `sessions.json` 中创建条目**——需在完成后调用 `deleteSession` 清理
- **仅在 `registerGatewayMethod` handler 内可用**——不能在 service 或 hook 回调中使用
- **并发风险**：若使用固定 sessionKey（如 `coclaw:title-gen`），多个并发的标题生成请求会共享同一个 session 上下文。应使用唯一 sessionKey（如 `coclaw:title-gen:<topicId>`）避免

---

## 九、关键源码索引

| 用途 | 文件路径 |
|------|---------|
| agent RPC 参数定义 | `src/gateway/protocol/schema/agent.ts:74-103` |
| agent RPC handler | `src/gateway/server-methods/agent.ts` |
| sessionId 解析 | `src/commands/agent/session.ts:resolveSession` |
| sessionKey 解析/校验 | `src/sessions/session-key-utils.ts:12-32` |
| sessionKey 格式分类 | `src/routing/session-key.ts:78-87` |
| sessionKey 规范化 | `src/routing/session-key.ts:53-71` |
| 插件钩子类型定义 | `src/plugins/types.ts` |
| 钩子 runner | `src/plugins/hooks.ts:203-224` |
| session_start/end 触发 | `src/auto-reply/reply/session.ts:574-599` |
| before_reset 触发 | `src/auto-reply/reply/commands-core.ts:96-136` |
| session_start payload 构建 | `src/auto-reply/reply/session-hooks.ts:22-43` |
| 文件归档函数 | `src/gateway/session-utils.fs.ts:177-182` |
| sessions.delete handler | `src/gateway/server-methods/sessions.ts:252-311` |
| sessions.compact handler | `src/gateway/server-methods/sessions.ts:345-430` |
| 维护剪裁 | `src/config/sessions/store.ts:340-455` |
| 磁盘预算清理 | `src/config/sessions/disk-budget.ts` |
| 文件模式匹配 | `src/config/sessions/artifacts.ts` |
| 维护配置类型 | `src/config/zod-schema.session.ts:72-143` |
| chat.send 参数定义 | `src/gateway/protocol/schema/logs-chat.ts:34-47` |
| deriveSessionTitle | `src/gateway/session-utils.ts:152-178` |
| /v1/chat/completions HTTP | `src/gateway/openai-http.ts` |
| HTTP 端点配置类型 | `src/config/types.gateway.ts:216-239` |
| gateway reset 路径 | `src/gateway/session-reset-service.ts` |
| cron session 清理 | `src/cron/session-reaper.ts` |
| RPC 方法注册列表 | `src/gateway/server-methods-list.ts` |
| transcript 文件创建 | `src/config/sessions/transcript.ts:67-86` |
| 会话新鲜度判断 | `src/auto-reply/reply/session.ts:evaluateSessionFreshness` |

> 以上路径均基于本地同步的 OpenClaw 源码（`./openclaw-repo/openclaw/`），前缀 `src/` 对应该仓库根目录下的 `src/` 目录。
