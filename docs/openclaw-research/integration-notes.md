# CoClaw 集成要点与已知限制

> 更新时间：2026-03-09
> 汇总 CoClaw 集成 OpenClaw 过程中遇到的具体问题与解决方案

---

## 一、主会话 Key Bootstrap

### 问题

OpenClaw 启动时**不保证**在 `sessions.json` 中预创建 `agent:main:main` entry。该 entry 在首条消息到达时按需创建。CoClaw 用户首次发消息可能因"无会话映射"而失败。

### 方案

在插件连接 Gateway WebSocket 后，执行一次 ensure 流程：

1. **探测**：`sessions.resolve({ key: "agent:main:main" })`
2. **创建**（仅当网关真实响应"不存在"时）：`sessions.reset({ key: "agent:main:main", reason: "new" })`

设计原则：仅用公开网关 API、幂等、单进程生命周期内执行一次。超时/网关未就绪等瞬态错误**不触发** reset，避免每次重连都重置会话。

```js
// 简化示意（实际实现见 realtime-bridge.js __ensureMainSessionKey）
async function ensureMainSessionKey() {
  const key = 'agent:main:main';
  const resolved = await gatewayRpc('sessions.resolve', { key });
  if (resolved?.ok === true) {
    return { ok: true, state: 'ready' };
  }
  // 仅当网关真实响应 "不存在" 时才创建；超时等瞬态错误不触发 reset
  if (!resolved?.response) {
    return { ok: false, error: resolved?.error ?? 'resolve_transient_failure' };
  }
  const reset = await gatewayRpc('sessions.reset', { key, reason: 'new' });
  if (reset?.ok !== true) {
    return { ok: false, error: reset?.error ?? 'sessions_reset_failed' };
  }
  return { ok: true, state: 'created' };
}
```

落地位置：`plugins/openclaw` 的 `RealtimeBridge.__ensureMainSessionKey()`，在 gateway WS connect 成功回调中执行。含并发调用防御和 `mainSessionEnsured` 标志位，确保生命周期内仅执行一次。详见 `docs/ensure-main-session-bug-analysis.md`。

---

## 二、Orphan Session 续聊

### 问题

用户希望继续一个历史/归档会话（transcript 文件存在但 sessionKey 已从 sessions.json 中移除）。

### 结论

- `chat.send(sessionKey=<orphanSessionId>)` **不能**可靠续写 orphan transcript
- `agent(sessionId=<orphanSessionId>)` **可以**续写

### 方案

CoClaw server 根据会话类型路由：

- 常规会话（有 sessionKey）→ `agent(sessionKey=...)`
- orphan 会话（仅 sessionId）→ `agent(sessionId=...)`

关键参数：`deliver: false`（避免消息向外部渠道投递）、`idempotencyKey`（重试去重）。

**事件映射**：

| agent 事件 | UI 行为 |
|-----------|---------|
| `lifecycle.start` | 标记运行开始 |
| `assistant` (data.text) | 更新流式文本（完整替换模式） |
| `tool` (start/result) | 展示工具执行轨迹 |
| `lifecycle.end` | 固化最终内容 |
| `lifecycle.error` | 展示错误，允许重试 |

只处理当前 `runId` 的事件，忽略其他 run。

---

## 三、Session 滚动检测

### 问题

使用 `agent(sessionKey)` 发送对话时，OpenClaw 可能自动 reset（如日重置），导致底层 sessionId 变更。但 `agent()` 的 ACK 和事件流都不返回 sessionId。

### 方案

通过 `chat.history` 发送前后对比检测：

1. **发送前**：`chat.history(sessionKey, limit=1)` → 记录 `beforeSessionId`
2. **发送**：`agent(sessionKey, ...)`
3. **等待完成**：监听 `lifecycle.end|error` 或调用 `agent.wait`
4. **发送后**：`chat.history(sessionKey, limit=1)` → 记录 `afterSessionId`
5. **判断**：`beforeSessionId !== afterSessionId` 说明 session 已滚动

检测到变更时可在 UI 展示轻提示："OpenClaw 已自动开启新会话"。

如果产品不关心底层 session 是否滚动，可跳过此检测。

---

## 四、附件类型限制

### 问题

CoClaw UI 支持图片、语音、文件上传，但语音和文件在发送后被 bot 忽略。

### 根因

Gateway RPC 路径（`agent` / `chat.send`）的附件解析函数 `parseMessageWithAttachments()` 只处理 image 类型，非图片一律静默丢弃（带 warn 日志）。

音频处理能力存在于 channel 消息管道（media-understanding 模块），但尚未接入 RPC 路径。

### 可行方向

1. **浏览器端 STT**：发送前用 Web Speech API 将语音转文字
2. **推动 OpenClaw 核心支持**：在 RPC 路径接入 media-understanding 管道
3. **CoClaw Plugin 层转写**：在插件中拦截音频附件，调用外部 STT 服务

相关源码：`src/gateway/chat-attachments.ts:123-130`

---

## 五、非 Vision 模型图片静默丢弃

### 问题

用户发送图片+文本，文本正常处理但图片"没发出去"，无任何错误提示。

### 根因

OpenClaw 的 Agent 执行层（`pi-embedded-runner/run/images.ts:271-309`）会检查 `modelSupportsImages(model)`（即 `model.input` 是否包含 `"image"`）。若模型仅支持 `input: ["text"]`，`detectAndLoadPromptImages()` 返回空数组，**图片被静默丢弃**。

Gateway 在 `chat.send` / `agent` 阶段不做 vision 能力检查，只在 agent 执行时才检查。

### 排查

1. 确认模型 `input` 数组是否包含 `"image"`
2. 图片大小是否超过 5MB（`maxBytes: 5_000_000`）
3. 图片格式是否可被 `sniffMimeFromBase64()` 识别
4. Gateway 日志搜索 "dropping" 或 "attachment"

### 可行方向

1. **短期**：UI 帮助中提示用户确认模型是否支持 vision
2. **中期**：发送前通过 RPC 查询模型能力，不支持时在 UI 提示
3. **长期**：向 OpenClaw 社区反馈，建议在 `chat.send` 阶段即返回错误
