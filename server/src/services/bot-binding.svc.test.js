import assert from 'node:assert/strict';
import test from 'node:test';

import {
	bindBot,
	createBindingCodeForUser,
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
