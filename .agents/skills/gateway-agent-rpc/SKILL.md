---
name: gateway-agent-rpc
description: OpenClaw Gateway agent RPC 两阶段响应协议。当开发/修改涉及 claw-connection.js、agent 请求、RPC 响应处理、ChatPage 发送消息相关的前端代码时使用。
---

# OpenClaw Gateway agent RPC 两阶段响应协议

## 核心机制

Gateway 对 `agent` 方法使用**两阶段响应**：同一个 request id 会收到两次 `type: "res"` 消息。

```
UI ──req──> gateway
UI <──res── {status: "accepted", runId}     ← Phase 1: Ack（中间态）
UI <──event─ {stream: "assistant", ...}     ← 期间: streaming 事件
UI <──res── {status: "ok"/"error", ...}     ← Phase 2: Final（终态）
```

## Status 判定规则

**终态（明确）：**
- `status === "ok"` -> resolve（agent 成功完成）
- `status === "error"` -> reject（agent 执行失败）

**已知中间态：**
- `status === "accepted"` -> 跳过，继续等待终态

**未知状态（既非终态也非已知中间态）：**
- 调用 `onUnknownStatus` 回调（如有提供）
- 暴露问题，便于排查

## 前端关键实现：`ClawConnection`

`ui/src/services/claw-connection.js` 的 `request()` 方法支持两阶段回调：

```js
const result = await conn.request('agent', agentParams, {
  timeout: 0,              // agent 长任务，不设 RPC 超时
  onAccepted: (payload) => {
    // payload.runId 可用于匹配后续 streaming 事件
  },
  onUnknownStatus: (status, payload) => {
    // 处理未知中间态
  },
});
```

消息处理逻辑（`__handleRpcResponse` 方法）：

```
收到 res:
  1. 找到 waiter?
     否 -> 丢弃（正常：非 request 发起的消息）
  2. ok === false?
     是 -> reject(error)，移除 waiter
  3. 有 onAccepted 且 payload.status === "accepted"?
     是 -> 调用 onAccepted(payload)，保留 waiter（继续等终态）
  4. 无 onAccepted（非两阶段调用）且 ok === true?
     是 -> resolve，移除 waiter
  5. payload.status 是终态（"ok" / "error"）?
     是 -> resolve/reject，移除 waiter
  6. 以上都不满足（未知中间态）?
     -> 调用 onUnknownStatus，保留 waiter
```

终态判定常量：`TERMINAL_STATUSES = new Set(['ok', 'error'])`

## 调用端：chat.store.js

`ui/src/stores/chat.store.js` 的 `sendMessage` action 中发起 agent 请求：

```js
conn.request('agent', agentParams, {
  timeout: 0,
  onAccepted: (payload) => {
    // 读取 runId，设置 streamingRunId
    // 替换 pre-acceptance 180s 计时器为 post-acceptance 30min 计时器
    // 将 streaming 生命周期移交 agentRunsStore
  },
  onUnknownStatus: (status, payload) => { /* error log */ },
})
```

`agentParams` 结构：
- `message` — 用户消息文本
- `deliver: false`
- `idempotencyKey` — 幂等键
- `extraSystemPrompt` — 附加系统提示
- `sessionKey`（chat 模式）或 `sessionId`（topic 模式）

## 特殊情况

### 参数校验失败
Gateway 直接返回单次 `ok: false` 响应（无 ack），payload 中无 `status`。
此时直接走 reject 路径。

### Streaming 事件
事件以 `type: "event"` 帧独立推送，走 `conn.on('agent', cb)` 监听通道，与 `res` 响应互不干扰。

## 注意事项

- **不要在第一个 res 就移除 waiter**：这是最常见的坑。ack 只是中间态，final 才表示请求真正结束。
- **runId = idempotencyKey**：ack 返回的 runId 就是请求中传入的 idempotencyKey，用于匹配 streaming 事件。
- **幂等性**：Gateway 以 `agent:{idempotencyKey}` 缓存响应，重复请求返回缓存结果。

## 相关文件

- 协议文档：`docs/architecture/gateway-agent-rpc-protocol.md`
- RPC 传输层：`ui/src/services/claw-connection.js`（`ClawConnection` 类）
- 消息发送：`ui/src/stores/chat.store.js`（`sendMessage` action）
- OpenClaw 源码参考：`openclaw-repo/src/gateway/server-methods/agent.ts`、`openclaw-repo/src/gateway/client.ts`
