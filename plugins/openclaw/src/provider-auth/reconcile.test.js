import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcilePortalModels } from './reconcile.js';
import { getPortalModels } from './portal-model-catalog.js';

const TARGET = getPortalModels('minimax-portal');

// 造一份带 minimax-portal 节点的 cfg；models 由调用方给（缺省用 target，即"已一致"）
function makeCfg(models = TARGET) {
	return {
		models: {
			providers: {
				'minimax-portal': {
					baseUrl: 'https://api.minimaxi.com/anthropic',
					api: 'anthropic-messages',
					authHeader: true,
					models,
				},
			},
		},
	};
}

// 收集 mutateConfigFile 调用；defaultDraft 让调用方决定 mutate 跑在什么 draft 上
function makeMutate(draftFactory) {
	const calls = [];
	const mutateConfigFile = async ({ afterWrite, mutate }) => {
		const draft = draftFactory();
		mutate(draft);
		calls.push({ afterWrite, draft });
	};
	return { mutateConfigFile, calls };
}

test('reconcile: getConfig returns null → no-config, no write', async () => {
	const { mutateConfigFile, calls } = makeMutate(() => makeCfg());
	const r = await reconcilePortalModels({ getConfig: () => null, mutateConfigFile });
	assert.deepEqual(r, { changed: false, reason: 'no-config' });
	assert.equal(calls.length, 0);
});

test('reconcile: getConfig missing / non-object → no-config', async () => {
	const { mutateConfigFile, calls } = makeMutate(() => makeCfg());
	assert.deepEqual(await reconcilePortalModels({ getConfig: () => undefined, mutateConfigFile }), { changed: false, reason: 'no-config' });
	assert.deepEqual(await reconcilePortalModels({ getConfig: () => 'garbage', mutateConfigFile }), { changed: false, reason: 'no-config' });
	assert.equal(calls.length, 0);
});

test('reconcile: no minimax-portal node (not bound) → not-bound, no write', async () => {
	const { mutateConfigFile, calls } = makeMutate(() => makeCfg());
	const r = await reconcilePortalModels({ getConfig: () => ({ models: { providers: {} } }), mutateConfigFile });
	assert.deepEqual(r, { changed: false, reason: 'not-bound' });
	assert.equal(calls.length, 0);
});

test('reconcile: portal node is null / array (malformed) → not-bound', async () => {
	const { mutateConfigFile, calls } = makeMutate(() => makeCfg());
	assert.deepEqual(
		await reconcilePortalModels({ getConfig: () => ({ models: { providers: { 'minimax-portal': null } } }), mutateConfigFile }),
		{ changed: false, reason: 'not-bound' },
	);
	assert.deepEqual(
		await reconcilePortalModels({ getConfig: () => ({ models: { providers: { 'minimax-portal': ['bad'] } } }), mutateConfigFile }),
		{ changed: false, reason: 'not-bound' },
	);
	assert.equal(calls.length, 0);
});

test('reconcile: unknown providerId (empty catalog) → no-catalog, leaves config alone', async () => {
	const cfg = { models: { providers: { 'other-portal': { models: [] } } } };
	const { mutateConfigFile, calls } = makeMutate(() => cfg);
	const r = await reconcilePortalModels({ getConfig: () => cfg, mutateConfigFile, providerId: 'other-portal' });
	assert.deepEqual(r, { changed: false, reason: 'no-catalog' });
	assert.equal(calls.length, 0);
});

test('reconcile: config already matches table → in-sync, no write (restart-loop guard)', async () => {
	const { mutateConfigFile, calls } = makeMutate(() => makeCfg());
	const r = await reconcilePortalModels({ getConfig: () => makeCfg(), mutateConfigFile });
	assert.deepEqual(r, { changed: false, reason: 'in-sync' });
	assert.equal(calls.length, 0); // 一致就一字不写
});

test('reconcile: in-sync holds even when config order differs from table', async () => {
	const reversed = [...TARGET].reverse();
	const { mutateConfigFile, calls } = makeMutate(() => makeCfg(reversed));
	const r = await reconcilePortalModels({ getConfig: () => makeCfg(reversed), mutateConfigFile });
	assert.deepEqual(r, { changed: false, reason: 'in-sync' });
	assert.equal(calls.length, 0);
});

test('reconcile: config is a superset (our ids present + extras from another source) → in-sync, no write', async () => {
	// 模拟官方 MiniMax 插件往同一 provider 多写了几个模型：我们的 id 都在 → 不去覆盖它
	const superset = [...TARGET, { id: 'MiniMax-M2.5', name: 'MiniMax M2.5' }, { id: 'MiniMax-Other', name: 'Other' }];
	const { mutateConfigFile, calls } = makeMutate(() => makeCfg(superset));
	const r = await reconcilePortalModels({ getConfig: () => makeCfg(superset), mutateConfigFile });
	assert.deepEqual(r, { changed: false, reason: 'in-sync' });
	assert.equal(calls.length, 0); // 超集也不写——避免和别的来源来回覆盖
});

