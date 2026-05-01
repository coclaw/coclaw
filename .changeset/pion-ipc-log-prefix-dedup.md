---
'@coclaw/openclaw-coclaw': patch
---

fix(plugin): drop duplicate `[pion-ipc]` prefix from local logger output

`pion-node` SDK already prepends `[pion-ipc] ` to every message handed to its logger callback. The plugin was wrapping that string with another `[pion-ipc] ` prefix, producing gateway log lines like `[pion-ipc] [pion-ipc] [stderr] ...`. Forward the SDK message verbatim so each line carries a single prefix.
