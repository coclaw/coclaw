import assert from 'node:assert/strict';
import test from 'node:test';

import { findLocalAuthByUserId, updatePasswordByUserId } from './local-auth.repo.js';

test('findLocalAuthByUserId: should call prisma with correct userId', async () => {
	let calledWhere = null;
	const mockPrisma = {
		localAuth: {
			findUnique: async (args) => {
				calledWhere = args.where;
				return { userId: 42n, passwordHash: 'hash' };
			},
		},
	};

	const result = await findLocalAuthByUserId(42n, mockPrisma);

	assert.deepEqual(calledWhere, { userId: 42n });
	assert.equal(result.userId, 42n);
});

test('updatePasswordByUserId: should call prisma update with correct data', async () => {
	let calledArgs = null;
	const mockPrisma = {
		localAuth: {
			update: async (args) => {
				calledArgs = args;
				return { userId: 42n, passwordHash: 'newHash' };
			},
		},
	};

	const result = await updatePasswordByUserId(42n, 'newHash', mockPrisma);

	assert.equal(calledArgs.where.userId, 42n);
	assert.equal(calledArgs.data.passwordHash, 'newHash');
	assert.ok(calledArgs.data.passwordUpdatedAt instanceof Date);
	assert.equal(result.passwordHash, 'newHash');
});

test('updatePasswordByUserId: should throw "Local auth not found" on P2025', async () => {
	const mockPrisma = {
		localAuth: {
			update: async () => {
				const err = new Error('Record not found');
				err.code = 'P2025';
				throw err;
			},
		},
	};

	await assert.rejects(
		() => updatePasswordByUserId(999n, 'hash', mockPrisma),
		{ message: 'Local auth not found' },
	);
});

test('updatePasswordByUserId: should rethrow non-P2025 errors', async () => {
	const mockPrisma = {
		localAuth: {
			update: async () => {
				throw new Error('DB connection lost');
			},
		},
	};

	await assert.rejects(
		() => updatePasswordByUserId(42n, 'hash', mockPrisma),
		{ message: 'DB connection lost' },
	);
});
