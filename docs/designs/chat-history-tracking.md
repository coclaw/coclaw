# Chat 历史 Session 追踪与消息加载重构

> 创建时间：2026-03-17
> 状态：草案
> 前置依赖：`docs/designs/topic-management.md`（Topic 管理功能已实施）
> 研究基础：`docs/openclaw-research/topic-feature-research.md`

---

## 一、概述

### 目标

1. **追踪 chat 的历史 sessions**：当 OpenClaw reset 一条 chat（sessionKey）时，旧 session 成为孤儿。插件通过 `session_start` 钩子捕获这些事件，持久化孤儿链，使 UI 能向前加载历史对话。
2. **消息加载接口统一**：引入 `coclaw.sessions.getById` 替代 `nativeui.sessions.get`，使 topic、孤儿 session 和 chat 当前 session 的消息格式一致。
3. **Chat 模式基于 sessionKey 发送**：UI 在 chat 模式下始终使用 `agent({ sessionKey })` 发送消息，不再依赖 sessionId。

### 术语

参见项目 `CLAUDE.md` 核心术语表。补充：

| 术语 | 含义 |
|------|------|
| chat history | 一条 chat（sessionKey）因 reset 产生的所有历史孤儿 session 记录 |
| 当前 session | sessionKey 当前关联的 sessionId，由 OpenClaw `sessions.json` 管理 |

---

## 二、插件侧：Chat History 追踪

### 2.1 数据模型

**文件**：`~/.openclaw/agents/<agentId>/sessions/coclaw-chat-history.json`

```jsonc
{
  "version": 1,
  "agent:main:main": [
    { "sessionId": "550e8400-...", "archivedAt": 1742003000000 },
    { "sessionId": "a1b2c3d4-...", "archivedAt": 1742002000000 }
  ],
  "agent:main:telegram:direct:12345": [
    { "sessionId": "f9e8d7c6-...", "archivedAt": 1742001000000 }
  ]
}
```

- sessionKey 为顶层 key，值为孤儿 session 数组（按 `archivedAt` 降序，最近的在前）
- **只记录被抛弃的孤儿 sessionId**，不记录 sessionKey 的当前 sessionId
- `version` 字段预留格式迁移
- 该 `.json` 文件不受 OpenClaw 任何清理机制影响

**路径解析**：与 topic-manager 一致，通过 `resolveAgentSessionsDir(agentId)` 获取 sessions 目录，拼接文件名。

**文件读写规范**：遵循插件 CLAUDE.md 文件 I/O 安全规范（atomicWriteJsonFile + mutex）。

### 2.2 内存模型

- 插件启动时从磁盘加载到内存（文件不存在时初始化为 `{ version: 1 }`）
- 所有读操作从内存读取
- 写操作在内存修改后通过 mutex + atomicWrite 持久化
- 不需要 file watcher——该文件仅由本插件写入

### 2.3 session_start 钩子

在插件 `register(api)` 中注册：

```js
api.on('session_start', async (event, ctx) => {
  if (!event.resumedFrom) return; // 首次创建，无前任
  await chatHistoryManager.recordArchived({
    agentId: ctx.agentId,
    sessionKey: event.sessionKey,
    sessionId: event.resumedFrom,  // 被抛弃的旧 sessionId
  });
});
```

**钩子特性回顾**：
- fire-and-forget：调用方不 await，但钩子内的 async 操作正常完成
- `event.sessionKey` 实际始终有值（类型标 `?` 仅为防御性声明）
- `event.resumedFrom` 指向旧 sessionId；首次创建时为 `undefined`
- `ctx.agentId` 从 sessionKey 中解析

**触发矩阵**：

| 场景 | 是否触发 |
|------|:--------:|
| 自动过期（daily/idle reset） | ✓ |
| `/new`、`/reset` 通过 `chat.send` | ✓ |
| `/new`、`/reset` 通过 `agent()` RPC | ✗ |
| `sessions.reset` RPC | ✗ |

