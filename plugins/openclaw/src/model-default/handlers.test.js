import test from 'node:test';
import assert from 'node:assert/strict';

import { buildModelDefaultHandlers } from './handlers.js';

function makeRespond() {
	const calls = [];
	function respond(ok, payload, error) {
		calls.push({ ok, payload, error });
	}
	return { respond, calls };
}

function makeSdk(overrides = {}) {
	const mutateCalls = [];
	const sdk = {
		mutateConfigFile: async ({ mutate }) => {
			const draft = structuredClone(sdk.__cfg ?? {});
			await mutate(draft, { snapshot: {}, previousHash: null });
			mutateCalls.push(draft);
			sdk.__cfg = draft;
			return { result: undefined };
		},
		buildModelsProviderData: async () => ({
			byProvider: new Map([
				['openai-codex', new Set(['gpt-5.5', 'gpt-4o'])],
				['anthropic', new Set(['claude-opus-4-7'])],
			]),
		}),
		isProviderAuthProfileConfigured: () => true,
		__cfg: {},
		__mutateCalls: mutateCalls,
		...overrides,
	};
	return sdk;
}

function makeHandlers({ sdk, cfg, agentDir = '/fake/agents/main/agent' }) {
	const effectiveSdk = sdk ?? makeSdk();
	if (cfg !== undefined) effectiveSdk.__cfg = cfg;
	return {
		handlers: buildModelDefaultHandlers({
			sdk: effectiveSdk,
			loadConfig: () => effectiveSdk.__cfg,
			resolveAgentDir: () => agentDir,
		}),
		sdk: effectiveSdk,
	};
}

// ============ set: 入参校验 ============

test('set: params 非 object → INVALID_ARGS', async () => {
	const { handlers } = makeHandlers({});
	const r = makeRespond();
	await handlers.set({ params: null, respond: r.respond });
	assert.equal(r.calls[0].ok, false);
	assert.equal(r.calls[0].error.code, 'INVALID_ARGS');
	assert.match(r.calls[0].error.message, /params must be an object/);
});

test('set: params 是 array → INVALID_ARGS', async () => {
	const { handlers } = makeHandlers({});
	const r = makeRespond();
	await handlers.set({ params: [], respond: r.respond });
	assert.equal(r.calls[0].error.code, 'INVALID_ARGS');
});

test('set: 未知字段 → INVALID_ARGS', async () => {
	const { handlers } = makeHandlers({});
	const r = makeRespond();
	await handlers.set({ params: { primary: 'a/b', extra: 1 }, respond: r.respond });
	assert.equal(r.calls[0].error.code, 'INVALID_ARGS');
	assert.match(r.calls[0].error.message, /unknown field: extra/);
});

test('set: agentId 非空 string 检查', async () => {
	const { handlers } = makeHandlers({});
	const r = makeRespond();
	await handlers.set({ params: { agentId: '', primary: 'a/b' }, respond: r.respond });
	assert.equal(r.calls[0].error.code, 'INVALID_ARGS');
	assert.match(r.calls[0].error.message, /agentId/);
});

test('set: agentId 类型错 → INVALID_ARGS', async () => {
	const { handlers } = makeHandlers({});
	const r = makeRespond();
	await handlers.set({ params: { agentId: 123, primary: 'a/b' }, respond: r.respond });
	assert.equal(r.calls[0].error.code, 'INVALID_ARGS');
});

test('set: primary 字段必传', async () => {
	const { handlers } = makeHandlers({});
	const r = makeRespond();
	await handlers.set({ params: { agentId: 'r' }, respond: r.respond });
	assert.equal(r.calls[0].error.code, 'INVALID_ARGS');
	assert.match(r.calls[0].error.message, /primary is required/);
});

test('set: primary 类型错（数字）→ INVALID_ARGS', async () => {
	const { handlers } = makeHandlers({});
	const r = makeRespond();
	await handlers.set({ params: { primary: 42 }, respond: r.respond });
	assert.equal(r.calls[0].error.code, 'INVALID_ARGS');
	assert.match(r.calls[0].error.message, /string or null/);
});

test('set: primary 空字符串 → INVALID_ARGS', async () => {
	const { handlers } = makeHandlers({});
	const r = makeRespond();
	await handlers.set({ params: { primary: '' }, respond: r.respond });
	assert.equal(r.calls[0].error.code, 'INVALID_ARGS');
});

