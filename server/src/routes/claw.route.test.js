import assert from 'node:assert/strict';
import test from 'node:test';

import { claimHandler, createClaimCodeHandler, waitClaimCodeHandler } from './claw.route.js';

function createRes() {
	return {
		statusCode: null,
		body: null,
		ended: false,
		writableFinished: false,
		writableEnded: false,
		on() {},
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

// ---- createClaimCodeHandler ----

test('createClaimCodeHandler: should return 201 with code and waitToken on success', async () => {
	const req = {};
	const res = createRes();

	await createClaimCodeHandler(req, res, () => {}, {
		createClaimCodeImpl: async () => ({
			ok: true,
			code: '12345678',
			expiresAt: new Date('2099-01-01T00:00:00.000Z'),
		}),
		registerClaimWaitImpl: () => 'wait-token-abc',
	});

	assert.equal(res.statusCode, 201);
	assert.equal(res.body.code, '12345678');
	assert.equal(res.body.waitToken, 'wait-token-abc');
	assert.ok(res.body.expiresAt);
});

test('createClaimCodeHandler: should return 500 when createClaimCode fails', async () => {
	const req = {};
	const res = createRes();

	await createClaimCodeHandler(req, res, () => {}, {
		createClaimCodeImpl: async () => ({
			ok: false,
			code: 'CLAIM_CODE_EXHAUSTED',
			message: 'Failed to generate claim code',
		}),
		registerClaimWaitImpl: () => 'unused',
	});

	assert.equal(res.statusCode, 500);
	assert.equal(res.body.code, 'CLAIM_CODE_EXHAUSTED');
});

test('createClaimCodeHandler: should call next on thrown error', async () => {
	const req = {};
	const res = createRes();
	let nextErr = null;
	const expectedErr = new Error('db crash');

	await createClaimCodeHandler(req, res, (err) => { nextErr = err; }, {
		createClaimCodeImpl: async () => { throw expectedErr; },
		registerClaimWaitImpl: () => 'unused',
	});

	assert.equal(nextErr, expectedErr);
	assert.equal(res.statusCode, null);
});

// ---- waitClaimCodeHandler ----

function createReqWithBody(body) {
	return { body };
}

test('waitClaimCodeHandler: should return 400 when code is missing', async () => {
	const req = createReqWithBody({ waitToken: 'tok' });
	const res = createRes();

	await waitClaimCodeHandler(req, res, () => {});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.code, 'INVALID_INPUT');
});

test('waitClaimCodeHandler: should return 400 when waitToken is missing', async () => {
	const req = createReqWithBody({ code: '12345678' });
	const res = createRes();

	await waitClaimCodeHandler(req, res, () => {});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.code, 'INVALID_INPUT');
});

test('waitClaimCodeHandler: should return 400 when body is empty', async () => {
	const req = createReqWithBody({});
	const res = createRes();

	await waitClaimCodeHandler(req, res, () => {});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.code, 'INVALID_INPUT');
});

test('waitClaimCodeHandler: should return 404 when result status is INVALID', async () => {
	const req = createReqWithBody({ code: '12345678', waitToken: 'tok' });
	const res = createRes();

	await waitClaimCodeHandler(req, res, () => {}, {
		waitClaimResultImpl: async () => ({ status: 'INVALID' }),
	});

	assert.equal(res.statusCode, 404);
	assert.equal(res.body.code, 'CLAIM_NOT_FOUND');
});

test('waitClaimCodeHandler: should return 408 when result status is TIMEOUT', async () => {
	const req = createReqWithBody({ code: '12345678', waitToken: 'tok' });
	const res = createRes();

	await waitClaimCodeHandler(req, res, () => {}, {
		waitClaimResultImpl: async () => ({ status: 'TIMEOUT' }),
	});

	assert.equal(res.statusCode, 408);
	assert.equal(res.body.code, 'CLAIM_TIMEOUT');
});

test('waitClaimCodeHandler: should return 200 with botId and token when BOUND', async () => {
	const req = createReqWithBody({ code: '12345678', waitToken: 'tok' });
	const res = createRes();

	await waitClaimCodeHandler(req, res, () => {}, {
		waitClaimResultImpl: async () => ({
			status: 'BOUND',
			botId: '42',
			token: 'secret-token',
		}),
	});

	assert.equal(res.statusCode, 200);
	assert.equal(res.body.botId, '42');
	assert.equal(res.body.token, 'secret-token');
});

test('waitClaimCodeHandler: should return 200 CLAIM_PENDING for other statuses', async () => {
	const req = createReqWithBody({ code: '12345678', waitToken: 'tok' });
	const res = createRes();

	await waitClaimCodeHandler(req, res, () => {}, {
		waitClaimResultImpl: async () => ({ status: 'PENDING' }),
	});

	assert.equal(res.statusCode, 200);
	assert.equal(res.body.code, 'CLAIM_PENDING');
});