**未覆盖场景处理**：通过 `agent()` RPC 发送 `/new`、`/reset` 不触发钩子。**标记为 TODO**——后续 CoClaw 将切换为通过 `chat.send` 发送 reset 命令，届时钩子自然触发。当前阶段接受此缺口（用户手动 `/new` 时历史可能不完整）。

### 2.4 新增模块

`src/chat-history-manager/` 目录：

| 文件 | 职责 |
|------|------|
| `manager.js` | ChatHistoryManager 类：内存模型、记录追加、列表查询、磁盘读写 |
| `manager.test.js` | 单元测试 |

```js
class ChatHistoryManager {
  constructor({ sessionsDir, logger })

  // 生命周期
  load()  // 从磁盘加载到内存

  // 记录
  recordArchived({ agentId, sessionKey, sessionId })
  // → 在对应 sessionKey 数组头部插入 { sessionId, archivedAt: Date.now() }
  // → 持久化到磁盘

  // 查询
  list({ agentId, sessionKey })
  // → 返回 { history: [{ sessionId, archivedAt }] }
}
```

**agentId 参数的作用**：sessionKey 中已包含 agentId，但显式传入可避免解析 sessionKey 即可定位 `coclaw-chat-history.json` 文件路径。这与 OpenClaw 原生 RPC 的参数设计一致（如 `sessions.list` 也接受 `agentId`）。

### 2.5 RPC 注册

在 `index.js` 的 `register(api)` 中注册：

| 方法 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `coclaw.chatHistory.list` | `{ agentId, sessionKey }` | `{ history: [{ sessionId, archivedAt }] }` | 获取指定 chat 的孤儿 session 列表 |

仅此一个 RPC。前端拿到完整 history 后在内存中按需取用，不需要 `previous` 之类的逐条查询接口。

---

## 三、插件侧：coclaw.sessions.getById

### 3.1 用途

统一的按 sessionId 读取 .jsonl transcript 的接口，替代 `nativeui.sessions.get`。适用于：
- topic 对话内容加载
- 孤儿 session（chat history）内容加载

### 3.2 接口定义

| 方法 | 参数 | 返回 |
|------|------|------|
| `coclaw.sessions.getById` | `{ sessionId: string, agentId?: string, limit?: number }` | `{ messages: [...] }` |

- `sessionId`：必填，目标 session 的 UUID
- `agentId`：可选，默认 `'main'`。用于定位 sessions 目录
- `limit`：可选，默认 500。返回最后 N 条消息

### 3.3 返回格式

**保持完整的 JSONL 行级结构**，与 `nativeui.sessions.get` 一致：

```json
{
  "messages": [
    { "type": "message", "id": "msg_abc", "message": { "role": "user", "content": "...", "timestamp": 1742000000 } },
    { "type": "message", "id": "msg_def", "message": { "role": "assistant", "content": "...", "model": "claude-sonnet-4-5-20250514", "stopReason": "end_turn" } }
  ]
}
```

每个元素是完整的 JSONL 行对象，包含 `type`、`id`、`message` 三个顶层字段。`message` 子对象中含 `role`、`content`、`model`、`timestamp`、`stopReason` 等字段。

**选择此格式的原因**：UI 的消息渲染管线（`session-msg-group.js` 的 `groupSessionMessages`）重度依赖 JSONL 行级结构：
- `entry.type === 'message'` 守卫——缺失则所有条目被跳过
- `entry.id` 作为 Vue `:key` 和 botTask 分组 ID
- `entry.message.model`、`entry.message.timestamp`、`entry.message.stopReason` 用于 botTask 聚合

保持此格式可使 `groupSessionMessages` 和 chat.store 的本地条目构造（streaming/optimistic entries）完全无需改动。

### 3.4 实现

session-manager 中已有 `getById` 方法（`manager.js:339-365`），返回完整 JSONL 行结构：

```js
function getById(params = {}) {
  // 1. 尝试 <sessionId>.jsonl（live transcript）
  // 2. fallback 到最新的 <sessionId>.jsonl.reset.<ts>（归档）
  // 3. 解析 JSONL 每行为完整对象
  // 4. 过滤 type==="message" 且有合法 message.role 的行
  // 5. 取最后 limit 条
  // 6. 返回 { messages: [...] }
}
```