test('set: primary 没 "/" → INVALID_ARGS', async () => {
	const { handlers } = makeHandlers({});
	const r = makeRespond();
	await handlers.set({ params: { primary: 'just-model' }, respond: r.respond });
	assert.equal(r.calls[0].error.code, 'INVALID_ARGS');
	assert.match(r.calls[0].error.message, /<provider>\/<model>/);
});

test('set: primary "/" 在开头 → INVALID_ARGS', async () => {
	const { handlers } = makeHandlers({});
	const r = makeRespond();
	await handlers.set({ params: { primary: '/model' }, respond: r.respond });
	assert.equal(r.calls[0].error.code, 'INVALID_ARGS');
});

test('set: primary "/" 在结尾 → INVALID_ARGS', async () => {
	const { handlers } = makeHandlers({});
	const r = makeRespond();
	await handlers.set({ params: { primary: 'provider/' }, respond: r.respond });
	assert.equal(r.calls[0].error.code, 'INVALID_ARGS');
});

test('set: provider 没凭据 → INVALID_ARGS', async () => {
	const sdk = makeSdk({ isProviderAuthProfileConfigured: () => false });
	const { handlers } = makeHandlers({ sdk });
	const r = makeRespond();
	await handlers.set({ params: { primary: 'openai-codex/gpt-5.5' }, respond: r.respond });
	assert.equal(r.calls[0].error.code, 'INVALID_ARGS');
	assert.match(r.calls[0].error.message, /no usable auth profile/);
});

test('set: model 不在 catalog → INVALID_ARGS', async () => {
	const { handlers } = makeHandlers({});
	const r = makeRespond();
	await handlers.set({ params: { primary: 'openai-codex/unknown-model' }, respond: r.respond });
	assert.equal(r.calls[0].error.code, 'INVALID_ARGS');
	assert.match(r.calls[0].error.message, /not found in catalog/);
});

test('set: catalog 完全没该 provider → INVALID_ARGS', async () => {
	const { handlers } = makeHandlers({});
	const r = makeRespond();
	await handlers.set({ params: { primary: 'mystery/foo' }, respond: r.respond });
	assert.equal(r.calls[0].error.code, 'INVALID_ARGS');
});

// ============ set: 写盘成功 ============

test('set: 合法 primary default scope → 写盘 + respond(true, {})', async () => {
	const { handlers, sdk } = makeHandlers({});
	const r = makeRespond();
	await handlers.set({ params: { primary: 'openai-codex/gpt-5.5' }, respond: r.respond });
	assert.equal(r.calls[0].ok, true);
	assert.deepEqual(r.calls[0].payload, {});
	assert.deepEqual(sdk.__mutateCalls[0].agents.defaults.model, {
		primary: 'openai-codex/gpt-5.5',
	});
});

test('set: 合法 primary per-agent scope', async () => {
	const sdk = makeSdk();
	sdk.__cfg = { agents: { list: [{ id: 'r', model: { primary: 'old/a' } }] } };
	const { handlers } = makeHandlers({ sdk });
	const r = makeRespond();
	await handlers.set({
		params: { agentId: 'r', primary: 'openai-codex/gpt-5.5' },
		respond: r.respond,
	});
	assert.equal(r.calls[0].ok, true);
	assert.deepEqual(sdk.__mutateCalls[0].agents.list[0].model, {
		primary: 'openai-codex/gpt-5.5',
	});
});

test('set: primary=null default scope 跳过校验 → 直接清', async () => {
	const sdk = makeSdk();
	sdk.__cfg = { agents: { defaults: { model: { primary: 'old/a' } } } };
	// 即便凭据/catalog 都报"无效"也允许清——因为 primary=null 跳过校验
	sdk.isProviderAuthProfileConfigured = () => false;
	const { handlers } = makeHandlers({ sdk });
	const r = makeRespond();
	await handlers.set({ params: { primary: null }, respond: r.respond });
	assert.equal(r.calls[0].ok, true);
	assert.deepEqual(sdk.__mutateCalls[0].agents.defaults, {});
});

