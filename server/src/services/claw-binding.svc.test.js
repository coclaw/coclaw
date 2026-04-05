import assert from 'node:assert/strict';
import test from 'node:test';

import {
	bindClaw,
	claimClaw,
	createBindingCodeForUser,
	createClaimCode,
	unbindClawByToken,
	unbindClawByUser,
} from './claw-binding.svc.js';

test('createBindingCodeForUser: should create new code', async () => {
	const created = [];
	const result = await createBindingCodeForUser({ userId: 1n }, {
		createCode: async (data) => {
			created.push(data);
		},
		findCode: async () => null,
		updateCode: async () => null,
		now: () => new Date('2026-02-19T00:00:00.000Z'),
	});

	assert.equal(result.ok, true);
	assert.equal(result.code.length, 8);
	assert.equal(created.length, 1);
});

test('bindClaw: should reject invalid input', async () => {
	const result = await bindClaw({ code: '' });
	assert.equal(result.ok, false);
	assert.equal(result.code, 'INVALID_INPUT');
});

test('bindClaw: should create new claw record', async () => {
	const createdInputs = [];
	const result = await bindClaw({ code: '12345678', name: 'home' }, {
		findCode: async () => ({
			code: '12345678',
			userId: 9n,
			expiresAt: new Date('2099-01-01T00:00:00.000Z'),
		}),
		deleteCode: async () => null,
		createClawImpl: async (data) => {
			createdInputs.push(data);
			return ({ id: data.id });
		},
		genId: () => 88n,
	});

	assert.equal(result.ok, true);
	assert.equal(result.rebound, false);
	assert.equal(result.botId, 88n);
	assert.equal(result.userId, 9n);
	assert.equal(typeof result.token, 'string');
	assert.equal(createdInputs.length, 1);
	assert.equal(createdInputs[0].name, 'home');
});

test('bindClaw: should allow missing name and persist null', async () => {
	const createdInputs = [];
	const result = await bindClaw({ code: '12345678' }, {
		findCode: async () => ({
			code: '12345678',
			userId: 9n,
			expiresAt: new Date('2099-01-01T00:00:00.000Z'),
		}),
		deleteCode: async () => null,
		createClawImpl: async (data) => {
			createdInputs.push(data);
			return ({ id: data.id });
		},
		genId: () => 99n,
	});

	assert.equal(result.ok, true);
	assert.equal(result.botName, null);
	assert.equal(createdInputs[0].name, null);
	assert.equal(Buffer.isBuffer(createdInputs[0].tokenHash), true);
	assert.equal(createdInputs[0].tokenHash.length, 32);
});

test('unbindClawByUser: should delete specified claw', async () => {
	const deleted = [];
	const result = await unbindClawByUser({ userId: 7n, botId: 2n }, {
		findById: async () => ({ id: 2n, userId: 7n, status: 'active' }),
		deleteClawImpl: async (id) => {
			deleted.push(id);
		},
	});

	assert.equal(result.ok, true);
	assert.equal(result.botId, 2n);
	assert.equal(deleted.length, 1);
	assert.equal(deleted[0], 2n);
});

test('unbindClawByToken: should delete matched claw', async () => {
	const deleted = [];
	const findInputs = [];
	const result = await unbindClawByToken({ token: 'abc' }, {
		findByTokenHash: async (tokenHash) => {
			findInputs.push(tokenHash);
			return { id: 2n, userId: 7n, status: 'active' };
		},
		deleteClawImpl: async (id) => {
			deleted.push(id);
		},
	});

	assert.equal(result.ok, true);
	assert.equal(result.botId, 2n);
	assert.equal(result.userId, 7n);
	assert.equal(findInputs.length, 1);
	assert.equal(Buffer.isBuffer(findInputs[0]), true);
	assert.equal(findInputs[0].length, 32);
	assert.equal(deleted.length, 1);
	assert.equal(deleted[0], 2n);
});

// ---- createClaimCode ----