### 3.5 消息格式与 OC sessions.get 的关系

**背景**：OpenClaw 原生 `sessions.get({ key })` 返回的消息格式与我们不同。OC 的 `readSessionMessages` 函数（`session-utils.fs.ts:93-95`）对每行 JSONL 做了解包——只取 `parsed.message` 子对象，丢弃外层的 `type` 和 `id`：

```
磁盘 JSONL 行：  { "type": "message", "id": "msg_abc", "message": { "role": "assistant", "content": "...", "model": "...", "stopReason": "..." } }
                                                                    ↓ OC sessions.get 提取 parsed.message
OC 返回：        { "role": "assistant", "content": "...", "model": "...", "stopReason": "..." }
```

**关键事实**：`model`、`timestamp`、`stopReason` 等 UI 需要的字段**本就在 `message` 子对象内**，OC 返回时这些字段完整保留。真正丢失的只有外层的 `type`（固定为 `"message"`）和 `id`（OC 消息 ID）。

因此 UI 在使用 OC `sessions.get` 时需要一层薄包装，将扁平格式恢复为 JSONL 行级结构（详见 4.2 节）。

### 3.6 消息格式汇总

| 接口 | 返回格式 | UI 是否需要转换 |
|------|----------|:----------:|
| `coclaw.sessions.getById` | `[{ type, id, message: { role, content, ... } }]` | 否 |
| OC `sessions.get({ key })` | `[{ role, content, model, timestamp, ... }]` | **是**（薄包装） |
| `nativeui.sessions.get`（旧） | `[{ type, id, message: { role, content, ... } }]`（含非 message 行） | 否（将废弃） |

### 3.7 coclaw.topics.getHistory 的处理

`coclaw.topics.getHistory` 当前调用 session-manager 的 `get()` 返回旧格式。有两个选择：

- **方案 A**：`coclaw.topics.getHistory` 内部改为调用 `coclaw.sessions.getById` 的逻辑，返回新格式
- **方案 B**：废弃 `coclaw.topics.getHistory`，UI 直接用 `coclaw.sessions.getById({ sessionId: topicId })` 加载 topic 内容

**推荐方案 B**——减少接口数量，`coclaw.sessions.getById` 本身就是按 sessionId 加载，topicId 即 sessionId。`coclaw.topics.getHistory` 在 topic-management.md 中已标记为"未来可废弃"。

### 3.8 nativeui.sessions.* 废弃路径

| 接口 | 当前状态 | 目标 |
|------|----------|------|
| `nativeui.sessions.listAll` | 被 chat.store.js 和 sessions.store.js 调用 | 移除所有调用点，插件代码保留但标记 deprecated |
| `nativeui.sessions.get` | 被 chat.store.js loadMessages 调用 | 被 `coclaw.sessions.getById` 替代 |

---

## 四、UI 侧：Chat 模式重构

### 4.1 消息发送——始终使用 sessionKey

**当前行为**（`chat.store.js:284-323`）：
```
sessionKeyById 有缓存？→ 用 sessionKey → 轮转检测
                    ↘ fallback → 用 sessionId
```

**新行为**：
```
chat 模式 → 始终 agent({ sessionKey })
topic 模式 → 始终 agent({ sessionId: topicId })
```

**具体改动**（`chat.store.js` `sendMessage` 方法）：

1. **移除 `sessionKeyById` 缓存**——不再需要维护 sessionId → sessionKey 映射
2. **chat 模式下 sessionKey 从 store 状态中获取**——新增 `chatSessionKey` 状态字段
3. **移除轮转检测（`__detectRotation`）**——基于 sessionKey 发送时，OpenClaw 自行解析到当前 sessionId，无需 UI 检测轮转
4. **agentParams 构建简化**：

```js
const agentParams = {
  message: safeText,
  deliver: false,
  idempotencyKey,
};
if (attachments.length) agentParams.attachments = attachments;

if (this.topicMode) {
  agentParams.sessionId = this.sessionId;
} else {
  agentParams.sessionKey = this.chatSessionKey;
}
```

