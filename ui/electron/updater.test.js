import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const autoUpdaterMock = vi.hoisted(() => {
	const handlers = {};
	return {
		handlers,
		on: vi.fn((event, cb) => { handlers[event] = cb; }),
		checkForUpdates: vi.fn().mockResolvedValue({ updateInfo: { version: '1.2.3' } }),
		downloadUpdate: vi.fn().mockResolvedValue(),
		quitAndInstall: vi.fn(),
		autoDownload: true,
		logger: null,
	};
});

vi.mock('electron-updater', () => ({
	default: { autoUpdater: autoUpdaterMock },
}));

vi.mock('electron-log', () => ({
	default: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

const ipcHandlers = vi.hoisted(() => ({}));
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn((ch, cb) => { ipcHandlers[ch] = cb; }),
	},
}));

const { initUpdater, disposeUpdater, __resetForTest } = await import('./updater.js');

function resetMocks() {
	__resetForTest();
	autoUpdaterMock.on.mockClear();
	autoUpdaterMock.checkForUpdates.mockClear();
	autoUpdaterMock.downloadUpdate.mockClear();
	autoUpdaterMock.quitAndInstall.mockClear();
	Object.keys(autoUpdaterMock.handlers).forEach((k) => delete autoUpdaterMock.handlers[k]);
	Object.keys(ipcHandlers).forEach((k) => delete ipcHandlers[k]);
}

describe('initUpdater — portable 模式', () => {
	beforeEach(() => {
		resetMocks();
		process.env.PORTABLE_EXECUTABLE_FILE = '/portable.exe';
	});
	afterEach(() => {
		delete process.env.PORTABLE_EXECUTABLE_FILE;
	});

	test('不订阅 autoUpdater 事件', () => {
		initUpdater(() => null);
		expect(autoUpdaterMock.on).not.toHaveBeenCalled();
	});
	test('仍注册 4 个 IPC handler', () => {
		initUpdater(() => null);
		expect(ipcHandlers['updater:getPending']).toBeTypeOf('function');
		expect(ipcHandlers['updater:checkForUpdates']).toBeTypeOf('function');
		expect(ipcHandlers['updater:downloadUpdate']).toBeTypeOf('function');
		expect(ipcHandlers['updater:quitAndInstall']).toBeTypeOf('function');
	});
	test('downloadUpdate → { ok: false, error: "portable-mode" }', async () => {
		initUpdater(() => null);
		const res = await ipcHandlers['updater:downloadUpdate']();
		expect(res).toEqual({ ok: false, error: 'portable-mode' });
		expect(autoUpdaterMock.downloadUpdate).not.toHaveBeenCalled();
	});
	test('quitAndInstall → portable-mode', async () => {
		initUpdater(() => null);
		const res = await ipcHandlers['updater:quitAndInstall']();
		expect(res).toEqual({ ok: false, error: 'portable-mode' });
	});
	test('checkForUpdates → portable-mode，不走网络', async () => {
		initUpdater(() => null);
		const res = await ipcHandlers['updater:checkForUpdates']();
		expect(res).toEqual({ ok: false, error: 'portable-mode' });
		expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
	});
	test('getPending → null', async () => {
		initUpdater(() => null);
		const res = await ipcHandlers['updater:getPending']();
		expect(res).toBeNull();
	});
});

