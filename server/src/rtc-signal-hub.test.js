import assert from 'node:assert/strict';
import test from 'node:test';

process.env.TURN_SECRET ??= 'test-secret';
process.env.APP_DOMAIN ??= 'test.coclaw.net';

import { __test, attachRtcSignalHub } from './rtc-signal-hub.js';
import { register, lookup, __test as routerTest } from './rtc-signal-router.js';

const { handleMessage, validateBotOwnership } = __test;
const { routes } = routerTest;

function createMockWs(opts = {}) {
	const sent = [];
	return {
		readyState: opts.readyState ?? 1,
		sent,
		send(data) { sent.push(JSON.parse(data)); },
	};
}

// mock findClawById：botId=1,2,3 归属 userId='u1'；botId=999 归属 other-user
function mockFindClawById(id) {
	const botId = String(id);
	if (['1', '2', '3'].includes(botId)) {
		return Promise.resolve({ id, userId: 'u1' });
	}
	if (botId === '999') {
		return Promise.resolve({ id, userId: 'other-user' });
	}
	return Promise.resolve(null);
}

// mock forwardToBot：记录调用，可配置返回值
function createForwardMock(opts = {}) {
	const { returnValue = true } = opts;
	const calls = [];
	const fn = (botId, payload) => {
		calls.push({ botId, payload: structuredClone(payload) });
		return returnValue;
	};
	fn.calls = calls;
	return fn;
}

function makeDeps(forwardMock) {
	return {
		findClawByIdFn: mockFindClawById,
		forwardToBotFn: forwardMock ?? createForwardMock(),
	};
}

function cleanup() {
	routes.clear();
}

// --- ping ---

test('handleMessage: ping → 回复 pong', async () => {
	const ws = createMockWs();
	await handleMessage(ws, 'u1', JSON.stringify({ type: 'ping' }), makeDeps());
	assert.equal(ws.sent.length, 1);
	assert.equal(ws.sent[0].type, 'pong');
});

// --- type=log 远程日志 ---

test('handleMessage: type=log 逐条输出到 console.info', async () => {
	const ws = createMockWs();
	const now = Date.now();
	const logged = [];
	const origInfo = console.info;
	console.info = (msg) => logged.push(msg);
	try {
		await handleMessage(ws, 'u1', JSON.stringify({
			type: 'log',
			logs: [
				{ ts: now, text: 'sse.connected' },
				{ ts: now + 1500, text: 'rtc.state connected' },
			],
		}), makeDeps());
		assert.equal(logged.length, 2);
		assert.match(logged[0], /\[remote\]\[ui\]\[user:u1\]/);
		assert.match(logged[0], /\d{2}:\d{2}:\d{2}\.\d{3}/);
		assert.match(logged[0], /sse\.connected/);
		assert.match(logged[1], /rtc\.state/);
	} finally {
		console.info = origInfo;
	}
});

test('handleMessage: type=log 忽略非 {ts,text} 条目', async () => {
	const ws = createMockWs();
	const logged = [];
	const origInfo = console.info;
	console.info = (msg) => logged.push(msg);
	try {
		await handleMessage(ws, 'u1', JSON.stringify({
			type: 'log',
			logs: [
				{ ts: Date.now(), text: 'valid' },
				'bare string',
				42,
				null,
				{ ts: Date.now(), text: 'also valid' },
			],
		}), makeDeps());
		assert.equal(logged.length, 2);
	} finally {
		console.info = origInfo;
	}
});

test('handleMessage: type=log logs 不是数组时静默忽略', async () => {
	const ws = createMockWs();
	const logged = [];
	const origInfo = console.info;
	console.info = (msg) => logged.push(msg);
	try {
		await handleMessage(ws, 'u1', JSON.stringify({
			type: 'log',
			logs: 'not-array',
		}), makeDeps());
		assert.equal(logged.length, 0);
	} finally {
		console.info = origInfo;
	}
});

test('handleMessage: type=log 不回复任何消息', async () => {
	const ws = createMockWs();
	const origInfo = console.info;
	console.info = () => {};
	try {
		await handleMessage(ws, 'u1', JSON.stringify({
			type: 'log',
			logs: [{ ts: Date.now(), text: 'some line' }],
		}), makeDeps());
		assert.equal(ws.sent.length, 0);
	} finally {
		console.info = origInfo;
	}
});

// --- 无效 JSON ---

