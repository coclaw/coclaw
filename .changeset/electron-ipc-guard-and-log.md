---
'@coclaw/ui': patch
---

Electron 壳子小修（Batch F）：

- `ipc-handlers.js` 加注册幂等守卫：重复调用 `registerIpcHandlers` 直接跳过，防御两类问题：(1) `ipcMain.handle` 对同一 channel 重复注册会抛错；(2) `session.on('will-download', ...)` 累积监听会导致每次下载重复发送 `download:progress` / `download:done` 事件
- `main.js` 的 `console.warn`（截图快捷键注册失败分支）替换为 `electron-log` 的 `log.warn`，确保生产环境日志能落盘被 `electron-log` 统一收集
