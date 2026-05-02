---
'@coclaw/openclaw-coclaw': patch
---

Fix: switch auto-upgrade `writeState` / `trimLog` / `writeUpgradeLock` to `atomicWriteFile` (tmp + rename). The previous bare `fs.writeFile` could leave `upgrade-state.json`, `upgrade-log.jsonl`, or `upgrade.lock` in a half-written / truncated state if the process crashed mid-syscall, which violates the project's hard rule against bare `fs.writeFile` for plugin-managed files. With atomic writes, a write failure leaves the original file untouched.