test('set: primary=null per-agent scope 不存在 entry → 安静成功（无写）', async () => {
	const sdk = makeSdk();
	sdk.__cfg = { agents: { list: [] } };
	const { handlers } = makeHandlers({ sdk });
	const r = makeRespond();
	await handlers.set({
		params: { agentId: 'nonexistent', primary: null },
		respond: r.respond,
	});
	assert.equal(r.calls[0].ok, true);
	// mutate 跑了但 list 不动
	assert.deepEqual(sdk.__mutateCalls[0].agents.list, []);
});

// ============ set: 错误路径 ============

test('set: loadConfig 返回 null → IO_FAILED', async () => {
	const sdk = makeSdk();
	const handlers = buildModelDefaultHandlers({
		sdk,
		loadConfig: () => null,
		resolveAgentDir: () => '/x',
	});
	const r = makeRespond();
	await handlers.set({ params: { primary: 'openai-codex/gpt-5.5' }, respond: r.respond });
	assert.equal(r.calls[0].error.code, 'IO_FAILED');
	assert.match(r.calls[0].error.message, /runtime config not available/);
});

test('set: mutateConfigFile 抛错 → IO_FAILED', async () => {
	const sdk = makeSdk({
		mutateConfigFile: async () => { throw new Error('disk full'); },
	});
	const { handlers } = makeHandlers({ sdk });
	const r = makeRespond();
	await handlers.set({ params: { primary: 'openai-codex/gpt-5.5' }, respond: r.respond });
	assert.equal(r.calls[0].error.code, 'IO_FAILED');
	assert.match(r.calls[0].error.message, /disk full/);
});

test('set: mutateConfigFile 抛非 Error 字符串 → message 走 ?? err 兜底', async () => {
	const sdk = makeSdk({
		mutateConfigFile: async () => { throw 'boom-as-string'; },
	});
	const { handlers } = makeHandlers({ sdk });
	const r = makeRespond();
	await handlers.set({ params: { primary: 'openai-codex/gpt-5.5' }, respond: r.respond });
	assert.equal(r.calls[0].error.code, 'IO_FAILED');
	assert.equal(r.calls[0].error.message, 'boom-as-string');
});

test('set: buildModelsProviderData 抛错 → IO_FAILED', async () => {
	const sdk = makeSdk({
		buildModelsProviderData: async () => { throw new Error('catalog load failed'); },
	});
	const { handlers } = makeHandlers({ sdk });
	const r = makeRespond();
	await handlers.set({ params: { primary: 'openai-codex/gpt-5.5' }, respond: r.respond });
	assert.equal(r.calls[0].error.code, 'IO_FAILED');
});

test('set: isProviderAuthProfileConfigured 抛错 → IO_FAILED', async () => {
	const sdk = makeSdk({
		isProviderAuthProfileConfigured: () => { throw new Error('cred check failed'); },
	});
	const { handlers } = makeHandlers({ sdk });
	const r = makeRespond();
	await handlers.set({ params: { primary: 'openai-codex/gpt-5.5' }, respond: r.respond });
	assert.equal(r.calls[0].error.code, 'IO_FAILED');
});

// ============ list ============

test('list: 完整 cfg → 出参对称 default + agents', async () => {
	const sdk = makeSdk();
	sdk.__cfg = {
		agents: {
			defaults: { model: 'openai-codex/gpt-5.5' },
			list: [
				{ id: 'main' },
				{ id: 'researcher', model: { primary: 'anthropic/claude-opus-4-7' } },
			],
		},
	};
	const { handlers } = makeHandlers({ sdk });
	const r = makeRespond();
	await handlers.list({ respond: r.respond });
	assert.equal(r.calls[0].ok, true);
	assert.deepEqual(r.calls[0].payload, {
		default: { primary: 'openai-codex/gpt-5.5' },
		agents: {
			main: { primary: null },
			researcher: { primary: 'anthropic/claude-opus-4-7' },
		},
	});
});

test('list: cfg 没有 list 时补 main', async () => {
	const sdk = makeSdk();
	sdk.__cfg = { agents: { defaults: { model: 'a/b' } } };
	const { handlers } = makeHandlers({ sdk });
	const r = makeRespond();
	await handlers.list({ respond: r.respond });
	assert.deepEqual(r.calls[0].payload.agents, { main: { primary: null } });
});

test('list: 出参不带 status wrap（payload 顶层就是 default + agents）', async () => {
	const { handlers } = makeHandlers({});
	const r = makeRespond();
	await handlers.list({ respond: r.respond });
	assert.equal(Object.hasOwn(r.calls[0].payload, 'status'), false);
	assert.equal(Object.hasOwn(r.calls[0].payload, 'default'), true);
	assert.equal(Object.hasOwn(r.calls[0].payload, 'agents'), true);
});

