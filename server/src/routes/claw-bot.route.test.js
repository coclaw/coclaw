import assert from 'node:assert/strict';
import test from 'node:test';

import {
	bindClawHandler,
	clawStatusStreamHandler,
	cancelBindingCodeHandler,
	createBindingCodeHandler,
	createUiWsTicketHandler,
	getClawSelfHandler,
	listClawsHandler,
	unbindClawByUserHandler,
	unbindClawHandler,
	waitBindingCodeHandler,
} from './claw-bot.route.js';

function createRes() {
	const handlers = new Map();
	return {
		statusCode: null,
		body: null,
		ended: false,
		writableFinished: false,
		on(event, handler) {
			handlers.set(event, handler);
		},
		__emit(event) {
			const handler = handlers.get(event);
			if (handler) return handler();
			return null;
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

test('listClawsHandler: should reject unauthenticated request', async () => {
	const req = {
		isAuthenticated: () => false,
		user: null,
	};
	const res = createRes();

	await listClawsHandler(req, res, () => {});

	assert.equal(res.statusCode, 401);
	assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('createBindingCodeHandler: should reject unauthenticated request', async () => {
	const req = {
		isAuthenticated: () => false,
		user: null,
	};
	const res = createRes();

	await createBindingCodeHandler(req, res, () => {});

	assert.equal(res.statusCode, 401);
	assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('listClawsHandler: should include online state and refreshed name from ws hub', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
	};
	const res = createRes();
	const refreshedIds = [];

	await listClawsHandler(req, res, () => {}, {
		listClawsByUserIdImpl: async () => ([
			{
				id: 1n,
				name: 'a',
				lastSeenAt: null,
				createdAt: new Date('2026-01-01T00:00:00.000Z'),
				updatedAt: new Date('2026-01-01T00:00:00.000Z'),
			},
			{
				id: 2n,
				name: 'b',
				lastSeenAt: null,
				createdAt: new Date('2026-01-01T00:00:00.000Z'),
				updatedAt: new Date('2026-01-01T00:00:00.000Z'),
			},
		]),
		listOnlineClawIdsImpl: () => new Set(['2']),
		refreshClawNameImpl: async (clawId) => {
			refreshedIds.push(String(clawId));
			if (String(clawId) === '2') {
				return 'b-latest';
			}
			return null;
		},
	});

	assert.equal(res.statusCode, 200);
	assert.equal(res.body.items.length, 2);
	assert.equal(res.body.items[0].online, false);
	assert.equal(res.body.items[1].online, true);
	assert.equal(res.body.items[0].name, 'a');
	assert.equal(res.body.items[1].name, 'b-latest');
	assert.deepEqual(refreshedIds, ['2']);
});

test('clawStatusStreamHandler: should reject unauthenticated request', async () => {
	const req = {
		isAuthenticated: () => false,
		user: null,
	};
	const res = createRes();

	await clawStatusStreamHandler(req, res);

	assert.equal(res.statusCode, 401);
	assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('clawStatusStreamHandler: should set SSE headers for authenticated request', async () => {
	const headers = {};
	const reqCloseHandlers = [];
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		on(event, handler) {
			reqCloseHandlers.push({ event, handler });
		},
	};
	const written = [];
	const res = {
		writeHead(status, hdrs) {
			this.statusCode = status;
			Object.assign(headers, hdrs);
		},
		write(data) { written.push(data); },
		on() {},
	};

	await clawStatusStreamHandler(req, res, undefined, {
		sendSnapshotImpl: async () => {},
	});

	assert.equal(res.statusCode, 200);
	assert.equal(headers['Content-Type'], 'text/event-stream');
	assert.equal(headers['Cache-Control'], 'no-cache');
	assert.ok(reqCloseHandlers.some((h) => h.event === 'close'));

	// 触发 close 以清理 setInterval，避免进程挂起
	for (const { event, handler } of reqCloseHandlers) {
		if (event === 'close') {
			handler();
		}
	}
});

function createWaitReq(body) {
	return {
		body,
		user: { id: 7n },
		isAuthenticated: () => true,
	};
}

test('listClawsHandler: should fallback to db name when refresh fails', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
	};
	const res = createRes();

	await listClawsHandler(req, res, () => {}, {
		listClawsByUserIdImpl: async () => ([
			{
				id: 2n,
				name: 'b-cache',
				lastSeenAt: null,
				createdAt: new Date('2026-01-01T00:00:00.000Z'),
				updatedAt: new Date('2026-01-01T00:00:00.000Z'),
			},
		]),
		listOnlineClawIdsImpl: () => new Set(['2']),
		refreshClawNameImpl: async () => {
			throw new Error('timeout');
		},
	});

	assert.equal(res.statusCode, 200);
	assert.equal(res.body.items[0].name, 'b-cache');
});

test('listClawsHandler: should return null name when refresh resolves empty name', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
	};
	const res = createRes();

	await listClawsHandler(req, res, () => {}, {
		listClawsByUserIdImpl: async () => ([
			{
				id: 2n,
				name: 'old-name',
				lastSeenAt: null,
				createdAt: new Date('2026-01-01T00:00:00.000Z'),
				updatedAt: new Date('2026-01-01T00:00:00.000Z'),
			},
		]),
		listOnlineClawIdsImpl: () => new Set(['2']),
		refreshClawNameImpl: async () => null,
	});

	assert.equal(res.statusCode, 200);
	assert.equal(res.body.items[0].name, null);
});

test('bindClawHandler: should pass bind result name through and markBindingBound', async () => {
	const req = {
		body: { code: '12345678' },
	};
	const res = createRes();
	let markArgs = null;

	await bindClawHandler(req, res, () => {}, {
		bindClawImpl: async () => ({
			ok: true,
			botId: 42n,
			userId: 7n,
			token: 'tok',
			rebound: false,
			bindingCode: '12345678',
			botName: '小点',
		}),
		markBindingBoundImpl: (args) => {
			markArgs = args;
		},
	});

	assert.equal(res.statusCode, 200);
	assert.equal(res.body.botId, '42');
	assert.equal(res.body.clawId, '42');
	assert.equal(res.body.bot.name, '小点');
	assert.equal(res.body.claw.name, '小点');
	assert.equal(markArgs.clawName, '小点');
});

test('bindClawHandler: should pass null name through when bind result name is null', async () => {
	const req = {
		body: { code: '12345678' },
	};
	const res = createRes();
	let markArgs = null;

	await bindClawHandler(req, res, () => {}, {
		bindClawImpl: async () => ({
			ok: true,
			botId: 42n,
			userId: 7n,
			token: 'tok',
			rebound: false,
			bindingCode: '12345678',
			botName: null,
		}),
		markBindingBoundImpl: (args) => {
			markArgs = args;
		},
	});

	assert.equal(res.statusCode, 200);
	assert.equal(res.body.bot.name, null);
	assert.equal(res.body.claw.name, null);
	assert.equal(markArgs.clawName, null);
});

test('waitBindingCodeHandler: should return success when bound', async () => {
	const req = createWaitReq({ code: '12345678', waitToken: 'token' });
	const res = createRes();

	await waitBindingCodeHandler(req, res, () => {}, {
		waitBindingResultImpl: async () => ({
			status: 'BOUND',
			bot: { id: '1001', name: 'demo' },
		}),
	});

	assert.equal(res.statusCode, 200);
	assert.equal(res.body.code, 'BINDING_SUCCESS');
	assert.equal(res.body.bot.id, '1001');
	assert.equal(res.body.claw.id, '1001');
});

test('waitBindingCodeHandler: should return timeout when expired', async () => {
	const req = createWaitReq({ code: '12345678', waitToken: 'token' });
	const res = createRes();

	await waitBindingCodeHandler(req, res, () => {}, {
		waitBindingResultImpl: async () => ({ status: 'TIMEOUT' }),
	});

	assert.equal(res.statusCode, 408);
	assert.equal(res.body.code, 'BINDING_TIMEOUT');
});

test('waitBindingCodeHandler: should cancel wait but not delete binding code on abort', async () => {
	const req = createWaitReq({ code: '12345678', waitToken: 'token' });
	const res = createRes();
	let cancelCount = 0;
	let release;
	const pending = new Promise((resolve) => {
		release = resolve;
	});

	const running = waitBindingCodeHandler(req, res, () => {}, {
		cancelBindingWaitImpl: () => {
			cancelCount += 1;
			return true;
		},
		waitBindingResultImpl: async () => pending,
	});

	// 模拟客户端断连（res 未完成写入时 close）
	await res.__emit('close');
	release({ status: 'PENDING' });
	await running;

	assert.equal(cancelCount, 1);
	assert.equal(res.statusCode, null); // 未发送响应
});

test('cancelBindingCodeHandler: should reject unauthenticated request', async () => {
	const req = { isAuthenticated: () => false, user: null, params: { code: '12345678' } };
	const res = createRes();

	await cancelBindingCodeHandler(req, res, () => {});

	assert.equal(res.statusCode, 401);
	assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('cancelBindingCodeHandler: should delete binding code owned by user', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		params: { code: 'AABBCCDD' },
	};
	const res = createRes();
	let deletedCode = null;

	await cancelBindingCodeHandler(req, res, () => {}, {
		findBindingCodeImpl: async () => ({ code: 'AABBCCDD', userId: 7n }),
		deleteBindingCodeImpl: async (code) => { deletedCode = code; },
	});

	assert.equal(res.statusCode, 204);
	assert.equal(res.ended, true);
	assert.equal(deletedCode, 'AABBCCDD');
});

test('cancelBindingCodeHandler: should return 204 when code belongs to another user', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		params: { code: 'AABBCCDD' },
	};
	const res = createRes();
	let deleteCalled = false;

	await cancelBindingCodeHandler(req, res, () => {}, {
		findBindingCodeImpl: async () => ({ code: 'AABBCCDD', userId: 999n }),
		deleteBindingCodeImpl: async () => { deleteCalled = true; },
	});

	assert.equal(res.statusCode, 204);
	assert.equal(deleteCalled, false);
});

