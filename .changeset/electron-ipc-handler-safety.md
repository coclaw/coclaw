---
'@coclaw/ui': patch
---

Electron IPC handler 错误处理对称：

- `ipc-handlers.js` 抽出 `safeHandle(channel, fn)` 包装 `ipcMain.handle`，所有 handler 抛错时写 `electron-log` 后重抛（renderer 仍能感知失败，主进程多一份排查日志）。受益最大的是 `screenshot:getSources`（macOS 无屏幕录制权限时会抛）、`clipboard:writeImage`、`store:get/set` 等
- `tray.js` 的 `disposeTray()` 加 `ipcMain.removeAllListeners('tray:setTooltip' / 'tray:setUnread')`，对称 `initTray` 中的 `ipcMain.on` 注册，避免测试场景重复注册或生产端口残留监听

测试同步：ipc-handlers 加 3 个 safeHandle 错误路径用例；tray 在 disposeTray 用例验证 removeAllListeners 调用。
