import assert from 'node:assert/strict';
import test from 'node:test';

import {
	buildSessionUser,
	toAuthResponseUser,
	toSafeAuth,
	toSafeProfile,
	toSafeSettings,
} from './user-view.svc.js';

// ---- toSafeSettings ----

test('toSafeSettings: 返回完整结构，缺失字段用默认值填充', () => {
	const result = toSafeSettings({});
	assert.equal(result.theme, null);
	assert.equal(result.lang, null);
	assert.deepEqual(result.perfs, {});
	assert.deepEqual(result.uiState, {});
	assert.deepEqual(result.hintCounts, {});
});

test('toSafeSettings: 保留已有字段值', () => {
	const result = toSafeSettings({
		theme: 'dark',
		lang: 'zh-CN',
		perfs: { a: 1 },
		uiState: { open: true },
		hintCounts: { tip1: 3 },
	});
	assert.equal(result.theme, 'dark');
	assert.equal(result.lang, 'zh-CN');
	assert.deepEqual(result.perfs, { a: 1 });
	assert.deepEqual(result.uiState, { open: true });
	assert.deepEqual(result.hintCounts, { tip1: 3 });
});

// ---- toSafeAuth ----

test('toSafeAuth: 处理包含 localAuth 的 profile', () => {
	const result = toSafeAuth({
		localAuth: { loginName: 'alice' },
		externalAuths: [],
	});
	assert.deepEqual(result.auth.local, { loginName: 'alice' });
	assert.equal(result.authType, 'local');
});

test('toSafeAuth: 无 localAuth 时 local 为 null', () => {
	const result = toSafeAuth({
		localAuth: null,
		externalAuths: [],
	});
	assert.equal(result.auth.local, null);
	assert.equal(result.authType, null);
});

test('toSafeAuth: authType 参数覆盖默认值', () => {
	const result = toSafeAuth({
		localAuth: { loginName: 'alice' },
		externalAuths: [],
	}, 'github');
	assert.equal(result.authType, 'github');
});

test('toSafeAuth: 处理 externalAuths 列表', () => {
	const result = toSafeAuth({
		localAuth: null,
		externalAuths: [
			{ oauthType: 'github', oauthName: 'bob', oauthAvatar: 'http://a.png' },
			{ oauthType: 'google', oauthName: 'bob2', oauthAvatar: null },
		],
	});
	assert.deepEqual(result.auth.github, { oauthName: 'bob', oauthAvatar: 'http://a.png' });
	assert.deepEqual(result.auth.google, { oauthName: 'bob2', oauthAvatar: null });
});

test('toSafeAuth: 跳过 oauthType 为空的 externalAuth', () => {
	const result = toSafeAuth({
		localAuth: null,
		externalAuths: [
			{ oauthType: '', oauthName: 'skip' },
			{ oauthType: null, oauthName: 'skip2' },
			{ oauthType: undefined, oauthName: 'skip3' },
		],
	});
	// 只有 local 键
	assert.deepEqual(Object.keys(result.auth), ['local']);
});

test('toSafeAuth: 同一 oauthType 只取第一个', () => {
	const result = toSafeAuth({
		localAuth: null,
		externalAuths: [
			{ oauthType: 'github', oauthName: 'first' },
			{ oauthType: 'github', oauthName: 'second' },
		],
	});
	assert.equal(result.auth.github.oauthName, 'first');
});

test('toSafeAuth: profile 为 null 时 externalAuths 为空', () => {
	const result = toSafeAuth(null);
	assert.equal(result.auth.local, null);
	assert.equal(result.authType, null);
});

test('toSafeAuth: profile 无 externalAuths 属性', () => {
	const result = toSafeAuth({ localAuth: null });
	assert.equal(result.auth.local, null);
});

// ---- toSafeProfile ----

test('toSafeProfile: 返回正确的用户 profile 结构', () => {
	const profile = {
		id: 123n,
		name: 'Alice',
		avatar: 'http://a.png',
		level: 1,
		localAuth: { loginName: 'alice' },
		externalAuths: [],
		lastLoginAt: new Date('2026-01-01T00:00:00.000Z'),
	};
	const result = toSafeProfile(profile);
	assert.equal(result.id, '123');
	assert.equal(result.name, 'Alice');
	assert.equal(result.avatar, 'http://a.png');
	assert.equal(result.level, 1);
	assert.equal(result.authType, 'local');
	assert.equal(result.lastLoginAt, '2026-01-01T00:00:00.000Z');
});

test('toSafeProfile: lastLoginAt 为非 Date 时直接透传', () => {
	const profile = {
		id: 1n,
		name: null,
		avatar: null,
		level: 0,
		localAuth: null,
		externalAuths: [],
		lastLoginAt: '2026-01-01',
	};
	const result = toSafeProfile(profile);
	assert.equal(result.lastLoginAt, '2026-01-01');
});

test('toSafeProfile: lastLoginAt 为 null 时返回 null', () => {
	const profile = {
		id: 1n,
		name: null,
		avatar: null,
		level: 0,
		localAuth: null,
		externalAuths: [],
		lastLoginAt: null,
	};
	const result = toSafeProfile(profile);
	assert.equal(result.lastLoginAt, null);
});

// ---- buildSessionUser ----

test('buildSessionUser: 缺少 userSetting 时抛出异常', () => {
	assert.throws(
		() => buildSessionUser({ id: 1n }),
		(err) => {
			assert.equal(err.message, 'UserSetting is required');
			return true;
		},
	);
});

test('buildSessionUser: profile 为 null 时抛出异常', () => {
	assert.throws(
		() => buildSessionUser(null),
		(err) => {
			assert.equal(err.message, 'UserSetting is required');
			return true;
		},
	);
});

test('buildSessionUser: 返回完整 session user 结构', () => {
	const profile = {
		id: 42n,
		name: 'Bob',
		avatar: 'http://b.png',
		level: 2,
		locked: false,
		localAuth: { loginName: 'bob' },
		externalAuths: [],
		lastLoginAt: new Date('2026-02-01T00:00:00.000Z'),
		userSetting: { theme: 'dark', lang: 'en' },
	};
	const result = buildSessionUser(profile);
	assert.equal(result.id, 42n);
	assert.equal(result.name, 'Bob');
	assert.equal(result.avatar, 'http://b.png');
	assert.equal(result.level, 2);
	assert.equal(result.locked, false);
	assert.equal(result.authType, 'local');
	assert.equal(result.settings.theme, 'dark');
});

// ---- toAuthResponseUser ----

test('toAuthResponseUser: 将 session user 转为响应格式', () => {
	const user = {
		id: 10n,
		name: 'Carol',
		avatar: null,
		level: 1,
		authType: 'local',
		auth: { local: { loginName: 'carol' } },
		settings: { theme: null },
		lastLoginAt: null,
	};
	const result = toAuthResponseUser(user);
	assert.equal(result.id, '10');
	assert.equal(result.name, 'Carol');
	assert.equal(result.avatar, null);
	assert.equal(result.lastLoginAt, null);
});
