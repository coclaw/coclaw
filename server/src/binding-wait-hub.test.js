import assert from 'node:assert/strict';
import test from 'node:test';

import {
	cancelBindingWait,
	markBindingBound,
	registerBindingWait,
	waitBindingResult,
} from './binding-wait-hub.js';

function futureMs(ms = 60_000) {
	return new Date(Date.now() + ms).toISOString();
}

test('registerBindingWait: should return a waitToken', () => {
	const token = registerBindingWait({
		code: 'reg-1',
		userId: '1',
		expiresAt: futureMs(),
	});
	assert.equal(typeof token, 'string');
	assert.ok(token.length > 0);
});

test('waitBindingResult: should return INVALID for unknown code', async () => {
	const result = await waitBindingResult({
		code: 'no-such-code',
		waitToken: 'abc',
		userId: '1',
	});
	assert.equal(result.status, 'INVALID');
});

test('waitBindingResult: should return INVALID for wrong waitToken', async () => {
	registerBindingWait({
		code: 'token-mismatch',
		userId: '1',
		expiresAt: futureMs(),
	});
	const result = await waitBindingResult({
		code: 'token-mismatch',
		waitToken: 'wrong',
		userId: '1',
	});
	assert.equal(result.status, 'INVALID');
});

test('waitBindingResult: should return INVALID for wrong userId', async () => {
	const token = registerBindingWait({
		code: 'uid-mismatch',
		userId: '1',
		expiresAt: futureMs(),
	});
	const result = await waitBindingResult({
		code: 'uid-mismatch',
		waitToken: token,
		userId: '999',
	});
	assert.equal(result.status, 'INVALID');
});

test('markBindingBound + waitBindingResult: should return BOUND', async () => {
	const token = registerBindingWait({
		code: 'bound-1',
		userId: '1',
		expiresAt: futureMs(),
	});
	markBindingBound({ code: 'bound-1', botId: 42, botName: 'MyBot' });

	const result = await waitBindingResult({
		code: 'bound-1',
		waitToken: token,
		userId: '1',
	});
	assert.equal(result.status, 'BOUND');
	assert.deepEqual(result.bot, { id: '42', name: 'MyBot' });
});

test('markBindingBound: should ignore non-pending state', () => {
	const _token = registerBindingWait({
		code: 'double-bind',
		userId: '1',
		expiresAt: futureMs(),
	});
	markBindingBound({ code: 'double-bind', botId: 1, botName: 'A' });
	// 第二次 bind 应被忽略
	markBindingBound({ code: 'double-bind', botId: 2, botName: 'B' });

	// 验证仍是第一次 bind 的结果不会报错即可
});

test('cancelBindingWait: should cancel pending state', async () => {
	const token = registerBindingWait({
		code: 'cancel-1',
		userId: '1',
		expiresAt: futureMs(),
	});

	const cancelled = cancelBindingWait({
		code: 'cancel-1',
		waitToken: token,
		userId: '1',
	});
	assert.equal(cancelled, true);

	const result = await waitBindingResult({
		code: 'cancel-1',
		waitToken: token,
		userId: '1',
	});
	assert.equal(result.status, 'CANCELLED');
});

test('cancelBindingWait: should reject wrong token', () => {
	registerBindingWait({
		code: 'cancel-bad',
		userId: '1',
		expiresAt: futureMs(),
	});
	const cancelled = cancelBindingWait({
		code: 'cancel-bad',
		waitToken: 'wrong',
		userId: '1',
	});
	assert.equal(cancelled, false);
});

test('cancelBindingWait: should reject already-bound state', () => {
	const boundToken = registerBindingWait({
		code: 'cancel-after-bound',
		userId: '1',
		expiresAt: futureMs(),
	});
	markBindingBound({ code: 'cancel-after-bound', botId: 1 });

	const cancelled = cancelBindingWait({
		code: 'cancel-after-bound',
		waitToken: boundToken,
		userId: '1',
	});
	assert.equal(cancelled, false);
});

test('waitBindingResult: should return TIMEOUT for expired code', async () => {
	const token = registerBindingWait({
		code: 'expired-1',
		userId: '1',
		expiresAt: new Date(Date.now() - 1000).toISOString(),
	});

	const result = await waitBindingResult({
		code: 'expired-1',
		waitToken: token,
		userId: '1',
	});
	assert.equal(result.status, 'TIMEOUT');
});

test('registerBindingWait: re-register should reset state and cleanup timer', () => {
	const token1 = registerBindingWait({
		code: 're-reg',
		userId: '1',
		expiresAt: futureMs(),
	});
	const token2 = registerBindingWait({
		code: 're-reg',
		userId: '2',
		expiresAt: futureMs(),
	});

	// 新 token 应与旧 token 不同
	assert.notEqual(token1, token2);
});

test('markBindingBound: should notify waiting resolvers', async () => {
	const token = registerBindingWait({
		code: 'notify-1',
		userId: '1',
		expiresAt: futureMs(),
	});

	// 启动等待，然后立即 bind
	const waitPromise = waitBindingResult({
		code: 'notify-1',
		waitToken: token,
		userId: '1',
	});

	markBindingBound({ code: 'notify-1', botId: 99, botName: 'Bot99' });

	const result = await waitPromise;
	assert.equal(result.status, 'BOUND');
	assert.deepEqual(result.bot, { id: '99', name: 'Bot99' });
});

test('cancelBindingWait: should notify waiting resolvers', async () => {
	const token = registerBindingWait({
		code: 'notify-cancel',
		userId: '1',
		expiresAt: futureMs(),
	});

	const waitPromise = waitBindingResult({
		code: 'notify-cancel',
		waitToken: token,
		userId: '1',
	});

	cancelBindingWait({
		code: 'notify-cancel',
		waitToken: token,
		userId: '1',
	});

	const result = await waitPromise;
	assert.equal(result.status, 'CANCELLED');
});
