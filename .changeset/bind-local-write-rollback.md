---
'@coclaw/openclaw-coclaw': patch
---

Fix: bindClaw 在 server 已发 token 但本地 writeCfg 失败时，自动调用 server 端 unbind 回滚 — 避免产生只在 server 端存在、本地无凭据的"孤儿 claw"（与 unbind 强制不容错的红线对称）。回滚也失败时，仍以新的错误码 `BIND_LOCAL_WRITE_FAILED` 抛出原始 write 错误（不掩盖根因；server 端残留可由下次 enroll/bind 时 401/404/410 自动清理）。