test('waitClaimCodeHandler: should not send response when client disconnects', async () => {
	const req = createReqWithBody({ code: '12345678', waitToken: 'tok' });
	// 模拟客户端断连：res.on('close') 回调在 wait 期间触发
	const res = createRes();
	const originalOn = res.on;
	let closeCallback;
	res.on = (event, cb) => {
		if (event === 'close') closeCallback = cb;
	};

	await waitClaimCodeHandler(req, res, () => {}, {
		waitClaimResultImpl: async () => {
			// 模拟等待期间客户端断连
			closeCallback?.();
			return { status: 'BOUND', botId: '42', token: 'tok' };
		},
	});

	// 客户端已断连，不应发送响应
	assert.equal(res.statusCode, null);
});

test('waitClaimCodeHandler: should call next on thrown error', async () => {
	const req = createReqWithBody({ code: '12345678', waitToken: 'tok' });
	const res = createRes();
	let nextErr = null;
	const expectedErr = new Error('hub crash');

	await waitClaimCodeHandler(req, res, (err) => { nextErr = err; }, {
		waitClaimResultImpl: async () => { throw expectedErr; },
	});

	assert.equal(nextErr, expectedErr);
	assert.equal(res.statusCode, null);
});

// ---- claimHandler ----

test('claimHandler: should reject unauthenticated request', async () => {
	const req = {
		isAuthenticated: () => false,
		user: null,
	};
	const res = createRes();

	await claimHandler(req, res, () => {});

	assert.equal(res.statusCode, 401);
	assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('claimHandler: should return 400 when code is missing', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		body: {},
	};
	const res = createRes();

	await claimHandler(req, res, () => {});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.code, 'INVALID_INPUT');
});

test('claimHandler: should return 400 when code is empty string', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		body: { code: '   ' },
	};
	const res = createRes();

	await claimHandler(req, res, () => {});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.code, 'INVALID_INPUT');
});

test('claimHandler: should return 200 on successful claim and notify wait hub', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		body: { code: '12345678' },
	};
	const res = createRes();
	let markArgs = null;

	await claimHandler(req, res, () => {}, {
		claimBotImpl: async () => ({
			ok: true,
			botId: 42n,
			botName: null,
			token: 'secret-token',
		}),
		markClaimBoundImpl: (args) => { markArgs = args; },
	});

	assert.equal(res.statusCode, 200);
	assert.equal(res.body.botId, '42');
	assert.equal(res.body.botName, null);
	// 验证 markClaimBound 被调用
	assert.deepEqual(markArgs, {
		code: '12345678',
		botId: 42n,
		token: 'secret-token',
	});
});

test('claimHandler: should return 409 when ALREADY_BOUND', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		body: { code: '12345678' },
	};
	const res = createRes();

	await claimHandler(req, res, () => {}, {
		claimBotImpl: async () => ({
			ok: false,
			code: 'ALREADY_BOUND',
			message: 'You already have a bound bot.',
		}),
		markClaimBoundImpl: () => {},
	});

	assert.equal(res.statusCode, 409);
	assert.equal(res.body.code, 'ALREADY_BOUND');
});

test('claimHandler: should return 410 when CLAIM_CODE_EXPIRED', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		body: { code: '12345678' },
	};
	const res = createRes();

	await claimHandler(req, res, () => {}, {
		claimBotImpl: async () => ({
			ok: false,
			code: 'CLAIM_CODE_EXPIRED',
			message: 'Claim code has expired',
		}),
		markClaimBoundImpl: () => {},
	});

	assert.equal(res.statusCode, 410);
	assert.equal(res.body.code, 'CLAIM_CODE_EXPIRED');
});

test('claimHandler: should return 400 when service returns INVALID_INPUT', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		body: { code: '12345678' },
	};
	const res = createRes();

	await claimHandler(req, res, () => {}, {
		claimBotImpl: async () => ({
			ok: false,
			code: 'INVALID_INPUT',
			message: 'code is required',
		}),
		markClaimBoundImpl: () => {},
	});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.code, 'INVALID_INPUT');
});

test('claimHandler: should return 404 for CLAIM_CODE_INVALID', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		body: { code: '12345678' },
	};
	const res = createRes();

	await claimHandler(req, res, () => {}, {
		claimBotImpl: async () => ({
			ok: false,
			code: 'CLAIM_CODE_INVALID',
			message: 'Claim code is invalid',
		}),
		markClaimBoundImpl: () => {},
	});

	assert.equal(res.statusCode, 404);
	assert.equal(res.body.code, 'CLAIM_CODE_INVALID');
});

test('claimHandler: should call next on thrown error', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		body: { code: '12345678' },
	};
	const res = createRes();
	let nextErr = null;
	const expectedErr = new Error('db crash');

	await claimHandler(req, res, (err) => { nextErr = err; }, {
		claimBotImpl: async () => { throw expectedErr; },
		markClaimBoundImpl: () => {},
	});

	assert.equal(nextErr, expectedErr);
	assert.equal(res.statusCode, null);
});