test('createClaimCode: should create a new claim code', async () => {
	const created = [];
	const result = await createClaimCode({
		createCode: async (data) => {
			created.push(data);
		},
		findCode: async () => null,
		deleteCode: async () => {},
		now: () => new Date('2026-03-19T00:00:00.000Z'),
	});

	assert.equal(result.ok, true);
	assert.equal(result.code.length, 8);
	assert.ok(result.expiresAt instanceof Date);
	assert.equal(created.length, 1);
	assert.equal(created[0].code, result.code);
});

test('createClaimCode: should return CLAIM_CODE_EXHAUSTED after 3 retries', async () => {
	let attempts = 0;
	const result = await createClaimCode({
		createCode: async () => {
			attempts += 1;
			const err = new Error('Unique constraint');
			err.code = 'P2002';
			throw err;
		},
		findCode: async () => null,
		deleteCode: async () => {},
		now: () => new Date('2026-03-19T00:00:00.000Z'),
	});

	assert.equal(result.ok, false);
	assert.equal(result.code, 'CLAIM_CODE_EXHAUSTED');
	assert.equal(attempts, 3);
});

test('createClaimCode: should continue on P2002 with non-expired existing code', async () => {
	let attempts = 0;
	const result = await createClaimCode({
		createCode: async () => {
			attempts += 1;
			const err = new Error('Unique constraint');
			err.code = 'P2002';
			throw err;
		},
		// 返回一个未过期的记录 → 跳过继续重试
		findCode: async () => ({
			expiresAt: new Date('2099-01-01T00:00:00.000Z'),
		}),
		deleteCode: async () => {},
		now: () => new Date('2026-03-19T00:00:00.000Z'),
	});

	assert.equal(result.ok, false);
	assert.equal(result.code, 'CLAIM_CODE_EXHAUSTED');
	assert.equal(attempts, 3);
});

test('createClaimCode: should delete expired record on P2002 collision', async () => {
	let attempt = 0;
	const deletedCodes = [];
	const result = await createClaimCode({
		createCode: async (data) => {
			attempt += 1;
			if (attempt === 1) {
				const err = new Error('Unique constraint');
				err.code = 'P2002';
				throw err;
			}
			// 第二次成功
		},
		findCode: async () => ({
			expiresAt: new Date('2020-01-01T00:00:00.000Z'),
		}),
		deleteCode: async (code) => { deletedCodes.push(code); },
		now: () => new Date('2026-03-19T00:00:00.000Z'),
	});

	assert.equal(result.ok, true);
	assert.equal(deletedCodes.length, 1);
});

test('createClaimCode: should throw on non-P2002 errors', async () => {
	await assert.rejects(
		() => createClaimCode({
			createCode: async () => {
				throw new Error('DB connection lost');
			},
			findCode: async () => null,
			deleteCode: async () => {},
			now: () => new Date('2026-03-19T00:00:00.000Z'),
		}),
		(err) => {
			assert.equal(err.message, 'DB connection lost');
			return true;
		},
	);
});

// ---- claimClaw ----

test('claimClaw: should reject missing code', async () => {
	const result = await claimClaw({ code: '', userId: 1n });
	assert.equal(result.ok, false);
	assert.equal(result.code, 'INVALID_INPUT');
});

test('claimClaw: should reject non-string code', async () => {
	const result = await claimClaw({ code: null, userId: 1n });
	assert.equal(result.ok, false);
	assert.equal(result.code, 'INVALID_INPUT');
});

test('claimClaw: should reject missing userId', async () => {
	const result = await claimClaw({ code: '12345678', userId: undefined });
	assert.equal(result.ok, false);
	assert.equal(result.code, 'INVALID_INPUT');
	assert.match(result.message, /userId/);
});

test('claimClaw: should reject non-bigint userId', async () => {
	const result = await claimClaw({ code: '12345678', userId: 1 });
	assert.equal(result.ok, false);
	assert.equal(result.code, 'INVALID_INPUT');
});

