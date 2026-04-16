import { app, BrowserWindow, Menu, session, shell, globalShortcut } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import windowStateKeeper from 'electron-window-state';
import { initTray, attachMainWindow, disposeTray } from './tray.js';
import { registerIpcHandlers } from './ipc-handlers.js';
import { setupPermissions } from './permissions.js';
import {
	setupSingleInstance,
	registerProtocol,
	bootstrapDeepLinkFromArgv,
	flushPendingDeepLink,
} from './deep-link.js';
import { initUpdater, disposeUpdater } from './updater.js';
import { getAppTitle, t } from './locale.js';
import { REMOTE_URL, DEV_URL, isTrustedUrl } from './url-guard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

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
			// Windows 用 .ico（多分辨率，200% DPI 下不模糊）；其余平台用 .png
			icon: path.join(
				__dirname,
				process.platform === 'win32'
					? '../build-resources/icon.ico'
					: '../build-resources/icon.png',
			),
			autoHideMenuBar: true,
			// 远程加载有 TLS + 网络耗时，延迟到 ready-to-show 再显示，规避首屏白闪
			show: false,
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

		win.once('ready-to-show', () => {
			win.show();
		});

		// 加载页面
		const url = isDev ? DEV_URL : REMOTE_URL;
		win.loadURL(url);

		// 页面加载完成后 flush 早期累积的 deep-link
		win.webContents.on('did-finish-load', () => {
			flushPendingDeepLink(win);
		});

		// 开发模式打开 DevTools
		if (isDev) {
			win.webContents.openDevTools({ mode: 'detach' });
		}

		// 阻止导航到非信任域（严格 origin 匹配）；仅开发模式才把 localhost:5173 视为信任
		win.webContents.on('will-navigate', (event, navUrl) => {
			if (!isTrustedUrl(navUrl, { allowDev: isDev })) {
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
		const win = createWindow();

		// Windows 冷启动：若 process.argv 中携带 coclaw:// URL（protocol handler 首次触发），
		// 在窗口创建后投递（pending buffer 会等 did-finish-load 再 flush）
		bootstrapDeepLinkFromArgv(process.argv);

		// 以下只注册一次，通过 getMainWindow() 获取当前窗口
		registerIpcHandlers(getMainWindow);
		initTray(app, getMainWindow);
		// 主窗口的 close→托盘、focus/blur 事件绑定（仅对主窗口生效，避免误伤后续弹窗）
		attachMainWindow(app, win);

		// 自动更新（仅生产模式）
		if (!isDev) {
			initUpdater(getMainWindow);
		}

		// 全局快捷键目前无业务消费，暂不注册；preload 的 getScreenSources 等
		// 截图相关 API 保留作为预埋，真有截图需求时再接上 globalShortcut.register
	});

	// macOS：点击 Dock 图标时，若无窗口则重建
	app.on('activate', () => {
		// 仅 macOS 才会触发 activate；其它平台 window-all-closed 后已 app.quit()
		if (process.platform !== 'darwin') return;
		if (BrowserWindow.getAllWindows().length === 0) {
			const win = createWindow();
			attachMainWindow(app, win);
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
		disposeTray();
		disposeUpdater();
	});
}
