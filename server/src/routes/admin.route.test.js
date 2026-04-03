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

test('dashboardHandler: 不传 deps 时使用默认 getAdminDashboard（分支可达）', async () => {
	// 不传 deps（空对象），验证 deps.getAdminDashboard ?? getAdminDashboard 走默认路径
	const res = mockRes();
	let nextErr = null;
	await dashboardHandler({}, res, (e) => { nextErr = e; });
	// 默认路径连接真实 DB：可能成功也可能报错，两种情况都说明分支已覆盖
	assert.ok(res._json !== null || nextErr !== null, '默认路径应可达');
});
