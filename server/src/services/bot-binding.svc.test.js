import assert from 'node:assert/strict';
import test from 'node:test';

import {
	bindBot,
	claimBot,
	createBindingCodeForUser,
	createClaimCode,
	unbindBotByToken,
	unbindBotByUser,
} from './bot-binding.svc.js';

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

test('bindBot: should reject invalid input', async () => {
	const result = await bindBot({ code: '' });
	assert.equal(result.ok, false);
	assert.equal(result.code, 'INVALID_INPUT');
});

test('bindBot: should create new bot record', async () => {
	const createdInputs = [];
	const result = await bindBot({ code: '12345678', name: 'home' }, {
		findCode: async () => ({
			code: '12345678',
			userId: 9n,
			expiresAt: new Date('2099-01-01T00:00:00.000Z'),
		}),
		deleteCode: async () => null,
		createBotImpl: async (data) => {
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

test('bindBot: should allow missing name and persist null', async () => {
	const createdInputs = [];
	const result = await bindBot({ code: '12345678' }, {
		findCode: async () => ({
			code: '12345678',
			userId: 9n,
			expiresAt: new Date('2099-01-01T00:00:00.000Z'),
		}),
		deleteCode: async () => null,
		createBotImpl: async (data) => {
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

test('unbindBotByUser: should delete specified bot', async () => {
	const deleted = [];
	const result = await unbindBotByUser({ userId: 7n, botId: 2n }, {
		findById: async () => ({ id: 2n, userId: 7n, status: 'active' }),
		deleteBotImpl: async (id) => {
			deleted.push(id);
		},
	});

	assert.equal(result.ok, true);
	assert.equal(result.botId, 2n);
	assert.equal(deleted.length, 1);
	assert.equal(deleted[0], 2n);
});

test('unbindBotByToken: should delete matched bot', async () => {
	const deleted = [];
	const findInputs = [];
	const result = await unbindBotByToken({ token: 'abc' }, {
		findByTokenHash: async (tokenHash) => {
			findInputs.push(tokenHash);
			return { id: 2n, userId: 7n, status: 'active' };
		},
		deleteBotImpl: async (id) => {
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

// ---- claimBot ----

test('claimBot: should reject missing code', async () => {
	const result = await claimBot({ code: '', userId: 1n });
	assert.equal(result.ok, false);
	assert.equal(result.code, 'INVALID_INPUT');
});

test('claimBot: should reject non-string code', async () => {
	const result = await claimBot({ code: null, userId: 1n });
	assert.equal(result.ok, false);
	assert.equal(result.code, 'INVALID_INPUT');
});

test('claimBot: should reject missing userId', async () => {
	const result = await claimBot({ code: '12345678', userId: undefined });
	assert.equal(result.ok, false);
	assert.equal(result.code, 'INVALID_INPUT');
	assert.match(result.message, /userId/);
});

test('claimBot: should reject non-bigint userId', async () => {
	const result = await claimBot({ code: '12345678', userId: 1 });
	assert.equal(result.ok, false);
	assert.equal(result.code, 'INVALID_INPUT');
});

test('claimBot: should return CLAIM_CODE_INVALID for unknown code', async () => {
	const result = await claimBot({ code: '12345678', userId: 7n }, {
		findCode: async () => null,
	});

	assert.equal(result.ok, false);
	assert.equal(result.code, 'CLAIM_CODE_INVALID');
});

test('claimBot: should return CLAIM_CODE_EXPIRED for expired code and delete it', async () => {
	let deletedCode = null;
	const result = await claimBot({ code: '12345678', userId: 7n }, {
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

test('claimBot: should return ALREADY_BOUND when user has existing bots', async () => {
	const result = await claimBot({ code: '12345678', userId: 7n }, {
		findCode: async () => ({
			code: '12345678',
			expiresAt: new Date('2099-01-01T00:00:00.000Z'),
		}),
		listBots: async () => [{ id: 1n }],
		now: () => new Date('2026-03-19T00:00:00.000Z'),
	});

	assert.equal(result.ok, false);
	assert.equal(result.code, 'ALREADY_BOUND');
});

test('claimBot: ALREADY_BOUND message should mention openclaw coclaw unbind', async () => {
	const result = await claimBot({ code: '12345678', userId: 7n }, {
		findCode: async () => ({
			code: '12345678',
			expiresAt: new Date('2099-01-01T00:00:00.000Z'),
		}),
		listBots: async () => [{ id: 1n }],
		now: () => new Date('2026-03-19T00:00:00.000Z'),
	});

	assert.match(result.message, /openclaw coclaw unbind/);
});

test('claimBot: should create bot and return success on valid claim', async () => {
	const createdInputs = [];
	let deletedCode = null;
	const result = await claimBot({ code: '12345678', userId: 7n }, {
		findCode: async () => ({
			code: '12345678',
			expiresAt: new Date('2099-01-01T00:00:00.000Z'),
		}),
		deleteCode: async (c) => { deletedCode = c; },
		listBots: async () => [],
		createBotImpl: async (data) => {
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
