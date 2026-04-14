---
"@coclaw/ui": patch
---

fix(ui): 拉长 agent run / 斜杠命令 / 标题生成超时，避免长任务被前端过早中断

- **post-acceptance timeout**：30min → 24h（`POST_ACCEPT_TIMEOUT_MS`）。客户端等待 `lifecycle:end` 的 fallback 超时与 OpenClaw agent run 生命周期对齐；正常路径下 run 由事件驱动 settle，此 timer 只作 WS 丢事件 / OpenClaw 崩溃的兜底清理
- **`/compact` 斜杠命令**：10min → 24h（`POST_ACCEPT_TIMEOUT_MS`）。`/compact` 触发服务端 LLM 摘要可跑很久，前端不应先于服务端超时；`/new` / `/reset` 保持 10min（sessions.reset 是秒级操作），其它斜杠命令保持 5min
- **生成 topic 标题的 RPC 超时**：5min → 10min，给插件内部 agentRpc（同步提高到 5min）留足 buffer

`POST_ACCEPT_TIMEOUT_MS` 从 `agent-runs.store.js` export，供 `chat.store.js` 复用；相关测试用该常量替换原硬编码 `30 * 60_000`。
