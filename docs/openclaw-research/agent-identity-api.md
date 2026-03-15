# OpenClaw Agent Identity 获取机制

> 研究日期：2026-03-14
> 来源：openclaw-repo/openclaw 源码分析

## 1. 概述

OpenClaw 中 agent 的展示信息（name、avatar、emoji）分散在多个数据源中，不同的 RPC 方法返回的数据层次不同。本文档梳理各获取方式的行为差异和 fallback 策略。

## 2. 数据源层次

Agent 的 identity 信息存储在三个层次：

| 层次 | 位置 | 示例 |
|---|---|---|
| 全局 UI 配置 | `cfg.ui.assistant` | `{ name: "MyBot", avatar: "bot.png" }` |
| Agent config identity | `cfg.agents.list[].identity` | `{ name: "压测锤", emoji: "🔨" }` |
| Workspace IDENTITY.md | `~/.openclaw/<workspace>/IDENTITY.md` | `- **Name:** 压测锤` |

另有一个**独立于 identity 体系**的字段：

| 字段 | 位置 | 说明 |
|---|---|---|
| `cfg.agents.list[].name` | config 顶层 | 创建 agent 时的原始名称，用于派生 agentId，**不参与** identity fallback |

## 3. RPC 方法对比

### 3.1 `agents.list`

- **权限**：`operator.read`
- **入参**：`{}`
- **返回**：config 中的 raw 数据，不做 fallback 合并，不读 IDENTITY.md

```json
{
  "defaultId": "main",
  "mainKey": "agent:main:main",
  "scope": "per-sender",
  "agents": [
    {
      "id": "tester",
      "name": "tester",
      "identity": {
        "name": "...",
        "emoji": "...",
        "avatar": "...",
        "avatarUrl": "..."
      }
    }
  ]
}
```

字段说明：
- `name`：来自 `cfg.agents.list[].name`（顶层字段，创建时的原始输入）
- `identity`：来自 `cfg.agents.list[].identity`（子对象），**仅当 config 中配置了 identity 块时才存在**，否则为 `undefined`
- `identity.avatarUrl`：对本地文件路径的 avatar 会转为 data URI

**实际示例**：若 tester 的 config 为 `{ id: "tester", name: "tester" }`（无 identity 块），则返回 `{ id: "tester", name: "tester" }`，无 identity 字段。即使 IDENTITY.md 中写了 `Name: 压测锤`，这里也**不会**返回。

> 来源：`src/gateway/session-utils.ts` L338-394（`listAgentsForGateway`）

### 3.2 `agent.identity.get`

- **权限**：`operator.read`
- **入参**：`{ agentId?: string, sessionKey?: string }`（二选一或都不传）
- **返回**：经完整 fallback 链解析后的**最终展示用** identity

```json
{
  "agentId": "tester",
  "name": "压测锤",
  "avatar": "🔨",
  "emoji": "🔨"
}
```

该方法内部调用 `resolveAssistantIdentity()`，对每个字段执行独立的 fallback 链（见下文第 4 节）。

> 来源：`src/gateway/server-methods/agent.ts` L635-688

### 3.3 对比总结

| 维度 | `agents.list` | `agent.identity.get` |
|---|---|---|
| 数据来源 | config raw 字段 | 完整 fallback（config + IDENTITY.md + 默认值） |
| 读取 IDENTITY.md | 否 | 是 |
| 未配置时的 name | `undefined` | `"Assistant"` |
| 未配置时的 avatar | `undefined` | `"A"` |
| 批量 vs 单个 | 批量（一次返回所有 agent） | 单个（需逐个调用） |
| 顶层 name 字段 | 包含（`agent.name`） | 不包含 |

## 4. Identity Fallback 链

来源：`src/gateway/assistant-identity.ts` L81-118（`resolveAssistantIdentity`）

### 4.1 name

```
cfg.ui.assistant.name            （全局覆盖，所有 agent 共用）
  → cfg.agents.list[id].identity.name  （per-agent config identity 子对象）
  → IDENTITY.md 的 Name: 字段        （workspace 文件）
  → "Assistant"                       （硬编码默认值）
```