test('cancelBindingCodeHandler: should return 204 when code not found', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		params: { code: 'NOTEXIST' },
	};
	const res = createRes();

	await cancelBindingCodeHandler(req, res, () => {}, {
		findBindingCodeImpl: async () => null,
		deleteBindingCodeImpl: async () => {},
	});

	assert.equal(res.statusCode, 204);
});

// --- createBindingCodeHandler ---

test('createBindingCodeHandler: should return 500 when service returns not ok', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
	};
	const res = createRes();

	await createBindingCodeHandler(req, res, () => {}, {
		createBindingCodeForUserImpl: async () => ({
			ok: false,
			code: 'RATE_LIMIT',
			message: 'Too many codes',
		}),
	});

	assert.equal(res.statusCode, 500);
	assert.equal(res.body.code, 'RATE_LIMIT');
	assert.equal(res.body.message, 'Too many codes');
});

test('createBindingCodeHandler: should return 201 with code and waitToken on success', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
	};
	const res = createRes();
	const expiresAt = new Date('2026-12-31T00:00:00Z');

	await createBindingCodeHandler(req, res, () => {}, {
		createBindingCodeForUserImpl: async () => ({
			ok: true,
			code: 'ABCD1234',
			expiresAt,
		}),
		registerBindingWaitImpl: () => 'wait-token-123',
	});

	assert.equal(res.statusCode, 201);
	assert.equal(res.body.code, 'ABCD1234');
	assert.equal(res.body.expiresAt, expiresAt);
	assert.equal(res.body.waitToken, 'wait-token-123');
});

