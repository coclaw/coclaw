---
"@coclaw/openclaw-coclaw": patch
---

Harden closeAll loop-safety: in closeByConnId, move __sessions.delete before the throwable synchronous teardown steps (detach handlers / clear timers) so a mid-block throw cannot leave the session in the map and spin closeAll's per-session-catch drain forever.
