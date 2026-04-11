---
"@coclaw/ui": patch
---

fix(ui): 文件下载串行队列 + pending 状态可视化 + 失败诊断日志

- `files.store` 新增 `__runDownloadQueue`：同一 (claw, agent) 下载串行执行，避免多 DC 并发把插件 SCTP 缓冲灌满导致 UI READY_TIMEOUT。
- `files.store` 新增 `logTaskFailure` helper，覆盖 file-transfer 之外的失败路径（saveBlobToFile / Capacitor 权限错误等），并区分 `DOWNLOAD_FAILED` / `SAVE_FAILED` 阶段；UI 出现 failed 时一定能在 console + remoteLog 找到诊断信息。
- `FileListItem` 新增 pending 分支，渲染「等待中…」+ 取消按钮；删除按钮在 pending 时也隐藏，避免误删排队中的任务。修复了上一版下载入队后 UI 无任何反馈、用户误以为「点击被忽略」的问题。
- `FileUploadItem` 取消按钮图标与下载侧统一为 `i-lucide-circle-stop`。
