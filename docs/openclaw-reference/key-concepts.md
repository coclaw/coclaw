## 0. 先记住一句总纲

OpenClaw 本质上是在做三件事：

1. **收消息**（来自 WhatsApp/飞书/Telegram/WebChat 等）
2. **决定这条消息属于哪个“脑子+会话桶”**（agent + session key）
3. **用该会话历史去回答，并把回复发回原渠道**

---

## 1. 最核心的 3 层模型（先看这个）

把 OpenClaw 想成：

- **渠道层（IM Channel）**：消息从哪来、回哪去（WhatsApp、飞书…）
- **大脑层（Agent）**：谁在思考（main、work、family…）
- **记忆层（Session）**：这次对话到底写进哪本“聊天笔记本”

### 类比

- Channel = 电话线路
- Agent = 接线员/人格
- Session = 该接线员手里的某本对话记录本

---

## 2. Agent 是什么（main 又是什么）

### Agent
一个 agent 是一个**独立 AI 个体**，有自己的：

- workspace（SOUL/USER/技能等）
- sessions 存储
- 认证状态（各类账号授权）

### main agent
- `main` 只是默认 agentId。
- 它不是“更高级”的 agent，只是默认那个。

> 你可以只有一个 main，也可以有多个 agent（如 main/work/family），互相隔离。

---

## 3. Session 到底是什么（最容易混）

先分清两个词：

## A) `session key`（逻辑会话标识）
这是“会话桶”的名字。
它决定：**历史归属、并发隔离、路由归属**。

例如：
- `agent:main:main`
- `agent:main:whatsapp:group:1203...`
- `agent:work:telegram:direct:alice`

## B) `session id`（物理会话实例）
这是当前 transcript 文件的实例 ID（通常 UUID）。

### 关系
- `session key` 像“文件夹路径”
- `session id` 像这个文件夹里当前的“活跃文件名”

当你 `/new` 或 `/reset`：
- 通常 **key 不变**
- 但会生成新的 **session id**

---

## 4. OpenClaw 如何决定“这条消息进哪个 session”

流程简化版：

1. 先选 agent（通过 bindings：按 channel/account/peer 等）
2. 再按消息类型算 session key：
- 直聊（DM）
- 群聊/频道
- 线程/topic（在基础 key 上再加 thread/topic 后缀）

其中最关键参数是：`session.dmScope`

---

## 5. `dmScope`：直聊是否混在一起的总开关

它决定“不同人/不同渠道的 DM 是否共享同一会话”。

常见值：

- `main`（默认）
- 所有 DM 都进 `agent:<id>:main`
- 优点：上下文连续
- 风险：多人来聊时可能串上下文
- `per-peer`
- 每个发送者独立
- `per-channel-peer`
- 渠道+发送者独立（更安全）
- `per-account-channel-peer`
- 多账号场景下更细隔离

> 你现在关心的“跨 WhatsApp/飞书是否独立”，本质就是 dmScope 问题。

---

## 6. 群聊与直聊的关键区别

- **直聊**：可按 dmScope 合并或拆分
- **群聊/频道**：天然按群/频道 id 分桶，通常不和直聊混

所以你会看到 key 形态差异：
- DM 可能是 `agent:main:main`
- Group 会是 `agent:main:whatsapp:group:<id>`

---

## 7. 用户在 IM 里“看到的对话” vs OpenClaw“内部会话”

这是最容易误解的点：

### IM 客户端看到的是
该平台自己的消息列表（WhatsApp 的列表、飞书的列表）。

### OpenClaw 内部维护的是
网关上的统一 session store + transcript。

所以会出现：
- 在逻辑上同一 session（模型能延续上下文）
- 但在另一个 IM 客户端里，看不到前一个 IM 的历史气泡

**结论：**
- “模型记得” ≠ “各 IM 都展示同一历史列表”

---

## 8. 多渠道同一用户，会发生什么

看场景：

### 场景 1：默认 `dmScope=main`
- 用户先 WhatsApp 聊，再飞书聊
- 很可能都进 `agent:main:main`
- 模型上下文连续
- 但飞书不会自动显示 WhatsApp 的历史消息气泡

### 场景 2：`dmScope=per-channel-peer`
- WhatsApp 和飞书分成不同 session
- 互不影响，更像“两个独立聊天窗口”

---

## 9. 会话生命周期（/new /reset 在干嘛）

`/new` 或 `/reset` 触发时，通常会：

- 为该 session key 生成新的 session id
- 后续上下文从新实例开始
- 旧 transcript 归档（不等于彻底不存在）

所以它是“开始新一段”，不是“系统重装”。

---

## 10. 一张“速记表”（你以后查这个就行）

- **Channel**：消息通道（WhatsApp/飞书…）
- **Agent**：AI 个体（main/work…）
- **Session Key**：逻辑会话桶（决定上下文归属）
- **Session ID**：当前会话实例文件 ID
- **dmScope**：DM 是否合并/隔离
- **main session**：某 agent 的默认直聊桶（如 `agent:main:main`）
- **用户可见聊天记录**：由 IM 平台决定
- **模型可用上下文**：由 OpenClaw 的 session key 决定

## 11. 补充

**不考虑子 agent** 的情况下，大致如下。

### `dmScope` 的语义到底是什么？

一句话：**它只决定“直聊（DM）怎么分桶成 session key”。**

也就是：不同来源的私聊消息，是进同一个 session key，还是拆成多个。

**常见模式（只看 DM）**

- `main`（默认思路）：
所有 DM 都进 `agent:<agentId>:main`
→ 最连续，但多人场景容易串上下文

- `per-peer`：
按“人”拆分
→ 每个人一个 session key

- `per-channel-peer`：
按“渠道+人”拆分
→ 同一个人在 WhatsApp 和飞书会是两个 key

- `per-account-channel-peer`：
再加账号维度（多账号场景）

---

### session key 一旦创建就永远不会被重置吗？

**不会。要分“重置内容”与“换 key”两件事。**

- `/new` 或 `/reset` 通常是：
**同一个 session key，换新的 session id**（新一段会话实例）
- 所以：
- key 往往不变（逻辑桶还在）
- 会话内容实例会切换（session id 变）
- 如果手工删 session（或路由策略改变），才可能不再用旧 key，转到新 key。

---

### 什么情况下会有多个 session key？

在“无子 agent”前提下，主要 4 类：

1. **有群聊/频道**
群聊本来就是独立 key（不会和 DM 共用）

2. **DM 被拆分（dmScope 不是 main）**
比如按人、按渠道+人拆，就天然多个 key

3. **你用了多个 agent（main/work）**
每个 agent 自己一套 key 空间（`agent:main:*` vs `agent:work:*`）

4. **线程/topic 场景**
在线程制平台里，可能在基础 key 上再细分

---

你可以先记一个最简判断法：

- **只有 1 个 agent + 只 DM + dmScope=main** → 基本一个主 key
- 只要出现“群聊 / dmScope 拆分 / 多 agent / 线程”任一项 → 会出现多个 key