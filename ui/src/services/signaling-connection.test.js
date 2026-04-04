import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// mock platform 检测（默认非 Capacitor）
vi.mock('../utils/platform.js', () => ({ isCapacitorApp: false }));
import * as platformMod from '../utils/platform.js';

import {
	SignalingConnection,
	useSignalingConnection,
	__resetSignalingConnection,
} from './signaling-connection.js';

// --- MockWebSocket ---

class MockWebSocket {
	constructor(url) {
		this.url = url;
		this.readyState = 0;
		this.__listeners = {};
		this.sent = [];
		this.closed = false;
		this.closeCode = null;
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
		this.sent.push(data);
	}
	close(code, reason) {
		this.closed = true;
		this.closeCode = code;
		this.readyState = 3;
	}
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
	static reset() {
		MockWebSocket.lastInstance = null;
		MockWebSocket.instances = [];
	}
}
MockWebSocket.instances = [];
MockWebSocket.lastInstance = null;

function makeConnected() {
	MockWebSocket.reset();
	const conn = new SignalingConnection({ baseUrl: 'http://localhost:3000', WebSocket: MockWebSocket });
	conn.connect();
	const ws = MockWebSocket.lastInstance;
	ws.simulateOpen();
	return { conn, ws };
}

beforeEach(() => {
	vi.useFakeTimers();
	MockWebSocket.reset();
});

afterEach(() => {
	vi.useRealTimers();
});

// --- 测试套件 ---

