import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClawConnection, BRIEF_DISCONNECT_MS, DEFAULT_CONNECT_TIMEOUT_MS } from './claw-connection.js';

// mock signaling-connection 单例
vi.mock('./signaling-connection.js', () => {
	const releaseConnId = vi.fn();
	return {
		useSignalingConnection: () => ({ releaseConnId }),
		__mockReleaseConnId: releaseConnId,
	};
});

vi.mock('./remote-log.js', () => ({ remoteLog: vi.fn() }));

import { __mockReleaseConnId } from './signaling-connection.js';

// 工厂：创建 DC 就绪的连接
function makeRtcReady(clawId = 'bot1') {
	const conn = new ClawConnection(clawId);
	const mockRtc = { isReady: true, send: vi.fn().mockResolvedValue(), close: vi.fn() };
	conn.setRtc(mockRtc);
	return { conn, mockRtc };
}

// --- 测试套件 ---

describe('ClawConnection – constructor', () => {
	test('clawId 转为字符串', () => {
		const conn = new ClawConnection(42);
		expect(conn.clawId).toBe('42');
	});

	test('初始状态无 RTC', () => {
		const conn = new ClawConnection('bot1');
		expect(conn.rtc).toBeNull();
	});

	test('初始 readyWaiters 为空', () => {
		const conn = new ClawConnection('bot1');
		expect(conn.__readyWaiters).toEqual([]);
	});

	test('初始回调为 null', () => {
		const conn = new ClawConnection('bot1');
		expect(conn.__onTriggerReconnect).toBeNull();
		expect(conn.__onGetRtcPhase).toBeNull();
	});
});

describe('ClawConnection – disconnect()', () => {
	test('关闭 RTC 并释放 connId', () => {
		const { conn, mockRtc } = makeRtcReady();
		__mockReleaseConnId.mockClear();
		conn.disconnect();
		expect(mockRtc.close).toHaveBeenCalled();
		expect(conn.rtc).toBeNull();
		expect(__mockReleaseConnId).toHaveBeenCalledWith('bot1');
	});

	test('无 RTC 时也正常执行', () => {
		const conn = new ClawConnection('bot1');
		__mockReleaseConnId.mockClear();
		expect(() => conn.disconnect()).not.toThrow();
		expect(__mockReleaseConnId).toHaveBeenCalledWith('bot1');
	});

	test('reject 所有挂起请求', async () => {
		const { conn } = makeRtcReady();
		const p = conn.request('test');
		conn.disconnect();
		await expect(p).rejects.toMatchObject({ message: 'connection closed' });
	});

	test('reject 所有 readyWaiters (DC_CLOSED)', async () => {
		const conn = new ClawConnection('bot1');
		const p = conn.waitReady(5000);
		conn.disconnect();
		await expect(p).rejects.toMatchObject({ code: 'DC_CLOSED' });
	});
});

describe('ClawConnection – RTC 管理', () => {
	test('setRtc / get rtc', () => {
		const conn = new ClawConnection('bot1');
		const rtc = { isReady: true, send: vi.fn(), close: vi.fn() };
		conn.setRtc(rtc);
		expect(conn.rtc).toBe(rtc);
	});

	test('clearRtc rejects pending with RTC_LOST', async () => {
		const { conn } = makeRtcReady();
		const p = conn.request('test');
		conn.clearRtc();
		expect(conn.rtc).toBeNull();
		await expect(p).rejects.toMatchObject({ code: 'RTC_LOST' });
	});

	test('clearRtc rejects readyWaiters with RTC_LOST', async () => {
		const conn = new ClawConnection('bot1');
		const p = conn.waitReady(5000);
		conn.clearRtc();
		await expect(p).rejects.toMatchObject({ code: 'RTC_LOST' });
	});

	test('setRtc resolves all readyWaiters', async () => {
		const conn = new ClawConnection('bot1');
		const p1 = conn.waitReady(5000);
		const p2 = conn.waitReady(5000);
		const mockRtc = { isReady: true, send: vi.fn(), close: vi.fn() };
		conn.setRtc(mockRtc);
		await expect(p1).resolves.toBeUndefined();
		await expect(p2).resolves.toBeUndefined();
		expect(conn.__readyWaiters).toHaveLength(0);
	});
});

