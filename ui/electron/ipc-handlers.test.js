import { describe, test, expect, vi, beforeEach } from 'vitest';

// ---- Mocks ----

const hoisted = vi.hoisted(() => {
	const invokeHandlers = {};
	const onHandlers = {};
	const sessionHandlers = {};

	const dialog = {
		showOpenDialog: vi.fn().mockResolvedValue({ canceled: false, filePaths: ['/a'] }),
		showSaveDialog: vi.fn().mockResolvedValue({ canceled: false, filePath: '/b' }),
	};

	const clipboard = {
		writeText: vi.fn(),
		readText: vi.fn().mockReturnValue('hello'),
		writeImage: vi.fn(),
		readImage: vi.fn(),
	};

	const shell = {
		openExternal: vi.fn().mockResolvedValue(undefined),
	};

	const nativeImage = {
		createFromDataURL: vi.fn((s) => ({ __img: s })),
	};

	const session = {
		defaultSession: {
			on: vi.fn((event, handler) => {
				sessionHandlers[event] = handler;
			}),
		},
	};

	const notifications = [];
	class Notification {
		constructor(opts) {
			this.opts = opts;
			this.listeners = {};
			notifications.push(this);
		}
		on(event, handler) { this.listeners[event] = handler; }
		show = vi.fn();
	}

	const desktopCapturer = {
		getSources: vi.fn().mockResolvedValue([
			{ id: 'screen:0', name: 'Screen 1', thumbnail: { toDataURL: () => 'data:img/a' } },
			{ id: 'window:1', name: 'Win 1', thumbnail: { toDataURL: () => 'data:img/b' } },
		]),
	};

	const systemPreferences = {
		getMediaAccessStatus: vi.fn().mockReturnValue('granted'),
	};

	const app = {
		getVersion: vi.fn().mockReturnValue('1.2.3'),
		setBadgeCount: vi.fn(),
		dock: { bounce: vi.fn().mockReturnValue(1) },
	};

	const ipcMain = {
		handle: vi.fn((ch, cb) => { invokeHandlers[ch] = cb; }),
		on: vi.fn((ch, cb) => { onHandlers[ch] = cb; }),
	};

	return {
		invokeHandlers, onHandlers, sessionHandlers, notifications,
		dialog, clipboard, shell, nativeImage, session, Notification,
		desktopCapturer, systemPreferences, app, ipcMain,
	};
});

vi.mock('electron', () => ({
	ipcMain: hoisted.ipcMain,
	dialog: hoisted.dialog,
	clipboard: hoisted.clipboard,
	shell: hoisted.shell,
	nativeImage: hoisted.nativeImage,
	session: hoisted.session,
	Notification: hoisted.Notification,
	desktopCapturer: hoisted.desktopCapturer,
	systemPreferences: hoisted.systemPreferences,
	app: hoisted.app,
}));

const storeData = new Map();
vi.mock('electron-store', () => ({
	default: vi.fn(() => ({
		get: (key) => storeData.get(key),
		set: (key, val) => { storeData.set(key, val); },
	})),
}));

const { registerIpcHandlers } = await import('./ipc-handlers.js');

// ---- 测试辅助 ----

let fakeWin;
function freshWin() {
	return {
		isDestroyed: () => false,
		show: vi.fn(),
		focus: vi.fn(),
		flashFrame: vi.fn(),
		setOverlayIcon: vi.fn(),
		webContents: {
			send: vi.fn(),
			downloadURL: vi.fn(),
		},
	};
}

const originalPlatform = process.platform;
function setPlatform(plat) {
	Object.defineProperty(process, 'platform', { value: plat, configurable: true });
}
function restorePlatform() {
	Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
}

let onceRegistered = false;
function registerOnce() {
	if (onceRegistered) return;
	registerIpcHandlers(() => fakeWin);
	onceRegistered = true;
}

