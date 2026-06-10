---
name: gateway-agent-rpc
description: OpenClaw Gateway agent RPC 两阶段响应协议。Use when 开发/修改涉及 claw-connection.js、agent 请求、RPC 响应处理、ChatPage 发送消息相关的前端代码。
---

# OpenClaw Gateway agent RPC 两阶段响应协议

`agent` 方法对同一个 request id 返回两次 `type: "res"`：

```
UI <──res── {status: "accepted", runId}   ← Phase 1: Ack（中间态）
UI <──event─ {stream: "assistant", ...}   ← 期间: streaming 事件（独立 event 帧，走 conn.on('agent', cb)）
UI <──res── {status: "ok"/"error", ...}   ← Phase 2: Final（终态）
```

## Status 判定硬规则

**非 `accepted` 即终态**（与上游 `gateway/client.ts`、plugin 端 `isFinalResMsg` 三方镜像）：

- `status === "accepted"`（且传了 `onAccepted`）→ 中间态，调回调，保留 waiter 等下一帧
- `ok === false` → reject（调用层失败；如参数校验失败时无 ack、单次返回）
- 其他一切 `ok === true`（含 `"ok"` / `"error"` / `"timeout"` / 上游未来新增 status）→ resolve 透传 `payload`

## 两条高频坑

- **不要在第一个 res 就移除 waiter**：ack 只是中间态，final 才表示请求真正结束。
- **业务层错误走 `payload.status === "error"` + `ok === true`**，不是底层 RPC reject；reject 与否由调用方按 payload 内容自决。

## 其他要点

- `runId` = 请求传入的 `idempotencyKey`，用于匹配 streaming 事件；Gateway 以 `agent:{idempotencyKey}` 缓存响应实现幂等。
- 计时器：pre-acceptance 180s；post-acceptance 24h（`ui/src/stores/agent-runs.store.js` 的 `POST_ACCEPT_TIMEOUT_MS`）。

## 详细协议与实现

- 协议规范（消息处理流程、agentParams 结构、特殊情况）：`docs/architecture/gateway-agent-rpc-protocol.md`
- 判定逻辑三方镜像详述：`docs/designs/dc-rpc-response-unicast.md`
- RPC 传输层：`ui/src/services/claw-connection.js`（`request()` 支持 `onAccepted` 两阶段回调）
- 调用端：`ui/src/stores/chat.store.js`（`sendMessage` action）
- 上游参考：`openclaw-repo/src/gateway/server-methods/agent.ts`、`openclaw-repo/src/gateway/client.ts`
