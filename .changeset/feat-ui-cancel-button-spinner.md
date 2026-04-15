---
"@coclaw/ui": patch
---

feat(ui): cancel button shows spinner + "Cancelling…" tooltip while in flight

用户点 STOP 后按钮原先只是禁用（透明度变化），桌面端 tooltip 仍然显示 "Stop sending" 误导用户，移动端无 hover 反馈完全感知不到取消请求是否被记录。

改进：

- `ChatInput.vue` 新增 `cancelling` boolean prop（默认 false）。当 `cancelling=true` 时 STOP 按钮：
  - 图标 `i-lucide-square` → `i-lucide-loader-circle`，配合 Nuxt UI `:ui="{ leadingIcon: 'animate-spin' }"` 持续旋转（移动端清晰可见）
  - tooltip 切到 `chat.cancelling` = "正在取消…" / "Cancelling…" 等
  - `disabled` 仍由 `cancelDisabled` 控制（防重复触发），与 `cancelling` 解耦——slash 命令场景 `cancelDisabled=true` 但 `cancelling=false` 保持原 square 图标
- `ChatPage.vue` 透传 `:cancelling="!!chatStore?.isCancelling"`
- 12 个 locale 新增 `chat.cancelling` 翻译

测试：ChatInput.test.js 覆盖 cancelling=true/false 两个分支的 icon/tooltip/ui prop；ChatPage.test.js 覆盖 isCancelling 状态透传。
