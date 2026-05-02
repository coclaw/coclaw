# OpenClaw Gateway agent RPC 两阶段响应协议

> 源码参考：`openclaw-repo/src/gateway/server-methods/agent.ts`
> 客户端参考：`openclaw-repo/src/gateway/client.ts`

## 概述

OpenClaw Gateway 对 `agent` 方法采用 **两阶段响应** 模式：同一个 request id 会收到两次 `type: "res"` 消息。通过 `payload.status` 区分阶段。

## 响应阶段

### Phase 1: Ack（中间态）

Gateway 收到请求后**立即**返回：

```json
{
  "type": "res",
  "id": "<request-id>",
  "ok": true,
  "payload": {
    "runId": "<idempotencyKey>",
    "status": "accepted",
    "acceptedAt": 1709654400000
  }
}
```

- `runId` = 请求中传入的 `idempotencyKey`
- 表示 gateway 已接收请求并开始执行

### Phase 2: Final（终态）

Agent 执行完毕后返回（可能数秒到数分钟后），**同一个 id**：

**成功：**
```json
{
  "type": "res",
  "id": "<request-id>",
  "ok": true,
  "payload": {
    "runId": "<idempotencyKey>",
    "status": "ok",
    "summary": "completed",
    "result": { ... }
  }
}
```

**失败：**
```json
{
  "type": "res",
  "id": "<request-id>",
  "ok": false,
  "payload": {
    "runId": "<idempotencyKey>",
    "status": "error",
    "summary": "error description"
  },
  "error": {
    "code": "UNAVAILABLE",
    "message": "Error: ..."
  }
}
```

**被 abort（OpenClaw 2026.4.29 起）：**
```json
{
  "type": "res",
  "id": "<request-id>",
  "ok": true,
  "payload": {
    "runId": "<idempotencyKey>",
    "status": "timeout",
    "summary": "aborted",
    "stopReason": "stop",
    "result": { "meta": { "aborted": true, ... }, "payloads": [...] }
  }
}
```

注意：`status: "timeout"` 不是"超时"语义，是"被中途 abort 后的正常回包"——`ok` 仍为 `true`，调用方应按业务终态收尾。OpenClaw 错误路径中被 abort 时也回 `status: "timeout"`（外层 `ok=false`）。

### 特殊情况：参数校验失败

当请求参数不合法时，Gateway 直接返回单次错误响应（无 ack）：

```json
{
  "type": "res",
  "id": "<request-id>",
  "ok": false,
  "error": {
    "code": "INVALID_REQUEST",
    "message": "invalid agent params: ..."
  }
}
```

此时 `payload` 中无 `status` 字段。

## Status 取值与判定规则

| status | 阶段 | 含义 | `ok` | 终态? |
|---|---|---|---|---|
| `"accepted"` | ack | 请求已接收 | `true` | 否 |
| `"ok"` | final | 执行成功 | `true` | 是 |
| `"error"` | final | 执行失败 | `false`（参数错）/ `true`（业务错带 payload） | 是 |
| `"timeout"` | final | 被中途 abort 后的正常回包 | `true` | 是 |

**终态判定策略（CoClaw 前端实现）：**

判据采用 **"非 `accepted` 即终态"**——`status === "accepted"` 是唯一中间态，其余一切（含上游未来新增的任何字符串）都视为终态 resolve 透传 payload。这与上游 `gateway/client.ts` 的 `expectFinal && status === "accepted"`、plugin 端 `isFinalResMsg` 三方完全镜像，对上游 status 枚举的扩展具有未来兼容性。

详见 `docs/designs/dc-rpc-response-unicast.md` §5.1。

## Streaming 事件（执行期间）

在 ack 和 final 之间，Gateway 以 `type: "event"` 帧推送流式数据：

```json
{
  "type": "event",
  "event": "agent",
  "payload": {
    "runId": "<idempotencyKey>",
    "stream": "assistant|tool|thinking|lifecycle",
    "data": { ... }
  }
}
```

事件与响应是独立通道：事件走 `on('agent', ...)` 监听，响应走 `request()` 的 Promise。

## 前端实现要点

1. `claw-connection.js` 的 `request()` 方法支持两阶段：传 `onAccepted` 回调即开启两阶段；收到 `status: "accepted"` 调回调保留 waiter，其他 status 一律 resolve 透传
2. 调用方通过 `onAccepted` 回调获取 ack 中的 `runId`
3. 任何阶段收到 `ok: false` 都立即 reject
4. 业务层错误（如执行失败）通过 `payload.status` 表达，调用方按 payload 内容自决，不依赖 RPC 层 reject
5. OpenClaw 官方 client 通过 `expectFinal: true` 实现同样机制（见 `client.ts:394`）；plugin 端复用判据封装为 `isFinalResMsg`

## 常见错误码

| code | 含义 |
|---|---|
| `INVALID_REQUEST` | 参数校验失败（无 ack，单次响应） |
| `UNAVAILABLE` | 运行时错误（有 ack，final 为 error） |
| `AGENT_TIMEOUT` | 执行超时 |
| `NOT_PAIRED` | 设备配对问题 |

## 幂等性

Gateway 以 `agent:{idempotencyKey}` 为 key 缓存响应。重复请求返回缓存结果。
