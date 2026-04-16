---
'@coclaw/ui': patch
---

冷启动路由恢复扩展到 Electron：

`router/index.js` 的 `app:background` 保存路由 + 启动时从 localStorage 恢复路由的逻辑此前用 `isNative`（仅 Capacitor）门控；改为 `isNativeShell`（Capacitor + Electron + 预留 Tauri）。

效果：用户从托盘 Quit 或 `Cmd+Q` 退出 Electron 后再次启动，会自动回到上次访问的页面，与移动端体验一致。
