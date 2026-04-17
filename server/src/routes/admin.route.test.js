import assert from 'node:assert/strict';
import test from 'node:test';

import {
	dashboardHandler,
	listClawsHandler,
	listUsersHandler,
	adminStreamHandler,
	__test,
} from './admin.route.js';

const { parseLimit, normalizeSearch, normalizeCursor } = __test;

function mockRes() {
	const closeHandlers = [];
	const res = {
		_json: null,
		_headStatus: null,
		_headHeaders: null,
		_written: [],
		json(body) { res._json = body; return res; },
		writeHead(status, headers) { res._headStatus = status; res._headHeaders = headers; },
		write(data) { res._written.push(data); },
		on(event, handler) {
			if (event === 'close') closeHandlers.push(handler);
		},
		__triggerClose() { for (const h of closeHandlers) h(); },
	};
	return res;
}

test('dashboardHandler: 正常返回 dashboard 数据', async () => {
	const fakeData = { users: { total: 10 }, claws: { total: 2, todayNew: 0 } };
	const res = mockRes();

	await dashboardHandler({}, res, () => {}, {
		getAdminDashboard: async () => fakeData,
	});

	assert.deepEqual(res._json, fakeData);
});

test('dashboardHandler: service 抛错时调用 next', async () => {
	const err = new Error('boom');
	let nextErr = null;

	await dashboardHandler({}, mockRes(), (e) => { nextErr = e; }, {
		getAdminDashboard: async () => { throw err; },
	});

	assert.equal(nextErr, err);
});

test('dashboardHandler: 不传 deps 时使用默认 getAdminDashboard（分支可达）', async () => {
	const res = mockRes();
	let nextErr = null;
	await dashboardHandler({}, res, (e) => { nextErr = e; });
	assert.ok(res._json !== null || nextErr !== null, '默认路径应可达');
});

// --- parseLimit / normalizeSearch / normalizeCursor ---

test('parseLimit: 默认 50', () => {
	assert.equal(parseLimit(undefined), 50);
	assert.equal(parseLimit('abc'), 50);
	assert.equal(parseLimit(-1), 50);
	assert.equal(parseLimit(0), 50);
});

test('parseLimit: 超过上限时截断为 100', () => {
	assert.equal(parseLimit(200), 100);
	assert.equal(parseLimit('1000'), 100);
});

test('parseLimit: 正常值取整', () => {
	assert.equal(parseLimit(30), 30);
	assert.equal(parseLimit('25'), 25);
	assert.equal(parseLimit(25.9), 25);
});

test('normalizeSearch: 非字符串 → undefined', () => {
	assert.equal(normalizeSearch(undefined), undefined);
	assert.equal(normalizeSearch(123), undefined);
});

test('normalizeSearch: 空串/纯空白 → undefined', () => {
	assert.equal(normalizeSearch(''), undefined);
	assert.equal(normalizeSearch('   '), undefined);
});

test('normalizeSearch: trim 后返回非空值', () => {
	assert.equal(normalizeSearch('  foo  '), 'foo');
});

test('normalizeCursor: 仅接受数字字符串', () => {
	assert.equal(normalizeCursor('12345'), '12345');
	assert.equal(normalizeCursor('abc'), undefined);
	assert.equal(normalizeCursor(''), undefined);
	assert.equal(normalizeCursor(undefined), undefined);
	assert.equal(normalizeCursor('1.5'), undefined);
	assert.equal(normalizeCursor(null), undefined);
});

// --- listClawsHandler ---

test('listClawsHandler: 透传参数并标记 online', async () => {
	let captured = null;
	const res = mockRes();
	const req = { query: { cursor: '100', limit: '20', search: ' foo ' } };

	await listClawsHandler(req, res, () => {}, {
		listClawsPaginated: async (opts) => {
			captured = opts;
			return {
				items: [
					{ id: '1', name: 'a' },
					{ id: '2', name: 'b' },
				],
				nextCursor: null,
			};
		},
		listOnlineClawIds: () => new Set(['1']),
	});

	assert.deepEqual(captured, { cursor: '100', limit: 20, search: 'foo' });
	assert.equal(res._json.items[0].online, true);
	assert.equal(res._json.items[1].online, false);
	assert.equal(res._json.nextCursor, null);
});

test('listClawsHandler: cursor 非法被忽略', async () => {
	let captured = null;
	await listClawsHandler({ query: { cursor: 'abc' } }, mockRes(), () => {}, {
		listClawsPaginated: async (opts) => { captured = opts; return { items: [], nextCursor: null }; },
		listOnlineClawIds: () => new Set(),
	});
	assert.equal(captured.cursor, undefined);
});