### 4.2 消息加载

**当前行为**（`chat.store.js:142-177` `loadMessages`）：
1. 调用 `nativeui.sessions.listAll` 构建 `sessionKeyById`
2. 调用 `nativeui.sessions.get` 获取消息

**新行为**：

```
chat 模式：
  1. 调用 OC sessions.get({ key: chatSessionKey }) → { messages: [{ role, content, ... }] }
  2. 薄包装为 JSONL 行级结构 [{ type, id, message }]（见下方 wrapOcMessages）
  3. 调用 chat.history({ sessionKey, limit: 1 }) → { sessionId }

topic 模式 / 孤儿 session：
  1. 调用 coclaw.sessions.getById({ sessionId }) → { messages: [{ type, id, message }] }
  2. 直接使用，无需包装
```

#### OC sessions.get 返回值的薄包装

OC `sessions.get({ key })` 返回解包后的消息（`[{ role, content, model, timestamp, stopReason, ... }]`），需要包装为 UI 消息管线所需的 JSONL 行级结构。

包装逻辑很简单——补上被 OC 剥离的两个外层字段：

```js
// ui/src/utils/message-normalize.js
function wrapOcMessages(flatMessages) {
  if (!Array.isArray(flatMessages)) return [];
  return flatMessages.map((msg, i) => ({
    type: 'message',          // OC 只返回 type=message 的行，固定补 'message'
    id: `oc-${i}`,            // 原始 id 被 OC 丢弃，用索引生成唯一 id（仅用于 Vue :key）
    message: msg,             // msg 本身已包含 role, content, model, timestamp, stopReason 等
  }));
}
```

**为什么这样做是安全的**：
- OC 的 `readSessionMessages`（`session-utils.fs.ts:93-95`）只对有 `parsed.message` 的行执行 `messages.push(parsed.message)`，而这些行在磁盘上的 `type` 必然是 `"message"`，因此固定补 `'message'` 正确
- `id` 在 UI 中仅用于 Vue `:key` 绑定（列表 diff）和 `groupSessionMessages` 的分组标识，不需要原始 OC 消息 ID
- `model`、`timestamp`、`stopReason` 等 `groupSessionMessages` 依赖的字段本就在 `message` 子对象内，OC 返回时完整保留

包装后的结构与 `coclaw.sessions.getById` 和 `nativeui.sessions.get` 返回的格式一致，`groupSessionMessages` 无需任何改动。

#### chat 模式 loadMessages 新实现

```js
async loadMessages({ silent = false } = {}) {
  if (this.topicMode) return this.__loadTopicMessages({ silent });

  const conn = this.__getConnection();
  // ... 连接检查（同现有逻辑）...

  try {
    if (!silent) { this.loading = true; this.errorText = ''; }

    // 1. 通过 OC 原生 sessions.get 加载当前 session 消息
    const result = await conn.request('sessions.get', {
      key: this.chatSessionKey,
      limit: 500,
    });
    const flatMessages = Array.isArray(result?.messages) ? result.messages : [];
    // 2. 薄包装为 JSONL 行级结构（补 type + id）
    this.messages = wrapOcMessages(flatMessages);

    // 3. 获取当前 sessionId（用于历史上翻）
    const hist = await conn.request('chat.history', {
      sessionKey: this.chatSessionKey,
      limit: 1,
    });
    this.currentSessionId = hist?.sessionId ?? null;

    return true;
  }
  catch (err) { /* ... */ }
  finally { this.loading = false; }
},
```

#### topic 模式 `__loadTopicMessages` 调整

- 将 `coclaw.topics.getHistory` 替换为 `coclaw.sessions.getById({ sessionId: topicId })`
- `coclaw.sessions.getById` 直接返回 JSONL 行级结构，无需包装

### 4.3 Chat Store 状态变更

