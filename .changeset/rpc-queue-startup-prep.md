---
'@coclaw/openclaw-coclaw': patch
---

Prep `rpc-queues/` startup hook on bridge start. Once per start the bridge now (1) creates `~/.openclaw/coclaw/rpc-queues/` and removes any `*.jsonl` residuals from prior runs, and (2) probes available disk via `fs.statfs` to derive a `diskCap` value (`min(1GB, max(64MB, free × 50%))`) which is stored on the bridge instance. The value is **not yet consumed** — B-stage2 will inject it when the FileBackedQueue replaces MemoryQueue. Cleanup is whitelisted to `*.jsonl` files only and never recursive. `fs.statfs` requires Node 18.15+; older runtimes non-fatally fall back to a fixed 1GB cap (a single warning is logged via the injected logger). Runtime behavior of the MemoryQueue path is unchanged.
