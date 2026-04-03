import assert from 'node:assert/strict';
import test from 'node:test';

import {
	changePasswordHandler,
	getCurrentUserHandler,
	getCurrentUserSettingsHandler,
	patchCurrentUserHandler,
	patchCurrentUserSettingsHandler,
	userRouter,
} from './user.route.js';

function createRes() {
	return {
		statusCode: null,
		body: null,
		status(code) {
			this.statusCode = code;
			return this;
		},
		json(payload) {
			this.body = payload;
			return this;
		},
	};
}

function makeUserProfile() {
	return {
		id: 123n,
		name: 'Alice',
		avatar: 'https://example.com/a.png',
		level: 1,
		lastLoginAt: new Date('2026-01-15T10:00:00.000Z'),
		localAuth: {
			loginName: 'alice',
		},
		externalAuths: [],
		userSetting: {
			theme: 'auto',
			lang: null,
			perfs: {},
			uiState: {},
			hintCounts: {},
		},
	};
}

test('getCurrentUserHandler: should return profile without settings by default', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		query: {},
	};
	const res = createRes();

	await getCurrentUserHandler(req, res, () => {}, {
		findUserProfile: async (_id, options) => {
			assert.equal(options.includeSettings, false);
			return makeUserProfile();
		},
	});

	assert.equal(res.statusCode, 200);
	assert.deepEqual(res.body, {
		profile: {
			id: '123',
			name: 'Alice',
			avatar: 'https://example.com/a.png',
			level: 1,
			authType: 'local',
			auth: {
				local: {
					loginName: 'alice',
				},
			},
			lastLoginAt: '2026-01-15T10:00:00.000Z',
		},
	});
	assert.equal(Object.hasOwn(res.body, 'settings'), false);
});

test('getCurrentUserHandler: should include settings when includeSettings=true', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		query: {
			includeSettings: 'true',
		},
	};
	const res = createRes();

	await getCurrentUserHandler(req, res, () => {}, {
		findUserProfile: async (_id, options) => {
			assert.equal(options.includeSettings, true);
			return makeUserProfile();
		},
	});

	assert.equal(res.statusCode, 200);
	assert.deepEqual(res.body.settings, {
		theme: 'auto',
		lang: null,
		perfs: {},
		uiState: {},
		hintCounts: {},
	});
});

test('patchCurrentUserHandler: should reject invalid input', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		body: {},
	};
	const res = createRes();

	await patchCurrentUserHandler(req, res, () => {});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.code, 'INVALID_INPUT');
});

test('patchCurrentUserHandler: should update and return profile', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		body: {
			name: 'Bob',
		},
	};
	const res = createRes();
	let updated = null;

	await patchCurrentUserHandler(req, res, () => {}, {
		updateUserProfile: async (id, input) => {
			updated = { id, input };
		},
		findUserProfile: async () => makeUserProfile(),
	});

	assert.deepEqual(updated, {
		id: 123n,
		input: {
			name: 'Bob',
		},
	});
	assert.equal(res.statusCode, 200);
	assert.equal(res.body.profile.id, '123');
});

test('getCurrentUserSettingsHandler: should return settings', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
	};
	const res = createRes();

	await getCurrentUserSettingsHandler(req, res, () => {}, {
		findUserSetting: async () => ({
			theme: null,
			lang: null,
			perfs: {},
			uiState: {
				sidebar: {
					collapsed: true,
				},
			},
			hintCounts: {},
		}),
	});

	assert.equal(res.statusCode, 200);
	assert.deepEqual(res.body, {
		settings: {
			theme: null,
			lang: null,
			perfs: {},
			uiState: {
				sidebar: {
					collapsed: true,
				},
			},
			hintCounts: {},
		},
	});
});

test('patchCurrentUserSettingsHandler: should patch and return settings', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		body: {
			uiStatePatch: {
				sidebar: {
					collapsed: true,
				},
			},
		},
	};
	const res = createRes();

	await patchCurrentUserSettingsHandler(req, res, () => {}, {
		patchUserSetting: async () => ({
			theme: null,
			lang: null,
			perfs: {},
			uiState: {
				sidebar: {
					collapsed: true,
				},
			},
			hintCounts: {},
		}),
	});

	assert.equal(res.statusCode, 200);
	assert.deepEqual(res.body, {
		settings: {
			theme: null,
			lang: null,
			perfs: {},
			uiState: {
				sidebar: {
					collapsed: true,
				},
			},
			hintCounts: {},
		},
	});
});

