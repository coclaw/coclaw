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
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test('should create EventSource with correct URL', () => {
		useBotStatusSse(store);
		expect(MockEventSource).toHaveBeenCalledWith('/api/v1/bots/status-stream');
	});

	test('should register onBeforeUnmount cleanup', () => {
		useBotStatusSse(store);
		expect(onBeforeUnmount).toHaveBeenCalledWith(expect.any(Function));
	});

	test('should set connected=true and call loadBots on open', async () => {
		const { connected } = useBotStatusSse(store);

		esInstance.onopen();

		expect(connected.value).toBe(true);
		expect(store.loadBots).toHaveBeenCalledTimes(1);
	});

	test('should update bot status on message', () => {
		useBotStatusSse(store);

		esInstance.onmessage({
			data: JSON.stringify({ event: 'bot.status', botId: '42', online: true }),
		});

		expect(store.updateBotOnline).toHaveBeenCalledWith('42', true);
	});

	test('should handle bot.nameUpdated event by updating bot name in store', () => {
		useBotStatusSse(store);

		esInstance.onmessage({
			data: JSON.stringify({ event: 'bot.nameUpdated', botId: '42', name: '小点' }),
		});

		expect(store.addOrUpdateBot).toHaveBeenCalledWith({ id: '42', name: '小点' });
	});

	test('should handle bot.bound event by adding bot to store', () => {
		useBotStatusSse(store);

		esInstance.onmessage({
			data: JSON.stringify({ event: 'bot.bound', bot: { id: '42', name: 'test' } }),
		});

		expect(store.addOrUpdateBot).toHaveBeenCalledWith({ id: '42', name: 'test' });
	});

	test('should handle bot.unbound event by removing bot', () => {
		useBotStatusSse(store);

		esInstance.onmessage({
			data: JSON.stringify({ event: 'bot.unbound', botId: '42' }),
		});

		expect(store.removeBotById).toHaveBeenCalledWith('42');
		// removeSessionsByBotId 由 removeBotById 内部调用，不再重复调用
	});

	test('should ignore messages with unknown event', () => {
		useBotStatusSse(store);

		esInstance.onmessage({
			data: JSON.stringify({ event: 'unknown', botId: '42' }),
		});

		expect(store.updateBotOnline).not.toHaveBeenCalled();
	});

	test('should ignore malformed JSON messages', () => {
		useBotStatusSse(store);

		esInstance.onmessage({ data: 'not json' });

		expect(store.updateBotOnline).not.toHaveBeenCalled();
	});

	test('should set connected=false on error', () => {
		const { connected } = useBotStatusSse(store);

		esInstance.onopen();
		expect(connected.value).toBe(true);

		esInstance.onerror();
		expect(connected.value).toBe(false);
	});

	test('stop() should close EventSource', () => {
		const { stop, connected } = useBotStatusSse(store);

		stop();

		expect(esInstance.close).toHaveBeenCalled();
		expect(connected.value).toBe(false);
	});
});
