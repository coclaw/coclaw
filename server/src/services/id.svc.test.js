import assert from 'node:assert/strict';
import test from 'node:test';

import { genBotId, genUserId } from './id.svc.js';

test('genUserId: 返回 bigint 类型的 ID', () => {
	const id = genUserId();
	assert.equal(typeof id, 'bigint');
	assert.ok(id > 0n);
});

test('genUserId: 连续调用返回不同 ID', () => {
	const id1 = genUserId();
	const id2 = genUserId();
	assert.notEqual(id1, id2);
});

test('genBotId: 返回 bigint 类型的 ID', () => {
	const id = genBotId();
	assert.equal(typeof id, 'bigint');
	assert.ok(id > 0n);
});

test('genBotId: 连续调用返回不同 ID', () => {
	const id1 = genBotId();
	const id2 = genBotId();
	assert.notEqual(id1, id2);
});
