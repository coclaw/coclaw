---
"@coclaw/ui": patch
---

fix(ui): 取消已 accepted 的消息时保留气泡、等 lifecycle:end 自然收敛

当用户在 `agent accepted` 后点取消，原来 `cancelSend` 硬清理 `streamingMsgs` 并立即 `reconcileMessages`，由于服务端 run 仍在执行、user message 尚未持久化，导致用户消息气泡消逝，直到 run 真正结束时才恢复（main-agent-chat / topic 必现）。

本次修复：
- `agent-runs.store` 新增 `settlingReason: 'lifecycle' | 'cancel'` 字段区分 settling 来源；新增公共方法 `settleWithTransitionByKey(runKey)` 进入 `settling(cancel)` 过渡态但保留 streamingMsgs 与 30min 兜底 timer，不主动调度 500ms fallback
- `completeSettle` 仅处理 `settlingReason='lifecycle'` 的 run，防止 WS 闪断重连 / 前台恢复 / activate 重入等独立 loadMessages 路径误清 `settling(cancel)` 状态下的 streamingMsgs
- `__settleWithTransition`（由 lifecycle:end 触发）把 reason 升级为 `'lifecycle'`，解锁后续 completeSettle 清理
- `cancelSend` 已 accepted 分支改用新方法：不 reject 原 `agent()` RPC Promise、nullify `__cancelReject` 槽位避免后续 cleanup 误 reject、不立即 reload messages
- 此阶段 `isSending` 仍为 true（`isRunning` 判 `!settled`），输入框保持禁用；真正"取消后立即解锁"将在阶段 2 通过插件 `coclaw.agent.abort` 驱动 `lifecycle:end` 快速到达实现

详见 `docs/designs/agent-run-cancellation.md` 阶段 1。
