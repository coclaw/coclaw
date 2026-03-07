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
		body: { oldPassword: 'a', newPassword: 'b' },
	};
	const res = createRes();

	await changePasswordHandler(req, res, () => {});

	assert.equal(res.statusCode, 401);
	assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('changePasswordHandler: should return 401 when service returns INVALID_CREDENTIALS', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 123n },
		body: { oldPassword: 'wrong', newPassword: 'new' },
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
		body: { oldPassword: 'a', newPassword: 'b' },
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
		body: { oldPassword: 'old', newPassword: 'new' },
	};
	const res = createRes();

	await changePasswordHandler(req, res, () => {}, {
		changePwd: async () => ({ ok: true }),
	});

	assert.equal(res.statusCode, 200);
	assert.deepEqual(res.body, { message: 'Password changed' });
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
