---
'@coclaw/openclaw-coclaw': patch
---

Fix: dc-chunking receiver now caps incoming string frames by `Buffer.byteLength(data, 'utf8')` rather than `data.length`. The original check counted UTF-16 code units, so multi-byte characters (CJK, emoji) were under-counted by ~3x — a payload could occupy ~150MB of bytes and still pass the 50MB limit.