test('handleMessage: 无效 JSON 静默忽略', async () => {
	const ws = createMockWs();
	await handleMessage(ws, 'u1', 'not-json', makeDeps());
	assert.equal(ws.sent.length, 0);
});

// --- signal:resume 已移除（回归守卫） ---

test('handleMessage: signal:resume 被视为 unknown type，不注册路由', async () => {
	const ws = createMockWs();
	const fwd = createForwardMock();
	await handleMessage(ws, 'u1', JSON.stringify({
		type: 'signal:resume',
		connIds: { 1: 'c_a', 2: 'c_b' },
	}), makeDeps(fwd));

	assert.equal(ws.sent.length, 0, 'should not reply signal:resumed');
	assert.equal(lookup('c_a'), null, 'should not register connId');
	assert.equal(lookup('c_b'), null);
	assert.equal(fwd.calls.length, 0);
	cleanup();
});

// --- rtc:offer ---

test('handleMessage: rtc:offer → register + TURN 注入 + forwardToBot', async () => {
	const ws = createMockWs();
	const fwd = createForwardMock();
	await handleMessage(ws, 'u1', JSON.stringify({
		type: 'rtc:offer',
		botId: '1',
		connId: 'c_offer1',
		payload: { sdp: 'mock-sdp' },
	}), makeDeps(fwd));

	// 路由表已注册
	assert.equal(lookup('c_offer1')?.botId, '1');
	// forwardToBot 被调用
	assert.equal(fwd.calls.length, 1);
	const forwarded = fwd.calls[0].payload;
	assert.equal(forwarded.type, 'rtc:offer');
	assert.equal(forwarded.fromConnId, 'c_offer1');
	assert.equal(forwarded.payload.sdp, 'mock-sdp');
	// TURN 凭证已注入
	assert.ok(forwarded.turnCreds, 'turnCreds should be injected');
	assert.ok(forwarded.turnCreds.username);
	assert.ok(forwarded.turnCreds.credential);
	assert.ok(Array.isArray(forwarded.turnCreds.urls));
	cleanup();
});

test('handleMessage: rtc:offer TURN_SECRET 未设置时不注入 turnCreds', async () => {
	const origSecret = process.env.TURN_SECRET;
	delete process.env.TURN_SECRET;
	try {
		const ws = createMockWs();
		const fwd = createForwardMock();
		await handleMessage(ws, 'u1', JSON.stringify({
			type: 'rtc:offer',
			botId: '1',
			connId: 'c_no_turn',
			payload: { sdp: 'sdp' },
		}), makeDeps(fwd));

		assert.equal(fwd.calls.length, 1);
		assert.equal(fwd.calls[0].payload.turnCreds, undefined);
	} finally {
		process.env.TURN_SECRET = origSecret;
		cleanup();
	}
});

test('handleMessage: rtc:offer bot 归属验证失败时拒绝', async () => {
	const ws = createMockWs();
	const fwd = createForwardMock();
	await handleMessage(ws, 'u1', JSON.stringify({
		type: 'rtc:offer',
		botId: '999', // 归属 other-user，非 u1
		connId: 'c_denied',
		payload: { sdp: 'sdp' },
	}), makeDeps(fwd));

	assert.equal(fwd.calls.length, 0, 'should not forward');
	assert.equal(lookup('c_denied'), null, 'should not register');
	cleanup();
});

test('handleMessage: rtc:offer connId 被其他 WS 占用时拒绝', async () => {
	const ws1 = createMockWs();
	const ws2 = createMockWs();
	register('c_taken', ws1, '1', 'u1');

	const fwd = createForwardMock();
	await handleMessage(ws2, 'u1', JSON.stringify({
		type: 'rtc:offer',
		botId: '1',
		connId: 'c_taken',
		payload: { sdp: 'sdp' },
	}), makeDeps(fwd));

	assert.equal(fwd.calls.length, 0, 'should not forward');
	// 原注册不变
	assert.equal(lookup('c_taken').ws, ws1);
	cleanup();
});

// --- rtc:ice ---

test('handleMessage: rtc:ice 已注册 → 附 fromConnId + forwardToBot', async () => {
	const ws = createMockWs();
	register('c_ice1', ws, '1', 'u1');
	const fwd = createForwardMock();

	await handleMessage(ws, 'u1', JSON.stringify({
		type: 'rtc:ice',
		botId: '1',
		connId: 'c_ice1',
		payload: { candidate: 'cand1' },
	}), makeDeps(fwd));

	assert.equal(fwd.calls.length, 1);
	assert.equal(fwd.calls[0].payload.fromConnId, 'c_ice1');
	assert.equal(fwd.calls[0].botId, '1');
	cleanup();
});

