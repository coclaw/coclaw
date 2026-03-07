import assert from 'node:assert/strict';
import test from 'node:test';

import { bindBotHandler, botStatusStreamHandler, createBindingCodeHandler, listBotsHandler, waitBindingCodeHandler } from './bot.route.js';

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

test('listBotsHandler: should reject unauthenticated request', async () => {
	const req = {
		isAuthenticated: () => false,
		user: null,
	};
	const res = createRes();

	await listBotsHandler(req, res, () => {});

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

test('listBotsHandler: should include online state and refreshed name from ws hub', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
	};
	const res = createRes();
	const refreshedIds = [];

	await listBotsHandler(req, res, () => {}, {
		listBotsByUserIdImpl: async () => ([
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
		listOnlineBotIdsImpl: () => new Set(['2']),
		refreshBotNameImpl: async (botId) => {
			refreshedIds.push(String(botId));
			if (String(botId) === '2') {
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

test('botStatusStreamHandler: should reject unauthenticated request', () => {
	const req = {
		isAuthenticated: () => false,
		user: null,
	};
	const res = createRes();

	botStatusStreamHandler(req, res);

	assert.equal(res.statusCode, 401);
	assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('botStatusStreamHandler: should set SSE headers for authenticated request', () => {
	const headers = {};
	const reqCloseHandlers = [];
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
		on(event, handler) {
			reqCloseHandlers.push({ event, handler });
		},
	};
	const res = {
		writeHead(status, hdrs) {
			this.statusCode = status;
			Object.assign(headers, hdrs);
		},
		write() {},
		on() {},
	};

	botStatusStreamHandler(req, res);

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
	const handlers = new Map();
	return {
		body,
		user: { id: 7n },
		isAuthenticated: () => true,
		on(event, handler) {
			handlers.set(event, handler);
		},
		off(event, handler) {
			const current = handlers.get(event);
			if (current === handler) {
				handlers.delete(event);
			}
		},
		__emit(event) {
			const handler = handlers.get(event);
			if (handler) {
				return handler();
			}
			return null;
		},
	};
}

test('listBotsHandler: should fallback to db name when refresh fails', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
	};
	const res = createRes();

	await listBotsHandler(req, res, () => {}, {
		listBotsByUserIdImpl: async () => ([
			{
				id: 2n,
				name: 'b-cache',
				lastSeenAt: null,
				createdAt: new Date('2026-01-01T00:00:00.000Z'),
				updatedAt: new Date('2026-01-01T00:00:00.000Z'),
			},
		]),
		listOnlineBotIdsImpl: () => new Set(['2']),
		refreshBotNameImpl: async () => {
			throw new Error('timeout');
		},
	});

	assert.equal(res.statusCode, 200);
	assert.equal(res.body.items[0].name, 'b-cache');
});

test('listBotsHandler: should return null name when refresh resolves empty name', async () => {
	const req = {
		isAuthenticated: () => true,
		user: { id: 7n },
	};
	const res = createRes();

	await listBotsHandler(req, res, () => {}, {
		listBotsByUserIdImpl: async () => ([
			{
				id: 2n,
				name: 'old-name',
				lastSeenAt: null,
				createdAt: new Date('2026-01-01T00:00:00.000Z'),
				updatedAt: new Date('2026-01-01T00:00:00.000Z'),
			},
		]),
		listOnlineBotIdsImpl: () => new Set(['2']),
		refreshBotNameImpl: async () => null,
	});

	assert.equal(res.statusCode, 200);
	assert.equal(res.body.items[0].name, null);
});

test('bindBotHandler: should pass bind result name through and markBindingBound', async () => {
	const req = {
		body: { code: '12345678' },
	};
	const res = createRes();
	let markArgs = null;

	await bindBotHandler(req, res, () => {}, {
		bindBotImpl: async () => ({
			ok: true,
			botId: 42n,
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
	assert.equal(res.body.bot.name, '小点');
	assert.equal(markArgs.botName, '小点');
});

test('bindBotHandler: should pass null name through when bind result name is null', async () => {
	const req = {
		body: { code: '12345678' },
	};
	const res = createRes();
	let markArgs = null;

	await bindBotHandler(req, res, () => {}, {
		bindBotImpl: async () => ({
			ok: true,
			botId: 42n,
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
	assert.equal(markArgs.botName, null);
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

test('waitBindingCodeHandler: should cancel and delete binding code on abort', async () => {
	const req = createWaitReq({ code: '12345678', waitToken: 'token' });
	const res = createRes();
	const calls = {
		cancel: 0,
		find: 0,
		delete: 0,
	};
	let release;
	const pending = new Promise((resolve) => {
		release = resolve;
	});

	const running = waitBindingCodeHandler(req, res, () => {}, {
		cancelBindingWaitImpl: () => {
			calls.cancel += 1;
			return true;
		},
		findBindingCodeImpl: async () => {
			calls.find += 1;
			return { code: '12345678', userId: 7n };
		},
		deleteBindingCodeImpl: async () => {
			calls.delete += 1;
		},
		waitBindingResultImpl: async () => pending,
	});

	await req.__emit('aborted');
	release({ status: 'PENDING' });
	await running;

	assert.equal(calls.cancel, 1);
	assert.equal(calls.find, 1);
	assert.equal(calls.delete, 1);
	assert.equal(res.statusCode, null);
});
