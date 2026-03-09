# OpenClaw RPC 协议与 Session 机制

> 合并自 session-key-vs-session-id.md + chat-vs-agent-semantics.md
> 更新时间：2026-03-09

---

## 1. 核心概念

### 1.1 Session Key（逻辑路由标识）

- **含义**：标识一个"对话桶"——决定消息归属到哪个上下文
- **格式示例**：`agent:main:main`、`agent:main:webchat:direct:alice`
- **存储位置**：`~/.openclaw/agents/<agentId>/sessions/sessions.json` 的 map key
- **特点**：
  - 由 dmScope、channel、peer 等维度计算得出
  - 通常**不变**（除非修改路由配置）
  - 一个 key 在不同时刻可能关联不同的 sessionId（`/new` 或 `/reset` 后切换）

> 类比：Session Key 像文件夹路径

### 1.2 Session ID（物理 transcript 标识）

- **含义**：标识一个具体的 transcript 文件实例
- **格式**：UUID v4，如 `5c8e57f0-73c0-47ed-b302-7e55804a916b`
- **对应文件**：`~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`
- **特点**：
  - 每次 `/new` 或 `/reset` 生成新 UUID
  - 文件在磁盘上持久存在（即使 key 被删除）
  - 归档后重命名为 `<sessionId>.jsonl.reset.<timestamp>` 或 `.deleted.<timestamp>`

> 类比：Session ID 像文件夹里当前活跃的文件名

### 1.3 两者关系

```
sessions.json
┌─────────────────────────────────────────────────┐
│ "agent:main:main" (sessionKey)                   │
│   → { sessionId: "5c8e...", updatedAt, model, …} │
│                                                   │
│ "agent:main:webchat:direct:alice" (sessionKey)    │
│   → { sessionId: "a1b2...", updatedAt, model, …} │
└─────────────────────────────────────────────────┘
                     ↓ 映射
        sessions/5c8e....jsonl   (transcript 文件)
        sessions/a1b2....jsonl   (transcript 文件)
```

- **一个 sessionKey** 在任意时刻关联**一个 sessionId**
- **一个 sessionId** 始终关联**一个 transcript 文件**
- **Orphan session**：transcript 文件仍在磁盘，但 sessionKey 已从 `sessions.json` 中删除

### 1.4 Cron Key 语义

- `agent:main:cron:<jobId>`：cron job 级锚点 key（当前指针）
- `agent:main:cron:<jobId>:run:<runId/sessionId>`：单次运行快照 key
- run key 不是"子会话层级"，而是运行记录别名；下一次 run 时 base key 会前移

---

## 2. Session 生命周期

```
1. 创建 (CREATED)
   用户首次发消息 → 计算 sessionKey → 生成 sessionId → 写入 sessions.json → 创建 .jsonl

2. 活跃使用 (ACTIVE)
   同一 sessionKey → 找到 sessionId → 追加 transcript → 更新 sessions.json 元数据

3. 重置 (RESET)
   用户执行 /new 或 /reset → 旧 transcript 归档 (.jsonl.reset.<ts>)
   → 生成新 sessionId → sessions.json 更新为新 ID → sessionKey 不变

4. 删除/孤立 (ORPHAN)
   用户删除 session 或配置变更 → sessionKey 从 sessions.json 移除
   → transcript 文件改名 (.jsonl.deleted.<ts>) 或留在磁盘
   → sessionId 仍可在文件系统发现
```

### `agent:main:main` 创建时机

- `agent:main:main` 作为 canonical key 总是可解析
- 但其在 `sessions.json` 的 entry 通常是**按需创建**（首次实际会话流量写入时）
- 非"安装后/启动后必定预置 entry"

### 自动 Session Reset

- 自动 reset（会话 freshness 失效后换新 sessionId）不会单独推送专门事件
- `chat.send` ACK 与 `chat` 事件都不直接包含底层 `sessionId`
- 若要判断是否重置，需主动查询（详见 `detect-sessionid-change.md`）

---

## 3. 两种 RPC 发送接口

`chat.send` 与 `agent()` 底层都会触发 agent run，差异主要在 **Gateway 对外协议层**。

### 3.1 `chat.send`

```json
{
  "method": "chat.send",
  "params": {
    "sessionKey": "agent:main:main",
    "message": "用户消息",
    "idempotencyKey": "uuid-v4",
    "thinking": "medium"
  }
}
```

- **必须传** `sessionKey`（不接受 sessionId）
- 内部通过 `loadSessionEntry(sessionKey)` 查找 sessions.json
- 如果找不到匹配的 sessionKey → 报错 `No session found`

**ACK**：`{ runId, status: "started" }`

**事件流**：`event: "chat"`
- `state: "delta"` — 增量文本块（需要前端累加）
- `state: "final"` — 完整的最终文本
- `state: "error"` — 错误信息
- `state: "aborted"` — 中止（含部分文本和 stopReason）

**Delta 载荷示例**：
```json
{
  "event": "chat",
  "payload": {
    "runId": "xxx",
    "sessionKey": "agent:main:main",
    "seq": 2,
    "state": "delta",
    "message": {
      "role": "assistant",
      "content": [{ "type": "text", "text": "增量文本" }],
      "timestamp": 1771572313559
    }
  }
}
```

### 3.2 `agent`

```json
{
  "method": "agent",
  "params": {
    "sessionId": "5c8e57f0-...",
    "message": "用户消息",
    "deliver": false,
    "idempotencyKey": "uuid-v4",
    "thinking": "medium"
  }
}
```

- 可传 `sessionKey`（路由到 indexed session）或 `sessionId`（直接指向 transcript）
- 对 orphan session 唯一可靠的方式

**ACK**：`{ runId, status: "accepted" }`

**事件流**：`event: "agent"`
- `stream: "lifecycle"` — phase: start / end / error
- `stream: "assistant"` — data.text 为**当前完整文本**（替换模式，非追加）
- `stream: "tool"` — 工具调用与结果
- `stream: "thinking"` — 思考过程

### 3.3 `agent(sessionKey)` 可行性

可行，且可保持会话桶语义：

- `agent` 方法支持 `sessionKey` 参数
- 使用 `sessionKey` 时，OpenClaw 会按 key 读取/更新会话 entry（而不是绕开 key）
- 因此不会像 `agent(sessionId)`（orphan 恢复场景）那样弱化 key 语义

> `agent(sessionKey)` 不是 `chat.send` 的"调用别名"，但在会话维护层面可覆盖大部分 chat 需求。

### 3.4 关键差异汇总

| 对比项 | chat.send | agent |
|--------|-----------|-------|
| 必须参数 | sessionKey | sessionKey 或 sessionId |
| ACK status | `"started"` | `"accepted"` |
| 事件类型 | `"chat"` | `"agent"` |
| 文本交付 | delta 增量追加 | text 完整替换 |
| 工具可见 | ❌ | ✅ |
| 思考可见 | ❌ | ✅ |
| 生命周期事件 | ❌（靠 final/error 终止） | ✅（lifecycle stream） |
| orphan 支持 | ❌ | ✅ |
| 中止支持 | ✅（chat.abort） | 需额外处理 |

---

## 4. 参考来源

- OpenClaw 源码：`openclaw-repo/src/gateway/server-methods/chat.ts`（chat.send 实现）
- OpenClaw 源码：`openclaw-repo/src/gateway/server-methods/agent.ts`（agent 实现）
- OpenClaw 源码：`openclaw-repo/src/config/sessions/types.ts`（SessionEntry 类型）
- 验证项目：`tunnel-poc/protocol-dumps/`（实际协议抓包）
