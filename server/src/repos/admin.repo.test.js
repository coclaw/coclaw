import assert from 'node:assert/strict';
import test from 'node:test';

import {
	countUsers,
	countUsersCreatedSince,
	countUsersActiveSince,
	topActiveUsers,
	latestRegisteredUsers,
	countBots,
} from './admin.repo.js';

test('countUsers: 调用 prisma.user.count()', async () => {
	const db = { user: { count: async () => 10 } };
	assert.equal(await countUsers(db), 10);
});

test('countUsersCreatedSince: 传递 gte 条件', async () => {
	const since = new Date('2026-01-01');
	let captured = null;
	const db = {
		user: {
			count: async (args) => { captured = args; return 3; },
		},
	};

	const result = await countUsersCreatedSince(since, db);

	assert.equal(result, 3);
	assert.deepEqual(captured, { where: { createdAt: { gte: since } } });
});

test('countUsersActiveSince: 传递 lastLoginAt gte 条件', async () => {
	const since = new Date('2026-03-01');
	let captured = null;
	const db = {
		user: {
			count: async (args) => { captured = args; return 5; },
		},
	};

	const result = await countUsersActiveSince(since, db);

	assert.equal(result, 5);
	assert.deepEqual(captured, { where: { lastLoginAt: { gte: since } } });
});

test('topActiveUsers: 返回结果并将 BigInt id 转为 string', async () => {
	const db = {
		user: {
			findMany: async () => [
				{ id: 123456789n, name: 'Alice', lastLoginAt: new Date('2026-03-20') },
				{ id: 987654321n, name: 'Bob', lastLoginAt: new Date('2026-03-19') },
			],
		},
	};

	const result = await topActiveUsers(5, db);

	assert.equal(result.length, 2);
	assert.equal(result[0].id, '123456789');
	assert.equal(typeof result[0].id, 'string');
	assert.equal(result[1].name, 'Bob');
});

test('topActiveUsers: 传递正确的查询参数', async () => {
	let captured = null;
	const db = {
		user: {
			findMany: async (args) => { captured = args; return []; },
		},
	};

	await topActiveUsers(3, db);

	assert.deepEqual(captured, {
		where: { lastLoginAt: { not: null } },
		orderBy: { lastLoginAt: 'desc' },
		take: 3,
		select: { id: true, name: true, lastLoginAt: true, localAuth: { select: { loginName: true } } },
	});
});

test('countBots: 调用 prisma.bot.count()', async () => {
	const db = { bot: { count: async () => 7 } };
	assert.equal(await countBots(db), 7);
});

test('latestRegisteredUsers: 返回结果并将 BigInt id 转为 string', async () => {
	const db = {
		user: {
			findMany: async () => [
				{ id: 111n, name: 'Carol', createdAt: new Date('2026-03-24'), localAuth: { loginName: 'carol' } },
				{ id: 222n, name: 'Dave', createdAt: new Date('2026-03-23'), localAuth: null },
			],
		},
	};

	const result = await latestRegisteredUsers(5, db);

	assert.equal(result.length, 2);
	assert.equal(result[0].id, '111');
	assert.equal(result[0].name, 'Carol');
	assert.equal(result[0].loginName, 'carol');
	assert.equal(result[1].id, '222');
	assert.equal(result[1].loginName, null);
});

test('latestRegisteredUsers: 传递正确的查询参数', async () => {
	let captured = null;
	const db = {
		user: {
			findMany: async (args) => { captured = args; return []; },
		},
	};

	await latestRegisteredUsers(10, db);

	assert.deepEqual(captured, {
		orderBy: { createdAt: 'desc' },
		take: 10,
		select: { id: true, name: true, createdAt: true, localAuth: { select: { loginName: true } } },
	});
});