test('patchCurrentUserSettingsHandler: should patch scalar-only fields', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		body: {
			theme: 'dark',
			lang: 'en',
		},
	};
	const res = createRes();
	let patchArgs = null;

	await patchCurrentUserSettingsHandler(req, res, () => {}, {
		patchUserSetting: async (userId, input) => {
			patchArgs = { userId, input };
			return {
				theme: 'dark',
				lang: 'en',
				perfs: {},
				uiState: {},
				hintCounts: {},
			};
		},
	});

	assert.equal(res.statusCode, 200);
	assert.deepEqual(patchArgs, {
		userId: 123n,
		input: { theme: 'dark', lang: 'en' },
	});
	assert.equal(res.body.settings.theme, 'dark');
	assert.equal(res.body.settings.lang, 'en');
});

test('patchCurrentUserSettingsHandler: should patch scalar fields to null', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		body: {
			theme: null,
			lang: null,
		},
	};
	const res = createRes();

	await patchCurrentUserSettingsHandler(req, res, () => {}, {
		patchUserSetting: async () => ({
			theme: null,
			lang: null,
			perfs: {},
			uiState: {},
			hintCounts: {},
		}),
	});

	assert.equal(res.statusCode, 200);
	assert.equal(res.body.settings.theme, null);
	assert.equal(res.body.settings.lang, null);
});

test('patchCurrentUserSettingsHandler: should reject invalid theme value', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		body: {
			theme: 'night',
		},
	};
	const res = createRes();

	await patchCurrentUserSettingsHandler(req, res, () => {});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.code, 'INVALID_INPUT');
	assert.equal(res.body.message, 'theme must be one of auto, dark, light or null');
});

test('patchCurrentUserSettingsHandler: should reject invalid lang value', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		body: {
			lang: 'ja',
		},
	};
	const res = createRes();

	await patchCurrentUserSettingsHandler(req, res, () => {});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.code, 'INVALID_INPUT');
	assert.equal(res.body.message, 'lang must be one of zh-CN, en or null');
});

test('changePasswordHandler: should reject missing fields', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		body: { oldPassword: 'abc' },
	};
	const res = createRes();

	await changePasswordHandler(req, res, () => {});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.code, 'INVALID_INPUT');
	assert.equal(res.body.message, 'newPassword is required');
});

test('changePasswordHandler: should return 401 when not authenticated', async () => {
	const req = {
		isAuthenticated: () => false,
		user: null,
		body: { oldPassword: 'oldpasswd', newPassword: 'newpasswd' },
	};
	const res = createRes();

	await changePasswordHandler(req, res, () => {});

	assert.equal(res.statusCode, 401);
	assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('changePasswordHandler: should return 400 when service returns PASSWORD_TOO_SHORT', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		body: { oldPassword: 'oldpassword', newPassword: 'short' },
	};
	const res = createRes();

	await changePasswordHandler(req, res, () => {}, {
		changePwd: async () => ({
			ok: false,
			code: 'PASSWORD_TOO_SHORT',
			message: 'password must be at least 8 characters',
		}),
	});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.code, 'PASSWORD_TOO_SHORT');
});

test('changePasswordHandler: should return 401 when service returns INVALID_CREDENTIALS', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		body: { oldPassword: 'wrongpassword', newPassword: 'newpasswd' },
	};
	const res = createRes();

	await changePasswordHandler(req, res, () => {}, {
		changePwd: async () => ({
			ok: false,
			code: 'INVALID_CREDENTIALS',
			message: 'Invalid credentials',
		}),
	});

	assert.equal(res.statusCode, 401);
	assert.equal(res.body.code, 'INVALID_CREDENTIALS');
});

test('changePasswordHandler: should return 400 when service returns NO_LOCAL_AUTH', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		body: { oldPassword: 'oldpasswd', newPassword: 'newpasswd' },
	};
	const res = createRes();

	await changePasswordHandler(req, res, () => {}, {
		changePwd: async () => ({
			ok: false,
			code: 'NO_LOCAL_AUTH',
			message: 'No local auth found for this user',
		}),
	});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.code, 'NO_LOCAL_AUTH');
});

