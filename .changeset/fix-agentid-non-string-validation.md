---
"@coclaw/openclaw-coclaw": patch
---

fix(plugin): a non-string `agentId` on session, topic, chat-history and file RPC/DC methods now fails loudly with `INVALID_INPUT` instead of being silently coerced to `'main'`, which could leak another workspace's file listing/content or misdirect writes. Omitted/empty/whitespace `agentId` still falls back to `'main'` as before.
