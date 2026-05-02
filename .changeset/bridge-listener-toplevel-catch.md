---
'@coclaw/openclaw-coclaw': patch
---

Fix: wrap gateway WebSocket message listener in a top-level try/catch (via IIFE + .catch) so an exception thrown during async paths (await sendTo, settle, broadcast, etc.) cannot escape as `unhandledRejection` and crash the gateway process. Previously only `JSON.parse` was guarded; any future or upstream-injected throw past that point would leak.
