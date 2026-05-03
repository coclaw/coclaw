# OpenClaw Transcript 消息分类

> 更新时间：2026-05-03
> 基于 OpenClaw 本地源码核实（`openclaw-repo/`）
> 关注点：CoClaw UI 如何正确分组渲染 transcript

---

## 一、问题背景

OpenClaw 的 JSONL transcript 不仅承载用户与模型的自然对话，还会落盘多种"非自然"消息——斜杠命令回执、心跳静默 ack、外部 inject、compaction 边界等。

CoClaw UI 当前按 `role` 三分（`user` / `assistant` / `toolResult`）粗暴分组，其它一律并入"上一段 agent run 块"，导致：

- `/compact`、`/new` 命令的回执（`Compaction skipped...`、`✅ New session started.`）被吸进上一段 agent run 卡片
- 模型对心跳 prompt 的 `HEARTBEAT_OK` 回复在 UI 中可见

要做正确分组，先弄清 transcript 里到底有几类消息、各自怎么识别。

---

## 二、JSONL 顶层结构

每行 JSONL 解析后顶层有 `type` 字段，可见取值：

| 顶层 `type` | 含义 | 是否带 `message` 子对象 |
|------------|------|---------------------|
| `session` | 文件头，记录 sessionId / version / cwd | 否 |
| `message` | 绝大多数对话条目 | 是 |
| `compaction` | 上下文压缩边界标记，含 summary / tokensBefore / tokensAfter | 否 |

CoClaw UI 在前端拿到的消息**外层 `type`/`id` 实际上不可信**：
- chat 模式（`sessions.get` RPC）走 OpenClaw 服务端 `readSessionMessages`，**只保留 `parsed.message` 子对象**返回（`gateway/session-utils.fs.ts:130-201`）
- topic 模式（`coclaw.sessions.getById`）插件文档明确"仅返回 `type==='message'` 的行"
- CoClaw 前端 `wrapOcMessages`（`ui/src/utils/message-normalize.js:11-18`）一律硬补 `{ type: 'message', id, message }` 外壳

**关键例外**：服务端 `readSessionMessages` 看到顶层 `type:'compaction'` 时**不直接丢弃**，而是合成一条假的 message 行返回：

```js
{
  role: 'system',
  content: [{ type: 'text', text: 'Compaction' }],
  timestamp,
  __openclaw: { kind: 'compaction', id, seq }
}
```

源码：`openclaw-repo/src/gateway/session-utils.fs.ts:142-156, 180-196`

所以 UI 实际能拿到的有效信号是：
- 所有 `type=message` 的原始 message 子对象
- compaction 边界被合成成 `role:'system' + __openclaw.kind:'compaction'` 的合成消息

---

## 三、`type==='message'` 内的 `role` 分类

| `role` | 来源 | 是否可见 |
|--------|------|--------|
| `user` | 真实用户输入；cron 触发；inter-session relay | 可见 |
| `assistant` | 模型真实回复；OpenClaw 系统注入；delivery-mirror 镜像 | 可见 |
| `toolResult` | 模型调工具的执行回执 | 可见 |
| `compactionSummary` | 与 `type=compaction` 配对的内容载荷 | 服务端过滤 |
| `custom` | 内部 steering（sessions yield interrupt 等），带 `display:false` | 服务端过滤 |
| `system` | **仅** compaction 边界合成（见上节） | 可见 |

UI 实际遇到的 `role` 仅 `user` / `assistant` / `toolResult` / `system`。

---

## 四、`role==='assistant'` 的进一步分类

这一项最关键——CoClaw 当前把所有 assistant 都并入 botTask，但 OpenClaw 实际有两类。

### A. 真模型回复

- `provider`：`anthropic` / `openai` / 其它真实供应商
- `model`：真实模型名（`claude-...` / `gpt-...`）
- `usage`：非全 0 的真实 token 计数
- `stopReason`：`toolUse` / `endTurn` / `stop`

应当聚合到 botTask 的就是这一类。

### B. 系统注入

- `provider === 'openclaw'`
- `model`：`gateway-injected` 或 `delivery-mirror`
- `usage` 全 0
- 上游 replay 路径会**整条跳过不喂模型**（`agents/pi-embedded-runner/replay-history.ts:229-237`，`agents/pi-embedded-subscribe.handlers.messages.ts:45-52`）

**唯一稳定判据**：`role==='assistant' && provider==='openclaw'`。`model` 字段值有两种但都属于"transcript-only 注入"，无需逐一判断。

#### B 类的具体子来源

