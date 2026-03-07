import assert from 'node:assert/strict';
import test from 'node:test';

import { patchUserSettingByUserId, findUserSettingByUserId } from './user-setting.repo.js';

function makeSetting(overrides = {}) {
	return {
		userId: 1n,
		theme: 'auto',
		lang: null,
		perfs: {},
		uiState: {},
		hintCounts: {},
		...overrides,
	};
}

function createMockPrisma({ updateResult, executeRawResult = 1, findResult } = {}) {
	const calls = {
		update: [],
		executeRaw: [],
		findUnique: [],
		transaction: [],
	};

	const buildClient = (isTransaction = false) => ({
		userSetting: {
			findUnique(args) {
				calls.findUnique.push(args);
				return Promise.resolve(findResult ?? makeSetting());
			},
			update(args) {
				calls.update.push(args);
				if (updateResult instanceof Error) {
					return Promise.reject(updateResult);
				}
				return Promise.resolve(updateResult ?? makeSetting());
			},
		},
		$executeRaw(...args) {
			calls.executeRaw.push(args);
			return Promise.resolve(executeRawResult);
		},
		$transaction: isTransaction ? undefined : async (fn) => {
			calls.transaction.push(true);
			const tx = buildClient(true);
			return fn(tx);
		},
	});

	return { client: buildClient(), calls };
}

test('findUserSettingByUserId: 调用 prisma.userSetting.findUnique', async () => {
	const expected = makeSetting();
	const { client, calls } = createMockPrisma({ findResult: expected });

	const result = await findUserSettingByUserId(1n, client);

	assert.deepEqual(result, expected);
	assert.equal(calls.findUnique.length, 1);
	assert.deepEqual(calls.findUnique[0].where, { userId: 1n });
});

test('patchUserSettingByUserId: 仅标量字段 → 调用 update', async () => {
	const { client, calls } = createMockPrisma();

	await patchUserSettingByUserId(1n, { theme: 'dark' }, client);

	assert.equal(calls.update.length, 1);
	assert.deepEqual(calls.update[0].where, { userId: 1n });
	assert.deepEqual(calls.update[0].data, { theme: 'dark' });
	assert.equal(calls.executeRaw.length, 0);
	assert.equal(calls.transaction.length, 0);
});

test('patchUserSettingByUserId: 标量字段为 null → 不报错', async () => {
	const { client, calls } = createMockPrisma();

	await patchUserSettingByUserId(1n, { theme: null, lang: null }, client);

	assert.equal(calls.update.length, 1);
	assert.deepEqual(calls.update[0].data, { theme: null, lang: null });
});

test('patchUserSettingByUserId: 仅 JSON patch → 调用 $executeRaw', async () => {
	const { client, calls } = createMockPrisma();

	await patchUserSettingByUserId(1n, { uiStatePatch: { sidebar: true } }, client);

	assert.equal(calls.executeRaw.length, 1);
	assert.equal(calls.update.length, 0);
	assert.equal(calls.transaction.length, 0);
});

test('patchUserSettingByUserId: 混合字段 → 调用 $transaction', async () => {
	const { client, calls } = createMockPrisma();

	await patchUserSettingByUserId(1n, {
		theme: 'light',
		perfsPatch: { key: 'val' },
	}, client);

	assert.equal(calls.transaction.length, 1);
	// 事务内部分别调用了 update 和 executeRaw
	assert.equal(calls.update.length, 1);
	assert.equal(calls.executeRaw.length, 1);
});

test('patchUserSettingByUserId: update 抛 P2025 → 抛出 User settings not found', async () => {
	const p2025 = new Error('Record not found');
	p2025.code = 'P2025';
	const { client } = createMockPrisma({ updateResult: p2025 });

	await assert.rejects(
		() => patchUserSettingByUserId(1n, { theme: 'dark' }, client),
		{ message: 'User settings not found' },
	);
});

test('patchUserSettingByUserId: $executeRaw 返回 0 → 抛出 User settings not found', async () => {
	const { client } = createMockPrisma({ executeRawResult: 0 });

	await assert.rejects(
		() => patchUserSettingByUserId(1n, { uiStatePatch: {} }, client),
		{ message: 'User settings not found' },
	);
});

test('patchUserSettingByUserId: update 抛非 P2025 错误 → 原样抛出', async () => {
	const otherErr = new Error('Connection lost');
	otherErr.code = 'P1001';
	const { client } = createMockPrisma({ updateResult: otherErr });

	await assert.rejects(
		() => patchUserSettingByUserId(1n, { lang: 'en' }, client),
		{ message: 'Connection lost' },
	);
});
