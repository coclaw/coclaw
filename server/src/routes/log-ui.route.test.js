import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';
import request from 'supertest';

import { fmtRemoteLogTs } from '../claw-ws-hub.js';
import {
	stopUiLogCleanupTimer,
	__resetUiLogState,
	__getUiLogState,
} from '../services/log-ui.svc.js';
import {
	attachLogUiBodyParser,
	handlePostLogUi,
	logUiRouter,
	__test,
} from './log-ui.route.js';

const VALID_UI_ID = 'V1StGXR8_Z5jdHi6B-myT'; // nanoid 默认 21 字符样例

function makeApp({ user } = {}) {
	const app = express();
	attachLogUiBodyParser(app);
	app.use(express.json());
	app.use((req, _res, next) => {
		if (user) {
			req.user = user;
			req.isAuthenticated = () => true;
		}
		else {
			req.user = null;
			req.isAuthenticated = () => false;
		}
		next();
	});
	app.use('/api/v1/log', logUiRouter);
	return app;
}

function captureConsoleInfo(t) {
	const lines = [];
	t.mock.method(console, 'info', (...args) => {
		lines.push(args.join(' '));
	});
	return lines;
}

test.beforeEach(() => {
	stopUiLogCleanupTimer();
	__resetUiLogState();
});

test.after(() => {
	stopUiLogCleanupTimer();
	__resetUiLogState();
});

// --- 正常路径 ---

test('POST /api/v1/log/ui: 合法 batch → 200，按格式打印每条 log', async (t) => {
	const lines = captureConsoleInfo(t);
	const res = await request(makeApp({ user: { id: 42 } }))
		.post('/api/v1/log/ui')
		.send({
			uiId: VALID_UI_ID,
			seq: 1,
			logs: [
				{ ts: 1715500000000, text: 'sig.connected peer=abc' },
				{ ts: 1715500001234, text: 'rtc.state connecting' },
			],
		});
	assert.equal(res.status, 200);
	assert.equal(lines.length, 2);
	const sid = VALID_UI_ID.slice(-8);
	assert.equal(
		lines[0],
		`[remote][ui][user:42][batch=${sid}:1]${fmtRemoteLogTs(1715500000000)} sig.connected peer=abc`,
	);
	assert.equal(
		lines[1],
		`[remote][ui][user:42][batch=${sid}:1]${fmtRemoteLogTs(1715500001234)} rtc.state connecting`,
	);
});

test('POST /api/v1/log/ui: 无 session → 身份段为 [anon]', async (t) => {
	const lines = captureConsoleInfo(t);
	const res = await request(makeApp())
		.post('/api/v1/log/ui')
		.send({
			uiId: VALID_UI_ID,
			seq: 1,
			logs: [{ ts: 1715500000000, text: 'startup' }],
		});
	assert.equal(res.status, 200);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /\[remote\]\[ui\]\[anon\]/);
});

test('POST /api/v1/log/ui: 有 session → 身份段为 [user:<id>]', async (t) => {
	const lines = captureConsoleInfo(t);
	const res = await request(makeApp({ user: { id: 'user-xyz' } }))
		.post('/api/v1/log/ui')
		.send({
			uiId: VALID_UI_ID,
			seq: 1,
			logs: [{ ts: 1715500000000, text: 'login ok' }],
		});
	assert.equal(res.status, 200);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /\[remote\]\[ui\]\[user:user-xyz\]/);
});

test('POST /api/v1/log/ui: req.user 为原始值（非对象）也能转 user 标注', async (t) => {
	const lines = captureConsoleInfo(t);
	const res = await request(makeApp({ user: 99 }))
		.post('/api/v1/log/ui')
		.send({
			uiId: VALID_UI_ID,
			seq: 1,
			logs: [{ ts: 1715500000000, text: 'x' }],
		});
	assert.equal(res.status, 200);
	assert.match(lines[0], /\[user:99\]/);
});

test('POST /api/v1/log/ui: 短 uiId 标识取尾部 8 字符', () => {
	assert.equal(__test.shortUiId('V1StGXR8_Z5jdHi6B-myT'), 'Hi6B-myT');
	assert.equal(__test.shortUiId('V1StGXR8_Z5jdHi6B-myT').length, 8);
});

// --- 单调去重 ---

test('POST /api/v1/log/ui: 重复 seq 静默丢弃，仍返 200 且不打印', async (t) => {
	const app = makeApp({ user: { id: 1 } });
	const lines = captureConsoleInfo(t);

	await request(app).post('/api/v1/log/ui').send({
		uiId: VALID_UI_ID,
		seq: 5,
		logs: [{ ts: 1715500000000, text: 'first' }],
	});
	assert.equal(lines.length, 1);
	assert.match(lines[0], /first/);

	const res = await request(app).post('/api/v1/log/ui').send({
		uiId: VALID_UI_ID,
		seq: 5,
		logs: [{ ts: 1715500099999, text: 'retransmit' }],
	});
	assert.equal(res.status, 200);
	// 第二次应不新增打印
	assert.equal(lines.length, 1);
});