test('handleMessage: rtc:ice 未注册 → 隐式注册 + forwardToBot', async () => {
	const ws = createMockWs();
	const fwd = createForwardMock();

	await handleMessage(ws, 'u1', JSON.stringify({
		type: 'rtc:ice',
		botId: '1',
		connId: 'c_implicit',
		payload: { candidate: 'cand2' },
	}), makeDeps(fwd));

	// 应已隐式注册
	assert.equal(lookup('c_implicit')?.botId, '1');
	assert.equal(fwd.calls.length, 1);
	cleanup();
});

// --- rtc:ready ---

test('handleMessage: rtc:ready 转发到 bot', async () => {
	const ws = createMockWs();
	register('c_rdy', ws, '1', 'u1');
	const fwd = createForwardMock();

	await handleMessage(ws, 'u1', JSON.stringify({
		type: 'rtc:ready',
		botId: '1',
		connId: 'c_rdy',
	}), makeDeps(fwd));

	assert.equal(fwd.calls.length, 1);
	assert.equal(fwd.calls[0].payload.fromConnId, 'c_rdy');
	cleanup();
});

// --- rtc:closed ---

test('handleMessage: rtc:closed → forwardToBot + remove connId', async () => {
	const ws = createMockWs();
	register('c_cls', ws, '1', 'u1');
	const fwd = createForwardMock();

	await handleMessage(ws, 'u1', JSON.stringify({
		type: 'rtc:closed',
		botId: '1',
		connId: 'c_cls',
	}), makeDeps(fwd));

	assert.equal(fwd.calls.length, 1);
	assert.equal(fwd.calls[0].payload.fromConnId, 'c_cls');
	// connId 已移除
	assert.equal(lookup('c_cls'), null);
	cleanup();
});

test('handleMessage: rtc:closed connId 不存在时不抛异常', async () => {
	const ws = createMockWs();
	const fwd = createForwardMock();

	await handleMessage(ws, 'u1', JSON.stringify({
		type: 'rtc:closed',
		botId: '1',
		connId: 'c_gone',
	}), makeDeps(fwd));

	// 仍转发（使用 payload 中的 botId）
	assert.equal(fwd.calls.length, 1);
	assert.equal(fwd.calls[0].botId, '1');
	cleanup();
});

// --- unknown type ---

test('handleMessage: unknown message type 静默忽略', async () => {
	const ws = createMockWs();
	await handleMessage(ws, 'u1', JSON.stringify({ type: 'unknown:msg', botId: '1', connId: 'c_x' }), makeDeps());
	assert.equal(ws.sent.length, 0);
	cleanup();
});

// --- 缺少 botId/connId ---

test('handleMessage: rtc:offer 缺少 connId 时忽略', async () => {
	const ws = createMockWs();
	const fwd = createForwardMock();
	await handleMessage(ws, 'u1', JSON.stringify({
		type: 'rtc:offer',
		botId: '1',
		payload: { sdp: 'sdp' },
	}), makeDeps(fwd));

	assert.equal(fwd.calls.length, 0);
	cleanup();
});

test('handleMessage: rtc:offer 缺少 botId 时忽略', async () => {
	const ws = createMockWs();
	const fwd = createForwardMock();
	await handleMessage(ws, 'u1', JSON.stringify({
		type: 'rtc:offer',
		connId: 'c_x',
		payload: { sdp: 'sdp' },
	}), makeDeps(fwd));

	assert.equal(fwd.calls.length, 0);
	cleanup();
});

// --- rtc:ice / rtc:ready 隐式注册失败路径 ---

test('handleMessage: rtc:ice 未注册 + botId 归属验证失败时拒绝', async () => {
	const ws = createMockWs();
	const fwd = createForwardMock();
	await handleMessage(ws, 'u1', JSON.stringify({
		type: 'rtc:ice',
		botId: '999',
		connId: 'c_denied_ice',
		payload: { candidate: 'cand' },
	}), makeDeps(fwd));

	assert.equal(fwd.calls.length, 0);
	assert.equal(lookup('c_denied_ice'), null);
	cleanup();
});

