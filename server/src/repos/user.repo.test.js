import assert from 'node:assert/strict';
import test from 'node:test';

import {
	findUserById,
	findUserProfileById,
	findUserProfileByIdWithOptions,
	updateUserProfileById,
} from './user.repo.js';

function makeUser(overrides = {}) {
	return {
		id: 1n,
		name: 'Alice',
		avatar: null,
		createdAt: new Date('2026-01-01'),
		...overrides,
	};
}

function createMockDb({ findUniqueResult = makeUser(), updateResult } = {}) {
	const calls = { findUnique: [], update: [] };

	return {
		client: {
			user: {
				findUnique: async (args) => {
					calls.findUnique.push(args);
					return findUniqueResult;
				},
				update: async (args) => {
					calls.update.push(args);
					if (updateResult instanceof Error) throw updateResult;
					return updateResult ?? makeUser();
				},
			},
		},
		calls,
	};
}

// --- findUserById ---

test('findUserById: 传递正确的 where 条件', async () => {
	const { client, calls } = createMockDb();

	const result = await findUserById(1n, client);

	assert.equal(calls.findUnique.length, 1);
	assert.deepEqual(calls.findUnique[0], { where: { id: 1n } });
	assert.equal(result.id, 1n);
});

test('findUserById: 不存在时返回 null', async () => {
	const { client } = createMockDb({ findUniqueResult: null });

	const result = await findUserById(999n, client);

	assert.equal(result, null);
});

// --- findUserProfileByIdWithOptions ---

test('findUserProfileByIdWithOptions: 默认不包含 settings', async () => {
	const { client, calls } = createMockDb();

	await findUserProfileByIdWithOptions(1n, {}, client);

	assert.equal(calls.findUnique.length, 1);
	const args = calls.findUnique[0];
	assert.deepEqual(args.where, { id: 1n });
	assert.equal(args.include.userSetting, false);
	assert.deepEqual(args.include.localAuth, { select: { loginName: true } });
	assert.deepEqual(args.include.externalAuths, {
		select: { oauthType: true, oauthName: true, oauthAvatar: true },
	});
});

test('findUserProfileByIdWithOptions: includeSettings=true 时包含 settings', async () => {
	const { client, calls } = createMockDb();

	await findUserProfileByIdWithOptions(1n, { includeSettings: true }, client);

	assert.equal(calls.findUnique[0].include.userSetting, true);
});

// --- findUserProfileById ---

test('findUserProfileById: 默认包含 settings（调用 WithOptions）', async () => {
	const { client, calls } = createMockDb();

	await findUserProfileById(1n, client);

	assert.equal(calls.findUnique.length, 1);
	assert.equal(calls.findUnique[0].include.userSetting, true);
});

// --- updateUserProfileById ---

test('updateUserProfileById: 仅传 name 时只更新 name', async () => {
	const { client, calls } = createMockDb({ updateResult: makeUser({ name: 'Bob' }) });

	const result = await updateUserProfileById(1n, { name: 'Bob' }, client);

	assert.equal(calls.update.length, 1);
	assert.deepEqual(calls.update[0], {
		where: { id: 1n },
		data: { name: 'Bob' },
	});
	assert.equal(result.name, 'Bob');
});

test('updateUserProfileById: 仅传 avatar 时只更新 avatar', async () => {
	const { client, calls } = createMockDb({ updateResult: makeUser({ avatar: 'url' }) });

	await updateUserProfileById(1n, { avatar: 'url' }, client);

	assert.deepEqual(calls.update[0].data, { avatar: 'url' });
});

test('updateUserProfileById: 同时传 name 和 avatar', async () => {
	const { client, calls } = createMockDb();

	await updateUserProfileById(1n, { name: 'Bob', avatar: 'url' }, client);

	assert.deepEqual(calls.update[0].data, { name: 'Bob', avatar: 'url' });
});

test('updateUserProfileById: 无关字段不会传入 data', async () => {
	const { client, calls } = createMockDb();

	await updateUserProfileById(1n, { email: 'a@b.com' }, client);

	assert.deepEqual(calls.update[0].data, {});
});

test('updateUserProfileById: name 为 null 时仍传入', async () => {
	const { client, calls } = createMockDb();

	await updateUserProfileById(1n, { name: null }, client);

	assert.deepEqual(calls.update[0].data, { name: null });
});
