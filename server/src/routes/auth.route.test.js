import assert from 'node:assert/strict';
import test from 'node:test';

import { getCurrentSessionHandler, registerLocalHandler, logoutHandler } from './auth.route.js';

function createRes() {
	return {
		statusCode: null,
		body: null,
		headers: {},
		ended: false,
		set(name, value) {
			this.headers[name] = value;
			return this;
		},
		status(code) {
			this.statusCode = code;
			return this;
		},
		json(payload) {
			this.body = payload;
			return this;
		},
		end() {
			this.ended = true;
			return this;
		},
	};
}

test('getCurrentSessionHandler: should return null for unauthenticated user', () => {
	const req = {
		isAuthenticated: () => false,
		user: null,
	};
	const res = createRes();

	getCurrentSessionHandler(req, res);

	assert.equal(res.statusCode, 200);
	assert.deepEqual(res.body, {
		user: null,
	});
});

test('getCurrentSessionHandler: should return user for authenticated user', () => {
	const req = {
		isAuthenticated: () => true,
		user: {
			id: 123n,
			name: 'Alice',
			avatar: null,
			level: 1,
			authType: 'local',
			auth: {
				local: {
					loginName: 'alice',
				},
			},
			settings: {
				theme: 'auto',
				lang: null,
				perfs: {},
				uiState: {},
				hintCounts: {},
			},
			lastLoginAt: '2026-01-15T10:00:00.000Z',
		},
	};
	const res = createRes();

	getCurrentSessionHandler(req, res);

	assert.equal(res.statusCode, 200);
	assert.deepEqual(res.body, {
		user: {
			id: '123',
			name: 'Alice',
			avatar: null,
			level: 1,
			authType: 'local',
			auth: {
				local: {
					loginName: 'alice',
				},
			},
			settings: {
				theme: 'auto',
				lang: null,
				perfs: {},
				uiState: {},
				hintCounts: {},
			},
			lastLoginAt: '2026-01-15T10:00:00.000Z',
		},
	});
});

// --- registerLocalHandler ---

function makeSessionUser() {
	return {
		id: 778899n,
		name: 'Alice',
		avatar: null,
		level: 0,
		authType: 'local',
		auth: { local: { loginName: 'alice' } },
		settings: {
			theme: null,
			lang: null,
			perfs: {},
			uiState: {},
			hintCounts: {},
		},
	};
}

test('registerLocalHandler: should return 400 on INVALID_INPUT', async () => {
	const req = { body: { loginName: '', password: '' } };
	const res = createRes();
	const next = () => {};

	await registerLocalHandler(req, res, next, {
		createAccount: async () => ({
			ok: false,
			code: 'INVALID_INPUT',
			message: 'loginName and password are required',
		}),
	});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.code, 'INVALID_INPUT');
});

test('registerLocalHandler: should return 409 on LOGIN_NAME_TAKEN', async () => {
	const req = { body: { loginName: 'alice', password: 'secret' } };
	const res = createRes();
	const next = () => {};

	await registerLocalHandler(req, res, next, {
		createAccount: async () => ({
			ok: false,
			code: 'LOGIN_NAME_TAKEN',
			message: 'Login name is already taken',
		}),
	});

	assert.equal(res.statusCode, 409);
	assert.equal(res.body.code, 'LOGIN_NAME_TAKEN');
});

test('registerLocalHandler: should return 201 and call logIn on success', async () => {
	const user = makeSessionUser();
	let loggedInUser = null;

	const req = {
		body: { loginName: 'alice', password: 'secret' },
		logIn(u, cb) {
			loggedInUser = u;
			cb(null);
		},
	};
	const res = createRes();
	const next = () => {};

	await registerLocalHandler(req, res, next, {
		createAccount: async () => ({ ok: true, user }),
	});

	assert.equal(res.statusCode, 201);
	assert.equal(res.body.user.id, '778899');
	assert.equal(loggedInUser, user);
});

// --- logoutHandler ---

test('logoutHandler: 成功 logout 时写入 lastLogoutAt 并返回 204', async () => {
	let touchCalled = false;
	let touchedUserId = null;
	const touchLogout = async (userId) => {
		touchCalled = true;
		touchedUserId = userId;
	};

	const req = {
		user: { id: 42n },
		logout(cb) { cb(null); },
		session: { destroy(cb) { cb(null); } },
	};
	const res = createRes();

	await new Promise((resolve) => {
		logoutHandler(req, res, () => {}, { touchLogout });
		// logoutHandler 是回调驱动，需等 event loop
		setTimeout(resolve, 50);
	});

	assert.equal(res.statusCode, 204);
	assert.equal(res.ended, true);
	assert.equal(touchCalled, true);
	assert.equal(touchedUserId, 42n);
});

test('logoutHandler: touchLogout 失败不影响 logout 流程', async () => {
	const touchLogout = async () => { throw new Error('DB error'); };

	const req = {
		user: { id: 1n },
		logout(cb) { cb(null); },
		session: { destroy(cb) { cb(null); } },
	};
	const res = createRes();

	await new Promise((resolve) => {
		logoutHandler(req, res, () => {}, { touchLogout });
		setTimeout(resolve, 50);
	});

	assert.equal(res.statusCode, 204);
	assert.equal(res.ended, true);
});

test('logoutHandler: req.user 为 null 时不调用 touchLogout', async () => {
	let touchCalled = false;
	const touchLogout = async () => { touchCalled = true; };

	const req = {
		user: null,
		logout(cb) { cb(null); },
		session: { destroy(cb) { cb(null); } },
	};
	const res = createRes();

	await new Promise((resolve) => {
		logoutHandler(req, res, () => {}, { touchLogout });
		setTimeout(resolve, 50);
	});

	assert.equal(res.statusCode, 204);
	assert.equal(touchCalled, false);
});
