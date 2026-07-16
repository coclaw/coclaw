---
"@coclaw/openclaw-coclaw": minor
---

Remove the werift WebRTC fallback — pion is now the sole implementation. When pion fails to preload, the plugin now reports `impl=none` instead of falling back: all DataChannel-based remote features (chat, UI RPC, file transfer) become unavailable, while the gateway process, its local RPC surface, and the auto-upgrade pipeline stay healthy (independence pinned by a new rtc-isolation test), so such a machine can still be recovered by publishing a fixed release. The werift path was a broken fallback: its DataChannel never invokes the `onbufferedamountlow` property callback that RPC backpressure and file-download resume rely on, so file transfers and heavy RPC would wedge silently. Dropping werift also removes its 62-package dependency closure from the plugin tree, including the only unknown-license packages in it.
