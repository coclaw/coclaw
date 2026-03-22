import assert from 'node:assert/strict';
import test from 'node:test';

import { changePassword, createLocalAccount, loginByLoginName } from './local-auth.svc.js';

function makeLocalAuth({
	userId = 123n,
	loginName = 'alice',
	passwordHash = 'hash',
	userLocked = false,
	localLocked = false,
} = {}) {
	return {
		userId,
		loginName,
		passwordHash,
		locked: localLocked,
		user: {
			id: userId,
			name: 'Alice',
			avatar: null,
			level: 0,
			locked: userLocked,
			externalAuths: [],
			userSetting: {
				theme: null,
				lang: null,
				perfs: {},
				uiState: {},
				hintCounts: {},
			},
		},
	};
}

test('loginByLoginName: should reject invalid input', async () => {
	const result = await loginByLoginName({
		loginName: '',
		password: '',
	}, {
		findByLoginName: async () => null,
	});

	assert.equal(result.ok, false);
	assert.equal(result.code, 'INVALID_INPUT');
});

test('loginByLoginName: should reject when user not found', async () => {
	const result = await loginByLoginName({
		loginName: 'alice',
		password: 'pwd',
	}, {
		findByLoginName: async () => null,
	});

	assert.equal(result.ok, false);
	assert.equal(result.code, 'INVALID_CREDENTIALS');
});

test('loginByLoginName: should reject locked account', async () => {
	const result = await loginByLoginName({
		loginName: 'alice',
		password: 'pwd',
	}, {
		findByLoginName: async () => makeLocalAuth({ userLocked: true }),
	});

	assert.equal(result.ok, false);
	assert.equal(result.code, 'ACCOUNT_LOCKED');
});

test('loginByLoginName: should reject wrong password', async () => {
	const result = await loginByLoginName({
		loginName: 'alice',
		password: 'wrong',
	}, {
		findByLoginName: async () => makeLocalAuth(),
		scryptImpl: {
			verifyPassword: async () => false,
		},
	});

	assert.equal(result.ok, false);
	assert.equal(result.code, 'INVALID_CREDENTIALS');
});

test('loginByLoginName: should return user and touch login time', async () => {
	let touchedUserId = null;

	const result = await loginByLoginName({
		loginName: 'alice',
		password: 'correct',
	}, {
		findByLoginName: async () => makeLocalAuth({ userId: 987n }),
		scryptImpl: {
			verifyPassword: async () => true,
		},
		touchLoginSuccess: async (userId) => {
			touchedUserId = userId;
		},
	});

	assert.equal(result.ok, true);
	assert.equal(result.user.id, 987n);
	assert.equal(result.user.authType, 'local');
	assert.equal(result.user.auth.local.loginName, 'alice');
	assert.equal(touchedUserId, 987n);
});

test('changePassword: should reject short newPassword', async () => {
	const result = await changePassword(42n, {
		oldPassword: 'oldpasswd',
		newPassword: 'short',
	});

	assert.equal(result.ok, false);
	assert.equal(result.code, 'PASSWORD_TOO_SHORT');
});

test('changePassword: should return NO_LOCAL_AUTH when no record found', async () => {
	const result = await changePassword(42n, {
		oldPassword: 'oldpasswd',
		newPassword: 'newpasswd',
	}, {
		findByUserId: async () => null,
	});

	assert.equal(result.ok, false);
	assert.equal(result.code, 'NO_LOCAL_AUTH');
});

test('changePassword: should return INVALID_CREDENTIALS when old password wrong', async () => {
	const result = await changePassword(42n, {
		oldPassword: 'wrongpass',
		newPassword: 'newpasswd',
	}, {
		findByUserId: async () => ({ passwordHash: 'hash' }),
		scryptImpl: {
			verifyPassword: async () => false,
		},
	});

	assert.equal(result.ok, false);
	assert.equal(result.code, 'INVALID_CREDENTIALS');
});

test('changePassword: should hash new password and update', async () => {
	let updatedArgs = null;

	const result = await changePassword(42n, {
		oldPassword: 'correctpwd',
		newPassword: 'newpasswd',
	}, {
		findByUserId: async () => ({ passwordHash: 'hash' }),
		scryptImpl: {
			verifyPassword: async () => true,
			hashPassword: async (pwd) => `hashed:${pwd}`,
		},
		updatePassword: async (userId, hash) => {
			updatedArgs = { userId, hash };
		},
	});

	assert.equal(result.ok, true);
	assert.deepEqual(updatedArgs, {
		userId: 42n,
		hash: 'hashed:newpasswd',
	});
});

test('createLocalAccount: should reject empty password', async () => {
	const result = await createLocalAccount({
		loginName: 'alice',
		password: '',
	});

	assert.equal(result.ok, false);
	assert.equal(result.code, 'INVALID_INPUT');
});

test('createLocalAccount: should reject short password', async () => {
	const result = await createLocalAccount({
		loginName: 'alice',
		password: 'short',
	});

	assert.equal(result.ok, false);
	assert.equal(result.code, 'PASSWORD_TOO_SHORT');
});

test('createLocalAccount: should reject invalid loginName format', async () => {
	const result = await createLocalAccount({
		loginName: '_a',
		password: 'secret88',
	});

	assert.equal(result.ok, false);
	assert.equal(result.code, 'LOGIN_NAME_LENGTH');
});

test('createLocalAccount: should reject reserved loginName', async () => {
	const result = await createLocalAccount({
		loginName: 'admin',
		password: 'secret88',
	});

	assert.equal(result.ok, false);
	assert.equal(result.code, 'LOGIN_NAME_RESERVED');
});

test('createLocalAccount: should return LOGIN_NAME_TAKEN on P2002', async () => {
	const result = await createLocalAccount({
		loginName: 'alice',
		password: 'secret88',
	}, {
		genId: () => 778899n,
		scryptImpl: {
			hashPassword: async (pwd) => `hashed:${pwd}`,
		},
		createLocalUser: async () => {
			const err = new Error('Unique constraint failed');
			err.code = 'P2002';
			throw err;
		},
	});

	assert.equal(result.ok, false);
	assert.equal(result.code, 'LOGIN_NAME_TAKEN');
});

test('createLocalAccount: should return ok with session user and touch login time on success', async () => {
	let createdPayload = null;
	let touchedUserId = null;

	const result = await createLocalAccount({
		loginName: 'alice',
		password: 'secret88',
	}, {
		genId: () => 778899n,
		scryptImpl: {
			hashPassword: async (pwd) => `hashed:${pwd}`,
		},
		createLocalUser: async (payload) => {
			createdPayload = payload;
			return { id: payload.userId };
		},
		findByLoginName: async () => makeLocalAuth({ userId: 778899n, loginName: 'alice' }),
		touchLoginSuccess: async (userId) => {
			touchedUserId = userId;
		},
	});

	assert.equal(result.ok, true);
	assert.equal(result.user.id, 778899n);
	assert.equal(result.user.authType, 'local');
	assert.equal(result.user.auth.local.loginName, 'alice');
	assert.equal(touchedUserId, 778899n);
	assert.ok(result.user.lastLoginAt instanceof Date);
	assert.deepEqual(createdPayload, {
		userId: 778899n,
		loginName: 'alice',
		passwordHash: 'hashed:secret88',
	});
});
