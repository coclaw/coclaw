import { Tray, Menu, nativeImage, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Store from 'electron-store';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const store = new Store();

let tray = null;
let flashTimer = null;
let isUnread = false;

/**
 * 初始化系统托盘
 * @param {Electron.App} app
 * @param {Electron.BrowserWindow} win
 */
export function initTray(app, win) {
	const iconPath = path.join(__dirname, '../build-resources/tray-icon.png');
	const normalIcon = nativeImage.createFromPath(iconPath);

	// macOS template image（自动适配深/浅色模式）
	if (process.platform === 'darwin') {
		normalIcon.setTemplateImage(true);
	}

	tray = new Tray(normalIcon);
	tray.setToolTip('CoClaw');

	const contextMenu = Menu.buildFromTemplate([
		{
			label: '显示窗口',
			click: () => { win.show(); win.focus(); },
		},
		{ type: 'separator' },
		{
			label: '退出',
			click: () => {
				app.isQuitting = true;
				app.quit();
			},
		},
	]);
	tray.setContextMenu(contextMenu);

	// 左键单击：显示/隐藏窗口
	tray.on('click', () => {
		if (win.isVisible()) {
			win.hide();
		} else {
			win.show();
			win.focus();
		}
	});

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
		win.webContents.send('window-focus');
		// 停止任务栏闪烁
		win.flashFrame(false);
	});

	// ---- IPC：托盘状态更新 ----
	ipcMain.on('tray:setTooltip', (_, text) => {
		tray.setToolTip(text || 'CoClaw');
	});

	ipcMain.on('tray:setUnread', (_, hasUnread) => {
		if (hasUnread && !isUnread) {
			isUnread = true;
			startFlash(normalIcon);
		} else if (!hasUnread && isUnread) {
			isUnread = false;
			stopFlash(normalIcon);
		}
	});
}

function startFlash(normalIcon) {
	// TODO: 未读图标资源就绪后替换为实际的 unread icon
	// 目前用同一图标闪烁（可见/隐藏交替）
	let visible = true;
	flashTimer = setInterval(() => {
		if (visible) {
			tray.setImage(nativeImage.createEmpty());
		} else {
			const img = normalIcon;
			tray.setImage(img);
			if (process.platform === 'darwin') img.setTemplateImage(true);
		}
		visible = !visible;
	}, 500);
}

function stopFlash(normalIcon) {
	if (flashTimer) {
		clearInterval(flashTimer);
		flashTimer = null;
	}
	tray.setImage(normalIcon);
	if (process.platform === 'darwin') normalIcon.setTemplateImage(true);
}
