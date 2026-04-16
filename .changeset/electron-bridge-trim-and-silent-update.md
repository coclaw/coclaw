---
'@coclaw/ui': minor
---

Electron 壳子对齐 Capacitor 无感更新策略，撤掉无业务消费的 renderer 桥接：

- `updater.js` 改 `autoDownload: true`：发现新版本立即下载、下次退出时自动安装，与 Capacitor `/version.json` 路径一致；不再要求 renderer 弹窗确认
- `electron-app.js` 移除 5 个 `electron:update-*` / 2 个 `electron:download-*` / 1 个 `electron:screenshot-trigger` 事件桥接（src 全局无任何 `addEventListener` 消费点）
- `main.js` 移除 `globalShortcut.register(Ctrl+Shift+A)`：项目无截图业务，避免按键无反应的假象（preload 的 `getScreenSources` / `onScreenshotTrigger` API 保留作为预埋）
- `electron-app.js` 在 window-focus / window-blur 调 `remoteLog`，对齐 Capacitor `app.stateChange` 上报埋点

preload 公共 API 保持不变（onUpdate* / onDownload* / onScreenshotTrigger 等仍可订阅，调用方按需），仅 renderer 端的桥接订阅简化为 3 个（deep-link / window-focus / window-blur）。
