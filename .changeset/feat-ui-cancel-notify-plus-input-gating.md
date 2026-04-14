---
"@coclaw/ui": minor
---

feat(ui): 取消 RPC 结果按 reason notify + 输入框守卫精细化

**取消 RPC 结果 notify**

`cancelSend` 现在返回一个 Promise（已 accepted 分支），永远 resolve 为 `{ ok, reason? }` shape；RPC reject 被收敛为 `{ ok:false, reason:'rpc-error' }` 避免 unhandled rejection。`ChatPage.onCancelSend` 根据 reason 分支 notify：

- `not-supported`（侧门不存在，OpenClaw 版本过旧）→ `notify.warning` 提示升级 OpenClaw
- `abort-threw`（OpenClaw abort 抛异常）→ `notify.error` + `console.error`
- `not-found` / `rpc-error`（竞态或底层已 notify）→ 静默
- `ok: true` → 静默

新增 i18n keys `chat.cancelNotSupported` / `chat.cancelAbortFailed`（12 种语言同步）。

**accepted 后允许准备下次消息的附件**

`ChatInput` 的 "+" 文件按钮从 `:disabled="sending || disabled"` 改为 `:disabled="disabled"`，与 textarea 对齐：pre-accepted 期间被 `disabled` 禁用（`inputLocked=sending&&!__accepted`），accepted 后可点击添加文件。

**pre-accepted 期间禁止拖放文件**

`ChatPage` 的 `__onDragOver` / `__onDrop` 新增 `inputLocked` 守卫，pre-accepted 窗口拒绝拖入（不 `preventDefault`，不开启拖拽蒙层）；accepted 后继续允许拖入。

**设计文档**

修正 `docs/designs/agent-run-cancellation.md` 决策 1 中"取消后输入框守卫禁用"的不准确描述——实际仅发送按钮保持 STOP 状态，输入框在 `__accepted=true` 时始终启用。
