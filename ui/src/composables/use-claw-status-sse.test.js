import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('vue', () => ({
	onBeforeUnmount: vi.fn(),
	ref: (v) => ({ value: v }),
}));

vi.mock('../stores/sessions.store.js', () => {
	const mockStore = { removeSessionsByClawId: vi.fn() };
	return { useSessionsStore: () => mockStore };
});

// mock remote-log（use-bot-status-sse 内部 import）
const mockRemoteLog = vi.fn();
vi.mock('../services/remote-log.js', () => ({ remoteLog: (...args) => mockRemoteLog(...args) }));

import { onBeforeUnmount } from 'vue';
import { useSessionsStore } from '../stores/sessions.store.js';
import { useClawStatusSse } from './use-claw-status-sse.js';

describe('useClawStatusSse', () => {
	let store;
	let MockEventSource;
	let esInstance;
	let currentStop;

	beforeEach(() => {
		store = {
			applySnapshot: vi.fn(),
			updateClawOnline: vi.fn(),
			addOrUpdateClaw: vi.fn(),
			removeClawById: vi.fn(),
		};
		useSessionsStore().removeSessionsByClawId.mockReset();
		mockRemoteLog.mockClear();

		esInstance = {
			onopen: null,
			onmessage: null,
			onerror: null,
			close: vi.fn(),
		};

		MockEventSource = vi.fn(() => esInstance);
		vi.stubGlobal('EventSource', MockEventSource);
		vi.useFakeTimers();
		vi.mocked(onBeforeUnmount).mockReset();
		currentStop = null;
	});

	afterEach(() => {
		if (currentStop) currentStop();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function createSse() {
		const result = useClawStatusSse(store);
		currentStop = result.stop;
		return result;
	}

	test('should create EventSource with correct URL', () => {
		createSse();
		expect(MockEventSource).toHaveBeenCalledWith('/api/v1/claws/status-stream');
	});

	test('should register onBeforeUnmount cleanup', () => {
		createSse();
		expect(onBeforeUnmount).toHaveBeenCalledWith(expect.any(Function));
	});

	test('should set connected=true on open and emit remoteLog', () => {
		const { connected } = createSse();

		esInstance.onopen();

		expect(connected.value).toBe(true);
		expect(mockRemoteLog).toHaveBeenCalledWith('sse.connected');
	});

	test('should handle claw.snapshot event via applySnapshot', () => {
		createSse();

		const items = [{ id: '1', name: 'a', online: true }];
		esInstance.onmessage({
			data: JSON.stringify({ event: 'claw.snapshot', items }),
		});

		expect(store.applySnapshot).toHaveBeenCalledWith(items);
	});

	test('should update claw status on message', () => {
		createSse();

		esInstance.onmessage({
			data: JSON.stringify({ event: 'claw.status', clawId: '42', online: true }),
		});

		expect(store.updateClawOnline).toHaveBeenCalledWith('42', true);
	});

	test('should handle claw.nameUpdated event by updating claw name in store', () => {
		createSse();

		esInstance.onmessage({
			data: JSON.stringify({ event: 'claw.nameUpdated', clawId: '42', name: '小点' }),
		});

		expect(store.addOrUpdateClaw).toHaveBeenCalledWith({ id: '42', name: '小点' });
	});

	test('should handle claw.bound event by adding claw to store', () => {
		createSse();

		esInstance.onmessage({
			data: JSON.stringify({ event: 'claw.bound', claw: { id: '42', name: 'test' } }),
		});

		expect(store.addOrUpdateClaw).toHaveBeenCalledWith({ id: '42', name: 'test' });
	});

	test('should handle claw.unbound event by removing claw', () => {
		createSse();

		esInstance.onmessage({
			data: JSON.stringify({ event: 'claw.unbound', clawId: '42' }),
		});

		expect(store.removeClawById).toHaveBeenCalledWith('42');
	});

	test('should handle heartbeat event silently', () => {
		createSse();

		esInstance.onmessage({
			data: JSON.stringify({ event: 'heartbeat' }),
		});

		expect(store.applySnapshot).not.toHaveBeenCalled();
		expect(store.updateClawOnline).not.toHaveBeenCalled();
	});

	test('should ignore messages with unknown event', () => {
		createSse();

		esInstance.onmessage({
			data: JSON.stringify({ event: 'unknown', clawId: '42' }),
		});

		expect(store.updateClawOnline).not.toHaveBeenCalled();
	});

	test('should ignore malformed JSON messages', () => {
		createSse();

		esInstance.onmessage({ data: 'not json' });

		expect(store.updateClawOnline).not.toHaveBeenCalled();
	});

	test('should set connected=false on error and emit remoteLog', () => {
		const { connected } = createSse();

		esInstance.onopen();
		expect(connected.value).toBe(true);

		esInstance.onerror();
		expect(connected.value).toBe(false);
		expect(mockRemoteLog).toHaveBeenCalledWith('sse.error');
	});

	test('stop() should close EventSource and clear heartbeat timer', () => {
		const { stop, connected } = createSse();

		esInstance.onopen(); // 启动心跳计时器

		stop();
		currentStop = null;

		expect(esInstance.close).toHaveBeenCalled();
		expect(connected.value).toBe(false);

		// 即使超过超时时间也不应重建（计时器已清理）
		vi.advanceTimersByTime(70_000);
		expect(MockEventSource).toHaveBeenCalledTimes(1);
	});

	test('heartbeat timeout should restart SSE after 65s of silence and emit remoteLog', () => {
		createSse();
		esInstance.onopen();
		mockRemoteLog.mockClear();

		expect(MockEventSource).toHaveBeenCalledTimes(1);

		// 65s 无数据 → 超时重建
		vi.advanceTimersByTime(65_000);

		expect(esInstance.close).toHaveBeenCalled();
		expect(MockEventSource).toHaveBeenCalledTimes(2);
		expect(mockRemoteLog).toHaveBeenCalledWith('sse.hbTimeout');
	});

	test('heartbeat timeout should be reset by any incoming message', () => {
		createSse();
		esInstance.onopen();

		// 40s 后收到心跳
		vi.advanceTimersByTime(40_000);
		esInstance.onmessage({
			data: JSON.stringify({ event: 'heartbeat' }),
		});

		// 再过 40s（距上次消息 40s < 65s）→ 不应超时
		vi.advanceTimersByTime(40_000);
		expect(MockEventSource).toHaveBeenCalledTimes(1);

		// 再过 25s（距上次消息 65s）→ 超时
		vi.advanceTimersByTime(25_000);
		expect(MockEventSource).toHaveBeenCalledTimes(2);
	});

	test('app:foreground 事件触发 SSE 重建', () => {
		createSse();
		expect(MockEventSource).toHaveBeenCalledTimes(1);

		window.dispatchEvent(new CustomEvent('app:foreground'));

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

	describe('restart 节流', () => {
		test('500ms 内连续两次 restart 只创建一个新 EventSource', () => {
			createSse();
			expect(MockEventSource).toHaveBeenCalledTimes(1);

			// 第一次 restart（如 app:foreground）
			window.dispatchEvent(new CustomEvent('app:foreground'));
			expect(MockEventSource).toHaveBeenCalledTimes(2);

			// 第二次 restart（如 network:online）—— 500ms 内，被节流
			window.dispatchEvent(new CustomEvent('network:online'));
			expect(MockEventSource).toHaveBeenCalledTimes(2);
		});

		test('超过 500ms 后 restart 正常执行', () => {
			createSse();
			expect(MockEventSource).toHaveBeenCalledTimes(1);

			window.dispatchEvent(new CustomEvent('app:foreground'));
			expect(MockEventSource).toHaveBeenCalledTimes(2);

			// 超过节流期
			vi.advanceTimersByTime(500);

			window.dispatchEvent(new CustomEvent('network:online'));
			expect(MockEventSource).toHaveBeenCalledTimes(3);
		});
	});
});
