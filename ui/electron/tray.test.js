import { describe, test, vi, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';

// ---- Electron mock ----

const mockTray = {
	setToolTip: vi.fn(),
	setContextMenu: vi.fn(),
	setImage: vi.fn(),
	on: vi.fn(),
	destroy: vi.fn(),
	isDestroyed: vi.fn(() => false),
};

const ipcHandlers = {};

const fakeNormalIcon = { __tag: 'normal', setTemplateImage: vi.fn() };
const fakeUnreadIcon = { __tag: 'unread', setTemplateImage: vi.fn() };

let createFromPathCallIdx = 0;
const iconByCall = [fakeNormalIcon, fakeUnreadIcon];

vi.mock('electron', () => ({
	Tray: vi.fn(() => mockTray),
	Menu: { buildFromTemplate: vi.fn(() => ({})) },
	nativeImage: {
		// 超出 iconByCall 预置项时兜底返回带 setTemplateImage 的 stub，
		// 否则 disposeTray 用例二次 initTray（idx 未重置）会拿到 undefined，
		// macOS 的 darwin 分支 cachedNormalIcon.setTemplateImage 即崩
		createFromPath: vi.fn(() => iconByCall[createFromPathCallIdx++] ?? { __tag: 'extra', setTemplateImage: vi.fn() }),
		createEmpty: vi.fn(() => ({ __tag: 'empty' })),
	},
	ipcMain: {
		on: vi.fn((channel, handler) => {
			ipcHandlers[channel] = handler;
		}),
		removeAllListeners: vi.fn((channel) => {
			delete ipcHandlers[channel];
		}),
	},
}));

vi.mock('electron-store', () => ({
	default: vi.fn(() => ({ get: () => true })),
}));

vi.mock('./locale.js', () => ({
	getAppTitle: () => 'CoClaw',
	t: (zh, en) => en,
}));

const { initTray, attachMainWindow, disposeTray, installQuitGuard } = await import('./tray.js');
const { nativeImage } = await import('electron');

describe('tray flash', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		createFromPathCallIdx = 0;
		const fakeApp = { on: vi.fn() };
		const fakeWin = {
			on: vi.fn(),
			isVisible: () => true,
			webContents: { send: vi.fn() },
		};
		initTray(fakeApp, () => fakeWin);
	});

	afterEach(() => {
		// 停止闪烁清理 timer
		if (ipcHandlers['tray:setUnread']) {
			ipcHandlers['tray:setUnread'](null, false);
		}
		vi.useRealTimers();
	});

	test('startFlash 不使用 nativeImage.createEmpty()', () => {
		nativeImage.createEmpty.mockClear();
		mockTray.setImage.mockClear();

		ipcHandlers['tray:setUnread'](null, true);
		vi.advanceTimersByTime(1100);

		assert.equal(nativeImage.createEmpty.mock.calls.length, 0,
			'startFlash should not call nativeImage.createEmpty()');
		assert.ok(mockTray.setImage.mock.calls.length >= 2,
			'startFlash should call setImage multiple times');
	});

	test('startFlash 在 normalIcon 和 unreadIcon 之间切换', () => {
		mockTray.setImage.mockClear();

		ipcHandlers['tray:setUnread'](null, true);
		vi.advanceTimersByTime(1100);

		const tags = mockTray.setImage.mock.calls
			.map(c => c[0]?.__tag)
			.filter(Boolean);

		assert.ok(tags.includes('unread'), 'should flash unread icon');
		assert.ok(tags.includes('normal'), 'should flash normal icon');
		assert.ok(!tags.includes('empty'), 'should never use empty icon');
	});
});

