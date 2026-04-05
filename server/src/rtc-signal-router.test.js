import assert from 'node:assert/strict';
import test from 'node:test';

import { register, remove, removeByWs, removeByClawId, routeToUi, lookup, __test } from './rtc-signal-router.js';

const { routes, wsToConnIds } = __test;

function createMockWs(opts = {}) {
	const sent = [];
	return {
		readyState: opts.readyState ?? 1,
		sent,
		send(data) { sent.push(JSON.parse(data)); },
	};
}

function cleanup() {
	routes.clear();
	// WeakMap 无法手动清理，但每个测试使用独立 WS 对象，不会互相干扰
}

// --- register ---

test('register: 成功注册返回 true', () => {
	const ws = createMockWs();
	assert.equal(register('c_1', ws, 'bot1', 'user1'), true);
	assert.deepEqual(lookup('c_1'), { ws, clawId: 'bot1', userId: 'user1' });
	cleanup();
});

test('register: 同一 WS 重复注册同一 connId 返回 true 并更新', () => {
	const ws = createMockWs();
	register('c_1', ws, 'bot1', 'user1');
	assert.equal(register('c_1', ws, 'bot2', 'user1'), true);
	assert.equal(lookup('c_1').clawId, 'bot2');
	cleanup();
});

test('register: connId 被其他 WS 占用返回 false', () => {
	const ws1 = createMockWs();
	const ws2 = createMockWs();
	register('c_1', ws1, 'bot1', 'user1');
	assert.equal(register('c_1', ws2, 'bot1', 'user1'), false);
	// 原条目不变
	assert.equal(lookup('c_1').ws, ws1);
	cleanup();
});

test('register: 同一 WS 注册多个 connId', () => {
	const ws = createMockWs();
	register('c_1', ws, 'bot1', 'user1');
	register('c_2', ws, 'bot2', 'user1');
	assert.equal(routes.size, 2);
	const set = wsToConnIds.get(ws);
	assert.equal(set.size, 2);
	assert.ok(set.has('c_1'));
	assert.ok(set.has('c_2'));
	cleanup();
});

// --- remove ---

test('remove: 移除存在的 connId', () => {
	const ws = createMockWs();
	register('c_1', ws, 'bot1', 'user1');
	remove('c_1');
	assert.equal(lookup('c_1'), null);
	assert.equal(routes.size, 0);
	// wsToConnIds 中对应 Set 也应已移除该 connId
	const set = wsToConnIds.get(ws);
	assert.ok(!set || !set.has('c_1'));
	cleanup();
});

test('remove: 移除不存在的 connId 无副作用', () => {
	remove('c_nonexist');
	assert.equal(routes.size, 0);
});

// --- removeByWs ---

test('removeByWs: 移除该 WS 下所有 connId', () => {
	const ws = createMockWs();
	register('c_1', ws, 'bot1', 'user1');
	register('c_2', ws, 'bot2', 'user1');
	removeByWs(ws);
	assert.equal(routes.size, 0);
	assert.equal(lookup('c_1'), null);
	assert.equal(lookup('c_2'), null);
	cleanup();
});

test('removeByWs: WS 无注册时无副作用', () => {
	const ws = createMockWs();
	removeByWs(ws);
	assert.equal(routes.size, 0);
});

test('removeByWs: 不影响其他 WS 的 connId', () => {
	const ws1 = createMockWs();
	const ws2 = createMockWs();
	register('c_1', ws1, 'bot1', 'user1');
	register('c_2', ws2, 'bot1', 'user1');
	removeByWs(ws1);
	assert.equal(lookup('c_1'), null);
	assert.deepEqual(lookup('c_2'), { ws: ws2, clawId: 'bot1', userId: 'user1' });
	cleanup();
});

// --- removeByClawId ---

test('removeByClawId: 移除该 botId 下所有 connId', () => {
	const ws1 = createMockWs();
	const ws2 = createMockWs();
	register('c_1', ws1, 'bot1', 'user1');
	register('c_2', ws2, 'bot1', 'user2');
	removeByClawId('bot1');
	assert.equal(routes.size, 0);
	cleanup();
});

test('removeByClawId: 不影响其他 botId 的 connId', () => {
	const ws = createMockWs();
	register('c_1', ws, 'bot1', 'user1');
	register('c_2', ws, 'bot2', 'user1');
	removeByClawId('bot1');
	assert.equal(routes.size, 1);
	assert.equal(lookup('c_1'), null);
	assert.deepEqual(lookup('c_2'), { ws, clawId: 'bot2', userId: 'user1' });
	cleanup();
});

test('removeByClawId: clawId 无注册时无副作用', () => {
	removeByClawId('nonexist');
	assert.equal(routes.size, 0);
});

// --- routeToUi ---

test('routeToUi: 成功投递返回 true', () => {
	const ws = createMockWs();
	register('c_1', ws, 'bot1', 'user1');
	const payload = { type: 'rtc:answer', toConnId: 'c_1', payload: { sdp: 'ans' } };
	assert.equal(routeToUi('c_1', payload), true);
	assert.equal(ws.sent.length, 1);
	assert.equal(ws.sent[0].type, 'rtc:answer');
	cleanup();
});

test('routeToUi: connId 不存在返回 false', () => {
	assert.equal(routeToUi('c_nonexist', { type: 'rtc:answer' }), false);
});

test('routeToUi: WS 非 OPEN 返回 false', () => {
	const ws = createMockWs({ readyState: 3 }); // CLOSED
	register('c_1', ws, 'bot1', 'user1');
	assert.equal(routeToUi('c_1', { type: 'rtc:answer' }), false);
	assert.equal(ws.sent.length, 0);
	cleanup();
});

test('routeToUi: WS.send 抛异常返回 false', () => {
	const ws = {
		readyState: 1,
		send() { throw new Error('connection lost'); },
	};
	register('c_1', ws, 'bot1', 'user1');
	assert.equal(routeToUi('c_1', { type: 'rtc:answer' }), false);
	cleanup();
});

// --- lookup ---

test('lookup: 存在返回条目', () => {
	const ws = createMockWs();
	register('c_1', ws, 'bot1', 'user1');
	const entry = lookup('c_1');
	assert.equal(entry.ws, ws);
	assert.equal(entry.clawId, 'bot1');
	assert.equal(entry.userId, 'user1');
	cleanup();
});

test('lookup: 不存在返回 null', () => {
	assert.equal(lookup('c_nonexist'), null);
});
