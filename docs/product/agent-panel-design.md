# Agent 面板设计建议 — 数据可行性评估与方案

> 状态：建议稿（待 PM 评审）
> 日期：2026-03-14
> 背景：PM 提出在 Claw 管理页面为每个 Agent 设计"资料卡/面板"，展现与传统 IM bot 的本质区别

## 1. 核心结论

PM 原始方案中引用的 REST API（如 `GET /api/agent/profile`、`GET /api/memory/stats`、`GET /api/artifacts`）在 OpenClaw 中**均不存在**。OpenClaw 的所有交互通过 **WebSocket RPC** 进行，不提供 REST HTTP 接口。

经逐项核实 OpenClaw 源码，以下是数据可获取性的完整评估，以及基于实际可用数据的面板设计方案。

## 2. PM 原始方案的数据可行性评估

| PM 设想的展示内容 | PM 声称的接口 | 实际情况 | 结论 |
|---|---|---|---|
| 实例名称 | `GET /api/instance/info` | 不存在。可用 WS RPC `gateway.identity.get` + `status` | 可替代实现 |
| Agent 名称 / 头像 | `GET /api/agent/profile` | 不存在。可用 WS RPC `agent.identity.get` → name, avatar, emoji | 可替代实现 |
| Agent 角色 / 职位描述 | `GET /api/agent/profile` → Role, Description | **IDENTITY.md 无 role / description 字段**，仅有 name, emoji, creature, vibe, theme, avatar | 不可行 |
| 在线状态 (idle/thinking/delegating) | `agent.presence` 事件 | 不存在。可通过 `agent` 事件的 lifecycle stream（start/end）推断忙碌/空闲 | 需自行推断，精度有限 |
| 下属能力 (调研/写稿/配图) | `GET /api/agent/skills` → `delegate_task` | 不存在。可用 `tools.catalog` 获取工具列表，无 `delegate_task` 工具，委派用 `sessions_spawn` | 可替代实现，但展示形式需调整 |
| 记忆统计 (18条习惯) | `GET /api/memory/stats` | **完全不存在**，无任何替代方案获取记忆计数 | 不可行 |
| 最新产出物 | `GET /api/artifacts` | **完全不存在**，OpenClaw 无产出物管理系统 | 不可行 |
| Subagent 类型列表 | 无明确接口 | OpenClaw 的 subagent 是运行时动态创建的，**无类型注册表**，无法列举 | 不可行 |

## 3. 关于 Subagent 的关键说明

PM 在沟通中希望展示"subagent 类型"，需要明确以下事实：

1. **Subagent 没有预定义"类型"**：OpenClaw 的 subagent 由 AI 在会话中通过 `sessions_spawn` 工具动态创建，传入任务描述即可启动，不存在"调研型 / 写稿型 / 配图型"这样的预设分类
2. **Subagent 与顶层 Agent 绑定**：session key 格式为 `agent:<agentId>:subagent:<id>`，subagent 归属于其发起者
3. **不可管理**：没有定义、查看、编辑 subagent 类型的接口。Subagent 的行为完全由创建时的任务描述决定
4. **可观测但不可枚举**：CoClaw 插件可以 hook subagent 的生命周期事件（spawning/spawned/ended），但这只是运行时观测，无法提前列出"有哪些类型"

**建议**：在面板中不展示 subagent 类型，改为展示 Agent 是否具备"委派子任务"的能力（即工具列表中是否包含 `sessions_spawn`）。

## 4. 推荐面板方案

基于实际可获取的数据，设计以下 Agent 面板。每一项数据都标注了来源 RPC 和字段路径。

### 4.1 面板布局

```
┌──────────────────────────────────────────────────┐
│                                                  │
│  [头像]  墨客                        🟢 空闲     │ ← 身份区
│          #博学的猫头鹰  #沉稳专业                 │ ← 个性标签
│                                                  │
│  ── 能力 ──────────────────────────────────────  │
│  📁 文件   ⚡ 执行   🌐 搜索   🧠 记忆           │ ← 工具能力
│  💬 消息   👥 可委派子任务   ⏰ 自动化            │
│                                                  │
│  ── 工作概况 ──────────────────────────────────  │
│  会话 12 个 · 最近活跃 3 分钟前                   │ ← 会话统计
│  累计消耗 128K tokens                            │
│  定时任务 2 个运行中                              │ ← 定时任务
│                                                  │
│  ── 最近对话 ──────────────────────────────────  │
│  "帮我分析一下这份报告的..."          2 分钟前     │ ← 对话预览
│  "调研 React 状态管理方案"           1 小时前     │
│                                                  │
│  [ 💬 发起对话 ]          [ ⚙️ 详细设置 ]        │
└──────────────────────────────────────────────────┘
```

### 4.2 各区块数据来源

#### 身份区

| 展示项 | RPC 方法 | 返回字段 | 说明 |
|---|---|---|---|
| 名称 | `agent.identity.get({ agentId })` | `name` | 合并 config + IDENTITY.md 后的最终名称 |
| 头像 | 同上 | `avatar` | 图片 URL / data URI / 名称首字母兜底 |
| Emoji | 同上 | `emoji` | 可选，用于列表中的快捷标识 |
| 实时状态 | `agent` WebSocket 事件 | `stream: "lifecycle"`, `data.phase` | `"start"` → 忙碌；`"end"` → 空闲。需客户端维护状态 |

