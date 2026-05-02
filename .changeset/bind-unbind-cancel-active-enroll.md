---
'@coclaw/openclaw-coclaw': patch
---

Fix: `coclaw.bind` and `coclaw.unbind` proactively cancel any in-flight enroll on entry, so that a late-arriving token from the old enroll cannot pollute local config after the new bind/unbind completes. Extract a shared `cancelActiveEnroll` helper used by the enroll RPC, the slash command, and bind/unbind paths.
