import { describe, test, expect, vi, beforeEach } from 'vitest';

const windows = vi.hoisted(() => ({ list: [] }));
vi.mock('electron', () => ({
	BrowserWindow: {
		getAllWindows: () => windows.list,
	},
}));

const {
	setupSingleInstance,
	registerProtocol,
	bootstrapDeepLinkFromArgv,
	flushPendingDeepLink,
	__resetForTest,
	__peekPendingUrl,
} = await import('./deep-link.js');

function makeWin({ loading = false, url = 'https://im.coclaw.net/', destroyed = false } = {}) {
	return {
		isDestroyed: () => destroyed,
		isMinimized: () => false,
		restore: vi.fn(),
		show: vi.fn(),
		focus: vi.fn(),
		webContents: {
			isLoading: () => loading,
			getURL: () => url,
			send: vi.fn(),
		},
	};
}

describe('setupSingleInstance', () => {
	test('gotLock=true → 返回 true 并绑定 second-instance', () => {
		const app = {
			requestSingleInstanceLock: vi.fn().mockReturnValue(true),
			on: vi.fn(),
		};
		expect(setupSingleInstance(app)).toBe(true);
		expect(app.on).toHaveBeenCalledWith('second-instance', expect.any(Function));
	});
	test('gotLock=false → 返回 false，不绑事件', () => {
		const app = {
			requestSingleInstanceLock: vi.fn().mockReturnValue(false),
			on: vi.fn(),
		};
		expect(setupSingleInstance(app)).toBe(false);
		expect(app.on).not.toHaveBeenCalled();
	});
	test('second-instance 携带 coclaw:// 且窗口已 load → webContents.send', () => {
		__resetForTest();
		const handlers = {};
		const app = {
			requestSingleInstanceLock: vi.fn().mockReturnValue(true),
			on: (evt, cb) => { handlers[evt] = cb; },
		};
		setupSingleInstance(app);
		const win = makeWin();
		windows.list = [win];
		handlers['second-instance']({}, ['electron.exe', 'coclaw://topics', '--flag']);
		expect(win.webContents.send).toHaveBeenCalledWith('deep-link', 'coclaw://topics');
		expect(win.show).toHaveBeenCalled();
		expect(win.focus).toHaveBeenCalled();
		windows.list = [];
	});
	test('second-instance 窗口最小化 → 先 restore 再 show/focus', () => {
		__resetForTest();
		const handlers = {};
		setupSingleInstance({
			requestSingleInstanceLock: vi.fn().mockReturnValue(true),
			on: (evt, cb) => { handlers[evt] = cb; },
		});
		const win = makeWin();
		win.isMinimized = () => true;
		windows.list = [win];
		handlers['second-instance']({}, ['electron.exe']);
		expect(win.restore).toHaveBeenCalled();
		windows.list = [];
	});
});