describe('ClawConnection – waitReady()', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	test('rtc.isReady 为 true 时立即 resolve', async () => {
		const { conn } = makeRtcReady();
		await expect(conn.waitReady()).resolves.toBeUndefined();
	});

	test('setRtc 后 resolve', async () => {
		const conn = new ClawConnection('bot1');
		const p = conn.waitReady(5000);
		const mockRtc = { isReady: true, send: vi.fn(), close: vi.fn() };
		conn.setRtc(mockRtc);
		await expect(p).resolves.toBeUndefined();
	});

	test('超时 reject CONNECT_TIMEOUT', async () => {
		const conn = new ClawConnection('bot1');
		const p = conn.waitReady(3000);
		vi.advanceTimersByTime(3001);
		await expect(p).rejects.toMatchObject({ code: 'CONNECT_TIMEOUT' });
	});

	test('clearRtc 时 reject RTC_LOST', async () => {
		const conn = new ClawConnection('bot1');
		const p = conn.waitReady(5000);
		conn.clearRtc();
		await expect(p).rejects.toMatchObject({ code: 'RTC_LOST' });
	});

	test('disconnect 时 reject DC_CLOSED', async () => {
		const conn = new ClawConnection('bot1');
		const p = conn.waitReady(5000);
		conn.disconnect();
		await expect(p).rejects.toMatchObject({ code: 'DC_CLOSED' });
	});

	test('多个并发 waitReady 在 setRtc 时全部 resolve', async () => {
		const conn = new ClawConnection('bot1');
		const promises = [
			conn.waitReady(5000),
			conn.waitReady(5000),
			conn.waitReady(5000),
		];
		const mockRtc = { isReady: true, send: vi.fn(), close: vi.fn() };
		conn.setRtc(mockRtc);
		const results = await Promise.allSettled(promises);
		expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
		expect(conn.__readyWaiters).toHaveLength(0);
	});

	test('超时后 setRtc 不再 resolve 已超时的 waiter', async () => {
		const conn = new ClawConnection('bot1');
		const p = conn.waitReady(2000);
		vi.advanceTimersByTime(2001);
		await expect(p).rejects.toMatchObject({ code: 'CONNECT_TIMEOUT' });

		// waiter 已移除
		expect(conn.__readyWaiters).toHaveLength(0);

		// 之后 setRtc 不应有副作用
		const mockRtc = { isReady: true, send: vi.fn(), close: vi.fn() };
		conn.setRtc(mockRtc);
		expect(conn.rtc).toBe(mockRtc);
	});

	test('rtcPhase=failed 时调用 __onTriggerReconnect', async () => {
		const conn = new ClawConnection('bot1');
		conn.__onGetRtcPhase = vi.fn().mockReturnValue('failed');
		conn.__onTriggerReconnect = vi.fn();

		const p = conn.waitReady(3000);
		expect(conn.__onGetRtcPhase).toHaveBeenCalled();
		expect(conn.__onTriggerReconnect).toHaveBeenCalled();

		// 清理
		vi.advanceTimersByTime(3001);
		await p.catch(() => {});
	});

	test('rtcPhase=building 时不调用 __onTriggerReconnect', async () => {
		const conn = new ClawConnection('bot1');
		conn.__onGetRtcPhase = vi.fn().mockReturnValue('building');
		conn.__onTriggerReconnect = vi.fn();

		const p = conn.waitReady(3000);
		expect(conn.__onTriggerReconnect).not.toHaveBeenCalled();

		vi.advanceTimersByTime(3001);
		await p.catch(() => {});
	});

	test('rtcPhase=recovering 时不调用 __onTriggerReconnect', async () => {
		const conn = new ClawConnection('bot1');
		conn.__onGetRtcPhase = vi.fn().mockReturnValue('recovering');
		conn.__onTriggerReconnect = vi.fn();

		const p = conn.waitReady(3000);
		expect(conn.__onTriggerReconnect).not.toHaveBeenCalled();

		vi.advanceTimersByTime(3001);
		await p.catch(() => {});
	});

	test('回调未注入时不报错', async () => {
		const conn = new ClawConnection('bot1');
		expect(conn.__onGetRtcPhase).toBeNull();
		expect(conn.__onTriggerReconnect).toBeNull();

		const p = conn.waitReady(1000);
		vi.advanceTimersByTime(1001);
		await expect(p).rejects.toMatchObject({ code: 'CONNECT_TIMEOUT' });
	});

	test('默认 connectTimeout 为 30s', async () => {
		const conn = new ClawConnection('bot1');
		const p = conn.waitReady();
		vi.advanceTimersByTime(29_999);
		expect(conn.__readyWaiters).toHaveLength(1);
		vi.advanceTimersByTime(2);
		await expect(p).rejects.toMatchObject({ code: 'CONNECT_TIMEOUT' });
	});
});

