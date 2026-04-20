---
'@coclaw/openclaw-coclaw': patch
---

Add `FileBackedQueue` utility in `src/utils/file-backed-queue.js` — generic string queue with memory-first storage that spills to a JSONL file when the memory budget is exceeded. Internal module only; not yet wired into the plugin.