#### 个性标签

| 展示项 | RPC 方法 | 返回字段 | 说明 |
|---|---|---|---|
| Creature | `agents.files.get({ agentId, name: "IDENTITY.md" })` | 解析 `content` | 如"博学的猫头鹰"，展示为 `#标签` 形式 |
| Vibe | 同上 | 同上 | 如"沉稳专业"，展示为 `#标签` 形式 |
| Theme | 同上 | 同上 | 如"深海蓝"，可用于卡片配色 |

> 这三个字段是 OpenClaw 的"人格设定"，是区别传统 IM bot 的独特数据。并非所有 Agent 都配置了这些字段，为空时不展示该区域。

#### 能力区

| 展示项 | RPC 方法 | 判断逻辑 |
|---|---|---|
| 工具能力图标 | `tools.catalog({ agentId })` | 按返回的 `groups[].id` 映射为图标标签 |
| "可委派子任务" 标记 | 同上 | 工具列表中存在 `sessions_spawn` 时展示 |
| 已安装技能 | `skills.status({ agentId })` | 展示 `eligible: true` 的技能名称 |

工具分组到图标的映射建议：

| group.id | 图标 | 标签 |
|---|---|---|
| `fs` | 📁 | 文件 |
| `runtime` | ⚡ | 执行 |
| `web` | 🌐 | 搜索 |
| `memory` | 🧠 | 记忆 |
| `sessions` | 💬 | 会话 |
| `messaging` | 📨 | 消息 |
| `automation` | ⏰ | 自动化 |
| `ui` | 🖥️ | 浏览器 |
| `media` | 🎨 | 媒体 |
| `plugin:*` | 🧩 | 扩展（显示插件名） |

#### 工作概况区

| 展示项 | RPC 方法 | 计算方式 |
|---|---|---|
| 会话数 | `sessions.list({ agentId })` | 返回的 `count` 字段 |
| 最近活跃时间 | 同上 | `sessions[]` 按 `updatedAt` 排序，取最大值，转为相对时间 |
| 累计 token 消耗 | 同上 | 汇总所有 session 的 `totalTokens` |
| 定时任务数 | `cron.list()` | 客户端按 `agentId` 筛选，计数 `enabled: true` 的条目 |

#### 最近对话预览区

| 展示项 | RPC 方法 | 说明 |
|---|---|---|
| 对话摘要 | 先 `sessions.list({ agentId, limit: 3 })` 取最近 session key，再 `sessions.preview({ keys })` | 每条预览含 role + text，截取首句展示 |
| 对话时间 | `sessions.list` 返回的 `updatedAt` | 转为相对时间 |

### 4.3 数据加载策略建议

面板数据涉及多个 RPC 调用，建议分层加载：

1. **首屏（即时）**：`agents.list` → 名称 + emoji + avatar（已在列表接口中返回）
2. **展开面板时**：并发请求 `agent.identity.get` + `tools.catalog` + `sessions.list`
3. **延迟加载**：`agents.files.get`（IDENTITY.md）、`sessions.preview`、`cron.list`
4. **持续监听**：`agent` WebSocket 事件 → 更新实时状态

## 5. 与传统 IM Bot 的差异化总结

面板中 4 个维度是传统 IM bot 名片完全不具备的：

| 维度 | 传统 IM Bot | CoClaw Agent 面板 | 数据支撑 |
|---|---|---|---|
| **有性格** | 只有名称和头像 | creature / vibe / theme 个性标签 | IDENTITY.md |
| **有组织力** | 单点对话 | 明确标识"可委派子任务"能力 | tools.catalog 中的 sessions_spawn |
| **有工作量** | 无 | 会话数、token 消耗、定时任务计数 | sessions.list + cron.list |
| **有状态** | 最多显示"在线" | 空闲 / 思考中 / 执行工具中 | agent 事件 lifecycle + tool stream |

## 6. 明确不可行的功能（建议从需求中移除）

| 功能 | 不可行原因 |
|---|---|
| 记忆条数统计 | OpenClaw 无记忆计数 API，最近的 `doctor.memory.status` 仅返回健康状态 |
| 产出物 / 交付物列表 | OpenClaw 无产出物管理系统 |
| Agent 角色 / 职位描述 | IDENTITY.md 不含 role / description 字段 |
| Subagent 类型列表 | Subagent 无类型注册表，是运行时动态构造 |
| 一句话简介 / 座右铭 | 无对应数据字段 |

## 7. 与现有 PRD 的关系

本文档是对 `multi-agent-support-prd.md` 第 3.3 节"管理 Claw 页面"中 Agent 卡片的细化设计。现有 PRD 中卡片仅展示 Agent 名称 + 对话按钮，本方案将其升级为信息更丰富的面板。

建议在 PM 评审通过后，将本文档的面板设计合并回 PRD 的 3.3 节。
