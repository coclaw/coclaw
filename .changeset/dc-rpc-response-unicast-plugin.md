---
'@coclaw/openclaw-coclaw': minor
---

feat(plugin): unicast DC RPC responses to the originating UI

Plugin now keeps a `reqId → connId` routing table for UI-forwarded DC RPC requests. When the gateway responds, the plugin sends the response only to the originating UI PC instead of broadcasting to all connected PCs. Falls back to broadcast when the mapping is missing (collision, old UI, upstream introducing a new intermediate status, etc.), so no response is ever lost. Includes a 24h TTL and an hourly sweep to clear stale entries; resets the table on gateway WS close.
