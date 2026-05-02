---
'@coclaw/openclaw-coclaw': patch
---

Fix: `waitForClaimAndSave` 在 long-poll 返回 BOUND 数据后、写本地 config 前再次检查 abort 信号；若被 abort，则与 D 阶段 partial-failure 同模式回滚 server 端 token，再抛 `enroll cancelled`。原先 abort 仅在循环开头判断，await 期间 abort + token 同时到达会让旧 enroll 的 token 落到本地，污染并发新 enroll 的状态。
