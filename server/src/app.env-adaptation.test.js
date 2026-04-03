import test from 'node:test';
import assert from 'node:assert/strict';

import request from 'supertest';

import { createApp, globalErrorHandler } from './app.js';

function withEnv(patch, fn) {
	const keys = Object.keys(patch);
	const prev = new Map(keys.map((key) => [key, process.env[key]]));
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) {
			delete process.env[key];
		}
		else {
			process.env[key] = value;
		}
	}
	try {
		return fn();
	}
	finally {
		for (const key of keys) {
			const value = prev.get(key);
			if (value === undefined) {
				delete process.env[key];
			}
			else {
				process.env[key] = value;
			}
		}
	}
}

test('production should reject default SESSION_SECRET', () => {
	withEnv({
		NODE_ENV: 'production',
		SESSION_SECRET: 'coclaw-dev-session-secret',
	}, () => {
		assert.throws(() => createApp(), /SESSION_SECRET is required in production/);
	});
});

test('production should allow /healthz while HTTPS guard is on', async () => {
	await withEnv({
		NODE_ENV: 'production',
		SESSION_SECRET: 'strong-production-secret',
		ENFORCE_HTTPS: 'true',
	}, async () => {
		const app = createApp();
		const res = await request(app).get('/healthz');
		assert.equal(res.status, 200);
		assert.equal(res.body?.ok, true);
	});
});

test('production should reject non-https API request when HTTPS guard is on', async () => {
	await withEnv({
		NODE_ENV: 'production',
		SESSION_SECRET: 'strong-production-secret',
		ENFORCE_HTTPS: 'true',
	}, async () => {
		const app = createApp();
		const res = await request(app).get('/api/v1/auth/session');
		assert.equal(res.status, 426);
		assert.equal(res.body?.code, 'HTTPS_REQUIRED');
	});
});

test('production should allow forwarded https request behind proxy', async () => {
	await withEnv({
		NODE_ENV: 'production',
		SESSION_SECRET: 'strong-production-secret',
		ENFORCE_HTTPS: 'true',
	}, async () => {
		const app = createApp();
		const res = await request(app)
			.get('/api/v1/auth/session')
			.set('X-Forwarded-Proto', 'https');
		assert.equal(res.status, 200);
		assert.equal(res.body?.user, null);
	});
});

test('development should not enforce HTTPS by default', async () => {
	await withEnv({
		NODE_ENV: 'development',
		SESSION_SECRET: 'coclaw-dev-session-secret',
		ENFORCE_HTTPS: undefined,
	}, async () => {
		const app = createApp();
		const res = await request(app).get('/api/v1/auth/session');
		assert.equal(res.status, 200);
		assert.equal(res.body?.user, null);
	});
});

test('development CORS allows localhost origins', async () => {
	await withEnv({
		NODE_ENV: 'development',
		SESSION_SECRET: 'coclaw-dev-session-secret',
	}, async () => {
		const app = createApp();
		const res = await request(app)
			.get('/api/v1/auth/session')
			.set('Origin', 'http://localhost:5173');
		assert.equal(res.status, 200);
		assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:5173');
	});
});

test('CORS rejects unknown origin in production', async () => {
	await withEnv({
		NODE_ENV: 'production',
		SESSION_SECRET: 'strong-production-secret',
		ENFORCE_HTTPS: 'false',
		ALLOWED_ORIGINS: 'https://app.coclaw.net',
	}, async () => {
		const app = createApp();
		const res = await request(app)
			.get('/healthz')
			.set('Origin', 'https://evil.example.com');
		// CORS 头不设置，但请求仍然被处理（CORS 由浏览器拦截）
		assert.equal(res.headers['access-control-allow-origin'], undefined);
	});
});

test('CORS allows capacitor://localhost origin', async () => {
	await withEnv({
		NODE_ENV: 'production',
		SESSION_SECRET: 'strong-production-secret',
		ENFORCE_HTTPS: 'false',
	}, async () => {
		const app = createApp();
		const res = await request(app)
			.get('/healthz')
			.set('Origin', 'capacitor://localhost');
		assert.equal(res.headers['access-control-allow-origin'], 'capacitor://localhost');
	});
});


test('globalErrorHandler: 返回 500 + INTERNAL_SERVER_ERROR', () => {
	const origError = console.error;
	console.error = () => {};
	try {
		const res = {
			statusCode: null,
			body: null,
			status(code) { this.statusCode = code; return this; },
			json(payload) { this.body = payload; return this; },
		};
		globalErrorHandler(new Error('boom'), {}, res, () => {});
		assert.equal(res.statusCode, 500);
		assert.equal(res.body.code, 'INTERNAL_SERVER_ERROR');
		assert.equal(res.body.message, 'Internal server error');
	} finally {
		console.error = origError;
	}
});

test('production ENFORCE_HTTPS=false should not enforce HTTPS', async () => {
	await withEnv({
		NODE_ENV: 'production',
		SESSION_SECRET: 'strong-production-secret',
		ENFORCE_HTTPS: 'false',
	}, async () => {
		const app = createApp();
		const res = await request(app).get('/api/v1/auth/session');
		assert.equal(res.status, 200);
	});
});
