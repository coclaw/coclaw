---
'@coclaw/openclaw-coclaw': patch
---

Fix: gateway WS message handler adds a `this.gatewayWs !== ws` stale guard at the top, mirroring the server sock open/message guards. Without it, late-arriving `connect.challenge` / `res` / `event` frames from a torn-down gateway ws would still write to `this.gatewayConnectReqId` / `this.gatewayReady` / forward responses, polluting the current ws's handshake or RPC routing.
