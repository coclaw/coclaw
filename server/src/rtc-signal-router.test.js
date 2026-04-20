import assert from 'node:assert/strict';
import test from 'node:test';

import { register, remove, removeByWs, removeByClawId, routeToUi, lookup, __test } from './rtc-signal-router.js';

const { routes, wsToConnIds } = __test;

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

function cleanup() {
	routes.clear();
	// WeakMap 无法手动清理，但每个测试使用独立 WS 对象，不会互相干扰
}

// --- register ---

test('register: 成功注册返回 ok=true migrated=false', () => {
	const ws = createMockWs();
	assert.deepEqual(register('c_1', ws, 'bot1', 'user1'), { ok: true, migrated: false });
	assert.deepEqual(lookup('c_1'), { ws, clawId: 'bot1', userId: 'user1' });
	cleanup();
});

test('register: 同一 WS 重复注册同一 connId 返回 ok=true 并更新', () => {
	const ws = createMockWs();
	register('c_1', ws, 'bot1', 'user1');
	assert.deepEqual(register('c_1', ws, 'bot2', 'user1'), { ok: true, migrated: false });
	assert.equal(lookup('c_1').clawId, 'bot2');
	cleanup();
});

test('register: 同 userId+clawId 的冲突触发 WS 级迁移', () => {
	const ws1 = createMockWs();
	const ws2 = createMockWs();
	register('c_1', ws1, 'bot1', 'user1');
	const result = register('c_1', ws2, 'bot1', 'user1');
	assert.deepEqual(result, { ok: true, migrated: true });
	// 路由改写到新 WS
	assert.equal(lookup('c_1').ws, ws2);
	// 旧 WS 被 terminate
	assert.equal(ws1.terminateCalls, 1);
	// 反向索引：旧 WS 清空，新 WS 接管
	assert.equal(wsToConnIds.get(ws1), undefined);
	assert.ok(wsToConnIds.get(ws2).has('c_1'));
	cleanup();
});

test('register: WS 级迁移搬走旧 WS 上全部 connId', () => {
	const ws1 = createMockWs();
	const ws2 = createMockWs();
	register('c_x', ws1, 'bot1', 'user1');
	register('c_y', ws1, 'bot2', 'user1');
	register('c_z', ws1, 'bot3', 'user1');
	// ws2 只对 c_x 发起 register，但 y/z 也应同步搬迁
	const result = register('c_x', ws2, 'bot1', 'user1');
	assert.deepEqual(result, { ok: true, migrated: true });
	assert.equal(lookup('c_x').ws, ws2);
	assert.equal(lookup('c_y').ws, ws2);
	assert.equal(lookup('c_z').ws, ws2);
	// 各 entry 的 clawId/userId 保留
	assert.equal(lookup('c_y').clawId, 'bot2');
	assert.equal(lookup('c_z').clawId, 'bot3');
	const newSet = wsToConnIds.get(ws2);
	assert.ok(newSet.has('c_x') && newSet.has('c_y') && newSet.has('c_z'));
	assert.equal(wsToConnIds.get(ws1), undefined);
	cleanup();
});

test('register: 迁移合并到新 WS 已有的 connId 集合', () => {
	const ws1 = createMockWs();
	const ws2 = createMockWs();
	register('c_a', ws2, 'bot1', 'user1'); // ws2 已经有 c_a
	register('c_x', ws1, 'bot1', 'user1'); // ws1 有 c_x，同 clawId
	const result = register('c_x', ws2, 'bot1', 'user1');
	assert.deepEqual(result, { ok: true, migrated: true });
	const set = wsToConnIds.get(ws2);
	assert.ok(set.has('c_a') && set.has('c_x'));
	assert.equal(set.size, 2);
	cleanup();
});

test('register: userId 不匹配仍拒绝，旧 WS 不被 terminate', () => {
	const ws1 = createMockWs();
	const ws2 = createMockWs();
	register('c_1', ws1, 'bot1', 'user1');
	const result = register('c_1', ws2, 'bot1', 'other-user');
	assert.deepEqual(result, { ok: false, migrated: false });
	// 原条目不变
	assert.equal(lookup('c_1').ws, ws1);
	assert.equal(ws1.terminateCalls, 0);
	cleanup();
});

test('register: 同 userId 异 clawId 时仍迁移，保留 existing 的 clawId', () => {
	// 正常情况下 UI 端 connId 绑 claw 不会错位；万一错位（UI bug），以 server 历史事实为准，
	// 不把 userId 之外的字段当作安全边界——clawId 不是 safety boundary
	const ws1 = createMockWs();
	const ws2 = createMockWs();
	register('c_1', ws1, 'bot1', 'user1');
	const result = register('c_1', ws2, 'bot2', 'user1');
	assert.deepEqual(result, { ok: true, migrated: true });
	assert.equal(lookup('c_1').ws, ws2);
	assert.equal(lookup('c_1').clawId, 'bot1', 'existing clawId preserved');
	assert.equal(ws1.terminateCalls, 1);
	cleanup();
});

test('register: 旧 WS 无 terminate 方法时回退到 close(4000)', () => {
	const ws1 = { readyState: 1, closeCalls: [], send() {}, close(code, reason) { ws1.closeCalls.push({ code, reason }); } };
	const ws2 = createMockWs();
	register('c_1', ws1, 'bot1', 'user1');
	register('c_1', ws2, 'bot1', 'user1');
	assert.equal(ws1.closeCalls.length, 1);
	assert.equal(ws1.closeCalls[0].code, 4000);
	assert.equal(ws1.closeCalls[0].reason, 'migrated');
	cleanup();
});

test('register: 旧 WS terminate 抛异常时不影响迁移', () => {
	const ws1 = { readyState: 1, send() {}, terminate() { throw new Error('boom'); } };
	const ws2 = createMockWs();
	register('c_1', ws1, 'bot1', 'user1');
	const result = register('c_1', ws2, 'bot1', 'user1');
	assert.deepEqual(result, { ok: true, migrated: true });
	assert.equal(lookup('c_1').ws, ws2);
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

test('removeByWs: 守卫防御——entry.ws !== ws 时不误删（defensive，正常路径不可达）', () => {
	// 该场景通过底层 routes.set 构造，真实 register 路径不会走到这里；
	// 测试守卫逻辑本身对"路由已被重写到另一条 ws、但旧 ws 反向索引未清"的防御性。
	const ws1 = createMockWs();
	const ws2 = createMockWs();
	register('c_1', ws1, 'bot1', 'user1');
	routes.set('c_1', { ws: ws2, clawId: 'bot1', userId: 'user1' });
	assert.ok(wsToConnIds.get(ws1).has('c_1'));
	removeByWs(ws1);
	assert.equal(lookup('c_1').ws, ws2);
	assert.equal(wsToConnIds.get(ws1), undefined);
	cleanup();
});

test('removeByWs: 迁移完成后对旧 WS 调用是幂等 no-op', () => {
	const ws1 = createMockWs();
	const ws2 = createMockWs();
	register('c_1', ws1, 'bot1', 'user1');
	register('c_1', ws2, 'bot1', 'user1'); // 迁移
	// 旧 WS 的 set 已被 register 清空
	assert.equal(wsToConnIds.get(ws1), undefined);
	removeByWs(ws1);
	assert.equal(lookup('c_1').ws, ws2);
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
