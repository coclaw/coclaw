# Topic 管理功能设计

> 创建时间：2026-03-17
> 状态：草案
> 范围：用户主动新建的独立话题（Topic）管理，不含 main sessionKey 的历史 session 链追踪

---

## 一、概述

### 目标

为 CoClaw 提供 ChatBot 主流的"新建对话"能力。用户可在 UI 中主动创建独立话题（Topic），每个 Topic 是一个完全脱离 OpenClaw sessionKey 体系的独立 session，由 CoClaw 自行管理其生命周期。

### 核心设计原则

- 使用 `agent(sessionId=<uuid>)` 发起请求，**不传 sessionKey**，不干扰 OpenClaw 对 sessionKey → sessionId 的映射关系
- Topic 元信息由插件侧 `coclaw-topics.json` 管理，OpenClaw 的 `sessions.json` 中不会出现 Topic 的条目
- 对话内容（`.jsonl` transcript）由 OpenClaw 自然生成和管理，CoClaw 只负责元信息层

### 术语

| 术语 | 含义 |
|------|------|
| Topic | 用户主动新建的独立对话，由 CoClaw 管理 |
| topicId | Topic 的唯一标识，同时也是 OpenClaw 层面的 sessionId（UUID v4） |
| main 通道 | 指 main agent 的 `agent:main:main` sessionKey 对应的对话，由 OpenClaw 管理 |

---

## 二、整体流程

```
用户在 UI 中点击"新话题"
  → 进入新话题页面（路由参数为 'new'，无 topicId）
  → 用户输入消息，点击发送
  → UI 调用 coclaw.topics.create({ agentId }) → 获得 topicId
  → 插件分配 UUID，立即写入 coclaw-topics.json（title: null）
  → UI 用 topicId 作为 sessionId 发起 agent() 请求
  → UI 路由从 'new' 切换为 topicId
  → 首轮交互完成（UI 收到 lifecycle.end）
  → UI 调用 coclaw.topics.generateTitle({ topicId })（后台任务）
  → 插件复制 .jsonl → 通过 gateway WS 发起 agent(sessionId=tempId, extraSystemPrompt) → 等待两阶段响应
  → 生成完成 → 更新 coclaw-topics.json → 清理临时文件 → 返回 title
  → UI 更新 store 中的 topic title
```

---

## 三、数据模型

### 存储位置

`~/.openclaw/agents/<agentId>/sessions/coclaw-topics.json`

每个 agent 的 sessions 目录天然隔离（由 OpenClaw `resolveAgentSessionsDir` 硬编码按 agentId 区分，不受 `agentDir` 配置覆盖），无需额外防护。

该 `.json` 文件不受 OpenClaw 任何清理机制影响——OpenClaw 的清理仅针对 `.jsonl` 及其归档文件（`.jsonl.reset.*`、`.jsonl.deleted.*`、`.jsonl.bak.*`）。

### 文件结构

```jsonc
{
  "version": 1,
  "topics": [
    {
      "topicId": "a1b2c3d4-...",
      "agentId": "main",
      "title": "关于部署策略的讨论",
      "createdAt": 1742000000000
    },
    {
      "topicId": "e5f6g7h8-...",
      "agentId": "main",
      "title": null,
      "createdAt": 1741999000000
    }
  ]
}
```

- **数组而非对象**：新 topic 插入数组头部（`unshift`），天然按创建时间倒序，与 UI 展示一致
- **`title: null`** 表示标题尚未生成
- **`agentId`**：虽然文件路径已按 agentId 隔离，仍写入以保证数据自描述
- **`version`**：预留数据格式版本，便于将来迁移

### 路径解析

插件通过 OpenClaw 的 `resolveAgentSessionsDir(agentId)` 获取 sessions 目录路径（该函数硬编码返回 `<stateDir>/agents/<agentId>/sessions`），再拼接 `coclaw-topics.json`。

现有 session-manager 已使用该函数解析路径（`manager.js` 中的 `resolveSessionsDir`），topic-manager 复用同一方式。

### 文件读写规范

遵循插件 CLAUDE.md 中的文件 I/O 安全规范：
- 写入使用 `atomicWriteJsonFile`（`src/utils/atomic-write.js`）
- read-modify-write 操作在 `mutex.withLock()` 内完成
- fire-and-forget 场景必须 `.catch()`

### 内存模型

