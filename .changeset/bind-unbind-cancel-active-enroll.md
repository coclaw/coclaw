---
'@coclaw/openclaw-coclaw': patch
---

Fix: `coclaw.bind` 和 `coclaw.unbind` 进入时主动取消正在等待的 enroll，避免旧 enroll 后到的 token 在 server 解绑或新 bind 完成后污染本地 config。抽 `cancelActiveEnroll` helper 同时被 enroll RPC、斜杠命令、bind/unbind 共用。
