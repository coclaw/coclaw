---
'@coclaw/openclaw-coclaw': patch
---

Fix: bind/unbind/enroll handlers now reject whitespace-only `serverUrl` (e.g. `"   "` or `"\t\n "`) with INVALID_INPUT instead of letting it fall through to `new URL()` and surface as INTERNAL_ERROR. Tighten the existing length check to `.trim().length === 0`.
