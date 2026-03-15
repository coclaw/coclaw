import {
	ipcMain, dialog, clipboard, shell, nativeImage,
	Notification, desktopCapturer, systemPreferences, app,
} from 'electron';
import Store from 'electron-store';

const store = new Store();

/**
 * 注册所有 IPC 处理器
 * @param {Electron.BrowserWindow} win
 */
export function registerIpcHandlers(win) {
	// ---- 对话框 ----
	ipcMain.handle('dialog:openFile', async (_, options) => {
		return dialog.showOpenDialog(win, options);
	});
	ipcMain.handle('dialog:saveFile', async (_, options) => {
		return dialog.showSaveDialog(win, options);
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
			win.show();
			win.focus();
		});
		notif.show();
	});

	// ---- 外部链接 ----
	ipcMain.handle('shell:openExternal', (_, url) => {
		return shell.openExternal(url);
	});

	// ---- 任务栏/Dock ----
	ipcMain.on('window:flashFrame', (_, flag) => {
		win.flashFrame(flag);
	});
	ipcMain.on('app:setBadgeCount', (_, count) => {
		if (process.platform === 'darwin') {
			app.setBadgeCount(count);
		}
	});
	ipcMain.on('window:setOverlayIcon', (_, dataUrl, desc) => {
		if (process.platform === 'win32') {
			win.setOverlayIcon(nativeImage.createFromDataURL(dataUrl), desc || '');
		}
	});
	ipcMain.on('window:clearOverlayIcon', () => {
		if (process.platform === 'win32') {
			win.setOverlayIcon(null, '');
		}
	});
	ipcMain.on('window:requestAttention', (_, type) => {
		if (process.platform === 'darwin') {
			app.dock.bounce(type === 'critical' ? 'critical' : 'informational');
		} else {
			win.flashFrame(true);
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

	// ---- 设置 ----
	ipcMain.handle('store:get', (_, key) => {
		return store.get(key);
	});
	ipcMain.handle('store:set', (_, key, value) => {
		store.set(key, value);
	});
}