test('changePasswordHandler: should return 200 on success', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		body: { oldPassword: 'oldpasswd', newPassword: 'newpasswd' },
	};
	const res = createRes();

	await changePasswordHandler(req, res, () => {}, {
		changePwd: async () => ({ ok: true }),
	});

	assert.equal(res.statusCode, 200);
	assert.deepEqual(res.body, { message: 'Password changed' });
});

// --- validateSettingsPatchPayload 分支覆盖 ---

test('patchCurrentUserSettingsHandler: should reject non-object body (null)', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		body: null,
	};
	const res = createRes();

	await patchCurrentUserSettingsHandler(req, res, () => {});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.code, 'INVALID_INPUT');
	assert.equal(res.body.message, 'Request body must be an object');
});

test('patchCurrentUserSettingsHandler: should reject array body', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		body: [1, 2],
	};
	const res = createRes();

	await patchCurrentUserSettingsHandler(req, res, () => {});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.message, 'Request body must be an object');
});

test('patchCurrentUserSettingsHandler: should reject body with no known fields', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		body: { unknown: 'field' },
	};
	const res = createRes();

	await patchCurrentUserSettingsHandler(req, res, () => {});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.message, 'At least one patch field is required');
});

test('patchCurrentUserSettingsHandler: should reject non-string theme', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		body: { theme: 123 },
	};
	const res = createRes();

	await patchCurrentUserSettingsHandler(req, res, () => {});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.message, 'theme must be a string or null');
});

test('patchCurrentUserSettingsHandler: should reject non-string lang', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		body: { lang: 42 },
	};
	const res = createRes();

	await patchCurrentUserSettingsHandler(req, res, () => {});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.message, 'lang must be a string or null');
});

test('patchCurrentUserSettingsHandler: should reject non-object perfsPatch', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		body: { perfsPatch: 'not-an-object' },
	};
	const res = createRes();

	await patchCurrentUserSettingsHandler(req, res, () => {});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.message, 'perfsPatch must be an object');
});

test('patchCurrentUserSettingsHandler: should reject array perfsPatch', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		body: { perfsPatch: [1] },
	};
	const res = createRes();

	await patchCurrentUserSettingsHandler(req, res, () => {});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.message, 'perfsPatch must be an object');
});

test('patchCurrentUserSettingsHandler: should reject non-object uiStatePatch', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		body: { uiStatePatch: 'bad' },
	};
	const res = createRes();

	await patchCurrentUserSettingsHandler(req, res, () => {});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.message, 'uiStatePatch must be an object');
});

test('patchCurrentUserSettingsHandler: should reject non-object hintCountsPatch', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		body: { hintCountsPatch: 42 },
	};
	const res = createRes();

	await patchCurrentUserSettingsHandler(req, res, () => {});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.message, 'hintCountsPatch must be an object');
});

// --- getCurrentUserHandler 分支覆盖 ---

test('getCurrentUserHandler: should return 401 when profile not found', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 999n },
		query: {},
	};
	const res = createRes();

	await getCurrentUserHandler(req, res, () => {}, {
		findUserProfile: async () => null,
	});

	assert.equal(res.statusCode, 401);
	assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('getCurrentUserHandler: should return 401 when not authenticated', async () => {
	const req = {
		isAuthenticated: () => false,
		user: null,
		query: {},
	};
	const res = createRes();

	await getCurrentUserHandler(req, res, () => {});

	assert.equal(res.statusCode, 401);
	assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('getCurrentUserHandler: should call next on error', async () => {
	const boom = new Error('db error');
	let nextErr = null;
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		query: {},
	};
	const res = createRes();

	await getCurrentUserHandler(req, res, (err) => { nextErr = err; }, {
		findUserProfile: async () => { throw boom; },
	});

	assert.equal(nextErr, boom);
});

// --- validateChangePasswordPayload 分支覆盖 ---

test('changePasswordHandler: should reject non-object body (null)', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		body: null,
	};
	const res = createRes();

	await changePasswordHandler(req, res, () => {});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.message, 'Request body must be an object');
});

test('changePasswordHandler: should reject array body', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		body: [],
	};
	const res = createRes();

	await changePasswordHandler(req, res, () => {});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.message, 'Request body must be an object');
});

test('changePasswordHandler: should reject missing oldPassword', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		body: { newPassword: 'newpasswd' },
	};
	const res = createRes();

	await changePasswordHandler(req, res, () => {});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.message, 'oldPassword is required');
});

