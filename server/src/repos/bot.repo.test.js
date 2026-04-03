import assert from 'node:assert/strict';
import test from 'node:test';

import {
	findBotById,
	findLatestBotByUserId,
	findBotByTokenHash,
	createBot,
	updateBot,
	updateBotName,
	deleteBot,
	listBotsByUserId,
} from './bot.repo.js';

function makeBot(overrides = {}) {
	return {
		id: 1n,
		userId: 10n,
		name: 'test-bot',
		tokenHash: 'hash123',
		createdAt: new Date('2026-01-01'),
		updatedAt: new Date('2026-01-02'),
		...overrides,
	};
}

function createMockDb(method, handler) {
	return { bot: { [method]: handler } };
}

// --- findBotById ---

test('findBotById: 传递正确的 where 条件', async () => {
	let captured;
	const db = createMockDb('findUnique', async (args) => {
		captured = args;
		return makeBot();
	});

	const result = await findBotById(1n, db);

	assert.deepEqual(captured, { where: { id: 1n } });
	assert.equal(result.id, 1n);
});

test('findBotById: 不存在时返回 null', async () => {
	const db = createMockDb('findUnique', async () => null);

	const result = await findBotById(999n, db);

	assert.equal(result, null);
});

// --- findLatestBotByUserId ---

test('findLatestBotByUserId: 传递正确的查询参数', async () => {
	let captured;
	const db = createMockDb('findFirst', async (args) => {
		captured = args;
		return makeBot();
	});

	await findLatestBotByUserId(10n, db);

	assert.deepEqual(captured, {
		where: { userId: 10n },
		orderBy: { updatedAt: 'desc' },
	});
});

test('findLatestBotByUserId: 无结果时返回 null', async () => {
	const db = createMockDb('findFirst', async () => null);

	const result = await findLatestBotByUserId(999n, db);

	assert.equal(result, null);
});

// --- findBotByTokenHash ---

test('findBotByTokenHash: 传递正确的 where 和 select', async () => {
	let captured;
	const db = createMockDb('findUnique', async (args) => {
		captured = args;
		return { id: 1n, userId: 10n };
	});

	const result = await findBotByTokenHash('hash123', db);

	assert.deepEqual(captured, {
		where: { tokenHash: 'hash123' },
		select: { id: true, userId: true },
	});
	assert.equal(result.id, 1n);
});

test('findBotByTokenHash: 不存在时返回 null', async () => {
	const db = createMockDb('findUnique', async () => null);

	const result = await findBotByTokenHash('nonexistent', db);

	assert.equal(result, null);
});

// --- createBot ---

test('createBot: 传递 data 给 prisma.bot.create', async () => {
	let captured;
	const newBot = makeBot();
	const db = createMockDb('create', async (args) => {
		captured = args;
		return newBot;
	});

	const input = { userId: 10n, name: 'new-bot', tokenHash: 'abc' };
	const result = await createBot(input, db);

	assert.deepEqual(captured, { data: input });
	assert.equal(result.name, 'test-bot');
});

// --- updateBot ---

test('updateBot: 传递正确的 where 和 data', async () => {
	let captured;
	const db = createMockDb('update', async (args) => {
		captured = args;
		return makeBot({ name: 'updated' });
	});

	const result = await updateBot(1n, { name: 'updated' }, db);

	assert.deepEqual(captured, { where: { id: 1n }, data: { name: 'updated' } });
	assert.equal(result.name, 'updated');
});

// --- updateBotName ---

test('updateBotName: 传递正确的 where 和 data.name', async () => {
	let captured;
	const db = createMockDb('update', async (args) => {
		captured = args;
		return makeBot({ name: 'renamed' });
	});

	const result = await updateBotName(1n, 'renamed', db);

	assert.deepEqual(captured, { where: { id: 1n }, data: { name: 'renamed' } });
	assert.equal(result.name, 'renamed');
});

// --- deleteBot ---

test('deleteBot: 传递正确的 where 条件', async () => {
	let captured;
	const db = createMockDb('delete', async (args) => {
		captured = args;
		return makeBot();
	});

	await deleteBot(1n, db);

	assert.deepEqual(captured, { where: { id: 1n } });
});

// --- listBotsByUserId ---

test('listBotsByUserId: 传递正确的查询参数', async () => {
	let captured;
	const bots = [makeBot(), makeBot({ id: 2n })];
	const db = createMockDb('findMany', async (args) => {
		captured = args;
		return bots;
	});

	const result = await listBotsByUserId(10n, db);

	assert.deepEqual(captured, {
		where: { userId: 10n },
		orderBy: { createdAt: 'desc' },
	});
	assert.equal(result.length, 2);
});

test('listBotsByUserId: 无 bot 时返回空数组', async () => {
	const db = createMockDb('findMany', async () => []);

	const result = await listBotsByUserId(999n, db);

	assert.deepEqual(result, []);
});
