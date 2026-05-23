---
'@coclaw/ui': patch
---

chore(ui): surface fire-and-forget loader failures in claw-lifecycle via console.warn

Replace the seven `.catch(() => {})` swallows in `claw-lifecycle.js`
(`initClawResources` + `refreshClawResources`) with thin
`console.warn('[lifecycle] <phase> <loader> failed clawId=%s:', id, err)`
wrappers. The fire-and-forget semantics are preserved — each loader
still has its own internal `try/catch + warn + no rethrow`, so the
outer catch rarely fires, but when it does (e.g. unexpected
programming error in a loader) there will now be a diagnostic trail
instead of a silent black hole.

No behavior change beyond logging.
