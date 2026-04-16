---
'@coclaw/ui': patch
---

Electron 壳子生命周期与窗口管理加固（Batch B）：

- 托盘：`attachMainWindow(app, win)` 替代之前全量监听 `browser-window-created`，避免将来截图/模态子窗口被误绑 close→hide
- 生命周期清理：新增 `disposeTray()` / `disposeUpdater()`，`will-quit` 统一调用，释放闪动 timer、托盘实例、自动更新的 30s + 4h 两个 timer 句柄
- 主窗口图标：Windows 改用 `icon.ico`（多分辨率、200% DPI 不糊），其它平台继续 `icon.png`
- 打包白名单：`electron-builder.yaml` 的 `files` 显式加入 `build-resources/icon.png`，非 Windows 平台 `BrowserWindow.icon` 不再指向打包外文件
- 跨平台守卫：`app.on('activate')` 加 `process.platform !== 'darwin'` 早 return（其它平台不会触发，显式守卫提高可读性）
- 本地化兜底：`tray:setTooltip` IPC 收到空文本时用 `getAppTitle()`（中文系统 "可虾"，英文系统 "CoClaw"），原先硬编码 "CoClaw"