**注意**：`cfg.agents.list[id].name`（顶层 name 字段）**不在此链中**。代码路径：`resolveAgentIdentity(cfg, agentId)` 返回的是 `resolveAgentConfig(cfg, agentId)?.identity`，只取 identity 子对象，跳过顶层 name。

### 4.2 avatar

```
cfg.ui.assistant.avatar
  → cfg.agents.list[id].identity.avatar
  → cfg.agents.list[id].identity.emoji    （emoji 可作为 avatar 的 fallback）
  → IDENTITY.md 的 Avatar: 字段
  → IDENTITY.md 的 Emoji: 字段           （同理）
  → "A"                                  （硬编码默认值）
```

每个候选值经过 `normalizeAvatarValue()` 校验，首个通过的被采用。avatar 支持的格式：
- emoji / 短文本（≤4 字符）
- 工作区相对路径（如 `avatars/bot.png`）
- 绝对路径 / `~` 路径
- `http(s)://` URL
- `data:` URI

本地文件限制：`.png`/`.jpg`/`.jpeg`/`.gif`/`.webp`/`.svg`，最大 2MB。

### 4.3 emoji

```
cfg.ui.assistant.avatar          （avatar 也可作为 emoji 候选）
  → cfg.agents.list[id].identity.avatar
  → cfg.agents.list[id].identity.emoji
  → IDENTITY.md 的 Avatar: 字段
  → IDENTITY.md 的 Emoji: 字段
  → undefined                    （无默认值）
```

候选值经过 `normalizeEmojiValue()` 校验，要求包含**非 ASCII 字符**（即真正的 emoji）。纯 ASCII 字符串（如 `"A"`）不会通过。

## 5. IDENTITY.md 解析规则

来源：`src/agents/identity-file.ts` L38-78（`parseIdentityMarkdown`）

### 5.1 支持的格式

```markdown
- **Name:** 压测锤
- Name: 压测锤
- _Name:_ 压测锤
```

解析时逐行处理：
1. 去掉行首 `- ` 前缀
2. 以第一个 `:` 分割为 label 和 value
3. label 剥掉所有 `*` 和 `_`，转小写
4. value 剥掉首尾 `*`/`_`，trim
5. value 为空则跳过该行

### 5.2 识别的字段

| label（不区分大小写） | 映射到 |
|---|---|
| `name` | `identity.name` |
| `emoji` | `identity.emoji` |
| `avatar` | `identity.avatar` |
| `creature` | `identity.creature` |
| `vibe` | `identity.vibe` |

### 5.3 文件位置

`<workspace>/IDENTITY.md`（常量 `DEFAULT_IDENTITY_FILENAME`）

workspace 路径由 `resolveAgentWorkspaceDir(cfg, agentId)` 确定：
1. `cfg.agents.list[id].workspace`（config 中显式指定）
2. 默认 agent → `~/.openclaw/workspace`
3. 其他 agent → `~/.openclaw/workspace-<agentId>`

## 6. 其他 agent/agents RPC 方法

| 方法 | 权限 | 功能 |
|---|---|---|
| `agents.create` | admin | 创建 agent（name 写入顶层字段和 IDENTITY.md） |
| `agents.update` | admin | 更新 agent config（name 更新顶层字段，avatar 追加到 IDENTITY.md） |
| `agents.delete` | admin | 删除 agent 及其文件 |
| `agents.files.list` | read | 列出 workspace 文件（IDENTITY.md、SOUL.md 等） |
| `agents.files.get` | read | 读取 workspace 文件内容 |
| `agents.files.set` | admin | 写入 workspace 文件 |
| `agent` | write | 向 agent 发送消息（触发 AI run） |
| `agent.wait` | write | 等待某次 run 完成 |

## 7. CoClaw 使用建议

`agents.list` 适合批量获取 agent 列表和基本元信息，但**无法获取 IDENTITY.md 中的友好名称**。若需要展示用户在 IDENTITY.md 中配置的名称（如 `"压测锤"` 而非 `"tester"`），需对每个 agent 额外调用 `agent.identity.get`。

推荐的 CoClaw 展示 name fallback 策略（在 UI 侧）：

```
agent.identity.get 返回的 name
  → agents.list 的 identity.name
  → agents.list 的顶层 name
  → agent id
```