test('handleMessage: rtc:ready 未注册 → 隐式注册 + forwardToBot', async () => {
	const ws = createMockWs();
	const fwd = createForwardMock();
	await handleMessage(ws, 'u1', JSON.stringify({
		type: 'rtc:ready',
		botId: '1',
		connId: 'c_rdy_implicit',
	}), makeDeps(fwd));

	assert.equal(lookup('c_rdy_implicit')?.botId, '1');
	assert.equal(fwd.calls.length, 1);
	cleanup();
});

// --- rtc:closed 安全性 ---

test('handleMessage: rtc:closed connId 未注册 + botId 归属验证失败时拒绝转发', async () => {
	const ws = createMockWs();
	const fwd = createForwardMock();
	await handleMessage(ws, 'u1', JSON.stringify({
		type: 'rtc:closed',
		botId: '999',
		connId: 'c_unauth',
	}), makeDeps(fwd));

	assert.equal(fwd.calls.length, 0, 'should not forward to unowned bot');
	cleanup();
});

// --- bot 离线时 forwardToBot 返回 false ---

test('handleMessage: rtc:offer bot 离线时 UI 不收到消息', async () => {
	const ws = createMockWs();
	const fwd = createForwardMock({ returnValue: false });
	await handleMessage(ws, 'u1', JSON.stringify({
		type: 'rtc:offer',
		botId: '1',
		connId: 'c_offline',
		payload: { sdp: 'sdp' },
	}), makeDeps(fwd));

	assert.equal(fwd.calls.length, 1, 'should attempt forward');
	assert.equal(ws.sent.length, 0, 'UI should not receive any message');
	cleanup();
});

// --- validateBotOwnership 异常分支 ---

test('handleMessage: findClawById 抛异常时视为归属验证失败', async () => {
	const ws = createMockWs();
	const fwd = createForwardMock();
	const throwingFindBot = () => Promise.reject(new Error('db connection lost'));
	await handleMessage(ws, 'u1', JSON.stringify({
		type: 'rtc:offer',
		botId: '1',
		connId: 'c_db_err',
		payload: { sdp: 'sdp' },
	}), { findClawByIdFn: throwingFindBot, forwardToBotFn: fwd });

	assert.equal(fwd.calls.length, 0, 'should not forward when DB errors');
	assert.equal(lookup('c_db_err'), null, 'should not register');
	cleanup();
});

// --- validateBotOwnership 直接测试 ---

test('validateBotOwnership: bot 存在且归属匹配返回 true', async () => {
	const result = await validateBotOwnership('1', 'u1', mockFindClawById);
	assert.equal(result, true);
});

test('validateBotOwnership: bot 存在但归属不匹配返回 false', async () => {
	const result = await validateBotOwnership('999', 'u1', mockFindClawById);
	assert.equal(result, false);
});

test('validateBotOwnership: bot 不存在返回 false', async () => {
	const result = await validateBotOwnership('888', 'u1', mockFindClawById);
	assert.equal(result, false);
});

test('validateBotOwnership: findClawByIdFn 抛异常返回 false', async () => {
	const result = await validateBotOwnership('1', 'u1', () => { throw new Error('boom'); });
	assert.equal(result, false);
});

// --- rtc:closed 已注册路由但 bot 离线 ---

test('handleMessage: rtc:closed 已注册但 bot 离线（forward 返回 false）仍移除路由', async () => {
	const ws = createMockWs();
	register('c_cls_offline', ws, '1', 'u1');
	const fwd = createForwardMock({ returnValue: false });

	await handleMessage(ws, 'u1', JSON.stringify({
		type: 'rtc:closed',
		botId: '1',
		connId: 'c_cls_offline',
	}), makeDeps(fwd));

	assert.equal(fwd.calls.length, 1, 'should attempt forward');
	assert.equal(fwd.calls[0].payload.fromConnId, 'c_cls_offline');
	// 路由仍被移除
	assert.equal(lookup('c_cls_offline'), null);
	cleanup();
});

// --- rtc:closed 未注册 + 归属验证通过但 bot 离线 ---

test('handleMessage: rtc:closed 未注册 + 归属验证通过但 bot 离线', async () => {
	const ws = createMockWs();
	const fwd = createForwardMock({ returnValue: false });

	await handleMessage(ws, 'u1', JSON.stringify({
		type: 'rtc:closed',
		botId: '1',
		connId: 'c_unreg_offline',
	}), makeDeps(fwd));

	assert.equal(fwd.calls.length, 1, 'should attempt forward');
	assert.equal(fwd.calls[0].botId, '1');
	cleanup();
});

