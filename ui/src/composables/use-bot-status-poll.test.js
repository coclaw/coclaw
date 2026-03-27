import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('vue', () => ({
	onBeforeUnmount: vi.fn(),
}));

import { onBeforeUnmount } from 'vue';
import { useBotStatusPoll } from './use-bot-status-poll.js';

describe('useBotStatusPoll', () => {
	let store;
	let addListenerSpy;
	let removeListenerSpy;

	beforeEach(() => {
		vi.useFakeTimers();
		store = { loadBots: vi.fn().mockResolvedValue([]) };
		addListenerSpy = vi.spyOn(document, 'addEventListener');
		removeListenerSpy = vi.spyOn(document, 'removeEventListener');
		vi.mocked(onBeforeUnmount).mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	test('should register visibilitychange listener on init', () => {
		useBotStatusPoll(store);
		expect(addListenerSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
	});

	test('should register onBeforeUnmount cleanup', () => {
		useBotStatusPoll(store);
		expect(onBeforeUnmount).toHaveBeenCalledWith(expect.any(Function));
	});

	test('should call loadBots after 30s interval', async () => {
		useBotStatusPoll(store);
		expect(store.loadBots).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(30_000);
		expect(store.loadBots).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(30_000);
		expect(store.loadBots).toHaveBeenCalledTimes(2);
	});

	test('should pause polling when page becomes hidden', async () => {
		useBotStatusPoll(store);

		// 触发 hidden
		vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
		document.dispatchEvent(new Event('visibilitychange'));

		await vi.advanceTimersByTimeAsync(60_000);
		expect(store.loadBots).not.toHaveBeenCalled();
	});

	test('should resume and immediately refresh when page becomes visible', async () => {
		useBotStatusPoll(store);

		// 先隐藏
		const visSpy = vi.spyOn(document, 'visibilityState', 'get');
		visSpy.mockReturnValue('hidden');
		document.dispatchEvent(new Event('visibilitychange'));

		// 再可见
		visSpy.mockReturnValue('visible');
		document.dispatchEvent(new Event('visibilitychange'));

		// resume 会立即调用 loadBots
		await vi.advanceTimersByTimeAsync(0);
		expect(store.loadBots).toHaveBeenCalledTimes(1);

		// 恢复后定时器继续工作
		await vi.advanceTimersByTimeAsync(30_000);
		expect(store.loadBots).toHaveBeenCalledTimes(2);
	});

	test('stop() should clear timer and remove listener', async () => {
		const { stop } = useBotStatusPoll(store);
		stop();

		expect(removeListenerSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));

		await vi.advanceTimersByTimeAsync(60_000);
		expect(store.loadBots).not.toHaveBeenCalled();
	});

	test('should silently ignore loadBots errors during polling', async () => {
		store.loadBots.mockRejectedValue(new Error('network error'));

		useBotStatusPoll(store);
		// 不应抛出
		await vi.advanceTimersByTimeAsync(30_000);
		expect(store.loadBots).toHaveBeenCalledTimes(1);

		// 定时器应继续
		await vi.advanceTimersByTimeAsync(30_000);
		expect(store.loadBots).toHaveBeenCalledTimes(2);
	});

	test('should not poll after stop even if visibility changes', async () => {
		const { stop } = useBotStatusPoll(store);
		stop();

		// 模拟可见性变化
		vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
		document.dispatchEvent(new Event('visibilitychange'));

		await vi.advanceTimersByTimeAsync(60_000);
		expect(store.loadBots).not.toHaveBeenCalled();
	});

	test('should skip polling when sseConnected is true', async () => {
		const sseConnected = { value: true };
		useBotStatusPoll(store, { sseConnected });

		await vi.advanceTimersByTimeAsync(30_000);
		expect(store.loadBots).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(30_000);
		expect(store.loadBots).not.toHaveBeenCalled();
	});

	test('should resume polling when sseConnected becomes false', async () => {
		const sseConnected = { value: true };
		useBotStatusPoll(store, { sseConnected });

		await vi.advanceTimersByTimeAsync(30_000);
		expect(store.loadBots).not.toHaveBeenCalled();

		sseConnected.value = false;
		await vi.advanceTimersByTimeAsync(30_000);
		expect(store.loadBots).toHaveBeenCalledTimes(1);
	});

	test('should skip resume loadBots when sseConnected is true and page becomes visible', async () => {
		const sseConnected = { value: true };
		useBotStatusPoll(store, { sseConnected });

		vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
		document.dispatchEvent(new Event('visibilitychange'));

		vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
		document.dispatchEvent(new Event('visibilitychange'));

		await vi.advanceTimersByTimeAsync(0);
		expect(store.loadBots).not.toHaveBeenCalled();
	});
});
