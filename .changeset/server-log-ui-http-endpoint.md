---
"@coclaw/server": minor
---

Add `POST /api/v1/log/ui` HTTP endpoint to receive UI remote diagnostic logs over an independent short-connection channel (separate from the RTC signaling WS). The endpoint accepts a batch `{ uiId, seq, logs[] }` with up to 100 entries and a 1 MB body, performs monotone-seq deduplication per `uiId` in an in-memory map (entries pruned after 1 h of inactivity by a 5 min sweep), and prints each entry as `[remote][ui][user:<id>|anon][batch=<uiId 尾部 8>:<seq>][ts=<ISO_UTC>] <text>`. Schema validation rejects malformed payloads with 400 without touching the dedup map; non-POST methods return 405 before any body parsing. The endpoint is not authenticated — session cookie, when present, is used only for identity labeling. The RTC signaling WS `type:'log'` branch is left intact as a 4-week rollback safety net.