**新增**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `chatSessionKey` | `string` | chat 模式下的 sessionKey（如 `agent:main:main`） |
| `currentSessionId` | `string \| null` | chat 当前 session 的 sessionId（从 `chat.history` 获取，用于历史上翻） |
| `historySessionIds` | `Array<{ sessionId, archivedAt }>` | 从 `coclaw.chatHistory.list` 加载的孤儿列表 |
| `historySegments` | `Array<{ sessionId, archivedAt, messages }>` | 向上加载的历史 session 分段（每段含 sessionId、归档时间和消息列表，按时间从旧到新排列） |
| `historyLoading` | `boolean` | 历史加载中标志 |
| `historyExhausted` | `boolean` | 已无更多历史 |

**移除**：

| 字段 | 原因 |
|------|------|
| `sessionKeyById` | 不再需要 sessionId → sessionKey 映射 |

### 4.4 activateSession 方法调整

当前 `activateSession(sessionId, { botId })` 使用 sessionId 激活 chat。新增 sessionKey 相关逻辑：

```js
activateSession(sessionId, { botId, sessionKey }) {
  this.$reset();
  this.sessionId = sessionId;
  this.botId = botId;
  this.chatSessionKey = sessionKey ?? '';
  this.topicMode = false;
  this.loadMessages();
  this.__loadChatHistory();  // 加载孤儿链
},
```

### 4.5 Agent 导航

> 更新于 2026-03-21：路由已迁移到 `/chat/:botId/:agentId`，详见 `docs/decisions/session-navigation.md`。

用户点击 agent 列表项时：

```
1. 导航到 /chat/<botId>/<agentId>
2. ChatPage 从路由参数直接获取 botId 和 agentId
3. sessionKey 由 agent:${agentId}:main 构造
4. 调用 chatStore.activateSession(botId, agentId)
5. activateSession 内部通过 loadMessages → chat.history 获取 currentSessionId（用于历史上翻）
```

**路由格式**：`/chat/:botId/:agentId`，使用稳定的 bot + agent 标识。sessionId 不出现在路由中。

### 4.6 历史懒加载

当用户在 chat 模式下向上滚动到消息列表顶端时：

```
1. 检测到滚动到顶 + !historyExhausted + !historyLoading
2. 从 historySessionIds 中取下一个未加载的 sessionId
   （historySessionIds 按 archivedAt 降序，从头部依次取）
3. 调用 coclaw.sessions.getById({ sessionId, agentId }) → { messages }
4. 将 messages prepend 到 historySegments
5. 在两段消息之间插入分隔标记（如 { _separator: true, sessionId, archivedAt }）
6. 若 historySessionIds 已全部加载完，设 historyExhausted = true
```

**__loadChatHistory**（进入 chat 时调用）：

```js
async __loadChatHistory() {
  if (this.topicMode || !this.chatSessionKey) return;
  const conn = this.__getConnection();
  if (!conn) return;
  try {
    const agentId = this.__resolveAgentId();
    const result = await conn.request('coclaw.chatHistory.list', {
      agentId,
      sessionKey: this.chatSessionKey,
    });
    this.historySessionIds = Array.isArray(result?.history) ? result.history : [];
    this.historyExhausted = this.historySessionIds.length === 0;
  }
  catch (err) {
    console.warn('[chat] loadChatHistory failed:', err?.message);
    this.historySessionIds = [];
    this.historyExhausted = true;
  }
},
```

### 4.7 Session 被 Reset 后的处理

#### 用户主动 `/new` 或 `/reset`

`__onChatEvent` 在 `loadMessages` 替换消息**之前**快照旧 session 状态（`prevSessionId` + `prevMessages`，过滤 `_local` 乐观消息）。`loadMessages` 完成后，若 `currentSessionId` 确实变化且旧消息非空，将旧消息作为 historySegment 直接追加到 `historySegments` 末尾（含去重）。

这完全绕过了对服务端孤儿索引（`coclaw-chat-history.json`）即时可用的依赖，避免了 `session_start` 钩子异步磁盘写入与 UI 请求之间的竞态条件。ChatPage 侧仅异步 fire-and-forget 调用 `__loadChatHistory()` 刷新孤儿列表供后续上翻使用。

