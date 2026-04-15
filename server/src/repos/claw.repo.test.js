import assert from 'node:assert/strict';
import test from 'node:test';

import {
	findClawById,
	findLatestClawByUserId,
	findClawByTokenHash,
	createClaw,
	updateClaw,
	deleteClaw,
	listClawsByUserId,
} from './claw.repo.js';

function makeClaw(overrides = {}) {
	return {
		id: 1n,
		userId: 10n,
		name: 'test-claw',
		tokenHash: 'hash123',
		createdAt: new Date('2026-01-01'),
		updatedAt: new Date('2026-01-02'),
		...overrides,
	};
}

function createMockDb(method, handler) {
	return { claw: { [method]: handler } };
}

// --- findClawById ---

test('findClawById: 传递正确的 where 条件', async () => {
	let captured;
	const db = createMockDb('findUnique', async (args) => {
		captured = args;
		return makeClaw();
	});

	const result = await findClawById(1n, db);

	assert.deepEqual(captured, { where: { id: 1n } });
	assert.equal(result.id, 1n);
});

test('findClawById: 不存在时返回 null', async () => {
	const db = createMockDb('findUnique', async () => null);

	const result = await findClawById(999n, db);

	assert.equal(result, null);
});

// --- findLatestClawByUserId ---

test('findLatestClawByUserId: 传递正确的查询参数', async () => {
	let captured;
	const db = createMockDb('findFirst', async (args) => {
		captured = args;
		return makeClaw();
	});

	await findLatestClawByUserId(10n, db);

	assert.deepEqual(captured, {
		where: { userId: 10n },
		orderBy: { updatedAt: 'desc' },
	});
});

test('findLatestClawByUserId: 无结果时返回 null', async () => {
	const db = createMockDb('findFirst', async () => null);

	const result = await findLatestClawByUserId(999n, db);

	assert.equal(result, null);
});

// --- findClawByTokenHash ---

test('findClawByTokenHash: 传递正确的 where 和 select', async () => {
	let captured;
	const db = createMockDb('findUnique', async (args) => {
		captured = args;
		return { id: 1n, userId: 10n };
	});

	const result = await findClawByTokenHash('hash123', db);

	assert.deepEqual(captured, {
		where: { tokenHash: 'hash123' },
		select: { id: true, userId: true },
	});
	assert.equal(result.id, 1n);
});

test('findClawByTokenHash: 不存在时返回 null', async () => {
	const db = createMockDb('findUnique', async () => null);

	const result = await findClawByTokenHash('nonexistent', db);

	assert.equal(result, null);
});

// --- createClaw ---

test('createClaw: 传递 data 给 prisma.claw.create', async () => {
	let captured;
	const newClaw = makeClaw();
	const db = createMockDb('create', async (args) => {
		captured = args;
		return newClaw;
	});

	const input = { userId: 10n, name: 'new-claw', tokenHash: 'abc' };
	const result = await createClaw(input, db);

	assert.deepEqual(captured, { data: input });
	assert.equal(result.name, 'test-claw');
});

// --- updateClaw ---

test('updateClaw: 传递正确的 where 和 data', async () => {
	let captured;
	const db = createMockDb('update', async (args) => {
		captured = args;
		return makeClaw({ name: 'updated' });
	});

	const result = await updateClaw(1n, { name: 'updated' }, db);

	assert.deepEqual(captured, { where: { id: 1n }, data: { name: 'updated' } });
	assert.equal(result.name, 'updated');
});

// --- deleteClaw ---

test('deleteClaw: 传递正确的 where 条件', async () => {
	let captured;
	const db = createMockDb('delete', async (args) => {
		captured = args;
		return makeClaw();
	});

	await deleteClaw(1n, db);

	assert.deepEqual(captured, { where: { id: 1n } });
});

// --- listClawsByUserId ---

test('listClawsByUserId: 传递正确的查询参数', async () => {
	let captured;
	const claws = [makeClaw(), makeClaw({ id: 2n })];
	const db = createMockDb('findMany', async (args) => {
		captured = args;
		return claws;
	});

	const result = await listClawsByUserId(10n, db);

	assert.deepEqual(captured, {
		where: { userId: 10n },
		orderBy: { createdAt: 'desc' },
	});
	assert.equal(result.length, 2);
});

test('listClawsByUserId: 无 claw 时返回空数组', async () => {
	const db = createMockDb('findMany', async () => []);

	const result = await listClawsByUserId(999n, db);

	assert.deepEqual(result, []);
});