test('listClawsHandler: req.query 缺失时用默认参数', async () => {
	let captured = null;
	await listClawsHandler({}, mockRes(), () => {}, {
		listClawsPaginated: async (opts) => { captured = opts; return { items: [], nextCursor: null }; },
		listOnlineClawIds: () => new Set(),
	});
	assert.deepEqual(captured, { cursor: undefined, limit: 50, search: undefined });
});

test('listClawsHandler: repo 抛错 → next', async () => {
	const err = new Error('db');
	let nextErr = null;
	await listClawsHandler({ query: {} }, mockRes(), (e) => { nextErr = e; }, {
		listClawsPaginated: async () => { throw err; },
		listOnlineClawIds: () => new Set(),
	});
	assert.equal(nextErr, err);
});

test('listClawsHandler: 默认 deps 可达', async () => {
	const res = mockRes();
	let nextErr = null;
	await listClawsHandler({ query: {} }, res, (e) => { nextErr = e; });
	assert.ok(res._json !== null || nextErr !== null, '默认路径应可达');
});

// --- listUsersHandler ---

test('listUsersHandler: 直接透传 repo 结果', async () => {
	let captured = null;
	const res = mockRes();
	const fake = { items: [{ id: '1', name: 'u' }], nextCursor: '1' };

	await listUsersHandler({ query: { limit: '5', search: 'a' } }, res, () => {}, {
		listUsersPaginated: async (opts) => { captured = opts; return fake; },
	});

	assert.deepEqual(captured, { cursor: undefined, limit: 5, search: 'a' });
	assert.deepEqual(res._json, fake);
});

test('listUsersHandler: repo 抛错 → next', async () => {
	const err = new Error('db');
	let nextErr = null;
	await listUsersHandler({ query: {} }, mockRes(), (e) => { nextErr = e; }, {
		listUsersPaginated: async () => { throw err; },
	});
	assert.equal(nextErr, err);
});

test('listUsersHandler: 默认 deps 可达', async () => {
	const res = mockRes();
	let nextErr = null;
	await listUsersHandler({ query: {} }, res, (e) => { nextErr = e; });
	assert.ok(res._json !== null || nextErr !== null, '默认路径应可达');
});

// --- adminStreamHandler ---

test('adminStreamHandler: 设置 SSE header 并注册 client + 心跳', async (t) => {
	t.mock.timers.enable({ apis: ['setInterval'] });
	let registered = null;
	const reqCloseHandlers = [];
	const req = {
		on(event, handler) {
			if (event === 'close') reqCloseHandlers.push(handler);
		},
	};
	const res = mockRes();

	await adminStreamHandler(req, res, () => {}, {
		registerAdminSseClient: (r) => { registered = r; },
	});

	assert.equal(res._headStatus, 200);
	assert.equal(res._headHeaders['Content-Type'], 'text/event-stream');
	assert.equal(registered, res);
	assert.ok(reqCloseHandlers.length > 0);

	// 推进心跳 timer 验证 write 被调用
	t.mock.timers.tick(30_000);
	assert.ok(res._written.includes('data: {"event":"heartbeat"}\n\n'));

	// 清理
	for (const h of reqCloseHandlers) h();
});

test('adminStreamHandler: 心跳 write 失败时清理 timer', async (t) => {
	t.mock.timers.enable({ apis: ['setInterval'] });
	const reqCloseHandlers = [];
	const req = { on(event, handler) { if (event === 'close') reqCloseHandlers.push(handler); } };

	let writeCalls = 0;
	const res = {
		writeHead() {},
		write() {
			writeCalls++;
			if (writeCalls >= 2) throw new Error('pipe');
		},
	};

	await adminStreamHandler(req, res, () => {}, { registerAdminSseClient: () => {} });

	// 第一次心跳：抛错 → clearInterval
	t.mock.timers.tick(30_000);
	// 第二次 tick：timer 已清理，write 不再被调用
	t.mock.timers.tick(30_000);

	assert.equal(writeCalls, 2); // 1 初始 '\n' + 1 心跳

	for (const h of reqCloseHandlers) h();
});

test('adminStreamHandler: 默认 registerAdminSseClient 分支', async (t) => {
	t.mock.timers.enable({ apis: ['setInterval'] });
	const reqCloseHandlers = [];
	const req = { on(event, handler) { if (event === 'close') reqCloseHandlers.push(handler); } };
	const res = mockRes();
	// 不传 deps，走默认依赖（真实 registerAdminSseClient）
	await adminStreamHandler(req, res);
	assert.equal(res._headStatus, 200);
	// 清理 timer + 从 adminSseClients 中移除
	for (const h of reqCloseHandlers) h();
	res.__triggerClose?.();
});