- 插件启动时从磁盘加载 `coclaw-topics.json` 到内存（文件不存在时初始化为 `{ version: 1, topics: [] }`）
- 所有读操作从内存读取
- 所有写操作在内存中修改后，通过 mutex + atomicWrite 持久化到磁盘
- 不需要 file watcher——该文件仅由本插件写入

---

## 四、RPC 接口

所有 RPC 方法通过 `api.registerGatewayMethod` 在插件 `register()` 中注册。方法命名遵循 `coclaw.` 前缀约定。

### coclaw.info

获取插件信息与能力声明。UI 在 bot 连接建立后首先调用此接口，用于版本兼容性检查和功能发现。

- **参数**：无（`{}`）
- **返回**：`{ version: string, capabilities: string[] }`
- **行为**：
  - `version`：插件的 npm 包版本号（从 `package.json` 读取）
  - `capabilities`：当前插件支持的功能列表，如 `['topics']`
- **示例返回**：`{ version: "0.4.0", capabilities: ["topics"] }`
- **UI 侧用途**：
  - 若 `version` 低于 UI 要求的最低版本（当前为 `0.4.0`），提示用户升级插件
  - 根据 `capabilities` 决定是否显示 topic 相关 UI（未来扩展功能时同理）

### coclaw.topics.create

创建新 Topic，分配 topicId 并立即持久化。

- **参数**：`{ agentId: string }`
- **返回**：`{ topicId: string }`
- **行为**：
  1. 生成 UUID v4 作为 topicId（`crypto.randomUUID()`）
  2. 构造 topic 记录：`{ topicId, agentId, title: null, createdAt: Date.now() }`
  3. 在 mutex 内插入 `coclaw-topics.json` 的 `topics` 数组头部并持久化
  4. 返回 `{ topicId }`

### coclaw.topics.list

获取指定 agent 的 Topic 元信息列表。

- **参数**：`{ agentId: string }`
- **返回**：`{ topics: Array<{ topicId, agentId, title, createdAt }> }`
- **行为**：从内存中读取 topics 数组，按创建时间倒序返回（数组本身已有序）
- **备注**：分页参数（`limit`、`cursor`）将来扩展

### coclaw.topics.get

获取单个 Topic 的元信息。

- **参数**：`{ topicId: string }`
- **返回**：`{ topic: { topicId, agentId, title, createdAt } }`
- **行为**：从内存中查找对应 topicId 的记录
- **备注**：当前阶段暂不实现（`list` 已包含所有信息），接口预留

### coclaw.topics.getHistory

获取 Topic 的对话内容（transcript）。

- **参数**：`{ topicId: string }`
- **返回**：`{ messages: Array<...>, total, cursor, nextCursor }` — 复用 session-manager.get() 的返回格式
- **行为**：读取 `<agentId>/sessions/<topicId>.jsonl`，解析并返回对话内容
- **解析逻辑**：直接调用 session-manager 的 `get({ agentId, sessionId: topicId })`，返回格式与 `nativeui.sessions.get` 一致（字段为 `messages`，非 `history`）
- **错误处理**：若 `.jsonl` 文件不存在，session-manager 返回 `{ messages: [] }`

> **未来演进**：`coclaw.topics.getHistory` 的底层能力（按 sessionId 读取 .jsonl）不限于 topic，也适用于孤儿 session 等场景。后续版本计划将此能力提升为通用接口，替代 `nativeui.sessions.get`。候选命名：
>
> | 候选 | 说明 |
> |------|------|
> | `coclaw.sessions.history({ sessionId })` | 名词即查询，与 `coclaw.info` 风格一致，呼应 OpenClaw 的 `chat.history` |
> | `coclaw.sessions.getById({ sessionId })` | 语义为"通过 sessionId 获取"——对 OpenClaw `sessions.get`（只接受 sessionKey）的 sessionId 级扩展 |
>
> 届时 `coclaw.topics.getHistory` 可废弃或改为薄封装。当前版本保持不变。

### coclaw.topics.generateTitle

为 Topic 生成 AI 标题。阻塞式调用，完成后直接返回标题。

