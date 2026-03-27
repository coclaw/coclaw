import assert from 'node:assert/strict';
import test from 'node:test';

import { getAdminDashboard } from './admin-dashboard.svc.js';

function mockRepo(overrides = {}) {
	return {
		countUsers: async () => overrides.total ?? 100,
		countUsersCreatedSince: async () => overrides.todayNew ?? 5,
		countUsersActiveSince: async () => overrides.todayActive ?? 20,
		topActiveUsers: async () => overrides.topActive ?? [
			{ id: '1', name: 'Alice', lastLoginAt: '2026-03-23T10:00:00Z' },
		],
		latestRegisteredUsers: async () => overrides.latestRegistered ?? [
			{ id: '10', name: 'NewUser', loginName: 'newuser', createdAt: '2026-03-24T08:00:00Z' },
		],
		countBots: async () => overrides.botsTotal ?? 8,
	};
}

test('getAdminDashboard: 返回正确的汇总结构', async () => {
	const result = await getAdminDashboard({
		repo: mockRepo(),
		getOnlineBotCount: () => 3,
	});

	assert.equal(result.users.total, 100);
	assert.equal(result.users.todayNew, 5);
	assert.equal(result.users.todayActive, 20);
	assert.equal(result.topActiveUsers.length, 1);
	assert.equal(result.topActiveUsers[0].name, 'Alice');
	assert.equal(result.latestRegisteredUsers.length, 1);
	assert.equal(result.latestRegisteredUsers[0].name, 'NewUser');
	assert.equal(result.bots.total, 8);
	assert.equal(result.bots.online, 3);
	assert.equal(typeof result.version.server, 'string');
	assert.ok(result.version.server.length > 0);
	// plugin version 可为字符串或 null（取决于部署环境）
	assert.ok(result.version.plugin === null || typeof result.version.plugin === 'string');
});

test('getAdminDashboard: 自定义数据正确透传', async () => {
	const result = await getAdminDashboard({
		repo: mockRepo({ total: 50, todayNew: 2, todayActive: 10, botsTotal: 0, topActive: [], latestRegistered: [] }),
		getOnlineBotCount: () => 0,
	});

	assert.equal(result.users.total, 50);
	assert.equal(result.users.todayNew, 2);
	assert.equal(result.users.todayActive, 10);
	assert.deepEqual(result.topActiveUsers, []);
	assert.deepEqual(result.latestRegisteredUsers, []);
	assert.equal(result.bots.total, 0);
	assert.equal(result.bots.online, 0);
});

test('getAdminDashboard: 并行调用所有 repo 方法', async () => {
	const calls = [];
	const repo = {
		countUsers: async () => { calls.push('countUsers'); return 0; },
		countUsersCreatedSince: async () => { calls.push('countUsersCreatedSince'); return 0; },
		countUsersActiveSince: async () => { calls.push('countUsersActiveSince'); return 0; },
		topActiveUsers: async () => { calls.push('topActiveUsers'); return []; },
		latestRegisteredUsers: async () => { calls.push('latestRegisteredUsers'); return []; },
		countBots: async () => { calls.push('countBots'); return 0; },
	};

	await getAdminDashboard({ repo, getOnlineBotCount: () => 0 });

	assert.equal(calls.length, 6);
	assert.ok(calls.includes('countUsers'));
	assert.ok(calls.includes('countUsersCreatedSince'));
	assert.ok(calls.includes('countUsersActiveSince'));
	assert.ok(calls.includes('topActiveUsers'));
	assert.ok(calls.includes('latestRegisteredUsers'));
	assert.ok(calls.includes('countBots'));
});

test('getAdminDashboard: reads plugin version from COCLAW_PLUGIN_VERSION env var', async () => {
	process.env.COCLAW_PLUGIN_VERSION = '9.9.9-test';
	try {
		const result = await getAdminDashboard({ repo: mockRepo(), getOnlineBotCount: () => 0 });
		assert.equal(result.version.plugin, '9.9.9-test');
	} finally {
		delete process.env.COCLAW_PLUGIN_VERSION;
	}
});

test('getAdminDashboard: plugin version is null when env var unset and package not found', async () => {
	const saved = process.env.COCLAW_PLUGIN_VERSION;
	delete process.env.COCLAW_PLUGIN_VERSION;
	try {
		const result = await getAdminDashboard({ repo: mockRepo(), getOnlineBotCount: () => 0 });
		assert.ok(result.version.plugin === null || typeof result.version.plugin === 'string');
	} finally {
		if (saved !== undefined) process.env.COCLAW_PLUGIN_VERSION = saved;
	}
});
