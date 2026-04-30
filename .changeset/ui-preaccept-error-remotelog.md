---
"@coclaw/ui": patch
---

chore(ui): add chat.preAccept.error remoteLog at the pre-acceptance catch-all branch

Surfaces wire-layer drops (e.g. silent JSON frame coercion that was just fixed
on the plugin side) in remote diagnostics instead of silently failing past the
user-facing 180 s timeout. Pairs with the plugin-side `RpcSendQueue` string
type-preservation fix.
