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
		// list 凭据信号默认：env/账本无、内联无、账本空 → providerUsable / hasAny 均 false
		isProviderApiKeyConfigured: () => false,
		hasConfiguredSecretInput: () => false,
		ensureAuthProfileStore: () => ({ profiles: {} }),
		// 别名归一默认 identity（测试里不涉及别名时等价于精确名比较）
		resolveProviderIdForAuth: (p) => p,
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

test('set: primary 尾随空格 → trim 后通过校验并按 trim 值落盘', async () => {
	const { handlers, sdk } = makeHandlers({});
	const r = makeRespond();
	await handlers.set({ params: { primary: 'openai-codex/gpt-5.5 ' }, respond: r.respond });
	assert.equal(r.calls[0].ok, true);
	assert.deepEqual(sdk.__mutateCalls[0].agents.defaults.model, {
		primary: 'openai-codex/gpt-5.5',
	});
});

test('set: primary 前后均有空格 → trim 后通过校验', async () => {
	const { handlers, sdk } = makeHandlers({});
	const r = makeRespond();
	await handlers.set({ params: { primary: '  openai-codex/gpt-5.5  ' }, respond: r.respond });
	assert.equal(r.calls[0].ok, true);
	assert.deepEqual(sdk.__mutateCalls[0].agents.defaults.model, {
		primary: 'openai-codex/gpt-5.5',
	});
});

test('set: primary 全为空白 → trim 后空 → INVALID_ARGS（非空字符串）', async () => {
	const { handlers } = makeHandlers({});
	const r = makeRespond();
	await handlers.set({ params: { primary: '   ' }, respond: r.respond });
	assert.equal(r.calls[0].error.code, 'INVALID_ARGS');
	assert.match(r.calls[0].error.message, /non-empty string or null/);
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
		default: { primary: 'openai-codex/gpt-5.5', providerUsable: false },
		agents: {
			main: { primary: null, providerUsable: false },
			researcher: { primary: 'anthropic/claude-opus-4-7', providerUsable: false },
		},
		hasAnyUsableCredential: false,
	});
});

test('list: cfg 没有 list 时补 main', async () => {
	const sdk = makeSdk();
	sdk.__cfg = { agents: { defaults: { model: 'a/b' } } };
	const { handlers } = makeHandlers({ sdk });
	const r = makeRespond();
	await handlers.list({ respond: r.respond });
	assert.deepEqual(r.calls[0].payload.agents, { main: { primary: null, providerUsable: false } });
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
	// 两边都是 { primary, providerUsable } 形状
	assert.deepEqual(Object.keys(def).sort(), ['primary', 'providerUsable']);
	for (const v of Object.values(agents)) {
		assert.deepEqual(Object.keys(v).sort(), ['primary', 'providerUsable']);
	}
});

// ============ 端到端串联：set→list / 并存清除 ============

test('set→list: 先 set default scope 再 list，default.primary 反映刚写入的值', async () => {
	const sdk = makeSdk();
	const { handlers } = makeHandlers({ sdk });
	const r1 = makeRespond();
	await handlers.set({ params: { primary: 'openai-codex/gpt-5.5' }, respond: r1.respond });
	assert.equal(r1.calls[0].ok, true);

	const r2 = makeRespond();
	await handlers.list({ respond: r2.respond });
	assert.equal(r2.calls[0].ok, true);
	assert.equal(r2.calls[0].payload.default.primary, 'openai-codex/gpt-5.5');
	// main agent 自动补一条 primary=null（list 永远包含 main）
	assert.deepEqual(r2.calls[0].payload.agents.main, { primary: null, providerUsable: false });
});

test('clear path: global default + per-agent override 并存时，清 per-agent 不影响 global default', async () => {
	const sdk = makeSdk();
	sdk.__cfg = {
		agents: {
			defaults: { model: { primary: 'openai-codex/gpt-5.5' } },
			list: [{ id: 'researcher', model: { primary: 'anthropic/claude-opus-4-7' } }],
		},
	};
	const { handlers } = makeHandlers({ sdk });

	// 清 researcher 这条 override
	const r1 = makeRespond();
	await handlers.set({
		params: { agentId: 'researcher', primary: null },
		respond: r1.respond,
	});
	assert.equal(r1.calls[0].ok, true);

	// list 应仍看到 global default 不变，researcher 变成 primary=null
	const r2 = makeRespond();
	await handlers.list({ respond: r2.respond });
	assert.equal(r2.calls[0].payload.default.primary, 'openai-codex/gpt-5.5');
	assert.deepEqual(r2.calls[0].payload.agents.researcher, { primary: null, providerUsable: false });
	// main 仍由 list 自动补
	assert.deepEqual(r2.calls[0].payload.agents.main, { primary: null, providerUsable: false });
});

// ============ list: 凭据信号（providerUsable / hasAnyUsableCredential）============

test('list: env/账本认得该 provider → providerUsable=true', async () => {
	const sdk = makeSdk({
		isProviderApiKeyConfigured: ({ provider }) => provider === 'openai-codex',
	});
	sdk.__cfg = { agents: { defaults: { model: 'openai-codex/gpt-5.5' } } };
	const { handlers } = makeHandlers({ sdk });
	const r = makeRespond();
	await handlers.list({ respond: r.respond });
	assert.equal(r.calls[0].payload.default.providerUsable, true);
});