test('POST /api/v1/log/ui: 乱序老 seq 被丢弃', async (t) => {
	const app = makeApp({ user: { id: 1 } });
	await request(app).post('/api/v1/log/ui').send({
		uiId: VALID_UI_ID,
		seq: 5,
		logs: [{ ts: 1, text: 'a' }],
	});
	const lines = captureConsoleInfo(t);
	const res = await request(app).post('/api/v1/log/ui').send({
		uiId: VALID_UI_ID,
		seq: 4,
		logs: [{ ts: 2, text: 'b' }],
	});
	assert.equal(res.status, 200);
	assert.equal(lines.length, 0);
	// map.lastSeq 未回退
	assert.equal(__getUiLogState().get(VALID_UI_ID).lastSeq, 5);
});

test('POST /api/v1/log/ui: 不同 uiId 互不干扰，各自接受 seq=1', async (t) => {
	const app = makeApp();
	const lines = captureConsoleInfo(t);
	const other = 'AbCdEfGhIjKlMnOpQrStU';
	const res1 = await request(app).post('/api/v1/log/ui').send({
		uiId: VALID_UI_ID, seq: 1, logs: [{ ts: 1, text: 'x' }],
	});
	const res2 = await request(app).post('/api/v1/log/ui').send({
		uiId: other, seq: 1, logs: [{ ts: 2, text: 'y' }],
	});
	assert.equal(res1.status, 200);
	assert.equal(res2.status, 200);
	assert.equal(lines.length, 2);
});

// --- schema 校验 → 400 且不更新 map ---

test('POST /api/v1/log/ui: uiId 长度不等于 21 → 400 且不更新 map', async (t) => {
	const lines = captureConsoleInfo(t);
	const res = await request(makeApp())
		.post('/api/v1/log/ui')
		.send({ uiId: 'tooshort', seq: 1, logs: [{ ts: 1, text: 'x' }] });
	assert.equal(res.status, 400);
	assert.equal(res.body.code, 'INVALID_PAYLOAD');
	assert.equal(lines.length, 0);
	assert.equal(__getUiLogState().has('tooshort'), false);
});

test('POST /api/v1/log/ui: uiId 含非法字符（点号）→ 400 且不更新 map', async () => {
	const res = await request(makeApp())
		.post('/api/v1/log/ui')
		.send({ uiId: 'V1StGXR8_Z5jdHi6B-my.', seq: 1, logs: [{ ts: 1, text: 'x' }] });
	assert.equal(res.status, 400);
	assert.equal(__getUiLogState().has('V1StGXR8_Z5jdHi6B-my.'), false);
});

test('POST /api/v1/log/ui: uiId 长度 22 字符 → 400', async () => {
	const res = await request(makeApp())
		.post('/api/v1/log/ui')
		.send({ uiId: 'V1StGXR8_Z5jdHi6B-myTX', seq: 1, logs: [{ ts: 1, text: 'x' }] });
	assert.equal(res.status, 400);
});

test('POST /api/v1/log/ui: seq 非正整数（0）→ 400 且不更新 map', async () => {
	const res = await request(makeApp())
		.post('/api/v1/log/ui')
		.send({ uiId: VALID_UI_ID, seq: 0, logs: [{ ts: 1, text: 'x' }] });
	assert.equal(res.status, 400);
	assert.equal(__getUiLogState().has(VALID_UI_ID), false);
});

test('POST /api/v1/log/ui: seq 为浮点数 → 400 且不更新 map', async () => {
	const res = await request(makeApp())
		.post('/api/v1/log/ui')
		.send({ uiId: VALID_UI_ID, seq: 1.5, logs: [{ ts: 1, text: 'x' }] });
	assert.equal(res.status, 400);
	assert.equal(__getUiLogState().has(VALID_UI_ID), false);
});

test('POST /api/v1/log/ui: seq 超过 MAX_SAFE_INTEGER → 400 且不更新 map', async () => {
	const res = await request(makeApp())
		.post('/api/v1/log/ui')
		.send({
			uiId: VALID_UI_ID,
			seq: Number.MAX_SAFE_INTEGER + 10,
			logs: [{ ts: 1, text: 'x' }],
		});
	assert.equal(res.status, 400);
	assert.equal(__getUiLogState().has(VALID_UI_ID), false);
});

