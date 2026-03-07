import assert from 'node:assert/strict';
import test from 'node:test';

import { getCurrentSessionHandler, registerLocalHandler } from './auth.route.js';

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
