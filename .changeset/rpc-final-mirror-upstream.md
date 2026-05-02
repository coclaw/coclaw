---
'@coclaw/ui': patch
---

Treat any non-`accepted` two-phase RPC status as terminal, mirroring upstream OpenClaw `gateway/client.ts` and the plugin's `isFinalResMsg`. Previously the UI used a hardcoded whitelist (`{'ok','error'}`); when OpenClaw 2026.4.29 began returning `status='timeout'` for aborted runs, the unknown-status branch silently dropped the response — the agent RPC promise hung forever, the run state machine froze (cancelled=true / ended=false), and the STOP button stayed permanently disabled.

`__handleRpcResponse` now resolves on any `ok=true` frame whose status isn't `accepted`, transparently passing the payload (including `timeout`, `error`, `ok`, and any future status string) to the caller. The `onUnknownStatus` option is removed since the unknown branch no longer exists; this also eliminates the prior memory-leak risk where the unknown path didn't clean up `__pending`.
