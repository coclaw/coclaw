---
'@coclaw/ui': minor
---

Electron 壳子深度加固与预埋补完：

- 自动更新链路闭环：preload 补 `downloadUpdate`/`quitAndInstall`/`checkForUpdatesNow`/`getPendingUpdate`；主进程 forward `update-download-progress`/`update-downloaded`/`update-not-available`/`update-error` 事件并缓存早期 pending payload；portable 模式自动跳过 autoUpdater
- Windows 冷启动 Deep Link：扫描 `process.argv` 中的 `coclaw://` URL 并在 `did-finish-load` 后 flush 补发
- 安全加固：`will-navigate` 改为严格 origin 匹配（修子域名前缀绕过）；permissions 同步/异步 handler 统一采用 URL hostname 严格比对 + permission 名白名单（对齐设计文档 §5.4）
- 用户体验：窗口 `show:false` + `ready-to-show` 防远程加载首屏白闪；窗口 `blur`/`hide` 事件桥接为 `app:background`
- 渲染端预埋：新增 `src/utils/electron-app.js`，订阅 deep-link→router.push、window-focus/blur→`app:foreground`/`app:background`、update 全流程→`electron:update-*` CustomEvent
- 发布源切换：`publish.provider` 从指向不一致仓库的 github 改为 generic（`https://im.coclaw.net/downloads/`），规避 GitHub Releases 国内访问不稳定
- 测试闭环：新增 `test:electron` 脚本接通 `vitest.electron.config.js`（原 `tray.test.js` 此前从未被执行）；补 `permissions.test.js`/`deep-link.test.js`/`updater.test.js`/`electron-app.test.js` 共 ~60 个测试
