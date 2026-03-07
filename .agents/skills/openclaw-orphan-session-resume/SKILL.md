---
name: openclaw-orphan-session-resume
description: Resume conversation on historical/orphan OpenClaw sessions (sessionId no longer indexed by sessions.json). Use when you need to continue a past transcript by sessionId, especially when chat.send with UUID-as-sessionKey does not append to the old jsonl.
---

# Resume Orphan Session by `sessionId`

用于处理这种场景：
- 历史 transcript 还在 `~/.openclaw/agents/<agent>/sessions/*.jsonl`
- 但该 `sessionId` 已不再被 `sessions.json` 当前 key 映射引用（orphan）

## 核心结论

- **正确路径**：走 Gateway WebSocket `method: "agent"`，传 `params.sessionId`
- **不推荐路径**：`chat.send` 把 UUID 当 `sessionKey`，通常不会直接续写原 orphan transcript

## 最小调用模板（WS）

```json
{
  "type": "req",
  "id": "resume-1",
  "method": "agent",
  "params": {
    "sessionId": "<orphan-session-id>",
    "message": "<你的新问题>",
    "idempotencyKey": "resume-<timestamp>",
    "deliver": false
  }
}
```

预期：
1. 先收到 `res.ok=true` + `payload.runId`
2. 后续收到 `event=agent/chat`
3. transcript `<sessionId>.jsonl` 出现新 message 记录（user/assistant）

## 一键脚本（推荐）

已内置脚本：`scripts/resume-orphan-session.mjs`

```bash
node scripts/resume-orphan-session.mjs \
  --sessionId <uuid> \
  --message "继续这个历史会话" \
  --url ws://127.0.0.1:3001?role=client
```

脚本会输出 JSON 结果，关键字段：`ok / grew / markerFound / finalSeen / runId`。

## 验证步骤（手工）

1. 发送前记录目标文件大小：`<sessionId>.jsonl`
2. 发起 `agent(sessionId=...)`
3. 等待 `chat final`（或至少有 assistant 输出）
4. 再次检查文件大小与 tail 是否包含本次 marker

## 常见误区

- `sessions.resolve(sessionId)` 失败，不代表不能通过 `agent(sessionId)` 续写。
- `sessions_history` 的 `limit` 是消息条数，不是历史 session 数。
- `chat.send` 需要 `sessionKey` 语义；UUID 文本不等同“恢复旧 transcript”。

## 排障提示

- 若长时间无动作，先确认 gateway 在线，再重试一次带新 `idempotencyKey`。
- 若怀疑写入失败，优先看：
  - `chat` 事件是否出现 `final/error/aborted`
  - 目标 `.jsonl` 文件是否增长
  - 目标 tail 是否出现本轮 marker
