import { BrowserWindow } from 'electron';
import path from 'node:path';

const PROTOCOL = 'coclaw';

/** 最近一次未投递的 deep-link URL；窗口 did-finish-load 后补发 */
let pendingUrl = null;

/**
 * 单实例锁 + Deep Link 接收（Windows/Linux）
 * @param {Electron.App} app
 * @returns {boolean} 是否获得锁
 */
export function setupSingleInstance(app) {
	const gotLock = app.requestSingleInstanceLock();
	if (!gotLock) return false;

	app.on('second-instance', (_event, commandLine) => {
		const url = findDeepLinkInArgv(commandLine);
		if (url) handleDeepLink(url);
		const win = BrowserWindow.getAllWindows()[0];
		if (win) {
			if (win.isMinimized()) win.restore();
			win.show();
			win.focus();
		}
	});

	return true;
}

/**
 * 注册自定义协议处理器
 * @param {Electron.App} app
 */
export function registerProtocol(app) {
	if (process.defaultApp) {
		// 开发模式：尽量传 argv[1]（脚本路径）+ `--` 防 URL 参数被解析为 flag
		const args = process.argv[1] ? [path.resolve(process.argv[1]), '--'] : ['--'];
		app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, args);
	} else {
		app.setAsDefaultProtocolClient(PROTOCOL);
	}

	// macOS：通过 open-url 事件接收
	app.on('open-url', (event, url) => {
		event.preventDefault();
		handleDeepLink(url);
	});
}

/**
 * Windows 冷启动：扫 process.argv 中的 coclaw:// URL 并投递
 * @param {string[]} argv
 */
export function bootstrapDeepLinkFromArgv(argv) {
	const url = findDeepLinkInArgv(argv);
	if (url) handleDeepLink(url);
}

/**
 * 主窗口 did-finish-load 后补发 pending deep-link（若有）
 * @param {Electron.BrowserWindow} win
 */
export function flushPendingDeepLink(win) {
	if (pendingUrl && win && !win.isDestroyed()) {
		win.webContents.send('deep-link', pendingUrl);
		pendingUrl = null;
	}
}

function findDeepLinkInArgv(argv) {
	if (!Array.isArray(argv)) return null;
	return argv.find((arg) => typeof arg === 'string' && arg.startsWith(`${PROTOCOL}://`)) || null;
}

function handleDeepLink(url) {
	if (!url) return;
	pendingUrl = url; // 新 URL 覆盖旧 URL（最后胜出）
	const win = BrowserWindow.getAllWindows()[0];
	// webContents.isLoading() 加载中为 true；getURL() 非空表示至少走过一次 load
	if (win && !win.isDestroyed() && !win.webContents.isLoading() && win.webContents.getURL()) {
		flushPendingDeepLink(win);
	}
}

/** @internal 仅供测试 */
export function __resetForTest() {
	pendingUrl = null;
}

/** @internal 仅供测试 */
export function __peekPendingUrl() {
	return pendingUrl;
}