beforeEach(() => {
	fakeWin = freshWin();
	hoisted.dialog.showOpenDialog.mockClear();
	hoisted.dialog.showSaveDialog.mockClear();
	hoisted.clipboard.writeText.mockClear();
	hoisted.clipboard.readText.mockClear();
	hoisted.clipboard.writeImage.mockClear();
	hoisted.clipboard.readImage.mockReset();
	hoisted.shell.openExternal.mockClear();
	hoisted.nativeImage.createFromDataURL.mockClear();
	hoisted.desktopCapturer.getSources.mockClear();
	hoisted.systemPreferences.getMediaAccessStatus.mockClear();
	hoisted.app.getVersion.mockClear();
	hoisted.app.setBadgeCount.mockClear();
	hoisted.app.dock.bounce.mockClear();
	hoisted.notifications.length = 0;
	storeData.clear();
	registerOnce();
});

// ---- dialog ----

describe('dialog', () => {
	test('dialog:openFile 透传到 showOpenDialog', async () => {
		const res = await hoisted.invokeHandlers['dialog:openFile']({}, { title: 'pick' });
		expect(hoisted.dialog.showOpenDialog).toHaveBeenCalledWith(fakeWin, { title: 'pick' });
		expect(res.filePaths).toEqual(['/a']);
	});

	test('dialog:openFile win=null 时返回 null', async () => {
		const prev = fakeWin;
		fakeWin = null;
		const res = await hoisted.invokeHandlers['dialog:openFile']({}, {});
		expect(res).toBeNull();
		fakeWin = prev;
	});

	test('dialog:saveFile 透传到 showSaveDialog', async () => {
		const res = await hoisted.invokeHandlers['dialog:saveFile']({}, { defaultPath: '/tmp' });
		expect(hoisted.dialog.showSaveDialog).toHaveBeenCalledWith(fakeWin, { defaultPath: '/tmp' });
		expect(res.filePath).toBe('/b');
	});
});

// ---- clipboard ----

describe('clipboard', () => {
	test('clipboard:writeText', async () => {
		await hoisted.invokeHandlers['clipboard:writeText']({}, 'hi');
		expect(hoisted.clipboard.writeText).toHaveBeenCalledWith('hi');
	});

	test('clipboard:readText 返回字符串', async () => {
		const res = await hoisted.invokeHandlers['clipboard:readText']();
		expect(res).toBe('hello');
	});

	test('clipboard:writeImage 将 dataURL 转 nativeImage', async () => {
		await hoisted.invokeHandlers['clipboard:writeImage']({}, 'data:png;base64,xxx');
		expect(hoisted.nativeImage.createFromDataURL).toHaveBeenCalledWith('data:png;base64,xxx');
		expect(hoisted.clipboard.writeImage).toHaveBeenCalledWith({ __img: 'data:png;base64,xxx' });
	});

	test('clipboard:readImage 空图返回 null', async () => {
		hoisted.clipboard.readImage.mockReturnValue({ isEmpty: () => true, toDataURL: () => '' });
		const res = await hoisted.invokeHandlers['clipboard:readImage']();
		expect(res).toBeNull();
	});

	test('clipboard:readImage 非空图返回 dataURL', async () => {
		hoisted.clipboard.readImage.mockReturnValue({ isEmpty: () => false, toDataURL: () => 'data:img' });
		const res = await hoisted.invokeHandlers['clipboard:readImage']();
		expect(res).toBe('data:img');
	});
});

// ---- notification ----

describe('notification', () => {
	test('notification:show 创建并 show', async () => {
		await hoisted.invokeHandlers['notification:show']({}, 'T', 'B', { silent: true });
		expect(hoisted.notifications.length).toBe(1);
		expect(hoisted.notifications[0].opts).toMatchObject({ title: 'T', body: 'B', silent: true });
		expect(hoisted.notifications[0].show).toHaveBeenCalled();
	});

	test('notification click 触发 win.show/focus', async () => {
		await hoisted.invokeHandlers['notification:show']({}, 'T', 'B');
		const notif = hoisted.notifications[0];
		notif.listeners.click();
		expect(fakeWin.show).toHaveBeenCalled();
		expect(fakeWin.focus).toHaveBeenCalled();
	});
});

// ---- shell ----

describe('shell', () => {
	test('shell:openExternal 透传', async () => {
		await hoisted.invokeHandlers['shell:openExternal']({}, 'https://x.com');
		expect(hoisted.shell.openExternal).toHaveBeenCalledWith('https://x.com');
	});
});

// ---- window/tray 效果 ----

