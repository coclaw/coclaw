import assert from 'node:assert/strict';
import test from 'node:test';

import { getAdminDashboard } from './admin-dashboard.svc.js';

function mockRepo(overrides = {}) {
	return {
		countUsers: async () => overrides.total ?? 100,
		countUsersCreatedSince: async () => overrides.todayNew ?? 5,
		countUsersActiveSince: async () => overrides.todayActive ?? 20,
		topActiveUsers: async () => overrides.topActive ?? [
			{ id: '1', name: 'Alice', lastLoginAt: '2026-03-23T10:00:00Z', botCount: 2, botIds: ['10', '11'] },
		],
		countBots: async () => overrides.botsTotal ?? 8,
		countBotsCreatedSince: async () => overrides.todayNewBots ?? 3,
		listBots: async () => overrides.botList ?? [
			{ id: '10', name: 'Bot-A', lastSeenAt: '2026-03-25T12:00:00Z', createdAt: '2026-03-01T00:00:00Z', userId: '1', userName: 'Alice', userLoginName: 'alice' },
		],
	};
}

test('getAdminDashboard: 返回正确的汇总结构', async () => {
	const onlineIds = new Set(['10']);
	const result = await getAdminDashboard({
		repo: mockRepo(),
		getOnlineBotIds: () => onlineIds,
		getOnlineBotCount: () => 1,
	});

	assert.equal(result.users.total, 100);
	assert.equal(result.users.todayNew, 5);
	assert.equal(result.users.todayActive, 20);
	assert.equal(result.topActiveUsers.length, 1);
	assert.equal(result.topActiveUsers[0].name, 'Alice');
	assert.equal(result.topActiveUsers[0].onlineBotCount, 1);
	assert.equal(result.bots.total, 8);
	assert.equal(result.bots.todayNew, 3);
	assert.equal(result.bots.online, 1);
	assert.equal(result.bots.list.length, 1);
	assert.equal(result.bots.list[0].name, 'Bot-A');
	assert.equal(result.bots.list[0].isOnline, true);
	assert.equal(typeof result.version.server, 'string');
	assert.ok(result.version.server.length > 0);
	assert.equal(typeof result.version.plugin, 'string');
	assert.ok(result.version.plugin.length > 0);
});

test('getAdminDashboard: plugin version 可为 null', async () => {
	const result = await getAdminDashboard({
		repo: mockRepo(),
		getOnlineBotIds: () => new Set(),
		getOnlineBotCount: () => 0,
	});
	// pluginVersion 从模块顶层读取，在测试环境中可能为 null 或 string
	assert.ok(result.version.plugin === null || typeof result.version.plugin === 'string');
});

test('getAdminDashboard: 自定义数据正确透传', async () => {
	const result = await getAdminDashboard({
		repo: mockRepo({ total: 50, todayNew: 2, todayActive: 10, botsTotal: 0, todayNewBots: 0, topActive: [], botList: [] }),
		getOnlineBotIds: () => new Set(),
		getOnlineBotCount: () => 0,
	});

	assert.equal(result.users.total, 50);
	assert.equal(result.users.todayNew, 2);
	assert.equal(result.users.todayActive, 10);
	assert.deepEqual(result.topActiveUsers, []);
	assert.equal(result.bots.total, 0);
	assert.equal(result.bots.todayNew, 0);
	assert.equal(result.bots.online, 0);
	assert.deepEqual(result.bots.list, []);
});

test('getAdminDashboard: 并行调用所有 repo 方法', async () => {
	const calls = [];
	const repo = {
		countUsers: async () => { calls.push('countUsers'); return 0; },
		countUsersCreatedSince: async () => { calls.push('countUsersCreatedSince'); return 0; },
		countUsersActiveSince: async () => { calls.push('countUsersActiveSince'); return 0; },
		topActiveUsers: async () => { calls.push('topActiveUsers'); return []; },
		countBots: async () => { calls.push('countBots'); return 0; },
		countBotsCreatedSince: async () => { calls.push('countBotsCreatedSince'); return 0; },
		listBots: async () => { calls.push('listBots'); return []; },
	};

	await getAdminDashboard({ repo, getOnlineBotIds: () => new Set(), getOnlineBotCount: () => 0 });

	assert.equal(calls.length, 7);
	assert.ok(calls.includes('countUsers'));
	assert.ok(calls.includes('countUsersCreatedSince'));
	assert.ok(calls.includes('countUsersActiveSince'));
	assert.ok(calls.includes('topActiveUsers'));
	assert.ok(calls.includes('countBots'));
	assert.ok(calls.includes('countBotsCreatedSince'));
	assert.ok(calls.includes('listBots'));
});
