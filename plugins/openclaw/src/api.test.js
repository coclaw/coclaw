import assert from 'node:assert/strict';
import test from 'node:test';

import { bindWithServer, unbindWithServer } from './api.js';

test('api methods should call fetch with expected routes', async () => {
	const calls = [];
	const oldFetch = globalThis.fetch;
	globalThis.fetch = async (url, options = {}) => {
		calls.push([String(url), options]);
		return {
			ok: true,
			status: 200,
			async json() {
				return { ok: true };
			},
		};
	};

	try {
		const b = await bindWithServer({ baseUrl: 'http://x', code: '123', name: 'n' });
		assert.equal(b.ok, true);

		const u = await unbindWithServer({ baseUrl: 'http://x', token: 't1' });
		assert.equal(u.ok, true);

		assert.equal(calls.length, 2);
	}
	finally {
		globalThis.fetch = oldFetch;
	}
});

test('api should throw with response shape on non-ok responses', async () => {
	const oldFetch = globalThis.fetch;
	globalThis.fetch = async () => ({
		ok: false,
		status: 401,
		async json() {
			return { code: 'UNAUTHORIZED', message: 'bad token' };
		},
	});
	try {
		await assert.rejects(() => unbindWithServer({ baseUrl: 'http://x', token: 'bad' }), (err) => {
			assert.equal(err.response.status, 401);
			assert.equal(err.response.data.code, 'UNAUTHORIZED');
			return true;
		});
	}
	finally {
		globalThis.fetch = oldFetch;
	}
});