test('createBindingCodeHandler: should forward error to next', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
	};
	const res = createRes();
	const testErr = new Error('db error');
	let nextErr = null;

	await createBindingCodeHandler(req, res, (err) => { nextErr = err; }, {
		createBindingCodeForUserImpl: async () => { throw testErr; },
	});

	assert.equal(nextErr, testErr);
});

// --- bindClawHandler 补充 ---

test('bindClawHandler: should return 400 for INVALID_INPUT failure', async () => {
	const req = { body: { code: '' } };
	const res = createRes();

	await bindClawHandler(req, res, () => {}, {
		bindClawImpl: async () => ({
			ok: false,
			code: 'INVALID_INPUT',
			message: 'code is required',
		}),
	});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.code, 'INVALID_INPUT');
});

test('bindClawHandler: should return 401 for non-INVALID_INPUT failure', async () => {
	const req = { body: { code: 'EXPIRED1' } };
	const res = createRes();

	await bindClawHandler(req, res, () => {}, {
		bindClawImpl: async () => ({
			ok: false,
			code: 'CODE_EXPIRED',
			message: 'Code has expired',
		}),
	});

	assert.equal(res.statusCode, 401);
	assert.equal(res.body.code, 'CODE_EXPIRED');
});

test('bindClawHandler: should notify and disconnect on rebound', async () => {
	const req = { body: { code: '12345678', name: 'bot-x' } };
	const res = createRes();
	let disconnectedBotId = null;
	let disconnectReason = null;

	await bindClawHandler(req, res, () => {}, {
		bindClawImpl: async () => ({
			ok: true,
			botId: 42n,
			userId: 7n,
			token: 'new-tok',
			rebound: true,
			bindingCode: '12345678',
			botName: 'bot-x',
		}),
		markBindingBoundImpl: () => {},
		notifyAndDisconnectClawImpl: (botId, reason) => {
			disconnectedBotId = botId;
			disconnectReason = reason;
		},
	});

	assert.equal(res.statusCode, 200);
	assert.equal(res.body.rebound, true);
	assert.equal(disconnectedBotId, 42n);
	assert.equal(disconnectReason, 'token_revoked');
});

