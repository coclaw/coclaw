---
'@coclaw/openclaw-coclaw': patch
---

Harden `rpc-queues/` startup prep on bridge.start after deep-review:

- Wrap the prep block (`resolveStateDir() → cleanup → measure`) in a try/catch. If `resolveStateDir()` throws synchronously (e.g. a runtime-injected resolver fails), the bridge logs a single warning, leaves `__diskCap` as `null`, and continues startup instead of rejecting `bridge.start()`.
- Re-check `this.started` immediately after the prep block. If `stop()` raced during the cleanup/measure awaits, the bridge now exits before invoking the WebRTC preload (avoiding an unnecessary native subprocess spawn).
- `cleanupResiduals()` defends against non-string `readdir` entries (e.g. `Buffer` / `Dirent` returned by an unusual `fsOps` injection) by warning and skipping rather than throwing — keeping the "module never throws" contract.
- Integration tests now clean up their tmp state-dir in `finally`, the default-path test asserts `bridge.__diskCap` is a positive number, and two new tests cover the prep-failure path and the cleanup/measure stop() race.