- **参数**：`{ topicId: string }`
- **返回**：`{ title: string }`
- **行为**：
  1. 验证 topicId 存在于 topics 中
  2. 复制 `<topicId>.jsonl` 为 `<tempId>.jsonl`（tempId = `crypto.randomUUID()`）
  3. 通过 gateway WebSocket 发起 `agent({ sessionId: tempId, extraSystemPrompt: TITLE_PROMPT, message: '请为这段对话生成标题', idempotencyKey: crypto.randomUUID() })`
  4. 等待 agent 两阶段响应完成（见第六章），从最终响应中提取 assistant 文本作为标题
  5. 清理标题文本（去除可能的引号、前缀等）
  6. 在 mutex 内更新 `coclaw-topics.json` 中对应 topic 的 `title` 字段并持久化
  7. 删除 `<tempId>.jsonl`（`fs.unlink`，忽略 ENOENT）
  8. 返回 `{ title }`
- **失败处理**：
  - agent 请求失败 → 清理临时文件 → 返回错误（`respond(false, { error })`）
  - topic 记录不受影响（`title` 保持 `null`，UI 可稍后重试）
  - 清理操作在 `finally` 块中执行，确保无论成功或失败都清理

### coclaw.topics.delete

删除 Topic 及其对话数据。

- **参数**：`{ topicId: string }`
- **返回**：`{ ok: boolean }`
- **行为**：
  1. 在 mutex 内从 `coclaw-topics.json` 的 `topics` 数组中移除对应记录并持久化
  2. 删除 `<topicId>.jsonl` 文件（`fs.unlink`，忽略 ENOENT）

---

## 五、UI 路由设计

### 路由表

| 路由 | 路由名 | 用途 | 路由 meta |
|------|--------|------|-----------|
| `/chat/:sessionId` | `chat` | Agent 的 main session 对话 | `requiresAuth, hideMobileNav` |
| `/topics` | `topics` | Topic 列表页（底部导航入口） | `requiresAuth, isTopPage` |
| `/topics/new?agent=<agentId>&bot=<botId>` | `topics-chat` | 新建 Topic（sessionId='new'） | `requiresAuth, hideMobileNav` |
| `/topics/:topicId` | `topics-chat` | 已有 Topic 对话 | `requiresAuth, hideMobileNav` |
| `/plugin-upgrade` | `plugin-upgrade` | 插件版本过低提示页 | `requiresAuth` |

- `/topics/new` 被 `/topics/:sessionId` 捕获，`sessionId` 值为字符串 `'new'`
- 新建 topic 需通过 query 参数传递 `agent`（agentId）和 `bot`（botId），以确定目标 agent 及其所属 OpenClaw 实例的 WS 连接
- `/topics/:topicId` 中的 topicId 为 UUID，ChatPage 通过 `topicsStore.findTopic(topicId)` 获取元信息（含 agentId、botId）

### Chat Store 双模式

ChatPage 的 chatStore 支持两种运行模式：

| 特性 | Session 模式 | Topic 模式 |
|------|-------------|-----------|
| 标志 | `topicMode = false` | `topicMode = true` |
| 消息加载 | `nativeui.sessions.get` | `coclaw.topics.getHistory` |
| 发送参数 | 优先 `sessionKey`，fallback `sessionId` | 仅 `sessionId`（不传 sessionKey） |
| 轮转检测 | 有（`chat.history` RPC） | 无 |
| reconcile | 重载 sessionKeyById + messages | 仅重载 messages |
| botId 解析 | 从 sessionsStore 匹配 | 由 topic 元信息或 query 参数提供 |

---

## 六、UI 交互流程

### 插件版本检查

Bot WS 连接建立后，UI 首先调用 `coclaw.info()` 检查插件版本：

```
bot WS 连接就绪
  → 调用 coclaw.info()
  → 若调用失败（方法不存在 = 旧版插件）或 version < "0.4.0"
    → router.push('/plugin-upgrade')
  → 若成功且版本满足
    → 正常流程（加载 sessions、topics 等）
```

**`/plugin-upgrade` 页面**：
- 布局参考"添加 Claw"页面风格
- 标题："插件需要升级"
- 说明：当前 OpenClaw 插件版本过低，无法支持最新功能，请在 OpenClaw 终端执行升级
- 升级命令（可复制）：`openclaw plugins update @coclaw/openclaw-coclaw`
- "重试"按钮：重新调用 `coclaw.info()` 检查版本，通过后以 `router.replace` 跳转回来源页面（通过 query 参数 `redirect` 传递，默认为 `/`）

### 导航与列表

#### Topic 列表替代 session 列表

原有 UI 中侧边栏/TopicsPage 展示 OpenClaw sessions 列表。现调整为只展示 CoClaw 自管理的 topics——OpenClaw sessions（含大量孤儿 session）不再对用户可见。