test('bindClawHandler: should forward error to next', async () => {
	const req = { body: { code: '12345678' } };
	const res = createRes();
	const testErr = new Error('bind error');
	let nextErr = null;

	await bindClawHandler(req, res, (err) => { nextErr = err; }, {
		bindClawImpl: async () => { throw testErr; },
	});

	assert.equal(nextErr, testErr);
});

// --- getClawSelfHandler ---

test('getClawSelfHandler: should reject request without bearer token', async () => {
	const req = { headers: {} };
	const res = createRes();

	await getClawSelfHandler(req, res, () => {});

	assert.equal(res.statusCode, 401);
	assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('getClawSelfHandler: should reject non-Bearer auth scheme', async () => {
	const req = { headers: { authorization: 'Basic abc123' } };
	const res = createRes();

	await getClawSelfHandler(req, res, () => {});

	assert.equal(res.statusCode, 401);
	assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('getClawSelfHandler: should reject Bearer with empty token', async () => {
	const req = { headers: { authorization: 'Bearer ' } };
	const res = createRes();

	await getClawSelfHandler(req, res, () => {});

	assert.equal(res.statusCode, 401);
});

test('getClawSelfHandler: should return 401 when token not found in db', async () => {
	const req = { headers: { authorization: 'Bearer some-token' } };
	const res = createRes();

	await getClawSelfHandler(req, res, () => {}, {
		findClawByTokenHashImpl: async () => null,
	});

	assert.equal(res.statusCode, 401);
	assert.equal(res.body.message, 'Invalid token');
});

test('getClawSelfHandler: should return botId when token is valid', async () => {
	const req = { headers: { authorization: 'Bearer valid-token' } };
	const res = createRes();

	await getClawSelfHandler(req, res, () => {}, {
		findClawByTokenHashImpl: async () => ({ id: 99n }),
	});

	assert.equal(res.statusCode, 200);
	assert.equal(res.body.botId, '99');
	assert.equal(res.body.clawId, '99');
});

test('getClawSelfHandler: should forward error to next', async () => {
	const req = { headers: { authorization: 'Bearer valid-token' } };
	const res = createRes();
	const testErr = new Error('db error');
	let nextErr = null;

	await getClawSelfHandler(req, res, (err) => { nextErr = err; }, {
		findClawByTokenHashImpl: async () => { throw testErr; },
	});

	assert.equal(nextErr, testErr);
});

// --- createUiWsTicketHandler ---

test('createUiWsTicketHandler: should reject unauthenticated request', async () => {
	const req = { isAuthenticated: () => false, user: null };
	const res = createRes();

	await createUiWsTicketHandler(req, res, () => {});

	assert.equal(res.statusCode, 401);
});

test('createUiWsTicketHandler: should create ticket with explicit botId', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		body: { botId: '42' },
	};
	const res = createRes();

	await createUiWsTicketHandler(req, res, () => {}, {
		findClawByIdImpl: async () => ({ id: 42n, userId: 7n }),
		createUiWsTicketImpl: ({ clawId, userId }) => `ticket-${clawId}-${userId}`,
	});

	assert.equal(res.statusCode, 201);
	assert.equal(res.body.ticket, 'ticket-42-7');
	assert.equal(res.body.botId, '42');
	assert.equal(res.body.clawId, '42');
});

test('createUiWsTicketHandler: should return 400 for invalid botId format', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		body: { botId: 'not-a-number' },
	};
	const res = createRes();

	await createUiWsTicketHandler(req, res, () => {}, {
		findClawByIdImpl: async () => { throw new Error('invalid'); },
	});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.code, 'INVALID_INPUT');
});

