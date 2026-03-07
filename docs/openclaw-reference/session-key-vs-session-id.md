# OpenClaw：Session Key 与 Session ID 关系说明

> 更新时间：2026-03-02
> 面向对象：coding agent / 开发同学
> 目标：厘清 OpenClaw 中 sessionKey 与 sessionId 的关系，为 CoClaw 接入"基于 sessionKey 的继续对话"提供设计依据。

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

---

## 3. 两种发送接口对比

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
- 内部通过 `loadSessionEntry(sessionKey)` 查找 sessions.json，提取 sessionId
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

**Final 载荷示例**：
```json
{
  "event": "chat",
  "payload": {
    "runId": "xxx",
    "sessionKey": "agent:main:main",
    "seq": 6,
    "state": "final",
    "message": {
      "role": "assistant",
      "content": [{ "type": "text", "text": "完整回复文本" }],
      "timestamp": 1771572313696
    }
  }
}
```

**特点**：
- 纯文本流，**不包含工具调用信息**
- **不包含 thinking 流**
- 适合简单的 WebChat 场景

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

**特点**：
- 丰富的执行轨迹（工具、思考、生命周期）
- 适合需要展示 agent 执行过程的场景

### 3.3 关键差异汇总

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

## 4. 对 CoClaw 的设计启示

### 4.1 当前状态

- **Orphan 续聊**（已实现）：通过 `agent(sessionId=...)` 发送，监听 `agent` 事件流，完整展示 assistant 文本 + 工具步骤 + 思考
- **Indexed session**（待完善）：当前代码调用 `chat.send` 但**未监听 chat 事件流**，仅等 ACK 后立即 reload，用户看不到流式回复

### 4.2 设计选项

详见后续方案讨论。核心决策点：

1. indexed session 是继续用 `chat.send` + 补全 chat 事件监听，还是统一用 `agent(sessionKey=...)`？
2. 如果用 `chat.send`，如何处理缺失的工具/思考信息？
3. 两种路径的 UI 体验是否需要完全一致？

---

## 5. 参考来源

- OpenClaw 源码：`openclaw-repo/src/gateway/server-methods/chat.ts`（chat.send 实现）
- OpenClaw 源码：`openclaw-repo/src/gateway/server-methods/agent.ts`（agent 实现）
- OpenClaw 源码：`openclaw-repo/src/config/sessions/types.ts`（SessionEntry 类型）
- 验证项目：`tunnel-poc/protocol-dumps/`（实际协议抓包）
- 验证项目：`tunnel-poc/docs/2026-03-01-orphan-session-resume-verification.md`
- CoClaw 文档：`docs/orphan-session-resume-via-gateway-agent.md`
- CoClaw 文档：`docs/openclaw-关键概念.md`
