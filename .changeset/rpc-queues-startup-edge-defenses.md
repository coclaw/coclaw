---
'@coclaw/openclaw-coclaw': patch
---

Harden `rpc-queue-startup.js` defenses surfaced by the combined plan-1+plan-2 deep review:

- `measureDiskCap` now falls back to the fixed 1GB cap whenever `fs.statfs` returns non-finite fields (NaN/undefined `bavail` or `bsize`, missing fields) or negative `free`. Without this, `Number(NaN) * Number(_)` is `NaN` and the value would propagate through the `min/max/floor` chain and store `NaN` on `bridge.__diskCap`. Real production environments (containers, network mounts, exotic filesystems) occasionally surface such fields. A single warn (`rpc-queues statfs failed (non-finite, fallback 1GB): bavail=X bsize=Y`) is logged via the injected logger.
- `cleanupResiduals` pulls `nodePath.join` inside the same `try/catch` that wraps `unlink`. The "module never throws" contract was technically violated when `dir` was non-string (production paths always pass a string from `nodePath.join` upstream, but the defensive layer keeps the contract honest under future refactors and unusual `fsOps` injections).

Both fixes are paired with new edge-case tests (non-finite statfs fields, negative free, non-string dir over five shapes). Two orthogonal coverage gaps from the same review pass are also closed: multi-connId `rpc-drop-monitor` isolation (mobile 5-8 concurrent DC overflow scenario — three monitors must keep their `dropCount`/`dropBytes`, warn lines, remoteLog and close-summary streams independent) and `MemoryQueue` destroy/enqueue mutex race (`destroy` enqueued first into the mutex queue must run its `onBeforeClear` then set `destroyed=true`; the pending `enqueue`, when it acquires the mutex, sees `destroyed=true` and returns `false` silently). `MemoryQueue.enqueue`'s JSDoc now explicitly documents that the destroyed short-circuit is silent by design — no `onDrop` is fired — which is distinct from the loud-on-loss contract that governs live-connection drops (`oversize` / `queue-full`).

Coverage stays at the same 100/96.43/100/100 baseline. No public API or runtime behavior change beyond the additive defensive warn lines.