test('createUiWsTicketHandler: should return 404 when bot not found', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		body: { botId: '999' },
	};
	const res = createRes();

	await createUiWsTicketHandler(req, res, () => {}, {
		findClawByIdImpl: async () => null,
	});

	assert.equal(res.statusCode, 404);
	assert.equal(res.body.code, 'BOT_NOT_FOUND');
});

test('createUiWsTicketHandler: should return 404 when bot belongs to another user', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		body: { botId: '42' },
	};
	const res = createRes();

	await createUiWsTicketHandler(req, res, () => {}, {
		findClawByIdImpl: async () => ({ id: 42n, userId: 999n }),
	});

	assert.equal(res.statusCode, 404);
	assert.equal(res.body.code, 'BOT_NOT_FOUND');
});

test('createUiWsTicketHandler: should fallback to latest bot when botId not provided', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		body: {},
	};
	const res = createRes();

	await createUiWsTicketHandler(req, res, () => {}, {
		findLatestClawByUserIdImpl: async () => ({ id: 10n, userId: 7n }),
		createUiWsTicketImpl: () => 'auto-ticket',
	});

	assert.equal(res.statusCode, 201);
	assert.equal(res.body.ticket, 'auto-ticket');
	assert.equal(res.body.botId, '10');
	assert.equal(res.body.clawId, '10');
});

test('createUiWsTicketHandler: should return 404 when no latest bot found', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		body: {},
	};
	const res = createRes();

	await createUiWsTicketHandler(req, res, () => {}, {
		findLatestClawByUserIdImpl: async () => null,
	});

	assert.equal(res.statusCode, 404);
	assert.equal(res.body.code, 'BOT_NOT_FOUND');
});

test('createUiWsTicketHandler: should forward error to next', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		body: {},
	};
	const res = createRes();
	const testErr = new Error('unexpected');
	let nextErr = null;

	await createUiWsTicketHandler(req, res, (err) => { nextErr = err; }, {
		findLatestClawByUserIdImpl: async () => { throw testErr; },
	});

	assert.equal(nextErr, testErr);
});

// --- waitBindingCodeHandler 补充 ---

test('waitBindingCodeHandler: should reject unauthenticated request', async () => {
	const req = { isAuthenticated: () => false, user: null, body: {} };
	const res = createRes();

	await waitBindingCodeHandler(req, res, () => {});

	assert.equal(res.statusCode, 401);
});

test('waitBindingCodeHandler: should return 400 when code is missing', async () => {
	const req = createWaitReq({ code: '', waitToken: 'token' });
	const res = createRes();

	await waitBindingCodeHandler(req, res, () => {});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.code, 'INVALID_INPUT');
});

test('waitBindingCodeHandler: should return 400 when waitToken is missing', async () => {
	const req = createWaitReq({ code: '12345678', waitToken: '' });
	const res = createRes();

	await waitBindingCodeHandler(req, res, () => {});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.code, 'INVALID_INPUT');
});

test('waitBindingCodeHandler: should return 404 when result is INVALID', async () => {
	const req = createWaitReq({ code: '12345678', waitToken: 'token' });
	const res = createRes();

	await waitBindingCodeHandler(req, res, () => {}, {
		waitBindingResultImpl: async () => ({ status: 'INVALID' }),
	});

	assert.equal(res.statusCode, 404);
	assert.equal(res.body.code, 'BINDING_NOT_FOUND');
});