describe('window/tray effects', () => {
	test('window:flashFrame 透传到 win.flashFrame', () => {
		hoisted.onHandlers['window:flashFrame']({}, true);
		expect(fakeWin.flashFrame).toHaveBeenCalledWith(true);
	});

	test('app:setBadgeCount 仅 macOS 生效', () => {
		setPlatform('darwin');
		try {
			hoisted.onHandlers['app:setBadgeCount']({}, 5);
			expect(hoisted.app.setBadgeCount).toHaveBeenCalledWith(5);
		}
		finally { restorePlatform(); }
	});

	test('app:setBadgeCount 在 Windows 下 no-op', () => {
		setPlatform('win32');
		try {
			hoisted.app.setBadgeCount.mockClear();
			hoisted.onHandlers['app:setBadgeCount']({}, 5);
			expect(hoisted.app.setBadgeCount).not.toHaveBeenCalled();
		}
		finally { restorePlatform(); }
	});

	test('window:setOverlayIcon 仅 Windows 生效', () => {
		setPlatform('win32');
		try {
			hoisted.onHandlers['window:setOverlayIcon']({}, 'data:png,x', '3');
			expect(hoisted.nativeImage.createFromDataURL).toHaveBeenCalledWith('data:png,x');
			expect(fakeWin.setOverlayIcon).toHaveBeenCalled();
		}
		finally { restorePlatform(); }
	});

	test('window:setOverlayIcon 在 macOS no-op', () => {
		setPlatform('darwin');
		try {
			fakeWin.setOverlayIcon.mockClear();
			hoisted.onHandlers['window:setOverlayIcon']({}, 'data:png,x', '3');
			expect(fakeWin.setOverlayIcon).not.toHaveBeenCalled();
		}
		finally { restorePlatform(); }
	});

	test('window:clearOverlayIcon 仅 Windows 生效', () => {
		setPlatform('win32');
		try {
			hoisted.onHandlers['window:clearOverlayIcon']();
			expect(fakeWin.setOverlayIcon).toHaveBeenCalledWith(null, '');
		}
		finally { restorePlatform(); }
	});

	test('window:requestAttention macOS → dock.bounce', () => {
		setPlatform('darwin');
		try {
			hoisted.onHandlers['window:requestAttention']({}, 'critical');
			expect(hoisted.app.dock.bounce).toHaveBeenCalledWith('critical');
		}
		finally { restorePlatform(); }
	});

	test('window:requestAttention macOS 非 critical → informational', () => {
		setPlatform('darwin');
		try {
			hoisted.onHandlers['window:requestAttention']({}, 'x');
			expect(hoisted.app.dock.bounce).toHaveBeenCalledWith('informational');
		}
		finally { restorePlatform(); }
	});

	test('window:requestAttention 非 macOS → flashFrame(true)', () => {
		setPlatform('win32');
		try {
			hoisted.onHandlers['window:requestAttention']({}, 'critical');
			expect(fakeWin.flashFrame).toHaveBeenCalledWith(true);
		}
		finally { restorePlatform(); }
	});
});

// ---- 截图 ----

describe('screenshot', () => {
	test('screenshot:getSources 返回简化 shape', async () => {
		const res = await hoisted.invokeHandlers['screenshot:getSources']();
		expect(res).toEqual([
			{ id: 'screen:0', name: 'Screen 1', thumbnail: 'data:img/a' },
			{ id: 'window:1', name: 'Win 1', thumbnail: 'data:img/b' },
		]);
		expect(hoisted.desktopCapturer.getSources).toHaveBeenCalledWith({
			types: ['screen', 'window'],
			thumbnailSize: { width: 1920, height: 1080 },
		});
	});

	test('screenshot:checkPermission macOS 调 systemPreferences', async () => {
		setPlatform('darwin');
		try {
			hoisted.systemPreferences.getMediaAccessStatus.mockReturnValue('denied');
			const res = await hoisted.invokeHandlers['screenshot:checkPermission']();
			expect(res).toBe('denied');
			expect(hoisted.systemPreferences.getMediaAccessStatus).toHaveBeenCalledWith('screen');
		}
		finally { restorePlatform(); }
	});

	test('screenshot:checkPermission 非 macOS 永远 granted', async () => {
		setPlatform('win32');
		try {
			const res = await hoisted.invokeHandlers['screenshot:checkPermission']();
			expect(res).toBe('granted');
			expect(hoisted.systemPreferences.getMediaAccessStatus).not.toHaveBeenCalled();
		}
		finally { restorePlatform(); }
	});
});

