# 多 Agent 架构

> 最后更新：2026-04-02
> 状态：Phase 1-3 已实施，Phase 4（创建 Agent）待实施

## 1. 背景

OpenClaw 支持在 `agents.list` 中配置多个顶层 agent（与 main 同级），每个 agent 拥有独立的 workspace、session 存储和身份信息。CoClaw 从 Phase 1-3 开始支持这些顶层 agent。

**术语约定**：本文中 "agent" 统一指 OpenClaw 的顶层 agent（top-level agent），不含子 agent。

## 2. 术语映射

| UI 文案 | 含义 | 代码层 |
|---------|------|--------|
| Claw | 一个 OpenClaw 实例 | `bot`（代码中不重命名） |
| Agent | 一个 Claw 下的顶层 agent | `agent` / `agentId` |

## 3. Gateway 原生 RPC

以下能力通过现有 RPC 透传链路（UI → Server → Plugin → Gateway）直接调用，无需插件额外注册：

| RPC 方法 | 作用 |
|---|---|
| `agents.list` | 返回所有顶层 agent 列表（含 id, name, identity）及 defaultId |
| `agent.identity.get` | 获取单个 agent 的身份信息（name/avatar/emoji），读取 IDENTITY.md |
| `agent` | 发消息，已支持 `agentId` 参数 |
| `sessions.resolve` | 检查 sessionKey 是否存在（不创建） |
| `sessions.reset` | 创建/重置 session |
| `agents.create` | 创建新 agent（Phase 4 使用） |

## 4. Agent 身份解析链

### Name（label 显示）

所有候选名称先经 `pick()` 过滤：值为 gateway 默认 `"Assistant"` 或等于 `agentId` 的占位名视为无信息量，跳过。过滤后按权威性 fallback：

```
agent.identity.get 的 name（resolvedIdentity.name）    ← 最权威，读取 IDENTITY.md
  → agents.list 的 identity.name                       ← config identity 子对象
  → agents.list 的顶层 name                            ← openclaw.json 中的 name
  → botName（仅默认 agent，来自 server 的 refreshBotName）
  → agent id（如 "main"、"tester"）                    ← 最终兜底
```

### Avatar（图片/图标显示）

```
agents.list 的 identity.avatarUrl                      ← 仅当为 data: 或 http(s): URL 时使用
  → resolvedIdentity.emoji 或 identity.emoji           ← 文本渲染
  → bot name 首字母 / 默认 SVG 图标
```

> `agent.identity.get` 返回的 `avatar` 字段可能是 workspace 相对路径，不能直接用于 `<img src>`。`agents.list` 的 `identity.avatarUrl` 已由 gateway 转为 data URI。UI 侧对 `avatarUrl` 做 `isRenderableUrl()` 校验（匹配 `data:` 或 `https?://`）。

## 5. 数据流

### 初始化时序

```
Plugin 连接 Gateway 成功
  → agents.list 获取所有 agent
  → 对每个 agent 调 ensureAgentSession()        ← 保证 main session 存在

UI mounted
  → botsStore.loadBots()
  → agentsStore.loadAgents(botId)              ← 调 agents.list + 逐个 agent.identity.get
  → sessionsStore.loadAllSessions()
    → 对每个 agent 调 nativeui.sessions.listAll({ agentId })
      → handler 内 ensure 兜底
  → MainList 渲染 agent 条目
```

### 运行期间新增 agent

```
用户在 OpenClaw 侧新增 agent
  → UI 刷新 agentsStore.loadAgents()            ← 发现新 agent
  → sessionsStore.loadAllSessions()
    → nativeui.sessions.listAll({ agentId: newAgentId })
      → handler 内 ensure 触发 sessions.reset   ← 自动创建 session
  → MainList 渲染新 agent 条目
```

## 6. 架构要点

- **Server 层无需改动**：Agent 数据来自 OpenClaw 实时 RPC，不在 Server 侧持久化。Bot 表仍代表 OpenClaw 实例，`name` 字段由 `refreshBotName()` 从默认 agent 的 `agent.identity.get` 获取
- **RPC 透传无差别**：Server 和 Plugin 均不做 method 级路由，所有 `req` 类型消息原样转发
- **Session ensure 内聚**：`nativeui.sessions.listAll` handler 在返回前自动 ensure 目标 agent 的 main session，UI 无需感知
- **向后兼容**：旧插件可透传 `agents.list`；不传 agentId 时 fallback 到 `'main'`

## 7. 待实施

- Phase 4：创建 Agent 功能（`agents.create` RPC + UI 对话框）
- 编辑已有 Agent 信息（`agents.update` RPC）
- `nativeui.sessions.listAll` 支持 `agentIds: string[]` 批量获取
- 插件侧合并 `agent.identity.get` 到 `agents.list` 响应，减少 RPC 往返