test('POST /api/v1/log/ui: logs 为空数组 → 400 且不更新 map', async () => {
	const res = await request(makeApp())
		.post('/api/v1/log/ui')
		.send({ uiId: VALID_UI_ID, seq: 1, logs: [] });
	assert.equal(res.status, 400);
	assert.equal(__getUiLogState().has(VALID_UI_ID), false);
});

test('POST /api/v1/log/ui: logs 超 100 条 → 400 且不更新 map', async () => {
	const logs = Array.from({ length: 101 }, (_, i) => ({ ts: i, text: 'x' }));
	const res = await request(makeApp())
		.post('/api/v1/log/ui')
		.send({ uiId: VALID_UI_ID, seq: 1, logs });
	assert.equal(res.status, 400);
	assert.equal(__getUiLogState().has(VALID_UI_ID), false);
});

test('POST /api/v1/log/ui: logs[i].ts 非数值 → 400 且不更新 map', async () => {
	const res = await request(makeApp())
		.post('/api/v1/log/ui')
		.send({ uiId: VALID_UI_ID, seq: 1, logs: [{ ts: 'not-a-num', text: 'x' }] });
	assert.equal(res.status, 400);
	assert.equal(__getUiLogState().has(VALID_UI_ID), false);
});

test('POST /api/v1/log/ui: logs[i].ts 为负数 → 400 且不更新 map', async () => {
	const res = await request(makeApp())
		.post('/api/v1/log/ui')
		.send({ uiId: VALID_UI_ID, seq: 1, logs: [{ ts: -1, text: 'x' }] });
	assert.equal(res.status, 400);
	assert.equal(__getUiLogState().has(VALID_UI_ID), false);
});

test('POST /api/v1/log/ui: logs[i].text 非字符串 → 400 且不更新 map', async () => {
	const res = await request(makeApp())
		.post('/api/v1/log/ui')
		.send({ uiId: VALID_UI_ID, seq: 1, logs: [{ ts: 1, text: 123 }] });
	assert.equal(res.status, 400);
	assert.equal(__getUiLogState().has(VALID_UI_ID), false);
});

// --- schema 直接调用：覆盖 JSON 无法编码的 NaN / Infinity ---

test('batchSchema: seq 为 NaN → safeParse 拒绝', () => {
	const r = __test.batchSchema.safeParse({
		uiId: VALID_UI_ID, seq: NaN, logs: [{ ts: 1, text: 'x' }],
	});
	assert.equal(r.success, false);
});

test('batchSchema: seq 为 Infinity → safeParse 拒绝', () => {
	const r = __test.batchSchema.safeParse({
		uiId: VALID_UI_ID, seq: Infinity, logs: [{ ts: 1, text: 'x' }],
	});
	assert.equal(r.success, false);
});

test('batchSchema: seq 为负数 → safeParse 拒绝', () => {
	const r = __test.batchSchema.safeParse({
		uiId: VALID_UI_ID, seq: -1, logs: [{ ts: 1, text: 'x' }],
	});
	assert.equal(r.success, false);
});

test('batchSchema: ts 为 NaN → safeParse 拒绝', () => {
	const r = __test.batchSchema.safeParse({
		uiId: VALID_UI_ID, seq: 1, logs: [{ ts: NaN, text: 'x' }],
	});
	assert.equal(r.success, false);
});

test('batchSchema: ts 为 Infinity → safeParse 拒绝', () => {
	const r = __test.batchSchema.safeParse({
		uiId: VALID_UI_ID, seq: 1, logs: [{ ts: Infinity, text: 'x' }],
	});
	assert.equal(r.success, false);
});

test('batchSchema: seq 恰为 MAX_SAFE_INTEGER → safeParse 接受', () => {
	const r = __test.batchSchema.safeParse({
		uiId: VALID_UI_ID, seq: Number.MAX_SAFE_INTEGER, logs: [{ ts: 0, text: 'x' }],
	});
	assert.equal(r.success, true);
});

test('POST /api/v1/log/ui: 缺 uiId 字段 → 400', async () => {
	const res = await request(makeApp())
		.post('/api/v1/log/ui')
		.send({ seq: 1, logs: [{ ts: 1, text: 'x' }] });
	assert.equal(res.status, 400);
});

test('POST /api/v1/log/ui: 缺 logs 字段 → 400', async () => {
	const res = await request(makeApp())
		.post('/api/v1/log/ui')
		.send({ uiId: VALID_UI_ID, seq: 1 });
	assert.equal(res.status, 400);
});

// --- 方法 / body parser 错误 ---

test('GET /api/v1/log/ui → 405 + Allow: POST', async () => {
	const res = await request(makeApp()).get('/api/v1/log/ui');
	assert.equal(res.status, 405);
	assert.equal(res.headers.allow, 'POST');
	assert.equal(res.body.code, 'METHOD_NOT_ALLOWED');
});

