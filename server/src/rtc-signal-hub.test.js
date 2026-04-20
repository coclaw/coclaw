import assert from 'node:assert/strict';
import test from 'node:test';

process.env.TURN_SECRET ??= 'test-secret';
process.env.APP_DOMAIN ??= 'test.coclaw.net';

import { __test, attachRtcSignalHub } from './rtc-signal-hub.js';
import { register, lookup, __test as routerTest } from './rtc-signal-router.js';

const { handleMessage, validateClawOwnership } = __test;
const { routes } = routerTest;

function createMockWs(opts = {}) {
	const sent = [];
	const ws = {
		readyState: opts.readyState ?? 1,
		sent,
		terminateCalls: 0,
		closeCalls: [],
		send(data) { sent.push(JSON.parse(data)); },
		terminate() { ws.terminateCalls++; },
		close(code, reason) { ws.closeCalls.push({ code, reason }); },
	};
	return ws;
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
	const fn = (clawId, payload) => {
		calls.push({ clawId, payload: structuredClone(payload) });
		return returnValue;
	};
	fn.calls = calls;
	return fn;
}

function makeDeps(forwardMock) {
	return {
		findClawByIdFn: mockFindClawById,
		forwardToClawFn: forwardMock ?? createForwardMock(),
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
	assert.equal(lookup('c_offer1')?.clawId, '1');
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

test('handleMessage: rtc:offer 使用 clawId（新版 UI）正常转发', async () => {
	const ws = createMockWs();
	const fwd = createForwardMock();
	await handleMessage(ws, 'u1', JSON.stringify({
		type: 'rtc:offer',
		clawId: '1',
		connId: 'c_offer_claw',
		payload: { sdp: 'mock-sdp' },
	}), makeDeps(fwd));

	assert.equal(lookup('c_offer_claw')?.clawId, '1');
	assert.equal(fwd.calls.length, 1);
	assert.equal(fwd.calls[0].clawId, '1');
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

test('handleMessage: rtc:offer 同 user+claw 的 connId 冲突触发 WS 级接管', async () => {
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

	// 接管：消息正常转发到 claw，路由迁到新 WS，旧 WS 被 terminate
	assert.equal(fwd.calls.length, 1, 'should forward after takeover');
	assert.equal(fwd.calls[0].payload.fromConnId, 'c_taken');
	assert.equal(lookup('c_taken').ws, ws2);
	assert.equal(ws1.terminateCalls, 1);
	cleanup();
});

test('handleMessage: rtc:offer connId 被其他 user 的 WS 占用时仍拒绝', async () => {
	const ws1 = createMockWs();
	const ws2 = createMockWs();
	// 模拟 ws1 是另一个 user 的——直接用路由底层注册绕开归属校验
	register('c_conflict', ws1, '1', 'other-user');

	const fwd = createForwardMock();
	await handleMessage(ws2, 'u1', JSON.stringify({
		type: 'rtc:offer',
		botId: '1',
		connId: 'c_conflict',
		payload: { sdp: 'sdp' },
	}), makeDeps(fwd));

	assert.equal(fwd.calls.length, 0, 'should not forward');
	assert.equal(lookup('c_conflict').ws, ws1);
	assert.equal(ws1.terminateCalls, 0);
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
	assert.equal(fwd.calls[0].clawId, '1');
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
	assert.equal(lookup('c_implicit')?.clawId, '1');
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
	assert.equal(fwd.calls[0].clawId, '1');
	cleanup();
});

test('handleMessage: rtc:closed 来自旧 WS 但路由已迁走时不误删新路由', async () => {
	// 场景：接管刚发生，routes[connId].ws=ws2；此时旧 ws1 的 rtc:closed 仍被投递（延迟消息）。
	// 守卫应保证 remove(connId) 不把新 WS 刚接管的路由抹掉。
	const ws1 = createMockWs();
	const ws2 = createMockWs();
	register('c_migrated', ws2, '1', 'u1'); // 模拟接管后的状态
	const fwd = createForwardMock();

	await handleMessage(ws1, 'u1', JSON.stringify({
		type: 'rtc:closed',
		botId: '1',
		connId: 'c_migrated',
	}), makeDeps(fwd));

	// 转发照常（旧 WS 的 rtc:closed 仍会通知 claw）
	assert.equal(fwd.calls.length, 1);
	// 关键：路由保持指向 ws2，未被误删
	assert.equal(lookup('c_migrated').ws, ws2);
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

	assert.equal(lookup('c_rdy_implicit')?.clawId, '1');
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

// --- validateClawOwnership 异常分支 ---

test('handleMessage: findClawById 抛异常时视为归属验证失败', async () => {
	const ws = createMockWs();
	const fwd = createForwardMock();
	const throwingFindBot = () => Promise.reject(new Error('db connection lost'));
	await handleMessage(ws, 'u1', JSON.stringify({
		type: 'rtc:offer',
		botId: '1',
		connId: 'c_db_err',
		payload: { sdp: 'sdp' },
	}), { findClawByIdFn: throwingFindBot, forwardToClawFn: fwd });

	assert.equal(fwd.calls.length, 0, 'should not forward when DB errors');
	assert.equal(lookup('c_db_err'), null, 'should not register');
	cleanup();
});

// --- validateClawOwnership 直接测试 ---

test('validateClawOwnership: bot 存在且归属匹配返回 true', async () => {
	const result = await validateClawOwnership('1', 'u1', mockFindClawById);
	assert.equal(result, true);
});

test('validateClawOwnership: bot 存在但归属不匹配返回 false', async () => {
	const result = await validateClawOwnership('999', 'u1', mockFindClawById);
	assert.equal(result, false);
});

test('validateClawOwnership: bot 不存在返回 false', async () => {
	const result = await validateClawOwnership('888', 'u1', mockFindClawById);
	assert.equal(result, false);
});

test('validateClawOwnership: findClawByIdFn 抛异常返回 false', async () => {
	const result = await validateClawOwnership('1', 'u1', () => { throw new Error('boom'); });
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
	assert.equal(fwd.calls[0].clawId, '1');
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

test('handleMessage: rtc:ice connId 已注册在同一 WS 上时直接转发', async () => {
	const ws = createMockWs();
	register('c_ice_taken', ws, '1', 'u1');

	const fwd = createForwardMock();
	await handleMessage(ws, 'u1', JSON.stringify({
		type: 'rtc:ice',
		botId: '1',
		connId: 'c_ice_taken',
		payload: { candidate: 'cand' },
	}), makeDeps(fwd));

	// 路由指向当前 ws → 直接走已注册路径、不触发接管
	assert.equal(fwd.calls.length, 1);
	assert.equal(fwd.calls[0].clawId, '1');
	assert.equal(lookup('c_ice_taken').ws, ws);
	assert.equal(ws.terminateCalls, 0);
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

// --- rtc:ice/ready 路由指向旧 WS 时触发接管 ---

test('handleMessage: rtc:ice 路由指向旧 WS 时触发接管', async () => {
	const ws1 = createMockWs();
	const ws2 = createMockWs();
	register('c_ice_occupied', ws1, '1', 'u1');

	const fwd = createForwardMock();
	await handleMessage(ws2, 'u1', JSON.stringify({
		type: 'rtc:ice',
		botId: '1',
		connId: 'c_ice_occupied',
	}), makeDeps(fwd));

	// 接管：转发正常，路由迁到 ws2，旧 WS 被 terminate
	assert.equal(fwd.calls.length, 1);
	assert.equal(lookup('c_ice_occupied').ws, ws2);
	assert.equal(ws1.terminateCalls, 1);
	cleanup();
});

// --- rtc:ice/ready 隐式注册成功后 lookup 必定非 null 的防御分支 ---
// 正常情况下 register 成功后 lookup 必不为 null（JS 单线程 + 迁移路径无 await）
// 无法通过正常路径触发，仅作为防御性保护；不做测试

test('handleMessage: rtc:ready 路由指向旧 WS 时触发接管', async () => {
	const ws1 = createMockWs();
	const ws2 = createMockWs();
	register('c_rdy_occ', ws1, '1', 'u1');

	const fwd = createForwardMock();
	await handleMessage(ws2, 'u1', JSON.stringify({
		type: 'rtc:ready',
		botId: '1',
		connId: 'c_rdy_occ',
	}), makeDeps(fwd));

	// 接管成功，转发照常
	assert.equal(fwd.calls.length, 1);
	assert.equal(lookup('c_rdy_occ').ws, ws2);
	assert.equal(ws1.terminateCalls, 1);
	cleanup();
});

// --- rtc:ice/ready 接管被 userId 不匹配挡住时拒绝 ---

test('handleMessage: rtc:ice 路由指向旧 WS 但 userId 不匹配时拒绝', async () => {
	const ws1 = createMockWs();
	const ws2 = createMockWs();
	// ws1 归属 u1；ws2 的 userId 是 u1，但 ws2 发 rtc:ice 的 botId=999（归属 other-user）
	// 借助归属校验挡住——ownership 校验通过不了 → 直接拒绝，路由不动
	register('c_ice_crossuser', ws1, '999', 'other-user');

	const fwd = createForwardMock();
	await handleMessage(ws2, 'u1', JSON.stringify({
		type: 'rtc:ice',
		botId: '999',
		connId: 'c_ice_crossuser',
	}), makeDeps(fwd));

	assert.equal(fwd.calls.length, 0);
	assert.equal(lookup('c_ice_crossuser').ws, ws1);
	assert.equal(ws1.terminateCalls, 0);
	cleanup();
});