describe('attachMainWindow', () => {
	let fakeApp;
	let fakeWin;
	let winHandlers;

	beforeEach(() => {
		fakeApp = { isQuitting: false };
		winHandlers = {};
		fakeWin = {
			isDestroyed: () => false,
			on: vi.fn((event, handler) => {
				winHandlers[event] = handler;
			}),
			webContents: { send: vi.fn() },
			flashFrame: vi.fn(),
			hide: vi.fn(),
		};
	});

	test('绑定 close/focus/blur/hide 四个事件', () => {
		attachMainWindow(fakeApp, fakeWin);
		assert.ok(winHandlers.close, 'should bind close');
		assert.ok(winHandlers.focus, 'should bind focus');
		assert.ok(winHandlers.blur, 'should bind blur');
		assert.ok(winHandlers.hide, 'should bind hide');
	});

	test('close 事件：minimize_to_tray=true 时 preventDefault 并 hide', () => {
		attachMainWindow(fakeApp, fakeWin);
		const event = { preventDefault: vi.fn() };
		winHandlers.close(event);
		assert.equal(event.preventDefault.mock.calls.length, 1);
		assert.equal(fakeWin.hide.mock.calls.length, 1);
	});

	test('close 事件：app.isQuitting=true 时不拦截', () => {
		fakeApp.isQuitting = true;
		attachMainWindow(fakeApp, fakeWin);
		const event = { preventDefault: vi.fn() };
		winHandlers.close(event);
		assert.equal(event.preventDefault.mock.calls.length, 0);
		assert.equal(fakeWin.hide.mock.calls.length, 0);
	});

	test('blur 事件：发送 window-blur 到 renderer', () => {
		attachMainWindow(fakeApp, fakeWin);
		winHandlers.blur();
		assert.deepEqual(fakeWin.webContents.send.mock.calls[0], ['window-blur']);
	});

	test('hide 事件：同样发送 window-blur（与 blur 对齐 Capacitor app:background）', () => {
		attachMainWindow(fakeApp, fakeWin);
		winHandlers.hide();
		assert.deepEqual(fakeWin.webContents.send.mock.calls[0], ['window-blur']);
	});

	test('win=null 或 已 destroyed 时静默返回', () => {
		attachMainWindow(fakeApp, null);
		attachMainWindow(fakeApp, { isDestroyed: () => true, on: vi.fn() });
		// 无异常即通过
	});
});

describe('installQuitGuard', () => {
	function makeApp() {
		const handlers = {};
		return {
			handlers,
			app: { isQuitting: false, on: vi.fn((e, h) => { handlers[e] = h; }) },
		};
	}

	test('注册 before-quit 处理器', () => {
		const { app, handlers } = makeApp();
		installQuitGuard(app);
		assert.ok(handlers['before-quit'], 'should register before-quit handler');
	});

	test('before-quit 置 isQuitting=true（覆盖 Cmd+Q/SIGTERM/更新器等所有退出入口）', () => {
		const { app, handlers } = makeApp();
		installQuitGuard(app);
		handlers['before-quit']();
		assert.equal(app.isQuitting, true);
	});

	test('与 close 拦截联动：before-quit 后 close 放行（不再收进托盘，退出可达）', () => {
		const { app, handlers } = makeApp();
		installQuitGuard(app);

		const winHandlers = {};
		const fakeWin = {
			isDestroyed: () => false,
			on: vi.fn((event, handler) => { winHandlers[event] = handler; }),
			webContents: { send: vi.fn() },
			flashFrame: vi.fn(),
			hide: vi.fn(),
		};
		attachMainWindow(app, fakeWin);

		// 退出意图到达前：close 被拦截收进托盘（minimize_to_tray 行为不受影响）
		const evBefore = { preventDefault: vi.fn() };
		winHandlers.close(evBefore);
		assert.equal(evBefore.preventDefault.mock.calls.length, 1);
		assert.equal(fakeWin.hide.mock.calls.length, 1);

		// 任意退出意图触发 before-quit 后：close 放行，quit 流程不再被取消
		handlers['before-quit']();
		const evAfter = { preventDefault: vi.fn() };
		winHandlers.close(evAfter);
		assert.equal(evAfter.preventDefault.mock.calls.length, 0);
		assert.equal(fakeWin.hide.mock.calls.length, 1, 'hide should not be called again');
	});
});

describe('disposeTray', () => {
	test('清 flashTimer + destroy tray + 移除 tray:* 监听', async () => {
		const fakeApp = { on: vi.fn() };
		const fakeWin = { on: vi.fn(), isVisible: () => true, webContents: { send: vi.fn() } };
		vi.useFakeTimers();
		try {
			initTray(fakeApp, () => fakeWin);
			ipcHandlers['tray:setUnread'](null, true); // 启动闪烁
			mockTray.destroy.mockClear();

			const { ipcMain } = await import('electron');
			ipcMain.removeAllListeners.mockClear();
			disposeTray();

			assert.equal(mockTray.destroy.mock.calls.length, 1);
			// 两个 channel 都被清理即可，顺序不重要（避免实现细节耦合）
			const channels = ipcMain.removeAllListeners.mock.calls.map(c => c[0]).sort();
			assert.deepEqual(channels, ['tray:setTooltip', 'tray:setUnread']);
		}
		finally {
			vi.useRealTimers();
		}
	});

	test('tray:setTooltip 在 tray 已销毁时静默返回', () => {
		const fakeApp = { on: vi.fn() };
		const fakeWin = { on: vi.fn(), isVisible: () => true, webContents: { send: vi.fn() } };
		initTray(fakeApp, () => fakeWin);
		mockTray.setToolTip.mockClear();
		mockTray.isDestroyed.mockReturnValueOnce(true);
		ipcHandlers['tray:setTooltip'](null, 'x');
		assert.equal(mockTray.setToolTip.mock.calls.length, 0);
	});
});