describe('registerProtocol — argv[1] 防御', () => {
	test('process.defaultApp=true 且 argv[1] 存在 → setAsDefaultProtocolClient 3 参形式', () => {
		const app = {
			setAsDefaultProtocolClient: vi.fn(),
			on: vi.fn(),
		};
		const orig = { defaultApp: process.defaultApp, argv: process.argv };
		process.defaultApp = true;
		process.argv = ['electron', '/path/to/main.js'];
		registerProtocol(app);
		expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith(
			'coclaw',
			process.execPath,
			expect.arrayContaining(['--']),
		);
		process.defaultApp = orig.defaultApp;
		process.argv = orig.argv;
	});
	test('process.defaultApp=true 且 argv[1] undefined → 不抛', () => {
		const app = {
			setAsDefaultProtocolClient: vi.fn(),
			on: vi.fn(),
		};
		const orig = { defaultApp: process.defaultApp, argv: process.argv };
		process.defaultApp = true;
		process.argv = ['electron']; // 仅 argv[0]
		expect(() => registerProtocol(app)).not.toThrow();
		expect(app.setAsDefaultProtocolClient).toHaveBeenCalled();
		process.defaultApp = orig.defaultApp;
		process.argv = orig.argv;
	});
	test('process.defaultApp=false（打包后）→ 1 参形式', () => {
		const app = {
			setAsDefaultProtocolClient: vi.fn(),
			on: vi.fn(),
		};
		const orig = process.defaultApp;
		process.defaultApp = false;
		registerProtocol(app);
		expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith('coclaw');
		process.defaultApp = orig;
	});
	test('绑定 open-url 事件（macOS）', () => {
		const app = {
			setAsDefaultProtocolClient: vi.fn(),
			on: vi.fn(),
		};
		registerProtocol(app);
		expect(app.on).toHaveBeenCalledWith('open-url', expect.any(Function));
	});
	test('open-url 回调：preventDefault + handleDeepLink', () => {
		__resetForTest();
		const handlers = {};
		registerProtocol({
			setAsDefaultProtocolClient: vi.fn(),
			on: (evt, cb) => { handlers[evt] = cb; },
		});
		const evt = { preventDefault: vi.fn() };
		const win = makeWin();
		windows.list = [win];
		handlers['open-url'](evt, 'coclaw://chat/abc');
		expect(evt.preventDefault).toHaveBeenCalled();
		expect(win.webContents.send).toHaveBeenCalledWith('deep-link', 'coclaw://chat/abc');
		windows.list = [];
	});
});

describe('bootstrapDeepLinkFromArgv', () => {
	beforeEach(() => { __resetForTest(); windows.list = []; });

	test('argv 含 coclaw:// 且窗口未 load → 缓存为 pending', () => {
		const win = makeWin({ loading: true, url: '' });
		windows.list = [win];
		bootstrapDeepLinkFromArgv(['electron.exe', 'coclaw://chat/5']);
		expect(__peekPendingUrl()).toBe('coclaw://chat/5');
		expect(win.webContents.send).not.toHaveBeenCalled();
	});
	test('argv 含 coclaw:// 且窗口已 load → 立即投递并清空 pending', () => {
		const win = makeWin({ loading: false, url: 'https://im.coclaw.net/' });
		windows.list = [win];
		bootstrapDeepLinkFromArgv(['electron.exe', 'coclaw://chat/5']);
		expect(win.webContents.send).toHaveBeenCalledWith('deep-link', 'coclaw://chat/5');
		expect(__peekPendingUrl()).toBeNull();
	});
	test('argv 无 coclaw:// → pending 不变', () => {
		bootstrapDeepLinkFromArgv(['electron.exe', '/path/to/main.js']);
		expect(__peekPendingUrl()).toBeNull();
	});
	test('非数组 argv → 不抛', () => {
		expect(() => bootstrapDeepLinkFromArgv(null)).not.toThrow();
		expect(() => bootstrapDeepLinkFromArgv(undefined)).not.toThrow();
	});
});

describe('flushPendingDeepLink', () => {
	beforeEach(() => { __resetForTest(); windows.list = []; });

	test('有 pending + win 存在 → send 并清空', () => {
		const win = makeWin({ loading: true });
		windows.list = [win];
		bootstrapDeepLinkFromArgv(['x', 'coclaw://chat/7']);
		expect(__peekPendingUrl()).toBe('coclaw://chat/7');
		flushPendingDeepLink(win);
		expect(win.webContents.send).toHaveBeenCalledWith('deep-link', 'coclaw://chat/7');
		expect(__peekPendingUrl()).toBeNull();
	});
	test('无 pending → 不 send', () => {
		const win = makeWin();
		flushPendingDeepLink(win);
		expect(win.webContents.send).not.toHaveBeenCalled();
	});
	test('win 已 destroyed → 不 send', () => {
		const win = makeWin({ destroyed: true, loading: true });
		windows.list = [];
		bootstrapDeepLinkFromArgv(['x', 'coclaw://chat/7']);
		flushPendingDeepLink(win);
		expect(win.webContents.send).not.toHaveBeenCalled();
	});
	test('null win → 不抛，不 send', () => {
		bootstrapDeepLinkFromArgv(['x', 'coclaw://chat/7']);
		expect(() => flushPendingDeepLink(null)).not.toThrow();
	});
});
