import { Tray, Menu, nativeImage, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Store from 'electron-store';
import { getAppTitle, t } from './locale.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const store = new Store();

let tray = null;
let flashTimer = null;
let isUnread = false;
let cachedNormalIcon = null;
let cachedUnreadIcon = null;

/**
 * 初始化系统托盘（仅调用一次，不含窗口绑定，窗口绑定走 attachMainWindow）
 * @param {Electron.App} app
 * @param {() => Electron.BrowserWindow | null} getWin - 获取当前主窗口的函数
 */
export function initTray(app, getWin) {
	const iconPath = path.join(__dirname, '../build-resources/tray-icon.png');
	const unreadIconPath = path.join(__dirname, '../build-resources/tray-icon-unread.png');
	cachedNormalIcon = nativeImage.createFromPath(iconPath);
	cachedUnreadIcon = nativeImage.createFromPath(unreadIconPath);

	// macOS template image（自动适配深/浅色模式）
	if (process.platform === 'darwin') {
		cachedNormalIcon.setTemplateImage(true);
		// unreadIcon 不设置 template，保留红点彩色
	}

	tray = new Tray(cachedNormalIcon);
	tray.setToolTip(getAppTitle());

	const contextMenu = Menu.buildFromTemplate([
		{
			label: t('显示窗口', 'Show Window'),
			click: () => {
				const win = getWin();
				if (win) { win.show(); win.focus(); }
			},
		},
		{ type: 'separator' },
		{
			label: t('退出', 'Quit'),
			click: () => {
				app.isQuitting = true;
				app.quit();
			},
		},
	]);
	tray.setContextMenu(contextMenu);

	// 左键单击：显示/隐藏窗口
	tray.on('click', () => {
		const win = getWin();
		if (!win) return;
		if (win.isVisible()) {
			win.hide();
		} else {
			win.show();
			win.focus();
		}
	});

	// ---- IPC：托盘状态更新 ----
	ipcMain.on('tray:setTooltip', (_, text) => {
		// 中文系统兜底 "可虾"，英文系统兜底 "CoClaw"
		tray.setToolTip(text || getAppTitle());
	});

	ipcMain.on('tray:setUnread', (_, hasUnread) => {
		if (hasUnread && !isUnread) {
			isUnread = true;
			startFlash();
		} else if (!hasUnread && isUnread) {
			isUnread = false;
			stopFlash();
		}
	});
}

/**
 * 绑定主窗口的 close→托盘、focus/blur→Web 事件（仅主窗口，后续弹窗不会被拦截 close）
 * @param {Electron.App} app
 * @param {Electron.BrowserWindow} win - 主窗口
 */
export function attachMainWindow(app, win) {
	if (!win || win.isDestroyed()) return;

	// 关闭窗口 → 根据设置隐藏到托盘或退出
	win.on('close', (event) => {
		if (app.isQuitting) return;
		const minimizeToTray = store.get('minimize_to_tray', true);
		if (minimizeToTray) {
			event.preventDefault();
			win.hide();
		}
	});

	// 窗口获焦时通知 Web 端
	win.on('focus', () => {
		if (!win.isDestroyed()) {
			win.webContents.send('window-focus');
			win.flashFrame(false);
		}
	});

	// 窗口失焦/隐藏时通知 Web 端，对应 Capacitor 的 app:background
	win.on('blur', () => {
		if (!win.isDestroyed()) win.webContents.send('window-blur');
	});
	win.on('hide', () => {
		if (!win.isDestroyed()) win.webContents.send('window-blur');
	});
}

/** 退出前清理：停闪动、destroy 托盘 */
export function disposeTray() {
	if (flashTimer) {
		clearInterval(flashTimer);
		flashTimer = null;
	}
	if (tray && !tray.isDestroyed()) {
		tray.destroy();
	}
	tray = null;
	isUnread = false;
	cachedNormalIcon = null;
	cachedUnreadIcon = null;
}

function startFlash() {
	let showUnread = true;
	flashTimer = setInterval(() => {
		if (!tray || tray.isDestroyed()) return;
		tray.setImage(showUnread ? cachedUnreadIcon : cachedNormalIcon);
		showUnread = !showUnread;
	}, 500);
}

function stopFlash() {
	if (flashTimer) {
		clearInterval(flashTimer);
		flashTimer = null;
	}
	if (tray && !tray.isDestroyed()) {
		tray.setImage(cachedNormalIcon);
		if (process.platform === 'darwin') cachedNormalIcon.setTemplateImage(true);
	}
}

/** @internal 仅供测试 */
export function __resetForTest() {
	if (flashTimer) clearInterval(flashTimer);
	flashTimer = null;
	tray = null;
	isUnread = false;
	cachedNormalIcon = null;
	cachedUnreadIcon = null;
}
