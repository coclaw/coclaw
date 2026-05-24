---
'@coclaw/openclaw-coclaw': patch
---

test(plugin/file-manager): assertion-lock safeUnlink non-ENOENT warn path

Plus three companion test/doc fixes from the read-only deep review of the
unpushed plugin commits:

- `file-manager/handler.test.js`: add a test that injects an EACCES failure
  into `deps.unlink` and asserts the `safeUnlink failed` warn fires exactly
  once carrying both the tmp path and the error code. Previously the new
  non-ENOENT logging path in `e6e9679` had no assertion locking it, so a
  refactor could silently swallow these failures again while orphan tmp
  files accumulate.
- `auto-upgrade/updater.test.js`: tighten the `upgrade.legacy-config-read-failed`
  assertion from `startsWith` to a full-line regex `msg=corrupt`, so the
  failure-reason detail can't regress under a silent prefix-only match.
- `docs/plugin-events.md`: update the `coclaw.info.updated` trigger cell —
  it still said "全量 4 字段" while `__pushInstanceInfo()` now intentionally
  omits `agentModels` on collection failure (patch semantics, see same doc).
- `TODO.md` + `docs/rpc-dc-send-queue.md`: drop two orphan TODO entries and
  the dead-code note that all pointed at work already done (`chunkAndSend`
  removal in 22ce733, `atomicWriteFileSync` already in
  `utils/atomic-write.js` and used by `device-identity.js`).

No business code changed.
