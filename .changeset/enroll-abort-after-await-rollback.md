---
'@coclaw/openclaw-coclaw': patch
---

Fix: `waitForClaimAndSave` re-checks the abort signal after `waitClaimCode` returns BOUND data and before writing local config; if aborted, roll back the server-side token (same partial-failure pattern as the D-stage fix) and throw `enroll cancelled`. Previously abort was only checked at the loop top, so an abort that arrived during the long-poll await alongside a token would persist the now-orphaned token to local config and pollute concurrent new-enroll state.
