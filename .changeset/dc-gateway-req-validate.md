---
'@coclaw/openclaw-coclaw': patch
---

Fix: `__handleGatewayRequestFromDc` validates `id` and `method` are non-empty strings before forwarding to gateway. Previously a malicious or misconfigured peer sending `{ "type": "req", "params": {...} }` (missing fields) would forward `id: undefined / method: undefined` to gateway and pollute the RPC protocol. Now drop+warn when fields are missing; if `id` is valid but `method` is missing, reply with an `INVALID_REQUEST` frame so the peer stops waiting.