describe('initUpdater — 正常模式', () => {
	let getWin;
	let win;

	beforeEach(() => {
		resetMocks();
		delete process.env.PORTABLE_EXECUTABLE_FILE;
		vi.useFakeTimers();
		win = {
			isDestroyed: () => false,
			webContents: { send: vi.fn() },
		};
		getWin = () => win;
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test('订阅 5 个 autoUpdater 事件', () => {
		initUpdater(getWin);
		const events = autoUpdaterMock.on.mock.calls.map((c) => c[0]);
		expect(events).toEqual(expect.arrayContaining([
			'update-available',
			'update-not-available',
			'download-progress',
			'update-downloaded',
			'error',
		]));
	});

	test('autoDownload 被设为 false（让用户确认）', () => {
		autoUpdaterMock.autoDownload = true;
		initUpdater(getWin);
		expect(autoUpdaterMock.autoDownload).toBe(false);
	});

	test('update-available 事件 → send 到 renderer + 缓存 pending', async () => {
		initUpdater(getWin);
		autoUpdaterMock.handlers['update-available']({
			version: '1.2.3',
			releaseNotes: 'notes',
			releaseDate: '2026-04-01',
		});
		expect(win.webContents.send).toHaveBeenCalledWith(
			'update-available',
			expect.objectContaining({ version: '1.2.3', releaseNotes: 'notes' }),
		);
		const pending = await ipcHandlers['updater:getPending']();
		expect(pending).toMatchObject({ version: '1.2.3' });
	});

	test('releaseNotes 非字符串 → 归一化为空字符串', async () => {
		initUpdater(getWin);
		autoUpdaterMock.handlers['update-available']({
			version: '1.2.3',
			releaseNotes: [{ note: 'x' }],
		});
		const pending = await ipcHandlers['updater:getPending']();
		expect(pending.releaseNotes).toBe('');
	});

	test('download-progress 事件 → update-download-progress channel', () => {
		initUpdater(getWin);
		autoUpdaterMock.handlers['download-progress']({
			percent: 50,
			bytesPerSecond: 100,
			transferred: 1000,
			total: 2000,
		});
		expect(win.webContents.send).toHaveBeenCalledWith(
			'update-download-progress',
			expect.objectContaining({ percent: 50, total: 2000 }),
		);
	});

	test('update-downloaded 事件 → update-downloaded channel', () => {
		initUpdater(getWin);
		autoUpdaterMock.handlers['update-downloaded']({ version: '1.2.3' });
		expect(win.webContents.send).toHaveBeenCalledWith(
			'update-downloaded',
			expect.objectContaining({ version: '1.2.3' }),
		);
	});

	test('update-not-available 事件 → update-not-available channel', () => {
		initUpdater(getWin);
		autoUpdaterMock.handlers['update-not-available']({ version: '1.0.0' });
		expect(win.webContents.send).toHaveBeenCalledWith(
			'update-not-available',
			expect.objectContaining({ version: '1.0.0' }),
		);
	});

	test('error 事件 → update-error channel', () => {
		initUpdater(getWin);
		autoUpdaterMock.handlers['error'](new Error('boom'));
		expect(win.webContents.send).toHaveBeenCalledWith(
			'update-error',
			expect.objectContaining({ message: 'boom' }),
		);
	});

	test('getWin 返回 null 时不抛', () => {
		initUpdater(() => null);
		expect(() => autoUpdaterMock.handlers['update-available']({ version: '1' })).not.toThrow();
	});

	test('win.isDestroyed() → 跳过 send', () => {
		win.isDestroyed = () => true;
		initUpdater(getWin);
		autoUpdaterMock.handlers['update-available']({ version: '1' });
		expect(win.webContents.send).not.toHaveBeenCalled();
	});

	test('downloadUpdate 成功 → { ok: true }', async () => {
		initUpdater(getWin);
		const res = await ipcHandlers['updater:downloadUpdate']();
		expect(res).toEqual({ ok: true });
		expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalled();
	});

	test('downloadUpdate 抛错 → { ok: false, error }', async () => {
		autoUpdaterMock.downloadUpdate.mockRejectedValueOnce(new Error('net-down'));
		initUpdater(getWin);
		const res = await ipcHandlers['updater:downloadUpdate']();
		expect(res.ok).toBe(false);
		expect(res.error).toContain('net-down');
	});

	test('quitAndInstall 成功 → { ok: true }', async () => {
		initUpdater(getWin);
		const res = await ipcHandlers['updater:quitAndInstall']();
		expect(res).toEqual({ ok: true });
		expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalled();
	});

	test('quitAndInstall 抛错 → { ok: false }', async () => {
		autoUpdaterMock.quitAndInstall.mockImplementationOnce(() => { throw new Error('busy'); });
		initUpdater(getWin);
		const res = await ipcHandlers['updater:quitAndInstall']();
		expect(res.ok).toBe(false);
	});

	test('checkForUpdates 成功 → { ok: true, updateInfo }', async () => {
		initUpdater(getWin);
		const res = await ipcHandlers['updater:checkForUpdates']();
		expect(res.ok).toBe(true);
		expect(res.updateInfo).toMatchObject({ version: '1.2.3' });
	});

	test('checkForUpdates 返回空 updateInfo → null', async () => {
		autoUpdaterMock.checkForUpdates.mockResolvedValueOnce(null);
		initUpdater(getWin);
		const res = await ipcHandlers['updater:checkForUpdates']();
		expect(res.ok).toBe(true);
		expect(res.updateInfo).toBeNull();
	});

	test('checkForUpdates 抛错 → { ok: false }', async () => {
		autoUpdaterMock.checkForUpdates.mockRejectedValueOnce(new Error('offline'));
		initUpdater(getWin);
		const res = await ipcHandlers['updater:checkForUpdates']();
		expect(res.ok).toBe(false);
		expect(res.error).toContain('offline');
	});

	test('初始化后 30s 触发首次 checkForUpdates', async () => {
		initUpdater(getWin);
		expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
		vi.advanceTimersByTime(30_000);
		expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
	});

	test('setInterval 每 4 小时再触发', async () => {
		initUpdater(getWin);
		vi.advanceTimersByTime(30_000);
		vi.advanceTimersByTime(4 * 60 * 60 * 1000);
		expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2);
	});

	test('多次 initUpdater 只初始化一次', () => {
		initUpdater(getWin);
		const first = autoUpdaterMock.on.mock.calls.length;
		initUpdater(getWin);
		expect(autoUpdaterMock.on.mock.calls.length).toBe(first);
	});

	test('disposeUpdater 后首次检查 timer 不再触发', () => {
		initUpdater(getWin);
		disposeUpdater();
		vi.advanceTimersByTime(30_000);
		expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
	});

	test('disposeUpdater 后 4h 周期性检查 timer 不再触发', () => {
		initUpdater(getWin);
		// 先走完 30s 初检
		vi.advanceTimersByTime(30_000);
		expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
		disposeUpdater();
		vi.advanceTimersByTime(4 * 60 * 60 * 1000);
		expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
	});

	test('未 initUpdater 直接 dispose 不抛', () => {
		expect(() => disposeUpdater()).not.toThrow();
	});
});
