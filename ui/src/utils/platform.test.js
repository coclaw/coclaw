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
});
