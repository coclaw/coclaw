---
'@coclaw/openclaw-coclaw': minor
---

Swap the per-session WebRTC RPC send queue from `MemoryQueue` to `FileBackedQueue` (B-stage2 B9b). Selection is gated by a single module-level constant `RPC_QUEUE_IMPL` in `webrtc-peer.js`; the default is `'fbq'`, and `'mem'` remains a one-line revert path for dev / test / emergency rollback.

When the queue dir is unavailable (the bridge's startup `cleanupResiduals` / `measureDiskCap` prep failed), the assembly automatically falls back to `MemoryQueue` for that session — the `'fbq'` path never blocks `webrtc` setup. Each FBQ session id is suffixed with `${Date.now()}-<uuid8>` so concurrent same-`connId` rebuilds (e.g. ICE restart failure → new offer landing during the previous instance's `await destroy`) target physically different `*.jsonl` files and never race on disk IO. Startup `cleanupResiduals` already whitelists `*.jsonl`, so suffixed leftovers are reclaimed at next start.

Each session's chosen impl is logged locally (`info`) and pushed via `remoteLog` (`rtc.queue-impl conn=… impl=fbq|mem [fallback=queue-dir-null]`) once on assembly so operators can see the actual runtime behaviour, including silent fallbacks. The four queue cleanup sites in `WebRtcPeer` are unchanged thanks to B6/B7/B8 already aligning the FBQ contract.
