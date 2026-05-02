---
'@coclaw/openclaw-coclaw': patch
---

Fix: tighten param validation across several gateway RPC handlers. `nativeui.sessions.get` returns `INVALID_INPUT` for missing/non-string `sessionId` instead of `INTERNAL_ERROR`. `coclaw.topics.update` returns `NOT_FOUND` when the topic doesn't exist instead of `INTERNAL_ERROR`. `coclaw.bind` / `coclaw.unbind` / `coclaw.enroll` validate that `code` and `serverUrl` are strings. Aligns error codes with the OpenClaw gateway protocol contract.
