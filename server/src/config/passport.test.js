import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import passport from 'passport';

import { setupPassport } from './passport.js';

/**
 * 拦截 passport 方法，提取 setupPassport 注册的回调函数
 * @param {object} deps - 传递给 setupPassport 的依赖
 * @returns {{ strategyVerify: Function, serializeFn: Function, deserializeFn: Function }}
 */
function extractCallbacks(deps = {}) {
	let strategyVerify = null;
	let serializeFn = null;
	let deserializeFn = null;

	const origUse = passport.use;
	const origSerialize = passport.serializeUser;
	const origDeserialize = passport.deserializeUser;

	mock.method(passport, 'use', (_name, strategy) => {
		strategyVerify = strategy._verify;
	});
	mock.method(passport, 'serializeUser', (fn) => {
		serializeFn = fn;
	});
	mock.method(passport, 'deserializeUser', (fn) => {
		deserializeFn = fn;
	});

	setupPassport(deps);

	passport.use = origUse;
	passport.serializeUser = origSerialize;
	passport.deserializeUser = origDeserialize;

	return { strategyVerify, serializeFn, deserializeFn };
}

// --- serializeUser ---

test('serializeUser: should serialize user id to string', (t, done) => {
	const { serializeFn } = extractCallbacks();

	serializeFn({ id: 12345n }, (err, serialized) => {
		assert.equal(err, null);
		assert.equal(serialized, '12345');
		done();
	});
});

// --- strategy verify: 登录成功 ---

test('strategy verify: should return done(null, user) on login success', async () => {
	const fakeUser = { id: 1n, name: 'Alice' };
	const { strategyVerify } = extractCallbacks({
		login: async () => ({ ok: true, user: fakeUser }),
	});

	const result = await new Promise((resolve) => {
		strategyVerify('alice', 'correctpwd', (err, user, info) => {
			resolve({ err, user, info });
		});
	});

	assert.equal(result.err, null);
	assert.equal(result.user, fakeUser);
});

// --- strategy verify: 登录失败（凭据错误等） ---

test('strategy verify: should return done(null, false, info) on login failure', async () => {
	const { strategyVerify } = extractCallbacks({
		login: async () => ({
			ok: false,
			code: 'INVALID_CREDENTIALS',
			message: 'Wrong password',
		}),
	});

	const result = await new Promise((resolve) => {
		strategyVerify('alice', 'wrongpwd', (err, user, info) => {
			resolve({ err, user, info });
		});
	});

	assert.equal(result.err, null);
	assert.equal(result.user, false);
	assert.deepEqual(result.info, {
		code: 'INVALID_CREDENTIALS',
		message: 'Wrong password',
	});
});

// --- strategy verify: 异常抛出 ---

test('strategy verify: should return done(err) on exception', async () => {
	const boom = new Error('service crashed');
	const { strategyVerify } = extractCallbacks({
		login: async () => { throw boom; },
	});

	const result = await new Promise((resolve) => {
		strategyVerify('alice', 'pwd', (err) => {
			resolve({ err });
		});
	});

	assert.equal(result.err, boom);
});

// --- deserializeUser: 用户存在 ---

test('deserializeUser: should return user object when found', async () => {
	const fakeUser = {
		id: 123n,
		name: 'Bob',
		avatar: 'http://example.com/bob.png',
		level: 2,
		locked: false,
	};
	const { deserializeFn } = extractCallbacks({
		findUser: async () => fakeUser,
	});

	const result = await new Promise((resolve) => {
		deserializeFn('123', (err, user) => {
			resolve({ err, user });
		});
	});

	assert.equal(result.err, null);
	assert.deepEqual(result.user, {
		id: 123n,
		name: 'Bob',
		avatar: 'http://example.com/bob.png',
		level: 2,
		locked: false,
	});
});

// --- deserializeUser: 用户不存在 ---

test('deserializeUser: should call done(null, false) when user not found', async () => {
	const { deserializeFn } = extractCallbacks({
		findUser: async () => null,
	});

	const result = await new Promise((resolve) => {
		deserializeFn('999', (err, user) => {
			resolve({ err, user });
		});
	});

	assert.equal(result.err, null);
	assert.equal(result.user, false);
});

// --- deserializeUser: 异常抛出 ---

test('deserializeUser: should call done(err) on exception', async () => {
	const boom = new Error('db connection lost');
	const { deserializeFn } = extractCallbacks({
		findUser: async () => { throw boom; },
	});

	const result = await new Promise((resolve) => {
		deserializeFn('123', (err) => {
			resolve({ err });
		});
	});

	assert.equal(result.err, boom);
});

// --- setupPassport 默认调用（不传 deps） ---

test('setupPassport: should work without deps argument', () => {
	// 验证无参数调用不报错（使用默认依赖）
	const { strategyVerify, serializeFn, deserializeFn } = extractCallbacks();

	assert.equal(typeof strategyVerify, 'function');
	assert.equal(typeof serializeFn, 'function');
	assert.equal(typeof deserializeFn, 'function');
});