具体变更：
- MainList 的 Group 3 从 session 列表改为 topic 列表
- Topic 列表从 `topicsStore` 获取，按 `createdAt` 降序排列
- 每个 topic item 显示 title（无 title 时 fallback 为"新话题"）和对应 agent 的 avatar/emoji
- sessions store 保留（内部使用：解析 agent 的 main sessionId 用于导航），但不在 UI 中展示

#### Agent 列表与点击行为

- 侧边栏 Group 2 保持 agent 列表
- 用户点击某个 agent → 导航到该 agent 的 main sessionKey 对应的 session（`/chat/:mainSessionId`）
- 当前正在查看的 agent 在列表中高亮（active 状态）
- active 状态的判定：从当前路由解析出 agentId，与 agent item 匹配

#### Topic 列表数据加载

- `topicsStore.loadAllTopics()` 遍历所有已连接 bot × 其 agents，调用 `coclaw.topics.list({ agentId })` 合并结果
- 加载时机与 sessions 一致：bot WS 连接就绪时、bots 列表变化时
- 每个 topic 本地额外存储 `botId` 字段，用于后续 RPC 调用时选择正确的 WS 连接

### "新话题"按钮

- 位于每个 ChatPage 右上角（移动端 MobilePageHeader 和桌面端 header 中均有）
- **所有 ChatPage 均显示**（不再只限 main session），语义为"新建一个与当前 agent 的独立话题"
- 不再执行 main session 的 reset/new 操作
- 点击行为：获取当前上下文的 `agentId` 和 `botId`，导航到 `/topics/new?agent=<agentId>&bot=<botId>`

### 多 Agent 支持

Topic 必须区分 agentId——每个 topic 属于一个特定的 agent。

- `coclaw.topics.create({ agentId })` 中的 agentId 由 UI 从当前上下文传入
- `coclaw.topics.list({ agentId })` 按 agent 分别拉取，UI 侧合并展示所有 agent 的 topics
- 当用户有多个 bot（OpenClaw 实例）、每个 bot 有多个 agent 时，topic 列表会包含来自不同 bot 的不同 agent 的 topics

### botId 解析策略

确定了一个 agent 后，必须使用该 agent 所属的 OpenClaw 实例的 WS 连接。

- 每个 topic 在本地 store 中存储 `botId`（创建时绑定）
- 新建 topic 时：通过 query 参数 `bot` 传入
- 加载已有 topic 时：从 `topicsStore.findTopic(topicId).botId` 获取
- 发送消息/加载历史时：通过 `chatStore.botId` → `useBotConnections().get(botId)` 获取 WS 连接

### 新建 Topic

1. 用户在任意 ChatPage 点击"新话题"
2. 导航到 `/topics/new?agent=<agentId>&bot=<botId>`
3. ChatPage 检测到 `sessionId === 'new'`，进入新建 topic 模式——空消息列表，输入框就绪
4. 用户输入消息，点击发送
5. UI 调用 `coclaw.topics.create({ agentId })`，获得 `topicId`
6. UI 调用 `chatStore.activateTopic(topicId, { botId, agentId, skipLoad: true })`（跳过消息加载，因为 topic 刚创建）
7. UI 用 `$router.replace` 将路由从 `/topics/new` 切换为 `/topics/<topicId>`
8. UI 调用 `chatStore.sendMessage(text, files)`——内部使用 `sessionId: topicId`，不传 sessionKey
9. 首轮完成后触发标题生成（见下文）

**agent 请求参数**：
```js
{
  method: 'agent',
  params: {
    message: userMessage,
    sessionId: topicId,       // topicId 即 sessionId
    // 不传 sessionKey
    deliver: false,
    idempotencyKey: crypto.randomUUID(),
  }
}
```

### 后续消息发送

用户在已有 Topic 中发送后续消息时，agent 请求使用相同的 `sessionId: topicId`。OpenClaw 会自动将新消息追加到同一 `.jsonl`，上下文持续累积。

### 首轮交互完成后

1. UI 收到 `lifecycle.end` 事件（匹配当前 runId），sendMessage 正常完成
2. ChatPage 检测到当前 topic 的 `title === null`（首轮标志），后台调用 `topicsStore.generateTitle(botId, topicId)`
3. `generateTitle` 为 fire-and-forget 调用，完成后直接更新 store 中的 `title` 字段，界面响应式更新
4. 若 `generateTitle` 失败，静默忽略——topic 仍可正常使用，UI 将 title fallback 显示为"新话题"

