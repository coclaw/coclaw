import assert from 'node:assert/strict';
import test from 'node:test';

import {
	PORTAL_MODEL_CATALOG,
	getPortalModels,
	portalModelsMatch,
} from './portal-model-catalog.js';

// === PORTAL_MODEL_CATALOG ===

test('PORTAL_MODEL_CATALOG: minimax-portal holds the two current models with non-empty id+name', () => {
	const list = PORTAL_MODEL_CATALOG['minimax-portal'];
	assert.deepEqual(list, [
		{ id: 'MiniMax-M2.7', name: 'MiniMax M2.7' },
		{ id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 Highspeed' },
	]);
	// config model 条目 zod schema 要求 id/name 均非空字符串
	for (const m of list) {
		assert.equal(typeof m.id, 'string');
		assert.ok(m.id.length > 0);
		assert.equal(typeof m.name, 'string');
		assert.ok(m.name.length > 0);
	}
});

// === getPortalModels ===

test('getPortalModels: returns the list for a known provider', () => {
	assert.deepEqual(getPortalModels('minimax-portal'), [
		{ id: 'MiniMax-M2.7', name: 'MiniMax M2.7' },
		{ id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 Highspeed' },
	]);
});

test('getPortalModels: unknown provider → []', () => {
	assert.deepEqual(getPortalModels('nope'), []);
});

test('getPortalModels: returns a deep copy (caller mutation cannot poison the shared table)', () => {
	const a = getPortalModels('minimax-portal');
	a[0].id = 'HACKED';
	a.push({ id: 'X', name: 'X' });
	// 再取一次仍是原值
	assert.deepEqual(getPortalModels('minimax-portal'), [
		{ id: 'MiniMax-M2.7', name: 'MiniMax M2.7' },
		{ id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 Highspeed' },
	]);
});

// === portalModelsMatch ===

test('portalModelsMatch: identical lists match', () => {
	const t = getPortalModels('minimax-portal');
	assert.equal(portalModelsMatch(t, getPortalModels('minimax-portal')), true);
});

test('portalModelsMatch: order does not matter', () => {
	const t = getPortalModels('minimax-portal');
	const reversed = [...t].reverse();
	assert.equal(portalModelsMatch(reversed, t), true);
});

test('portalModelsMatch: different length → false', () => {
	const t = getPortalModels('minimax-portal');
	assert.equal(portalModelsMatch([t[0]], t), false);
	assert.equal(portalModelsMatch([...t, { id: 'extra', name: 'extra' }], t), false);
});

test('portalModelsMatch: same length but a name differs → false', () => {
	const t = getPortalModels('minimax-portal');
	const drift = [{ id: t[0].id, name: 'OLD NAME' }, { id: t[1].id, name: t[1].name }];
	assert.equal(portalModelsMatch(drift, t), false);
});

test('portalModelsMatch: same length but an id differs → false', () => {
	const t = getPortalModels('minimax-portal');
	const drift = [{ id: 'MiniMax-M2', name: t[0].name }, { id: t[1].id, name: t[1].name }];
	assert.equal(portalModelsMatch(drift, t), false);
});

test('portalModelsMatch: non-array current (missing / garbage) → false', () => {
	const t = getPortalModels('minimax-portal');
	assert.equal(portalModelsMatch(undefined, t), false);
	assert.equal(portalModelsMatch(null, t), false);
	assert.equal(portalModelsMatch('garbage', t), false);
});

test('portalModelsMatch: non-array target → false', () => {
	assert.equal(portalModelsMatch([], undefined), false);
});

test('portalModelsMatch: id/name containing spaces does not cause a false match', () => {
	// "a b"/"c" vs "a"/"b c" 拼起来都是 "a b c"——朴素空格分隔会误判一致，JSON 串化不会
	const x = [{ id: 'a b', name: 'c' }];
	const y = [{ id: 'a', name: 'b c' }];
	assert.equal(portalModelsMatch(x, y), false);
});
