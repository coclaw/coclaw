# Topic 仅限 Main Agent：OpenClaw 路由约束分析

> 日期：2026-03-18
> 状态：已确认（当前限制）
> 关联：`docs/designs/topic-management.md`（设计文档）、`docs/openclaw-research/topic-feature-research.md`（源码研究）

---

## 问题

CoClaw 0.4.0 引入的 Topic（独立话题）功能，最初目标是支持所有顶层 Agent。实施过程中发现 OpenClaw gateway 的路由机制存在硬性约束，导致 Topic 方案仅对 main agent 可行。本文档完整解释该约束的成因。

---

## Topic 方案的核心前提

Topic 的设计目标是创建**脱离 OpenClaw sessionKey 体系**的独立对话。具体做法：

1. CoClaw 自行生成 UUID 作为 `topicId`
2. 调用 `agent(sessionId=topicId)` 时**不传 sessionKey**
3. OpenClaw 会用该 sessionId 创建 `.jsonl` 对话文件，但不会在 `sessions.json` 中登记
4. 对话的元信息（创建时间、标题等）由 CoClaw 侧的 `coclaw-topics.json` 自行管理

这样 Topic 完全由 CoClaw 掌控生命周期，不会污染 OpenClaw 的 session 索引。

**这个方案成立的关键前提是：调用方传入的 sessionId 被 OpenClaw 原样使用，且不写入 sessions.json。**

---

## OpenClaw `agent()` RPC 的路由机制

OpenClaw gateway 的 `agent()` 方法接受多个可选参数，其中与路由相关的有三个：

| 参数 | 作用 |
|------|------|
| `sessionId` | 指定对话的 UUID |
| `sessionKey` | 指定逻辑路由标识（如 `agent:main:main`） |
| `agentId` | 指定目标 Agent |

### 仅传 sessionId 时（Topic 方案的调用方式）

gateway handler 中 `requestedSessionKeyRaw` 为空，整个 sessionKey 解析和 `sessions.json` 写入逻辑被跳过。`resolvedSessionId` 直接使用调用方传入的 UUID。

**但此时 Agent 路由默认走 main。** 不指定 Agent，OpenClaw 只会使用 main agent 处理请求。

### 传入 agentId 时（想路由到非 main agent）

当 `agentId` 非空时，gateway 的处理流程如下（源码路径：`src/gateway/server-methods/agent.ts`）：

1. 若未显式传 `sessionKey`，调用 `resolveExplicitAgentSessionKey({ cfg, agentId })`
2. 该函数（`src/config/sessions/main-session.ts:40-49`）**必定返回** `agent:<agentId>:main`
3. 进入 `if (requestedSessionKey)` 分支，按 sessionKey 查找 session store
4. 调用方传入的 `sessionId` 被 store 中的 sessionId **无条件覆盖**
5. 向 `sessions.json` 写入/更新该 sessionKey 的条目

**也就是说：传 agentId 会自动派生 sessionKey，一旦有 sessionKey 就进入 OpenClaw 的 session 管理体系。** 调用方的 sessionId 被丢弃，Topic 方案的前提彻底失效。

### 各参数组合的完整行为

| 传参方式 | sessionId 被保留 | Agent 路由 | 写 sessions.json |
|---------|:---:|:---:|:---:|
| 只传 `sessionId` | **是** | 固定为 main | **否** |
| 传 `agentId`（不传 key） | 否（被覆盖） | 正确路由 | 是 |
| 传 `sessionKey` | 否（被覆盖） | 正确路由 | 是 |
| 传 `agentId` + `sessionId` | 否（被覆盖） | 正确路由 | 是 |
| 传 `sessionKey` + `sessionId` | 否（被覆盖） | 正确路由 | 是 |

---

## 核心矛盾

```
Topic 方案需要同时满足三个条件：

  ① 调用方的 sessionId 被保留（topicId = sessionId）
  ② 请求路由到指定 Agent
  ③ 不写入 sessions.json

对于 main agent：只传 sessionId → ①③ 满足，② 自动满足（默认 main）→ 三条件全部达成
对于非 main agent：必须传 agentId → 触发 sessionKey 派生 → ①③ 被破坏 → 方案不可行
```

**不存在任何参数组合能同时满足"指定非 main agent + 保留自定义 sessionId + 不写 sessions.json"。** 这是 OpenClaw gateway 源码层面的硬约束，非 CoClaw 侧能绕过。

---

## 影响范围

该约束不仅影响 Topic 对话的消息发送，也同样影响 Topic 标题生成——标题生成同样通过 `agent(sessionId=tempId)` 调用 LLM，受相同的路由限制。

---

## 当前实施

- 插件侧 `TopicManager` 接口保留了 `agentId` 参数，不做 main 限制
- **限制在 UI 侧执行**：
  - "新话题"按钮仅在 main agent 上下文中显示（`ChatPage.vue` `showNewTopicBtn`）
  - `topicsStore.loadAllTopics()` 仅查询 `agentId: 'main'`
- 若 OpenClaw 未来放开路由约束，UI 侧解除限制即可，插件侧无需改动

---

## 备选方案：sessionKey-per-topic

若产品上确需支持非 main agent 的 Topic，可放弃"脱离 sessionKey 体系"的设计目标，改用 sessionKey 方案：

- 每个 Topic 分配独立 sessionKey：`agent:<agentId>:coclaw-<topicId>`
- sessionId 由 OpenClaw 分配（非 CoClaw 控制），topic 元信息需额外记录 sessionId
- 对话正确路由到目标 Agent

**代价**：

| 影响 | 说明 |
|------|------|
| sessions.json 膨胀 | 每个 Topic 占一条索引，随 Topic 数量线性增长 |
| .jsonl 生命周期 | 纳入 OpenClaw 维护剪裁范围，`mode=enforce` 时可能被清理 |
| 实现复杂度 | Topic 删除需同步清理 sessions.json 条目；需处理 sessionId 非自主分配带来的时序问题 |

该方案已在设计文档中预留（`topic-management.md` 第一章"未来扩展"），尚未排期。