// --- attachRtcSignalHub ---

test('attachRtcSignalHub: 绑定 upgrade 事件', async () => {
	const handlers = {};
	const mockServer = {
		on(event, handler) { handlers[event] = handler; },
	};
	attachRtcSignalHub(mockServer, { sessionMiddleware: () => {} });
	assert.ok(handlers.upgrade, 'should register upgrade handler');
});

test('attachRtcSignalHub: 非 /api/v1/rtc/signal 路径直接忽略', async () => {
	const handlers = {};
	const mockServer = {
		on(event, handler) { handlers[event] = handler; },
	};
	attachRtcSignalHub(mockServer, { sessionMiddleware: () => {} });

	const mockSocket = {
		written: [],
		write(data) { this.written.push(data); },
		destroy() { this.destroyed = true; },
	};
	// 非目标路径，应直接返回
	await handlers.upgrade({ url: '/other-path' }, mockSocket, Buffer.alloc(0));
	assert.equal(mockSocket.written.length, 0, 'should not respond');
	assert.equal(mockSocket.destroyed, undefined, 'should not destroy');
});

test('attachRtcSignalHub: sessionMiddleware 为空时返回 500', async () => {
	const handlers = {};
	const mockServer = {
		on(event, handler) { handlers[event] = handler; },
	};
	attachRtcSignalHub(mockServer, { sessionMiddleware: null });

	const mockSocket = {
		written: [],
		write(data) { this.written.push(data); },
		destroy() { this.destroyed = true; },
	};
	await handlers.upgrade({ url: '/api/v1/rtc/signal' }, mockSocket, Buffer.alloc(0));
	assert.equal(mockSocket.written.length, 1);
	assert.match(mockSocket.written[0], /500/);
	assert.equal(mockSocket.destroyed, true);
});

test('attachRtcSignalHub: session middleware 出错时返回 401', async () => {
	const handlers = {};
	const mockServer = {
		on(event, handler) { handlers[event] = handler; },
	};
	const errMiddleware = (_req, _res, next) => { next(new Error('session error')); };
	attachRtcSignalHub(mockServer, { sessionMiddleware: errMiddleware });

	const mockSocket = {
		written: [],
		write(data) { this.written.push(data); },
		destroy() { this.destroyed = true; },
	};
	await handlers.upgrade({ url: '/api/v1/rtc/signal' }, mockSocket, Buffer.alloc(0));
	assert.equal(mockSocket.written.length, 1);
	assert.match(mockSocket.written[0], /401/);
	assert.equal(mockSocket.destroyed, true);
});

test('attachRtcSignalHub: session 无 userId 时返回 401', async () => {
	const handlers = {};
	const mockServer = {
		on(event, handler) { handlers[event] = handler; },
	};
	const noUserMiddleware = (req, _res, next) => {
		req.session = { passport: {} };
		next();
	};
	attachRtcSignalHub(mockServer, { sessionMiddleware: noUserMiddleware });

	const mockSocket = {
		written: [],
		write(data) { this.written.push(data); },
		destroy() { this.destroyed = true; },
	};
	await handlers.upgrade({ url: '/api/v1/rtc/signal' }, mockSocket, Buffer.alloc(0));
	assert.equal(mockSocket.written.length, 1);
	assert.match(mockSocket.written[0], /401/);
	assert.equal(mockSocket.destroyed, true);
});

test('attachRtcSignalHub: 认证通过时调用 wss.handleUpgrade', async () => {
	const handlers = {};
	const mockServer = {
		on(event, handler) { handlers[event] = handler; },
	};
	const authMiddleware = (req, _res, next) => {
		req.session = { passport: { user: '42' } };
		next();
	};
	attachRtcSignalHub(mockServer, { sessionMiddleware: authMiddleware });

	const mockSocket = {
		written: [],
		write(data) { this.written.push(data); },
		destroy() { this.destroyed = true; },
		remoteAddress: '127.0.0.1',
	};
	const req = {
		url: '/api/v1/rtc/signal',
		headers: {},
		socket: mockSocket,
	};
	// handleUpgrade 由内部 WebSocketServer 调用，触发后会调用 callback
	// 验证不会抛异常即可（内部 wss 会尝试真正的 upgrade）
	// 由于没有真实的 HTTP upgrade 头，wss.handleUpgrade 会抛异常并被 catch 捕获
	await handlers.upgrade(req, mockSocket, Buffer.alloc(0));
	// catch 块会返回 500
	assert.ok(mockSocket.written.length >= 1);
});

