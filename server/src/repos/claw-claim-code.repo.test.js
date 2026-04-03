import assert from 'node:assert/strict';
import test from 'node:test';

import {
	findClaimCode,
	createClaimCode,
	deleteClaimCode,
} from './claw-claim-code.repo.js';

function makeClaimCode(overrides = {}) {
	return {
		code: 'CLAIM001',
		clawId: 5n,
		expiresAt: new Date('2026-03-01'),
		...overrides,
	};
}

function createMockDb(method, handler) {
	return { clawClaimCode: { [method]: handler } };
}

// --- findClaimCode ---

test('findClaimCode: 传递正确的 where 条件', async () => {
	let captured;
	const db = createMockDb('findUnique', async (args) => {
		captured = args;
		return makeClaimCode();
	});

	const result = await findClaimCode('CLAIM001', db);

	assert.deepEqual(captured, { where: { code: 'CLAIM001' } });
	assert.equal(result.code, 'CLAIM001');
});

test('findClaimCode: 不存在时返回 null', async () => {
	const db = createMockDb('findUnique', async () => null);

	const result = await findClaimCode('NONEXIST', db);

	assert.equal(result, null);
});

// --- createClaimCode ---

test('createClaimCode: 传递 data 给 prisma.clawClaimCode.create', async () => {
	let captured;
	const db = createMockDb('create', async (args) => {
		captured = args;
		return makeClaimCode();
	});

	const input = { code: 'CLAIM001', clawId: 5n, expiresAt: new Date() };
	await createClaimCode(input, db);

	assert.deepEqual(captured, { data: input });
});

// --- deleteClaimCode ---

test('deleteClaimCode: 传递正确的 where 条件', async () => {
	let captured;
	const db = createMockDb('delete', async (args) => {
		captured = args;
		return makeClaimCode();
	});

	await deleteClaimCode('CLAIM001', db);

	assert.deepEqual(captured, { where: { code: 'CLAIM001' } });
});