describe('SignalingConnection – constructor', () => {
	test('初始状态为 disconnected', () => {
		const conn = new SignalingConnection({ baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		expect(conn.state).toBe('disconnected');
	});
});

describe('SignalingConnection – connect()', () => {
	test('连接后状态变为 connecting → connected', () => {
		const states = [];
		const conn = new SignalingConnection({ baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		conn.on('state', s => states.push(s));
		conn.connect();
		expect(conn.state).toBe('connecting');
		MockWebSocket.lastInstance.simulateOpen();
		expect(conn.state).toBe('connected');
		expect(states).toEqual(['connecting', 'connected']);
	});

	test('幂等：已连接时不重复创建 WS', () => {
		const { conn } = makeConnected();
		conn.connect();
		expect(MockWebSocket.instances.length).toBe(1);
	});

	test('WS URL 使用 /api/v1/rtc/signal 路径', () => {
		const conn = new SignalingConnection({ baseUrl: 'http://localhost:3000', WebSocket: MockWebSocket });
		conn.connect();
		expect(MockWebSocket.lastInstance.url).toContain('/api/v1/rtc/signal');
	});

	test('https base URL 生成 wss WS URL', () => {
		const conn = new SignalingConnection({ baseUrl: 'https://example.com', WebSocket: MockWebSocket });
		conn.connect();
		expect(MockWebSocket.lastInstance.url).toMatch(/^wss:/);
	});
});

describe('SignalingConnection – log 事件', () => {
	test('状态变更时发射 log 事件', () => {
		const logs = [];
		const conn = new SignalingConnection({ baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		conn.on('log', (text) => logs.push(text));
		conn.connect();
		MockWebSocket.lastInstance.simulateOpen();
		expect(logs).toEqual([
			'sig.state disconnected→connecting',
			'sig.state connecting→connected',
		]);
	});

	test('WS 关闭时发射 log 事件', () => {
		const logs = [];
		const { conn, ws } = makeConnected();
		conn.on('log', (text) => logs.push(text));
		ws.simulateClose(1006, '');
		expect(logs.some((l) => l.startsWith('sig.close'))).toBe(true);
	});

	test('心跳超时时发射 log 事件', () => {
		const logs = [];
		const { conn } = makeConnected();
		conn.on('log', (text) => logs.push(text));
		// 两次心跳超时 → max miss
		vi.advanceTimersByTime(45_000);
		vi.advanceTimersByTime(45_000);
		expect(logs.some((l) => l.startsWith('sig.hbTimeout'))).toBe(true);
	});
});

describe('SignalingConnection – disconnect()', () => {
	test('主动断开后不自动重连', () => {
		const { conn, ws } = makeConnected();
		conn.disconnect();
		expect(conn.state).toBe('disconnected');
		vi.advanceTimersByTime(60_000);
		expect(MockWebSocket.instances.length).toBe(1); // 未创建新 WS
	});
});

describe('SignalingConnection – connId 管理', () => {
	test('getOrCreateConnId 生成并缓存 connId', () => {
		const conn = new SignalingConnection({ baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		const id1 = conn.getOrCreateConnId('bot1');
		const id2 = conn.getOrCreateConnId('bot1');
		expect(id1).toBe(id2);
		expect(id1).toMatch(/^c_/);
	});

	test('不同 botId 生成不同 connId', () => {
		const conn = new SignalingConnection({ baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		const id1 = conn.getOrCreateConnId('bot1');
		const id2 = conn.getOrCreateConnId('bot2');
		expect(id1).not.toBe(id2);
	});

	test('releaseConnId 移除 connId 并发送 rtc:closed', () => {
		const { conn, ws } = makeConnected();
		const connId = conn.getOrCreateConnId('bot1');
		conn.releaseConnId('bot1');
		// 应发送 rtc:closed
		const msgs = ws.sent.map(s => JSON.parse(s));
		const closedMsg = msgs.find(m => m.type === 'rtc:closed');
		expect(closedMsg).toBeTruthy();
		expect(closedMsg.connId).toBe(connId);
		expect(closedMsg.botId).toBe('bot1');
		// 再次 getOrCreateConnId 应生成新的 connId
		const newId = conn.getOrCreateConnId('bot1');
		expect(newId).not.toBe(connId);
	});

	test('releaseConnId 对不存在的 botId 无副作用', () => {
		const { conn, ws } = makeConnected();
		conn.releaseConnId('nonexistent');
		// 无 rtc:closed 消息
		expect(ws.sent.length).toBe(0);
	});
});

describe('SignalingConnection – sendSignaling()', () => {
	test('WS 可用时发送消息并返回 true', () => {
		const { conn, ws } = makeConnected();
		const ok = conn.sendSignaling('bot1', 'rtc:offer', { sdp: 'test-sdp' });
		expect(ok).toBe(true);
		const msg = JSON.parse(ws.sent[0]);
		expect(msg.type).toBe('rtc:offer');
		expect(msg.botId).toBe('bot1');
		expect(msg.connId).toMatch(/^c_/);
		expect(msg.payload).toEqual({ sdp: 'test-sdp' });
	});

	test('无 payload 时消息不含 payload 字段', () => {
		const { conn, ws } = makeConnected();
		conn.sendSignaling('bot1', 'rtc:ready');
		const msg = JSON.parse(ws.sent[0]);
		expect(msg.type).toBe('rtc:ready');
		expect(msg).not.toHaveProperty('payload');
	});

	test('WS 不可用时返回 false', () => {
		const conn = new SignalingConnection({ baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		const ok = conn.sendSignaling('bot1', 'rtc:offer', { sdp: 'x' });
		expect(ok).toBe(false);
	});

	test('同一 botId 多次发送使用相同 connId', () => {
		const { conn, ws } = makeConnected();
		conn.sendSignaling('bot1', 'rtc:offer', { sdp: '1' });
		conn.sendSignaling('bot1', 'rtc:ice', { candidate: 'c1' });
		const msg1 = JSON.parse(ws.sent[0]);
		const msg2 = JSON.parse(ws.sent[1]);
		expect(msg1.connId).toBe(msg2.connId);
	});
});

describe('SignalingConnection – 入站 RTC 信令', () => {
	test('rtc:answer 按 toConnId 路由到对应 botId', () => {
		const { conn, ws } = makeConnected();
		const connId = conn.getOrCreateConnId('bot1');
		const events = [];
		conn.on('rtc', (e) => events.push(e));
		ws.simulateMessage({ type: 'rtc:answer', toConnId: connId, payload: { sdp: 'ans' } });
		expect(events.length).toBe(1);
		expect(events[0].botId).toBe('bot1');
		expect(events[0].type).toBe('rtc:answer');
		expect(events[0].payload).toEqual({ sdp: 'ans' });
	});

	test('rtc:ice 按 toConnId 路由', () => {
		const { conn, ws } = makeConnected();
		const connId = conn.getOrCreateConnId('bot2');
		const events = [];
		conn.on('rtc', (e) => events.push(e));
		ws.simulateMessage({ type: 'rtc:ice', toConnId: connId, payload: { candidate: 'c' } });
		expect(events.length).toBe(1);
		expect(events[0].botId).toBe('bot2');
	});

	test('未知 toConnId 的消息被忽略', () => {
		const { conn, ws } = makeConnected();
		const events = [];
		conn.on('rtc', (e) => events.push(e));
		ws.simulateMessage({ type: 'rtc:answer', toConnId: 'c_unknown', payload: {} });
		expect(events.length).toBe(0);
	});
});

describe('SignalingConnection – resume 协议已移除', () => {
	test('重连后不发送 signal:resume', () => {
		const { conn, ws } = makeConnected();
		conn.getOrCreateConnId('bot1');
		// 模拟 WS 断开 + 重连
		ws.simulateClose(1006);
		vi.advanceTimersByTime(2000);
		const ws2 = MockWebSocket.lastInstance;
		ws2.simulateOpen();
		const msgs = ws2.sent.map(s => JSON.parse(s));
		expect(msgs.find(m => m.type === 'signal:resume')).toBeUndefined();
	});

	test('WS open 后 5s 内 ensureConnected verify 不触发 forceReconnect', async () => {
		const { conn, ws } = makeConnected();
		// WS 刚打开，__lastVerifiedAt 已被标记
		const p = conn.ensureConnected({ verify: true });
		// 不应创建新 WS（verify 被冷却降级）
		expect(MockWebSocket.lastInstance).toBe(ws);
		await p;
	});

	test('入站 signal:resumed 消息被忽略（不触发事件）', () => {
		const { conn, ws } = makeConnected();
		const events = [];
		conn.on('resumed', () => events.push(true));
		ws.simulateMessage({ type: 'signal:resumed' });
		expect(events.length).toBe(0);
	});
});

describe('SignalingConnection – 心跳', () => {
	test('连接后定期发送 ping', () => {
		const { ws } = makeConnected();
		vi.advanceTimersByTime(25_000);
		const pings = ws.sent.filter(s => JSON.parse(s).type === 'ping');
		expect(pings.length).toBeGreaterThanOrEqual(1);
	});

	test('连续 miss 后关闭 WS 并重连', () => {
		const { conn, ws } = makeConnected();
		// 模拟不收到任何 pong → 心跳超时
		vi.advanceTimersByTime(45_000); // 第一次 miss
		vi.advanceTimersByTime(45_000); // 第二次 miss → 关闭 WS
		expect(conn.state).toBe('disconnected');
		// 应安排重连
		vi.advanceTimersByTime(2000);
		expect(MockWebSocket.instances.length).toBeGreaterThan(1);
	});
});

describe('SignalingConnection – 重连', () => {
	test('WS 异常关闭后自动重连', () => {
		const { conn, ws } = makeConnected();
		ws.simulateClose(1006, 'abnormal');
		expect(conn.state).toBe('disconnected');
		vi.advanceTimersByTime(2000);
		expect(MockWebSocket.instances.length).toBe(2);
	});

	test('指数退避：第二次重连延迟更长', () => {
		const { conn, ws } = makeConnected();
		ws.simulateClose(1006);
		// 第一次重连 ~1s（含 jitter 最大 1.3s）
		vi.advanceTimersByTime(1500);
		const ws2 = MockWebSocket.lastInstance;
		expect(ws2).not.toBe(ws); // 确认已创建新 WS
		ws2.simulateClose(1006);
		// 第二次重连 ~2s（指数退避，含 jitter 最大 2.6s）
		vi.advanceTimersByTime(3000);
		expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(3);
	});
});

describe('SignalingConnection – 前台恢复', () => {
	afterEach(() => {
		platformMod.isCapacitorApp = false;
	});

	test('Capacitor + visibility → 发出 foreground-resume（含 payload）', () => {
		platformMod.isCapacitorApp = true;
		const { conn } = makeConnected();
		const events = [];
		conn.on('foreground-resume', (data) => events.push(data));
		vi.advanceTimersByTime(1000);
		conn.__handleForegroundResume('visibility');
		expect(events.length).toBe(1);
		expect(events[0]).toHaveProperty('source', 'visibility');
		expect(events[0]).toHaveProperty('elapsed');
	});

	test('桌面 visibility → 不发出 foreground-resume', () => {
		platformMod.isCapacitorApp = false;
		const { conn } = makeConnected();
		const events = [];
		conn.on('foreground-resume', () => events.push(true));
		vi.advanceTimersByTime(1000);
		conn.__handleForegroundResume('visibility');
		expect(events.length).toBe(0);
	});

	test('network:online → 全平台发出 foreground-resume', () => {
		platformMod.isCapacitorApp = false;
		const { conn } = makeConnected();
		const events = [];
		conn.on('foreground-resume', (data) => events.push(data));
		vi.advanceTimersByTime(1000);
		conn.__handleForegroundResume('network:online');
		expect(events.length).toBe(1);
		expect(events[0].source).toBe('network:online');
	});

	test('disconnected 状态下前台恢复触发即时重连', () => {
		const { conn, ws } = makeConnected();
		ws.simulateClose(1006);
		expect(conn.state).toBe('disconnected');
		vi.advanceTimersByTime(600); // 过节流期
		conn.__handleForegroundResume('network:online');
		// 应创建新 WS
		expect(MockWebSocket.instances.length).toBeGreaterThan(1);
	});

	test('disconnected + Capacitor → 发出 foreground-resume（elapsed=Infinity）', () => {
		platformMod.isCapacitorApp = true;
		const { conn, ws } = makeConnected();
		ws.simulateClose(1006);
		const events = [];
		conn.on('foreground-resume', (data) => events.push(data));
		vi.advanceTimersByTime(600);
		conn.__handleForegroundResume('app:foreground');
		expect(events.length).toBe(1);
		expect(events[0].elapsed).toBe(Infinity);
	});

	test('network:online 不受 throttle 限制', () => {
		platformMod.isCapacitorApp = true;
		const { conn } = makeConnected();
		const events = [];
		conn.on('foreground-resume', (data) => events.push(data));
		vi.advanceTimersByTime(1000);
		// 先触发 app:foreground
		conn.__handleForegroundResume('app:foreground');
		expect(events.length).toBe(1);
		// 立即触发 network:online（间隔 < 500ms），不应被节流抑制
		conn.__handleForegroundResume('network:online');
		expect(events.length).toBe(2);
		expect(events[1].source).toBe('network:online');
	});

	test('network:online + connected + elapsed 很小时仍 forceReconnect', () => {
		const { conn } = makeConnected();
		// lastAliveAt 刚被设为 now（elapsed 约 0）
		const wsBefore = MockWebSocket.instances.length;
		conn.__handleForegroundResume('network:online');
		// 应触发 forceReconnect → 创建新 WS
		expect(MockWebSocket.instances.length).toBeGreaterThan(wsBefore);
	});

	test('network:online + connecting 状态时仍发射 foreground-resume', () => {
		MockWebSocket.reset();
		const conn = new SignalingConnection({ baseUrl: 'http://localhost:3000', WebSocket: MockWebSocket });
		conn.connect(); // state → connecting，不 simulateOpen
		expect(conn.state).toBe('connecting');
		const events = [];
		conn.on('foreground-resume', (data) => events.push(data));
		conn.__handleForegroundResume('network:online');
		expect(events.length).toBe(1);
		expect(events[0].source).toBe('network:online');
		expect(events[0].elapsed).toBe(Infinity);
	});

	test('非 network:online 在 connecting 状态不发射 foreground-resume', () => {
		platformMod.isCapacitorApp = true;
		MockWebSocket.reset();
		const conn = new SignalingConnection({ baseUrl: 'http://localhost:3000', WebSocket: MockWebSocket });
		conn.connect(); // state → connecting，不 simulateOpen
		expect(conn.state).toBe('connecting');
		const events = [];
		conn.on('foreground-resume', (data) => events.push(data));
		conn.__handleForegroundResume('app:foreground');
		expect(events.length).toBe(0);
		conn.__handleForegroundResume('visibility');
		expect(events.length).toBe(0);
	});

	test('throttle 对非 network:online 事件仍生效', () => {
		platformMod.isCapacitorApp = true;
		const { conn } = makeConnected();
		const events = [];
		conn.on('foreground-resume', (data) => events.push(data));
		vi.advanceTimersByTime(1000);
		// 第一次 app:foreground 正常触发
		conn.__handleForegroundResume('app:foreground');
		expect(events.length).toBe(1);
		const wsBefore = MockWebSocket.instances.length;
		// 立即再次触发（间隔 < 500ms），应被节流抑制
		conn.__handleForegroundResume('app:foreground');
		expect(events.length).toBe(1); // 未新增事件
		expect(MockWebSocket.instances.length).toBe(wsBefore); // 未 forceReconnect
	});

	test('connected + elapsed > ASSUME_DEAD_MS → forceReconnect', () => {
		platformMod.isCapacitorApp = true;
		const { conn } = makeConnected();
		const events = [];
		conn.on('foreground-resume', (data) => events.push(data));
		// 推进时间超过 ASSUME_DEAD_MS（45s）
		vi.advanceTimersByTime(46_000);
		const wsBefore = MockWebSocket.instances.length;
		conn.__handleForegroundResume('app:foreground');
		// 应触发 forceReconnect → 创建新 WS
		expect(MockWebSocket.instances.length).toBeGreaterThan(wsBefore);
		// 应发射 foreground-resume（Capacitor 平台）
		expect(events.length).toBe(1);
		expect(events[0].source).toBe('app:foreground');
	});

	test('connected + elapsed > PROBE_TIMEOUT_MS 但 < ASSUME_DEAD_MS 且 lastAliveAt > 0 → probe', () => {
		platformMod.isCapacitorApp = true;
		const { conn } = makeConnected();
		const probeSpy = vi.spyOn(conn, 'probe');
		const events = [];
		conn.on('foreground-resume', (data) => events.push(data));
		// 推进时间超过 PROBE_TIMEOUT_MS（2.5s）但不超过 ASSUME_DEAD_MS（45s）
		vi.advanceTimersByTime(5_000);
		conn.__handleForegroundResume('app:foreground');
		// 应触发 probe
		expect(probeSpy).toHaveBeenCalledTimes(1);
		// 应发射 foreground-resume（Capacitor 平台）
		expect(events.length).toBe(1);
		expect(events[0].source).toBe('app:foreground');
		probeSpy.mockRestore();
	});

	test('connected + network:online 既 forceReconnect 又发射 foreground-resume', () => {
		const { conn } = makeConnected();
		const events = [];
		conn.on('foreground-resume', (data) => events.push(data));
		// lastAliveAt 在 makeConnected 中的 simulateOpen 时已设为 now，elapsed 很小
		const wsBefore = MockWebSocket.instances.length;
		conn.__handleForegroundResume('network:online');
		// forceReconnect 应创建新 WS
		expect(MockWebSocket.instances.length).toBeGreaterThan(wsBefore);
		// foreground-resume 应被发射
		expect(events.length).toBe(1);
		expect(events[0].source).toBe('network:online');
		expect(events[0]).toHaveProperty('elapsed');
		expect(typeof events[0].elapsed).toBe('number');
	});

	test('连续 network:online：第二次在 connecting 状态不再 forceReconnect', () => {
		const { conn } = makeConnected();
		vi.advanceTimersByTime(1000);
		// 第一次：forceReconnect → state 变为 connecting
		conn.__handleForegroundResume('network:online');
		expect(conn.state).toBe('connecting');
		const wsCountAfterFirst = MockWebSocket.instances.length;
		// 第二次（WS 还在 connecting）：不会再次创建 WS
		conn.__handleForegroundResume('network:online');
		expect(MockWebSocket.instances.length).toBe(wsCountAfterFirst);
		expect(conn.state).toBe('connecting');
	});
});

describe('SignalingConnection – probe()', () => {
	test('探测成功：收到 pong 后不触发 forceReconnect', () => {
		const { conn, ws } = makeConnected();
		vi.advanceTimersByTime(100); // 推进时间使 lastAliveAt 可被区分
		conn.probe();
		// 模拟收到 pong（更新 lastAliveAt）
		ws.simulateMessage({ type: 'pong' });
		vi.advanceTimersByTime(3000);
		// 不应触发 forceReconnect（WS 仍是同一个实例）
		expect(MockWebSocket.instances.length).toBe(1);
	});

	test('探测超时触发 forceReconnect', () => {
		const { conn, ws } = makeConnected();
		conn.probe();
		// 不回复 pong → 2.5s 后超时
		vi.advanceTimersByTime(2600);
		// 应触发 forceReconnect → disconnected → 重连
		expect(MockWebSocket.instances.length).toBeGreaterThan(1);
	});

	test('ws 未连接时 probe 直接 forceReconnect', () => {
		const conn = new SignalingConnection({ baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		conn.connect();
		const ws = MockWebSocket.lastInstance;
		// ws 尚未 open，readyState = 0
		expect(ws.readyState).toBe(0);
		const instancesBefore = MockWebSocket.instances.length;
		conn.probe();
		// 应触发 forceReconnect → 创建新 WS
		vi.advanceTimersByTime(100);
		expect(MockWebSocket.instances.length).toBeGreaterThan(instancesBefore);
	});

	test('ws 为 null 时 probe 直接 forceReconnect', () => {
		const { conn } = makeConnected();
		// 强制置空 ws
		conn.__ws = null;
		const instancesBefore = MockWebSocket.instances.length;
		conn.probe();
		vi.advanceTimersByTime(100);
		expect(MockWebSocket.instances.length).toBeGreaterThan(instancesBefore);
	});

	test('__clearProbe 清除已有的 probeTimer', () => {
		const { conn } = makeConnected();
		// 发起 probe 后会设置 __probeTimer
		conn.probe();
		expect(conn.__probeTimer).not.toBeNull();
		// 调用 __clearProbe
		conn.__clearProbe();
		expect(conn.__probeTimer).toBeNull();
	});
});

describe('SignalingConnection – catch 路径日志', () => {
	test('WS constructor 失败时输出 warn 并重连', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const FailWS = function () { throw new Error('ws constructor boom'); };
		const conn = new SignalingConnection({ baseUrl: 'http://localhost', WebSocket: FailWS });
		conn.connect();
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[SigConn] WS constructor failed'), 'ws constructor boom');
		expect(conn.state).toBe('disconnected');
		warnSpy.mockRestore();
		conn.disconnect();
	});

	test('sendRaw 发送失败时输出 warn', () => {
		const { conn, ws } = makeConnected();
		ws.send = () => { throw new Error('send boom'); };
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const ok = conn.sendSignaling('bot1', 'rtc:offer', { sdp: 'x' });
		expect(ok).toBe(false);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[SigConn] sendRaw failed'), 'send boom');
		warnSpy.mockRestore();
	});

	test('JSON 解析失败时输出 warn', () => {
		const { conn, ws } = makeConnected();
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		ws.simulateMessage('not valid json {{{');
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[SigConn] message parse failed'), expect.any(String));
		warnSpy.mockRestore();
	});

	test('probe ping 发送失败时输出 debug 并 forceReconnect', () => {
		const { conn, ws } = makeConnected();
		ws.send = () => { throw new Error('probe send fail'); };
		const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
		conn.probe();
		expect(debugSpy).toHaveBeenCalledWith(
			expect.stringContaining('[SigConn] probe ping send failed'),
			expect.stringContaining('probe send fail'),
		);
		debugSpy.mockRestore();
	});

	test('入站 rtc:closed 清理 connId 映射', () => {
		const { conn, ws } = makeConnected();
		const connId = conn.getOrCreateConnId('bot1');
		const events = [];
		conn.on('rtc', (e) => events.push(e));
		ws.simulateMessage({ type: 'rtc:closed', toConnId: connId });
		// 应收到事件
		expect(events.length).toBe(1);
		expect(events[0].type).toBe('rtc:closed');
		// connId 应被清理：再次 getOrCreateConnId 应生成新的
		const newConnId = conn.getOrCreateConnId('bot1');
		expect(newConnId).not.toBe(connId);
	});
});

describe('SignalingConnection – ensureConnected', () => {
	test('connected + verify=false → 立即 resolve', async () => {
		const { conn } = makeConnected();
		await conn.ensureConnected({ verify: false });
		// 无 forceReconnect（仍是同一 WS）
		expect(MockWebSocket.instances.length).toBe(1);
		conn.disconnect();
	});

	test('connected + verify=true → forceReconnect → 等新 WS → resolve', async () => {
		const { conn } = makeConnected();
		// 等冷却过期（WS open 时标记了 __lastVerifiedAt）
		vi.advanceTimersByTime(5001);
		const p = conn.ensureConnected({ verify: true, timeoutMs: 5000 });
		// forceReconnect 创建了新 WS
		expect(MockWebSocket.instances.length).toBe(2);
		expect(conn.state).toBe('connecting');
		// 模拟新 WS open
		MockWebSocket.lastInstance.simulateOpen();
		await p;
		expect(conn.state).toBe('connected');
		conn.disconnect();
	});

	test('connected + verify=true 冷却期内 → 立即 resolve（不 reconnect）', async () => {
		const { conn } = makeConnected();
		// 等冷却过期后做第一次 verify
		vi.advanceTimersByTime(5001);
		const p1 = conn.ensureConnected({ verify: true, timeoutMs: 5000 });
		MockWebSocket.lastInstance.simulateOpen();
		await p1;
		const countAfterFirst = MockWebSocket.instances.length;
		// 冷却期内第二次 verify → 应立即返回
		await conn.ensureConnected({ verify: true, timeoutMs: 5000 });
		expect(MockWebSocket.instances.length).toBe(countAfterFirst);
		conn.disconnect();
	});

	test('connected + verify=true 冷却期后 → 再次 forceReconnect', async () => {
		const { conn } = makeConnected();
		// 等冷却过期后做第一次 verify
		vi.advanceTimersByTime(5001);
		const p1 = conn.ensureConnected({ verify: true, timeoutMs: 5000 });
		MockWebSocket.lastInstance.simulateOpen();
		await p1;
		const countAfterFirst = MockWebSocket.instances.length;
		// 超过冷却期（6s > VERIFY_COOLDOWN_MS 5s）
		vi.advanceTimersByTime(6000);
		// 第二次 verify：冷却已过，应触发 forceReconnect
		const p2 = conn.ensureConnected({ verify: true, timeoutMs: 5000 });
		expect(MockWebSocket.instances.length).toBeGreaterThan(countAfterFirst);
		MockWebSocket.lastInstance.simulateOpen();
		await p2;
		conn.disconnect();
	});

	test('connected + verify=true + WS 最近有活动（< PROBE_TIMEOUT）→ 不 forceReconnect', async () => {
		const { conn, ws } = makeConnected();
		// 等冷却过期
		vi.advanceTimersByTime(5001);
		// 模拟收到心跳 pong → 刷新 lastAliveAt
		ws.simulateMessage({ type: 'pong' });
		const countBefore = MockWebSocket.instances.length;
		await conn.ensureConnected({ verify: true, timeoutMs: 5000 });
		// WS 最近有活动 → 不 forceReconnect
		expect(MockWebSocket.instances.length).toBe(countBefore);
		expect(conn.state).toBe('connected');
		conn.disconnect();
	});

	test('connected + verify=true + WS 长时间无活动（> PROBE_TIMEOUT）→ forceReconnect', async () => {
		const { conn } = makeConnected();
		// 等冷却过期 + lastAliveAt 过期（5001ms > PROBE_TIMEOUT_MS 2500ms）
		vi.advanceTimersByTime(5001);
		const countBefore = MockWebSocket.instances.length;
		const p = conn.ensureConnected({ verify: true, timeoutMs: 5000 });
		// lastAliveAt 已过期 → forceReconnect → 新 WS
		expect(MockWebSocket.instances.length).toBeGreaterThan(countBefore);
		MockWebSocket.lastInstance.simulateOpen();
		await p;
		conn.disconnect();
	});

	test('connecting → 等待 WS open → resolve', async () => {
		MockWebSocket.reset();
		const conn = new SignalingConnection({ baseUrl: 'http://localhost:3000', WebSocket: MockWebSocket });
		conn.connect(); // state → connecting
		expect(conn.state).toBe('connecting');
		const p = conn.ensureConnected({ timeoutMs: 5000 });
		MockWebSocket.lastInstance.simulateOpen();
		await p;
		expect(conn.state).toBe('connected');
		conn.disconnect();
	});

	test('disconnected → 触发 connect + 等待 → resolve', async () => {
		MockWebSocket.reset();
		const conn = new SignalingConnection({ baseUrl: 'http://localhost:3000', WebSocket: MockWebSocket });
		// 初始为 disconnected，不调用 connect()
		expect(conn.state).toBe('disconnected');
		const p = conn.ensureConnected({ timeoutMs: 5000 });
		// 应自动触发 __doConnect
		expect(MockWebSocket.lastInstance).toBeTruthy();
		expect(conn.state).toBe('connecting');
		MockWebSocket.lastInstance.simulateOpen();
		await p;
		expect(conn.state).toBe('connected');
		conn.disconnect();
	});

	test('intentionalClose → reject', async () => {
		const { conn } = makeConnected();
		conn.disconnect(); // __intentionalClose = true
		await expect(conn.ensureConnected()).rejects.toThrow('intentionally closed');
	});

	test('超时 → reject', async () => {
		MockWebSocket.reset();
		const conn = new SignalingConnection({ baseUrl: 'http://localhost:3000', WebSocket: MockWebSocket });
		const p = conn.ensureConnected({ timeoutMs: 3000 });
		// 不模拟 WS open → 超时
		vi.advanceTimersByTime(3000);
		await expect(p).rejects.toThrow('ensureConnected timeout');
		conn.disconnect();
	});

	test('等待期间 disconnect → 立即 reject（不等超时）', async () => {
		MockWebSocket.reset();
		const conn = new SignalingConnection({ baseUrl: 'http://localhost:3000', WebSocket: MockWebSocket });
		conn.connect();
		// WS 未 open，state = connecting
		const p = conn.ensureConnected({ timeoutMs: 10000 });
		// 等待期间主动断开
		conn.disconnect();
		await expect(p).rejects.toThrow('intentionally closed');
	});

	test('多个并发调用不重复创建 WS', async () => {
		MockWebSocket.reset();
		const conn = new SignalingConnection({ baseUrl: 'http://localhost:3000', WebSocket: MockWebSocket });
		conn.connect();
		const p1 = conn.ensureConnected({ timeoutMs: 5000 });
		const p2 = conn.ensureConnected({ timeoutMs: 5000 });
		// 只有一个 WS 实例
		expect(MockWebSocket.instances.length).toBe(1);
		MockWebSocket.lastInstance.simulateOpen();
		await Promise.all([p1, p2]);
		expect(conn.state).toBe('connected');
		conn.disconnect();
	});
});

describe('SignalingConnection – __onVisibilityChange / __onAppForeground', () => {
	test('__onVisibilityChange visible 时调用 __handleForegroundResume', () => {
		const { conn } = makeConnected();
		const spy = vi.spyOn(conn, '__handleForegroundResume');
		// 模拟 document.visibilityState = 'visible'
		Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
		vi.advanceTimersByTime(1000); // 过节流期
		conn.__onVisibilityChange();
		expect(spy).toHaveBeenCalledWith('visibility');
		spy.mockRestore();
	});

	test('__onVisibilityChange hidden 时不调用 __handleForegroundResume', () => {
		const { conn } = makeConnected();
		const spy = vi.spyOn(conn, '__handleForegroundResume');
		Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
		conn.__onVisibilityChange();
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	test('__onAppForeground 调用 __handleForegroundResume', () => {
		const { conn } = makeConnected();
		const spy = vi.spyOn(conn, '__handleForegroundResume');
		vi.advanceTimersByTime(1000);
		conn.__onAppForeground();
		expect(spy).toHaveBeenCalledWith('app:foreground');
		spy.mockRestore();
	});
});

describe('SignalingConnection – __emit 异常处理', () => {
	test('监听器抛异常时不影响其他监听器', () => {
		const { conn } = makeConnected();
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const cb1 = vi.fn(() => { throw new Error('listener boom'); });
		const cb2 = vi.fn();
		conn.on('state', cb1);
		conn.on('state', cb2);
		// 触发状态变更
		conn.disconnect();
		expect(cb1).toHaveBeenCalled();
		expect(cb2).toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[SigConn] listener error'), expect.any(Error));
		errorSpy.mockRestore();
	});
});

describe('SignalingConnection – 单例', () => {
	afterEach(() => __resetSignalingConnection());

	test('useSignalingConnection 返回同一实例', () => {
		const a = useSignalingConnection({ baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		const b = useSignalingConnection();
		expect(a).toBe(b);
	});

	test('__resetSignalingConnection 重置单例', () => {
		const a = useSignalingConnection({ baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		__resetSignalingConnection();
		const b = useSignalingConnection({ baseUrl: 'http://localhost', WebSocket: MockWebSocket });
		expect(a).not.toBe(b);
	});
});
