import { BrowserWindow } from 'electron';
import path from 'node:path';

const PROTOCOL = 'coclaw';

/**
 * 单实例锁 + Deep Link 接收（Windows/Linux）
 * @param {Electron.App} app
 * @returns {boolean} 是否获得锁
 */
export function setupSingleInstance(app) {
	const gotLock = app.requestSingleInstanceLock();
	if (!gotLock) return false;

	app.on('second-instance', (_event, commandLine) => {
		const url = commandLine.find(arg => arg.startsWith(`${PROTOCOL}://`));
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
		// 开发模式：需要传入 argv[1]（脚本路径）
		app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
			path.resolve(process.argv[1]),
		]);
	} else {
		app.setAsDefaultProtocolClient(PROTOCOL);
	}

	// macOS：通过 open-url 事件接收
	app.on('open-url', (event, url) => {
		event.preventDefault();
		handleDeepLink(url);
	});
}

function handleDeepLink(url) {
	const win = BrowserWindow.getAllWindows()[0];
	if (win) {
		win.webContents.send('deep-link', url);
	}
}