### Title fallback 策略

`title` 为 `null` 的 topic（标题尚未生成或生成失败），在 UI 中统一 fallback 显示为"新话题"（i18n key: `topic.newTopic`）。

### 首轮失败

若 `agent()` 请求失败（lifecycle.error 或连 accepted 都未收到）：
- Topic 已在 `coclaw-topics.json` 中，这是合法状态
- 对应 `.jsonl` 可能不存在或内容不完整
- UI 允许用户在该 Topic 中重试发送
- 不调用 `generateTitle`

### 进入已有 Topic

- 用户从 Topic 列表点击某个 topic → 导航到 `/topics/<topicId>`
- ChatPage 检测到 topic 路由，从 `topicsStore.findTopic(topicId)` 获取元信息
- 调用 `chatStore.activateTopic(topicId, { botId, agentId })` 进入 topic 模式
- 消息通过 `coclaw.topics.getHistory({ topicId })` 加载
- 渲染方式与 main 通道的对话一致

---

## 六、标题生成实现细节

### 插件侧 agent 调用机制

插件通过 realtime-bridge 持有的 gateway WebSocket 连接发起 `agent()` RPC 请求。

**关键**：`agent()` RPC 采用**两阶段响应**模式（同一个请求 id 对应两次响应）：
1. 第一阶段：`{ ok: true, payload: { runId, status: "accepted" } }` — 立即返回
2. 第二阶段：`{ ok: true, payload: { runId, status: "ok", result: { payloads: [{ text }] } } }` — agent 运行完成后返回

现有的 `__gatewayRpc` 方法在收到第一次响应后即 resolve（`finished = true`），无法获取第二阶段。需要扩展一个支持两阶段等待的变体，例如增加 `expectFinal: true` 选项：当收到 `status: "accepted"` 时不 settle，继续等待最终响应。

**超时设置**：标题生成的 agent 调用应使用较长的超时（如 30-60 秒），因为 LLM 推理需要时间。

### extraSystemPrompt 设计

```
你是标题生成器。根据以下对话内容，生成一个简短的对话标题。
要求：
- 仅回复标题本身，不要有任何前缀、引号或解释
- 标题应简洁准确，不超过 15 个字
- 使用与对话相同的语言
```

### 临时 .jsonl 管理

- 临时文件命名：`<tempId>.jsonl`，位于同一 sessions 目录
- 复制使用 `fs.copyFile`（无需原子写入，因为是全新文件）
- 文件头中的 `id` 字段与文件名不一致（保留原 topicId），经验证 OpenClaw 的 `ensureSessionHeader` 仅在文件不存在时创建头部，已存在时仅校验 `type` 和 `version`，**不校验 `id` 字段**
- 清理时机：agent 完成后（无论成功或失败）在 `finally` 中 `fs.unlink`
- 清理失败不影响主流程（文件体积极小，不会累积为问题）

### 该临时 .jsonl 与 OpenClaw 的关系

- 不在 `sessions.json` 中（agent 请求未传 sessionKey）
- 不会被 OpenClaw 重命名（重命名操作通过 sessionKey 索引定位，该文件无索引）
- 仅在 `enforce` + `maxDiskBytes` 场景下可能被磁盘预算清理删除（默认不触发）
- 我们主动删除，不依赖 OpenClaw 清理

### 标题清洗

LLM 可能返回带引号或前缀的标题（如 `"标题"` 或 `标题：xxx`）。提取后需做简单清洗：
- 去除首尾引号（`""`、`''`、`「」`）
- 去除首尾空白
- 截断至合理长度（如 50 字符）

---

## 七、插件侧实现结构

### 新增模块

`src/topic-manager/` 目录，包含：

| 文件 | 职责 |
|------|------|
| `manager.js` | TopicManager 类：内存模型、CRUD 操作、磁盘读写 |
| `title-gen.js` | 标题生成逻辑：复制 .jsonl、发起 agent 调用、清理 |

### TopicManager 职责

```js
class TopicManager {
  constructor({ sessionsDir, logger })

  // 生命周期
  load()                           // 从磁盘加载到内存
  // CRUD
  create({ agentId })              // → { topicId }
  list({ agentId })                // → { topics: [...] }
  get({ topicId })                 // → { topic } | null
  updateTitle({ topicId, title })  // 更新标题
  delete({ topicId })              // 删除记录 + .jsonl

  // 对话内容
  getHistory({ topicId })          // 读取 .jsonl → { history: [...] }
}
```