test('claimClaw: should return CLAIM_CODE_INVALID for unknown code', async () => {
	const result = await claimClaw({ code: '12345678', userId: 7n }, {
		findCode: async () => null,
	});

	assert.equal(result.ok, false);
	assert.equal(result.code, 'CLAIM_CODE_INVALID');
});

test('claimClaw: should return CLAIM_CODE_EXPIRED for expired code and delete it', async () => {
	let deletedCode = null;
	const result = await claimClaw({ code: '12345678', userId: 7n }, {
		findCode: async () => ({
			code: '12345678',
			expiresAt: new Date('2020-01-01T00:00:00.000Z'),
		}),
		deleteCode: async (c) => { deletedCode = c; },
		now: () => new Date('2026-03-19T00:00:00.000Z'),
	});

	assert.equal(result.ok, false);
	assert.equal(result.code, 'CLAIM_CODE_EXPIRED');
	assert.equal(deletedCode, '12345678');
});


// ---- createBindingCodeForUser: P2002 碰撞路径 ----

test('createBindingCodeForUser: should reuse expired code on P2002 collision', async () => {
	const updated = [];
	const result = await createBindingCodeForUser({ userId: 1n }, {
		createCode: async () => {
			const err = new Error('Unique constraint');
			err.code = 'P2002';
			throw err;
		},
		findCode: async () => ({
			expiresAt: new Date('2020-01-01T00:00:00.000Z'),
		}),
		updateCode: async (code, data) => {
			updated.push({ code, data });
		},
		now: () => new Date('2026-03-19T00:00:00.000Z'),
	});

	// 第一次碰撞后发现已过期记录，走 updateCode 路径
	assert.equal(result.ok, true);
	assert.equal(updated.length, 1);
});

test('createBindingCodeForUser: should continue when P2002 and existing code not found', async () => {
	let attempts = 0;
	const result = await createBindingCodeForUser({ userId: 1n }, {
		createCode: async () => {
			attempts += 1;
			const err = new Error('Unique constraint');
			err.code = 'P2002';
			throw err;
		},
		findCode: async () => null,
		updateCode: async () => {},
		now: () => new Date('2026-03-19T00:00:00.000Z'),
	});

	assert.equal(result.ok, false);
	assert.equal(result.code, 'BINDING_CODE_EXHAUSTED');
	assert.equal(attempts, 3);
});

test('createBindingCodeForUser: should continue when P2002 and existing code not expired', async () => {
	let attempts = 0;
	const result = await createBindingCodeForUser({ userId: 1n }, {
		createCode: async () => {
			attempts += 1;
			const err = new Error('Unique constraint');
			err.code = 'P2002';
			throw err;
		},
		findCode: async () => ({
			expiresAt: new Date('2099-01-01T00:00:00.000Z'),
		}),
		updateCode: async () => {},
		now: () => new Date('2026-03-19T00:00:00.000Z'),
	});

	assert.equal(result.ok, false);
	assert.equal(result.code, 'BINDING_CODE_EXHAUSTED');
	assert.equal(attempts, 3);
});

test('createBindingCodeForUser: should throw non-P2002 errors', async () => {
	await assert.rejects(
		() => createBindingCodeForUser({ userId: 1n }, {
			createCode: async () => {
				throw new Error('DB connection lost');
			},
			findCode: async () => null,
			updateCode: async () => {},
			now: () => new Date('2026-03-19T00:00:00.000Z'),
		}),
		(err) => {
			assert.equal(err.message, 'DB connection lost');
			return true;
		},
	);
});

// ---- unbindClawByUser: 分支覆盖 ----

test('unbindClawByUser: should reject invalid input types', async () => {
	const r1 = await unbindClawByUser({ userId: 1, botId: 2n });
	assert.equal(r1.ok, false);
	assert.equal(r1.code, 'INVALID_INPUT');

	const r2 = await unbindClawByUser({ userId: 1n, botId: 2 });
	assert.equal(r2.ok, false);
	assert.equal(r2.code, 'INVALID_INPUT');
});

