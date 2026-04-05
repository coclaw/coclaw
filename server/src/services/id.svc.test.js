import assert from 'node:assert/strict';
import test from 'node:test';

import { genClawId, genUserId } from './id.svc.js';

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

test('genClawId: 返回 bigint 类型的 ID', () => {
	const id = genClawId();
	assert.equal(typeof id, 'bigint');
	assert.ok(id > 0n);
});

test('genClawId: 连续调用返回不同 ID', () => {
	const id1 = genClawId();
	const id2 = genClawId();
	assert.notEqual(id1, id2);
});
