---
"@coclaw/ui": patch
---

Gate RTC recovery actions on `claw.online`: when SSE reports the plugin as offline, pause the in-flight ICE restart (reset its 90s budget, keep the PC), cancel pending backoff retries, and skip probe/restart/rebuild attempts. When the plugin comes back online, resume via a fresh ICE restart if the PC was paused in `restarting`, otherwise rebuild from scratch. Avoids burning recovery budget while the plugin is known-unreachable, while still leveraging ICE restart's fast-path on return.
