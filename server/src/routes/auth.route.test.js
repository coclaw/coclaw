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

// --- loginRateLimiter tests ---

import { loginRateLimiter } from './auth.route.js';

test('loginRateLimiter: allows requests under limit', () => {
	const req = { ip: '10.0.0.1', socket: {} };
	const res = { status: () => res, json: () => res, set: () => {} };
	let called = false;
	loginRateLimiter(req, res, () => { called = true; });
	assert.equal(called, true);
});

test('loginRateLimiter: blocks after exceeding limit', () => {
	const ip = '10.0.0.250'; // unique IP to avoid collision
	let blocked = false;
	let statusCode = null;
	const res = {
		set: () => {},
		status(code) { statusCode = code; return res; },
		json(body) { blocked = body.code === 'TOO_MANY_REQUESTS'; },
	};

	for (let i = 0; i < 10; i++) {
		loginRateLimiter({ ip, socket: {} }, res, () => {});
	}

	// 11th attempt should be blocked
	loginRateLimiter({ ip, socket: {} }, res, () => {});
	assert.equal(blocked, true);
	assert.equal(statusCode, 429);
});

test('loginRateLimiter: different IPs are independent', () => {
	const res = { status: () => res, json: () => res, set: () => {} };
	let calledA = false;
	let calledB = false;
	loginRateLimiter({ ip: '10.0.0.251', socket: {} }, res, () => { calledA = true; });
	loginRateLimiter({ ip: '10.0.0.252', socket: {} }, res, () => { calledB = true; });
	assert.equal(calledA, true);
	assert.equal(calledB, true);
});

test('loginRateLimiter: sets Retry-After header on 429', () => {
	const ip = '10.0.0.253';
	let retryAfterSet = false;
	const res = {
		set(key, val) { if (key === 'Retry-After') retryAfterSet = !!val; },
		status() { return res; },
		json() {},
	};

	for (let i = 0; i < 11; i++) {
		loginRateLimiter({ ip, socket: {} }, res, () => {});
	}
	assert.equal(retryAfterSet, true);
});
