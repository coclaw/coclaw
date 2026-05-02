---
'@coclaw/openclaw-coclaw': patch
---

Fix: enroll's `waitForClaimAndSave` now rolls back the server-side token via `unbindServer` when local `writeCfg` fails after the server has issued a token, mirroring the bind path. Reuses the `BIND_LOCAL_WRITE_FAILED` error code.
