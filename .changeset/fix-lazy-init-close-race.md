---
"@coclaw/openclaw-coclaw": patch
---

fix(webrtc): on an auth-close (4001/4003) the realtime bridge now awaits an in-flight lazy WebRtcPeer init before tearing down, so a close that races a pending `__initWebrtcPeer` no longer leaks an orphan PeerConnection and file handler. The `__webrtcPeerReady` latch is also cleared unconditionally. The `stop()`/`refresh()` teardown path is now covered by the same guard.
