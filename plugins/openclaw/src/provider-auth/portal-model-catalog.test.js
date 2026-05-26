import assert from 'node:assert/strict';
import test from 'node:test';

import {
	PORTAL_MODEL_CATALOG,
	getPortalModels,
	portalModelsCoveredById,
} from './portal-model-catalog.js';

// 钉死与上游对齐的确切清单（含最必须运行元数据；不含 cost——portal 是 token plan）
const EXPECTED = [
	{ id: 'MiniMax-M2.7', name: 'MiniMax M2.7', reasoning: true, contextWindow: 204800, maxTokens: 131072 },
	{ id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 Highspeed', reasoning: true, contextWindow: 204800, maxTokens: 131072 },
];

// === PORTAL_MODEL_CATALOG ===

test('PORTAL_MODEL_CATALOG: minimax-portal holds the two current models with id/name + runtime metadata', () => {
	const list = PORTAL_MODEL_CATALOG['minimax-portal'];
	assert.deepEqual(list, EXPECTED);
	for (const m of list) {
		// config model 条目 zod schema 要求 id/name 均非空字符串
		assert.equal(typeof m.id, 'string');
		assert.ok(m.id.length > 0);
		assert.equal(typeof m.name, 'string');
		assert.ok(m.name.length > 0);
		// 最必须运行元数据：推理模型须标 true（缺省会被当普通模型）、窗口/上限须为正数
		assert.equal(m.reasoning, true);
		assert.ok(m.contextWindow > 0);
		assert.ok(m.maxTokens > 0);
		// portal 走 token plan，不维护价格
		assert.equal(m.cost, undefined);
	}
});

// === getPortalModels ===

test('getPortalModels: returns the list for a known provider', () => {
	assert.deepEqual(getPortalModels('minimax-portal'), EXPECTED);
});

test('getPortalModels: unknown provider → []', () => {
	assert.deepEqual(getPortalModels('nope'), []);
});

test('getPortalModels: returns a deep copy (caller mutation cannot poison the shared table)', () => {
	const a = getPortalModels('minimax-portal');
	a[0].id = 'HACKED';
	a[0].reasoning = false;
	a.push({ id: 'X', name: 'X' });
	// 再取一次仍是原值
	assert.deepEqual(getPortalModels('minimax-portal'), EXPECTED);
});

// === portalModelsCoveredById ===

test('portalModelsCoveredById: identical lists → covered', () => {
	const t = getPortalModels('minimax-portal');
	assert.equal(portalModelsCoveredById(t, getPortalModels('minimax-portal')), true);
});

test('portalModelsCoveredById: order does not matter', () => {
	const t = getPortalModels('minimax-portal');
	const reversed = [...t].reverse();
	assert.equal(portalModelsCoveredById(reversed, t), true);
});

test('portalModelsCoveredById: current is a superset (extra models from another source) → covered', () => {
	const t = getPortalModels('minimax-portal');
	const superset = [...t, { id: 'MiniMax-M2.5', name: 'MiniMax M2.5' }, { id: 'MiniMax-Other', name: 'Other' }];
	assert.equal(portalModelsCoveredById(superset, t), true);
});

test('portalModelsCoveredById: matched by id only — different name/metadata still covered', () => {
	const t = getPortalModels('minimax-portal');
	// 别的来源用不同 name / 参数写了我们的 id：仍判已覆盖
	const drift = [
		{ id: t[0].id, name: 'OLD NAME', reasoning: false },
		{ id: t[1].id, name: t[1].name, contextWindow: 1 },
	];
	assert.equal(portalModelsCoveredById(drift, t), true);
});

test('portalModelsCoveredById: current missing one of the target ids → not covered', () => {
	const t = getPortalModels('minimax-portal');
	assert.equal(portalModelsCoveredById([t[0]], t), false);
	// 完全是别的 id 也不覆盖
	assert.equal(portalModelsCoveredById([{ id: 'MiniMax-M2', name: 'MiniMax M2' }], t), false);
});

test('portalModelsCoveredById: empty current → not covered (non-empty target)', () => {
	const t = getPortalModels('minimax-portal');
	assert.equal(portalModelsCoveredById([], t), false);
});

test('portalModelsCoveredById: non-array current (missing / garbage) treated as empty → not covered', () => {
	const t = getPortalModels('minimax-portal');
	assert.equal(portalModelsCoveredById(undefined, t), false);
	assert.equal(portalModelsCoveredById(null, t), false);
	assert.equal(portalModelsCoveredById('garbage', t), false);
});

test('portalModelsCoveredById: dirty current entries (null/garbage) do not crash; matched by id', () => {
	const t = getPortalModels('minimax-portal');
	const dirty = [null, 'garbage', { id: t[0].id }, { id: t[1].id }];
	assert.equal(portalModelsCoveredById(dirty, t), true);
});

test('portalModelsCoveredById: non-array target (undefined / null / garbage) → false', () => {
	assert.equal(portalModelsCoveredById([], undefined), false);
	assert.equal(portalModelsCoveredById([], null), false);
	assert.equal(portalModelsCoveredById([], 'garbage'), false);
});

test('portalModelsCoveredById: empty target → vacuously covered', () => {
	assert.equal(portalModelsCoveredById([], []), true);
	assert.equal(portalModelsCoveredById(undefined, []), true);
});
