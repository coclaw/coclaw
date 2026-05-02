---
'@coclaw/openclaw-coclaw': patch
---

Fix: harden two edge paths in realtime-bridge. (1) Server socket `open` and `message` listeners get a `serverWs !== sock` guard so a late-arriving open from a stale sock cannot reset the sender / heartbeat after reconnect, and a late-arriving message cannot reset the current sock's heartbeat timeout. (2) `__closeGatewayWs()` calls `__clearAllLagProbes()` synchronously on intentional close, no longer relying on the close-event callback timing — preventing probe leaks during the close-event delay.
