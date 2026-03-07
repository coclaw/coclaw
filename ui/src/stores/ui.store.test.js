import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { useUiStore } from './ui.store.js';

describe('ui store', () => {
	beforeEach(() => {
		setActivePinia(createPinia());
	});

	describe('drawerWidth', () => {
		test('should be 30% of screenWidth when below max', () => {
			const store = useUiStore();
			store.screenWidth = 768;
			expect(store.drawerWidth).toBe(230); // round(768 * 0.3)

			store.screenWidth = 1024;
			expect(store.drawerWidth).toBe(307); // round(1024 * 0.3)
		});

		test('should cap at 384px', () => {
			const store = useUiStore();
			store.screenWidth = 1280;
			expect(store.drawerWidth).toBe(384); // round(1280 * 0.3) = 384

			store.screenWidth = 1920;
			expect(store.drawerWidth).toBe(384); // round(1920 * 0.3) = 576 -> capped
		});

		test('should handle small screen widths', () => {
			const store = useUiStore();
			store.screenWidth = 320;
			expect(store.drawerWidth).toBe(96); // round(320 * 0.3)
		});
	});

	describe('initResize / destroyResize', () => {
		test('should update screenWidth on window resize', () => {
			const store = useUiStore();
			store.initResize();

			window.innerWidth = 800;
			window.dispatchEvent(new Event('resize'));
			expect(store.screenWidth).toBe(800);

			store.destroyResize();
		});

		test('should stop updating after destroyResize', () => {
			const store = useUiStore();
			store.initResize();

			window.innerWidth = 900;
			window.dispatchEvent(new Event('resize'));
			expect(store.screenWidth).toBe(900);

			store.destroyResize();

			window.innerWidth = 1200;
			window.dispatchEvent(new Event('resize'));
			expect(store.screenWidth).toBe(900); // 不再更新
		});

		test('should not add duplicate listeners on multiple init calls', () => {
			const spy = vi.spyOn(window, 'addEventListener');
			const store = useUiStore();

			store.initResize();
			store.initResize();
			const resizeCalls = spy.mock.calls.filter((c) => c[0] === 'resize');
			expect(resizeCalls).toHaveLength(1);

			store.destroyResize();
			spy.mockRestore();
		});
	});
});