test('unbindClawByUser: should return BOT_NOT_FOUND when claw does not exist', async () => {
	const result = await unbindClawByUser({ userId: 7n, botId: 2n }, {
		findById: async () => null,
		deleteClawImpl: async () => {},
	});

	assert.equal(result.ok, false);
	assert.equal(result.code, 'BOT_NOT_FOUND');
});

test('unbindClawByUser: should return BOT_NOT_FOUND when userId does not match', async () => {
	const result = await unbindClawByUser({ userId: 7n, botId: 2n }, {
		findById: async () => ({ id: 2n, userId: 999n }),
		deleteClawImpl: async () => {},
	});

	assert.equal(result.ok, false);
	assert.equal(result.code, 'BOT_NOT_FOUND');
});

// ---- unbindClawByToken: 分支覆盖 ----

test('unbindClawByToken: should reject empty token', async () => {
	const result = await unbindClawByToken({ token: '' });
	assert.equal(result.ok, false);
	assert.equal(result.code, 'INVALID_INPUT');
});

test('unbindClawByToken: should reject non-string token', async () => {
	const result = await unbindClawByToken({ token: 123 });
	assert.equal(result.ok, false);
	assert.equal(result.code, 'INVALID_INPUT');
});

test('unbindClawByToken: should return UNAUTHORIZED when claw not found', async () => {
	const result = await unbindClawByToken({ token: 'nonexistent-token' }, {
		findByTokenHash: async () => null,
		deleteClawImpl: async () => {},
	});

	assert.equal(result.ok, false);
	assert.equal(result.code, 'UNAUTHORIZED');
});

// ---- bindClaw: 分支覆盖 ----

test('bindClaw: should return BINDING_CODE_INVALID for unknown code', async () => {
	const result = await bindClaw({ code: '99999999' }, {
		findCode: async () => null,
	});

	assert.equal(result.ok, false);
	assert.equal(result.code, 'BINDING_CODE_INVALID');
});

test('bindClaw: should return BINDING_CODE_EXPIRED for expired code', async () => {
	let deleted = null;
	const result = await bindClaw({ code: '12345678' }, {
		findCode: async () => ({
			code: '12345678',
			userId: 9n,
			expiresAt: new Date('2020-01-01T00:00:00.000Z'),
		}),
		deleteCode: async (c) => { deleted = c; },
		now: () => new Date('2026-03-19T00:00:00.000Z'),
	});

	assert.equal(result.ok, false);
	assert.equal(result.code, 'BINDING_CODE_EXPIRED');
	assert.equal(deleted, '12345678');
});

test('claimClaw: should create claw and return success on valid claim', async () => {
	const createdInputs = [];
	let deletedCode = null;
	const result = await claimClaw({ code: '12345678', userId: 7n }, {
		findCode: async () => ({
			code: '12345678',
			expiresAt: new Date('2099-01-01T00:00:00.000Z'),
		}),
		deleteCode: async (c) => { deletedCode = c; },
		listBots: async () => [],
		createClawImpl: async (data) => {
			createdInputs.push(data);
			return { id: data.id };
		},
		genId: () => 42n,
		now: () => new Date('2026-03-19T00:00:00.000Z'),
	});

	assert.equal(result.ok, true);
	assert.equal(result.botId, 42n);
	assert.equal(result.botName, null);
	assert.equal(typeof result.token, 'string');
	assert.ok(result.token.length > 0);
	assert.equal(deletedCode, '12345678');
	assert.equal(createdInputs.length, 1);
	assert.equal(createdInputs[0].userId, 7n);
	assert.equal(createdInputs[0].name, null);
	assert.equal(Buffer.isBuffer(createdInputs[0].tokenHash), true);
	assert.equal(createdInputs[0].tokenHash.length, 32);
});
