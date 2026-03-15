import electronUpdater from 'electron-updater';
import log from 'electron-log';

const { autoUpdater } = electronUpdater;

/**
 * 初始化自动更新
 * @param {Electron.BrowserWindow} win
 */
export function initUpdater(win) {
	autoUpdater.logger = log;
	autoUpdater.autoDownload = false; // 让用户确认后再下载

	autoUpdater.on('update-available', (info) => {
		win.webContents.send('update-available', {
			version: info.version,
			releaseNotes: info.releaseNotes,
		});
	});

	autoUpdater.on('error', (err) => {
		log.error('Auto-updater error:', err);
	});

	// 启动时检查一次
	autoUpdater.checkForUpdates().catch(() => {});

	// 每 4 小时检查一次
	setInterval(() => {
		autoUpdater.checkForUpdates().catch(() => {});
	}, 4 * 60 * 60 * 1000);
}
