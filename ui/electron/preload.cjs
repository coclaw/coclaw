// preload.cjs — 沙箱渲染进程的预加载脚本（必须 CommonJS）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
	// ---- 平台信息 ----
	platform: process.platform, // 'win32' | 'darwin' | 'linux'

	// ---- 壳子版本（打包时由 electron-builder extraMetadata 注入） ----
	getShellVersion: () => ipcRenderer.invoke('app:getShellVersion'),

	// ---- 对话框 ----
	openFile: (options) => ipcRenderer.invoke('dialog:openFile', options),
	saveFile: (options) => ipcRenderer.invoke('dialog:saveFile', options),

	// ---- 剪贴板 ----
	clipboardWriteText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
	clipboardReadText: () => ipcRenderer.invoke('clipboard:readText'),
	clipboardWriteImage: (dataUrl) => ipcRenderer.invoke('clipboard:writeImage', dataUrl),
	clipboardReadImage: () => ipcRenderer.invoke('clipboard:readImage'),

	// ---- 通知 ----
	showNotification: (title, body, options) =>
		ipcRenderer.invoke('notification:show', title, body, options),

	// ---- 系统托盘 ----
	setTrayTooltip: (text) => ipcRenderer.send('tray:setTooltip', text),
	setTrayUnread: (hasUnread) => ipcRenderer.send('tray:setUnread', hasUnread),

	// ---- 任务栏/Dock ----
	flashFrame: (flag) => ipcRenderer.send('window:flashFrame', flag),
	setBadgeCount: (count) => ipcRenderer.send('app:setBadgeCount', count),
	setOverlayIcon: (dataUrl, description) =>
		ipcRenderer.send('window:setOverlayIcon', dataUrl, description),
	clearOverlayIcon: () => ipcRenderer.send('window:clearOverlayIcon'),

	// ---- 窗口 ----
	requestAttention: (type) => ipcRenderer.send('window:requestAttention', type),

	// ---- 外部链接 ----
	openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

	// ---- 截图 ----
	getScreenSources: () => ipcRenderer.invoke('screenshot:getSources'),
	getScreenPermission: () => ipcRenderer.invoke('screenshot:checkPermission'),

	// ---- 设置 ----
	getSetting: (key) => ipcRenderer.invoke('store:get', key),
	setSetting: (key, value) => ipcRenderer.invoke('store:set', key, value),

	// ---- 下载 ----
	downloadFile: (url) => ipcRenderer.invoke('download:start', url),

	// ---- 事件监听（主进程 → 渲染进程）----
	onDeepLink: (cb) => ipcRenderer.on('deep-link', (_e, url) => cb(url)),
	onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_e, info) => cb(info)),
	onWindowFocus: (cb) => ipcRenderer.on('window-focus', () => cb()),
	onScreenshotTrigger: (cb) => ipcRenderer.on('screenshot-trigger', () => cb()),
	onScreenshotKeyFailed: (cb) => ipcRenderer.on('screenshot-key-failed', (_e, info) => cb(info)),
	onDownloadProgress: (cb) => ipcRenderer.on('download:progress', (_e, info) => cb(info)),
	onDownloadDone: (cb) => ipcRenderer.on('download:done', (_e, info) => cb(info)),
});
