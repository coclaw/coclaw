import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mockRemoteLog = vi.fn();
vi.mock('./remote-log.js', () => ({ remoteLog: (...args) => mockRemoteLog(...args) }));

vi.mock('./admin.api.js', () => ({
	adminStreamUrl: () => '/api/v1/admin/stream',
}));

import { connectAdminStream } from './admin-stream.js';

describe('connectAdminStream', () => {
	let MockEventSource;
	let esInstance;
	let currentClose;

	beforeEach(() => {
		mockRemoteLog.mockClear();
		esInstance = { onopen: null, onmessage: null, onerror: null, close: vi.fn() };
		MockEventSource = vi.fn(() => esInstance);
		vi.stubGlobal('EventSource', MockEventSource);
		vi.useFakeTimers();
		currentClose = null;
	});

	afterEach(() => {
		if (currentClose) currentClose();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function connect(handlers = {}) {
		const result = connectAdminStream(handlers);
		currentClose = result.close;
		return result;
	}

	test('使用 admin.api 的 adminStreamUrl', () => {
		connect();
		expect(MockEventSource).toHaveBeenCalledWith('/api/v1/admin/stream');
	});

	test('onopen 记 remoteLog connected', () => {
		connect();
		esInstance.onopen();
		expect(mockRemoteLog).toHaveBeenCalledWith('adminSse.connected');
	});

	test('snapshot 事件分发 onlineClawIds', () => {
		const onSnapshot = vi.fn();
		connect({ onSnapshot });
		esInstance.onmessage({ data: JSON.stringify({ event: 'snapshot', onlineClawIds: ['1', '2'] }) });
		expect(onSnapshot).toHaveBeenCalledWith(['1', '2']);
	});

	test('snapshot onlineClawIds 非数组时传空数组', () => {
		const onSnapshot = vi.fn();
		connect({ onSnapshot });
		esInstance.onmessage({ data: JSON.stringify({ event: 'snapshot' }) });
		expect(onSnapshot).toHaveBeenCalledWith([]);
	});

	test('snapshot 无 handler 不抛', () => {
		connect();
		expect(() => esInstance.onmessage({ data: JSON.stringify({ event: 'snapshot', onlineClawIds: ['1'] }) }))
			.not.toThrow();
	});

	test('claw.statusChanged 转换字段类型', () => {
		const onStatusChanged = vi.fn();
		connect({ onStatusChanged });
		esInstance.onmessage({ data: JSON.stringify({ event: 'claw.statusChanged', clawId: 42, online: 1 }) });
		expect(onStatusChanged).toHaveBeenCalledWith({ clawId: '42', online: true });
	});

	test('claw.statusChanged 无 handler 不抛', () => {
		connect();
		expect(() => esInstance.onmessage({ data: JSON.stringify({ event: 'claw.statusChanged', clawId: '1', online: true }) }))
			.not.toThrow();
	});

	test('claw.infoUpdated 全字段 patch 透传', () => {
		const onInfoUpdated = vi.fn();
		connect({ onInfoUpdated });
		esInstance.onmessage({
			data: JSON.stringify({
				event: 'claw.infoUpdated',
				clawId: 7,
				name: 'x',
				hostName: 'host',
				pluginVersion: '0.1.0',
				agentModels: [{ id: 'a' }],
			}),
		});
		expect(onInfoUpdated).toHaveBeenCalledWith({
			clawId: '7',
			name: 'x',
			hostName: 'host',
			pluginVersion: '0.1.0',
			agentModels: [{ id: 'a' }],
		});
	});

	test('claw.infoUpdated 缺省字段不出现在 patch（保留 undefined 以便 store skip）', () => {
		const onInfoUpdated = vi.fn();
		connect({ onInfoUpdated });
		esInstance.onmessage({ data: JSON.stringify({ event: 'claw.infoUpdated', clawId: '7' }) });
		// patch 语义：wire 中不存在的字段 → 回调 patch 中也不存在（不以 null 伪装）
		expect(onInfoUpdated).toHaveBeenCalledWith({ clawId: '7' });
		const patch = onInfoUpdated.mock.calls[0][0];
		expect('name' in patch).toBe(false);
		expect('hostName' in patch).toBe(false);
		expect('pluginVersion' in patch).toBe(false);
		expect('agentModels' in patch).toBe(false);
	});

	test('claw.infoUpdated 部分字段 patch（仅 pluginVersion）只透传存在的字段', () => {
		const onInfoUpdated = vi.fn();
		connect({ onInfoUpdated });
		esInstance.onmessage({
			data: JSON.stringify({ event: 'claw.infoUpdated', clawId: '8', pluginVersion: '0.15.0' }),
		});
		expect(onInfoUpdated).toHaveBeenCalledWith({ clawId: '8', pluginVersion: '0.15.0' });
	});

	test('claw.infoUpdated 显式 null 字段（wire 中存在但值为 null）被透传', () => {
		const onInfoUpdated = vi.fn();
		connect({ onInfoUpdated });
		esInstance.onmessage({
			data: JSON.stringify({ event: 'claw.infoUpdated', clawId: '9', name: null, hostName: null }),
		});
		expect(onInfoUpdated).toHaveBeenCalledWith({ clawId: '9', name: null, hostName: null });
	});

	test('claw.infoUpdated 无 handler 不抛', () => {
		connect();
		expect(() => esInstance.onmessage({ data: JSON.stringify({ event: 'claw.infoUpdated', clawId: '1' }) }))
			.not.toThrow();
	});

	test('heartbeat 无副作用', () => {
		const onSnapshot = vi.fn();
		const onStatusChanged = vi.fn();
		connect({ onSnapshot, onStatusChanged });
		esInstance.onmessage({ data: JSON.stringify({ event: 'heartbeat' }) });
		expect(onSnapshot).not.toHaveBeenCalled();
		expect(onStatusChanged).not.toHaveBeenCalled();
	});

	test('未知事件忽略', () => {
		const onSnapshot = vi.fn();
		connect({ onSnapshot });
		esInstance.onmessage({ data: JSON.stringify({ event: 'unknown' }) });
		expect(onSnapshot).not.toHaveBeenCalled();
	});

	test('JSON 解析失败静默忽略', () => {
		const onSnapshot = vi.fn();
		connect({ onSnapshot });
		esInstance.onmessage({ data: 'not-json' });
		expect(onSnapshot).not.toHaveBeenCalled();
	});

	test('onerror 记 remoteLog error', () => {
		connect();
		esInstance.onerror();
		expect(mockRemoteLog).toHaveBeenCalledWith('adminSse.error');
	});

	test('close 调用 EventSource.close 并清定时器', () => {
		const result = connect();
		esInstance.onopen();
		result.close();
		currentClose = null;

		expect(esInstance.close).toHaveBeenCalled();
		// 即使到心跳超时也不应重建
		vi.advanceTimersByTime(70_000);
		expect(MockEventSource).toHaveBeenCalledTimes(1);
	});

	test('心跳 65s 无数据自动重连', () => {
		connect();
		esInstance.onopen();
		mockRemoteLog.mockClear();
		vi.advanceTimersByTime(65_000);
		expect(esInstance.close).toHaveBeenCalled();
		expect(MockEventSource).toHaveBeenCalledTimes(2);
		expect(mockRemoteLog).toHaveBeenCalledWith('adminSse.hbTimeout');
	});

	test('消息刷新心跳计时器', () => {
		connect();
		esInstance.onopen();
		vi.advanceTimersByTime(40_000);
		esInstance.onmessage({ data: JSON.stringify({ event: 'heartbeat' }) });
		vi.advanceTimersByTime(40_000);
		expect(MockEventSource).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(25_000);
		expect(MockEventSource).toHaveBeenCalledTimes(2);
	});

	test('app:foreground 触发重连', () => {
		connect();
		window.dispatchEvent(new CustomEvent('app:foreground'));
		expect(MockEventSource).toHaveBeenCalledTimes(2);
	});

	test('network:online 触发重连', () => {
		connect();
		window.dispatchEvent(new CustomEvent('network:online'));
		expect(MockEventSource).toHaveBeenCalledTimes(2);
	});

	test('close 后事件不再重建', () => {
		const result = connect();
		result.close();
		currentClose = null;
		MockEventSource.mockClear();
		window.dispatchEvent(new CustomEvent('app:foreground'));
		window.dispatchEvent(new CustomEvent('network:online'));
		expect(MockEventSource).not.toHaveBeenCalled();
	});

	test('close 移除 window 事件监听', () => {
		const removeSpy = vi.spyOn(window, 'removeEventListener');
		const result = connect();
		result.close();
		currentClose = null;
		expect(removeSpy).toHaveBeenCalledWith('app:foreground', expect.any(Function));
		expect(removeSpy).toHaveBeenCalledWith('network:online', expect.any(Function));
	});

	test('500ms 内多次 restart 被节流', () => {
		connect();
		window.dispatchEvent(new CustomEvent('app:foreground'));
		expect(MockEventSource).toHaveBeenCalledTimes(2);
		window.dispatchEvent(new CustomEvent('network:online'));
		expect(MockEventSource).toHaveBeenCalledTimes(2);
	});

	test('500ms 后 restart 正常执行', () => {
		connect();
		window.dispatchEvent(new CustomEvent('app:foreground'));
		expect(MockEventSource).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(500);
		window.dispatchEvent(new CustomEvent('network:online'));
		expect(MockEventSource).toHaveBeenCalledTimes(3);
	});

	test('未 onopen 的 onerror 连续 3 次即熔断，不再重连', () => {
		connect();
		// 三次握手失败（从未 onopen），第三次应触发熔断：stopped=true + close + 清除 es
		esInstance.onerror();
		esInstance.onerror();
		esInstance.onerror();
		expect(esInstance.close).toHaveBeenCalled();
		// 熔断后 foreground / network:online 不再重连
		MockEventSource.mockClear();
		window.dispatchEvent(new CustomEvent('app:foreground'));
		window.dispatchEvent(new CustomEvent('network:online'));
		expect(MockEventSource).not.toHaveBeenCalled();
		// 记了 handshakeBlocked 远程日志
		expect(mockRemoteLog).toHaveBeenCalledWith(expect.stringMatching(/^adminSse\.handshakeBlocked/));
	});

	test('onopen 后再 onerror 不计入熔断（生产期断线可继续重连）', () => {
		connect();
		esInstance.onopen(); // 握手成功 → 清零计数
		// 断线 若干次：错误不累计进熔断计数
		esInstance.onerror();
		esInstance.onerror();
		esInstance.onerror();
		esInstance.onerror();
		// foreground 触发重连：熔断开关 stopped 仍为 false，应建立新 EventSource
		window.dispatchEvent(new CustomEvent('app:foreground'));
		expect(MockEventSource).toHaveBeenCalledTimes(2);
	});
});
