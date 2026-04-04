import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const platformMock = vi.hoisted(() => ({
	isCapacitorApp: false,
	isElectronApp: false,
	isTauriApp: false,
}));

vi.mock('./platform.js', () => platformMock);

const browserOpenMock = vi.fn();
vi.mock('@capacitor/browser', () => ({ Browser: { open: browserOpenMock } }));

const URL = 'https://example.com/deploy';

describe('openExternalUrl', () => {
	let windowOpenSpy;
	let tauriShellOpenMock;

	let electronOpenExternalMock;

	beforeEach(() => {
		platformMock.isCapacitorApp = false;
		platformMock.isElectronApp = false;
		platformMock.isTauriApp = false;
		browserOpenMock.mockReset();
		windowOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

		// 模拟 Electron 全局对象
		electronOpenExternalMock = vi.fn();
		window.electronAPI = { openExternal: electronOpenExternalMock };

		// 模拟 Tauri 全局对象
		tauriShellOpenMock = vi.fn();
		window.__TAURI__ = { shell: { open: tauriShellOpenMock } };
	});

	afterEach(() => {
		windowOpenSpy.mockRestore();
		delete window.electronAPI;
		delete window.__TAURI__;
	});

	test('Capacitor 环境使用 In-App Browser', async () => {
		platformMock.isCapacitorApp = true;
		const { openExternalUrl } = await import('./external-url.js');

		await openExternalUrl(URL);

		expect(browserOpenMock).toHaveBeenCalledOnce();
		expect(browserOpenMock).toHaveBeenCalledWith({ url: URL });
		expect(windowOpenSpy).not.toHaveBeenCalled();
	});

	test('Electron 环境使用 electronAPI.openExternal', async () => {
		platformMock.isElectronApp = true;
		const { openExternalUrl } = await import('./external-url.js');

		await openExternalUrl(URL);

		expect(electronOpenExternalMock).toHaveBeenCalledOnce();
		expect(electronOpenExternalMock).toHaveBeenCalledWith(URL);
		expect(windowOpenSpy).not.toHaveBeenCalled();
		expect(browserOpenMock).not.toHaveBeenCalled();
	});

	test('Tauri 环境使用 shell.open', async () => {
		platformMock.isTauriApp = true;
		const { openExternalUrl } = await import('./external-url.js');

		await openExternalUrl(URL);

		expect(tauriShellOpenMock).toHaveBeenCalledOnce();
		expect(tauriShellOpenMock).toHaveBeenCalledWith(URL);
		expect(windowOpenSpy).not.toHaveBeenCalled();
	});

	test('Web 环境使用 window.open', async () => {
		const { openExternalUrl } = await import('./external-url.js');

		await openExternalUrl(URL);

		expect(windowOpenSpy).toHaveBeenCalledOnce();
		expect(windowOpenSpy).toHaveBeenCalledWith(URL, '_blank', 'noopener,noreferrer');
		expect(browserOpenMock).not.toHaveBeenCalled();
	});

	test('原生 API 异常时 fallback 到 window.open', async () => {
		platformMock.isCapacitorApp = true;
		browserOpenMock.mockRejectedValue(new Error('plugin unavailable'));
		const { openExternalUrl } = await import('./external-url.js');

		await openExternalUrl(URL);

		expect(browserOpenMock).toHaveBeenCalledOnce();
		expect(windowOpenSpy).toHaveBeenCalledOnce();
		expect(windowOpenSpy).toHaveBeenCalledWith(URL, '_blank', 'noopener,noreferrer');
	});
});