describe('ClawConnection – request() 连接等待', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	test('DC 未就绪时等待，setRtc 后发送请求并收到响应', async () => {
		const conn = new ClawConnection('bot1');

		const p = conn.request('ping', { x: 1 });

		// 此时 pending 应为空（尚未发送），但有 waiter
		expect(conn.__pending.size).toBe(0);
		expect(conn.__readyWaiters).toHaveLength(1);

		// 模拟 RTC 就绪
		const mockRtc = { isReady: true, send: vi.fn().mockResolvedValue(), close: vi.fn() };
		conn.setRtc(mockRtc);
		await vi.advanceTimersByTimeAsync(0); // 让 promise 链执行

		// 请求应已发送
		expect(mockRtc.send).toHaveBeenCalledTimes(1);
		const sent = mockRtc.send.mock.calls[0][0];
		expect(sent.method).toBe('ping');

		// 模拟响应
		conn.__onRtcMessage({ type: 'res', id: sent.id, ok: true, payload: { pong: true } });
		const res = await p;
		expect(res).toEqual({ pong: true });
	});

	test('waitReady 成功后 send 失败 → reject RTC_SEND_FAILED', async () => {
		vi.useRealTimers(); // 此测试需要真实定时器让 promise chain 自然执行
		const conn = new ClawConnection('bot1');
		const p = conn.request('test', {}, { connectTimeout: 5000 });

		// 模拟连接就绪但 send 失败
		const mockRtc = { isReady: true, send: vi.fn().mockRejectedValue(new Error('dc error')), close: vi.fn() };
		conn.setRtc(mockRtc);

		await expect(p).rejects.toMatchObject({ code: 'RTC_SEND_FAILED' });
		vi.useFakeTimers(); // 恢复
	});

	test('connectTimeout 到期 → reject CONNECT_TIMEOUT', async () => {
		const conn = new ClawConnection('bot1');
		const p = conn.request('test', {}, { connectTimeout: 5000 });
		vi.advanceTimersByTime(5001);
		await expect(p).rejects.toMatchObject({ code: 'CONNECT_TIMEOUT' });
	});

	test('clearRtc 在等待期间 → reject RTC_LOST', async () => {
		const conn = new ClawConnection('bot1');
		const p = conn.request('test');
		conn.clearRtc();
		await expect(p).rejects.toMatchObject({ code: 'RTC_LOST' });
	});

	test('disconnect 在等待期间 → reject DC_CLOSED', async () => {
		const conn = new ClawConnection('bot1');
		const p = conn.request('test');
		conn.disconnect();
		await expect(p).rejects.toMatchObject({ code: 'DC_CLOSED' });
	});

	test('等待期间触发重连（rtcPhase=failed）', async () => {
		const conn = new ClawConnection('bot1');
		conn.__onGetRtcPhase = vi.fn().mockReturnValue('failed');
		conn.__onTriggerReconnect = vi.fn();

		const p = conn.request('test', {}, { connectTimeout: 5000 });
		expect(conn.__onTriggerReconnect).toHaveBeenCalled();

		vi.advanceTimersByTime(5001);
		await p.catch(() => {});
	});
});

