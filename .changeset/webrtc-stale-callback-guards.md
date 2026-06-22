---
"@coclaw/openclaw-coclaw": patch
---

Complete the WebRTC stale-callback identity-guard family: add ownership guards to `dc.onopen` and `dc.onerror`, and move the existing `pc.onconnectionstatechange` guard ahead of its logging. Superseded data-channel / peer-connection callbacks no longer emit misleading logs or send redundant peer-transport signaling for the current session. Live-path behavior is unchanged.
