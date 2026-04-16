import electronUpdater from 'electron-updater';
import log from 'electron-log';
import { ipcMain } from 'electron';

const { autoUpdater } = electronUpdater;

/** 最近一次 update-available 信息；renderer 挂载前即收到时用于补发 */
let pendingUpdate = null;
let initialized = false;
let initialCheckTimer = null;
let periodicCheckInterval = null;

/**
 * 初始化自动更新（仅调用一次）
 * @param {() => Electron.BrowserWindow | null} getWin - 获取当前主窗口的函数
 */
export function initUpdater(getWin) {
	if (initialized) return;

	// portable exe 不支持自更新（electron-updater 在 quitAndInstall 时会抛错）
	if (process.env.PORTABLE_EXECUTABLE_FILE) {
		log.info('[updater] portable mode detected, autoUpdater disabled');
		registerIpcHandlers(getWin, true);
		initialized = true;
		return;
	}

	initialized = true;

	autoUpdater.logger = log;
	autoUpdater.autoDownload = false; // 让用户确认后再下载

	autoUpdater.on('update-available', (info) => {
		const payload = {
			version: info.version,
			releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
			releaseDate: info.releaseDate,
		};
		pendingUpdate = payload;
		sendToWin(getWin, 'update-available', payload);
	});

	autoUpdater.on('update-not-available', (info) => {
		sendToWin(getWin, 'update-not-available', { version: info?.version });
	});

	autoUpdater.on('download-progress', (progress) => {
		sendToWin(getWin, 'update-download-progress', {
			percent: progress.percent,
			bytesPerSecond: progress.bytesPerSecond,
			transferred: progress.transferred,
			total: progress.total,
		});
	});

	autoUpdater.on('update-downloaded', (info) => {
		sendToWin(getWin, 'update-downloaded', {
			version: info.version,
			releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
		});
	});

	autoUpdater.on('error', (err) => {
		log.error('[updater] error:', err);
		sendToWin(getWin, 'update-error', { message: err?.message || String(err) });
	});

	registerIpcHandlers(getWin, false);

	// 启动时延迟 30s 检查，避开冷启动网络竞争
	initialCheckTimer = setTimeout(() => {
		autoUpdater.checkForUpdates().catch((err) => log.warn('[updater] initial check failed:', err));
	}, 30_000);

	// 每 4 小时检查一次
	periodicCheckInterval = setInterval(() => {
		autoUpdater.checkForUpdates().catch((err) => log.warn('[updater] periodic check failed:', err));
	}, 4 * 60 * 60 * 1000);
}

/** 退出前清理定时器（生产进程退出 OS 会回收，显式清理可避免测试污染和极端场景句柄泄漏） */
export function disposeUpdater() {
	if (initialCheckTimer) {
		clearTimeout(initialCheckTimer);
		initialCheckTimer = null;
	}
	if (periodicCheckInterval) {
		clearInterval(periodicCheckInterval);
		periodicCheckInterval = null;
	}
}

function sendToWin(getWin, channel, payload) {
	const win = getWin();
	if (win && !win.isDestroyed()) {
		win.webContents.send(channel, payload);
	}
}

function registerIpcHandlers(getWin, portable) {
	ipcMain.handle('updater:getPending', () => pendingUpdate);

	ipcMain.handle('updater:checkForUpdates', async () => {
		if (portable) return { ok: false, error: 'portable-mode' };
		try {
			const res = await autoUpdater.checkForUpdates();
			return { ok: true, updateInfo: res?.updateInfo ? { version: res.updateInfo.version } : null };
		}
		catch (err) {
			log.warn('[updater] checkForUpdates (manual) failed:', err);
			return { ok: false, error: err?.message || String(err) };
		}
	});

	ipcMain.handle('updater:downloadUpdate', async () => {
		if (portable) return { ok: false, error: 'portable-mode' };
		try {
			await autoUpdater.downloadUpdate();
			return { ok: true };
		}
		catch (err) {
			log.warn('[updater] downloadUpdate failed:', err);
			return { ok: false, error: err?.message || String(err) };
		}
	});

	ipcMain.handle('updater:quitAndInstall', () => {
		if (portable) return { ok: false, error: 'portable-mode' };
		try {
			autoUpdater.quitAndInstall();
			return { ok: true };
		}
		catch (err) {
			log.warn('[updater] quitAndInstall failed:', err);
			return { ok: false, error: err?.message || String(err) };
		}
	});
}

/** @internal 仅供测试 */
export function __resetForTest() {
	initialized = false;
	pendingUpdate = null;
	if (initialCheckTimer) clearTimeout(initialCheckTimer);
	if (periodicCheckInterval) clearInterval(periodicCheckInterval);
	initialCheckTimer = null;
	periodicCheckInterval = null;
}
