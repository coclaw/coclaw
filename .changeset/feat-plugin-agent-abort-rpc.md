---
"@coclaw/openclaw-coclaw": minor
---

feat(plugin): 新增 `coclaw.agent.abort` RPC，通过 OpenClaw 全局 symbol 侧门真正终止 embedded agent run

该 RPC 接受 `{ sessionId: string }`，通过 `globalThis[Symbol.for('openclaw.embeddedRunState')].activeRuns.get(sessionId)?.abort()` 触发 OpenClaw 底层 `AbortController`，停止 LLM、工具调用和 compaction。

响应语义是"请求是否被接纳"，并非"run 是否已终止"：
- `{ ok: true }`：handle.abort 已调用，取消是否真生效由随后的 `lifecycle:end` 事件反映
- `{ ok: false, reason: 'not-supported' }`：侧门不存在（OpenClaw < v2026.3.12）
- `{ ok: false, reason: 'not-found' }`：sessionId 未在 activeRuns 中（已完成 / 从未开始 / 竞态）
- `{ ok: false, reason: 'abort-threw', error }`：handle.abort 抛异常（不期望但防御）

侧门访问封装在新文件 `src/agent-abort.js`，未来上游若提供正式 `agent.abort` RPC 或在 `api.runtime.agent` 暴露 abort 家族可集中替换。

详见 `docs/designs/agent-run-cancellation-implementation.md` 阶段 2。
