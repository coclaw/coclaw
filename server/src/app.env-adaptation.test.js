import test from 'node:test';
import assert from 'node:assert/strict';

import request from 'supertest';

import { createApp } from './app.js';

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
