import assert from 'node:assert/strict';
import test from 'node:test';

import {
	cancelClaimWait,
	markClaimBound,
	registerClaimWait,
	waitClaimResult,
} from './claim-wait-hub.js';

test('registerClaimWait: should return waitToken', () => {
	const waitToken = registerClaimWait({
		code: 'CW_01',
		expiresAt: new Date(Date.now() + 60_000),
	});
	assert.equal(typeof waitToken, 'string');
	assert.ok(waitToken.length > 0);
});

test('waitClaimResult: should return INVALID for unknown code', async () => {
	const result = await waitClaimResult({ code: 'UNKNOWN', waitToken: 'x' });
	assert.equal(result.status, 'INVALID');
});

test('waitClaimResult: should return INVALID for wrong waitToken', async () => {
	registerClaimWait({
		code: 'CW_02',
		expiresAt: new Date(Date.now() + 60_000),
	});
	const result = await waitClaimResult({ code: 'CW_02', waitToken: 'wrong' });
	assert.equal(result.status, 'INVALID');
});

test('markClaimBound + waitClaimResult: should resolve immediately if already bound', async () => {
	const waitToken = registerClaimWait({
		code: 'CW_03',
		expiresAt: new Date(Date.now() + 60_000),
	});
	markClaimBound({ code: 'CW_03', botId: 42n, token: 'tok-42' });

	const result = await waitClaimResult({ code: 'CW_03', waitToken });
	assert.equal(result.status, 'BOUND');
	assert.equal(result.botId, '42');
	assert.equal(result.token, 'tok-42');
});

test('markClaimBound: should notify pending waiters', async () => {
	const waitToken = registerClaimWait({
		code: 'CW_04',
		expiresAt: new Date(Date.now() + 60_000),
	});

	const promise = waitClaimResult({ code: 'CW_04', waitToken });
	markClaimBound({ code: 'CW_04', botId: 99n, token: 'tok-99' });

	const result = await promise;
	assert.equal(result.status, 'BOUND');
	assert.equal(result.botId, '99');
	assert.equal(result.token, 'tok-99');
});

test('waitClaimResult: should return TIMEOUT for expired code', async () => {
	const waitToken = registerClaimWait({
		code: 'CW_05',
		expiresAt: new Date(Date.now() - 1000),
	});

	const result = await waitClaimResult({ code: 'CW_05', waitToken });
	assert.equal(result.status, 'TIMEOUT');
});

test('markClaimBound: should not notify if not pending', () => {
	const waitToken = registerClaimWait({
		code: 'CW_06',
		expiresAt: new Date(Date.now() - 1000),
	});
	// 先让它过期
	waitClaimResult({ code: 'CW_06', waitToken });
	// markClaimBound 不应报错
	markClaimBound({ code: 'CW_06', botId: 1n, token: 'tok' });
});

test('markClaimBound: should no-op for unknown code', () => {
	markClaimBound({ code: 'NOPE', botId: 1n, token: 'tok' });
	// 不应抛异常
});

test('registerClaimWait: should schedule cleanup timer', async () => {
	const code = 'CW_CLEANUP_01';
	// 过期时间设为过去，TTL 计算后会 clamp 到 0
	registerClaimWait({
		code,
		expiresAt: new Date(Date.now() - 120_000),
	});
	// 等待 timer 触发（TTL clamp 到 0，setImmediate-like）
	await new Promise((r) => setTimeout(r, 50));
	// 条目应已被清理
	const result = await waitClaimResult({ code, waitToken: 'any' });
	assert.equal(result.status, 'INVALID');
});

test('markClaimBound: should reschedule cleanup timer', async () => {
	const code = 'CW_CLEANUP_02';
	const waitToken = registerClaimWait({
		code,
		expiresAt: new Date(Date.now() + 300_000),
	});
	markClaimBound({ code, botId: 77n, token: 'tok-77' });

	// bound 后条目仍可访问（60s 缓冲窗口内）
	const result = await waitClaimResult({ code, waitToken });
	assert.equal(result.status, 'BOUND');
	assert.equal(result.botId, '77');
});

test('cancelClaimWait: should settle waiters without changing status', async () => {
	const code = 'CW_CANCEL_01';
	const waitToken = registerClaimWait({
		code,
		expiresAt: new Date(Date.now() + 60_000),
	});

	const promise = waitClaimResult({ code, waitToken });
	const cancelled = cancelClaimWait({ code, waitToken });

	assert.equal(cancelled, true);
	const result = await promise;
	assert.equal(result.status, 'CANCELLED');
});

test('cancelClaimWait: markClaimBound should still work after cancel', async () => {
	const code = 'CW_CANCEL_THEN_BOUND';
	const waitToken = registerClaimWait({
		code,
		expiresAt: new Date(Date.now() + 60_000),
	});

	// cancel 提前 settle 当前 waiter
	cancelClaimWait({ code, waitToken });

	// claim 完成后 markClaimBound 仍应生效（status 仍为 pending）
	markClaimBound({ code, botId: 55n, token: 'tok-55' });

	// 下一轮 wait 应立即拿到 BOUND
	const result = await waitClaimResult({ code, waitToken });
	assert.equal(result.status, 'BOUND');
	assert.equal(result.botId, '55');
	assert.equal(result.token, 'tok-55');
});

test('cancelClaimWait: should reject wrong waitToken', () => {
	const code = 'CW_CANCEL_02';
	registerClaimWait({
		code,
		expiresAt: new Date(Date.now() + 60_000),
	});
	assert.equal(cancelClaimWait({ code, waitToken: 'wrong' }), false);
});

test('cancelClaimWait: should reject already-bound state', () => {
	const code = 'CW_CANCEL_03';
	const waitToken = registerClaimWait({
		code,
		expiresAt: new Date(Date.now() + 60_000),
	});
	markClaimBound({ code, botId: 1n, token: 'tok' });
	assert.equal(cancelClaimWait({ code, waitToken }), false);
});

test('cancelClaimWait: should reject unknown code', () => {
	assert.equal(cancelClaimWait({ code: 'NOPE', waitToken: 'x' }), false);
});
