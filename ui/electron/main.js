import { app, BrowserWindow, Menu, session, shell, globalShortcut } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import windowStateKeeper from 'electron-window-state';
import { initTray } from './tray.js';
import { registerIpcHandlers } from './ipc-handlers.js';
import { setupPermissions } from './permissions.js';
import { setupSingleInstance, registerProtocol } from './deep-link.js';
import { initUpdater } from './updater.js';
import { getAppTitle, t } from './locale.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

const REMOTE_URL = 'https://im.coclaw.net';
const DEV_URL = 'http://localhost:5173';

/** 当前主窗口引用，供各模块通过 getMainWindow() 获取 */
let mainWin = null;

/** 获取当前主窗口（可能为 null） */
export function getMainWindow() {
	return mainWin;
}

// 单实例锁（Deep Link 需要）
const gotLock = setupSingleInstance(app);
if (!gotLock) {
	app.quit();
} else {
	/**
	 * 创建主窗口（首次启动 + macOS activate 复用）
	 * 仅创建 BrowserWindow 和绑定窗口级事件，不注册全局 IPC/tray/updater
	 */
	function createWindow() {
		const mainWindowState = windowStateKeeper({
			defaultWidth: 420,
			defaultHeight: 780,
		});

		const appTitle = getAppTitle();
		const win = new BrowserWindow({
			x: mainWindowState.x,
			y: mainWindowState.y,
			width: mainWindowState.width,
			height: mainWindowState.height,
			minWidth: 360,
			minHeight: 640,
			title: appTitle,
			icon: path.join(__dirname, '../build-resources/icon.png'),
			autoHideMenuBar: true,
			webPreferences: {
				preload: path.join(__dirname, 'preload.cjs'),
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				// 禁止后台节流，确保 WebSocket 心跳和定时器在窗口不可见时仍按正常精度运行
				backgroundThrottling: false,
			},
			// macOS 标题栏
			...(process.platform === 'darwin' && {
				titleBarStyle: 'hiddenInset',
				trafficLightPosition: { x: 10, y: 10 },
			}),
		});

		mainWindowState.manage(win);
		mainWin = win;

		// 加载页面
		const url = isDev ? DEV_URL : REMOTE_URL;
		win.loadURL(url);

		// 开发模式打开 DevTools
		if (isDev) {
			win.webContents.openDevTools({ mode: 'detach' });
		}

		// 阻止导航到非信任域
		win.webContents.on('will-navigate', (event, navUrl) => {
			const allowed = navUrl.startsWith(REMOTE_URL) || navUrl.startsWith(DEV_URL);
			if (!allowed) {
				event.preventDefault();
			}
		});

		// 外部链接用系统浏览器打开（仅放行 http/https）
		win.webContents.setWindowOpenHandler(({ url: openUrl }) => {
			try {
				const { protocol } = new URL(openUrl);
				if (protocol === 'http:' || protocol === 'https:') {
					shell.openExternal(openUrl);
				}
			} catch { /* 忽略无效 URL */ }
			return { action: 'deny' };
		});

		// 窗口销毁时清理引用
		win.on('closed', () => {
			mainWin = null;
		});

		return win;
	}

	app.whenReady().then(() => {
		// Windows 通知需要 AppUserModelId
		if (process.platform === 'win32') {
			app.setAppUserModelId('net.coclaw.im');
		}

		// macOS：完整菜单栏（App + Edit + View + Window）
		if (process.platform === 'darwin') {
			Menu.setApplicationMenu(Menu.buildFromTemplate([
				{
					label: app.name,
					submenu: [
						{ role: 'about' },
						{ type: 'separator' },
						{ role: 'hide' },
						{ role: 'hideOthers' },
						{ role: 'unhide' },
						{ type: 'separator' },
						{ role: 'quit' },
					],
				},
				{
					label: 'Edit',
					submenu: [
						{ role: 'undo' },
						{ role: 'redo' },
						{ type: 'separator' },
						{ role: 'cut' },
						{ role: 'copy' },
						{ role: 'paste' },
						{ role: 'pasteAndMatchStyle' },
						{ role: 'delete' },
						{ role: 'selectAll' },
					],
				},
				{
					label: 'View',
					submenu: [
						{ role: 'reload' },
						{ role: 'forceReload' },
						{ role: 'toggleDevTools' },
						{ type: 'separator' },
						{ role: 'resetZoom' },
						{ role: 'zoomIn' },
						{ role: 'zoomOut' },
						{ type: 'separator' },
						{ role: 'togglefullscreen' },
					],
				},
				{
					label: 'Window',
					submenu: [
						{ role: 'minimize' },
						{ role: 'zoom' },
						{ type: 'separator' },
						{ role: 'front' },
					],
				},
			]));

			// macOS Dock 右键菜单
			app.dock.setMenu(Menu.buildFromTemplate([
				{
					label: t('显示窗口', 'Show Window'),
					click: () => {
						const win = getMainWindow();
						if (win) {
							win.show();
							win.focus();
						} else {
							createWindow();
						}
					},
				},
			]));
		} else {
			Menu.setApplicationMenu(null);
		}

		// 权限处理
		setupPermissions(session.defaultSession);

		// 注册 Deep Link 协议
		registerProtocol(app);

		// 创建主窗口
		createWindow();

		// 以下只注册一次，通过 getMainWindow() 获取当前窗口
		registerIpcHandlers(getMainWindow);
		initTray(app, getMainWindow);

		// 自动更新（仅生产模式）
		if (!isDev) {
			initUpdater(getMainWindow);
		}

		// 全局快捷键：截图
		const screenshotKey = process.platform === 'darwin'
			? 'Command+Shift+A'
			: 'Ctrl+Shift+A';
		const registered = globalShortcut.register(screenshotKey, () => {
			const win = getMainWindow();
			if (win) win.webContents.send('screenshot-trigger');
		});
		if (!registered) {
			console.warn(`截图快捷键 ${screenshotKey} 注册失败，可能已被其他应用占用`);
		}
	});

	// macOS：点击 Dock 图标时，若无窗口则重建
	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		} else {
			const win = BrowserWindow.getAllWindows()[0];
			win.show();
			win.focus();
		}
	});

	app.on('window-all-closed', () => {
		// macOS 下关闭所有窗口不退出（有托盘）
		if (process.platform !== 'darwin') {
			app.quit();
		}
	});

	app.on('will-quit', () => {
		globalShortcut.unregisterAll();
	});
}
