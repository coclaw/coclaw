import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { BotConnection } from './bot-connection.js';

// --- MockWebSocket ---

class MockWebSocket {
	constructor(url) {
		this.url = url;
		this.readyState = 0; // CONNECTING
		this.__listeners = {};
		this.sent = [];
		this.closed = false;
		this.closeCode = null;
		this.closeReason = null;
		MockWebSocket.lastInstance = this;
		MockWebSocket.instances.push(this);
	}

	addEventListener(event, cb) {
		if (!this.__listeners[event]) this.__listeners[event] = [];
		this.__listeners[event].push(cb);
	}

	removeEventListener(event, cb) {
		if (!this.__listeners[event]) return;
		this.__listeners[event] = this.__listeners[event].filter(fn => fn !== cb);
	}

	send(data) {
		if (this.readyState !== 1) throw new Error('ws not open');
		if (this.failOnSend) throw new Error('send failed');
		this.sent.push(data);
	}

	close(code, reason) {
		this.closed = true;
		this.closeCode = code;
		this.closeReason = reason;
		this.readyState = 3; // CLOSED
	}

	// 模拟触发事件
	simulateOpen() {
		this.readyState = 1;
		(this.__listeners['open'] ?? []).forEach(cb => cb());
	}

	simulateMessage(data) {
		const payload = typeof data === 'string' ? data : JSON.stringify(data);
		(this.__listeners['message'] ?? []).forEach(cb => cb({ data: payload }));
	}

	simulateClose(code = 1000, reason = '') {
		this.readyState = 3;
		(this.__listeners['close'] ?? []).forEach(cb => cb({ code, reason }));
	}

	simulateError() {
		(this.__listeners['error'] ?? []).forEach(cb => cb(new Event('error')));
	}

	static reset() {
		MockWebSocket.lastInstance = null;
		MockWebSocket.instances = [];
	}
}
MockWebSocket.instances = [];
MockWebSocket.lastInstance = null;

// 工厂：创建一个 WS 已连接的 BotConnection（WS 仅用于信令）
function makeConnected(botId = 'bot1', extra = {}) {
	MockWebSocket.reset();
	const conn = new BotConnection(botId, { baseUrl: 'http://localhost:3000', WebSocket: MockWebSocket, ...extra });
	conn.connect();
	const ws = MockWebSocket.lastInstance;
	ws.simulateOpen();
	return { conn, ws };
}

// 工厂：创建 WS + RTC(DC) 均就绪的连接
function makeRtcReady(botId = 'bot1', extra = {}) {
	const { conn, ws } = makeConnected(botId, extra);
	const mockRtc = { isReady: true, send: vi.fn().mockResolvedValue(), close: vi.fn() };
	conn.setRtc(mockRtc);
	return { conn, ws, mockRtc };
}

// --- 测试套件 ---

