---
"@coclaw/ui": patch
---

fix(ui): 修复多 claw 共用同名 agent 时活跃 run 跨 claw 串显

当用户连接多个 claw 且各自存在同名 agent（如默认 `main`）时，一个 claw 的 "思考中 N 秒" 计数和流式内容会同时出现在其它 claw 的 chat 页面。根因是 `agent-runs.store` 的 `runKeyIndex` 使用 `chatSessionKey`（形如 `agent:main:main`，不含 clawId）作为全局扁平 key，多 claw 同名 agent 在索引中发生碰撞，`register` 时甚至会互相驱逐对方的活跃 run。

本次修复将 chat 模式的 runKey 改为 `${clawId}::${chatSessionKey}`，topic 模式仍沿用 sessionId（uuid 天然唯一）。同步修改 `AgentCard.vue`、`ManageClawsPage.vue` 中独立构造 runKey 的三处位置。