test('reconcile: config has our ids but drifted name/metadata → still in-sync (covered by id), no write', async () => {
	const drifted = [
		{ id: 'MiniMax-M2.7', name: 'Different Name', reasoning: false },
		{ id: 'MiniMax-M2.7-highspeed', name: 'Another', contextWindow: 1 },
	];
	const { mutateConfigFile, calls } = makeMutate(() => makeCfg(drifted));
	const r = await reconcilePortalModels({ getConfig: () => makeCfg(drifted), mutateConfigFile });
	assert.deepEqual(r, { changed: false, reason: 'in-sync' });
	assert.equal(calls.length, 0);
});

test('reconcile: config missing one of our ids (upgrade added a model / partial config) → updated, writes full table', async () => {
	// 只有我们的一个 id，另一个缺 → 不被覆盖 → 补写整份静态表
	const partial = makeCfg([{ id: 'MiniMax-M2.7', name: 'MiniMax M2.7' }]);
	const { mutateConfigFile, calls } = makeMutate(() => structuredClone(partial));
	const r = await reconcilePortalModels({ getConfig: () => partial, mutateConfigFile });
	assert.deepEqual(r, { changed: true, reason: 'updated' });
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].draft.models.providers['minimax-portal'].models, TARGET);
});

test('reconcile: portal node present but models missing/garbage → not covered → updated, writes full table', async () => {
	// 节点在、但 models 字段缺失（半截写 / 手改 config）→ 不被覆盖 → 补写
	const malformed = { models: { providers: { 'minimax-portal': { baseUrl: 'b', api: 'anthropic-messages', authHeader: true } } } };
	const { mutateConfigFile, calls } = makeMutate(() => structuredClone(malformed));
	const r = await reconcilePortalModels({ getConfig: () => malformed, mutateConfigFile });
	assert.deepEqual(r, { changed: true, reason: 'updated' });
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].draft.models.providers['minimax-portal'].models, TARGET);
});

test('reconcile: config stale (old models) → updated, writes the static table, keeps connection fields', async () => {
	const stale = makeCfg([{ id: 'MiniMax-M2', name: 'MiniMax M2' }]);
	const { mutateConfigFile, calls } = makeMutate(() => structuredClone(stale));
	const r = await reconcilePortalModels({ getConfig: () => stale, mutateConfigFile });
	assert.deepEqual(r, { changed: true, reason: 'updated' });
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].afterWrite, { mode: 'auto' });
	const written = calls[0].draft.models.providers['minimax-portal'];
	assert.deepEqual(written.models, TARGET);
	// 连接字段保留（只刷新 models）
	assert.equal(written.baseUrl, 'https://api.minimaxi.com/anthropic');
	assert.equal(written.api, 'anthropic-messages');
	assert.equal(written.authHeader, true);
});

test('reconcile: update preserves sibling providers (only rewrites the portal node models)', async () => {
	// 旁边坐一个用户自配 provider；对账刷新 minimax-portal 时不能把它抹掉/重建
	const sibling = { baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages', models: [{ id: 'claude', name: 'Claude' }] };
	const stale = {
		models: {
			providers: {
				anthropic: structuredClone(sibling),
				'minimax-portal': { baseUrl: 'b', api: 'anthropic-messages', authHeader: true, models: [{ id: 'MiniMax-M2', name: 'MiniMax M2' }] },
			},
		},
	};
	const { mutateConfigFile, calls } = makeMutate(() => structuredClone(stale));
	const r = await reconcilePortalModels({ getConfig: () => stale, mutateConfigFile });
	assert.deepEqual(r, { changed: true, reason: 'updated' });
	assert.equal(calls.length, 1);
	const providers = calls[0].draft.models.providers;
	// 旁边的 provider 原样保留（没被重建 providers map 抹掉）
	assert.deepEqual(providers.anthropic, sibling);
	// 只有 minimax-portal 被刷成静态表
	assert.deepEqual(providers['minimax-portal'].models, TARGET);
});

test('reconcile: node vanished between read and write (TOCTOU) → mutate is a no-op, does not recreate node', async () => {
	// getConfig 看到 stale 节点 → 决定要写；但 mutateConfigFile 的 draft 里节点已被并发删
	const stale = makeCfg([{ id: 'MiniMax-M2', name: 'MiniMax M2' }]);
	const { mutateConfigFile, calls } = makeMutate(() => ({ models: { providers: {} } }));
	const r = await reconcilePortalModels({ getConfig: () => stale, mutateConfigFile });
	assert.deepEqual(r, { changed: true, reason: 'updated' }); // 走了写路径
	assert.equal(calls.length, 1);
	// 但不无中生有重建节点
	assert.equal(calls[0].draft.models.providers['minimax-portal'], undefined);
});
