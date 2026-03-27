import {
	ipcMain, dialog, clipboard, shell, nativeImage, session,
	Notification, desktopCapturer, systemPreferences, app,
} from 'electron';
import { store } from './store.js';

/**
 * 注册所有 IPC 处理器（仅调用一次）
 * @param {() => Electron.BrowserWindow | null} getWin - 获取当前主窗口的函数
 */
export function registerIpcHandlers(getWin) {
	// ---- 对话框 ----
	ipcMain.handle('dialog:openFile', async (_, options) => {
		const win = getWin();
		return win ? dialog.showOpenDialog(win, options) : null;
	});
	ipcMain.handle('dialog:saveFile', async (_, options) => {
		const win = getWin();
		return win ? dialog.showSaveDialog(win, options) : null;
	});

	// ---- 剪贴板 ----
	ipcMain.handle('clipboard:writeText', (_, text) => {
		clipboard.writeText(text);
	});
	ipcMain.handle('clipboard:readText', () => {
		return clipboard.readText();
	});
	ipcMain.handle('clipboard:writeImage', (_, dataUrl) => {
		clipboard.writeImage(nativeImage.createFromDataURL(dataUrl));
	});
	ipcMain.handle('clipboard:readImage', () => {
		const img = clipboard.readImage();
		return img.isEmpty() ? null : img.toDataURL();
	});

	// ---- 通知 ----
	ipcMain.handle('notification:show', (_, title, body, options = {}) => {
		const notif = new Notification({ title, body, ...options });
		notif.on('click', () => {
			const win = getWin();
			if (win) { win.show(); win.focus(); }
		});
		notif.show();
	});

	// ---- 外部链接 ----
	ipcMain.handle('shell:openExternal', (_, url) => {
		return shell.openExternal(url);
	});

	// ---- 任务栏/Dock ----
	ipcMain.on('window:flashFrame', (_, flag) => {
		const win = getWin();
		if (win) win.flashFrame(flag);
	});
	ipcMain.on('app:setBadgeCount', (_, count) => {
		if (process.platform === 'darwin') {
			app.setBadgeCount(count);
		}
	});
	ipcMain.on('window:setOverlayIcon', (_, dataUrl, desc) => {
		if (process.platform === 'win32') {
			const win = getWin();
			if (win) win.setOverlayIcon(nativeImage.createFromDataURL(dataUrl), desc || '');
		}
	});
	ipcMain.on('window:clearOverlayIcon', () => {
		if (process.platform === 'win32') {
			const win = getWin();
			if (win) win.setOverlayIcon(null, '');
		}
	});
	ipcMain.on('window:requestAttention', (_, type) => {
		if (process.platform === 'darwin') {
			app.dock.bounce(type === 'critical' ? 'critical' : 'informational');
		} else {
			const win = getWin();
			if (win) win.flashFrame(true);
		}
	});

	// ---- 截图 ----
	ipcMain.handle('screenshot:getSources', async () => {
		const sources = await desktopCapturer.getSources({
			types: ['screen', 'window'],
			thumbnailSize: { width: 1920, height: 1080 },
		});
		return sources.map(s => ({
			id: s.id,
			name: s.name,
			thumbnail: s.thumbnail.toDataURL(),
		}));
	});
	ipcMain.handle('screenshot:checkPermission', () => {
		if (process.platform === 'darwin') {
			return systemPreferences.getMediaAccessStatus('screen');
		}
		return 'granted';
	});

	// ---- 下载管理 ----
	// Web 端主动触发下载（使用 Electron 原生 downloadURL）
	ipcMain.handle('download:start', (_, url) => {
		const win = getWin();
		if (win) win.webContents.downloadURL(url);
	});

	// 拦截所有下载（含 <a download> 和 downloadURL 触发的）
	session.defaultSession.on('will-download', (_event, item) => {
		item.on('updated', (_e, state) => {
			if (state === 'progressing' && !item.isPaused()) {
				const win = getWin();
				if (win) {
					win.webContents.send('download:progress', {
						url: item.getURL(),
						filename: item.getFilename(),
						percent: item.getTotalBytes() > 0
							? item.getReceivedBytes() / item.getTotalBytes()
							: 0,
						transferredBytes: item.getReceivedBytes(),
						totalBytes: item.getTotalBytes(),
					});
				}
			}
		});
		item.once('done', (_e, state) => {
			const win = getWin();
			if (win) {
				win.webContents.send('download:done', {
					url: item.getURL(),
					filename: item.getFilename(),
					savePath: item.getSavePath(),
					state, // 'completed' | 'cancelled' | 'interrupted'
				});
			}
		});
	});

	// ---- 应用信息 ----
	ipcMain.handle('app:getShellVersion', () => {
		return app.getVersion();
	});

	// ---- 设置 ----
	ipcMain.handle('store:get', (_, key) => {
		return store.get(key);
	});
	ipcMain.handle('store:set', (_, key, value) => {
		store.set(key, value);
	});
}