// ---- 下载 ----

describe('download', () => {
	test('download:start 调 win.webContents.downloadURL', async () => {
		await hoisted.invokeHandlers['download:start']({}, 'https://x.com/a.zip');
		expect(fakeWin.webContents.downloadURL).toHaveBeenCalledWith('https://x.com/a.zip');
	});

	test('will-download 进度事件 → download:progress channel', () => {
		const handler = hoisted.sessionHandlers['will-download'];
		expect(handler).toBeTypeOf('function');

		const itemListeners = {};
		const item = {
			on: vi.fn((event, cb) => { itemListeners[event] = cb; }),
			once: vi.fn((event, cb) => { itemListeners[event] = cb; }),
			getURL: () => 'https://x.com/a',
			getFilename: () => 'a.zip',
			getTotalBytes: () => 1000,
			getReceivedBytes: () => 500,
			isPaused: () => false,
		};
		handler({}, item);
		itemListeners.updated({}, 'progressing');

		expect(fakeWin.webContents.send).toHaveBeenCalledWith('download:progress',
			expect.objectContaining({ percent: 0.5, filename: 'a.zip' }));
	});

	test('will-download 进度事件：暂停时不发', () => {
		const handler = hoisted.sessionHandlers['will-download'];
		const itemListeners = {};
		const item = {
			on: vi.fn((e, cb) => { itemListeners[e] = cb; }),
			once: vi.fn((e, cb) => { itemListeners[e] = cb; }),
			getURL: () => 'u', getFilename: () => 'f',
			getTotalBytes: () => 100, getReceivedBytes: () => 10,
			isPaused: () => true,
		};
		handler({}, item);
		itemListeners.updated({}, 'progressing');
		expect(fakeWin.webContents.send).not.toHaveBeenCalled();
	});

	test('will-download 完成事件 → download:done channel', () => {
		const handler = hoisted.sessionHandlers['will-download'];
		const itemListeners = {};
		const item = {
			on: vi.fn((e, cb) => { itemListeners[e] = cb; }),
			once: vi.fn((e, cb) => { itemListeners[e] = cb; }),
			getURL: () => 'https://x.com/a',
			getFilename: () => 'a.zip',
			getSavePath: () => '/downloads/a.zip',
			getTotalBytes: () => 100, getReceivedBytes: () => 100,
			isPaused: () => false,
		};
		handler({}, item);
		itemListeners.done({}, 'completed');
		expect(fakeWin.webContents.send).toHaveBeenCalledWith('download:done',
			expect.objectContaining({ state: 'completed', savePath: '/downloads/a.zip' }));
	});

	test('will-download getTotalBytes=0 时 percent=0（不除零）', () => {
		const handler = hoisted.sessionHandlers['will-download'];
		const itemListeners = {};
		const item = {
			on: vi.fn((e, cb) => { itemListeners[e] = cb; }),
			once: vi.fn((e, cb) => { itemListeners[e] = cb; }),
			getURL: () => 'u', getFilename: () => 'f',
			getTotalBytes: () => 0, getReceivedBytes: () => 0,
			isPaused: () => false,
		};
		handler({}, item);
		itemListeners.updated({}, 'progressing');
		expect(fakeWin.webContents.send).toHaveBeenCalledWith('download:progress',
			expect.objectContaining({ percent: 0 }));
	});
});

// ---- app/store ----

describe('app / store', () => {
	test('app:getShellVersion 返回 app.getVersion()', async () => {
		const v = await hoisted.invokeHandlers['app:getShellVersion']();
		expect(v).toBe('1.2.3');
	});

	test('store:set + store:get 往返', async () => {
		await hoisted.invokeHandlers['store:set']({}, 'auto_update_enabled', false);
		const res = await hoisted.invokeHandlers['store:get']({}, 'auto_update_enabled');
		expect(res).toBe(false);
	});

	test('store:get 未设置的 key 返回 undefined', async () => {
		const res = await hoisted.invokeHandlers['store:get']({}, 'nonexistent');
		expect(res).toBeUndefined();
	});
});
