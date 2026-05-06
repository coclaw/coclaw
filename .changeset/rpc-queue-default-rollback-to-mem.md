---
'@coclaw/openclaw-coclaw': patch
---

Roll back the rpc DC send queue default from `FileBackedQueue` (FBQ) back to `MemoryQueue` for the next emergency npm release. The B-stage2 swap (B9b) made FBQ the production default, but FBQ has not been validated end-to-end in real-world deployments — and an unrelated OpenClaw upgrade has broken auto-upgrade, so we need to ship a release fast without also shipping an under-tested queue change. The module-level constant `RPC_QUEUE_IMPL` in `src/webrtc/webrtc-peer.js` now reads `'mem'` instead of `'fbq'`; flipping it back to `'fbq'` is the one-line revert path the design always called out.

To preserve coverage of the FBQ assembly path (so we can flip back safely later), `WebRtcPeer` now accepts an optional `rpcQueueImpl: 'fbq' | 'mem'` constructor option. Production code does not pass it (so the module default applies); tests that need to exercise the FBQ branch (`rpc DC 装配走 FBQ 路径` / `同 connId 重建 race 隔离` / `queueDir 为 null 时降级到 MemoryQueue`) explicitly pass `rpcQueueImpl: 'fbq'`. Invalid values (anything other than the two literal strings) silently fall back to the module default. A new test pins the production-default invariant: when `rpcQueueImpl` is omitted, the queue is `MemoryQueue` even when `queueDir` is provided, and the assembly log emits `impl=mem` without the `fallback=` suffix.

Docs (`rpc-dc-send-queue.md`, `rpc-dc-file-queue.md`) updated to reflect the temporary `'mem'` default — the FBQ design and assembly path stay documented as the long-term direction, just gated on more validation. No bridge or queue-module changes; the FBQ infrastructure (cleanupResiduals, measureDiskCap, `__queueDir`, `__diskCap`) keeps running at startup so re-enabling FBQ remains a one-line flip.
