---
'@coclaw/openclaw-coclaw': patch
---

Fix: `waitForClaimAndSave` 把 server 408 + `CLAIM_TIMEOUT` 视为终态过期错误，立即抛 `claim code expired` 退出循环。原先所有非 404 错误（含 server 已过期的 408）都被当作瞬态错误重试，导致后台 enroll 在 claim code 永久失效后仍每 2s 轮询，永远占住 `activeEnrollAbort` 槽位。
