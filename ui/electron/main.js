import { app, BrowserWindow, session, shell, globalShortcut } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import windowStateKeeper from 'electron-window-state';
import { initTray } from './tray.js';
import { registerIpcHandlers } from './ipc-handlers.js';
import { setupPermissions } from './permissions.js';
import { setupSingleInstance, registerProtocol } from './deep-link.js';
import { initUpdater } from './updater.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

const REMOTE_URL = 'https://im.coclaw.net';
const DEV_URL = 'http://localhost:5173';

// 单实例锁（Deep Link 需要）
const gotLock = setupSingleInstance(app);
if (!gotLock) {
	app.quit();
} else {
	app.whenReady().then(() => {
		// Windows 通知需要 AppUserModelId
		if (process.platform === 'win32') {
			app.setAppUserModelId('net.coclaw.im');
		}

		// 权限处理
		setupPermissions(session.defaultSession);

		// 注册 Deep Link 协议
		registerProtocol(app);

		// 窗口状态持久化
		const mainWindowState = windowStateKeeper({
			defaultWidth: 420,
			defaultHeight: 780,
		});

		const win = new BrowserWindow({
			x: mainWindowState.x,
			y: mainWindowState.y,
			width: mainWindowState.width,
			height: mainWindowState.height,
			minWidth: 360,
			minHeight: 640,
			title: 'CoClaw',
			icon: path.join(__dirname, '../build-resources/icon.png'),
			webPreferences: {
				preload: path.join(__dirname, 'preload.cjs'),
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
			},
			// macOS 标题栏
			...(process.platform === 'darwin' && {
				titleBarStyle: 'hiddenInset',
				trafficLightPosition: { x: 10, y: 10 },
			}),
		});

		mainWindowState.manage(win);

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

		// 外部链接用系统浏览器打开
		win.webContents.setWindowOpenHandler(({ url: openUrl }) => {
			shell.openExternal(openUrl);
			return { action: 'deny' };
		});

		// 注册 IPC 处理器
		registerIpcHandlers(win);

		// 系统托盘
		initTray(app, win);

		// 自动更新（仅生产模式）
		if (!isDev) {
			initUpdater(win);
		}

		// 全局快捷键：截图
		const screenshotKey = process.platform === 'darwin'
			? 'Command+Shift+A'
			: 'Ctrl+Shift+A';
		const registered = globalShortcut.register(screenshotKey, () => {
			win.webContents.send('screenshot-trigger');
		});
		if (!registered) {
			console.warn(`截图快捷键 ${screenshotKey} 注册失败，可能已被其他应用占用`);
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
