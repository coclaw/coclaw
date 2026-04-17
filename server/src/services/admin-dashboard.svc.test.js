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
		countClaws: async () => overrides.clawsTotal ?? 8,
		countClawsCreatedSince: async () => overrides.clawsTodayNew ?? 2,
		latestBoundClaws: async () => overrides.latestBoundClaws ?? [
			{ id: '100', name: 'clawA', userName: 'Alice', createdAt: '2026-04-10T00:00:00Z' },
			{ id: '101', name: 'clawB', userName: 'Bob', createdAt: '2026-04-09T00:00:00Z' },
		],
	};
}

test('getAdminDashboard: 返回实例维度 + 用户维度结构', async () => {
	const result = await getAdminDashboard({
		repo: mockRepo(),
		listOnlineClawIds: () => new Set(['100']),
		getLatestPluginVersion: () => '0.15.2',
	});

	assert.deepEqual(result.users, { total: 100, todayNew: 5, todayActive: 20 });
	assert.deepEqual(result.claws, { total: 8, online: 1, todayNew: 2 });
	assert.equal(result.topActiveUsers.length, 1);
	assert.equal(result.topActiveUsers[0].name, 'Alice');
	assert.equal(result.latestRegisteredUsers.length, 1);
	assert.equal(result.latestRegisteredUsers[0].name, 'NewUser');
	assert.equal(result.latestBoundClaws.length, 2);
	assert.equal(result.latestBoundClaws[0].id, '100');
	assert.equal(result.latestBoundClaws[0].online, true);
	assert.equal(result.latestBoundClaws[1].online, false);
	assert.equal('bots' in result, false);
	assert.equal(typeof result.version.server, 'string');
	assert.ok(result.version.server.length > 0);
	assert.equal(result.version.plugin, '0.15.2');
});

test('getAdminDashboard: 插件版本缓存未就绪时返回 null', async () => {
	const result = await getAdminDashboard({
		repo: mockRepo(),
		listOnlineClawIds: () => new Set(),
		getLatestPluginVersion: () => null,
	});
	assert.equal(result.version.plugin, null);
});

test('getAdminDashboard: 自定义数据正确透传且 online 集合为空', async () => {
	const result = await getAdminDashboard({
		repo: mockRepo({
			total: 50, todayNew: 2, todayActive: 10,
			clawsTotal: 0, clawsTodayNew: 0,
			topActive: [], latestRegistered: [], latestBoundClaws: [],
		}),
		listOnlineClawIds: () => new Set(),
	});

	assert.deepEqual(result.users, { total: 50, todayNew: 2, todayActive: 10 });
	assert.deepEqual(result.claws, { total: 0, online: 0, todayNew: 0 });
	assert.deepEqual(result.topActiveUsers, []);
	assert.deepEqual(result.latestRegisteredUsers, []);
	assert.deepEqual(result.latestBoundClaws, []);
});

test('getAdminDashboard: 使用默认 deps 时不抛异常', async () => {
	// 覆盖 默认 repo 和 listOnlineClawIds 分支（默认依赖路径）
	const result = await getAdminDashboard({ repo: mockRepo() });

	assert.equal(result.users.total, 100);
	assert.equal(typeof result.claws.online, 'number');
	assert.ok('plugin' in result.version);
});

test('getAdminDashboard: 并行调用所有 repo 方法', async () => {
	const calls = [];
	const repo = {
		countUsers: async () => { calls.push('countUsers'); return 0; },
		countUsersCreatedSince: async () => { calls.push('countUsersCreatedSince'); return 0; },
		countUsersActiveSince: async () => { calls.push('countUsersActiveSince'); return 0; },
		topActiveUsers: async () => { calls.push('topActiveUsers'); return []; },
		latestRegisteredUsers: async () => { calls.push('latestRegisteredUsers'); return []; },
		countClaws: async () => { calls.push('countClaws'); return 0; },
		countClawsCreatedSince: async () => { calls.push('countClawsCreatedSince'); return 0; },
		latestBoundClaws: async () => { calls.push('latestBoundClaws'); return []; },
	};

	await getAdminDashboard({ repo, listOnlineClawIds: () => new Set() });

	assert.equal(calls.length, 8);
	assert.ok(calls.includes('countUsers'));
	assert.ok(calls.includes('countUsersCreatedSince'));
	assert.ok(calls.includes('countUsersActiveSince'));
	assert.ok(calls.includes('topActiveUsers'));
	assert.ok(calls.includes('latestRegisteredUsers'));
	assert.ok(calls.includes('countClaws'));
	assert.ok(calls.includes('countClawsCreatedSince'));
	assert.ok(calls.includes('latestBoundClaws'));
});

test('getAdminDashboard: topActiveUsers / latestRegisteredUsers 请求 10 条', async () => {
	const captured = {};
	const repo = {
		countUsers: async () => 0,
		countUsersCreatedSince: async () => 0,
		countUsersActiveSince: async () => 0,
		topActiveUsers: async (n) => { captured.topActive = n; return []; },
		latestRegisteredUsers: async (n) => { captured.latestRegistered = n; return []; },
		countClaws: async () => 0,
		countClawsCreatedSince: async () => 0,
		latestBoundClaws: async (n) => { captured.latestBoundClaws = n; return []; },
	};

	await getAdminDashboard({ repo, listOnlineClawIds: () => new Set() });

	assert.equal(captured.topActive, 10);
	assert.equal(captured.latestRegistered, 10);
	assert.equal(captured.latestBoundClaws, 10);
});
