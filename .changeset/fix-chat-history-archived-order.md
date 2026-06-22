---
"@coclaw/openclaw-coclaw": patch
---

fix(chat-history): `chatHistory.list` now sorts the archived segment by `archivedAt` descending (newest first) before returning, keeping the active head pinned at index 0. The reorder is done on a fresh copy so the in-memory cache is never mutated; non-numeric `archivedAt` values are coerced to the oldest end, and malformed (null/non-object) entries are dropped rather than passed through, so the list never throws and never hands a null entry to consumers.