test('list: 仅内联 key（env/账本均无）→ providerUsable=true', async () => {
	const sdk = makeSdk({
		isProviderApiKeyConfigured: () => false,
		hasConfiguredSecretInput: (v) => v === 'sk-inline',
	});
	sdk.__cfg = {
		agents: { defaults: { model: 'minimax/MiniMax-M2.7' } },
		models: { providers: { minimax: { apiKey: 'sk-inline' } } },
	};
	const { handlers } = makeHandlers({ sdk });
	const r = makeRespond();
	await handlers.list({ respond: r.respond });
	assert.equal(r.calls[0].payload.default.providerUsable, true);
	assert.equal(r.calls[0].payload.hasAnyUsableCredential, true);
});

test('list: 别名套餐内联 key（持基座 volcengine 内联 key → volcengine-plan primary providerUsable=true）', async () => {
	// 钉住 list deps 把 resolveProviderIdForAuth 接进来：两侧归一后基座 key 点亮变体 primary
	const sdk = makeSdk({
		isProviderApiKeyConfigured: () => false,
		hasConfiguredSecretInput: (v) => v === 'sk-volc',
		resolveProviderIdForAuth: (p) => (p === 'volcengine-plan' ? 'volcengine' : p),
	});
	sdk.__cfg = {
		agents: { defaults: { model: 'volcengine-plan/ark-code-latest' } },
		models: { providers: { volcengine: { apiKey: 'sk-volc' } } },
	};
	const { handlers } = makeHandlers({ sdk });
	const r = makeRespond();
	await handlers.list({ respond: r.respond });
	assert.equal(r.calls[0].payload.default.providerUsable, true);
	assert.equal(r.calls[0].payload.hasAnyUsableCredential, true);
});

test('list: 纯 env-only（账本/内联空，env 命中主模型段）→ hasAnyUsableCredential=true（必补 C）', async () => {
	const sdk = makeSdk({
		isProviderApiKeyConfigured: ({ provider }) => provider === 'openai-codex',
	});
	sdk.__cfg = { agents: { defaults: { model: 'openai-codex/gpt-5.5' } } };
	const { handlers } = makeHandlers({ sdk });
	const r = makeRespond();
	await handlers.list({ respond: r.respond });
	assert.equal(r.calls[0].payload.hasAnyUsableCredential, true);
	assert.equal(r.calls[0].payload.default.providerUsable, true);
});

test('list: primary 那家 provider 无任何凭据 → providerUsable=false', async () => {
	const sdk = makeSdk();
	sdk.__cfg = { agents: { defaults: { model: 'minimax/MiniMax-M2.7' } } };
	const { handlers } = makeHandlers({ sdk });
	const r = makeRespond();
	await handlers.list({ respond: r.respond });
	assert.equal(r.calls[0].payload.default.providerUsable, false);
});

test('list: primary=null → providerUsable=false（不调凭据判定）', async () => {
	let apiKeyCalls = 0;
	const sdk = makeSdk({
		isProviderApiKeyConfigured: () => { apiKeyCalls += 1; return true; },
	});
	sdk.__cfg = { agents: {} };
	const { handlers } = makeHandlers({ sdk });
	const r = makeRespond();
	await handlers.list({ respond: r.respond });
	assert.equal(r.calls[0].payload.agents.main.providerUsable, false);
	assert.equal(apiKeyCalls, 0);
});

test('list: 账本非空 → hasAnyUsableCredential=true（无内联也成立）', async () => {
	const sdk = makeSdk({
		ensureAuthProfileStore: () => ({ profiles: { 'openai-codex:default': { provider: 'openai-codex', type: 'api_key' } } }),
	});
	sdk.__cfg = { agents: { defaults: { model: 'openai-codex/gpt-5.5' } } };
	const { handlers } = makeHandlers({ sdk });
	const r = makeRespond();
	await handlers.list({ respond: r.respond });
	assert.equal(r.calls[0].payload.hasAnyUsableCredential, true);
});

test('list: 账本空 + 无内联 → hasAnyUsableCredential=false', async () => {
	const { handlers } = makeHandlers({});
	const r = makeRespond();
	await handlers.list({ respond: r.respond });
	assert.equal(r.calls[0].payload.hasAnyUsableCredential, false);
});

test('list: providerUsable 传入正确 provider 段 + agentDir', async () => {
	const calls = [];
	const sdk = makeSdk({
		isProviderApiKeyConfigured: (params) => { calls.push(params); return false; },
	});
	sdk.__cfg = { agents: { defaults: { model: 'anthropic/claude-opus-4-7' } } };
	const { handlers } = makeHandlers({ sdk, agentDir: '/fake/agents/main/agent' });
	const r = makeRespond();
	await handlers.list({ respond: r.respond });
	assert.ok(calls.some((c) => c.provider === 'anthropic' && c.agentDir === '/fake/agents/main/agent'));
});

test('list: ensureAuthProfileStore 抛错 → IO_FAILED（与 providerAuth.list 同口径）', async () => {
	const sdk = makeSdk({
		ensureAuthProfileStore: () => { throw new Error('store read failed'); },
	});
	sdk.__cfg = { agents: { defaults: { model: 'minimax/x' } } };
	const { handlers } = makeHandlers({ sdk });
	const r = makeRespond();
	await handlers.list({ respond: r.respond });
	assert.equal(r.calls[0].error.code, 'IO_FAILED');
});
