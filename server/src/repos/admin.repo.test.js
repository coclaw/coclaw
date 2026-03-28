import assert from 'node:assert/strict';
import test from 'node:test';

import {
	countUsers,
	countUsersCreatedSince,
	countUsersActiveSince,
	topActiveUsers,
	countBots,
	countBotsCreatedSince,
	listBots,
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
				{ id: 123456789n, name: 'Alice', lastLoginAt: new Date('2026-03-20'), bots: [{ id: 1n }, { id: 2n }] },
				{ id: 987654321n, name: 'Bob', lastLoginAt: new Date('2026-03-19'), bots: [] },
			],
		},
	};

	const result = await topActiveUsers(5, db);

	assert.equal(result.length, 2);
	assert.equal(result[0].id, '123456789');
	assert.equal(typeof result[0].id, 'string');
	assert.equal(result[0].botCount, 2);
	assert.deepEqual(result[0].botIds, ['1', '2']);
	assert.equal(result[1].name, 'Bob');
	assert.equal(result[1].botCount, 0);
	assert.deepEqual(result[1].botIds, []);
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
		select: { id: true, name: true, lastLoginAt: true, localAuth: { select: { loginName: true } }, bots: { select: { id: true } } },
	});
});

test('countBots: 调用 prisma.bot.count()', async () => {
	const db = { bot: { count: async () => 7 } };
	assert.equal(await countBots(db), 7);
});

test('countBotsCreatedSince: 传递 gte 条件', async () => {
	const since = new Date('2026-03-26');
	let captured = null;
	const db = {
		bot: {
			count: async (args) => { captured = args; return 2; },
		},
	};

	const result = await countBotsCreatedSince(since, db);

	assert.equal(result, 2);
	assert.deepEqual(captured, { where: { createdAt: { gte: since } } });
});

test('listBots: 返回字段完整性，含所属用户', async () => {
	const db = {
		bot: {
			findMany: async () => [
				{
					id: 100n, name: 'Bot-A', lastSeenAt: new Date('2026-03-25'), createdAt: new Date('2026-03-01'),
					user: { id: 1n, name: 'Alice', localAuth: { loginName: 'alice' } },
				},
				{
					id: 200n, name: null, lastSeenAt: null, createdAt: new Date('2026-03-20'),
					user: { id: 2n, name: 'Bob', localAuth: null },
				},
			],
		},
	};

	const result = await listBots(50, db);

	assert.equal(result.length, 2);
	assert.equal(result[0].id, '100');
	assert.equal(result[0].name, 'Bot-A');
	assert.equal(result[0].userId, '1');
	assert.equal(result[0].userName, 'Alice');
	assert.equal(result[0].userLoginName, 'alice');
	assert.equal(result[1].id, '200');
	assert.equal(result[1].name, null);
	assert.equal(result[1].userLoginName, null);
});

test('listBots: 传递正确的查询参数', async () => {
	let captured = null;
	const db = {
		bot: {
			findMany: async (args) => { captured = args; return []; },
		},
	};

	await listBots(10, db);

	assert.deepEqual(captured, {
		orderBy: { lastSeenAt: 'desc' },
		take: 10,
		select: {
			id: true, name: true, lastSeenAt: true, createdAt: true,
			user: { select: { id: true, name: true, localAuth: { select: { loginName: true } } } },
		},
	});
});