#### OpenClaw 自动 reset（如 daily reset）

- **发送消息不受影响**：`agent({ sessionKey })` 由 OpenClaw 自行解析到新 sessionId
- **消息列表可能不连贯**：新消息出现在新 session 中，旧消息属于上一个 session
- **reconcile 机制**：`__reconcileMessages` 重新调用 `loadMessages`（内部用 `sessions.get({ key })`），会加载新 session 的消息。同时重新获取 `currentSessionId`
- **historySessionIds 不自动更新**：需用户重新进入页面或手动刷新。后续可通过插件广播 reset 事件优化

### 4.8 sessions.store 简化

**移除**：
- `nativeui.sessions.listAll` 调用
- 不再维护 session 列表供 UI 展示

**保留**：
- store 本身保留（可能有其他内部用途）
- `loadAllSessions` 改为获取每个 agent 的 main session 信息（用于导航）

**新行为**：sessions.store 的核心职责变为"维护 agent → { sessionId, sessionKey, botId } 映射"，供 agent 导航使用。数据来源可改为 `chat.history({ sessionKey, limit: 1 })` 而非 `nativeui.sessions.listAll`。

### 4.9 消息格式统一

所有消息加载路径最终都产出 JSONL 行级结构（`[{ type, id, message: { role, content, ... } }]`），`groupSessionMessages` 和 ChatPage 渲染层**无需任何改动**：

| 加载路径 | 接口 | 接口返回格式 | UI 侧处理 |
|----------|------|-------------|-----------|
| chat 当前 session | OC `sessions.get({ key })` | `[{ role, content, ... }]`（扁平） | `wrapOcMessages` 包装 |
| topic / 孤儿 session | `coclaw.sessions.getById` | `[{ type, id, message }]`（行级） | 直接使用 |
| 历史懒加载 | `coclaw.sessions.getById` | `[{ type, id, message }]`（行级） | 直接使用 |

`wrapOcMessages` 是唯一的转换点，位于 `ui/src/utils/message-normalize.js`。

---

## 五、ensureAgentSession

### 现状

`ensureAgentSession(agentId)` 在 `realtime-bridge.js:327-346` 中实现，通过 `sessions.resolve` + 条件 `sessions.reset` 确保 `sessions.json` 中存在 `agent:<agentId>:main` 条目。

触发时机：
1. Gateway WS 连接成功后（`__ensureAllAgentSessions`，fire-and-forget）
2. 每次 `nativeui.sessions.listAll` 调用前（best-effort）

### 新方案中的角色

**保留**，理由：
- 确保 `agent({ sessionKey })` 首次调用前 `sessions.json` 中已有条目
- 确保 `chat.history({ sessionKey })` 能返回有效 `sessionId`（UI 需要此值用于路由和历史上翻）
- 确保 `sessions.get({ key })` 能正常工作

第 2 个触发点（`nativeui.sessions.listAll` 前）随废弃自然消失。第 1 个触发点保留。

---

## 六、实施步骤

### Phase 1：插件侧

1. **新建 `src/chat-history-manager/manager.js`**
   - ChatHistoryManager 类（load、recordArchived、list）
   - 对应的单元测试 `manager.test.js`

2. **注册 `session_start` 钩子**
   - 在 `index.js` 的 `register(api)` 中 `api.on('session_start', ...)`
   - 调用 chatHistoryManager.recordArchived

3. **注册 `coclaw.chatHistory.list` RPC**
   - 在 `index.js` 中注册
   - 对应的单元测试

4. **实现 `coclaw.sessions.getById` RPC**
   - 基于 session-manager 的 .jsonl 解析能力
   - 返回格式与 OC `sessions.get` 一致（`{ messages: [{ role, content }] }`）
   - 对应的单元测试

5. **更新 `coclaw.info` capabilities**
   - 在 capabilities 数组中添加 `'chatHistory'`

### Phase 2：UI 侧

6. **新增消息 normalize 工具**
   - `ui/src/utils/message-normalize.js`
   - 兼容新旧格式

