---
'@coclaw/openclaw-coclaw': patch
---

Plumbing for B-stage2 FBQ swap: `WebRtcPeer` constructor accepts a `getDiskCap` function dep and stores it as `__getDiskCap` (non-functions coerce to `null` for backward compat). `RealtimeBridge.__initWebrtcPeer` wires `() => this.__diskCap` into the constructor — bridge measured the disk cap once at startup (Phase B-stage1 plan-2), and B9b will read it via this getter when it instantiates `FileBackedQueue` per session. The getter is stored only; nothing consumes it yet, so behavior is unchanged.
