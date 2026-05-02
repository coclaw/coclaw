---
'@coclaw/openclaw-coclaw': patch
---

Fix: enroll 流程的 `waitForClaimAndSave` 与 bind 对称：server 已发 token 但本地 writeCfg 失败时回滚 server 端 unbind，避免孤儿 claw。错误码同 bindClaw 用 `BIND_LOCAL_WRITE_FAILED`。
