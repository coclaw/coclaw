---
'@coclaw/ui': patch
---

Cache `localStorage.rpcTrace` flag once at module load instead of reading it on every RPC send / inbound DC message. During an active agent run the inbound event stream can run hot (hundreds/sec), and synchronous `localStorage.getItem` is noticeably slower in Capacitor Android WebView than in V8 desktop — the per-message read added avoidable jitter on the hot path.

The cached value lives in a module-private `rpcTraceEnabled` boolean. To re-read after toggling `localStorage.rpcTrace` in DevTools without a page reload, call `__refreshRpcTrace()` from the Console.
