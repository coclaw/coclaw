import assert from 'node:assert/strict';
import test from 'node:test';

import { getCurrentSessionHandler, loginByLoginNameHandler, logoutHandler, registerLocalHandler } from './auth.route.js';

function createRes() {
	return {
		statusCode: null,
		body: null,
		headers: {},
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

// --- loginByLoginNameHandler ---

// 构造 mock authenticate，模拟 passport.authenticate 返回中间件
function mockAuthenticate(err, user, info) {
	return (_strategy, cb) => {
		return (_req, _res, _next) => {
			cb(err, user, info);
		};
	};
}

test('loginByLoginNameHandler: should call next on passport error', () => {
	const passportErr = new Error('passport boom');
	let nextErr = null;
	const req = {};
	const res = createRes();

	loginByLoginNameHandler(req, res, (err) => { nextErr = err; }, {
		authenticate: mockAuthenticate(passportErr, null, null),
	});

	assert.equal(nextErr, passportErr);
});

test('loginByLoginNameHandler: should return 401 when user is false with info', () => {
	const req = {};
	const res = createRes();

	loginByLoginNameHandler(req, res, () => {}, {
		authenticate: mockAuthenticate(null, false, {
			code: 'INVALID_CREDENTIALS',
			message: 'Wrong password',
		}),
	});

	assert.equal(res.statusCode, 401);
	assert.equal(res.body.code, 'INVALID_CREDENTIALS');
	assert.equal(res.body.message, 'Wrong password');
});

test('loginByLoginNameHandler: should return 401 with defaults when info is null', () => {
	const req = {};
	const res = createRes();

	loginByLoginNameHandler(req, res, () => {}, {
		authenticate: mockAuthenticate(null, false, null),
	});

	assert.equal(res.statusCode, 401);
	assert.equal(res.body.code, 'UNAUTHORIZED');
	assert.equal(res.body.message, 'Unauthorized');
});

test('loginByLoginNameHandler: should call next when logIn fails', () => {
	const loginErr = new Error('logIn failed');
	let nextErr = null;
	const user = makeSessionUser();
	const req = {
		logIn(u, cb) {
			cb(loginErr);
		},
	};
	const res = createRes();

	loginByLoginNameHandler(req, res, (err) => { nextErr = err; }, {
		authenticate: mockAuthenticate(null, user, null),
	});

	assert.equal(nextErr, loginErr);
});

test('loginByLoginNameHandler: should return 200 with user on success', () => {
	const user = makeSessionUser();
	let loggedInUser = null;
	const req = {
		logIn(u, cb) {
			loggedInUser = u;
			cb(null);
		},
	};
	const res = createRes();

	loginByLoginNameHandler(req, res, () => {}, {
		authenticate: mockAuthenticate(null, user, null),
	});

	assert.equal(res.statusCode, 200);
	assert.equal(loggedInUser, user);
	assert.equal(res.body.user.id, '778899');
});

// --- logoutHandler ---

test('logoutHandler: should call next when logout fails', (t, done) => {
	const logoutErr = new Error('logout failed');
	const req = {
		logout(cb) {
			cb(logoutErr);
		},
	};
	const res = createRes();

	logoutHandler(req, res, (err) => {
		assert.equal(err, logoutErr);
		done();
	});
});

test('logoutHandler: should call next when session.destroy fails', (t, done) => {
	const destroyErr = new Error('destroy failed');
	const req = {
		logout(cb) {
			cb(null);
		},
		session: {
			destroy(cb) {
				cb(destroyErr);
			},
		},
	};
	const res = createRes();

	logoutHandler(req, res, (err) => {
		assert.equal(err, destroyErr);
		done();
	});
});

test('logoutHandler: should return 204 on success', (t, done) => {
	const req = {
		logout(cb) {
			cb(null);
		},
		session: {
			destroy(cb) {
				cb(null);
			},
		},
	};
	const res = {
		statusCode: null,
		status(code) {
			this.statusCode = code;
			return this;
		},
		end() {
			assert.equal(this.statusCode, 204);
			done();
		},
	};

	logoutHandler(req, res, () => {});
});

test('registerLocalHandler: should call next when logIn fails', async () => {
	const loginErr = new Error('login failed');
	let nextErr = null;
	const user = makeSessionUser();

	const req = {
		body: { loginName: 'alice', password: 'secret' },
		logIn(u, cb) {
			cb(loginErr);
		},
	};
	const res = createRes();

	await registerLocalHandler(req, res, (err) => {
		nextErr = err;
	}, {
		createAccount: async () => ({ ok: true, user }),
	});

	assert.equal(nextErr, loginErr);
});

test('registerLocalHandler: should call next on createAccount rejection', async () => {
	const boom = new Error('db down');

	const req = {
		body: { loginName: 'alice', password: 'secret' },
	};
	const res = createRes();

	const nextErr = await new Promise((resolve) => {
		registerLocalHandler(req, res, (err) => {
			resolve(err);
		}, {
			createAccount: async () => { throw boom; },
		});
	});

	assert.equal(nextErr, boom);
});