test('list: loadConfig 返回 null → IO_FAILED', async () => {
	const handlers = buildModelDefaultHandlers({
		sdk: makeSdk(),
		loadConfig: () => null,
		resolveAgentDir: () => '/x',
	});
	const r = makeRespond();
	await handlers.list({ respond: r.respond });
	assert.equal(r.calls[0].error.code, 'IO_FAILED');
});

test('list: loadConfig 抛错 → IO_FAILED', async () => {
	const handlers = buildModelDefaultHandlers({
		sdk: makeSdk(),
		loadConfig: () => { throw new Error('rt missing'); },
		resolveAgentDir: () => '/x',
	});
	const r = makeRespond();
	await handlers.list({ respond: r.respond });
	assert.equal(r.calls[0].error.code, 'IO_FAILED');
});

// ============ set 出参形态：不带 status wrap ============

test('set: 成功 payload 不带 status wrap', async () => {
	const { handlers } = makeHandlers({});
	const r = makeRespond();
	await handlers.set({ params: { primary: 'openai-codex/gpt-5.5' }, respond: r.respond });
	assert.deepEqual(r.calls[0].payload, {});
	assert.equal(Object.hasOwn(r.calls[0].payload, 'status'), false);
});

// ============ 校验顺序：先 agentId 后 primary ============

test('set: 同时 agentId 非法 + primary 缺失 → 先报 agentId', async () => {
	const { handlers } = makeHandlers({});
	const r = makeRespond();
	await handlers.set({ params: { agentId: '' }, respond: r.respond });
	assert.match(r.calls[0].error.message, /agentId/);
});

test('set: cfg 不可读 + primary 形态非法 → INVALID_ARGS（形态校验前置在 loadConfig 之前）', async () => {
	const handlers = buildModelDefaultHandlers({
		sdk: makeSdk(),
		loadConfig: () => null,
		resolveAgentDir: () => '/x',
	});
	const r = makeRespond();
	await handlers.set({ params: { primary: 'no-slash' }, respond: r.respond });
	assert.equal(r.calls[0].ok, false);
	assert.equal(r.calls[0].error.code, 'INVALID_ARGS');
	assert.match(r.calls[0].error.message, /<provider>\/<model>/);
});

// ============ 调用 sdk 的入参形态 ============

test('set: 调 isProviderAuthProfileConfigured 时传入 cfg + agentDir', async () => {
	const calls = [];
	const sdk = makeSdk({
		isProviderAuthProfileConfigured: (params) => {
			calls.push(params);
			return true;
		},
	});
	const { handlers } = makeHandlers({ sdk, cfg: { agents: { list: [] }, mark: 'cfg' } });
	const r = makeRespond();
	await handlers.set({ params: { primary: 'openai-codex/gpt-5.5' }, respond: r.respond });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].provider, 'openai-codex');
	assert.equal(calls[0].agentDir, '/fake/agents/main/agent');
	assert.equal(calls[0].cfg.mark, 'cfg');
});

test('set: 调 buildModelsProviderData 时使用 view: all', async () => {
	const calls = [];
	const sdk = makeSdk({
		buildModelsProviderData: async (cfg, agentId, opts) => {
			calls.push({ cfg, agentId, opts });
			return {
				byProvider: new Map([['openai-codex', new Set(['gpt-5.5'])]]),
			};
		},
	});
	const { handlers } = makeHandlers({ sdk });
	const r = makeRespond();
	await handlers.set({ params: { primary: 'openai-codex/gpt-5.5' }, respond: r.respond });
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].opts, { view: 'all' });
	assert.equal(calls[0].agentId, undefined);
});

// ============ list/set 出参形态对称（设计意图）============

test('list+set: list 出参的 agents map 形状与 default 对称', async () => {
	const { handlers } = makeHandlers({});
	const r = makeRespond();
	await handlers.list({ respond: r.respond });
	const { default: def, agents } = r.calls[0].payload;
	// 两边都是 { primary: ... } 形状
	assert.deepEqual(Object.keys(def).sort(), ['primary']);
	for (const v of Object.values(agents)) {
		assert.deepEqual(Object.keys(v).sort(), ['primary']);
	}
});
