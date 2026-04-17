---
'@coclaw/ui': minor
---

ChatPage header 右侧新增刷新按钮（移动端 + 桌面端），点击静默重新拉取当前 session 的消息。

作为 agent-run 结束判定残留边界的人工兜底入口：当信号丢失或 loadMessages 静默失败等少见场景导致 UI 消息暂时不一致时，用户可以通过该按钮主动恢复。

按钮同步反映全局 load 状态——后台 `connReady` watcher / `runPromise.then` / foreground 恢复等任意路径触发的 loadMessages 都会让按钮显示 spinner + disabled，帮助用户感知"后台也在同步"，也便于反馈问题时描述状态。

成功刷新顺带清 `errorText` 残留，让按钮也成为"初始加载失败 → 手动重试"的恢复入口。
