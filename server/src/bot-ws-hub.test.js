import assert from 'node:assert/strict';
import test from 'node:test';

import { botPingTick } from './bot-ws-hub.js';

const MAX_MISS = 4;

test('botPingTick: isAlive=true → action=ok, missCount 重置为 0', () => {
	const result = botPingTick({ isAlive: true, missCount: 3, bufferedAmount: 0 }, MAX_MISS);
	assert.equal(result.action, 'ok');
	assert.equal(result.missCount, 0);
});

test('botPingTick: isAlive=true 时忽略 bufferedAmount', () => {
	const result = botPingTick({ isAlive: true, missCount: 2, bufferedAmount: 99999 }, MAX_MISS);
	assert.equal(result.action, 'ok');
	assert.equal(result.missCount, 0);
});

test('botPingTick: isAlive=false + bufferedAmount>0 → action=skip, missCount 不变', () => {
	const result = botPingTick({ isAlive: false, missCount: 2, bufferedAmount: 1024 }, MAX_MISS);
	assert.equal(result.action, 'skip');
	assert.equal(result.missCount, 2);
});

test('botPingTick: isAlive=false + bufferedAmount=0 + 未达上限 → action=miss', () => {
	const result = botPingTick({ isAlive: false, missCount: 0, bufferedAmount: 0 }, MAX_MISS);
	assert.equal(result.action, 'miss');
	assert.equal(result.missCount, 1);
});

test('botPingTick: 连续 miss 递增直到上限前', () => {
	let missCount = 0;
	for (let i = 1; i < MAX_MISS; i++) {
		const result = botPingTick({ isAlive: false, missCount, bufferedAmount: 0 }, MAX_MISS);
		assert.equal(result.action, 'miss');
		assert.equal(result.missCount, i);
		missCount = result.missCount;
	}
});

test('botPingTick: 达到 maxMiss → action=terminate', () => {
	const result = botPingTick({ isAlive: false, missCount: MAX_MISS - 1, bufferedAmount: 0 }, MAX_MISS);
	assert.equal(result.action, 'terminate');
	assert.equal(result.missCount, MAX_MISS);
});

test('botPingTick: bufferedAmount>0 阻止 terminate 即使 missCount 已高', () => {
	const result = botPingTick({ isAlive: false, missCount: MAX_MISS - 1, bufferedAmount: 500 }, MAX_MISS);
	assert.equal(result.action, 'skip');
	assert.equal(result.missCount, MAX_MISS - 1);
});

test('botPingTick: pong 后 miss 场景——模拟完整周期', () => {
	// 1. 正常轮次
	let r = botPingTick({ isAlive: true, missCount: 0, bufferedAmount: 0 }, MAX_MISS);
	assert.equal(r.action, 'ok');

	// 2. miss 1
	r = botPingTick({ isAlive: false, missCount: r.missCount, bufferedAmount: 0 }, MAX_MISS);
	assert.equal(r.action, 'miss');
	assert.equal(r.missCount, 1);

	// 3. miss 2
	r = botPingTick({ isAlive: false, missCount: r.missCount, bufferedAmount: 0 }, MAX_MISS);
	assert.equal(r.action, 'miss');
	assert.equal(r.missCount, 2);

	// 4. pong 收到 → 模拟外部重置 isAlive=true, missCount=0
	r = botPingTick({ isAlive: true, missCount: 0, bufferedAmount: 0 }, MAX_MISS);
	assert.equal(r.action, 'ok');
	assert.equal(r.missCount, 0);

	// 5. 再次 miss
	r = botPingTick({ isAlive: false, missCount: r.missCount, bufferedAmount: 0 }, MAX_MISS);
	assert.equal(r.action, 'miss');
	assert.equal(r.missCount, 1);
});

test('botPingTick: 大消息传输中途恢复——bufferedAmount 先高后低', () => {
	// miss 1
	let r = botPingTick({ isAlive: false, missCount: 0, bufferedAmount: 0 }, MAX_MISS);
	assert.equal(r.action, 'miss');

	// 大消息开始传输，bufferedAmount > 0，跳过
	r = botPingTick({ isAlive: false, missCount: r.missCount, bufferedAmount: 8192 }, MAX_MISS);
	assert.equal(r.action, 'skip');
	assert.equal(r.missCount, 1); // 不增加

	// 大消息传完，pong 到达
	r = botPingTick({ isAlive: true, missCount: 0, bufferedAmount: 0 }, MAX_MISS);
	assert.equal(r.action, 'ok');
	assert.equal(r.missCount, 0);
});

// --- pruneExpiredTickets tests ---

import { pruneExpiredTickets } from './bot-ws-hub.js';

test('pruneExpiredTickets: removes expired entries', () => {
	const map = new Map([
		['a', { expiresAt: Date.now() - 1000 }],
		['b', { expiresAt: Date.now() - 5000 }],
	]);
	const pruned = pruneExpiredTickets(map);
	assert.equal(pruned, 2);
	assert.equal(map.size, 0);
});

test('pruneExpiredTickets: keeps unexpired entries', () => {
	const map = new Map([
		['alive', { expiresAt: Date.now() + 60_000 }],
		['dead', { expiresAt: Date.now() - 1000 }],
	]);
	const pruned = pruneExpiredTickets(map);
	assert.equal(pruned, 1);
	assert.equal(map.size, 1);
	assert.ok(map.has('alive'));
	assert.ok(!map.has('dead'));
});

test('pruneExpiredTickets: returns 0 on empty map', () => {
	const map = new Map();
	const pruned = pruneExpiredTickets(map);
	assert.equal(pruned, 0);
});

test('pruneExpiredTickets: returns 0 when all entries are fresh', () => {
	const map = new Map([
		['x', { expiresAt: Date.now() + 10_000 }],
		['y', { expiresAt: Date.now() + 20_000 }],
	]);
	const pruned = pruneExpiredTickets(map);
	assert.equal(pruned, 0);
	assert.equal(map.size, 2);
});