describe('ClawConnection – request() 超时语义', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	test('默认 requestTimeout 为 30s', async () => {
		const { conn } = makeRtcReady();
		const p = conn.request('slow');
		vi.advanceTimersByTime(29_999);
		expect(conn.__pending.size).toBe(1); // 尚未超时
		vi.advanceTimersByTime(2);
		await expect(p).rejects.toMatchObject({ code: 'RPC_TIMEOUT' });
	});

	test('timeout: 0 → 不设置 requestTimeout（永不超时）', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const p = conn.request('long', {}, { timeout: 0 });
		// 推进大量时间
		vi.advanceTimersByTime(60 * 60_000);
		// pending 仍存在
		expect(conn.__pending.size).toBe(1);

		// 手动响应
		const reqId = mockRtc.send.mock.calls[0][0].id;
		conn.__onRtcMessage({ type: 'res', id: reqId, ok: true, payload: { done: true } });
		const res = await p;
		expect(res).toEqual({ done: true });
	});

	test('timeout: 0 + DC 断开 → 仍被 __rejectAllPending 拒绝', async () => {
		const { conn } = makeRtcReady();
		const p = conn.request('long', {}, { timeout: 0 });
		conn.clearRtc();
		await expect(p).rejects.toMatchObject({ code: 'RTC_LOST' });
	});

	test('connectTimeout 和 requestTimeout 独立计时', async () => {
		const conn = new ClawConnection('bot1');
		// connectTimeout=2s, requestTimeout=3s
		const p = conn.request('test', {}, { connectTimeout: 2000, timeout: 3000 });

		// 1.5s: 还在等待连接
		vi.advanceTimersByTime(1500);
		expect(conn.__readyWaiters).toHaveLength(1);

		// 1.8s: 连接就绪（总计 1.8s < 2s connectTimeout）
		const mockRtc = { isReady: true, send: vi.fn().mockResolvedValue(), close: vi.fn() };
		conn.setRtc(mockRtc);
		await vi.advanceTimersByTimeAsync(0);

		// 请求已发送
		expect(mockRtc.send).toHaveBeenCalledTimes(1);
		const reqId = mockRtc.send.mock.calls[0][0].id;

		// 再过 2.5s（总计 4.3s，但 requestTimeout 从发送时开始计 3s）
		vi.advanceTimersByTime(2999);
		expect(conn.__pending.size).toBe(1); // 尚未超时
		vi.advanceTimersByTime(2);
		await expect(p).rejects.toMatchObject({ code: 'RPC_TIMEOUT' });
	});

	test('超时前收到响应正常 resolve', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const p = conn.request('slow', {}, { timeout: 5000 });
		vi.advanceTimersByTime(3000);
		const reqId = mockRtc.send.mock.calls[0][0].id;
		conn.__onRtcMessage({ type: 'res', id: reqId, ok: true, payload: {} });
		const res = await p;
		expect(res).toEqual({});
	});
});

describe('ClawConnection – request() 前台恢复场景', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	test('等待中 setRtc（模拟恢复）→ 请求正常完成', async () => {
		const conn = new ClawConnection('bot1');
		const p = conn.request('ping');

		// 模拟 5s 后 RTC 恢复
		vi.advanceTimersByTime(5000);
		const mockRtc = { isReady: true, send: vi.fn().mockResolvedValue(), close: vi.fn() };
		conn.setRtc(mockRtc);
		await vi.advanceTimersByTimeAsync(0);

		const reqId = mockRtc.send.mock.calls[0][0].id;
		conn.__onRtcMessage({ type: 'res', id: reqId, ok: true, payload: { ok: 1 } });
		const res = await p;
		expect(res).toEqual({ ok: 1 });
	});

	test('请求进行中 clearRtc（模拟前台恢复重建）→ reject RTC_LOST', async () => {
		const { conn } = makeRtcReady();
		const p = conn.request('long.op', {}, { timeout: 0 });
		await vi.advanceTimersByTimeAsync(0); // 确保 send 完成

		// 模拟前台恢复触发 rebuild → clearRtc
		conn.clearRtc();
		await expect(p).rejects.toMatchObject({ code: 'RTC_LOST' });
	});
});