test('waitBindingCodeHandler: should return PENDING when status is unknown', async () => {
	const req = createWaitReq({ code: '12345678', waitToken: 'token' });
	const res = createRes();

	await waitBindingCodeHandler(req, res, () => {}, {
		waitBindingResultImpl: async () => ({ status: 'PENDING' }),
	});

	assert.equal(res.statusCode, 200);
	assert.equal(res.body.code, 'BINDING_PENDING');
});

test('waitBindingCodeHandler: should forward error to next', async () => {
	const req = createWaitReq({ code: '12345678', waitToken: 'token' });
	const res = createRes();
	const testErr = new Error('wait error');
	let nextErr = null;

	await waitBindingCodeHandler(req, res, (err) => { nextErr = err; }, {
		waitBindingResultImpl: async () => { throw testErr; },
	});

	assert.equal(nextErr, testErr);
});

// --- unbindClawByUserHandler ---

test('unbindClawByUserHandler: should reject unauthenticated request', async () => {
	const req = { isAuthenticated: () => false, user: null, body: {} };
	const res = createRes();

	await unbindClawByUserHandler(req, res, () => {});

	assert.equal(res.statusCode, 401);
});

test('unbindClawByUserHandler: should return 400 when botId is missing', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		body: {},
	};
	const res = createRes();

	await unbindClawByUserHandler(req, res, () => {});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.code, 'INVALID_INPUT');
	assert.equal(res.body.message, 'botId is required');
});

test('unbindClawByUserHandler: should return 400 when botId is empty string', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		body: { botId: '  ' },
	};
	const res = createRes();

	await unbindClawByUserHandler(req, res, () => {});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.message, 'botId is required');
});

test('unbindClawByUserHandler: should return 400 when botId is not a valid BigInt', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		body: { botId: 'not-a-number' },
	};
	const res = createRes();

	await unbindClawByUserHandler(req, res, () => {});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.message, 'botId is invalid');
});

test('unbindClawByUserHandler: should return 404 when unbind service returns BOT_NOT_FOUND', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		body: { botId: '42' },
	};
	const res = createRes();

	await unbindClawByUserHandler(req, res, () => {}, {
		unbindClawByUserImpl: async () => ({
			ok: false,
			code: 'BOT_NOT_FOUND',
			message: 'Bot not found',
		}),
	});

	assert.equal(res.statusCode, 404);
	assert.equal(res.body.code, 'BOT_NOT_FOUND');
});

test('unbindClawByUserHandler: should return 400 when unbind service returns INVALID_INPUT', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		body: { botId: '42' },
	};
	const res = createRes();

	await unbindClawByUserHandler(req, res, () => {}, {
		unbindClawByUserImpl: async () => ({
			ok: false,
			code: 'INVALID_INPUT',
			message: 'Invalid input',
		}),
	});

	assert.equal(res.statusCode, 400);
});

test('unbindClawByUserHandler: should return 401 for other error codes', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		body: { botId: '42' },
	};
	const res = createRes();

	await unbindClawByUserHandler(req, res, () => {}, {
		unbindClawByUserImpl: async () => ({
			ok: false,
			code: 'FORBIDDEN',
			message: 'Not allowed',
		}),
	});

	assert.equal(res.statusCode, 401);
});

test('unbindClawByUserHandler: should unbind, notify, and return success', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		body: { botId: '42' },
	};
	const res = createRes();
	let notifiedBotId = null;
	const sseEvents = [];

	await unbindClawByUserHandler(req, res, () => {}, {
		unbindClawByUserImpl: async () => ({
			ok: true,
			botId: 42n,
		}),
		notifyAndDisconnectClawImpl: (botId) => { notifiedBotId = botId; },
		sendToUserImpl: (_userId, evt) => { sseEvents.push(evt); },
	});

	assert.equal(res.statusCode, 200);
	assert.equal(res.body.botId, '42');
	assert.equal(res.body.clawId, '42');
	assert.equal(res.body.unbound, true);
	assert.equal(notifiedBotId, 42n);
	// 双事件：先 claw.unbound 后 bot.unbound
	assert.equal(sseEvents.length, 2);
	assert.equal(sseEvents[0].event, 'claw.unbound');
	assert.equal(sseEvents[0].clawId, '42');
	assert.equal(sseEvents[1].event, 'bot.unbound');
	assert.equal(sseEvents[1].botId, '42');
	assert.equal(sseEvents[1].clawId, '42');
});

