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

	describe('detectPlatformLabel', () => {
		let origUA;

		beforeEach(() => {
			origUA = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
		});

		afterEach(() => {
			vi.unstubAllGlobals();
			if (origUA) Object.defineProperty(navigator, 'userAgent', origUA);
		});

		test('Capacitor android → cap-android', async () => {
			vi.stubGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => 'android' });
			const { detectPlatformLabel } = await import('./platform.js');
			expect(detectPlatformLabel()).toBe('cap-android');
		});

		test('Capacitor ios → cap-ios', async () => {
			vi.stubGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => 'ios' });
			const { detectPlatformLabel } = await import('./platform.js');
			expect(detectPlatformLabel()).toBe('cap-ios');
		});

		test('Capacitor 原生但 platform 为空 → cap-unknown', async () => {
			vi.stubGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => '' });
			const { detectPlatformLabel } = await import('./platform.js');
			expect(detectPlatformLabel()).toBe('cap-unknown');
		});

		test('Capacitor 原生但无 getPlatform → cap-unknown', async () => {
			vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
			const { detectPlatformLabel } = await import('./platform.js');
			expect(detectPlatformLabel()).toBe('cap-unknown');
		});

		test('Capacitor 其他平台（如 web 模拟）→ cap-<其他>', async () => {
			vi.stubGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => 'electron' });
			const { detectPlatformLabel } = await import('./platform.js');
			expect(detectPlatformLabel()).toBe('cap-electron');
		});

		test('Electron Windows → electron-win', async () => {
			vi.stubGlobal('electronAPI', {});
			Object.defineProperty(navigator, 'userAgent', {
				value: 'Mozilla/5.0 (Windows NT 10.0)', configurable: true,
			});
			const { detectPlatformLabel } = await import('./platform.js');
			expect(detectPlatformLabel()).toBe('electron-win');
		});

		test('Electron Mac → electron-mac', async () => {
			vi.stubGlobal('electronAPI', {});
			Object.defineProperty(navigator, 'userAgent', {
				value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', configurable: true,
			});
			const { detectPlatformLabel } = await import('./platform.js');
			expect(detectPlatformLabel()).toBe('electron-mac');
		});

		test('Electron Linux → electron-linux', async () => {
			vi.stubGlobal('electronAPI', {});
			Object.defineProperty(navigator, 'userAgent', {
				value: 'Mozilla/5.0 (X11; Linux x86_64)', configurable: true,
			});
			const { detectPlatformLabel } = await import('./platform.js');
			expect(detectPlatformLabel()).toBe('electron-linux');
		});

		test('Electron 但 UA 不识别 → electron', async () => {
			vi.stubGlobal('electronAPI', {});
			Object.defineProperty(navigator, 'userAgent', {
				value: 'Unknown/OS', configurable: true,
			});
			const { detectPlatformLabel } = await import('./platform.js');
			expect(detectPlatformLabel()).toBe('electron');
		});

		test('Capacitor 全局存在但 isNativePlatform() 返回 false（web 模式注入 Capacitor）→ web', async () => {
			vi.stubGlobal('Capacitor', { isNativePlatform: () => false, getPlatform: () => 'web' });
			const { detectPlatformLabel } = await import('./platform.js');
			expect(detectPlatformLabel()).toBe('web');
		});

		test('普通浏览器 → web', async () => {
			const { detectPlatformLabel } = await import('./platform.js');
			expect(detectPlatformLabel()).toBe('web');
		});
	});
});
