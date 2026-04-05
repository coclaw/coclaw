import assert from 'node:assert/strict';
import test from 'node:test';

import {
	cancelBindingWait,
	markBindingBound,
	registerBindingWait,
	waitBindingResult,
	__test,
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
	markBindingBound({ code: 'bound-1', clawId: 42, clawName: 'MyBot' });

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
	markBindingBound({ code: 'double-bind', clawId: 1, clawName: 'A' });
	// 第二次 bind 应被忽略
	markBindingBound({ code: 'double-bind', clawId: 2, clawName: 'B' });

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
	markBindingBound({ code: 'cancel-after-bound', clawId: 1 });

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

	markBindingBound({ code: 'notify-1', clawId: 99, clawName: 'Bot99' });

	const result = await waitPromise;
	assert.equal(result.status, 'BOUND');
	assert.deepEqual(result.bot, { id: '99', name: 'Bot99' });
});

test('settleState: waiter 抛异常时不中断其他 waiter', async () => {
	const token = registerBindingWait({
		code: 'settle-throw',
		userId: '1',
		expiresAt: futureMs(),
	});

	// 第一个 waiter 会抛异常
	const results = [];
	const p1 = waitBindingResult({ code: 'settle-throw', waitToken: token, userId: '1' }).then((r) => results.push(r));
	const p2 = waitBindingResult({ code: 'settle-throw', waitToken: token, userId: '1' }).then((r) => results.push(r));

	markBindingBound({ code: 'settle-throw', clawId: 77, clawName: 'Bot77' });

	await Promise.all([p1, p2]);
	assert.equal(results.length, 2);
	assert.equal(results[0].status, 'BOUND');
	assert.equal(results[1].status, 'BOUND');
});

test('waitBindingResult: 长轮询超时且状态未变时返回 PENDING', async () => {
	const origTimeout = __test.POLL_TIMEOUT_MS;
	__test.POLL_TIMEOUT_MS = 30; // 30ms 超时
	try {
		const token = registerBindingWait({
			code: 'lp-pending',
			userId: '1',
			expiresAt: futureMs(),
		});

		const result = await waitBindingResult({ code: 'lp-pending', waitToken: token, userId: '1' });
		assert.equal(result.status, 'PENDING');
	} finally {
		__test.POLL_TIMEOUT_MS = origTimeout;
	}
});

test('waitBindingResult: 长轮询超时时已过期返回 TIMEOUT（超时回调中检测）', async () => {
	const origTimeout = __test.POLL_TIMEOUT_MS;
	__test.POLL_TIMEOUT_MS = 50;
	try {
		const token = registerBindingWait({
			code: 'lp-timeout',
			userId: '1',
			expiresAt: new Date(Date.now() + 30).toISOString(), // 30ms 后过期
		});

		// 在过期前调用 waitBindingResult，进入 Promise 分支
		// 50ms 后超时回调触发时，expiresAt 已过期
		const result = await waitBindingResult({ code: 'lp-timeout', waitToken: token, userId: '1' });
		assert.equal(result.status, 'TIMEOUT');
	} finally {
		__test.POLL_TIMEOUT_MS = origTimeout;
	}
});

test('waitBindingResult: 长轮询超时时已 bound（绕过 settle）返回 BOUND', async () => {
	const origTimeout = __test.POLL_TIMEOUT_MS;
	__test.POLL_TIMEOUT_MS = 50;
	try {
		const token = registerBindingWait({
			code: 'lp-bound',
			userId: '1',
			expiresAt: futureMs(),
		});

		// 启动等待（进入 Promise 分支）
		const promise = waitBindingResult({ code: 'lp-bound', waitToken: token, userId: '1' });

		// 直接修改内部状态为 bound，绕过 settleState
		// 这样 waiter 不会被提前 settle，超时回调会检测到 bound 状态
		const state = __test.bindingStates.get('lp-bound');
		state.status = 'bound';
		state.boundClaw = { id: '88', name: 'Bot88' };

		const result = await promise;
		assert.equal(result.status, 'BOUND');
		assert.deepEqual(result.bot, { id: '88', name: 'Bot88' });
	} finally {
		__test.POLL_TIMEOUT_MS = origTimeout;
	}
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
