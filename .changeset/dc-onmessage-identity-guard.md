---
'@coclaw/openclaw-coclaw': patch
---

Fix: rpc DC reassembler callback adds an `sess.rpcChannel === dc` identity guard before the branch dispatch, mirroring the guard already on `dc.onclose`. Without it, a stale message event from a torn-down DC could still be in the microtask queue after rebuild, enter `__onRequest` or `__onFileRpc`, and inject the old request into the new session — polluting connId-reuse scenarios.
