# 系统消息独立成块（系统块剥离）

> 创建时间：2026-05-03
> 状态：草案（待实施）
> 研究基础：`docs/openclaw-research/transcript-message-taxonomy.md`
> 影响范围：`ui` 工作区——`src/utils/session-msg-group.js` + `src/views/ChatPage.vue`

---

## 一、背景

OpenClaw transcript 里除了"用户原话 / 模型回复 / 工具回执"之外，还会落盘多种"非自然对话"消息：

- 斜杠命令回执（`✅ New session started.`、`⚙️ Compaction skipped...`、`⚙️ Compacted N→M tokens`）
- 外部 RPC 注入（`chat.inject`）
- run 中断时保存的半成品（abort partial）
- 模型对 heartbeat / 静默 prompt 的 ack 回复（整段 `HEARTBEAT_OK` 或 `NO_REPLY`）

CoClaw UI 当前的分组（`session-msg-group.js`）只按 `role` 三分（user / assistant / toolResult），其它一律并入"上一段 agent run 块"。结果是这些注入消息被错误地吸进 botTask 卡片，视觉上贴在模型回复后面，造成"final 之后又跑工具"等错乱。

---

## 二、目标

把上述"非自然对话"消息从 botTask 中剥离出来，独立成轻样式的"系统块"，且不破坏 botTask 的整体性。

详细分类与上游源码核实见 `docs/openclaw-research/transcript-message-taxonomy.md`。

---

## 三、识别规则

进入分组循环时，对每条 `role==='assistant'` 的 entry 按以下顺序判断：

1. `message.provider === 'openclaw'` → **系统注入块**。保留 `model` 字段（值如 `gateway-injected` / `delivery-mirror`）供渲染显示
2. content 提取的纯文本 trim 后整段 == `HEARTBEAT_OK` → **心跳 ack 块**
3. content 提取的纯文本 trim 后整段 == `NO_REPLY` → **静默 ack 块**

任一命中即视为"系统块"。否则按现有逻辑进入正常 botTask。

判断 1 不依赖 `model` 值——只要 `provider==='openclaw'` 就成立。这样 OpenClaw 未来新增 transcript-only 注入 model 名也无需 UI 改动。

判断 2/3 必须用整段精确匹配，避免误伤用户在长文本里偶然提到 token 字面量。

---

## 四、分组规则

每段 user 边界（含 cron / heartbeat 触发的伪 user）内：

- 维护一个 `pendingSystemNotes[]` 队列 + 一个 `currentBotTask`
- 遇到系统块（识别规则任一命中） → push 到 `pendingSystemNotes`，**不** 进 botTask
- 遇到正常 assistant / toolResult → 进 `currentBotTask`（不论它在系统块之前还是之后，**始终合并到同一个 botTask**）
- 遇到下一条 user 或流到末尾 → flush 输出顺序：`...pendingSystemNotes, currentBotTask`

**关键约束：不拆分 botTask**。中间出现的系统块只剥出来，botTask 内的 assistant + toolResult 步骤仍合并为单一卡片，与现有视觉一致。

---

## 五、位置策略：方案 A（统一前置）

每段内的所有系统块都放在该段 botTask **前面**，多个系统块按 entry 序保留相对顺序。

### 选这个方案的原因

- run 还在执行时，botTask 卡片正在生长——若把系统块放在它后面，用户会困惑（"前面 agent 还在跑、后面怎么先冒出系统消息了"）
- 用 entry 在数组中的顺序判定，**不**依赖 timestamp——避免运行期到持久化后位置跳变
- 实际场景里"botTask 完整结束之后又冒出系统块"几乎不存在；如果将来发现反例再加分支判断不迟

### 评估过的备选

- **方案 B（前/后二分，按系统块后是否还有非系统步骤判定）**：实现稍复杂，且收益的场景几乎不存在
- **方案 C（一律后置）**：与"agent 还在跑、系统块前置"的语义偏好相反

---

## 六、渲染（ChatPage.vue）

新增 `systemNote` 块类型，字段：

```
{
  type: 'systemNote',
  id,
  text,           // 提取的纯文本
  model,          // 仅 'inject' 子类有，渲染为右下角小标签
  timestamp,
  source,         // 'inject' | 'heartbeat' | 'noReply'
}
```

视觉：

- 小字 + 浅灰底（与 user 气泡和 botTask 卡片明显区分）
- `source === 'inject'` 显示 `model` 标签（保持与现有截图一致的呈现）
- `source === 'heartbeat'` / `source === 'noReply'` 直接展示原文，不带模型标签
- 不参与 botTask 的折叠/展开

---

## 七、不在本次范围

- **真正的 `type==='compaction'` 边界**：服务端已合成成 `role:'system' + __openclaw.kind:'compaction'` 消息（content 仅字面值 `Compaction`，无 token 数细节），CoClaw 当前自然丢弃。本次保持现状，未来若做"上下文已压缩"分隔条再处理
- **`role==='custom'` 内部 steering**：服务端 RPC 已过滤，前端拿不到，无需处理
- **inbound-meta strip 缺漏（`Location` / `UntrustedStructuredContext`）**：上游 bug，另开 issue 追上游
- **botTask 末尾系统块的精细位置**：实际场景罕见，发现反例再处理
- **HEARTBEAT_OK / NO_REPLY 是否应该完全隐藏**：本轮保留显示（独立成块），用户可自行观察是否要进一步过滤

---

## 八、落地步骤

### 1. `ui/src/utils/session-msg-group.js`

- 新增 `isSystemAssistantEntry(entry)` 判别函数
- 主循环改造：
  - assistant 分支前先判系统块，命中则 push 到 `pendingSystemNotes`
  - flush 时（user 边界 / 流末尾）按 `...pendingSystemNotes, botTask` 输出
- 新增 `systemNote` item 类型生成

### 2. `ui/src/views/ChatPage.vue`

- 在 `chatMessages` 渲染分支中加 `item.type === 'systemNote'` 模板
- 引入轻样式（小字 + 浅灰底）

### 3. 测试（`session-msg-group.test.js`）

覆盖以下场景：

- D 类紧跟 user：独立成块，botTask 不创建
- D 类夹在 botTask 中间：botTask 仍合并、系统块前置
- HEARTBEAT_OK / NO_REPLY 整段精确匹配 → 系统块
- 文本里包含 `NO_REPLY` 但非整段 → 仍走 botTask（防止误伤）
- 多个系统块在同一段 → 保持相对 entry 序、统一前置
- 原有 user / assistant / toolResult 行为回归

### 4. Changeset

minor。描述聚焦"OpenClaw 系统注入消息独立成块、不再吸入 agent run"。

---

## 九、风险与回退

- 风险：极少数 D 类消息（如 `chat.inject` 内容是模型续跑指令）剥离后视觉上"模型续跑"看起来更突兀。可观察后调整渲染提示
- 回退：分组器改造完全在前端、独立函数，回退只需还原 `session-msg-group.js` + ChatPage 模板分支