test('changePasswordHandler: should reject empty oldPassword', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		body: { oldPassword: '   ', newPassword: 'newpasswd' },
	};
	const res = createRes();

	await changePasswordHandler(req, res, () => {});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.message, 'oldPassword is required');
});

test('changePasswordHandler: should reject empty newPassword', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		body: { oldPassword: 'oldpasswd', newPassword: '  ' },
	};
	const res = createRes();

	await changePasswordHandler(req, res, () => {});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.message, 'newPassword is required');
});

test('changePasswordHandler: should call next on service error', async () => {
	const boom = new Error('service down');
	let nextErr = null;
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		body: { oldPassword: 'oldpasswd', newPassword: 'newpasswd' },
	};
	const res = createRes();

	await changePasswordHandler(req, res, (err) => { nextErr = err; }, {
		changePwd: async () => { throw boom; },
	});

	assert.equal(nextErr, boom);
});

// --- patchCurrentUserHandler 分支覆盖 ---

test('patchCurrentUserHandler: should return 401 when not authenticated', async () => {
	const req = {
		isAuthenticated: () => false,
		user: null,
		body: { name: 'Bob' },
	};
	const res = createRes();

	await patchCurrentUserHandler(req, res, () => {});

	assert.equal(res.statusCode, 401);
	assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('patchCurrentUserHandler: should call next on error', async () => {
	const boom = new Error('update failed');
	let nextErr = null;
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		body: { name: 'Bob' },
	};
	const res = createRes();

	await patchCurrentUserHandler(req, res, (err) => { nextErr = err; }, {
		updateUserProfile: async () => { throw boom; },
	});

	assert.equal(nextErr, boom);
});

// --- getCurrentUserSettingsHandler 分支覆盖 ---

test('getCurrentUserSettingsHandler: should return 401 when not authenticated', async () => {
	const req = {
		isAuthenticated: () => false,
		user: null,
	};
	const res = createRes();

	await getCurrentUserSettingsHandler(req, res, () => {});

	assert.equal(res.statusCode, 401);
	assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('getCurrentUserSettingsHandler: should call next when setting is null', async () => {
	let nextErr = null;
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
	};
	const res = createRes();

	await getCurrentUserSettingsHandler(req, res, (err) => { nextErr = err; }, {
		findUserSetting: async () => null,
	});

	assert.ok(nextErr instanceof Error);
	assert.equal(nextErr.message, 'User settings not found');
});

// --- patchCurrentUserSettingsHandler 分支覆盖 ---

test('patchCurrentUserSettingsHandler: should return 401 when not authenticated', async () => {
	const req = {
		isAuthenticated: () => false,
		user: null,
		body: { theme: 'dark' },
	};
	const res = createRes();

	await patchCurrentUserSettingsHandler(req, res, () => {});

	assert.equal(res.statusCode, 401);
	assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('patchCurrentUserSettingsHandler: should call next on service error', async () => {
	const boom = new Error('patch failed');
	let nextErr = null;
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		body: { theme: 'dark' },
	};
	const res = createRes();

	await patchCurrentUserSettingsHandler(req, res, (err) => { nextErr = err; }, {
		patchUserSetting: async () => { throw boom; },
	});

	assert.equal(nextErr, boom);
});

test('userRouter: should register routes without /me', () => {
	const routes = userRouter.stack
		.filter((layer) => layer.route)
		.map((layer) => ({
			path: layer.route.path,
			methods: layer.route.methods,
		}));

	const rootMethods = routes
		.filter((route) => route.path === '/')
		.reduce((acc, route) => ({ ...acc, ...route.methods }), {});
	assert.equal(rootMethods.get, true);
	assert.equal(rootMethods.patch, true);

	const settingsMethods = routes
		.filter((route) => route.path === '/settings')
		.reduce((acc, route) => ({ ...acc, ...route.methods }), {});
	assert.equal(settingsMethods.get, true);
	assert.equal(settingsMethods.patch, true);

	const passwordMethods = routes
		.filter((route) => route.path === '/password')
		.reduce((acc, route) => ({ ...acc, ...route.methods }), {});
	assert.equal(passwordMethods.put, true);

	const meRoute = routes.find((route) => route.path === '/me');
	assert.equal(meRoute, undefined);
});
