// preload.cjs — 沙箱渲染进程的预加载脚本（必须 CommonJS）
const { contextBridge, ipcRenderer } = require('electron');

/**
 * 为 ipcRenderer.on 封装订阅：保留 handler 引用以便返回 unsubscribe。
 * renderer 侧 mount/unmount 可调用返回值取消订阅，避免监听器累积。
 * @param {string} channel
 * @param {(payload: unknown) => void} cb - 业务回调，只接收 payload（剥离 IpcRendererEvent）
 * @returns {() => void} unsubscribe
 */
function subscribe(channel, cb) {
	const handler = (_e, payload) => cb(payload);
	ipcRenderer.on(channel, handler);
	return () => ipcRenderer.removeListener(channel, handler);
}

/**
 * 不接收 payload 的简化订阅（如 window-focus/window-blur/screenshot-trigger）
 * @param {string} channel
 * @param {() => void} cb
 * @returns {() => void} unsubscribe
 */
function subscribeVoid(channel, cb) {
	const handler = () => cb();
	ipcRenderer.on(channel, handler);
	return () => ipcRenderer.removeListener(channel, handler);
}

const electronAPI = Object.freeze({
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

	// ---- 自动更新 ----
	checkForUpdatesNow: () => ipcRenderer.invoke('updater:checkForUpdates'),
	downloadUpdate: () => ipcRenderer.invoke('updater:downloadUpdate'),
	quitAndInstall: () => ipcRenderer.invoke('updater:quitAndInstall'),
	// 获取 renderer 挂载前已触发的 update-available（避免早期事件丢失）
	getPendingUpdate: () => ipcRenderer.invoke('updater:getPending'),

	// ---- 事件监听（主进程 → 渲染进程）----
	// 所有 onXxx 均返回 unsubscribe 函数：renderer 在组件 unmount 时调用可移除监听
	onDeepLink: (cb) => subscribe('deep-link', cb),
	onUpdateAvailable: (cb) => subscribe('update-available', cb),
	onUpdateDownloadProgress: (cb) => subscribe('update-download-progress', cb),
	onUpdateDownloaded: (cb) => subscribe('update-downloaded', cb),
	onUpdateNotAvailable: (cb) => subscribe('update-not-available', cb),
	onUpdateError: (cb) => subscribe('update-error', cb),
	onWindowFocus: (cb) => subscribeVoid('window-focus', cb),
	onWindowBlur: (cb) => subscribeVoid('window-blur', cb),
	onScreenshotTrigger: (cb) => subscribeVoid('screenshot-trigger', cb),
	onDownloadProgress: (cb) => subscribe('download-progress', cb),
	onDownloadDone: (cb) => subscribe('download-done', cb),
});

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
