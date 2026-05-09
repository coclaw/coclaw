---
"@coclaw/openclaw-coclaw": patch
---

chore(plugin): promote inner-line handshake logs from debug to info

Promote four plugin↔gateway WebSocket handshake milestones from `debug` to `info` so they survive the default log level (which usually filters out debug):

- `[coclaw] gateway ws open, waiting for connect.challenge`
- `[coclaw] gateway event <- connect.challenge legacyMode=...`
- `[coclaw] gateway connect request -> id=...`
- `[coclaw] gateway connect ok <- id=...`

These are first-class lifecycle events for the inner line and align with the existing outer-line `[coclaw] realtime bridge connected: ...` (also `info`). Previously they only showed up under verbose logging, making it harder to diagnose handshake races (e.g. plugin startup colliding with `gateway starting; retry shortly`). Higher-volume RPC routing logs (`rpc-res-route` / `run-event-route`) remain `debug`.

No behavior change.
