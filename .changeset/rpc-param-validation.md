---
'@coclaw/openclaw-coclaw': patch
---

Fix: 多个 gateway RPC handler 入口参数校验补齐。`nativeui.sessions.get` 缺/非字符串 `sessionId` 时返回 `INVALID_INPUT` 而非 `INTERNAL_ERROR`；`coclaw.topics.update` 在 topic 不存在时返回 `NOT_FOUND` 而非 `INTERNAL_ERROR`；`coclaw.bind` / `coclaw.unbind` / `coclaw.enroll` 校验 `code`、`serverUrl` 必须为字符串。错误码契约对齐 OpenClaw gateway 协议。