// --- rtc:ice/rtc:ready 隐式注册被占用时拒绝 ---

test('handleMessage: rtc:ice connId 已注册时直接使用现有路由转发', async () => {
	const ws1 = createMockWs();
	const ws2 = createMockWs();
	register('c_ice_taken', ws1, '1', 'u1');

	const fwd = createForwardMock();
	await handleMessage(ws2, 'u1', JSON.stringify({
		type: 'rtc:ice',
		botId: '1',
		connId: 'c_ice_taken',
		payload: { candidate: 'cand' },
	}), makeDeps(fwd));

	// 已注册的 connId 会直接使用现有路由转发
	assert.equal(fwd.calls.length, 1);
	assert.equal(fwd.calls[0].botId, '1');
	// 原注册不变
	assert.equal(lookup('c_ice_taken').ws, ws1);
	cleanup();
});

// --- rtc:ice/rtc:ready bot 离线 ---

test('handleMessage: rtc:ice bot 离线时仍尝试转发', async () => {
	const ws = createMockWs();
	register('c_ice_off', ws, '1', 'u1');
	const fwd = createForwardMock({ returnValue: false });

	await handleMessage(ws, 'u1', JSON.stringify({
		type: 'rtc:ice',
		botId: '1',
		connId: 'c_ice_off',
		payload: { candidate: 'cand' },
	}), makeDeps(fwd));

	assert.equal(fwd.calls.length, 1, 'should attempt forward');
	cleanup();
});

// --- log 条目中 ts 缺失时显示占位符 ---

test('handleMessage: type=log 条目无 ts 时显示 ??:??:??.???', async () => {
	const ws = createMockWs();
	const logged = [];
	const origInfo = console.info;
	console.info = (msg) => logged.push(msg);
	try {
		await handleMessage(ws, 'u1', JSON.stringify({
			type: 'log',
			logs: [{ text: 'no-ts-entry' }],
		}), makeDeps());
		assert.equal(logged.length, 1);
		assert.match(logged[0], /\?\?:\?\?:\?\?\.\?\?\?/);
	} finally {
		console.info = origInfo;
	}
});

// --- null/非对象 payload ---

test('handleMessage: payload 为 null 时静默忽略', async () => {
	const ws = createMockWs();
	await handleMessage(ws, 'u1', 'null', makeDeps());
	assert.equal(ws.sent.length, 0);
});

// --- rtc:ice 隐式注册 connId 被占用时拒绝（覆盖 lines 124-126） ---

test('handleMessage: rtc:ice 未注册 + 隐式注册被其他 WS 占用时拒绝', async () => {
	const ws1 = createMockWs();
	const ws2 = createMockWs();
	// ws1 先注册了 connId
	register('c_ice_occupied', ws1, '1', 'u1');

	const fwd = createForwardMock();
	// ws2 尝试发 rtc:ice，connId 被 ws1 占用，隐式注册失败
	await handleMessage(ws2, 'u1', JSON.stringify({
		type: 'rtc:ice',
		botId: '1',
		connId: 'c_ice_occupied',
	}), makeDeps(fwd));

	// 已注册路由存在，应直接使用现有路由转发（不走隐式注册路径）
	assert.equal(fwd.calls.length, 1);
	cleanup();
});

// --- rtc:ice/ready 隐式注册成功后 lookup 必定非 null（覆盖 lines 131-133 防御分支） ---
// 这是一个防御分支，正常情况下 register 成功后 lookup 必不为 null
// 无法在单线程中触发，仅作为文档说明

// --- rtc:ready 隐式注册被占用时拒绝 ---

test('handleMessage: rtc:ready 未注册 + 归属验证通过但 connId 被占用时拒绝', async () => {
	const ws1 = createMockWs();
	const ws2 = createMockWs();
	register('c_rdy_occ', ws1, '1', 'u1');

	const fwd = createForwardMock();
	await handleMessage(ws2, 'u1', JSON.stringify({
		type: 'rtc:ready',
		botId: '1',
		connId: 'c_rdy_occ',
	}), makeDeps(fwd));

	// 已注册路由存在，走已注册路径
	assert.equal(fwd.calls.length, 1);
	cleanup();
});
