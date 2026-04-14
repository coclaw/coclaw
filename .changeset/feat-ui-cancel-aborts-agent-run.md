---
"@coclaw/ui": minor
---

feat(ui): 取消已 accepted 的消息时调用 `coclaw.agent.abort` RPC 真正终止服务端 run

阶段 1 仅在 UI 端进入 `settling(cancel)` 过渡态保留气泡，服务端 agent run 会继续执行到完成。本次在 `cancelSend` 已 accepted 分支增加 `conn.request('coclaw.agent.abort', { sessionId })` 调用：
- sessionId 优先用 `this.sessionId`（topic 模式 UUID），其次 `this.currentSessionId`（chat 模式从 `chat.history` 获取），两者均不可知时跳过 RPC 静默降级到纯阶段 1 行为
- RPC 失败（插件/OpenClaw 不支持、sessionId 未在 activeRuns 等）均通过 `.catch` 静默吞掉，UI 不暴露错误
- abort 成功后 OpenClaw 的 `lifecycle:end` 会快速到达，`__settleWithTransition` 升级 reason 为 `'lifecycle'`，随后 `completeSettle` 清理 run → `isSending=false` → 输入框解锁

`/compact` 进行中的 run 在服务端不可中断（OpenClaw 未注册到 `ACTIVE_EMBEDDED_RUNS`），UI 通过新增 `ChatInput` 的 `cancelDisabled` prop + `ChatPage` 绑定 `chatStore?.__slashCommandType === '/compact'` 禁用取消按钮，避免用户点击后 UI 状态与服务端不一致。

详见 `docs/designs/agent-run-cancellation-implementation.md` 阶段 2。
