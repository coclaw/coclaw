---
"@coclaw/openclaw-coclaw": patch
---

fix(chat-history): `chatHistory.list` now sorts the archived segment by `archivedAt` descending (newest first) before returning, keeping the active head pinned at index 0. The reorder is done on a fresh copy so the in-memory cache is never mutated, and non-numeric `archivedAt` values are coerced to the oldest end without throwing.
