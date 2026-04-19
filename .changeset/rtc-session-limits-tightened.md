---
'@coclaw/openclaw-coclaw': patch
---

Tighten WebRTC peer session limits to cut idle resource usage.

- `MAX_SESSIONS`: 20 → 10 — caps active + failed PeerConnections per peer. Eviction policy unchanged: only the oldest failed session is reclaimed; connected sessions are never evicted, and when none is failed the new offer still proceeds with a warning.
- `FAILED_SESSION_TTL_MS`: 24h → 12h — failed sessions reclaim their IPC listeners and Go-side resources sooner. ICE restart after foreground resume still works within the new window; beyond it the UI falls back to a fresh offer/answer.
