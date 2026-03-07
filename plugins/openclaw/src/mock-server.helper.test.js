import assert from 'node:assert/strict';
import test from 'node:test';

import { createMockServer } from './mock-server.helper.js';

async function request(url, options = {}) {
	const res = await fetch(url, options);
	return { status: res.status, json: await res.json() };
}

test('mock-server helper should cover bind/unbind and not found branches', async () => {
	const mock = await createMockServer();
	try {
		const badBind = await request(`${mock.baseUrl}/api/v1/bots/bind`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({}),
		});
		assert.equal(badBind.status, 400);
		assert.equal(badBind.json.code, 'INVALID_INPUT');

		const goodBind = await request(`${mock.baseUrl}/api/v1/bots/bind`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ code: '12345678' }),
		});
		assert.equal(goodBind.status, 200);

		const badUnbind = await request(`${mock.baseUrl}/api/v1/bots/unbind`, {
			method: 'POST',
			headers: { authorization: 'Bearer wrong' },
		});
		assert.equal(badUnbind.status, 401);

		const goodUnbind = await request(`${mock.baseUrl}/api/v1/bots/unbind`, {
			method: 'POST',
			headers: { authorization: 'Bearer mock-token-1' },
		});
		assert.equal(goodUnbind.status, 200);

		const notFound = await request(`${mock.baseUrl}/unknown`);
		assert.equal(notFound.status, 404);
	}
	finally {
		await mock.close();
	}
});