describe('ClawConnection – request() 通过 DataChannel 发送', () => {
	test('通过 DataChannel 发送请求', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const p = conn.request('ping.me', { x: 1 });
		expect(mockRtc.send).toHaveBeenCalledTimes(1);
		const sent = mockRtc.send.mock.calls[0][0];
		expect(sent.type).toBe('req');
		expect(sent.method).toBe('ping.me');
		expect(sent.params).toEqual({ x: 1 });
		expect(sent.id).toMatch(/^ui-/);
		conn.__onRtcMessage({ type: 'res', id: sent.id, ok: true, payload: { result: 42 } });
		const res = await p;
		expect(res).toEqual({ result: 42 });
	});

	test('插件返回 ok=false 时 reject', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const p = conn.request('bad.method');
		const reqId = mockRtc.send.mock.calls[0][0].id;
		conn.__onRtcMessage({ type: 'res', id: reqId, ok: false, error: { code: 'NOT_FOUND', message: 'not found' } });
		await expect(p).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'not found' });
	});

	test('error.code 缺失时使用默认 RPC_FAILED', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const p = conn.request('bad.method');
		const reqId = mockRtc.send.mock.calls[0][0].id;
		conn.__onRtcMessage({ type: 'res', id: reqId, ok: false, error: { message: 'oops' } });
		await expect(p).rejects.toMatchObject({ code: 'RPC_FAILED' });
	});

	test('自增 counter 保证请求 ID 唯一', () => {
		const { conn, mockRtc } = makeRtcReady();
		conn.request('a').catch(() => {});
		conn.request('b').catch(() => {});
		const id1 = mockRtc.send.mock.calls[0][0].id;
		const id2 = mockRtc.send.mock.calls[1][0].id;
		expect(id1).not.toBe(id2);
	});

	test('rtc.send() 失败时 reject RTC_SEND_FAILED', async () => {
		const { conn, mockRtc } = makeRtcReady();
		mockRtc.send.mockRejectedValue(new Error('dc error'));
		await expect(conn.request('some.method')).rejects.toMatchObject({ code: 'RTC_SEND_FAILED' });
	});
});

describe('ClawConnection – request() 两阶段 (onAccepted)', () => {
	test('收到 accepted 后调用 onAccepted，不 resolve', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const accepted = vi.fn();
		const p = conn.request('slow.op', {}, { onAccepted: accepted });
		const reqId = mockRtc.send.mock.calls[0][0].id;

		conn.__onRtcMessage({ type: 'res', id: reqId, ok: true, payload: { status: 'accepted', token: 'tok' } });
		await Promise.resolve();
		expect(accepted).toHaveBeenCalledWith({ status: 'accepted', token: 'tok' });
		let settled = false;
		p.then(() => { settled = true; }).catch(() => { settled = true; });
		await Promise.resolve();
		expect(settled).toBe(false);

		conn.__onRtcMessage({ type: 'res', id: reqId, ok: true, payload: { status: 'ok', data: 123 } });
		const res = await p;
		expect(res).toEqual({ status: 'ok', data: 123 });
	});

	test('终态 status=error 也 resolve', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const p = conn.request('slow.op', {}, { onAccepted: vi.fn() });
		const reqId = mockRtc.send.mock.calls[0][0].id;
		conn.__onRtcMessage({ type: 'res', id: reqId, ok: true, payload: { status: 'accepted' } });
		conn.__onRtcMessage({ type: 'res', id: reqId, ok: true, payload: { status: 'error', reason: 'fail' } });
		const res = await p;
		expect(res.status).toBe('error');
	});

	test('未知中间态调用 onUnknownStatus', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const onUnknown = vi.fn();
		conn.request('slow.op', {}, { onAccepted: vi.fn(), onUnknownStatus: onUnknown });
		const reqId = mockRtc.send.mock.calls[0][0].id;
		conn.__onRtcMessage({ type: 'res', id: reqId, ok: true, payload: { status: 'processing' } });
		await Promise.resolve();
		expect(onUnknown).toHaveBeenCalledWith('processing', { status: 'processing' });
	});
});

