import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * electron-app.js 测试
 *
 * 关键：isElectronApp 是 platform.js 顶层 `!!window.electronAPI`，首次 import 时求值。
 * 本测试通过 vi.mock 替换 platform.js 控制 isElectronApp，以便验证初始化流程。
 *
 * 桥接已精简到 3 个订阅（deep-link / window-focus / window-blur），
 * update-* / download-* / screenshot-trigger 在 review 后撤掉（无业务消费）。
 */

vi.mock('../services/remote-log.js', () => ({
	remoteLog: vi.fn(),
}));

// --- 非 Electron 环境 ---
describe('initElectronApp — 非 Electron 环境', () => {
	beforeEach(() => vi.resetModules());

	test('isElectronApp=false 直接返回，不触碰 window.electronAPI', async () => {
		vi.doMock('./platform.js', () => ({ isElectronApp: false }));
		const api = { onDeepLink: vi.fn() };
		window.electronAPI = api;
		const { initElectronApp } = await import('./electron-app.js');
		initElectronApp({ push: vi.fn() });
		expect(api.onDeepLink).not.toHaveBeenCalled();
		delete window.electronAPI;
	});
});

// --- Electron 环境 ---
describe('initElectronApp — Electron 环境', () => {
	let listeners;
	let router;
	let api;

	beforeEach(async () => {
		vi.resetModules();
		listeners = {};
		router = { push: vi.fn() };
		api = {
			onDeepLink: vi.fn((cb) => { listeners.deepLink = cb; return () => {}; }),
			onWindowFocus: vi.fn((cb) => { listeners.focus = cb; return () => {}; }),
			onWindowBlur: vi.fn((cb) => { listeners.blur = cb; return () => {}; }),
		};
		window.electronAPI = api;
		vi.doMock('./platform.js', () => ({ isElectronApp: true }));
	});

	afterEach(() => {
		delete window.electronAPI;
	});

	test('订阅 3 个事件通道（deep-link / focus / blur）', async () => {
		const { initElectronApp } = await import('./electron-app.js');
		initElectronApp(router);
		expect(api.onDeepLink).toHaveBeenCalledTimes(1);
		expect(api.onWindowFocus).toHaveBeenCalledTimes(1);
		expect(api.onWindowBlur).toHaveBeenCalledTimes(1);
	});

	test('deep-link 有效 URL → router.push 对应路径', async () => {
		const { initElectronApp } = await import('./electron-app.js');
		initElectronApp(router);
		listeners.deepLink('coclaw://chat/123');
		expect(router.push).toHaveBeenCalledWith('/chat/123');
	});

	test('deep-link 根路径 → 不 push', async () => {
		const { initElectronApp } = await import('./electron-app.js');
		initElectronApp(router);
		listeners.deepLink('coclaw://');
		expect(router.push).not.toHaveBeenCalled();
	});

	test('deep-link 无效 URL → warn 且不 push', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { initElectronApp } = await import('./electron-app.js');
		initElectronApp(router);
		listeners.deepLink('not a valid url');
		expect(router.push).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	test('window-focus → 派发 app:foreground 且 remoteLog', async () => {
		const { initElectronApp } = await import('./electron-app.js');
		const { remoteLog } = await import('../services/remote-log.js');
		initElectronApp(router);
		const fn = vi.fn();
		window.addEventListener('app:foreground', fn);
		listeners.focus();
		expect(fn).toHaveBeenCalledTimes(1);
		expect(remoteLog).toHaveBeenCalledWith(expect.stringContaining('active=true'));
		window.removeEventListener('app:foreground', fn);
	});

	test('window-blur → 派发 app:background 且 remoteLog', async () => {
		const { initElectronApp } = await import('./electron-app.js');
		const { remoteLog } = await import('../services/remote-log.js');
		initElectronApp(router);
		const fn = vi.fn();
		window.addEventListener('app:background', fn);
		listeners.blur();
		expect(fn).toHaveBeenCalledTimes(1);
		expect(remoteLog).toHaveBeenCalledWith(expect.stringContaining('active=false'));
		window.removeEventListener('app:background', fn);
	});
});

describe('disposeElectronApp & 重复 init', () => {
	let router;
	let api;
	let unsubCalls;

	beforeEach(() => {
		vi.resetModules();
		unsubCalls = [];
		router = { push: vi.fn() };
		const makeSub = (tag) => vi.fn(() => {
			const unsub = vi.fn(() => { unsubCalls.push(tag); });
			return unsub;
		});
		api = {
			onDeepLink: makeSub('deepLink'),
			onWindowFocus: makeSub('focus'),
			onWindowBlur: makeSub('blur'),
		};
		window.electronAPI = api;
		vi.doMock('./platform.js', () => ({ isElectronApp: true }));
	});

	afterEach(() => {
		delete window.electronAPI;
	});

	test('disposeElectronApp 调用每个 unsubscribe 一次', async () => {
		const { initElectronApp, disposeElectronApp } = await import('./electron-app.js');
		initElectronApp(router);
		expect(unsubCalls).toHaveLength(0);

		disposeElectronApp();
		expect(unsubCalls).toHaveLength(3);
	});

	test('重复 initElectronApp 先清旧订阅再建新的', async () => {
		const { initElectronApp } = await import('./electron-app.js');
		initElectronApp(router);
		expect(unsubCalls).toHaveLength(0);

		initElectronApp(router);
		expect(unsubCalls).toHaveLength(3);
	});

	test('某个 unsub 抛错不影响其它 unsub', async () => {
		api.onDeepLink = vi.fn(() => {
			return () => { throw new Error('boom'); };
		});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { initElectronApp, disposeElectronApp } = await import('./electron-app.js');
		initElectronApp(router);

		expect(() => disposeElectronApp()).not.toThrow();
		expect(warn).toHaveBeenCalled();
		// 其它 2 个 unsub 正常执行
		expect(unsubCalls).toHaveLength(2);

		warn.mockRestore();
	});

	test('不返回函数的 onXxx 兼容（preload 旧版本回归时不崩）', async () => {
		// 模拟旧 preload：onXxx 不返回 unsub
		api.onDeepLink = vi.fn();
		const { initElectronApp, disposeElectronApp } = await import('./electron-app.js');
		initElectronApp(router);
		// 仅其它 2 个订阅的 unsub 会被记录；onDeepLink 无 unsub，被 track 过滤
		disposeElectronApp();
		expect(unsubCalls).toHaveLength(2);
	});

	test('非 Electron 环境 disposeElectronApp no-op 不抛', async () => {
		vi.doMock('./platform.js', () => ({ isElectronApp: false }));
		const { disposeElectronApp } = await import('./electron-app.js');
		expect(() => disposeElectronApp()).not.toThrow();
	});
});

describe('parseDeepLinkToRoute', () => {
	test('coclaw://chat/123 → /chat/123', async () => {
		vi.resetModules();
		vi.doMock('./platform.js', () => ({ isElectronApp: false }));
		const { parseDeepLinkToRoute } = await import('./electron-app.js');
		expect(parseDeepLinkToRoute('coclaw://chat/123')).toBe('/chat/123');
	});

	test('coclaw://topics → /topics', async () => {
		vi.resetModules();
		vi.doMock('./platform.js', () => ({ isElectronApp: false }));
		const { parseDeepLinkToRoute } = await import('./electron-app.js');
		expect(parseDeepLinkToRoute('coclaw://topics')).toBe('/topics');
	});

	test('coclaw:// → null（无路径）', async () => {
		vi.resetModules();
		vi.doMock('./platform.js', () => ({ isElectronApp: false }));
		const { parseDeepLinkToRoute } = await import('./electron-app.js');
		expect(parseDeepLinkToRoute('coclaw://')).toBeNull();
	});

	test('无效 URL → null', async () => {
		vi.resetModules();
		vi.doMock('./platform.js', () => ({ isElectronApp: false }));
		const { parseDeepLinkToRoute } = await import('./electron-app.js');
		expect(parseDeepLinkToRoute('this is not a url')).toBeNull();
	});
});
