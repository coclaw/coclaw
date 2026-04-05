import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

// 必须在 import turn.route.js 之前设置环境变量
process.env.TURN_SECRET = 'test-secret-for-unit-tests';
process.env.APP_DOMAIN = 'test.coclaw.net';

const { genTurnCreds, genTurnCredsForGateway, turnRouter } = await import('./turn.route.js');

// --- genTurnCreds 纯函数测试 ---

test('genTurnCreds: 返回正确结构', () => {
	const creds = genTurnCreds('user42', 'my-secret');
	assert.ok(creds.username.endsWith(':user42'));
	assert.equal(typeof creds.credential, 'string');
	assert.equal(creds.ttl, 86400);
	assert.ok(Array.isArray(creds.urls));
	assert.equal(creds.urls.length, 2);
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

test('genTurnCreds: urls 默认使用 APP_DOMAIN', () => {
	delete process.env.TURN_DOMAIN;
	const creds = genTurnCreds('u', 'secret');
	for (const url of creds.urls) {
		assert.ok(url.includes('test.coclaw.net'), `url should contain domain: ${url}`);
	}
});

test('genTurnCreds: urls 使用 TURN_DOMAIN（优先于 APP_DOMAIN）', () => {
	process.env.TURN_DOMAIN = 'edge.test.net';
	try {
		const creds = genTurnCreds('u', 'secret');
		assert.equal(creds.urls.length, 2);
		for (const url of creds.urls) {
			assert.ok(url.includes('edge.test.net'), `url should use TURN_DOMAIN: ${url}`);
		}
	} finally {
		delete process.env.TURN_DOMAIN;
	}
});

test('genTurnCreds: urls 默认使用 3478 端口', () => {
	delete process.env.TURN_PORT;
	delete process.env.TURN_TLS_PORT;
	const creds = genTurnCreds('u', 'secret');
	for (const url of creds.urls) {
		assert.ok(url.includes(':3478'), `url should contain :3478: ${url}`);
	}
});

test('genTurnCreds: urls 使用自定义 TURN_PORT', () => {
	process.env.TURN_PORT = '5349';
	delete process.env.TURN_TLS_PORT;
	try {
		const creds = genTurnCreds('u', 'secret');
		for (const url of creds.urls) {
			assert.ok(url.includes(':5349'), `url should contain :5349: ${url}`);
		}
	} finally {
		delete process.env.TURN_PORT;
	}
});

test('genTurnCreds: 默认模式生成 turn/udp + turn/tcp', () => {
	delete process.env.TURN_TLS_PORT;
	const creds = genTurnCreds('u', 'secret');
	assert.equal(creds.urls.length, 2);
	assert.ok(creds.urls[0].startsWith('turn:'));
	assert.ok(creds.urls[0].includes('transport=udp'));
	assert.ok(creds.urls[1].startsWith('turn:'));
	assert.ok(creds.urls[1].includes('transport=tcp'));
});

test('genTurnCreds: TLS 模式生成 turn/udp + turn/tcp + turns/tcp', () => {
	process.env.TURN_TLS_PORT = '443';
	try {
		const creds = genTurnCreds('u', 'secret');
		assert.equal(creds.urls.length, 3);
		assert.ok(creds.urls[0].includes('transport=udp'));
		assert.ok(creds.urls[1].startsWith('turn:'));
		assert.ok(creds.urls[1].includes('transport=tcp'));
		assert.ok(creds.urls[2].startsWith('turns:'));
		assert.ok(creds.urls[2].includes(':443'));
	} finally {
		delete process.env.TURN_TLS_PORT;
	}
});

test('genTurnCredsForGateway: 过滤 turns: URL（兼容旧版 plugin）', () => {
	process.env.TURN_TLS_PORT = '443';
	try {
		const creds = genTurnCredsForGateway('u', 'secret');
		assert.equal(creds.urls.length, 2);
		assert.ok(creds.urls.every(u => !u.startsWith('turns:')));
		assert.ok(creds.urls[0].includes('transport=udp'));
		assert.ok(creds.urls[1].includes('transport=tcp'));
	} finally {
		delete process.env.TURN_TLS_PORT;
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
	assert.equal(res.body.urls.length, 2);
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
