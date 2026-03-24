import assert from 'node:assert/strict';
import test from 'node:test';

import { dashboardHandler } from './admin.route.js';

function mockRes() {
	const res = {
		_json: null,
		json(body) { res._json = body; return res; },
	};
	return res;
}

test('dashboardHandler: 正常返回 dashboard 数据', async () => {
	const fakeData = { users: { total: 10 }, bots: { total: 2 } };
	const res = mockRes();

	await dashboardHandler({}, res, () => {}, {
		getAdminDashboard: async () => fakeData,
	});

	assert.deepEqual(res._json, fakeData);
});

test('dashboardHandler: service 抛错时调用 next', async () => {
	const err = new Error('boom');
	let nextErr = null;

	await dashboardHandler({}, mockRes(), (e) => { nextErr = e; }, {
		getAdminDashboard: async () => { throw err; },
	});

	assert.equal(nextErr, err);
});
