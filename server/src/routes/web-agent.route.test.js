import assert from 'node:assert/strict';
import test from 'node:test';

import {
	listWebAgentsHandler,
	recordClickHandler,
	hideWebAgentHandler,
	parseWebAgentId,
} from './web-agent.route.js';

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

test('listWebAgentsHandler: 未登录 → 401', async () => {
	const req = unauthedReq();
	const res = createRes();
	await listWebAgentsHandler(req, res, () => {});
	assert.equal(res.statusCode, 401);
	assert.equal(res.body.code, 'UNAUTHORIZED');
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

test('listWebAgentsHandler: 401 / 异常 等错误响应均含非空 message 字段', async () => {
	// 401
	const res1 = createRes();
	await listWebAgentsHandler(unauthedReq(), res1, () => {});
	assert.equal(typeof res1.body.message, 'string');
	assert.ok(res1.body.message.length > 0);
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