test('unbindClawByUserHandler: should forward error to next', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		body: { botId: '42' },
	};
	const res = createRes();
	const testErr = new Error('unbind error');
	let nextErr = null;

	await unbindClawByUserHandler(req, res, (err) => { nextErr = err; }, {
		unbindClawByUserImpl: async () => { throw testErr; },
	});

	assert.equal(nextErr, testErr);
});

// --- unbindClawHandler ---

test('unbindClawHandler: should reject request without bearer token', async () => {
	const req = { headers: {} };
	const res = createRes();

	await unbindClawHandler(req, res, () => {});

	assert.equal(res.statusCode, 401);
	assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('unbindClawHandler: should return 401 when unbind service returns non-ok', async () => {
	const req = { headers: { authorization: 'Bearer some-token' } };
	const res = createRes();

	await unbindClawHandler(req, res, () => {}, {
		unbindClawByTokenImpl: async () => ({
			ok: false,
			code: 'INVALID_TOKEN',
			message: 'Token invalid',
		}),
	});

	assert.equal(res.statusCode, 401);
	assert.equal(res.body.code, 'INVALID_TOKEN');
});

test('unbindClawHandler: should return 400 for INVALID_INPUT failure', async () => {
	const req = { headers: { authorization: 'Bearer some-token' } };
	const res = createRes();

	await unbindClawHandler(req, res, () => {}, {
		unbindClawByTokenImpl: async () => ({
			ok: false,
			code: 'INVALID_INPUT',
			message: 'Bad input',
		}),
	});

	assert.equal(res.statusCode, 400);
});

test('unbindClawHandler: should unbind, notify, and return success', async () => {
	const req = { headers: { authorization: 'Bearer valid-token' } };
	const res = createRes();
	let notifiedBotId = null;
	const sseEvents = [];

	await unbindClawHandler(req, res, () => {}, {
		unbindClawByTokenImpl: async () => ({
			ok: true,
			botId: 55n,
			userId: 7n,
		}),
		notifyAndDisconnectClawImpl: (botId) => { notifiedBotId = botId; },
		sendToUserImpl: (_userId, evt) => { sseEvents.push(evt); },
	});

	assert.equal(res.statusCode, 200);
	assert.equal(res.body.botId, '55');
	assert.equal(res.body.clawId, '55');
	assert.equal(res.body.unbound, true);
	assert.equal(notifiedBotId, 55n);
	assert.equal(sseEvents.length, 2);
	assert.equal(sseEvents[0].event, 'claw.unbound');
	assert.equal(sseEvents[0].clawId, '55');
	assert.equal(sseEvents[1].event, 'bot.unbound');
	assert.equal(sseEvents[1].botId, '55');
	assert.equal(sseEvents[1].clawId, '55');
});

test('unbindClawHandler: should forward error to next', async () => {
	const req = { headers: { authorization: 'Bearer valid-token' } };
	const res = createRes();
	const testErr = new Error('unbind error');
	let nextErr = null;

	await unbindClawHandler(req, res, (err) => { nextErr = err; }, {
		unbindClawByTokenImpl: async () => { throw testErr; },
	});

	assert.equal(nextErr, testErr);
});

// --- cancelBindingCodeHandler 补充 ---

test('cancelBindingCodeHandler: should return 400 when code param is missing', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		params: {},
	};
	const res = createRes();

	await cancelBindingCodeHandler(req, res, () => {});

	assert.equal(res.statusCode, 400);
	assert.equal(res.body.code, 'INVALID_REQUEST');
});

test('cancelBindingCodeHandler: should forward error to next', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		params: { code: 'AABBCCDD' },
	};
	const res = createRes();
	const testErr = new Error('find error');
	let nextErr = null;

	await cancelBindingCodeHandler(req, res, (err) => { nextErr = err; }, {
		findBindingCodeImpl: async () => { throw testErr; },
		deleteBindingCodeImpl: async () => {},
	});

	assert.equal(nextErr, testErr);
});

