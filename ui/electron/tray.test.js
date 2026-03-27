import { describe, test, vi, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';

// ---- Electron mock ----

const mockTray = {
	setToolTip: vi.fn(),
	setContextMenu: vi.fn(),
	setImage: vi.fn(),
	on: vi.fn(),
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
		createFromPath: vi.fn(() => iconByCall[createFromPathCallIdx++]),
		createEmpty: vi.fn(() => ({ __tag: 'empty' })),
	},
	ipcMain: {
		on: vi.fn((channel, handler) => {
			ipcHandlers[channel] = handler;
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

const { initTray } = await import('./tray.js');
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