test('PUT /api/v1/log/ui → 405', async () => {
	const res = await request(makeApp()).put('/api/v1/log/ui');
	assert.equal(res.status, 405);
});

test('DELETE /api/v1/log/ui → 405', async () => {
	const res = await request(makeApp()).delete('/api/v1/log/ui');
	assert.equal(res.status, 405);
});

test('PATCH /api/v1/log/ui → 405', async () => {
	const res = await request(makeApp()).patch('/api/v1/log/ui');
	assert.equal(res.status, 405);
});

test('POST /api/v1/log/ui: body 超 1MB → 413', async () => {
	const big = 'x'.repeat(1_200_000);
	const res = await request(makeApp())
		.post('/api/v1/log/ui')
		.set('Content-Type', 'application/json')
		.send(`{"uiId":"${VALID_UI_ID}","seq":1,"logs":[{"ts":1,"text":"${big}"}]}`);
	assert.equal(res.status, 413);
	assert.equal(res.body.code, 'PAYLOAD_TOO_LARGE');
});

test('POST /api/v1/log/ui: 非法 JSON 字符串 → 400 (INVALID_PAYLOAD)', async () => {
	const res = await request(makeApp())
		.post('/api/v1/log/ui')
		.set('Content-Type', 'application/json')
		.send('{"uiId":"V1StGXR8_Z5jdHi6B-myT", seq');
	assert.equal(res.status, 400);
	assert.equal(res.body.code, 'INVALID_PAYLOAD');
});

// --- handler 直接调用（边界覆盖：不走 supertest）---

test('handlePostLogUi: 直接调用 + req.user.id 缺省回退到 String(req.user)', (t) => {
	const lines = captureConsoleInfo(t);
	const res = {
		statusCode: null,
		body: null,
		status(c) { this.statusCode = c; return this; },
		json(b) { this.body = b; return this; },
	};
	handlePostLogUi({
		body: { uiId: VALID_UI_ID, seq: 1, logs: [{ ts: 0, text: 'x' }] },
		isAuthenticated: () => true,
		user: 'u-7',
	}, res);
	assert.equal(res.statusCode, 200);
	assert.match(lines[0], /\[user:u-7\]/);
});

test('handlePostLogUi: isAuthenticated 未提供时回退 anon', (t) => {
	const lines = captureConsoleInfo(t);
	const res = {
		statusCode: null,
		body: null,
		status(c) { this.statusCode = c; return this; },
		json(b) { this.body = b; return this; },
	};
	handlePostLogUi({
		body: { uiId: VALID_UI_ID, seq: 1, logs: [{ ts: 0, text: 'x' }] },
		user: { id: 99 },
	}, res);
	assert.equal(res.statusCode, 200);
	assert.match(lines[0], /\[anon\]/);
});

// --- 格式与 plugin WS log 输出可区分 ---

test('输出前缀 `[remote][ui]` 与 plugin 通道 `[remote][plugin][claw:...]` 可区分', async (t) => {
	const lines = captureConsoleInfo(t);
	await request(makeApp())
		.post('/api/v1/log/ui')
		.send({ uiId: VALID_UI_ID, seq: 1, logs: [{ ts: 1, text: 'x' }] });
	assert.equal(lines.length, 1);
	assert.ok(lines[0].startsWith('[remote][ui]'));
	assert.equal(lines[0].includes('[remote][plugin]'), false);
});

// --- CORS preflight：用真 createApp 验证 OPTIONS 不被 405 误伤 ---

test('OPTIONS /api/v1/log/ui: 跨源 preflight 由全局 CORS 处理，不返 405', async () => {
	const envPatch = {
		ALLOWED_ORIGINS: 'https://im.coclaw.net',
		SESSION_SECRET: 'test-secret-for-options-preflight',
		TURN_SECRET: 'test-turn-secret',
		NODE_ENV: 'test',
	};
	const prev = {};
	for (const k of Object.keys(envPatch)) {
		prev[k] = process.env[k];
		process.env[k] = envPatch[k];
	}
	try {
		const { createApp } = await import('../app.js');
		const app = createApp();
		const res = await request(app)
			.options('/api/v1/log/ui')
			.set('Origin', 'https://im.coclaw.net')
			.set('Access-Control-Request-Method', 'POST')
			.set('Access-Control-Request-Headers', 'content-type');
		assert.notEqual(res.status, 405);
		assert.ok(res.status === 204 || res.status === 200);
		assert.match(res.headers['access-control-allow-origin'] ?? '', /coclaw\.net/);
	}
	finally {
		for (const k of Object.keys(envPatch)) {
			if (prev[k] === undefined) delete process.env[k];
			else process.env[k] = prev[k];
		}
	}
});
