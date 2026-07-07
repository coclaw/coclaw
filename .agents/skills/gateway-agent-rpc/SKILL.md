---
name: gateway-agent-rpc
description: OpenClaw Gateway agent RPC 两阶段响应协议。Use when 开发/修改涉及 claw-connection.js、agent 请求、RPC 响应处理、ChatPage 发送消息相关的前端代码。
---

# OpenClaw Gateway agent RPC 两阶段响应协议

`agent` 方法对同一个 request id 返回两次 `type: "res"`：

```
UI <──res── {ok:true, status:"accepted", runId}    ← Phase 1: Ack（中间态）
UI <──event─ {stream:"assistant", ...}             ← 期间: streaming 事件（独立 event 帧，走 conn.on('agent', cb)）
UI <──res── {status:"ok"|"timeout"|"error", ...}   ← Phase 2: Final（终态）
```

## Status 判定硬规则

**非 `accepted` 即终态**（与上游 `packages/gateway-client` 的 client、plugin 端 `isFinalResMsg` 三方镜像）：

- `status === "accepted"`（且传了 `onAccepted`）→ 唯一中间态：调回调，保留 waiter 等下一帧
- 其余一切 status（含上游未来新增）→ 终态：`ok === true` resolve 透传 payload；`ok === false` reject（`err.code` = `error.code`）

终态形态（上游现状）：

| 帧 | 含义 |
|---|---|
| `ok=true` + `status:"ok"` | 正常完成 |
| `ok=true` + `status:"timeout"` | run 被 abort 后的**业务终态帧**，不是传输层超时；成因（用户取消 / 运行超时 / 排队或等待耗尽）看 payload 的 `stopReason` / `timeoutPhase` / `providerStarted` |
| `ok=false` + `status:"error"` | 执行失败（`error.code` 常为 `UNAVAILABLE`），走 reject |
| `ok=false`、无 `payload.status` | 参数校验失败：无 ack、单帧返回 |
| `ok=true` + `status:"in_flight"` | 重复 `idempotencyKey` 命中进行中 run 的**单帧去重回包**——不是 accepted，UI 不会据此 register run |

## 两条高频坑

- **不要在第一个 res 就移除 waiter**：ack 只是中间态，final 才表示请求真正结束。
- **`status:"timeout"` 别当失败、也别当传输超时**：它是 `ok=true` 的业务终态（run 被 abort），按终态收尾、细分原因看 `stopReason`/`timeoutPhase`。真正的执行失败终态是 `ok=false`、由 reject 承载（catch 分支拿 `err.code`）——别指望 resolve 出一个 `status:"error"` 来处理失败。

## 其他要点

- `runId` = 请求传入的 `idempotencyKey`（上游直接把它用作 runId），用于匹配 streaming 事件；Gateway 以 `agent:{idempotencyKey}` 缓存响应实现幂等。
- 帧 schema：`openclaw-repo/packages/gateway-protocol/src/schema/frames.ts`——ResponseFrame 顶层只有 `type/id/ok/payload/error`（无顶层 status；`error.code` 非封闭枚举）；协议版本常量在 `packages/gateway-protocol/src/version.ts`，别在代码/文档里写死版本号。
- 计时器：pre-acceptance 180s 看门狗（`ui/src/stores/chat.store.js`）；post-acceptance 24h（`ui/src/stores/agent-runs.store.js` 的 `POST_ACCEPT_TIMEOUT_MS`）。数值以源码为准。

## 详细协议与实现

- 协议规范（消息处理流程、特殊情况）：`docs/architecture/gateway-agent-rpc-protocol.md`——⚠️ 该文档 Status 表的 error 行（"ok=true 业务错"）与"前端实现要点"第 4/5 条已过期，以本 skill 与上游源码为准（待更新）
- 判定逻辑三方镜像详述：`docs/designs/dc-rpc-response-unicast.md`
- RPC 传输层：`ui/src/services/claw-connection.js`（`request()` 支持 `onAccepted` 两阶段回调）
- 调用端：`ui/src/stores/chat.store.js`（`sendMessage` action）
- 上游参考：`openclaw-repo/src/gateway/server-methods/agent.ts`、`openclaw-repo/packages/gateway-client/src/client.ts`（`src/gateway/client.ts` 只是宿主侧薄包装）