7. **chat.store.js 重构**
   - 新增状态字段：`chatSessionKey`、`currentSessionId`、`historySessionIds`、`historySegments`、`historyLoading`、`historyExhausted`
   - 移除 `sessionKeyById`
   - `loadMessages` 改用 OC `sessions.get({ key })` + `chat.history` 获取 sessionId
   - `sendMessage` 简化：chat 模式用 sessionKey，topic 模式用 sessionId
   - 移除 `__detectRotation`
   - 新增 `__loadChatHistory`
   - `activateSession` 接收 sessionKey 参数
   - topic 消息加载改用 `coclaw.sessions.getById`

8. **sessions.store.js 简化**
   - 移除 `nativeui.sessions.listAll` 调用
   - 改为维护 agent → { sessionId, sessionKey, botId } 映射

9. **ChatPage 历史懒加载**
   - 监听消息列表滚动到顶
   - 从 `historySessionIds` 取下一个 sessionId
   - 调用 `coclaw.sessions.getById` 加载并 prepend
   - 插入分隔标记

10. **Agent 导航调整**（已实施，2026-03-21）
    - 路由迁移到 `/chat/:botId/:agentId`
    - 点击 agent 直接导航，sessionKey 由 agentId 构造

### Phase 3：清理

11. **标记 `nativeui.sessions.*` deprecated**
    - 插件代码保留但添加 deprecated 注释
    - 移除所有 UI 调用点

12. **移除 `coclaw.topics.getHistory`**
    - UI 改用 `coclaw.sessions.getById({ sessionId: topicId })`

---

## 七、/new 和 /reset 命令处理

斜杠命令（`/new`、`/reset`、`/compact` 等）改为通过 `chat.send()` 路径发送。该路径经 auto-reply 流水线处理，**会触发全部插件钩子**（包括 `session_start`），从而自然消除 session 链追踪的钩子缺口。

详细方案见 `docs/designs/slash-command-support.md`。

---

## 八、关键源码依赖

| 依赖 | 来源 | 用途 |
|------|------|------|
| `atomicWriteJsonFile` | `plugins/openclaw/src/utils/atomic-write.js` | coclaw-chat-history.json 原子写入 |
| `createMutex` | `plugins/openclaw/src/utils/mutex.js` | read-modify-write 并发保护 |
| session-manager .jsonl 解析 | `plugins/openclaw/src/session-manager/manager.js` | `coclaw.sessions.getById` 复用解析逻辑 |
| `api.on('session_start')` | OpenClaw Plugin API | 钩子注册 |
| `api.registerGatewayMethod` | OpenClaw Plugin API | RPC 注册 |
| `resolveAgentSessionsDir` | OpenClaw 路径解析 | 定位 sessions 目录 |
| OC `sessions.get` | OpenClaw Gateway RPC | 按 sessionKey 加载消息 |
| OC `chat.history` | OpenClaw Gateway RPC | 获取 sessionKey 当前的 sessionId |
| `ensureAgentSession` | `plugins/openclaw/src/realtime-bridge.js` | 确保 sessions.json 条目存在 |

---

## 九、研究基础

本设计基于 `docs/openclaw-research/topic-feature-research.md` 中的研究结论，关键依据：

- `session_start` 钩子的 `resumedFrom` 字段指向被抛弃的旧 sessionId
- 钩子为 fire-and-forget（`void hookRunner.run...catch(() => {})`），但异步操作会完成
- `sessionKey` 在钩子 event 中实际始终有值
- 通过 `agent()` RPC 发送的 `/new` 不触发插件钩子
- OpenClaw `sessions.get({ key })` 返回原始 transcript 消息，格式为 `[{ role, content }]`
- OpenClaw `chat.history({ sessionKey })` 额外返回 `sessionId`
- `agent({ sessionKey })` 在 sessionKey 无条目时自动创建 session
- sidecar `.json` 文件不受 OpenClaw 清理机制影响
- `.jsonl` 重命名都是通过 sessionKey 索引的定向操作，不影响无索引的文件
