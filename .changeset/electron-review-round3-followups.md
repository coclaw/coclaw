---
'@coclaw/ui': patch
---

Electron 壳子第三轮 deep-review 回归修复：

- `updater.js` `autoDownload` 跟随 `auto_update_enabled` 开关：关闭自动更新时即便 renderer 主动调 `updater:checkForUpdates`，也不会意外触发静默下载
- `main.js` 新增 `will-redirect` 对称拦截：与 `will-navigate` 共享 guard，防 3xx 重定向绕过 URL 白名单
- `tray.js` `tray:setTooltip` 处理器加 `tray.isDestroyed()` 守卫：对齐 `tray:setUnread` 路径，规避 disposeTray 进程中的竞态
- 测试稳健性：updater.test `autoDownload` 在 resetMocks 中复位；tray.test `disposeTray` 断言改为无序比较；ipc-handlers.test 在 `beforeEach` 清 `logMock.error`；url-guard.test 补 `allowDev=false` 显式语义 + `allowDev=true + 无效 URL` 边界
- 文档同步：`docs/designs/electron-desktop-shell.md` 头部标"已实施，以代码为准"；修正 autoDownload / URL 白名单 / files 声明 / isNative 迁移 4 处过时示例