describe('BotConnection – constructor', () => {
	test('initializes state as disconnected', () => {
		MockWebSocket.reset();
		const conn = new BotConnection('bot1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		expect(conn.state).toBe('disconnected');
		expect(conn.botId).toBe('bot1');
	});

	test('casts botId to string', () => {
		MockWebSocket.reset();
		const conn = new BotConnection(42, { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		expect(conn.botId).toBe('42');
	});
});

describe('BotConnection – connect()', () => {
	beforeEach(() => MockWebSocket.reset());

	test('sets state to connecting then connected when WS opens', () => {
		const states = [];
		const conn = new BotConnection('bot1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		conn.on('state', s => states.push(s));
		conn.connect();
		expect(conn.state).toBe('connecting');
		MockWebSocket.lastInstance.simulateOpen();
		expect(conn.state).toBe('connected');
		expect(states).toEqual(['connecting', 'connected']);
	});

	test('is idempotent: second connect() while already connecting is ignored', () => {
		const conn = new BotConnection('bot1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		conn.connect();
		const firstWs = MockWebSocket.lastInstance;
		conn.connect(); // no-op
		expect(MockWebSocket.instances.length).toBe(1);
		expect(MockWebSocket.lastInstance).toBe(firstWs);
	});

	test('is idempotent: second connect() while connected is ignored', () => {
		const { conn } = makeConnected();
		conn.connect();
		expect(MockWebSocket.instances.length).toBe(1);
	});

	test('WS URL contains botId and role=ui', () => {
		const conn = new BotConnection('myBot', { baseUrl: 'http://localhost:3000', WebSocket: MockWebSocket });
		conn.connect();
		const ws = MockWebSocket.lastInstance;
		expect(ws.url).toContain('botId=myBot');
		expect(ws.url).toContain('role=ui');
	});

	test('converts http base URL to ws protocol', () => {
		const conn = new BotConnection('b1', { baseUrl: 'http://localhost:3000', WebSocket: MockWebSocket });
		conn.connect();
		expect(MockWebSocket.lastInstance.url.startsWith('ws:')).toBe(true);
	});

	test('converts https base URL to wss protocol', () => {
		const conn = new BotConnection('b1', { baseUrl: 'https://api.example.com', WebSocket: MockWebSocket });
		conn.connect();
		expect(MockWebSocket.lastInstance.url.startsWith('wss:')).toBe(true);
	});

	test('resets reconnect delay on successful open', () => {
		const conn = new BotConnection('b1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		conn.__reconnectDelay = 16000; // simulate prior backoff
		conn.connect();
		MockWebSocket.lastInstance.simulateOpen();
		expect(conn.__reconnectDelay).toBe(1000); // INITIAL_RECONNECT_MS
	});
});

describe('BotConnection – disconnect()', () => {
	beforeEach(() => MockWebSocket.reset());

	test('closes WS and sets state to disconnected', () => {
		const { conn, ws } = makeConnected();
		conn.disconnect();
		expect(conn.state).toBe('disconnected');
		expect(ws.closed).toBe(true);
	});

	test('rejects all pending RPCs with DC_CLOSED', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const p = conn.request('some.method');
		conn.disconnect();
		await expect(p).rejects.toMatchObject({ code: 'DC_CLOSED' });
	});

	test('emits state=disconnected event', () => {
		const { conn } = makeConnected();
		const states = [];
		conn.on('state', s => states.push(s));
		conn.disconnect();
		expect(states).toContain('disconnected');
	});

	test('does nothing extra if already disconnected', () => {
		MockWebSocket.reset();
		const conn = new BotConnection('b1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		expect(() => conn.disconnect()).not.toThrow();
		expect(conn.state).toBe('disconnected');
	});

	test('disconnect() rejects pending RPC with DC_CLOSED not RPC_TIMEOUT when timeout is active', async () => {
		vi.useFakeTimers();
		try {
			const { conn } = makeRtcReady();
			const p = conn.request('x', {}, { timeout: 5000 });
			conn.disconnect();
			await expect(p).rejects.toMatchObject({ code: 'DC_CLOSED' });
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('BotConnection – request()', () => {
	beforeEach(() => MockWebSocket.reset());

	test('sends JSON message via DataChannel', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const p = conn.request('ping.me', { x: 1 });
		expect(mockRtc.send).toHaveBeenCalledTimes(1);
		const sent = mockRtc.send.mock.calls[0][0];
		expect(sent.type).toBe('req');
		expect(sent.method).toBe('ping.me');
		expect(sent.params).toEqual({ x: 1 });
		expect(sent.id).toMatch(/^ui-/);
		// resolve via DC message
		conn.__onRtcMessage({ type: 'res', id: sent.id, ok: true, payload: { result: 42 } });
		const res = await p;
		expect(res).toEqual({ result: 42 });
	});

	test('rejects with DC_NOT_READY when DataChannel is not available', async () => {
		const conn = new BotConnection('b1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		await expect(conn.request('foo')).rejects.toMatchObject({ code: 'DC_NOT_READY' });
	});

	test('rejects with DC_NOT_READY when WS connected but no RTC', async () => {
		const { conn } = makeConnected();
		await expect(conn.request('foo')).rejects.toMatchObject({ code: 'DC_NOT_READY' });
	});

	test('rejects with RPC_FAILED when plugin responds ok=false', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const p = conn.request('bad.method');
		const reqId = mockRtc.send.mock.calls[0][0].id;
		conn.__onRtcMessage({ type: 'res', id: reqId, ok: false, error: { code: 'NOT_FOUND', message: 'not found' } });
		await expect(p).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'not found' });
	});

	test('uses default error code RPC_FAILED when error.code missing', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const p = conn.request('bad.method');
		const reqId = mockRtc.send.mock.calls[0][0].id;
		conn.__onRtcMessage({ type: 'res', id: reqId, ok: false, error: { message: 'oops' } });
		await expect(p).rejects.toMatchObject({ code: 'RPC_FAILED' });
	});

	test('resolves immediately (no onAccepted) on any ok=true response', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const p = conn.request('simple');
		const reqId = mockRtc.send.mock.calls[0][0].id;
		conn.__onRtcMessage({ type: 'res', id: reqId, ok: true, payload: { status: 'accepted' } });
		const res = await p;
		expect(res).toEqual({ status: 'accepted' });
	});

	test('increments counter for unique IDs', () => {
		const { conn, mockRtc } = makeRtcReady();
		conn.request('a').catch(() => {});
		conn.request('b').catch(() => {});
		const id1 = mockRtc.send.mock.calls[0][0].id;
		const id2 = mockRtc.send.mock.calls[1][0].id;
		expect(id1).not.toBe(id2);
	});

	test('rejects with RTC_SEND_FAILED when rtc.send() rejects', async () => {
		const { conn, mockRtc } = makeRtcReady();
		mockRtc.send.mockRejectedValue(new Error('dc error'));
		await expect(conn.request('some.method')).rejects.toMatchObject({ code: 'RTC_SEND_FAILED' });
	});
});

describe('BotConnection – request() two-phase (onAccepted)', () => {
	beforeEach(() => MockWebSocket.reset());

	test('calls onAccepted when status=accepted and does not resolve yet', async () => {
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

	test('resolves on terminal status=error (ok=true, two-phase)', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const p = conn.request('slow.op', {}, { onAccepted: vi.fn() });
		const reqId = mockRtc.send.mock.calls[0][0].id;
		conn.__onRtcMessage({ type: 'res', id: reqId, ok: true, payload: { status: 'accepted' } });
		conn.__onRtcMessage({ type: 'res', id: reqId, ok: true, payload: { status: 'error', reason: 'fail' } });
		const res = await p;
		expect(res.status).toBe('error');
	});

	test('calls onUnknownStatus for unrecognised intermediate status', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const onUnknown = vi.fn();
		conn.request('slow.op', {}, { onAccepted: vi.fn(), onUnknownStatus: onUnknown });
		const reqId = mockRtc.send.mock.calls[0][0].id;
		conn.__onRtcMessage({ type: 'res', id: reqId, ok: true, payload: { status: 'processing' } });
		await Promise.resolve();
		expect(onUnknown).toHaveBeenCalledWith('processing', { status: 'processing' });
	});

	test('ok=false with no error field rejects with message "rpc failed" and code RPC_FAILED', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const p = conn.request('some.method');
		const reqId = mockRtc.send.mock.calls[0][0].id;
		conn.__onRtcMessage({ type: 'res', id: reqId, ok: false });
		await expect(p).rejects.toMatchObject({ message: 'rpc failed', code: 'RPC_FAILED' });
	});

	test('unknown intermediate status without onUnknownStatus keeps promise pending', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const p = conn.request('slow.op', {}, { onAccepted: vi.fn() });
		const reqId = mockRtc.send.mock.calls[0][0].id;
		conn.__onRtcMessage({ type: 'res', id: reqId, ok: true, payload: { status: 'processing' } });
		await Promise.resolve();
		let settled = false;
		p.then(() => { settled = true; }).catch(() => { settled = true; });
		await Promise.resolve();
		expect(settled).toBe(false);
	});
});

describe('BotConnection – request() timeout', () => {
	beforeEach(() => {
		MockWebSocket.reset();
		vi.useFakeTimers();
	});
	afterEach(() => vi.useRealTimers());

	test('rejects with RPC_TIMEOUT after timeout ms', async () => {
		const { conn } = makeRtcReady();
		const p = conn.request('slow', {}, { timeout: 5000 });
		vi.advanceTimersByTime(5001);
		await expect(p).rejects.toMatchObject({ code: 'RPC_TIMEOUT' });
	});

	test('does not reject before timeout elapses', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const p = conn.request('slow', {}, { timeout: 5000 });
		vi.advanceTimersByTime(3000);
		const reqId = mockRtc.send.mock.calls[0][0].id;
		conn.__onRtcMessage({ type: 'res', id: reqId, ok: true, payload: {} });
		const res = await p;
		expect(res).toEqual({});
	});

	test('cleans up pending entry after timeout', async () => {
		const { conn } = makeRtcReady();
		const p = conn.request('slow', {}, { timeout: 1000 });
		vi.advanceTimersByTime(1001);
		await expect(p).rejects.toBeDefined();
		expect(conn.__pending.size).toBe(0);
	});

	test('applies default 30-minute timeout when no explicit timeout given', async () => {
		const { conn } = makeRtcReady();
		const p = conn.request('longRunning');
		expect(conn.__pending.size).toBe(1);
		vi.advanceTimersByTime(29 * 60_000);
		expect(conn.__pending.size).toBe(1);
		vi.advanceTimersByTime(1 * 60_000 + 1);
		await expect(p).rejects.toMatchObject({ code: 'RPC_TIMEOUT' });
		expect(conn.__pending.size).toBe(0);
	});

	test('late response after timeout is silently ignored', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const p = conn.request('slow', {}, { timeout: 1000 });
		const reqId = mockRtc.send.mock.calls[0][0].id;
		vi.advanceTimersByTime(1001);
		await expect(p).rejects.toMatchObject({ code: 'RPC_TIMEOUT' });
		expect(() => {
			conn.__onRtcMessage({ type: 'res', id: reqId, ok: true, payload: { late: true } });
		}).not.toThrow();
		expect(conn.__pending.size).toBe(0);
	});
});

describe('BotConnection – event system (on/off/__emit)', () => {
	beforeEach(() => MockWebSocket.reset());

	test('on() registers listener, __emit() calls it', () => {
		const conn = new BotConnection('b1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		const cb = vi.fn();
		conn.on('custom', cb);
		conn.__emit('custom', { foo: 1 });
		expect(cb).toHaveBeenCalledWith({ foo: 1 });
	});

	test('off() removes listener', () => {
		const conn = new BotConnection('b1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		const cb = vi.fn();
		conn.on('custom', cb);
		conn.off('custom', cb);
		conn.__emit('custom', {});
		expect(cb).not.toHaveBeenCalled();
	});

	test('multiple listeners on same event all receive emit', () => {
		const conn = new BotConnection('b1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		const a = vi.fn(); const b = vi.fn();
		conn.on('e', a);
		conn.on('e', b);
		conn.__emit('e', 42);
		expect(a).toHaveBeenCalledWith(42);
		expect(b).toHaveBeenCalledWith(42);
	});

	test('__emit with no listeners does not throw', () => {
		const conn = new BotConnection('b1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		expect(() => conn.__emit('nonexistent', {})).not.toThrow();
	});

	test('listener that throws does not prevent other listeners from running', () => {
		const conn = new BotConnection('b1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		const bad = vi.fn(() => { throw new Error('oops'); });
		const good = vi.fn();
		conn.on('e', bad);
		conn.on('e', good);
		expect(() => conn.__emit('e', {})).not.toThrow();
		expect(good).toHaveBeenCalled();
	});
});

describe('BotConnection – special messages', () => {
	beforeEach(() => MockWebSocket.reset());

	test('pong message is silently ignored', () => {
		const { conn } = makeConnected();
		const listener = vi.fn();
		conn.on('state', listener);
		listener.mockClear();
		// no error, no state change
		expect(() => {
			MockWebSocket.lastInstance.simulateMessage({ type: 'pong' });
		}).not.toThrow();
		expect(listener).not.toHaveBeenCalled();
	});

	test('session.expired emits session-expired and disconnects', async () => {
		const { conn, ws } = makeConnected();
		const expiredCb = vi.fn();
		conn.on('session-expired', expiredCb);
		ws.simulateMessage({ type: 'session.expired' });
		expect(expiredCb).toHaveBeenCalled();
		expect(conn.state).toBe('disconnected');
		expect(ws.closed).toBe(true);
	});

	test('session.expired does not reconnect (intentional close)', async () => {
		const { conn, ws } = makeConnected();
		ws.simulateMessage({ type: 'session.expired' });
		expect(conn.__intentionalClose).toBe(true);
	});

	test('session.expired 清理 RTC 状态', () => {
		const { conn, ws, mockRtc } = makeRtcReady();

		ws.simulateMessage({ type: 'session.expired' });

		expect(mockRtc.close).toHaveBeenCalled();
		expect(conn.__rtc).toBeNull();
	});

	test('bot.unbound 清理 RTC 状态', () => {
		const { conn, ws, mockRtc } = makeRtcReady();

		ws.simulateMessage({ type: 'bot.unbound' });

		expect(mockRtc.close).toHaveBeenCalled();
		expect(conn.__rtc).toBeNull();
	});

	test('disconnect() 清理 RTC 状态', () => {
		const { conn, mockRtc } = makeRtcReady();

		conn.disconnect();

		expect(mockRtc.close).toHaveBeenCalled();
		expect(conn.__rtc).toBeNull();
	});

	test('bot.unbound emits bot-unbound and disconnects without reconnect', async () => {
		const { conn, ws } = makeConnected();
		const unboundCb = vi.fn();
		conn.on('bot-unbound', unboundCb);
		const payload = { type: 'bot.unbound', reason: 'user removed binding' };
		ws.simulateMessage(payload);
		expect(unboundCb).toHaveBeenCalledWith(payload);
		expect(conn.state).toBe('disconnected');
		expect(conn.__intentionalClose).toBe(true);
		expect(conn.__reconnectTimer).toBeNull();
	});

	test('bot.unbound rejects pending RPCs', async () => {
		const { conn, ws } = makeRtcReady();
		const p = conn.request('something');
		ws.simulateMessage({ type: 'bot.unbound' });
		await expect(p).rejects.toMatchObject({ code: 'DC_CLOSED' });
	});

	test('invalid JSON message is silently ignored', () => {
		const { ws } = makeConnected();
		expect(() => ws.simulateMessage('not json {')).not.toThrow();
	});

	test('DC res message without id does not throw and does not affect pending', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const p = conn.request('some.method');
		const reqId = mockRtc.send.mock.calls[0][0].id;
		// 发送一条无 id 的 res 消息
		expect(() => conn.__onRtcMessage({ type: 'res', ok: true })).not.toThrow();
		// 原 pending 未受影响，仍可正常 resolve
		conn.__onRtcMessage({ type: 'res', id: reqId, ok: true, payload: { done: true } });
		const res = await p;
		expect(res).toEqual({ done: true });
	});
});

describe('BotConnection – DC push events', () => {
	beforeEach(() => MockWebSocket.reset());

	test('DC event dispatches to event:<name> listener', () => {
		const { conn } = makeConnected();
		const cb = vi.fn();
		conn.on('event:message.new', cb);
		conn.__onRtcMessage({ type: 'event', event: 'message.new', payload: { text: 'hi' } });
		expect(cb).toHaveBeenCalledWith({ text: 'hi' });
	});

	test('WS event messages are always ignored', () => {
		const { conn, ws } = makeConnected();
		const cb = vi.fn();
		conn.on('event:message.new', cb);
		ws.simulateMessage({ type: 'event', event: 'message.new', payload: { text: 'hi' } });
		expect(cb).not.toHaveBeenCalled();
	});

	test('WS res messages are always ignored', () => {
		const { conn, mockRtc } = makeRtcReady();
		const p = conn.request('test').catch(() => {});
		const reqId = mockRtc.send.mock.calls[0][0].id;
		// WS res for same ID should be ignored
		MockWebSocket.lastInstance.simulateMessage({ type: 'res', id: reqId, ok: true, payload: {} });
		// 请求应仍在 pending 中
		expect(conn.__pending.has(reqId)).toBe(true);
		conn.disconnect();
	});
});

describe('BotConnection – heartbeat', () => {
	beforeEach(() => {
		MockWebSocket.reset();
		vi.useFakeTimers();
	});
	afterEach(() => vi.useRealTimers());

	test('ping is sent at 25s interval', () => {
		const { ws } = makeConnected();
		vi.advanceTimersByTime(25_000);
		const pings = ws.sent.map(s => JSON.parse(s)).filter(m => m.type === 'ping');
		expect(pings.length).toBeGreaterThanOrEqual(1);
	});

	test('first miss does not close WS (base tolerance = 2)', () => {
		const { conn, ws } = makeConnected();
		vi.advanceTimersByTime(45_001);
		expect(ws.closed).toBe(false);
		expect(conn.__hbMissCount).toBe(1);
	});

	test('closes WS after 2 misses without pending RPC (~90s)', () => {
		const { ws } = makeConnected();
		vi.advanceTimersByTime(45_000 * 2 + 1);
		expect(ws.closed).toBe(true);
		expect(ws.closeCode).toBe(4000);
	});

	test('miss sends extra ping as probe', () => {
		const { ws } = makeConnected();
		const sentBefore = ws.sent.length;
		vi.advanceTimersByTime(45_001);
		const newPings = ws.sent.slice(sentBefore).filter(s => JSON.parse(s).type === 'ping');
		expect(newPings.length).toBeGreaterThanOrEqual(1);
	});

	test('receiving a message resets miss count and timeout', () => {
		const { conn, ws } = makeConnected();
		vi.advanceTimersByTime(30_000);
		ws.simulateMessage({ type: 'pong' });
		expect(conn.__hbMissCount).toBe(0);
		vi.advanceTimersByTime(30_000);
		expect(ws.closed).toBe(false);
	});

	test('message after miss resets count, extends tolerance', () => {
		const { conn, ws } = makeConnected();
		vi.advanceTimersByTime(45_001);
		expect(conn.__hbMissCount).toBe(1);
		ws.simulateMessage({ type: 'pong' });
		expect(conn.__hbMissCount).toBe(0);
		// 从重置点需 2 次 miss 才断连
		vi.advanceTimersByTime(45_000 + 1);
		expect(ws.closed).toBe(false);
		vi.advanceTimersByTime(45_000);
		expect(ws.closed).toBe(true);
	});

	test('pending RPC does not extend heartbeat tolerance', () => {
		const { conn, ws, mockRtc } = makeRtcReady();
		conn.request('slowMethod').catch(() => {});
		expect(conn.__pending.size).toBe(1);
		// 即使有 pending RPC，2 次 miss 后仍断连 WS
		vi.advanceTimersByTime(45_000 * 2 + 1);
		expect(ws.closed).toBe(true);
		expect(ws.closeCode).toBe(4000);
	});

	// --- 基础 ---

	test('heartbeat is cleared after disconnect()', () => {
		const { conn } = makeConnected();
		conn.disconnect();
		expect(conn.__hbInterval).toBeNull();
		expect(conn.__hbTimer).toBeNull();
		expect(conn.__hbMissCount).toBe(0);
	});

	test('missCount resets on startHeartbeat (reconnect scenario)', () => {
		const { conn } = makeConnected();
		vi.advanceTimersByTime(45_001);
		expect(conn.__hbMissCount).toBe(1);
		conn.__startHeartbeat();
		expect(conn.__hbMissCount).toBe(0);
	});
});

describe('BotConnection – reconnect', () => {
	beforeEach(() => {
		MockWebSocket.reset();
		vi.useFakeTimers();
	});
	afterEach(() => vi.useRealTimers());

	test('schedules reconnect after non-intentional WS close', () => {
		const { conn, ws } = makeConnected();
		ws.simulateClose(1006, 'abnormal');
		expect(conn.__reconnectTimer).not.toBeNull();
	});

	test('reconnects by creating a new WS after delay', () => {
		const { ws } = makeConnected();
		ws.simulateClose(1006);
		// at this point 1 instance exists; advance to trigger reconnect
		vi.advanceTimersByTime(1500); // > INITIAL_RECONNECT_MS considering jitter
		expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
	});

	test('doubles reconnect delay on each attempt (exponential backoff)', () => {
		const { conn, ws } = makeConnected();
		const delay1 = conn.__reconnectDelay; // should be 1000
		ws.simulateClose(1006);
		vi.advanceTimersByTime(1500);
		// after first reconnect fires, delay should double
		expect(conn.__reconnectDelay).toBe(delay1 * 2);
	});

	test('reconnect delay is capped at MAX_RECONNECT_MS (30s)', () => {
		const { conn, ws } = makeConnected();
		conn.__reconnectDelay = 20_000;
		ws.simulateClose(1006);
		vi.advanceTimersByTime(30_001);
		expect(conn.__reconnectDelay).toBe(30_000);
	});

	test('does not reconnect after intentional disconnect()', () => {
		const { conn, ws } = makeConnected();
		conn.disconnect();
		// ws close event will fire internally via ws.close() but intentionalClose=true
		ws.simulateClose(1000);
		vi.advanceTimersByTime(5000);
		expect(MockWebSocket.instances.length).toBe(1);
	});

	test('WS constructor throwing schedules reconnect', () => {
		MockWebSocket.reset();
		let callCount = 0;
		class FailingWS extends MockWebSocket {
			constructor(url) {
				if (callCount++ === 0) throw new Error('connection refused');
				super(url);
			}
		}
		const conn = new BotConnection('b1', { baseUrl: 'http://localhost', WebSocket: FailingWS });
		conn.connect();
		expect(conn.state).toBe('disconnected');
		expect(conn.__reconnectTimer).not.toBeNull();
	});
});

describe('BotConnection – no reconnect after intentional disconnect', () => {
	beforeEach(() => {
		MockWebSocket.reset();
		vi.useFakeTimers();
	});
	afterEach(() => vi.useRealTimers());

	test('after session.expired, WS close does not trigger further reconnect', () => {
		const { ws } = makeConnected();
		ws.simulateMessage({ type: 'session.expired' });
		// session.expired calls disconnect() which sets intentionalClose=true
		// then WS close event should not schedule reconnect
		ws.simulateClose(1000);
		vi.advanceTimersByTime(5000);
		expect(MockWebSocket.instances.length).toBe(1);
	});

	test('after bot.unbound, no reconnect is scheduled', () => {
		const { conn, ws } = makeConnected();
		ws.simulateMessage({ type: 'bot.unbound' });
		vi.advanceTimersByTime(5000);
		expect(conn.__reconnectTimer).toBeNull();
		expect(MockWebSocket.instances.length).toBe(1);
	});
});

describe('BotConnection – stale WS guard', () => {
	beforeEach(() => MockWebSocket.reset());

	test('open event on old WS after reconnect does not change state to connected', () => {
		const { conn, ws: oldWs } = makeConnected();
		// 断开（非主动），触发重连
		conn.__intentionalClose = false;
		oldWs.simulateClose(1006, 'abnormal');
		// 此时 conn.__ws 为 null，state 为 disconnected，等待重连定时器
		// 直接模拟：手动调用 __doConnect 产生新 WS
		conn.__doConnect();
		const newWs = MockWebSocket.lastInstance;
		expect(newWs).not.toBe(oldWs);

		// 在新 WS open 之前，触发旧 WS 的 open 事件（过期事件）
		oldWs.readyState = 1;
		(oldWs.__listeners['open'] ?? []).forEach(cb => cb());

		// 状态不应变为 connected，因为 this.__ws !== oldWs
		expect(conn.state).toBe('connecting');

		// 新 WS open 后状态才变为 connected
		newWs.simulateOpen();
		expect(conn.state).toBe('connected');
	});
});

describe('BotConnection – visibility change reconnect', () => {
	let savedDoc;
	let mockDoc;

	beforeEach(() => {
		MockWebSocket.reset();
		vi.useFakeTimers();
		// 模拟 document
		savedDoc = globalThis.document;
		mockDoc = {
			visibilityState: 'visible',
			__listeners: {},
			addEventListener(evt, cb) {
				if (!this.__listeners[evt]) this.__listeners[evt] = [];
				this.__listeners[evt].push(cb);
			},
			removeEventListener(evt, cb) {
				if (!this.__listeners[evt]) return;
				this.__listeners[evt] = this.__listeners[evt].filter(fn => fn !== cb);
			},
			simulateVisibility(state) {
				this.visibilityState = state;
				(this.__listeners['visibilitychange'] ?? []).forEach(cb => cb());
			},
		};
		globalThis.document = mockDoc;
	});

	afterEach(() => {
		vi.useRealTimers();
		globalThis.document = savedDoc;
	});

	test('connect() registers visibilitychange listener on document', () => {
		const conn = new BotConnection('b1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		conn.connect();
		expect(mockDoc.__listeners['visibilitychange']?.length).toBe(1);
	});

	test('listener is registered only once even if connect() called multiple times', () => {
		const conn = new BotConnection('b1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		conn.connect();
		conn.__ws = null; // 模拟 ws 已关闭
		conn.connect();
		expect(mockDoc.__listeners['visibilitychange']?.length).toBe(1);
	});

	test('visibility→visible while disconnected triggers immediate reconnect', () => {
		const { conn, ws } = makeConnected();
		ws.simulateClose(1006, 'abnormal'); // 非主动断连
		expect(conn.state).toBe('disconnected');
		expect(conn.__reconnectTimer).not.toBeNull();

		mockDoc.simulateVisibility('visible');

		// 应立即发起新连接，不等待 backoff 计时器
		expect(MockWebSocket.instances.length).toBe(2);
		expect(conn.state).toBe('connecting');
	});

	test('visibility→visible resets reconnect delay to INITIAL_RECONNECT_MS', () => {
		const { conn, ws } = makeConnected();
		conn.__reconnectDelay = 16000; // 模拟已累积的 backoff
		ws.simulateClose(1006);
		mockDoc.simulateVisibility('visible');
		expect(conn.__reconnectDelay).toBe(1000);
	});

	test('visibility→visible cancels pending backoff timer', () => {
		const { conn, ws } = makeConnected();
		ws.simulateClose(1006);
		const oldTimer = conn.__reconnectTimer;
		expect(oldTimer).not.toBeNull();
		mockDoc.simulateVisibility('visible');
		expect(conn.__reconnectTimer).toBeNull(); // timer 已清除（doConnect 中会再建新 WS，不需要 timer）
	});

	test('visibility→hidden does not trigger reconnect', () => {
		const { ws } = makeConnected();
		ws.simulateClose(1006);
		mockDoc.simulateVisibility('hidden');
		// 不应产生新 WS
		expect(MockWebSocket.instances.length).toBe(1);
	});

	test('visibility→visible while connected does nothing', () => {
		const { conn } = makeConnected();
		expect(conn.state).toBe('connected');
		// lastAliveAt 已由 __resetHbTimeout 在 open 后设置
		mockDoc.simulateVisibility('visible');
		expect(MockWebSocket.instances.length).toBe(1);
		expect(conn.state).toBe('connected');
	});

	test('visibility→visible after intentional disconnect does not reconnect', () => {
		const { conn } = makeConnected();
		conn.disconnect();
		mockDoc.simulateVisibility('visible');
		expect(MockWebSocket.instances.length).toBe(1);
		expect(conn.state).toBe('disconnected');
	});

	test('disconnect() removes visibilitychange listener', () => {
		const { conn } = makeConnected();
		expect(mockDoc.__listeners['visibilitychange']?.length).toBe(1);
		conn.disconnect();
		expect((mockDoc.__listeners['visibilitychange'] ?? []).length).toBe(0);
	});

	test('bot.unbound removes visibilitychange listener', () => {
		const { conn, ws } = makeConnected();
		expect(mockDoc.__listeners['visibilitychange']?.length).toBe(1);
		ws.simulateMessage({ type: 'bot.unbound' });
		expect((mockDoc.__listeners['visibilitychange'] ?? []).length).toBe(0);
	});
});

describe('BotConnection – sendRaw()', () => {
	beforeEach(() => MockWebSocket.reset());

	test('发送成功返回 true', () => {
		const { conn, ws } = makeConnected();
		const payload = { type: 'rtc:offer', payload: { sdp: 'test' } };
		const result = conn.sendRaw(payload);
		expect(result).toBe(true);
		expect(ws.sent).toContain(JSON.stringify(payload));
		conn.disconnect();
	});

	test('未连接时返回 false', () => {
		const conn = new BotConnection('bot1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		expect(conn.sendRaw({ type: 'test' })).toBe(false);
	});

	test('ws.send 抛异常时返回 false', () => {
		const { conn, ws } = makeConnected();
		ws.failOnSend = true;
		expect(conn.sendRaw({ type: 'test' })).toBe(false);
		conn.disconnect();
	});
});

describe('BotConnection – rtc: 事件分发', () => {
	beforeEach(() => MockWebSocket.reset());

	test('rtc: 前缀消息 emit 到 rtc 事件', () => {
		const { conn, ws } = makeConnected();
		const handler = vi.fn();
		conn.on('rtc', handler);
		const msg = { type: 'rtc:answer', payload: { sdp: 'answer-sdp' } };
		ws.simulateMessage(msg);
		expect(handler).toHaveBeenCalledWith(msg);
		conn.disconnect();
	});

	test('rtc:ice 消息也被分发', () => {
		const { conn, ws } = makeConnected();
		const handler = vi.fn();
		conn.on('rtc', handler);
		const msg = { type: 'rtc:ice', payload: { candidate: 'c1' } };
		ws.simulateMessage(msg);
		expect(handler).toHaveBeenCalledWith(msg);
		conn.disconnect();
	});

	test('非 rtc: 消息不触发 rtc 事件', () => {
		const { conn, ws } = makeConnected();
		const handler = vi.fn();
		conn.on('rtc', handler);
		ws.simulateMessage({ type: 'event', event: 'agent', payload: {} });
		expect(handler).not.toHaveBeenCalled();
		conn.disconnect();
	});

	test('pong 消息不触发 rtc 事件', () => {
		const { conn, ws } = makeConnected();
		const handler = vi.fn();
		conn.on('rtc', handler);
		ws.simulateMessage({ type: 'pong' });
		expect(handler).not.toHaveBeenCalled();
		conn.disconnect();
	});

	test('rtc: 消息不会继续到 event 或 res 处理', () => {
		const { conn, ws } = makeConnected();
		const eventHandler = vi.fn();
		conn.on('event:answer', eventHandler);
		ws.simulateMessage({ type: 'rtc:answer', payload: { sdp: 'x' } });
		expect(eventHandler).not.toHaveBeenCalled();
		conn.disconnect();
	});
});

describe('BotConnection – RTC 管理', () => {
	beforeEach(() => MockWebSocket.reset());

	test('setRtc/clearRtc 管理 RTC 引用', () => {
		const conn = new BotConnection('b1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		const mockRtc = { isReady: true, send: vi.fn() };
		conn.setRtc(mockRtc);
		expect(conn.__rtc).toBe(mockRtc);
		conn.clearRtc();
		expect(conn.__rtc).toBeNull();
	});

	test('大 payload 走 DC（WebRtcConnection 内部自动分片）', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const largeParams = { data: 'x'.repeat(70_000) };
		conn.request('agent', largeParams).catch(() => {});
		expect(mockRtc.send).toHaveBeenCalledTimes(1);
		expect(mockRtc.send.mock.calls[0][0].method).toBe('agent');
		conn.disconnect();
	});

	test('clearRtc reject 所有挂起请求（RTC_LOST）', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const p = conn.request('slow.method');
		expect(conn.__pending.size).toBe(1);

		conn.clearRtc();

		await expect(p).rejects.toMatchObject({ code: 'RTC_LOST' });
		expect(conn.__pending.size).toBe(0);
		expect(conn.rtc).toBeNull();
	});

	test('clearRtc 后新请求 reject DC_NOT_READY', async () => {
		const { conn } = makeRtcReady();
		conn.clearRtc();
		await expect(conn.request('foo')).rejects.toMatchObject({ code: 'DC_NOT_READY' });
	});
});

describe('BotConnection – __onRtcMessage()', () => {
	beforeEach(() => MockWebSocket.reset());

	test('处理 DC res 消息', async () => {
		const { conn, mockRtc } = makeRtcReady();
		const p = conn.request('test');
		const reqId = mockRtc.send.mock.calls[0][0].id;

		conn.__onRtcMessage({ type: 'res', id: reqId, ok: true, payload: { result: 42 } });
		const res = await p;
		expect(res).toEqual({ result: 42 });
		conn.disconnect();
	});

	test('处理 DC event 消息', () => {
		const { conn } = makeConnected();
		const handler = vi.fn();
		conn.on('event:agent', handler);

		conn.__onRtcMessage({ type: 'event', event: 'agent', payload: { data: 'test' } });
		expect(handler).toHaveBeenCalledWith({ data: 'test' });
		conn.disconnect();
	});
});

describe('BotConnection – WS 始终忽略业务消息', () => {
	beforeEach(() => MockWebSocket.reset());

	test('WS event 消息被忽略', () => {
		const { conn, ws } = makeConnected();
		const handler = vi.fn();
		conn.on('event:agent', handler);
		ws.simulateMessage({ type: 'event', event: 'agent', payload: { x: 1 } });
		expect(handler).not.toHaveBeenCalled();
		conn.disconnect();
	});

	test('WS res 消息被忽略', () => {
		const { conn, ws, mockRtc } = makeRtcReady();
		conn.request('test').catch(() => {});
		const reqId = mockRtc.send.mock.calls[0][0].id;
		ws.simulateMessage({ type: 'res', id: reqId, ok: true, payload: {} });
		expect(conn.__pending.has(reqId)).toBe(true);
		conn.disconnect();
	});

	test('WS 仍处理 rtc: 信令消息', () => {
		const { conn, ws } = makeConnected();
		const handler = vi.fn();
		conn.on('rtc', handler);
		ws.simulateMessage({ type: 'rtc:answer', payload: { sdp: 'x' } });
		expect(handler).toHaveBeenCalled();
		conn.disconnect();
	});

	test('WS 仍处理 session.expired', () => {
		const { conn, ws } = makeConnected();
		const handler = vi.fn();
		conn.on('session-expired', handler);
		ws.simulateMessage({ type: 'session.expired' });
		expect(handler).toHaveBeenCalled();
	});
});

describe('BotConnection – WS close 不影响 DC pending', () => {
	beforeEach(() => MockWebSocket.reset());

	test('WS close 不 reject 任何 pending 请求', () => {
		const { conn, ws, mockRtc } = makeRtcReady();
		conn.request('slow').catch(() => {});
		expect(conn.__pending.size).toBe(1);

		ws.simulateClose(1006, 'abnormal');

		// pending 不受影响
		expect(conn.__pending.size).toBe(1);
		conn.disconnect();
	});
});

// =====================================================================
// Phase 3: 连接感知增强
// =====================================================================

describe('BotConnection – lastAliveAt / disconnectedAt', () => {
	beforeEach(() => {
		MockWebSocket.reset();
		vi.useFakeTimers();
	});
	afterEach(() => vi.useRealTimers());

	test('lastAliveAt 初始为 0', () => {
		const conn = new BotConnection('b1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		expect(conn.lastAliveAt).toBe(0);
	});

	test('连接建立后 lastAliveAt 被设置', () => {
		const { conn } = makeConnected();
		expect(conn.lastAliveAt).toBeGreaterThan(0);
	});

	test('收到消息时 lastAliveAt 更新', () => {
		const { conn, ws } = makeConnected();
		const t1 = conn.lastAliveAt;
		vi.advanceTimersByTime(100);
		ws.simulateMessage({ type: 'pong' });
		expect(conn.lastAliveAt).toBeGreaterThan(t1);
	});

	test('disconnectedAt 在断连时记录', () => {
		const { conn, ws } = makeConnected();
		expect(conn.disconnectedAt).toBe(0);
		ws.simulateClose(1006);
		expect(conn.disconnectedAt).toBeGreaterThan(0);
	});

	test('disconnectDuration 返回断连持续时长', () => {
		const { conn, ws } = makeConnected();
		// 主动断开以保持 disconnected 状态（不自动重连）
		conn.disconnect();
		vi.advanceTimersByTime(3000);
		expect(conn.disconnectDuration).toBeGreaterThanOrEqual(3000);
	});

	test('disconnectDuration 非 disconnected 状态时返回 0', () => {
		const { conn } = makeConnected();
		expect(conn.disconnectDuration).toBe(0);
	});
});

describe('BotConnection – probe()', () => {
	beforeEach(() => {
		MockWebSocket.reset();
		vi.useFakeTimers();
	});
	afterEach(() => vi.useRealTimers());

	test('发送 ping 并在超时后 forceReconnect', () => {
		const { conn, ws } = makeConnected();
		conn.probe();

		// 应发送了 ping
		const pings = ws.sent.filter((s) => JSON.parse(s).type === 'ping');
		expect(pings.length).toBeGreaterThanOrEqual(1);

		// 推进到超时
		vi.advanceTimersByTime(2500);

		// 应触发 forceReconnect → 新 WS 实例
		expect(MockWebSocket.instances.length).toBe(2);
	});

	test('probe 期间收到消息则不 forceReconnect', () => {
		const { conn, ws } = makeConnected();
		conn.probe();

		// 模拟收到 pong
		vi.advanceTimersByTime(1000);
		ws.simulateMessage({ type: 'pong' });

		// 推进到超时
		vi.advanceTimersByTime(2000);

		// 不应创建新 WS
		expect(MockWebSocket.instances.length).toBe(1);
	});

	test('重复调用 probe 不会创建多个定时器', () => {
		const { conn } = makeConnected();
		conn.probe();
		conn.probe();
		expect(conn.__probeTimer).not.toBeNull();

		// 超时后只触发一次
		vi.advanceTimersByTime(3000);
		expect(MockWebSocket.instances.length).toBe(2);
	});

	test('WS 已关闭时直接 forceReconnect', () => {
		const { conn, ws } = makeConnected();
		ws.readyState = 3; // CLOSED
		conn.__ws = ws;
		conn.probe();
		// 直接创建新连接
		expect(MockWebSocket.instances.length).toBe(2);
	});
});

describe('BotConnection – forceReconnect()', () => {
	beforeEach(() => {
		MockWebSocket.reset();
		vi.useFakeTimers();
	});
	afterEach(() => vi.useRealTimers());

	test('关闭旧连接并立即重连', () => {
		const { conn, ws } = makeConnected();
		expect(conn.state).toBe('connected');
		conn.forceReconnect();

		expect(ws.closed).toBe(true);
		expect(ws.closeCode).toBe(4000);
		expect(MockWebSocket.instances.length).toBe(2);
		expect(conn.state).toBe('connecting');
	});

	test('不影响 DC pending 请求', () => {
		const { conn } = makeRtcReady();
		conn.request('slow').catch(() => {});
		expect(conn.__pending.size).toBe(1);

		conn.forceReconnect();

		// pending 不受影响（在 DC 上）
		expect(conn.__pending.size).toBe(1);
		conn.disconnect();
	});

	test('intentionalClose 时不 forceReconnect', () => {
		const { conn } = makeConnected();
		conn.disconnect();
		MockWebSocket.reset();
		conn.forceReconnect();
		expect(MockWebSocket.instances.length).toBe(0);
	});

	test('重置 reconnectDelay', () => {
		const { conn } = makeConnected();
		conn.__reconnectDelay = 16000;
		conn.forceReconnect();
		expect(conn.__reconnectDelay).toBe(1000);
	});

	test('disconnectedAt 修正为 lastAliveAt 以反映真实断连时长', () => {
		const { conn } = makeConnected();
		const aliveAt = conn.lastAliveAt;
		expect(aliveAt).toBeGreaterThan(0);

		// 模拟长时间后台：推进时间但不发送消息
		vi.advanceTimersByTime(60_000);

		conn.forceReconnect();

		// disconnectedAt 应被修正为 lastAliveAt（而非 forceReconnect 的调用时间）
		expect(conn.disconnectedAt).toBe(aliveAt);
	});
});

describe('BotConnection – foreground resume (app:foreground)', () => {
	let savedDoc;
	let savedWin;
	let mockDoc;
	let mockWin;

	beforeEach(() => {
		MockWebSocket.reset();
		vi.useFakeTimers();
		savedDoc = globalThis.document;
		savedWin = globalThis.window;
		mockDoc = {
			visibilityState: 'visible',
			__listeners: {},
			addEventListener(evt, cb) {
				if (!this.__listeners[evt]) this.__listeners[evt] = [];
				this.__listeners[evt].push(cb);
			},
			removeEventListener(evt, cb) {
				if (!this.__listeners[evt]) return;
				this.__listeners[evt] = this.__listeners[evt].filter(fn => fn !== cb);
			},
		};
		mockWin = {
			__listeners: {},
			addEventListener(evt, cb) {
				if (!this.__listeners[evt]) this.__listeners[evt] = [];
				this.__listeners[evt].push(cb);
			},
			removeEventListener(evt, cb) {
				if (!this.__listeners[evt]) return;
				this.__listeners[evt] = this.__listeners[evt].filter(fn => fn !== cb);
			},
			dispatchEvent(event) {
				(this.__listeners[event.type] ?? []).forEach(cb => cb(event));
			},
		};
		globalThis.document = mockDoc;
		globalThis.window = mockWin;
	});

	afterEach(() => {
		vi.useRealTimers();
		globalThis.document = savedDoc;
		globalThis.window = savedWin;
	});

	test('connect() 注册 app:foreground 监听器', () => {
		const conn = new BotConnection('b1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		conn.connect();
		expect(mockWin.__listeners['app:foreground']?.length).toBe(1);
	});

	test('disconnect() 注销 app:foreground 监听器', () => {
		const conn = new BotConnection('b1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		conn.connect();
		MockWebSocket.lastInstance.simulateOpen();
		conn.disconnect();
		expect((mockWin.__listeners['app:foreground'] ?? []).length).toBe(0);
	});

	test('disconnected 状态下收到 foreground → 即时重连', () => {
		const conn = new BotConnection('b1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		conn.connect();
		const ws = MockWebSocket.lastInstance;
		ws.simulateOpen();
		ws.simulateClose(1006);
		expect(conn.state).toBe('disconnected');

		mockWin.dispatchEvent(new Event('app:foreground'));

		expect(MockWebSocket.instances.length).toBe(2);
		expect(conn.state).toBe('connecting');
	});

	test('connected + lastAliveAt 超过 ASSUME_DEAD → forceReconnect', () => {
		const conn = new BotConnection('b1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		conn.connect();
		MockWebSocket.lastInstance.simulateOpen();
		expect(conn.state).toBe('connected');

		// 模拟长时间后台
		vi.advanceTimersByTime(50_000);

		mockWin.dispatchEvent(new Event('app:foreground'));

		// 应触发 forceReconnect
		expect(MockWebSocket.instances.length).toBe(2);
	});

	test('connected + lastAliveAt 在探测范围内 → probe', () => {
		const conn = new BotConnection('b1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		conn.connect();
		MockWebSocket.lastInstance.simulateOpen();

		// 模拟中等时长后台（大于 PROBE_TIMEOUT 但小于 ASSUME_DEAD）
		vi.advanceTimersByTime(10_000);

		mockWin.dispatchEvent(new Event('app:foreground'));

		// 应发起 probe（发 ping），不立即创建新 WS
		expect(MockWebSocket.instances.length).toBe(1);
		expect(conn.__probeTimer).not.toBeNull();
	});

	test('connected + lastAliveAt 很新 → 不操作', () => {
		const conn = new BotConnection('b1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		conn.connect();
		MockWebSocket.lastInstance.simulateOpen();

		// lastAliveAt 刚设置，elapsed ≈ 0
		mockWin.dispatchEvent(new Event('app:foreground'));

		expect(MockWebSocket.instances.length).toBe(1);
		expect(conn.__probeTimer).toBeNull();
	});

	test('500ms 节流：重复触发不重复执行', () => {
		const conn = new BotConnection('b1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		conn.connect();
		MockWebSocket.lastInstance.simulateOpen();
		MockWebSocket.lastInstance.simulateClose(1006);

		mockWin.dispatchEvent(new Event('app:foreground'));
		expect(MockWebSocket.instances.length).toBe(2);

		// 立即再次触发 → 被节流
		mockWin.dispatchEvent(new Event('app:foreground'));
		expect(MockWebSocket.instances.length).toBe(2);

		// 500ms 后可以再次触发
		vi.advanceTimersByTime(500);
		MockWebSocket.instances[1].simulateClose(1006);
		mockWin.dispatchEvent(new Event('app:foreground'));
		expect(MockWebSocket.instances.length).toBe(3);
	});
});

describe('BotConnection – network:online', () => {
	let savedDoc;
	let savedWin;
	let mockDoc;
	let mockWin;

	beforeEach(() => {
		MockWebSocket.reset();
		vi.useFakeTimers();
		savedDoc = globalThis.document;
		savedWin = globalThis.window;
		mockDoc = {
			visibilityState: 'visible',
			__listeners: {},
			addEventListener(evt, cb) {
				if (!this.__listeners[evt]) this.__listeners[evt] = [];
				this.__listeners[evt].push(cb);
			},
			removeEventListener(evt, cb) {
				if (!this.__listeners[evt]) return;
				this.__listeners[evt] = this.__listeners[evt].filter(fn => fn !== cb);
			},
		};
		mockWin = {
			__listeners: {},
			addEventListener(evt, cb) {
				if (!this.__listeners[evt]) this.__listeners[evt] = [];
				this.__listeners[evt].push(cb);
			},
			removeEventListener(evt, cb) {
				if (!this.__listeners[evt]) return;
				this.__listeners[evt] = this.__listeners[evt].filter(fn => fn !== cb);
			},
			dispatchEvent(event) {
				(this.__listeners[event.type] ?? []).forEach(cb => cb(event));
			},
		};
		globalThis.document = mockDoc;
		globalThis.window = mockWin;
	});

	afterEach(() => {
		vi.useRealTimers();
		globalThis.document = savedDoc;
		globalThis.window = savedWin;
	});

	test('connect() 注册 network:online 监听器', () => {
		const conn = new BotConnection('b1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		conn.connect();
		expect(mockWin.__listeners['network:online']?.length).toBe(1);
	});

	test('disconnect() 注销 network:online 监听器', () => {
		const conn = new BotConnection('b1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		conn.connect();
		MockWebSocket.lastInstance.simulateOpen();
		conn.disconnect();
		expect((mockWin.__listeners['network:online'] ?? []).length).toBe(0);
	});

	test('disconnected 状态下收到 network:online → 即时重连', () => {
		const conn = new BotConnection('b1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		conn.connect();
		const ws = MockWebSocket.lastInstance;
		ws.simulateOpen();
		ws.simulateClose(1006);
		expect(conn.state).toBe('disconnected');

		mockWin.dispatchEvent(new Event('network:online'));

		expect(MockWebSocket.instances.length).toBe(2);
		expect(conn.state).toBe('connecting');
	});

	test('connected + 长时间静默 → forceReconnect', () => {
		const conn = new BotConnection('b1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		conn.connect();
		MockWebSocket.lastInstance.simulateOpen();

		vi.advanceTimersByTime(50_000);

		mockWin.dispatchEvent(new Event('network:online'));

		expect(MockWebSocket.instances.length).toBe(2);
	});
});
