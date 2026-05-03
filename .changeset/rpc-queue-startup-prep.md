---
'@coclaw/openclaw-coclaw': patch
---

Prep `rpc-queues/` startup hook on bridge start. Once per start the bridge now (1) creates `~/.openclaw/coclaw/rpc-queues/` and removes any `*.jsonl` residuals from prior runs, and (2) probes available disk via `fs.statfs` to derive a `diskCap` value (`min(1GB, max(64MB, free × 50%))`) which is stored on the bridge instance. The value is **not yet consumed** — B-stage2 will inject it when the FileBackedQueue replaces MemoryQueue. Cleanup is whitelisted to `*.jsonl` files only and never recursive. Requires Node 18.15+ for `fs.statfs`; older runtimes silently fall back to a fixed 1GB cap. Runtime behavior of the MemoryQueue path is unchanged.
