---
"@coclaw/openclaw-coclaw": minor
---

Remove the werift WebRTC fallback — pion is now the sole implementation. When pion fails to preload, the plugin now reports `impl=none` instead of falling back: RTC is unavailable, but the gateway, RPC surface, and auto-upgrade pipeline are unaffected (independence pinned by a new rtc-isolation test), so such a machine can still be recovered by publishing a fixed release. The werift path was a broken fallback: its DataChannel never invokes the `onbufferedamountlow` property callback that RPC backpressure and file-download resume rely on, so file transfers and heavy RPC would wedge silently. Dropping werift also removes its 63-package dependency closure, including the only unknown-license packages in the plugin tree.
