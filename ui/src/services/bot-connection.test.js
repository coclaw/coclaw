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

// 工厂：创建一个连接并推进到 'connected' 状态（默认 WS 传输模式）
function makeConnected(botId = 'bot1', extra = {}) {
	MockWebSocket.reset();
	const conn = new BotConnection(botId, { baseUrl: 'http://localhost:3000', WebSocket: MockWebSocket, ...extra });
	conn.connect();
	const ws = MockWebSocket.lastInstance;
	ws.simulateOpen();
	conn.setTransportMode('ws');
	return { conn, ws };
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

	test('rejects all pending RPCs with WS_CLOSED', async () => {
		const { conn } = makeConnected();
		// 手动添加一个 pending 不走 send（保持 readyState=1 再 disconnect）
		const p = conn.request('some.method');
		conn.disconnect();
		await expect(p).rejects.toMatchObject({ code: 'WS_CLOSED' });
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

	test('disconnect() rejects pending RPC with WS_CLOSED not RPC_TIMEOUT when timeout is active', async () => {
		vi.useFakeTimers();
		try {
			const { conn } = makeConnected();
			const p = conn.request('x', {}, { timeout: 5000 });
			conn.disconnect();
			await expect(p).rejects.toMatchObject({ code: 'WS_CLOSED' });
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('BotConnection – request()', () => {
	beforeEach(() => MockWebSocket.reset());

	test('sends JSON message via WS', async () => {
		const { conn, ws } = makeConnected();
		// respond immediately in next microtask
		const responsePromise = conn.request('ping.me', { x: 1 });
		// extract sent message
		expect(ws.sent.length).toBe(1);
		const msg = JSON.parse(ws.sent[0]);
		expect(msg.type).toBe('req');
		expect(msg.method).toBe('ping.me');
		expect(msg.params).toEqual({ x: 1 });
		expect(msg.id).toMatch(/^ui-/);
		// resolve it
		ws.simulateMessage({ type: 'res', id: msg.id, ok: true, payload: { result: 42 } });
		const res = await responsePromise;
		expect(res).toEqual({ result: 42 });
	});

	test('rejects with WS_CLOSED when transportMode is null but WS is not connected', async () => {
		const conn = new BotConnection('b1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
	        await expect(conn.request('foo')).rejects.toMatchObject({ code: 'WS_CLOSED' });
	});
	test('rejects with RPC_FAILED when server responds ok=false', async () => {
		const { conn, ws } = makeConnected();
		const p = conn.request('bad.method');
		const msg = JSON.parse(ws.sent[0]);
		ws.simulateMessage({ type: 'res', id: msg.id, ok: false, error: { code: 'NOT_FOUND', message: 'not found' } });
		await expect(p).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'not found' });
	});

	test('uses default error code RPC_FAILED when error.code missing', async () => {
		const { conn, ws } = makeConnected();
		const p = conn.request('bad.method');
		const msg = JSON.parse(ws.sent[0]);
		ws.simulateMessage({ type: 'res', id: msg.id, ok: false, error: { message: 'oops' } });
		await expect(p).rejects.toMatchObject({ code: 'RPC_FAILED' });
	});

	test('resolves immediately (no onAccepted) on any ok=true response', async () => {
		const { conn, ws } = makeConnected();
		const p = conn.request('simple');
		const msg = JSON.parse(ws.sent[0]);
		ws.simulateMessage({ type: 'res', id: msg.id, ok: true, payload: { status: 'accepted' } });
		const res = await p;
		expect(res).toEqual({ status: 'accepted' });
	});

	test('increments counter for unique IDs', () => {
		const { conn, ws } = makeConnected();
		conn.request('a');
		conn.request('b');
		const id1 = JSON.parse(ws.sent[0]).id;
		const id2 = JSON.parse(ws.sent[1]).id;
		expect(id1).not.toBe(id2);
	});

	test('rejects with WS_SEND_FAILED when ws.send() throws', async () => {
		const { conn, ws } = makeConnected();
		ws.failOnSend = true;
		await expect(conn.request('some.method')).rejects.toMatchObject({ code: 'WS_SEND_FAILED' });
	});

	test('rejects with WS_CLOSED when readyState is CONNECTING (transportMode=null)', async () => {
		MockWebSocket.reset();
		const conn = new BotConnection('b1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		conn.connect(); // WS created but open not simulated, transportMode stays null
		await expect(conn.request('foo')).rejects.toMatchObject({ code: 'WS_CLOSED' });
	});
});

describe('BotConnection – request() two-phase (onAccepted)', () => {
	beforeEach(() => MockWebSocket.reset());

	test('calls onAccepted when status=accepted and does not resolve yet', async () => {
		const { conn, ws } = makeConnected();
		const accepted = vi.fn();
		const p = conn.request('slow.op', {}, { onAccepted: accepted });
		const msg = JSON.parse(ws.sent[0]);

		ws.simulateMessage({ type: 'res', id: msg.id, ok: true, payload: { status: 'accepted', token: 'tok' } });
		await Promise.resolve(); // flush microtasks
		expect(accepted).toHaveBeenCalledWith({ status: 'accepted', token: 'tok' });
		// promise should still be pending — check via race
		let settled = false;
		p.then(() => { settled = true; }).catch(() => { settled = true; });
		await Promise.resolve();
		expect(settled).toBe(false);

		// now send terminal status
		ws.simulateMessage({ type: 'res', id: msg.id, ok: true, payload: { status: 'ok', data: 123 } });
		const res = await p;
		expect(res).toEqual({ status: 'ok', data: 123 });
	});

	test('resolves on terminal status=error (ok=true, two-phase)', async () => {
		const { conn, ws } = makeConnected();
		const p = conn.request('slow.op', {}, { onAccepted: vi.fn() });
		const msg = JSON.parse(ws.sent[0]);
		ws.simulateMessage({ type: 'res', id: msg.id, ok: true, payload: { status: 'accepted' } });
		ws.simulateMessage({ type: 'res', id: msg.id, ok: true, payload: { status: 'error', reason: 'fail' } });
		const res = await p;
		expect(res.status).toBe('error');
	});

	test('calls onUnknownStatus for unrecognised intermediate status', async () => {
		const { conn, ws } = makeConnected();
		const onUnknown = vi.fn();
		conn.request('slow.op', {}, { onAccepted: vi.fn(), onUnknownStatus: onUnknown });
		const msg = JSON.parse(ws.sent[0]);
		ws.simulateMessage({ type: 'res', id: msg.id, ok: true, payload: { status: 'processing' } });
		await Promise.resolve();
		expect(onUnknown).toHaveBeenCalledWith('processing', { status: 'processing' });
	});

	test('ok=false with no error field rejects with message "rpc failed" and code RPC_FAILED', async () => {
		const { conn, ws } = makeConnected();
		const p = conn.request('some.method');
		const msg = JSON.parse(ws.sent[0]);
		ws.simulateMessage({ type: 'res', id: msg.id, ok: false }); // no error field
		await expect(p).rejects.toMatchObject({ message: 'rpc failed', code: 'RPC_FAILED' });
	});

	test('unknown intermediate status without onUnknownStatus keeps promise pending', async () => {
		const { conn, ws } = makeConnected();
		const p = conn.request('slow.op', {}, { onAccepted: vi.fn() }); // no onUnknownStatus
		const msg = JSON.parse(ws.sent[0]);
		ws.simulateMessage({ type: 'res', id: msg.id, ok: true, payload: { status: 'processing' } });
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
		const { conn } = makeConnected();
		const p = conn.request('slow', {}, { timeout: 5000 });
		vi.advanceTimersByTime(5001);
		await expect(p).rejects.toMatchObject({ code: 'RPC_TIMEOUT' });
	});

	test('does not reject before timeout elapses', async () => {
		const { conn, ws } = makeConnected();
		const p = conn.request('slow', {}, { timeout: 5000 });
		vi.advanceTimersByTime(3000);
		const msg = JSON.parse(ws.sent[0]);
		ws.simulateMessage({ type: 'res', id: msg.id, ok: true, payload: {} });
		const res = await p;
		expect(res).toEqual({});
	});

	test('cleans up pending entry after timeout', async () => {
		const { conn } = makeConnected();
		const p = conn.request('slow', {}, { timeout: 1000 });
		vi.advanceTimersByTime(1001);
		await expect(p).rejects.toBeDefined();
		expect(conn.__pending.size).toBe(0);
	});

	test('applies default 30-minute timeout when no explicit timeout given', async () => {
		const { conn } = makeConnected();
		const p = conn.request('longRunning');
		expect(conn.__pending.size).toBe(1);
		// 29 分钟后仍 pending
		vi.advanceTimersByTime(29 * 60_000);
		expect(conn.__pending.size).toBe(1);
		// 30 分钟后超时
		vi.advanceTimersByTime(1 * 60_000 + 1);
		await expect(p).rejects.toMatchObject({ code: 'RPC_TIMEOUT' });
		expect(conn.__pending.size).toBe(0);
	});

	test('late response after timeout is silently ignored', async () => {
		const { conn, ws } = makeConnected();
		const p = conn.request('slow', {}, { timeout: 1000 });
		const msg = JSON.parse(ws.sent[0]);
		vi.advanceTimersByTime(1001);
		await expect(p).rejects.toMatchObject({ code: 'RPC_TIMEOUT' });
		// 迟到的响应不应抛错
		expect(() => {
			ws.simulateMessage({ type: 'res', id: msg.id, ok: true, payload: { late: true } });
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
		const { conn, ws } = makeConnected();
		const mockRtc = { close: vi.fn() };
		conn.setRtc(mockRtc);
		conn.setTransportMode('rtc');

		ws.simulateMessage({ type: 'session.expired' });

		expect(mockRtc.close).toHaveBeenCalled();
		expect(conn.__rtc).toBeNull();
		expect(conn.transportMode).toBeNull();
	});

	test('bot.unbound 清理 RTC 状态', () => {
		const { conn, ws } = makeConnected();
		const mockRtc = { close: vi.fn() };
		conn.setRtc(mockRtc);
		conn.setTransportMode('rtc');

		ws.simulateMessage({ type: 'bot.unbound' });

		expect(mockRtc.close).toHaveBeenCalled();
		expect(conn.__rtc).toBeNull();
		expect(conn.transportMode).toBeNull();
	});

	test('disconnect() 清理 RTC 状态', () => {
		const { conn } = makeConnected();
		const mockRtc = { close: vi.fn() };
		conn.setRtc(mockRtc);
		conn.setTransportMode('rtc');

		conn.disconnect();

		expect(mockRtc.close).toHaveBeenCalled();
		expect(conn.__rtc).toBeNull();
		expect(conn.transportMode).toBeNull();
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
		const { conn, ws } = makeConnected();
		const p = conn.request('something');
		ws.simulateMessage({ type: 'bot.unbound' });
		await expect(p).rejects.toMatchObject({ code: 'WS_CLOSED' });
	});

	test('invalid JSON message is silently ignored', () => {
		const { ws } = makeConnected();
		expect(() => ws.simulateMessage('not json {')).not.toThrow();
	});

	test('res message without id does not throw and does not affect pending', async () => {
		const { conn, ws } = makeConnected();
		const p = conn.request('some.method');
		const msg = JSON.parse(ws.sent[0]);
		// 发送一条无 id 的 res 消息
		expect(() => ws.simulateMessage({ type: 'res', ok: true })).not.toThrow();
		// 原 pending 未受影响，仍可正常 resolve
		ws.simulateMessage({ type: 'res', id: msg.id, ok: true, payload: { done: true } });
		const res = await p;
		expect(res).toEqual({ done: true });
	});
});

describe('BotConnection – server push events', () => {
	beforeEach(() => MockWebSocket.reset());

	test('type=event dispatches to event:<name> listener', () => {
		const { conn, ws } = makeConnected();
		const cb = vi.fn();
		conn.on('event:message.new', cb);
		ws.simulateMessage({ type: 'event', event: 'message.new', payload: { text: 'hi' } });
		expect(cb).toHaveBeenCalledWith({ text: 'hi' });
	});

	test('type=event with no matching listener does not throw', () => {
		const { ws } = makeConnected();
		expect(() => {
			ws.simulateMessage({ type: 'event', event: 'some.unheard.event', payload: {} });
		}).not.toThrow();
	});

	test('type=event without event field is ignored', () => {
		const { conn, ws } = makeConnected();
		const cb = vi.fn();
		conn.on('event:', cb);
		ws.simulateMessage({ type: 'event' }); // no event field
		expect(cb).not.toHaveBeenCalled();
	});
});

describe('BotConnection – heartbeat (two-layer: miss + pending suppression)', () => {
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

	// --- pending 抑制 ---

	test('with pending RPC, suppresses close beyond base miss limit', () => {
		const { conn, ws } = makeConnected();
		conn.request('slowMethod');
		expect(conn.__pending.size).toBe(1);
		// 2 次 miss（基础上限）→ 有 pending，不关闭
		vi.advanceTimersByTime(45_000 * 2 + 1);
		expect(ws.closed).toBe(false);
		expect(conn.__hbMissCount).toBe(2);
		// 继续第 3 次 miss → 仍不关闭
		vi.advanceTimersByTime(45_000);
		expect(ws.closed).toBe(false);
		expect(conn.__hbMissCount).toBe(3);
	});

	test('with pending RPC, closes after suppress limit (2+4=6 misses, ~270s)', () => {
		const { conn, ws } = makeConnected();
		conn.request('slowMethod');
		// 6 × 45s = 270s → 抑制上限
		vi.advanceTimersByTime(45_000 * 6 + 1);
		expect(ws.closed).toBe(true);
		expect(ws.closeCode).toBe(4000);
	});

	test('with pending RPC, does not close at 5 misses (just under suppress limit)', () => {
		const { conn, ws } = makeConnected();
		conn.request('slowMethod');
		vi.advanceTimersByTime(45_000 * 5 + 1);
		expect(ws.closed).toBe(false);
		expect(conn.__hbMissCount).toBe(5);
	});

	test('message during suppression resets everything', () => {
		const { conn, ws } = makeConnected();
		conn.request('slowMethod');
		// 进入抑制模式（miss=3，超过基础上限）
		vi.advanceTimersByTime(45_000 * 3 + 1);
		expect(conn.__hbMissCount).toBe(3);
		expect(ws.closed).toBe(false);
		// 收到消息 → 全部重置
		ws.simulateMessage({ type: 'pong' });
		expect(conn.__hbMissCount).toBe(0);
		// 需重新积累 6 次 miss 才断连（pending 仍在）
		vi.advanceTimersByTime(45_000 * 5 + 1);
		expect(ws.closed).toBe(false);
		vi.advanceTimersByTime(45_000);
		expect(ws.closed).toBe(true);
	});

	test('pending cleared during suppression → closes at next miss', () => {
		const { conn, ws } = makeConnected();
		conn.request('slowMethod').catch(() => {}); // 忽略 reject（连接关闭时触发）
		// 进入抑制模式
		vi.advanceTimersByTime(45_000 * 3 + 1);
		expect(ws.closed).toBe(false);
		// 模拟 RPC 完成 → pending 清空
		const reqMsg = JSON.parse(ws.sent[0]);
		ws.simulateMessage({ type: 'res', id: reqMsg.id, ok: true, payload: {} });
		// 收到消息会重置 missCount
		expect(conn.__hbMissCount).toBe(0);
		expect(conn.__pending.size).toBe(0);
		// 无 pending → 2 次 miss 后断连
		vi.advanceTimersByTime(45_000 * 2 + 1);
		expect(ws.closed).toBe(true);
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

// --- Phase 2: 传输模式 ---

describe('BotConnection – transportMode (Phase 2)', () => {
	beforeEach(() => MockWebSocket.reset());

	test('初始 transportMode 为 null', () => {
		const conn = new BotConnection('b1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		expect(conn.transportMode).toBeNull();
	});

	test('setTransportMode 设置模式', () => {
		const conn = new BotConnection('b1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		conn.setTransportMode('rtc');
		expect(conn.transportMode).toBe('rtc');
		conn.setTransportMode('ws');
		expect(conn.transportMode).toBe('ws');
	});

	test('setRtc/clearRtc 管理 RTC 引用', () => {
		const conn = new BotConnection('b1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		const mockRtc = { isReady: true, send: vi.fn() };
		conn.setRtc(mockRtc);
		expect(conn.__rtc).toBe(mockRtc);
		conn.clearRtc();
		expect(conn.__rtc).toBeNull();
	});

	test('RTC→WS 降级时 reject viaRtc 的挂起请求', () => {
		const { conn } = makeConnected();
		// 模拟 RTC 模式下有挂起请求
		const waiter = { reject: vi.fn(), timer: null, viaRtc: true };
		conn.__pending.set('test-1', waiter);
		const wsWaiter = { reject: vi.fn(), timer: null, viaRtc: false };
		conn.__pending.set('test-2', wsWaiter);

		conn.setTransportMode('rtc');
		conn.setTransportMode('ws'); // RTC→WS 降级

		expect(waiter.reject).toHaveBeenCalled();
		expect(waiter.reject.mock.calls[0][0].code).toBe('RTC_LOST');
		expect(wsWaiter.reject).not.toHaveBeenCalled();
		expect(conn.__pending.has('test-1')).toBe(false);
		expect(conn.__pending.has('test-2')).toBe(true);
		conn.disconnect();
	});
});

describe('BotConnection – request() via RTC', () => {
	beforeEach(() => MockWebSocket.reset());

	test('transportMode=rtc 时通过 DataChannel 发送', () => {
		const { conn } = makeConnected();
		const mockRtc = { isReady: true, send: vi.fn().mockResolvedValue() };
		conn.setRtc(mockRtc);
		conn.setTransportMode('rtc');

		conn.request('test.method', { key: 'val' }).catch(() => {});

		expect(mockRtc.send).toHaveBeenCalledTimes(1);
		const sent = mockRtc.send.mock.calls[0][0];
		expect(sent.type).toBe('req');
		expect(sent.method).toBe('test.method');
		expect(sent.params).toEqual({ key: 'val' });
		conn.disconnect();
	});

	test('transportMode=rtc 且 RTC 不可用时降级到 WS 并发送请求', async () => {
		const { conn, ws } = makeConnected();
		conn.setTransportMode('rtc');
		// 未设置 rtc 引用 → RTC 不可用，应降级并回退 WS
		const p = conn.request('foo');
		// 验证 transportMode 已降级
		expect(conn.transportMode).toBe('ws');
		expect(ws.sent.length).toBe(1);
		const msg = JSON.parse(ws.sent[0]);
		expect(msg.method).toBe('foo');

		// 模拟 WS 响应
		ws.simulateMessage({ type: 'res', id: msg.id, ok: true, payload: { bar: 1 } });
		await expect(p).resolves.toMatchObject({ bar: 1 });
		conn.disconnect();
	});

	test('transportMode=rtc 降级到 WS 后 event 消息能正确分发', () => {
		const { conn, ws } = makeConnected();
		conn.setTransportMode('rtc');
		// 触发降级
		conn.request('foo').catch(() => {});
		expect(conn.transportMode).toBe('ws');

		// 降级后 WS event 应能正常分发
		const handler = vi.fn();
		conn.on('event:agent', handler);
		ws.simulateMessage({ type: 'event', event: 'agent', payload: { text: 'hello' } });
		expect(handler).toHaveBeenCalledWith({ text: 'hello' });
		conn.disconnect();
	});

	test('transportMode=rtc 且 RTC 不可用且 WS 也不可用时 reject WS_CLOSED', async () => {
		const { conn, ws } = makeConnected();
		conn.setTransportMode('rtc');
		// 模拟 WS 已断开
		ws.readyState = 3;
		await expect(conn.request('foo')).rejects.toMatchObject({ code: 'WS_CLOSED' });
		// WS 不可用时也应降级 transportMode（避免后续请求重复尝试 RTC）
		expect(conn.transportMode).toBe('ws');
		conn.disconnect();
	});

	test('RTC 降级到 WS 时 reject 所有 pending RTC 请求', async () => {
		const { conn } = makeConnected();
		const mockRtc = {
			isReady: true,
			send: vi.fn().mockResolvedValue(undefined),
		};
		conn.setRtc(mockRtc);
		conn.setTransportMode('rtc');

		// 发起一个 RTC 请求使其 pending
		const p = conn.request('slow.method');

		// 触发降级
		conn.setTransportMode('ws');

		// pending RTC 请求应被 reject
		await expect(p).rejects.toMatchObject({ code: 'RTC_LOST' });
		conn.disconnect();
	});

	test('RTC 降级后恢复：setTransportMode(rtc) 后请求走 RTC', async () => {
		const { conn, ws } = makeConnected();
		conn.setTransportMode('rtc');
		// RTC 不可用 → 降级到 WS
		conn.request('degraded.method').catch(() => {});
		expect(conn.transportMode).toBe('ws');

		// 模拟 RTC 恢复
		const mockRtc = {
			isReady: true,
			send: vi.fn().mockResolvedValue(undefined),
		};
		conn.setRtc(mockRtc);
		conn.setTransportMode('rtc');

		// 后续请求应走 RTC
		conn.request('restored.method').catch(() => {});
		expect(mockRtc.send).toHaveBeenCalled();
		const sent = mockRtc.send.mock.calls[0][0];
		expect(sent.method).toBe('restored.method');
		// WS 不应收到这个请求
		const wsMethodsSent = ws.sent.map((s) => JSON.parse(s).method);
		expect(wsMethodsSent).not.toContain('restored.method');
		conn.disconnect();
	});

	test('transportMode=rtc 且 send 返回 rejected Promise 时 reject RTC_SEND_FAILED', async () => {
		const { conn } = makeConnected();
		const mockRtc = { isReady: true, send: vi.fn().mockRejectedValue(new Error('dc error')) };
		conn.setRtc(mockRtc);
		conn.setTransportMode('rtc');

		await expect(conn.request('foo')).rejects.toMatchObject({ code: 'RTC_SEND_FAILED' });
		conn.disconnect();
	});

	test('transportMode=null 时使用 WS 发送请求 (Phase 2 双通道过渡)', async () => {
		const { conn, ws } = makeConnected();
		conn.setTransportMode(null);
		const p = conn.request('foo');
		expect(ws.sent.length).toBe(1);
		const msg = JSON.parse(ws.sent[0]);
		expect(msg.method).toBe('foo');

		// 模拟 WS 响应
		ws.simulateMessage({ type: 'res', id: msg.id, ok: true, payload: { result: 'ok' } });
		await expect(p).resolves.toMatchObject({ result: 'ok' });
		conn.disconnect();
	});

	test('transportMode=null 期间发送的请求在 transportMode 变为 rtc 后，依然能处理来自 WS 的响应 (Phase 2)', async () => {
		const { conn, ws } = makeConnected();
		conn.setTransportMode(null);
		const p = conn.request('foo');
		expect(ws.sent.length).toBe(1);
		const msg = JSON.parse(ws.sent[0]);

		// 模拟通道切换
		conn.setTransportMode('rtc');

		// 模拟 WS 响应
		ws.simulateMessage({ type: 'res', id: msg.id, ok: true, payload: { result: 'ok' } });
		await expect(p).resolves.toMatchObject({ result: 'ok' });
		conn.disconnect();
	});
});

describe('BotConnection – __onRtcMessage()', () => {
	beforeEach(() => MockWebSocket.reset());

	test('transportMode=rtc 时处理 RTC res 消息', async () => {
		const { conn } = makeConnected();
		const mockRtc = { isReady: true, send: vi.fn().mockResolvedValue() };
		conn.setRtc(mockRtc);
		conn.setTransportMode('rtc');

		const p = conn.request('test');
		const reqId = mockRtc.send.mock.calls[0][0].id;

		conn.__onRtcMessage({ type: 'res', id: reqId, ok: true, payload: { result: 42 } });
		const res = await p;
		expect(res).toEqual({ result: 42 });
		conn.disconnect();
	});

	test('transportMode=rtc 时处理 RTC event 消息', () => {
		const { conn } = makeConnected();
		conn.setTransportMode('rtc');
		const handler = vi.fn();
		conn.on('event:agent', handler);

		conn.__onRtcMessage({ type: 'event', event: 'agent', payload: { data: 'test' } });
		expect(handler).toHaveBeenCalledWith({ data: 'test' });
		conn.disconnect();
	});

	test('transportMode=ws 时忽略 RTC 消息', () => {
		const { conn } = makeConnected();
		// transportMode 已被 makeConnected 设为 'ws'
		const handler = vi.fn();
		conn.on('event:agent', handler);

		conn.__onRtcMessage({ type: 'event', event: 'agent', payload: { data: 'test' } });
		expect(handler).not.toHaveBeenCalled();
		conn.disconnect();
	});
});

describe('BotConnection – WS 消息在 RTC 模式下被忽略', () => {
	beforeEach(() => MockWebSocket.reset());

	test('transportMode=rtc 时忽略 WS 业务消息(event)', () => {
		const { conn, ws } = makeConnected();
		conn.setTransportMode('rtc');
		const handler = vi.fn();
		conn.on('event:agent', handler);

		ws.simulateMessage({ type: 'event', event: 'agent', payload: { x: 1 } });
		expect(handler).not.toHaveBeenCalled();
		conn.disconnect();
	});

	test('transportMode=rtc 时忽略 WS 业务消息(res)', () => {
		const { conn, ws } = makeConnected();
		const mockRtc = { isReady: true, send: vi.fn().mockResolvedValue() };
		conn.setRtc(mockRtc);
		conn.setTransportMode('rtc');

		// 通过 RTC 发请求
		conn.request('test').catch(() => {}); // disconnect 时会 reject
		const reqId = mockRtc.send.mock.calls[0][0].id;

		// WS 收到同 ID 的 res → 应被忽略
		ws.simulateMessage({ type: 'res', id: reqId, ok: true, payload: {} });
		// 请求应仍在 pending 中
		expect(conn.__pending.has(reqId)).toBe(true);
		conn.disconnect();
	});

	test('transportMode=rtc 时仍处理 rtc: 信令消息', () => {
		const { conn, ws } = makeConnected();
		conn.setTransportMode('rtc');
		const handler = vi.fn();
		conn.on('rtc', handler);

		ws.simulateMessage({ type: 'rtc:answer', payload: { sdp: 'x' } });
		expect(handler).toHaveBeenCalled();
		conn.disconnect();
	});

	test('transportMode=rtc 时仍处理 session.expired', () => {
		const { conn, ws } = makeConnected();
		conn.setTransportMode('rtc');
		const handler = vi.fn();
		conn.on('session-expired', handler);

		ws.simulateMessage({ type: 'session.expired' });
		expect(handler).toHaveBeenCalled();
	});
});

describe('BotConnection – WS close 时 RTC 模式保留 RTC pending', () => {
	beforeEach(() => MockWebSocket.reset());

	test('transportMode=rtc 时 WS close 仅 reject viaRtc=false 的请求', () => {
		const { conn, ws } = makeConnected();
		conn.setTransportMode('rtc');

		const rtcWaiter = { reject: vi.fn(), timer: null, viaRtc: true };
		const wsWaiter = { reject: vi.fn(), timer: null, viaRtc: false };
		conn.__pending.set('rtc-1', rtcWaiter);
		conn.__pending.set('ws-1', wsWaiter);

		ws.simulateClose(1006, 'abnormal');

		expect(wsWaiter.reject).toHaveBeenCalled();
		expect(rtcWaiter.reject).not.toHaveBeenCalled();
		expect(conn.__pending.has('rtc-1')).toBe(true);
		expect(conn.__pending.has('ws-1')).toBe(false);

		// 清理以避免 unhandled rejection
		conn.__pending.clear();
		conn.disconnect();
	});
});
