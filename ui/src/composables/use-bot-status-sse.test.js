import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('vue', () => ({
	onBeforeUnmount: vi.fn(),
	ref: (v) => ({ value: v }),
}));

vi.mock('../stores/sessions.store.js', () => {
	const mockStore = { removeSessionsByBotId: vi.fn() };
	return { useSessionsStore: () => mockStore };
});

import { onBeforeUnmount } from 'vue';
import { useSessionsStore } from '../stores/sessions.store.js';
import { useBotStatusSse } from './use-bot-status-sse.js';

describe('useBotStatusSse', () => {
	let store;
	let MockEventSource;
	let esInstance;
	/** 当前测试的 SSE 实例 stop 函数，用于清理 */
	let currentStop;

	beforeEach(() => {
		store = {
			loadBots: vi.fn().mockResolvedValue([]),
			updateBotOnline: vi.fn(),
			addOrUpdateBot: vi.fn(),
			removeBotById: vi.fn(),
		};
		useSessionsStore().removeSessionsByBotId.mockReset();

		esInstance = {
			onopen: null,
			onmessage: null,
			onerror: null,
			close: vi.fn(),
		};

		MockEventSource = vi.fn(() => esInstance);
		vi.stubGlobal('EventSource', MockEventSource);
		vi.mocked(onBeforeUnmount).mockReset();
		currentStop = null;
	});

	afterEach(() => {
		// 清理全局监听器，避免跨测试污染
		if (currentStop) currentStop();
		vi.restoreAllMocks();
	});

	/** 创建 SSE 实例并自动注册 afterEach 清理 */
	function createSse() {
		const result = useBotStatusSse(store);
		currentStop = result.stop;
		return result;
	}

	test('should create EventSource with correct URL', () => {
		createSse();
		expect(MockEventSource).toHaveBeenCalledWith('/api/v1/bots/status-stream');
	});

	test('should register onBeforeUnmount cleanup', () => {
		createSse();
		expect(onBeforeUnmount).toHaveBeenCalledWith(expect.any(Function));
	});

	test('should set connected=true and call loadBots on open', async () => {
		const { connected } = createSse();

		esInstance.onopen();

		expect(connected.value).toBe(true);
		expect(store.loadBots).toHaveBeenCalledTimes(1);
	});

	test('should update bot status on message', () => {
		createSse();

		esInstance.onmessage({
			data: JSON.stringify({ event: 'bot.status', botId: '42', online: true }),
		});

		expect(store.updateBotOnline).toHaveBeenCalledWith('42', true);
	});

	test('should handle bot.nameUpdated event by updating bot name in store', () => {
		createSse();

		esInstance.onmessage({
			data: JSON.stringify({ event: 'bot.nameUpdated', botId: '42', name: '小点' }),
		});

		expect(store.addOrUpdateBot).toHaveBeenCalledWith({ id: '42', name: '小点' });
	});

	test('should handle bot.bound event by adding bot to store', () => {
		createSse();

		esInstance.onmessage({
			data: JSON.stringify({ event: 'bot.bound', bot: { id: '42', name: 'test' } }),
		});

		expect(store.addOrUpdateBot).toHaveBeenCalledWith({ id: '42', name: 'test' });
	});

	test('should handle bot.unbound event by removing bot', () => {
		createSse();

		esInstance.onmessage({
			data: JSON.stringify({ event: 'bot.unbound', botId: '42' }),
		});

		expect(store.removeBotById).toHaveBeenCalledWith('42');
		// removeSessionsByBotId 由 removeBotById 内部调用，不再重复调用
	});

	test('should ignore messages with unknown event', () => {
		createSse();

		esInstance.onmessage({
			data: JSON.stringify({ event: 'unknown', botId: '42' }),
		});

		expect(store.updateBotOnline).not.toHaveBeenCalled();
	});

	test('should ignore malformed JSON messages', () => {
		createSse();

		esInstance.onmessage({ data: 'not json' });

		expect(store.updateBotOnline).not.toHaveBeenCalled();
	});

	test('should set connected=false on error', () => {
		const { connected } = createSse();

		esInstance.onopen();
		expect(connected.value).toBe(true);

		esInstance.onerror();
		expect(connected.value).toBe(false);
	});

	test('stop() should close EventSource', () => {
		const { stop, connected } = createSse();

		stop();
		currentStop = null; // 已手动 stop

		expect(esInstance.close).toHaveBeenCalled();
		expect(connected.value).toBe(false);
	});

	test('app:foreground 事件触发 SSE 重建', () => {
		createSse();
		expect(MockEventSource).toHaveBeenCalledTimes(1);

		// 触发前台恢复
		window.dispatchEvent(new CustomEvent('app:foreground'));

		// 旧连接被关闭，新连接被创建
		expect(esInstance.close).toHaveBeenCalled();
		expect(MockEventSource).toHaveBeenCalledTimes(2);
	});

	test('stop() 后 app:foreground 不再重建 SSE', () => {
		const { stop } = createSse();
		stop();
		currentStop = null;

		MockEventSource.mockClear();
		window.dispatchEvent(new CustomEvent('app:foreground'));

		expect(MockEventSource).not.toHaveBeenCalled();
	});

	test('stop() 移除 app:foreground 监听器', () => {
		const removeSpy = vi.spyOn(window, 'removeEventListener');
		const { stop } = createSse();
		stop();
		currentStop = null;

		expect(removeSpy).toHaveBeenCalledWith('app:foreground', expect.any(Function));
	});

	test('network:online 事件触发 SSE 重建', () => {
		createSse();
		expect(MockEventSource).toHaveBeenCalledTimes(1);

		window.dispatchEvent(new CustomEvent('network:online'));

		expect(esInstance.close).toHaveBeenCalled();
		expect(MockEventSource).toHaveBeenCalledTimes(2);
	});

	test('stop() 后 network:online 不再重建 SSE', () => {
		const { stop } = createSse();
		stop();
		currentStop = null;

		MockEventSource.mockClear();
		window.dispatchEvent(new CustomEvent('network:online'));

		expect(MockEventSource).not.toHaveBeenCalled();
	});

	test('stop() 移除 network:online 监听器', () => {
		const removeSpy = vi.spyOn(window, 'removeEventListener');
		const { stop } = createSse();
		stop();
		currentStop = null;

		expect(removeSpy).toHaveBeenCalledWith('network:online', expect.any(Function));
	});
});