describe('ClawConnection – 事件系统', () => {
	test('on/off/__emit 基本功能', () => {
		const conn = new ClawConnection('b1');
		const cb = vi.fn();
		conn.on('custom', cb);
		conn.__emit('custom', { foo: 1 });
		expect(cb).toHaveBeenCalledWith({ foo: 1 });
		conn.off('custom', cb);
		conn.__emit('custom', { foo: 2 });
		expect(cb).toHaveBeenCalledTimes(1);
	});

	test('多个监听器都会收到事件', () => {
		const conn = new ClawConnection('b1');
		const a = vi.fn();
		const b = vi.fn();
		conn.on('e', a);
		conn.on('e', b);
		conn.__emit('e', 42);
		expect(a).toHaveBeenCalledWith(42);
		expect(b).toHaveBeenCalledWith(42);
	});

	test('监听器异常不影响其他监听器', () => {
		const conn = new ClawConnection('b1');
		const bad = vi.fn(() => { throw new Error('oops'); });
		const good = vi.fn();
		conn.on('e', bad);
		conn.on('e', good);
		expect(() => conn.__emit('e', {})).not.toThrow();
		expect(good).toHaveBeenCalled();
	});

	test('无监听器时 emit 不抛异常', () => {
		const conn = new ClawConnection('b1');
		expect(() => conn.__emit('nonexistent', {})).not.toThrow();
	});
});

describe('ClawConnection – __onRtcMessage', () => {
	test('DC event 分发到 event:<name>', () => {
		const conn = new ClawConnection('b1');
		const cb = vi.fn();
		conn.on('event:message.new', cb);
		conn.__onRtcMessage({ type: 'event', event: 'message.new', payload: { text: 'hi' } });
		expect(cb).toHaveBeenCalledWith({ text: 'hi' });
	});

	test('DC res 路由到 pending', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const p = conn.request('test');
		const reqId = mockRtc.send.mock.calls[0][0].id;
		conn.__onRtcMessage({ type: 'res', id: reqId, ok: true, payload: { done: true } });
		const res = await p;
		expect(res).toEqual({ done: true });
	});

	test('无 id 的 res 消息被安全忽略', () => {
		const conn = new ClawConnection('b1');
		expect(() => conn.__onRtcMessage({ type: 'res', ok: true })).not.toThrow();
	});
});

describe('ClawConnection – __rejectAllPending', () => {
	test('reject 所有挂起请求并清空', async () => {
		const { conn } = makeRtcReady();
		const p1 = conn.request('a');
		const p2 = conn.request('b');
		conn.__rejectAllPending('test reason', 'TEST_CODE');
		await expect(p1).rejects.toMatchObject({ code: 'TEST_CODE', message: 'test reason' });
		await expect(p2).rejects.toMatchObject({ code: 'TEST_CODE' });
		expect(conn.__pending.size).toBe(0);
	});
});

describe('ClawConnection – 常量导出', () => {
	test('BRIEF_DISCONNECT_MS 是合理的正整数', () => {
		expect(BRIEF_DISCONNECT_MS).toBeGreaterThan(0);
		expect(Number.isInteger(BRIEF_DISCONNECT_MS)).toBe(true);
	});

	test('DEFAULT_CONNECT_TIMEOUT_MS 为 30s', () => {
		expect(DEFAULT_CONNECT_TIMEOUT_MS).toBe(30_000);
	});
});