### RPC 注册

在 `index.js` 的 `register(api)` 中，创建 TopicManager 实例并注册 RPC 方法。模式与现有的 session-manager 注册一致。

`generateTitle` 的 RPC handler 内调用 `title-gen.js` 的生成函数，该函数需要访问 gateway WebSocket 连接（从 realtime-bridge 获取）。

---

## 八、Topic .jsonl 的生命周期与风险

### OpenClaw 对 Topic .jsonl 的影响

| 操作 | 是否影响 | 原因 |
|------|:--------:|------|
| 重命名为 .reset/.deleted/.bak | ✗ | 这些操作通过 sessionKey 索引定位，Topic .jsonl 无索引 |
| 自动清理删除 | 通常 ✗ | 默认 `mode=warn` + `maxDiskBytes=null`，不触发 |
| 磁盘预算清理 | 极端情况 ✓ | `enforce` + `maxDiskBytes` 启用时，未引用 .jsonl 被优先清理 |

### 数据一致性

- `coclaw-topics.json` 是元信息的 source of truth
- `.jsonl` 文件是对话内容的 source of truth
- 两者通过 `topicId` 关联
- 若 `.jsonl` 被意外删除（极端场景），topic 元信息仍在，UI 可展示"内容不可用"

---

## 九、备选方案：使用 `runtime.subagent` API 生成标题

OpenClaw 提供了 `api.runtime.subagent` 作为插件内发起 agent 任务的官方 API（详见 `topic-feature-research.md` 第八章）。如果将来需要替换当前的"复制 .jsonl + gateway WS agent 调用"方案，可改为：

1. 从 topic 的 `.jsonl` 中提取首轮对话内容（user message + assistant response）
2. `subagent.run({ sessionKey: "coclaw:title-gen:<topicId>", message: <提取内容>, extraSystemPrompt })` → `{ runId }`
3. `subagent.waitForRun({ runId, timeoutMs: 30000 })` → 确认完成
4. `subagent.getSessionMessages({ sessionKey, limit: 1 })` → 提取标题
5. `subagent.deleteSession({ sessionKey, deleteTranscript: true })` → 清理

**优势**：官方 API，无需处理两阶段响应，无需文件复制。
**劣势**：`subagent` 只接受 sessionKey（不接受 sessionId），会在 `sessions.json` 中创建条目需清理；需提取对话内容而非复制文件；必须使用唯一 sessionKey 避免并发冲突。
**限制**：仅在 `registerGatewayMethod` handler 内可用（依赖 `AsyncLocalStorage`）。

当前阶段采用"复制 .jsonl + gateway WS"方案，此方案作为备选。

---

## 十、关键源码依赖

| 依赖 | 来源 | 用途 |
|------|------|------|
| `atomicWriteJsonFile` | `plugins/openclaw/src/utils/atomic-write.js` | coclaw-topics.json 原子写入 |
| `createMutex` | `plugins/openclaw/src/utils/mutex.js` | read-modify-write 并发保护 |
| session-manager 的 .jsonl 解析 | `plugins/openclaw/src/session-manager/manager.js` | getHistory 复用解析逻辑 |
| realtime-bridge gateway WS | `plugins/openclaw/src/realtime-bridge.js` | generateTitle 的 agent 调用通道 |
| `api.registerGatewayMethod` | OpenClaw Plugin API | 注册 RPC 方法 |
| `resolveAgentSessionsDir` | OpenClaw 路径解析 | 定位 sessions 目录 |

---

## 十一、研究基础

本设计基于 `docs/openclaw-research/topic-feature-research.md` 中的研究结论，关键依据：

- `agent(sessionId=<uuid>)` 不传 sessionKey 时不写入 `sessions.json`
- OpenClaw 的文件清理不影响 `.json` 文件
- 三种 `.jsonl` 重命名均为通过索引关系的定向操作
- `extraSystemPrompt` 可在 `agent()` 中注入
- 所有 LLM 调用路径均走完整 agent 流水线
- `agent()` RPC 采用两阶段响应模式（accepted → final）
- `ensureSessionHeader` 不校验 .jsonl 头部的 `id` 字段
- 每个 agent 的 sessions 目录天然隔离（`resolveAgentSessionsDir` 硬编码按 agentId）
