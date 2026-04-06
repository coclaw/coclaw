import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// mock store 依赖
vi.mock('../stores/agent-runs.store.js', () => ({
	useAgentRunsStore: vi.fn(() => ({ busy: false })),
}));
vi.mock('../stores/files.store.js', () => ({
	useFilesStore: vi.fn(() => ({ busy: false })),
}));
vi.mock('../stores/chat-store-manager.js', () => ({
	chatStoreManager: { stores: vi.fn(() => [].values()) },
}));

import { startUpdateCheck, isReloadBlocked, __reset } from './app-update.js';
import { useAgentRunsStore } from '../stores/agent-runs.store.js';
import { useFilesStore } from '../stores/files.store.js';
import { chatStoreManager } from '../stores/chat-store-manager.js';

describe('app-update', () => {
	let reloadSpy;

	beforeEach(() => {
		setActivePinia(createPinia());
		__reset();
		vi.useFakeTimers();
		vi.stubGlobal('__APP_VERSION__', '1.0.0');
		// Vitest 默认 import.meta.env.DEV=true，测试时需设为 false
		import.meta.env.DEV = false;
		reloadSpy = vi.fn();
		Object.defineProperty(window, 'location', {
			value: { reload: reloadSpy },
			writable: true,
			configurable: true,
		});
		useAgentRunsStore.mockReturnValue({ busy: false });
		useFilesStore.mockReturnValue({ busy: false });
		chatStoreManager.stores.mockReturnValue([].values());
	});

	afterEach(() => {
		__reset();
		import.meta.env.DEV = true; // 恢复 Vitest 默认值
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	// =====================================================================
	// isReloadBlocked
	// =====================================================================

	describe('isReloadBlocked', () => {
		test('全部空闲时返回 false', () => {
			expect(isReloadBlocked()).toBe(false);
		});

		test('agentRunsStore busy 时返回 true', () => {
			useAgentRunsStore.mockReturnValue({ busy: true });
			expect(isReloadBlocked()).toBe(true);
		});

		test('chatStore busy 时返回 true', () => {
			chatStoreManager.stores.mockReturnValue([{ busy: true }].values());
			expect(isReloadBlocked()).toBe(true);
		});

		test('filesStore busy 时返回 true', () => {
			useFilesStore.mockReturnValue({ busy: true });
			expect(isReloadBlocked()).toBe(true);
		});
	});

	// =====================================================================
	// startUpdateCheck + pollVersion
	// =====================================================================

	describe('startUpdateCheck', () => {
		test('dev 模式下跳过', async () => {
			import.meta.env.DEV = true;
			const fetchSpy = vi.fn();
			vi.stubGlobal('fetch', fetchSpy);

			startUpdateCheck();
			await vi.advanceTimersByTimeAsync(10 * 60_000);
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		test('幂等：多次调用只启动一次', async () => {
			const fetchSpy = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ version: '1.0.0' }),
			});
			vi.stubGlobal('fetch', fetchSpy);

			startUpdateCheck();
			startUpdateCheck();

			await vi.advanceTimersByTimeAsync(10 * 60_000);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
		});

		test('版本相同时不触发 reload，继续轮询', async () => {
			vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ version: '1.0.0' }),
			}));

			startUpdateCheck();
			await vi.advanceTimersByTimeAsync(10 * 60_000);

			expect(reloadSpy).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBeGreaterThan(0);
		});

		test('检测到新版本且空闲时立即 reload', async () => {
			vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ version: '2.0.0' }),
			}));

			startUpdateCheck();
			await vi.advanceTimersByTimeAsync(10 * 60_000);

			expect(reloadSpy).toHaveBeenCalled();
		});

		test('检测到新版本但忙碌时延迟 reload', async () => {
			useAgentRunsStore.mockReturnValue({ busy: true });
			vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ version: '2.0.0' }),
			}));

			startUpdateCheck();
			await vi.advanceTimersByTimeAsync(10 * 60_000);

			expect(reloadSpy).not.toHaveBeenCalled();

			// 变为空闲后，兜底轮询触发 reload
			useAgentRunsStore.mockReturnValue({ busy: false });
			vi.advanceTimersByTime(10_000);
			expect(reloadSpy).toHaveBeenCalled();
		});

		test('res.ok 为 false 时继续轮询', async () => {
			vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

			startUpdateCheck();
			await vi.advanceTimersByTimeAsync(10 * 60_000);

			expect(reloadSpy).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBeGreaterThan(0);
		});

		test('fetch 失败时静默继续轮询', async () => {
			vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));

			startUpdateCheck();
			await vi.advanceTimersByTimeAsync(10 * 60_000);

			expect(reloadSpy).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBeGreaterThan(0);
		});

		test('app:foreground 事件触发 reload 检查', async () => {
			useAgentRunsStore.mockReturnValue({ busy: true });
			vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ version: '2.0.0' }),
			}));

			startUpdateCheck();
			await vi.advanceTimersByTimeAsync(10 * 60_000);

			expect(reloadSpy).not.toHaveBeenCalled();

			// 变空闲，app:foreground 触发
			useAgentRunsStore.mockReturnValue({ busy: false });
			window.dispatchEvent(new Event('app:foreground'));
			expect(reloadSpy).toHaveBeenCalled();
		});
	});
});
