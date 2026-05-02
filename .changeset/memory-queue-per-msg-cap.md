---
'@coclaw/openclaw-coclaw': patch
---

Fix: add per-message hard cap to MemoryQueue admission. Previously the 50 MB ceiling was only enforced inside RpcDcSender.send(), so an oversized frame (especially one that hit the bypassAdmission whitelist) could be enqueued first and only rejected later by the sender — letting `memBytes` balloon while the sender was blocked on backpressure. Now MemoryQueue takes a `maxMessageBytes` option and rejects oversized frames at enqueue time without bypass exemption, mirroring the sender's hard limit. webrtc-peer wires it to `MAX_SINGLE_MSG_BYTES` so the rpc DC pipeline stays bounded end-to-end.
