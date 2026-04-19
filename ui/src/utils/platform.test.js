import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

describe('platform', () => {
	describe('默认 jsdom 环境', () => {
		test('所有平台常量应为预期默认值', async () => {
			const mod = await import('./platform.js');
			expect(mod.isElectronApp).toBe(false);
			expect(mod.isTauriApp).toBe(false);
			expect(mod.isCapacitorApp).toBe(false);
			expect(mod.isNativeShell).toBe(false);
			expect(mod.isDesktop).toBe(true);
		});

		test('getPlatformType 返回 web', async () => {
			const { getPlatformType } = await import('./platform.js');
			expect(getPlatformType()).toBe('web');
		});
	});

	describe('模拟各平台环境', () => {
		beforeEach(() => {
			vi.resetModules();
		});

		afterEach(() => {
			vi.unstubAllGlobals();
		});

		test('Electron 环境', async () => {
			vi.stubGlobal('electronAPI', { send: vi.fn() });
			const mod = await import('./platform.js');
			expect(mod.isElectronApp).toBe(true);
			expect(mod.isNativeShell).toBe(true);
			expect(mod.isDesktop).toBe(true);
			expect(mod.getPlatformType()).toBe('electron');
		});

		test('Capacitor 环境', async () => {
			vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
			const mod = await import('./platform.js');
			expect(mod.isCapacitorApp).toBe(true);
			expect(mod.isNativeShell).toBe(true);
			// Capacitor 是移动端，isDesktop 应为 false
			expect(mod.isDesktop).toBe(false);
			expect(mod.getPlatformType()).toBe('capacitor');
		});

		test('Tauri 环境', async () => {
			vi.stubGlobal('__TAURI_INTERNALS__', {});
			const mod = await import('./platform.js');
			expect(mod.isTauriApp).toBe(true);
			expect(mod.isNativeShell).toBe(true);
			expect(mod.isDesktop).toBe(true);
			expect(mod.getPlatformType()).toBe('tauri');
		});
	});

	describe('isMobileOs', () => {
		let origUA;
		let origUAData;
		let origPlatform;
		let origMaxTouch;

		beforeEach(() => {
			vi.resetModules();
			origUA = navigator.userAgent;
			origUAData = navigator.userAgentData;
			origPlatform = navigator.platform;
			origMaxTouch = navigator.maxTouchPoints;
		});

		afterEach(() => {
			vi.unstubAllGlobals();
			Object.defineProperty(navigator, 'userAgent', { value: origUA, configurable: true });
			Object.defineProperty(navigator, 'userAgentData', { value: origUAData, configurable: true });
			Object.defineProperty(navigator, 'platform', { value: origPlatform, configurable: true });
			Object.defineProperty(navigator, 'maxTouchPoints', { value: origMaxTouch, configurable: true });
		});

		test('Capacitor 原生壳 → true', async () => {
			vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
			const mod = await import('./platform.js');
			expect(mod.isMobileOs).toBe(true);
		});

		test('Electron 壳 → false', async () => {
			vi.stubGlobal('electronAPI', { send: vi.fn() });
			const mod = await import('./platform.js');
			expect(mod.isMobileOs).toBe(false);
		});

		test('Tauri 壳 → false', async () => {
			vi.stubGlobal('__TAURI_INTERNALS__', {});
			const mod = await import('./platform.js');
			expect(mod.isMobileOs).toBe(false);
		});

		test('浏览器 UA-CH mobile=true → true', async () => {
			Object.defineProperty(navigator, 'userAgentData', {
				value: { mobile: true, platform: 'Android' }, configurable: true,
			});
			const mod = await import('./platform.js');
			expect(mod.isMobileOs).toBe(true);
		});

		test('浏览器 UA-CH platform=iOS → true', async () => {
			Object.defineProperty(navigator, 'userAgentData', {
				value: { platform: 'iOS', mobile: false }, configurable: true,
			});
			const mod = await import('./platform.js');
			expect(mod.isMobileOs).toBe(true);
		});

		test('浏览器 UA-CH platform=Windows → false', async () => {
			Object.defineProperty(navigator, 'userAgentData', {
				value: { platform: 'Windows', mobile: false }, configurable: true,
			});
			const mod = await import('./platform.js');
			expect(mod.isMobileOs).toBe(false);
		});

		test('UA 回退 Android → true', async () => {
			Object.defineProperty(navigator, 'userAgentData', { value: undefined, configurable: true });
			Object.defineProperty(navigator, 'userAgent', {
				value: 'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36',
				configurable: true,
			});
			const mod = await import('./platform.js');
			expect(mod.isMobileOs).toBe(true);
		});

		test('UA 回退 iPhone → true', async () => {
			Object.defineProperty(navigator, 'userAgentData', { value: undefined, configurable: true });
			Object.defineProperty(navigator, 'userAgent', {
				value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
				configurable: true,
			});
			const mod = await import('./platform.js');
			expect(mod.isMobileOs).toBe(true);
		});

		test('iPadOS 桌面模式伪装成 Mac（MacIntel + maxTouchPoints > 1）→ true', async () => {
			Object.defineProperty(navigator, 'userAgentData', { value: undefined, configurable: true });
			Object.defineProperty(navigator, 'userAgent', {
				value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit',
				configurable: true,
			});
			Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
			Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true });
			const mod = await import('./platform.js');
			expect(mod.isMobileOs).toBe(true);
		});

		test('桌面 Windows UA → false', async () => {
			Object.defineProperty(navigator, 'userAgentData', { value: undefined, configurable: true });
			Object.defineProperty(navigator, 'userAgent', {
				value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit',
				configurable: true,
			});
			const mod = await import('./platform.js');
			expect(mod.isMobileOs).toBe(false);
		});
	});
});
