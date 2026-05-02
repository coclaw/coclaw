---
'@coclaw/openclaw-coclaw': patch
---

Fix: rpc DC 的 reassembler 回调在分支前加 `sess.rpcChannel === dc` identity guard，与 `dc.onclose` 已加的守卫对称。原先 DC 重建后旧 dc 的 message event 若在 microtask 队列里派发，会进入 `__onRequest` 或 `__onFileRpc` 把旧请求注入新 session，污染 connId 复用场景。
