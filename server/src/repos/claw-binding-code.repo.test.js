import assert from 'node:assert/strict';
import test from 'node:test';

import {
	findBindingCode,
	createBindingCode,
	updateBindingCode,
	deleteBindingCode,
} from './claw-binding-code.repo.js';

function makeBindingCode(overrides = {}) {
	return {
		code: 'ABC123',
		userId: 10n,
		expiresAt: new Date('2026-02-01'),
		...overrides,
	};
}

function createMockDb(method, handler) {
	return { clawBindingCode: { [method]: handler } };
}

// --- findBindingCode ---

test('findBindingCode: 传递正确的 where 条件', async () => {
	let captured;
	const db = createMockDb('findUnique', async (args) => {
		captured = args;
		return makeBindingCode();
	});

	const result = await findBindingCode('ABC123', db);

	assert.deepEqual(captured, { where: { code: 'ABC123' } });
	assert.equal(result.code, 'ABC123');
});

test('findBindingCode: 不存在时返回 null', async () => {
	const db = createMockDb('findUnique', async () => null);

	const result = await findBindingCode('NONEXIST', db);

	assert.equal(result, null);
});

// --- createBindingCode ---

test('createBindingCode: 传递 data 给 prisma.clawBindingCode.create', async () => {
	let captured;
	const db = createMockDb('create', async (args) => {
		captured = args;
		return makeBindingCode();
	});

	const input = { code: 'ABC123', userId: 10n, expiresAt: new Date() };
	await createBindingCode(input, db);

	assert.deepEqual(captured, { data: input });
});

// --- updateBindingCode ---

test('updateBindingCode: 传递正确的 where 和 data', async () => {
	let captured;
	const db = createMockDb('update', async (args) => {
		captured = args;
		return makeBindingCode();
	});

	const result = await updateBindingCode('ABC123', { userId: 2n }, db);

	assert.deepEqual(captured, { where: { code: 'ABC123' }, data: { userId: 2n } });
	assert.equal(result.code, 'ABC123');
});

// --- deleteBindingCode ---

test('deleteBindingCode: 传递正确的 where 条件', async () => {
	let captured;
	const db = createMockDb('delete', async (args) => {
		captured = args;
		return makeBindingCode();
	});

	await deleteBindingCode('ABC123', db);

	assert.deepEqual(captured, { where: { code: 'ABC123' } });
});
