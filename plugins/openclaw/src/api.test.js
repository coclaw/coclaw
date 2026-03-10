import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { bindWithServer, unbindWithServer } from './api.js';

async function withServer(handler) {
	const server = http.createServer(handler);
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

test('api methods should call fetch with expected routes and timeouts', async () => {
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
		assert.ok(calls[0][1].signal, 'bind should have AbortSignal');

		const u = await unbindWithServer({ baseUrl: 'http://x', token: 't1' });
		assert.equal(u.ok, true);
		assert.ok(calls[1][1].signal, 'unbind should have AbortSignal');

		// 自定义 timeout
		await unbindWithServer({ baseUrl: 'http://x', token: 't2', timeout: 5000 });
		assert.ok(calls[2][1].signal, 'custom timeout should have AbortSignal');

		assert.equal(calls.length, 3);
	}
	finally {
		globalThis.fetch = oldFetch;
	}
});

test('unbindWithServer should abort when timeout expires', async () => {
	const server = await withServer((_req, _res) => {
		// 故意不响应，让请求挂起直到 timeout
		// 保持连接打开
	});

	try {
		await assert.rejects(
			() => unbindWithServer({ baseUrl: server.baseUrl, token: 'tk', timeout: 200 }),
			(err) => {
				// AbortSignal.timeout() 抛出 TimeoutError (DOMException name)
				assert.equal(err.name, 'TimeoutError');
				return true;
			},
		);
	} finally {
		await server.close();
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
