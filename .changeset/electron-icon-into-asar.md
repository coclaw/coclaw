---
'@coclaw/ui': patch
---

Electron 把 `icon.ico` / `icon.icns` 加进 asar 包：

`electron-builder.yaml` 的 `files` 白名单原本只包含 `icon.png` 和 `tray-icon*.png`，导致 `BrowserWindow.icon` 在 Windows 运行时按 `path.join(__dirname, '../build-resources/icon.ico')` 读到空 nativeImage（窗口栏 fallback 到 .exe 默认图标）。

现把三种格式都显式列入 files，让 BrowserWindow.icon 在所有平台都能命中正确资源。
