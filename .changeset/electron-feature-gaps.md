---
'@coclaw/ui': minor
---

Electron 壳子功能补完（Batch C）：

- 屏幕共享体验：`setDisplayMediaRequestHandler` 传 `{ useSystemPicker: true }`，macOS 12.3+ / Windows 11 24H2+ 走 OS 原生 picker，用户可选屏/窗口/画面，隐私和体验都优于之前的"强行取第一屏"
- macOS Dock 徽章：`window:setOverlayIcon` / `window:clearOverlayIcon` 在 macOS 上转调 `app.setBadgeCount`（此前 macOS 分支是 silent no-op，导致 Web 端未读提示在 macOS 上完全不显示）
- 自动更新开关：用户可通过 `store.set('auto_update_enabled', false)` 关闭后台自动检查；关闭后不启动定时器、不订阅 powerMonitor，但手动的"检查更新"IPC 仍可用。默认 true，维持原行为
- 休眠恢复检查：订阅 `powerMonitor.on('resume', ...)`，系统睡眠恢复后立即触发一次更新检查，比 4h 周期更及时抓到发布
- `disposeUpdater` 同步移除 powerMonitor 监听，避免极端场景句柄泄漏
