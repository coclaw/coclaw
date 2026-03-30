import assert from 'node:assert/strict';
import test from 'node:test';

process.env.TURN_SECRET ??= 'test-secret';
process.env.APP_DOMAIN ??= 'test.coclaw.net';

import { __test } from './rtc-signal-hub.js';
import { register, lookup, __test as routerTest } from './rtc-signal-router.js';

const { handleMessage } = __test;
const { routes } = routerTest;

function createMockWs(opts = {}) {
	const sent = [];
	return {
		readyState: opts.readyState ?? 1,
		sent,
		send(data) { sent.push(JSON.parse(data)); },
	};
}

// mock findBotById：botId=1,2,3 归属 userId='u1'；botId=999 归属 other-user
function mockFindBotById(id) {
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
		findBotByIdFn: mockFindBotById,
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

// --- 无效 JSON ---

test('handleMessage: 无效 JSON 静默忽略', async () => {
	const ws = createMockWs();
	await handleMessage(ws, 'u1', 'not-json', makeDeps());
	assert.equal(ws.sent.length, 0);
});

// --- signal:resume ---

test('handleMessage: signal:resume 批量注册 + 回复 signal:resumed', async () => {
	const ws = createMockWs();
	await handleMessage(ws, 'u1', JSON.stringify({
		type: 'signal:resume',
		connIds: { 1: 'c_a', 2: 'c_b' },
	}), makeDeps());

	// 路由表中应有 2 个条目
	assert.equal(routes.size, 2);
	assert.equal(lookup('c_a')?.botId, '1');
	assert.equal(lookup('c_b')?.botId, '2');
	// 回复 signal:resumed
	assert.equal(ws.sent.length, 1);
	assert.equal(ws.sent[0].type, 'signal:resumed');
	cleanup();
});

test('handleMessage: signal:resume 归属验证失败的 botId 被跳过', async () => {
	const ws = createMockWs();
	await handleMessage(ws, 'u1', JSON.stringify({
		type: 'signal:resume',
		connIds: { 1: 'c_a', '999': 'c_bad' },
	}), makeDeps());

	assert.equal(routes.size, 1);
	assert.equal(lookup('c_a')?.botId, '1');
	assert.equal(lookup('c_bad'), null);
	// 仍回复 signal:resumed
	assert.equal(ws.sent[0].type, 'signal:resumed');
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

// --- signal:resume 边界情况 ---

test('handleMessage: signal:resume connIds 为 null 时仍回复 signal:resumed', async () => {
	const ws = createMockWs();
	await handleMessage(ws, 'u1', JSON.stringify({
		type: 'signal:resume',
		connIds: null,
	}), makeDeps());

	assert.equal(routes.size, 0);
	assert.equal(ws.sent.length, 1);
	assert.equal(ws.sent[0].type, 'signal:resumed');
	cleanup();
});

test('handleMessage: signal:resume connIds 为空对象时回复 signal:resumed', async () => {
	const ws = createMockWs();
	await handleMessage(ws, 'u1', JSON.stringify({
		type: 'signal:resume',
		connIds: {},
	}), makeDeps());

	assert.equal(routes.size, 0);
	assert.equal(ws.sent[0].type, 'signal:resumed');
	cleanup();
});

test('handleMessage: signal:resume connIds 为数组时忽略', async () => {
	const ws = createMockWs();
	await handleMessage(ws, 'u1', JSON.stringify({
		type: 'signal:resume',
		connIds: ['c_a', 'c_b'],
	}), makeDeps());

	assert.equal(routes.size, 0);
	assert.equal(ws.sent[0].type, 'signal:resumed');
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