| 子来源 | 触发 | 典型文本 | 落盘函数 |
|--------|------|---------|---------|
| chat.inject RPC | 外部把消息塞进 transcript | 任意 | `gateway/server-methods/chat-transcript-inject.ts:44-116` |
| abort partial | run 被中断时保存半成品 | 模型半成品文本，带 `openclawAbort` 元数据 | `gateway/server-methods/chat.ts:1381-1411` |
| chat.send final 镜像 | webchat 路径把最终回复以 inject 身份重写 | 同模型回复 | `gateway/server-methods/chat.ts:2260-2269` |
| delivery-mirror | 服务端把发给用户的消息镜像写进 transcript | `✅ Session reset.` / `✅ New session started.` / `⚙️ Compacted (1.2k → 800)` / `⚙️ Compaction skipped: ...` | `config/sessions/transcript.ts:157-209`，斜杠命令文本生成 `auto-reply/reply/commands-reset.ts`、`commands-compact.ts` |
| TTS / 媒体回复 | OpenClaw 主动注入语音/媒体 | 含 audio block | 同 chat.inject |

---

## 五、`HEARTBEAT_OK` 与 `NO_REPLY`

两个特殊静默 token。来源：`openclaw-repo/src/auto-reply/tokens.ts:3-4`。

- 落盘形态：**普通 `role:'assistant'` 消息**，content 整段就是 `HEARTBEAT_OK` 或 `NO_REPLY`
- `provider` / `model` 是真实模型——这是模型对系统注入的 prompt（heartbeat tick / 静默 prompt）的真实回复
- **不**通过 `role:'custom'` 落盘
- 服务端 `readSessionMessages` **不**过滤这两类——前端能拿到原文

识别只能扫文本：trim 后整段精确等于 `HEARTBEAT_OK` 或 `NO_REPLY`。

---

## 六、单次 run 是否会产生多个 final assistant

**不会**。在 JSONL 层面，一次 user 触发的 run 只写一条 final 性质的 assistant 消息。

- model fallback 仅在内存 `fallbackAttempts` / `runResult` 里发生，最终只写一条结果（`auto-reply/reply/agent-runner-execution.ts:101-120`、`1618-1637`）
- compaction-retry 明确"不增加 user/assistant turns"（`agents/pi-embedded-runner/run/attempt.ts:2783-2864`）
- gateway 事件流虽然会多次 emit `lifecycle:end`（compaction-retry / model-fallback 场景），但事件流不落 JSONL

所以"final 之后又跟一串 tool 调用"的视觉怪象，不是 fallback / retry 写入了多条 assistant，而是 OpenClaw 内部触发了模型续跑——transcript 里一定有个 B 类系统消息（如 chat.inject 或心跳 prompt 之类）作为分界点，CoClaw 当前没识别出来，所以连续看起来像"final 后又跑工具"。

---

## 七、cron / inter-session 等用户消息标识

| 子类 | 识别 | 落盘函数 |
|------|------|---------|
| cron 触发 | 内容前缀 `[cron:<UUID> <name>] ...\nCurrent time: ...` | `cron/isolated-agent/run.ts:644-645` |
| inter-session relay | `message.provenance.kind === 'inter_session'` | `sessions/input-provenance.ts:4-18` |
| heartbeat tick | 内容是 heartbeat prompt（`Read HEARTBEAT.md...`） | `auto-reply/heartbeat.ts:15` |
| 入站 metadata 头部 | `<Label> (untrusted...):\n\`\`\`json\n...\n\`\`\`\n\n` 等多种装饰 | `auto-reply/reply/inbound-meta.ts` |

CoClaw 已通过 `cleanDerivedTitle` / `stripOcPrefixes` 处理大部分文本前缀，但仍有遗漏（见第八节）。

---

## 八、已知缺口与上游 bug

- **inbound-meta strip 不同步**：`auto-reply/reply/inbound-meta.ts:296-314` 注入的 `Location` / `UntrustedStructuredContext` 两个 label，对应的 strip sentinel 列表（`strip-inbound-meta.ts:17-28`）未同步。两文件互注释"需同步"但实际未同步——属上游 bug，应另开 issue
- **runtime-context custom**（`customType:'openclaw.runtime-context'`）和 **prompt-error custom**（`customType:'openclaw:prompt-error'`）：服务端 RPC 当前会过滤掉，CoClaw 前端无需处理；若上游未来开放，需补判别

---

## 九、CoClaw UI 应当的分类（结论）

| UI 视觉块 | 来自哪些条目 | 识别 |
|----------|------------|------|
| user 气泡 | `role==='user'`（含 cron 子样式） | role + 文本前缀 |
| agent run 块 | A 类 assistant + toolResult | `role==='assistant' && provider!=='openclaw'`，或 `role==='toolResult'` |
| 系统块（轻样式） | B 类系统注入 + HEARTBEAT_OK + NO_REPLY | `role==='assistant' && provider==='openclaw'`，或 content 整段 == 静默 token |
| compaction 分隔条（待定） | 服务端合成的 `role:'system' + __openclaw.kind:'compaction'` | 顶层 role 检查 |
| 隐藏 | 服务端已过滤的 `custom`、`compactionSummary`、`session` 头 | 现状自然丢弃 |

实际落地方案见 `ui/docs/system-message-grouping.md`。