test('cancelBindingCodeHandler: should silently handle delete failure', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		params: { code: 'AABBCCDD' },
	};
	const res = createRes();

	await cancelBindingCodeHandler(req, res, () => {}, {
		findBindingCodeImpl: async () => ({ code: 'AABBCCDD', userId: 7n }),
		deleteBindingCodeImpl: async () => { throw new Error('delete failed'); },
	});

	assert.equal(res.statusCode, 204);
	assert.equal(res.ended, true);
});

// --- clawStatusStreamHandler 补充 ---

test('clawStatusStreamHandler: should write heartbeat on interval tick', async (t) => {
	t.mock.timers.enable({ apis: ['setInterval'] });

	const reqCloseHandlers = [];
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		on(event, handler) { reqCloseHandlers.push({ event, handler }); },
	};
	const written = [];
	const res = {
		writeHead() {},
		write(data) { written.push(data); },
		on() {},
	};

	await clawStatusStreamHandler(req, res, undefined, {
		sendSnapshotImpl: async () => {},
	});

	// 触发心跳定时器
	t.mock.timers.tick(30_000);
	assert.ok(written.includes('data: {"event":"heartbeat"}\n\n'));

	// 清理
	for (const { event, handler } of reqCloseHandlers) {
		if (event === 'close') handler();
	}
});

test('clawStatusStreamHandler: should clear heartbeat timer when write fails', async (t) => {
	t.mock.timers.enable({ apis: ['setInterval'] });

	const reqCloseHandlers = [];
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		on(event, handler) { reqCloseHandlers.push({ event, handler }); },
	};
	let writeCount = 0;
	const res = {
		writeHead() {},
		write(data) {
			writeCount++;
			// 第一次 write 是初始的 '\n'，之后的心跳 write 抛异常
			if (writeCount > 1) {
				throw new Error('connection closed');
			}
		},
		on() {},
	};

	await clawStatusStreamHandler(req, res, undefined, {
		sendSnapshotImpl: async () => {},
	});

	// 第一次心跳触发 → 写失败 → 清理定时器
	t.mock.timers.tick(30_000);
	const countAfterFirst = writeCount;

	// 再 tick 一次，不应再有 write 调用（定时器已被清理）
	t.mock.timers.tick(30_000);
	assert.equal(writeCount, countAfterFirst);

	// 清理
	for (const { event, handler } of reqCloseHandlers) {
		if (event === 'close') handler();
	}
});

test('clawStatusStreamHandler: should handle snapshot failure gracefully', async () => {
	const reqCloseHandlers = [];
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		on(event, handler) { reqCloseHandlers.push({ event, handler }); },
	};
	const written = [];
	const res = {
		writeHead() {},
		write(data) { written.push(data); },
		on() {},
	};

	await clawStatusStreamHandler(req, res, undefined, {
		sendSnapshotImpl: async () => { throw new Error('snapshot error'); },
	});

	// 不应抛出异常，应正常返回
	assert.ok(written.includes('\n'));

	// 清理定时器
	for (const { event, handler } of reqCloseHandlers) {
		if (event === 'close') handler();
	}
});

// --- listClawsHandler 补充 ---

test('listClawsHandler: should forward error to next', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
	};
	const res = createRes();
	const testErr = new Error('list error');
	let nextErr = null;

	await listClawsHandler(req, res, (err) => { nextErr = err; }, {
		listClawsByUserIdImpl: async () => { throw testErr; },
		listOnlineClawIdsImpl: () => new Set(),
	});

	assert.equal(nextErr, testErr);
});

test('listClawsHandler: should use db name for offline bots', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
	};
	const res = createRes();

	await listClawsHandler(req, res, () => {}, {
		listClawsByUserIdImpl: async () => ([
			{
				id: 1n,
				name: 'offline-bot',
				lastSeenAt: null,
				createdAt: new Date('2026-01-01T00:00:00.000Z'),
				updatedAt: new Date('2026-01-01T00:00:00.000Z'),
			},
		]),
		listOnlineClawIdsImpl: () => new Set(),
		refreshClawNameImpl: async () => undefined,
	});

	assert.equal(res.statusCode, 200);
	assert.equal(res.body.items[0].name, 'offline-bot');
	assert.equal(res.body.items[0].online, false);
});
