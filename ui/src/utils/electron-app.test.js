import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * electron-app.js 测试
 *
 * 关键：isElectronApp 是 platform.js 顶层 `!!window.electronAPI`，首次 import 时求值。
 * 本测试通过 vi.mock 替换 platform.js 控制 isElectronApp，以便验证初始化流程。
 */

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
			onDeepLink: vi.fn((cb) => { listeners.deepLink = cb; }),
			onWindowFocus: vi.fn((cb) => { listeners.focus = cb; }),
			onWindowBlur: vi.fn((cb) => { listeners.blur = cb; }),
			onUpdateAvailable: vi.fn((cb) => { listeners.updateAvailable = cb; }),
			onUpdateDownloadProgress: vi.fn((cb) => { listeners.downloadProgress = cb; }),
			onUpdateDownloaded: vi.fn((cb) => { listeners.downloaded = cb; }),
			onUpdateNotAvailable: vi.fn((cb) => { listeners.notAvailable = cb; }),
			onUpdateError: vi.fn((cb) => { listeners.updateError = cb; }),
			getPendingUpdate: vi.fn().mockResolvedValue(null),
			onScreenshotTrigger: vi.fn((cb) => { listeners.screenshot = cb; }),
			onDownloadProgress: vi.fn((cb) => { listeners.dlProgress = cb; }),
			onDownloadDone: vi.fn((cb) => { listeners.dlDone = cb; }),
		};
		window.electronAPI = api;
		vi.doMock('./platform.js', () => ({ isElectronApp: true }));
	});

	afterEach(() => {
		delete window.electronAPI;
	});

	test('订阅全部 12 个事件通道', async () => {
		const { initElectronApp } = await import('./electron-app.js');
		initElectronApp(router);
		expect(api.onDeepLink).toHaveBeenCalledTimes(1);
		expect(api.onWindowFocus).toHaveBeenCalledTimes(1);
		expect(api.onWindowBlur).toHaveBeenCalledTimes(1);
		expect(api.onUpdateAvailable).toHaveBeenCalledTimes(1);
		expect(api.onUpdateDownloadProgress).toHaveBeenCalledTimes(1);
		expect(api.onUpdateDownloaded).toHaveBeenCalledTimes(1);
		expect(api.onUpdateNotAvailable).toHaveBeenCalledTimes(1);
		expect(api.onUpdateError).toHaveBeenCalledTimes(1);
		expect(api.getPendingUpdate).toHaveBeenCalledTimes(1);
		expect(api.onScreenshotTrigger).toHaveBeenCalledTimes(1);
		expect(api.onDownloadProgress).toHaveBeenCalledTimes(1);
		expect(api.onDownloadDone).toHaveBeenCalledTimes(1);
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

	test('window-focus → 派发 app:foreground', async () => {
		const { initElectronApp } = await import('./electron-app.js');
		initElectronApp(router);
		const fn = vi.fn();
		window.addEventListener('app:foreground', fn);
		listeners.focus();
		expect(fn).toHaveBeenCalledTimes(1);
		window.removeEventListener('app:foreground', fn);
	});

	test('window-blur → 派发 app:background', async () => {
		const { initElectronApp } = await import('./electron-app.js');
		initElectronApp(router);
		const fn = vi.fn();
		window.addEventListener('app:background', fn);
		listeners.blur();
		expect(fn).toHaveBeenCalledTimes(1);
		window.removeEventListener('app:background', fn);
	});

	test('onUpdateAvailable → 派发 electron:update-available', async () => {
		const { initElectronApp } = await import('./electron-app.js');
		initElectronApp(router);
		const fn = vi.fn();
		window.addEventListener('electron:update-available', fn);
		listeners.updateAvailable({ version: '1.2.3' });
		expect(fn).toHaveBeenCalledTimes(1);
		expect(fn.mock.calls[0][0].detail).toEqual({ version: '1.2.3' });
		window.removeEventListener('electron:update-available', fn);
	});

	test('onUpdateDownloadProgress / Downloaded / NotAvailable / Error 各自派发对应事件', async () => {
		const { initElectronApp } = await import('./electron-app.js');
		initElectronApp(router);
		const names = [
			'electron:update-download-progress',
			'electron:update-downloaded',
			'electron:update-not-available',
			'electron:update-error',
		];
		const fns = names.map(() => vi.fn());
		names.forEach((n, i) => window.addEventListener(n, fns[i]));
		listeners.downloadProgress({ percent: 50 });
		listeners.downloaded({ version: '1.2.3' });
		listeners.notAvailable({ version: '1.0.0' });
		listeners.updateError({ message: 'boom' });
		fns.forEach((fn) => expect(fn).toHaveBeenCalledTimes(1));
		names.forEach((n, i) => window.removeEventListener(n, fns[i]));
	});

	test('getPendingUpdate 返回非 null → 派发 electron:update-available', async () => {
		api.getPendingUpdate.mockResolvedValueOnce({ version: '9.9.9' });
		const { initElectronApp } = await import('./electron-app.js');
		const fn = vi.fn();
		window.addEventListener('electron:update-available', fn);
		initElectronApp(router);
		await Promise.resolve();
		await Promise.resolve();
		expect(fn).toHaveBeenCalledTimes(1);
		expect(fn.mock.calls[0][0].detail).toEqual({ version: '9.9.9' });
		window.removeEventListener('electron:update-available', fn);
	});

	test('getPendingUpdate 返回 null → 不派发', async () => {
		const { initElectronApp } = await import('./electron-app.js');
		const fn = vi.fn();
		window.addEventListener('electron:update-available', fn);
		initElectronApp(router);
		await Promise.resolve();
		await Promise.resolve();
		expect(fn).not.toHaveBeenCalled();
		window.removeEventListener('electron:update-available', fn);
	});

	test('getPendingUpdate 拒绝 → catch warn 且不抛', async () => {
		api.getPendingUpdate.mockRejectedValueOnce(new Error('rpc-failed'));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { initElectronApp } = await import('./electron-app.js');
		initElectronApp(router);
		await Promise.resolve();
		await Promise.resolve();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	test('onScreenshotTrigger → 派发 electron:screenshot-trigger', async () => {
		const { initElectronApp } = await import('./electron-app.js');
		initElectronApp(router);
		const fn = vi.fn();
		window.addEventListener('electron:screenshot-trigger', fn);
		listeners.screenshot();
		expect(fn).toHaveBeenCalledTimes(1);
		window.removeEventListener('electron:screenshot-trigger', fn);
	});

	test('onDownloadProgress / onDownloadDone 派发对应 CustomEvent', async () => {
		const { initElectronApp } = await import('./electron-app.js');
		initElectronApp(router);
		const progFn = vi.fn();
		const doneFn = vi.fn();
		window.addEventListener('electron:download-progress', progFn);
		window.addEventListener('electron:download-done', doneFn);
		listeners.dlProgress({ percent: 0.5 });
		listeners.dlDone({ state: 'completed' });
		expect(progFn).toHaveBeenCalledTimes(1);
		expect(doneFn).toHaveBeenCalledTimes(1);
		window.removeEventListener('electron:download-progress', progFn);
		window.removeEventListener('electron:download-done', doneFn);
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
