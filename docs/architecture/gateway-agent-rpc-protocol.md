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
| `"error"` | final | 执行失败 | `false` | 是 |

**终态判定策略（CoClaw 前端实现）：**

- 终态明确：`status === "ok"` 或 `status === "error"`
- 已知中间态：`status === "accepted"`（跳过，继续等待终态）
- 未知状态：既非终态也非已知中间态 -> error log + notify 用户，暴露问题

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

1. `gateway.ws.js` 的 `request()` 方法需支持两阶段：收到 `status: "accepted"` 时不移除 waiter，等终态才 resolve/reject
2. 调用方通过 `onAccepted` 回调获取 ack 中的 `runId`
3. 任何阶段收到 `ok: false` 都立即 reject
4. OpenClaw 官方 client 通过 `expectFinal: true` 实现同样机制（见 `client.ts:394`）

## 常见错误码

| code | 含义 |
|---|---|
| `INVALID_REQUEST` | 参数校验失败（无 ack，单次响应） |
| `UNAVAILABLE` | 运行时错误（有 ack，final 为 error） |
| `AGENT_TIMEOUT` | 执行超时 |
| `NOT_PAIRED` | 设备配对问题 |

## 幂等性

Gateway 以 `agent:{idempotencyKey}` 为 key 缓存响应。重复请求返回缓存结果。
