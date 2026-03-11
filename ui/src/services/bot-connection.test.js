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

// 工厂：创建一个连接并推进到 'connected' 状态
function makeConnected(botId = 'bot1', extra = {}) {
	MockWebSocket.reset();
	const conn = new BotConnection(botId, { baseUrl: 'http://localhost:3000', WebSocket: MockWebSocket, ...extra });
	conn.connect();
	const ws = MockWebSocket.lastInstance;
	ws.simulateOpen();
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

	test('rejects with WS_CLOSED when not connected', async () => {
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

	test('rejects with WS_CLOSED when readyState is CONNECTING (0)', async () => {
		MockWebSocket.reset();
		const conn = new BotConnection('b1', { baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		conn.connect(); // WS created but open not simulated, readyState stays 0
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

	test('heartbeat timeout closes WS after 45s without message', () => {
		const { ws } = makeConnected();
		vi.advanceTimersByTime(45_001);
		expect(ws.closed).toBe(true);
		expect(ws.closeCode).toBe(4000);
	});

	test('receiving a message resets heartbeat timeout', () => {
		const { ws } = makeConnected();
		// advance 30s, receive a message, advance another 30s — still open
		vi.advanceTimersByTime(30_000);
		ws.simulateMessage({ type: 'pong' });
		vi.advanceTimersByTime(30_000);
		expect(ws.closed).toBe(false);
	});

	test('heartbeat is cleared after disconnect()', () => {
		const { conn } = makeConnected();
		conn.disconnect();
		expect(conn.__hbInterval).toBeNull();
		expect(conn.__hbTimer).toBeNull();
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
