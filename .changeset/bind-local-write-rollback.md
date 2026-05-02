---
'@coclaw/openclaw-coclaw': patch
---

Fix: `bindClaw` rolls back the server-side claw via `unbindServer` when local `writeCfg` fails after the server has already issued a token, mirroring unbind's strict-no-tolerance contract. The original `writeCfg` error is rethrown wrapped with code `BIND_LOCAL_WRITE_FAILED`. If rollback also fails, do not mask the root cause — server-side leftovers can still be cleaned up by the next enroll/bind via 401/404/410.
