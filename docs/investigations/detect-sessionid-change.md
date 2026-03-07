# 当使用 `agent(sessionKey)` 时，如何检测底层 `sessionId` 是否变更

> 更新时间：2026-03-03  
> 适用场景：CoClaw 走 `agent(sessionKey)` 发送对话，同时需要识别 OpenClaw 自动 reset（底层 session 滚动）

## 1. 关键事实

- `agent(sessionKey)` 的 ACK 不返回 `sessionId`。
- `event=agent` 事件流也不保证携带 `sessionId`。
- `chat.history(sessionKey)` 返回里包含 `sessionId`（可用于对比）。

因此，检测策略必须是 **发送前后查询 + 对比**。

---

## 2. 推荐检测流程

## Step A：发送前读取基线

调用：

```json
{ "method": "chat.history", "params": { "sessionKey": "agent:main:main", "limit": 1 } }
```

记录：
- `beforeSessionId = payload.sessionId`（可能为空）

## Step B：发起 agent run

调用：

```json
{
  "method": "agent",
  "params": {
    "sessionKey": "agent:main:main",
    "message": "...",
    "idempotencyKey": "<uuid>",
    "deliver": false
  }
}
```

记录：
- `runId`

## Step C：等待 run 结束

可选两种：
1. 订阅 `event=agent` 直到 `lifecycle.end|error`
2. 或调用 `agent.wait({ runId })`

## Step D：发送后读取并对比

再次调用 `chat.history(sessionKey)`，记录：
- `afterSessionId`

判断：
- `beforeSessionId != afterSessionId` => 底层 session 已切换（自动 reset 或显式 reset）
- 相等 => 仍在同一底层 session

---

## 3. 边界情况

1. 首次会话：`beforeSessionId` 可能为空，`afterSessionId` 有值，视为“新建 session”。
2. 并发发送：需按 `runId` 做请求级隔离，避免把别的 run 的变化归因到当前请求。
3. 网络抖动：若 agent 事件丢失，优先用 `agent.wait` 收敛后再做 Step D。
4. 其他入口并发（如 IM）可能同时推进同一 sessionKey；若要强一致，可在 server 层做发送串行化。

---

## 4. UI 呈现建议

- 检测到 sessionId 变更时，展示轻提示：
  - “OpenClaw 已自动开启新会话（session rollover）”
- 若你们维护本地会话状态缓存：
  - 更新当前会话的 `sessionId`
  - 继续沿用同一个 `sessionKey`

---

## 5. 最小实现伪代码

```ts
async function sendWithSessionRolloverDetect(sessionKey: string, message: string) {
  const before = await chatHistory(sessionKey, 1);
  const beforeId = before.sessionId ?? null;

  const runId = uuid();
  await agentSend({ sessionKey, message, idempotencyKey: runId, deliver: false });

  await agentWait({ runId, timeoutMs: 180000 });

  const after = await chatHistory(sessionKey, 1);
  const afterId = after.sessionId ?? null;

  return {
    runId,
    sessionIdChanged: beforeId !== afterId,
    beforeSessionId: beforeId,
    afterSessionId: afterId,
  };
}
```

---

## 6. 什么时候不需要做这件事

如果产品不关心“底层 session 是否滚动”，可跳过该检测，只按 `sessionKey` 连续对话。
