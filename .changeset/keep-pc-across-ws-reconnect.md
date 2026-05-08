---
"@coclaw/openclaw-coclaw": patch
"@coclaw/server": patch
---

fix(plugin): keep WebRTC sessions across server WS reconnect; tighten heartbeat miss limit to 3

Plugin side:
- Decouple PeerConnection lifecycle from server WS lifecycle. On non-auth WS close (heartbeat timeout 4000, abnormal 1006, etc.), the bridge now retains `webrtcPeer` and `fileHandler` instances so existing UI <-> plugin data channels survive a WS reconnect. Auth-close (4001/4003) still tears down PCs and clears the local token. `stop()` continues to close all PCs deliberately.
- Tighten `SERVER_HB_MAX_MISS` from 4 to 3 so detection lands at ~135s instead of ~180s. Real-world worst observed main-thread spike (~89.5s, OpenClaw upstream issue #75069) still has ~1.5x margin.
- `__forwardToServer` now logs a warning instead of silently dropping when WS is not ready or `send` throws, so signaling drops during a WS-down window become visible. Full queue/rollback behavior is tracked in plugins/openclaw/TODO.md.

Server side:
- Mirror the `CLAW_PING_MAX_MISS` heartbeat limit from 4 to 3 to keep both directions of the plugin <-> server WS in sync.
