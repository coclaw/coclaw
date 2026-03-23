import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

// 必须在 import turn.route.js 之前设置环境变量
process.env.TURN_SECRET = 'test-secret-for-unit-tests';
process.env.APP_DOMAIN = 'test.coclaw.net';

const { genTurnCreds, turnRouter } = await import('./turn.route.js');

// --- genTurnCreds 纯函数测试 ---

test('genTurnCreds: 返回正确结构', () => {
	const creds = genTurnCreds('user42', 'my-secret');
	assert.ok(creds.username.endsWith(':user42'));
	assert.equal(typeof creds.credential, 'string');
	assert.equal(creds.ttl, 86400);
	assert.ok(Array.isArray(creds.urls));
	assert.equal(creds.urls.length, 3);
});

test('genTurnCreds: username 包含过期时间戳', () => {
	const before = Math.floor(Date.now() / 1000) + 86400;
	const creds = genTurnCreds('u1', 'secret');
	const after = Math.floor(Date.now() / 1000) + 86400;
	const ts = Number(creds.username.split(':')[0]);
	assert.ok(ts >= before && ts <= after, `timestamp ${ts} should be in [${before}, ${after}]`);
});

test('genTurnCreds: credential 与手工 HMAC-SHA1 一致', () => {
	const secret = 'test-secret';
	const creds = genTurnCreds('uid_7', secret, 3600);
	const expected = crypto.createHmac('sha1', secret).update(creds.username).digest('base64');
	assert.equal(creds.credential, expected);
});

test('genTurnCreds: urls 使用 APP_DOMAIN', () => {
	const creds = genTurnCreds('u', 'secret');
	for (const url of creds.urls) {
		assert.ok(url.includes('test.coclaw.net'), `url should contain domain: ${url}`);
	}
});

test('genTurnCreds: 自定义 ttl', () => {
	const creds = genTurnCreds('u', 'secret', 7200);
	assert.equal(creds.ttl, 7200);
});

// --- 路由测试（模拟 req/res）---

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

function findRouteHandler(router, method, path) {
	for (const layer of router.stack) {
		if (layer.route?.path === path && layer.route.methods[method]) {
			return layer.route.stack[0].handle;
		}
	}
	return null;
}

const credsHandler = findRouteHandler(turnRouter, 'get', '/creds');

test('GET /creds: 未认证返回 401', () => {
	const req = { isAuthenticated: () => false, user: null };
	const res = createRes();
	credsHandler(req, res);
	assert.equal(res.statusCode, 401);
	assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('GET /creds: 认证用户返回有效凭证', () => {
	const req = { isAuthenticated: () => true, user: { id: 42 } };
	const res = createRes();
	credsHandler(req, res);
	assert.equal(res.statusCode, null); // json() 直接调用，未显式 status(200)
	assert.ok(res.body.username.endsWith(':42'));
	assert.equal(typeof res.body.credential, 'string');
	assert.equal(res.body.ttl, 86400);
	assert.equal(res.body.urls.length, 3);
});

test('GET /creds: user 为原始值时正确转换', () => {
	const req = { isAuthenticated: () => true, user: 99 };
	const res = createRes();
	credsHandler(req, res);
	assert.ok(res.body.username.endsWith(':99'));
});

test('GET /creds: TURN_SECRET 未配置时返回 503', () => {
	const orig = process.env.TURN_SECRET;
	delete process.env.TURN_SECRET;
	try {
		const req = { isAuthenticated: () => true, user: { id: 1 } };
		const res = createRes();
		credsHandler(req, res);
		assert.equal(res.statusCode, 503);
		assert.equal(res.body.code, 'TURN_NOT_CONFIGURED');
	} finally {
		process.env.TURN_SECRET = orig;
	}
});
