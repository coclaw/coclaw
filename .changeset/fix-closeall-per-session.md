---
"@coclaw/openclaw-coclaw": patch
---

fix(webrtc): closeAll now tolerates an individual session's close failure (per-session error downgraded to a warn) instead of aborting the cleanup of the remaining sessions.
