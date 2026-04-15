import assert from 'node:assert/strict';
import test from 'node:test';

import {
	countUsers,
	countUsersCreatedSince,
	countUsersActiveSince,
	topActiveUsers,
	latestRegisteredUsers,
	countClaws,
	countClawsCreatedSince,
	latestBoundClaws,
	listClawsPaginated,
	listUsersPaginated,
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

test('countClaws: 调用 prisma.claw.count()', async () => {
	const db = { claw: { count: async () => 7 } };
	assert.equal(await countClaws(db), 7);
});

test('countClawsCreatedSince: 传递 gte 条件', async () => {
	const since = new Date('2026-04-01');
	let captured = null;
	const db = {
		claw: {
			count: async (args) => { captured = args; return 4; },
		},
	};

	const result = await countClawsCreatedSince(since, db);

	assert.equal(result, 4);
	assert.deepEqual(captured, { where: { createdAt: { gte: since } } });
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

test('latestBoundClaws: 返回结果并映射 user.name', async () => {
	const db = {
		claw: {
			findMany: async () => [
				{ id: 10n, name: 'clawA', createdAt: new Date('2026-04-10'), user: { name: 'Alice' } },
				{ id: 20n, name: null, createdAt: new Date('2026-04-09'), user: { name: null } },
				{ id: 30n, name: 'clawC', createdAt: new Date('2026-04-08'), user: null },
			],
		},
	};

	const result = await latestBoundClaws(10, db);

	assert.equal(result.length, 3);
	assert.deepEqual(result[0], {
		id: '10', name: 'clawA', userName: 'Alice', createdAt: new Date('2026-04-10'),
	});
	assert.equal(result[1].userName, null);
	assert.equal(result[2].userName, null);
});

test('latestBoundClaws: 传递正确的查询参数', async () => {
	let captured = null;
	const db = {
		claw: {
			findMany: async (args) => { captured = args; return []; },
		},
	};

	await latestBoundClaws(10, db);

	assert.deepEqual(captured, {
		orderBy: { createdAt: 'desc' },
		take: 10,
		select: {
			id: true,
			name: true,
			createdAt: true,
			user: { select: { name: true } },
		},
	});
});

// --- listClawsPaginated ---

function makeClaw(id, over = {}) {
	return {
		id: BigInt(id),
		name: `claw-${id}`,
		hostName: `host-${id}`,
		pluginVersion: '0.14.0',
		agentModels: [{ id: 'main', name: 'Main', model: 'opus' }],
		createdAt: new Date('2026-04-10'),
		lastSeenAt: new Date('2026-04-15'),
		user: {
			id: BigInt(1000 + Number(id)),
			name: `user-${id}`,
			localAuth: { loginName: `ln-${id}` },
		},
		...over,
	};
}

test('listClawsPaginated: 基础调用返回 items + nextCursor null', async () => {
	let captured = null;
	const db = {
		claw: {
			findMany: async (q) => { captured = q; return [makeClaw(1), makeClaw(2)]; },
		},
	};

	const result = await listClawsPaginated({ limit: 50 }, db);

	assert.equal(captured.take, 51);
	assert.equal(captured.cursor, undefined);
	assert.equal(captured.skip, undefined);
	assert.deepEqual(captured.orderBy, { id: 'desc' });
	assert.equal(captured.where, undefined);
	assert.equal(result.items.length, 2);
	assert.equal(result.items[0].id, '1');
	assert.equal(result.items[0].userId, '1001');
	assert.equal(result.items[0].userName, 'user-1');
	assert.equal(result.items[0].userLoginName, 'ln-1');
	assert.deepEqual(result.items[0].agentModels, [{ id: 'main', name: 'Main', model: 'opus' }]);
	assert.equal(result.nextCursor, null);
});

test('listClawsPaginated: 返回超过 limit 时截断并生成 nextCursor', async () => {
	const db = {
		claw: {
			findMany: async () => [makeClaw(1), makeClaw(2), makeClaw(3)],
		},
	};

	const result = await listClawsPaginated({ limit: 2 }, db);

	assert.equal(result.items.length, 2);
	assert.equal(result.nextCursor, '2');
});

test('listClawsPaginated: 传入 cursor 时设置 skip=1', async () => {
	let captured = null;
	const db = {
		claw: {
			findMany: async (q) => { captured = q; return []; },
		},
	};

	await listClawsPaginated({ cursor: '100', limit: 10 }, db);

	assert.deepEqual(captured.cursor, { id: 100n });
	assert.equal(captured.skip, 1);
	assert.equal(captured.take, 11);
});

test('listClawsPaginated: search 生效', async () => {
	let captured = null;
	const db = {
		claw: {
			findMany: async (q) => { captured = q; return []; },
		},
	};

	await listClawsPaginated({ search: 'foo' }, db);

	assert.deepEqual(captured.where, { name: { contains: 'foo' } });
});

test('listClawsPaginated: agentModels 为 null 时保留 null', async () => {
	const db = {
		claw: {
			findMany: async () => [makeClaw(1, { agentModels: null })],
		},
	};

	const { items } = await listClawsPaginated({ limit: 10 }, db);

	assert.equal(items[0].agentModels, null);
});

test('listClawsPaginated: user 为 null 时字段兜底为 null', async () => {
	const db = {
		claw: {
			findMany: async () => [makeClaw(1, { user: null })],
		},
	};

	const { items } = await listClawsPaginated({ limit: 10 }, db);

	assert.equal(items[0].userId, null);
	assert.equal(items[0].userName, null);
	assert.equal(items[0].userLoginName, null);
});

test('listClawsPaginated: 不传参数时使用默认 limit=50', async () => {
	let captured = null;
	const db = {
		claw: {
			findMany: async (q) => { captured = q; return []; },
		},
	};

	await listClawsPaginated(undefined, db);

	assert.equal(captured.take, 51);
});

test('listClawsPaginated: 空结果时 nextCursor 为 null', async () => {
	const db = {
		claw: {
			findMany: async () => [],
		},
	};
	const result = await listClawsPaginated({ limit: 50 }, db);
	assert.equal(result.items.length, 0);
	assert.equal(result.nextCursor, null);
});

// --- listUsersPaginated ---

function makeUser(id, over = {}) {
	return {
		id: BigInt(id),
		name: `user-${id}`,
		avatar: null,
		createdAt: new Date('2026-02-01'),
		lastLoginAt: new Date('2026-04-10'),
		localAuth: { loginName: `ln-${id}` },
		_count: { claws: 2 },
		...over,
	};
}

test('listUsersPaginated: 基础调用返回 items', async () => {
	let captured = null;
	const db = {
		user: {
			findMany: async (q) => { captured = q; return [makeUser(1), makeUser(2)]; },
		},
	};

	const result = await listUsersPaginated({ limit: 50 }, db);

	assert.equal(captured.take, 51);
	assert.deepEqual(captured.orderBy, { id: 'desc' });
	assert.equal(result.items.length, 2);
	assert.equal(result.items[0].id, '1');
	assert.equal(result.items[0].loginName, 'ln-1');
	assert.equal(result.items[0].clawCount, 2);
	assert.equal(result.nextCursor, null);
});

test('listUsersPaginated: 超过 limit 时截断并生成 nextCursor', async () => {
	const db = {
		user: {
			findMany: async () => [makeUser(1), makeUser(2), makeUser(3)],
		},
	};

	const result = await listUsersPaginated({ limit: 2 }, db);

	assert.equal(result.items.length, 2);
	assert.equal(result.nextCursor, '2');
});

test('listUsersPaginated: cursor 启用 skip=1', async () => {
	let captured = null;
	const db = {
		user: {
			findMany: async (q) => { captured = q; return []; },
		},
	};

	await listUsersPaginated({ cursor: '500', limit: 10 }, db);

	assert.deepEqual(captured.cursor, { id: 500n });
	assert.equal(captured.skip, 1);
});

test('listUsersPaginated: search 使用 OR(name, localAuth.loginName)', async () => {
	let captured = null;
	const db = {
		user: {
			findMany: async (q) => { captured = q; return []; },
		},
	};

	await listUsersPaginated({ search: 'ali' }, db);

	assert.deepEqual(captured.where, {
		OR: [
			{ name: { contains: 'ali' } },
			{ localAuth: { loginName: { contains: 'ali' } } },
		],
	});
});

test('listUsersPaginated: localAuth 为 null → loginName 兜底为 null', async () => {
	const db = {
		user: {
			findMany: async () => [makeUser(1, { localAuth: null })],
		},
	};

	const { items } = await listUsersPaginated({ limit: 10 }, db);

	assert.equal(items[0].loginName, null);
});

test('listUsersPaginated: _count 缺失时 clawCount 兜底为 0', async () => {
	const db = {
		user: {
			findMany: async () => [makeUser(1, { _count: undefined })],
		},
	};

	const { items } = await listUsersPaginated({ limit: 10 }, db);

	assert.equal(items[0].clawCount, 0);
});

test('listUsersPaginated: 不传参数时使用默认 limit=50', async () => {
	let captured = null;
	const db = {
		user: {
			findMany: async (q) => { captured = q; return []; },
		},
	};

	await listUsersPaginated(undefined, db);

	assert.equal(captured.take, 51);
});
