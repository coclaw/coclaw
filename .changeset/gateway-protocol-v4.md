---
"@coclaw/openclaw-coclaw": patch
---

Advertise gateway protocol range v3–v4 in the connect handshake

OpenClaw's gateway now requires protocol v4 (`MIN_CLIENT_PROTOCOL_VERSION=4`).
The plugin's connect request hard-coded `minProtocol: 3, maxProtocol: 3`, a range
that no longer includes the gateway's current protocol, so every handshake to the
local gateway was rejected with "protocol mismatch" after an OpenClaw upgrade —
leaving CoClaw unable to issue any gateway RPC even though the WebRTC transport was
healthy. The request now sends `maxProtocol: 4` (keeping `minProtocol: 3` so older
v3 gateways still negotiate down), matching the reference client handshake range.
