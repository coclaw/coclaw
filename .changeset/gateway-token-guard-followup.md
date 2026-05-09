---
"@coclaw/openclaw-coclaw": patch
---

Harden the realtime bridge token guard introduced in the previous patch. Resolve the gateway auth token before tearing down any existing singleton, so a transient resolver failure can no longer kill a healthy bridge. When the resolver itself throws, log the underlying error via the injected logger instead of swallowing it silently. Also export `GATEWAY_RETRY_DELAYS_MS` so the retry-timer test helper imports the same constant the production code uses, removing the duplicated retry table that was prone to silent drift.
