import assert from 'node:assert/strict';
import test from 'node:test';

import express, { Router } from 'express';
import request from 'supertest';

import {
	listWebAgentsHandler,
	recordClickHandler,
	hideWebAgentHandler,
	parseWebAgentId,
	webAgentRouter,
} from './web-agent.route.js';
import { prisma } from '../db/prisma.js';

function createRes() {
	return {
		statusCode: null,
		body: null,
		ended: false,
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

function authedReq(extra = {}) {
	return {
		isAuthenticated: () => true,
		user: { id: 7n },
		...extra,
	};
}

function unauthedReq(extra = {}) {
	return {
		isAuthenticated: () => false,
		user: null,
		...extra,
	};
}

// ---- parseWebAgentId ----

test('parseWebAgentId: 合法正整数返回 number', () => {
	assert.equal(parseWebAgentId('1'), 1);
	assert.equal(parseWebAgentId('42'), 42);
});

test('parseWebAgentId: 0 返回 null', () => {
	assert.equal(parseWebAgentId('0'), null);
});

test('parseWebAgentId: 负数 / 小数 / 字母 / 空 / 非字符串 返回 null', () => {
	assert.equal(parseWebAgentId('-1'), null);
	assert.equal(parseWebAgentId('1.5'), null);
	assert.equal(parseWebAgentId('abc'), null);
	assert.equal(parseWebAgentId(''), null);
	assert.equal(parseWebAgentId(undefined), null);
	assert.equal(parseWebAgentId(null), null);
	assert.equal(parseWebAgentId(1), null); // 非字符串
});

test('parseWebAgentId: 含 . / + / e / 空格 等非纯数字字符返回 null', () => {
	assert.equal(parseWebAgentId('1.0'), null);
	assert.equal(parseWebAgentId('+1'), null);
	assert.equal(parseWebAgentId('1e2'), null);
	assert.equal(parseWebAgentId(' 1'), null);
	assert.equal(parseWebAgentId('1 '), null);
	assert.equal(parseWebAgentId('1.5e3'), null);
});

test('parseWebAgentId: UnsignedInt 上界（4294967295）接受、超出拒绝', () => {
	// schema: WebAgent.id @db.UnsignedInt → 0..4294967295
	assert.equal(parseWebAgentId('4294967295'), 4294967295);
	assert.equal(parseWebAgentId('4294967296'), null);
	// safe integer 范围外但 Number.isInteger 仍 true 的大数也必须拒绝
	assert.equal(parseWebAgentId('99999999999999999999'), null);
});

test('parseWebAgentId: 前导零 "0001" 接受并规范化为 1', () => {
	// 这是当前正则 [0-9]+ 的语义：前导零不算非法。锁住该行为以防未来收紧时静默回归
	assert.equal(parseWebAgentId('0001'), 1);
});

test('parseWebAgentId: 全角数字（１２３）拒绝', () => {
	// [0-9] 仅匹配 ASCII 0-9；正则若被改宽（如 \d 含 Unicode 数字）会让此用例失败
	assert.equal(parseWebAgentId('１２３'), null);
});

// ---- listWebAgentsHandler ----

test('listWebAgentsHandler: 未登录也能拿到列表，userId 传 null', async () => {
	// 接口已对匿名用户开放（ChatBot 门户语义）；userId 透传 null 让 repo 走匿名分支
	const req = unauthedReq();
	const res = createRes();
	const items = [
		{ id: 1, slug: 'a', name: 'A', url: 'https://a/', sort: 1, lastClickedAt: null, hiddenAt: null },
	];
	let receivedUserId = 'NOT_CALLED';
	await listWebAgentsHandler(req, res, () => {}, {
		findAllForUserImpl: async (userId) => {
			receivedUserId = userId;
			return items;
		},
	});
	assert.equal(receivedUserId, null);
	assert.equal(res.statusCode, 200);
	assert.deepEqual(res.body.items, items);
});

test('listWebAgentsHandler: req.isAuthenticated 缺失（passport 未挂）视为未登录，不抛', async () => {
	// 防御性：isAuthenticated 不是函数时也不能炸，按匿名走
	const req = { isAuthenticated: undefined, user: null };
	const res = createRes();
	let receivedUserId = 'NOT_CALLED';
	await listWebAgentsHandler(req, res, () => {}, {
		findAllForUserImpl: async (userId) => {
			receivedUserId = userId;
			return [];
		},
	});
	assert.equal(receivedUserId, null);
	assert.equal(res.statusCode, 200);
});

test('listWebAgentsHandler: 登录后正常返回 items', async () => {
	const req = authedReq();
	const res = createRes();
	const items = [
		{ id: 1, slug: 'a', name: 'A', url: 'https://a/', sort: 1, lastClickedAt: null },
		{ id: 2, slug: 'b', name: 'B', url: 'https://b/', sort: 2, lastClickedAt: new Date('2026-05-01') },
	];
	await listWebAgentsHandler(req, res, () => {}, {
		findAllForUserImpl: async (userId) => {
			assert.equal(userId, 7n);
			return items;
		},
	});
	assert.equal(res.statusCode, 200);
	assert.deepEqual(res.body.items, items);
	// 锁住响应 root 仅 items 一个 key——防止未来手滑添加无意义的 meta 字段
	assert.deepEqual(Object.keys(res.body), ['items']);
});

test('listWebAgentsHandler: lastClickedAt / hiddenAt 经 JSON 序列化后是 ISO 字符串或 null（前端时序合并依赖）', async () => {
	// res.body 是 JS 对象（拿到 Date 对象），但实际过线时会被 JSON.stringify 序列化
	// 前端把 ISO 字符串与本地乐观时间戳做时序比较；若 server 哪天误把 Date 包成 { value, at } 之类
	// 序列化后形态会变，前端比较静默失败。这里走一遍 stringify 锁住实际过线形态
	const req = authedReq();
	const res = createRes();
	const items = [
		// 三态：没点过 / 点过未藏 / 点过已藏
		{ id: 1, slug: 'a', name: 'A', url: 'https://a/', sort: 1, lastClickedAt: null, hiddenAt: null },
		{ id: 2, slug: 'b', name: 'B', url: 'https://b/', sort: 2, lastClickedAt: new Date('2026-05-01T10:00:00Z'), hiddenAt: null },
		{ id: 3, slug: 'c', name: 'C', url: 'https://c/', sort: 3, lastClickedAt: new Date('2026-05-02T10:00:00Z'), hiddenAt: new Date('2026-05-02T11:00:00Z') },
	];
	await listWebAgentsHandler(req, res, () => {}, {
		findAllForUserImpl: async () => items,
	});

	const wire = JSON.parse(JSON.stringify(res.body));
	const [a, b, c] = wire.items;
	// null 透传
	assert.equal(a.lastClickedAt, null);
	assert.equal(a.hiddenAt, null);
	// Date → ISO 字符串（不是 {} 也不是 undefined）
	assert.equal(typeof b.lastClickedAt, 'string');
	assert.equal(b.lastClickedAt, '2026-05-01T10:00:00.000Z');
	assert.equal(b.hiddenAt, null);
	assert.equal(typeof c.lastClickedAt, 'string');
	assert.equal(c.lastClickedAt, '2026-05-02T10:00:00.000Z');
	assert.equal(typeof c.hiddenAt, 'string');
	assert.equal(c.hiddenAt, '2026-05-02T11:00:00.000Z');
});

test('listWebAgentsHandler: 异常走 next(err)', async () => {
	const req = authedReq();
	const res = createRes();
	let nextErr = null;
	const expected = new Error('db down');
	await listWebAgentsHandler(req, res, (err) => { nextErr = err; }, {
		findAllForUserImpl: async () => { throw expected; },
	});
	assert.equal(nextErr, expected);
	assert.equal(res.statusCode, null);
});

// ---- recordClickHandler ----

test('recordClickHandler: 未登录 → 401', async () => {
	const req = unauthedReq({ params: { id: '1' } });
	const res = createRes();
	await recordClickHandler(req, res, () => {});
	assert.equal(res.statusCode, 401);
	assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('recordClickHandler: id 非法 → 400 INVALID_INPUT', async () => {
	const req = authedReq({ params: { id: 'abc' } });
	const res = createRes();
	await recordClickHandler(req, res, () => {});
	assert.equal(res.statusCode, 400);
	assert.equal(res.body.code, 'INVALID_INPUT');
});

test('recordClickHandler: id=0 → 400 INVALID_INPUT', async () => {
	const req = authedReq({ params: { id: '0' } });
	const res = createRes();
	await recordClickHandler(req, res, () => {});
	assert.equal(res.statusCode, 400);
	assert.equal(res.body.code, 'INVALID_INPUT');
});

test('recordClickHandler: 不可见 → 404 WEB_AGENT_NOT_FOUND', async () => {
	const req = authedReq({ params: { id: '99' } });
	const res = createRes();
	await recordClickHandler(req, res, () => {}, {
		recordClickImpl: async () => false,
	});
	assert.equal(res.statusCode, 404);
	assert.equal(res.body.code, 'WEB_AGENT_NOT_FOUND');
});

test('recordClickHandler: 可见 → 204 No Content', async () => {
	const req = authedReq({ params: { id: '7' } });
	const res = createRes();
	let receivedArgs = null;
	await recordClickHandler(req, res, () => {}, {
		recordClickImpl: async (args) => {
			receivedArgs = args;
			return true;
		},
	});
	assert.equal(res.statusCode, 204);
	assert.equal(res.ended, true);
	assert.deepEqual(receivedArgs, { userId: 7n, webAgentId: 7 });
	// 204 必须无 body（不能误调 res.json）
	assert.equal(res.body, null);
});

test('recordClickHandler: 401 / 400 / 404 错误响应均含非空 code + message', async () => {
	// 401
	const res401 = createRes();
	await recordClickHandler(unauthedReq({ params: { id: '1' } }), res401, () => {});
	assert.equal(res401.body.code, 'UNAUTHORIZED');
	assert.ok(typeof res401.body.message === 'string' && res401.body.message.length > 0);

	// 400
	const res400 = createRes();
	await recordClickHandler(authedReq({ params: { id: 'abc' } }), res400, () => {});
	assert.equal(res400.body.code, 'INVALID_INPUT');
	assert.ok(typeof res400.body.message === 'string' && res400.body.message.length > 0);

	// 404
	const res404 = createRes();
	await recordClickHandler(authedReq({ params: { id: '7' } }), res404, () => {}, {
		recordClickImpl: async () => false,
	});
	assert.equal(res404.body.code, 'WEB_AGENT_NOT_FOUND');
	assert.ok(typeof res404.body.message === 'string' && res404.body.message.length > 0);
});

test('recordClickHandler: service 抛错走 next(err)', async () => {
	const req = authedReq({ params: { id: '7' } });
	const res = createRes();
	let nextErr = null;
	const expected = new Error('boom');
	await recordClickHandler(req, res, (err) => { nextErr = err; }, {
		recordClickImpl: async () => { throw expected; },
	});
	assert.equal(nextErr, expected);
	assert.equal(res.statusCode, null);
});

test('recordClickHandler: req.params 缺失 → 400 INVALID_INPUT（不抛异常）', async () => {
	const req = authedReq();
	const res = createRes();
	await recordClickHandler(req, res, () => {});
	assert.equal(res.statusCode, 400);
	assert.equal(res.body.code, 'INVALID_INPUT');
});

// ---- hideWebAgentHandler ----

test('hideWebAgentHandler: 未登录 → 401', async () => {
	const req = unauthedReq({ params: { id: '1' } });
	const res = createRes();
	await hideWebAgentHandler(req, res, () => {});
	assert.equal(res.statusCode, 401);
	assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('hideWebAgentHandler: id 非法 → 400 INVALID_INPUT', async () => {
	const req = authedReq({ params: { id: 'abc' } });
	const res = createRes();
	await hideWebAgentHandler(req, res, () => {});
	assert.equal(res.statusCode, 400);
	assert.equal(res.body.code, 'INVALID_INPUT');
});

test('hideWebAgentHandler: id=0 → 400 INVALID_INPUT', async () => {
	const req = authedReq({ params: { id: '0' } });
	const res = createRes();
	await hideWebAgentHandler(req, res, () => {});
	assert.equal(res.statusCode, 400);
	assert.equal(res.body.code, 'INVALID_INPUT');
});

test('hideWebAgentHandler: 不可见 / 用户从未点击 → 404 WEB_AGENT_NOT_FOUND', async () => {
	const req = authedReq({ params: { id: '99' } });
	const res = createRes();
	await hideWebAgentHandler(req, res, () => {}, {
		hideImpl: async () => false,
	});
	assert.equal(res.statusCode, 404);
	assert.equal(res.body.code, 'WEB_AGENT_NOT_FOUND');
});

test('hideWebAgentHandler: 成功 → 204 No Content，透传 userId/webAgentId', async () => {
	const req = authedReq({ params: { id: '7' } });
	const res = createRes();
	let receivedArgs = null;
	await hideWebAgentHandler(req, res, () => {}, {
		hideImpl: async (args) => {
			receivedArgs = args;
			return true;
		},
	});
	assert.equal(res.statusCode, 204);
	assert.equal(res.ended, true);
	assert.deepEqual(receivedArgs, { userId: 7n, webAgentId: 7 });
	// 204 必须无 body
	assert.equal(res.body, null);
});

test('hideWebAgentHandler: 幂等 — 同样的请求连续两次都返 204', async () => {
	const req = authedReq({ params: { id: '7' } });
	const res1 = createRes();
	const res2 = createRes();
	const hideImpl = async () => true;
	await hideWebAgentHandler(req, res1, () => {}, { hideImpl });
	await hideWebAgentHandler(req, res2, () => {}, { hideImpl });
	assert.equal(res1.statusCode, 204);
	assert.equal(res2.statusCode, 204);
});

test('hideWebAgentHandler: 401 / 400 / 404 错误响应均含非空 code + message', async () => {
	const res401 = createRes();
	await hideWebAgentHandler(unauthedReq({ params: { id: '1' } }), res401, () => {});
	assert.equal(res401.body.code, 'UNAUTHORIZED');
	assert.ok(typeof res401.body.message === 'string' && res401.body.message.length > 0);

	const res400 = createRes();
	await hideWebAgentHandler(authedReq({ params: { id: 'abc' } }), res400, () => {});
	assert.equal(res400.body.code, 'INVALID_INPUT');
	assert.ok(typeof res400.body.message === 'string' && res400.body.message.length > 0);

	const res404 = createRes();
	await hideWebAgentHandler(authedReq({ params: { id: '7' } }), res404, () => {}, {
		hideImpl: async () => false,
	});
	assert.equal(res404.body.code, 'WEB_AGENT_NOT_FOUND');
	assert.ok(typeof res404.body.message === 'string' && res404.body.message.length > 0);
});

test('hideWebAgentHandler: service 抛错走 next(err)', async () => {
	const req = authedReq({ params: { id: '7' } });
	const res = createRes();
	let nextErr = null;
	const expected = new Error('boom');
	await hideWebAgentHandler(req, res, (err) => { nextErr = err; }, {
		hideImpl: async () => { throw expected; },
	});
	assert.equal(nextErr, expected);
	assert.equal(res.statusCode, null);
});

test('hideWebAgentHandler: req.params 缺失 → 400 INVALID_INPUT（不抛异常）', async () => {
	const req = authedReq();
	const res = createRes();
	await hideWebAgentHandler(req, res, () => {});
	assert.equal(res.statusCode, 400);
	assert.equal(res.body.code, 'INVALID_INPUT');
});

// ---- 跨 handler scenario：用同一份 fake state 跑主流程 ----

// 单调递增 clock，确保两次 click 的 lastClickedAt 严格大于上次（不依赖 wall clock）
function makeFakeStore() {
	const agents = [{ id: 7, slug: 'a', name: 'A', url: 'https://a/', sort: 1 }];
	const clicks = new Map(); // key=`${userId}|${webAgentId}` → {clickCount, lastClickedAt, hiddenAt}
	let clock = Date.parse('2026-05-09T08:00:00Z');
	const tick = () => new Date(++clock);
	const key = (u, w) => `${u}|${w}`;

	return {
		findAllForUserImpl: async (userId) => agents.map((a) => {
			const c = clicks.get(key(userId, a.id));
			return {
				id: a.id,
				slug: a.slug,
				name: a.name,
				url: a.url,
				sort: a.sort,
				lastClickedAt: c?.lastClickedAt ?? null,
				hiddenAt: c?.hiddenAt ?? null,
			};
		}),
		recordClickImpl: async ({ userId, webAgentId }) => {
			if (!agents.some(a => a.id === webAgentId)) return false;
			const k = key(userId, webAgentId);
			const cur = clicks.get(k);
			if (cur) {
				cur.clickCount += 1;
				cur.lastClickedAt = tick();
				cur.hiddenAt = null;
			}
			else {
				clicks.set(k, { clickCount: 1, lastClickedAt: tick(), hiddenAt: null });
			}
			return true;
		},
		hideImpl: async ({ userId, webAgentId }) => {
			if (!agents.some(a => a.id === webAgentId)) return false;
			const cur = clicks.get(key(userId, webAgentId));
			if (!cur) return false;
			cur.hiddenAt = tick();
			return true;
		},
	};
}

test('scenario: route 层 list→click→list→hide→list→click→list 主流程闭合（同一 fake state 串三 handler）', async () => {
	// 验证三个 handler 在同一 state 下协作的契约：list 形态在每步后正确反映
	const store = makeFakeStore();
	const id = '7';
	const findAllDeps = { findAllForUserImpl: store.findAllForUserImpl };
	const clickDeps = { recordClickImpl: store.recordClickImpl };
	const hideDeps = { hideImpl: store.hideImpl };

	async function getList() {
		const res = createRes();
		await listWebAgentsHandler(authedReq(), res, () => {}, findAllDeps);
		assert.equal(res.statusCode, 200);
		return res.body.items[0];
	}

	// step 1: list 初始 — 都是 null
	let item = await getList();
	assert.equal(item.lastClickedAt, null);
	assert.equal(item.hiddenAt, null);

	// step 2: click → 204
	let res = createRes();
	await recordClickHandler(authedReq({ params: { id } }), res, () => {}, clickDeps);
	assert.equal(res.statusCode, 204);

	// step 3: list → lastClickedAt 非空、hiddenAt 仍 null
	item = await getList();
	assert.ok(item.lastClickedAt instanceof Date);
	assert.equal(item.hiddenAt, null);
	const firstClickAt = item.lastClickedAt;

	// step 4: hide → 204
	res = createRes();
	await hideWebAgentHandler(authedReq({ params: { id } }), res, () => {}, hideDeps);
	assert.equal(res.statusCode, 204);

	// step 5: list → hiddenAt 非空、lastClickedAt 不变
	item = await getList();
	assert.ok(item.hiddenAt instanceof Date);
	assert.equal(item.lastClickedAt.getTime(), firstClickAt.getTime());
	const hideAt = item.hiddenAt;

	// step 6: 再次 click → 204（自动取消隐藏）
	res = createRes();
	await recordClickHandler(authedReq({ params: { id } }), res, () => {}, clickDeps);
	assert.equal(res.statusCode, 204);

	// step 7: list → hiddenAt 清空、lastClickedAt 严格大于上次
	item = await getList();
	assert.equal(item.hiddenAt, null);
	assert.ok(item.lastClickedAt.getTime() > hideAt.getTime());
});

test('scenario: route 层 hide 一个用户从未点击过的 agent → 404（service false 真打到 store）', async () => {
	// 防 mock 写错时被误掩盖：用 fake store 真跑 hideImpl 的"可见但 click 行不存在"分支
	const store = makeFakeStore();
	const res = createRes();
	await hideWebAgentHandler(authedReq({ params: { id: '7' } }), res, () => {}, {
		hideImpl: store.hideImpl,
	});
	assert.equal(res.statusCode, 404);
	assert.equal(res.body.code, 'WEB_AGENT_NOT_FOUND');
});

// ---- supertest 兜底：用真 webAgentRouter 验证 method/path/Content-Type ----
//
// 全部用未登录请求（不会触达 service，所以不需要 mock prisma）；
// 防 method 误改（POST→GET）、mount 路径手滑、错误响应 Content-Type 漂移这类
// handler 单测无法覆盖的 HTTP 表层回归

function makeUnauthedApp() {
	const app = express();
	app.use(express.json());
	// 真 webAgentRouter；未登录请求会被 requireSession 在 handler 入口拦截，不会调 service
	app.use('/api/v1/web-agents', webAgentRouter);
	return app;
}

test('routing: GET /api/v1/web-agents/:id/hide → 404（仅 POST 注册了 /:id/hide）', async () => {
	const res = await request(makeUnauthedApp()).get('/api/v1/web-agents/1/hide');
	assert.equal(res.status, 404);
});

test('routing: GET /api/v1/web-agents/:id/click → 404（仅 POST 注册了 /:id/click）', async () => {
	const res = await request(makeUnauthedApp()).get('/api/v1/web-agents/1/click');
	assert.equal(res.status, 404);
});

test('routing: PUT /api/v1/web-agents/:id/hide → 404（不接受其它 method）', async () => {
	const res = await request(makeUnauthedApp()).put('/api/v1/web-agents/1/hide');
	assert.equal(res.status, 404);
});

test('routing: GET /api/v1/web-agents/unknown-path → 404', async () => {
	const res = await request(makeUnauthedApp()).get('/api/v1/web-agents/foo/bar/baz');
	assert.equal(res.status, 404);
});

test('routing: 未登录 POST /api/v1/web-agents/:id/click → 401 application/json + code/message', async () => {
	const res = await request(makeUnauthedApp()).post('/api/v1/web-agents/1/click');
	assert.equal(res.status, 401);
	assert.match(res.headers['content-type'] ?? '', /application\/json/);
	assert.equal(res.body.code, 'UNAUTHORIZED');
	assert.ok(typeof res.body.message === 'string' && res.body.message.length > 0);
});

test('routing: 未登录 POST /api/v1/web-agents/:id/hide → 401 application/json + code/message', async () => {
	const res = await request(makeUnauthedApp()).post('/api/v1/web-agents/1/hide');
	assert.equal(res.status, 401);
	assert.match(res.headers['content-type'] ?? '', /application\/json/);
	assert.equal(res.body.code, 'UNAUTHORIZED');
	assert.ok(typeof res.body.message === 'string' && res.body.message.length > 0);
});

test('routing: 未登录 POST 即使 id 非法也优先返 401（401 在 400 前）', async () => {
	const res = await request(makeUnauthedApp()).post('/api/v1/web-agents/abc/hide');
	assert.equal(res.status, 401);
	assert.equal(res.body.code, 'UNAUTHORIZED');
});

// makeAnonAppWithRepoStub：用注入 deps 的 listWebAgentsHandler 挂同一挂载点，
// 防止生产 webAgentRouter 真打 prisma 又能锁住"匿名 GET → 200 + 路径正确"
function makeAnonAppWithRepoStub(stubItems) {
	const app = express();
	app.use(express.json());
	const r = Router();
	r.get('/', (req, res, next) => listWebAgentsHandler(req, res, next, {
		findAllForUserImpl: async () => stubItems,
	}));
	app.use('/api/v1/web-agents', r);
	return app;
}

test('routing: 未登录 GET /api/v1/web-agents → 200 application/json + items 为预置纯入口', async () => {
	// 端到端兜底（注入 deps 版）：锁住"匿名 GET → 200 + 路径正确 + JSON 形状"
	const items = [
		{ id: 1, slug: 'a', name: 'A', url: 'https://a/', sort: 1, lastClickedAt: null, hiddenAt: null },
		{ id: 2, slug: 'b', name: 'B', url: 'https://b/', sort: 2, lastClickedAt: null, hiddenAt: null },
	];
	const res = await request(makeAnonAppWithRepoStub(items)).get('/api/v1/web-agents');
	assert.equal(res.status, 200);
	assert.match(res.headers['content-type'] ?? '', /application\/json/);
	assert.deepEqual(res.body.items, items);
});

test('routing: 真 webAgentRouter 也对匿名 GET 放行 → 200（防"未来加回 requireSession 中间件"回归）', async () => {
	// 仅 stub prisma.webAgent.findMany，不动业务路径；
	// 若有人重新给 GET 加了 requireSession，这条会立刻 401
	const original = prisma.webAgent.findMany;
	prisma.webAgent.findMany = async () => [
		{ id: 1, slug: 'a', name: 'A', url: 'https://a/', sort: 1, userId: null },
	];
	try {
		const res = await request(makeUnauthedApp()).get('/api/v1/web-agents');
		assert.equal(res.status, 200);
		assert.match(res.headers['content-type'] ?? '', /application\/json/);
		assert.equal(res.body.items.length, 1);
		// 匿名分支个人化字段固定 null
		assert.equal(res.body.items[0].lastClickedAt, null);
		assert.equal(res.body.items[0].hiddenAt, null);
	}
	finally {
		prisma.webAgent.findMany = original;
	}
});
