---
'@coclaw/ui': minor
---

Electron 壳子 preload 重构（Batch D）：

- 所有 `onXxx(cb)` 返回 unsubscribe 函数，renderer 可主动取消订阅；防止 HMR / 组件 unmount/remount 时监听器累积
- `electron-app.js` 追踪每个订阅的 unsub，新增 `disposeElectronApp()` 一键清理；`initElectronApp` 重复调用时先 dispose 再订阅，HMR 不再累积
- preload 导出对象改为 `Object.freeze(...)`，防御 preload 自身未来扩展误改已暴露 API；contextBridge 对 renderer 侧再次隔离
- 命名一致性：`download:progress` / `download:done` 两个事件通道改为 `download-progress` / `download-done`，与其它主→渲染事件（deep-link、update-\*、window-focus、screenshot-trigger）统一连字符风格

preload 公共 API（方法名、参数、行为）保持不变，仅 `onXxx` 多了一个可选的返回值；内部 IPC channel 重命名对 renderer 透明（all plumbing in preload/main）。
