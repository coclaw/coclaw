import test from 'node:test';
import assert from 'node:assert/strict';

import {
	readPrimaryFromModel,
	readDefaultPrimary,
	readAgentPrimary,
	findAgentEntry,
	listAllPrimaries,
	providerSegmentOf,
	computeProviderUsableByName,
	computeProviderUsable,
	computeHasAnyUsableCredential,
	computeConfiguredProviders,
	enumerateUsableModels,
	listAllPrimariesWithCredentials,
	MAIN_AGENT_ID,
} from './resolve.js';

// 凭据信号测试用的 fake deps：默认全否、账本空、别名归一为 identity
function makeCredDeps(overrides = {}) {
	return {
		agentDir: '/fake/agents/main/agent',
		isProviderApiKeyConfigured: () => false,
		hasConfiguredSecretInput: () => false,
		ensureAuthProfileStore: () => ({ profiles: {} }),
		resolveProviderIdForAuth: (p) => p,
		...overrides,
	};
}

test('readPrimaryFromModel: string 形态返回原值', () => {
	assert.equal(readPrimaryFromModel('openai-codex/gpt-5.5'), 'openai-codex/gpt-5.5');
});

test('readPrimaryFromModel: 空字符串返回 null', () => {
	assert.equal(readPrimaryFromModel(''), null);
});

test('readPrimaryFromModel: object 形态有 primary 非空', () => {
	assert.equal(readPrimaryFromModel({ primary: 'anthropic/claude-opus-4-7' }), 'anthropic/claude-opus-4-7');
});

test('readPrimaryFromModel: object 形态 primary 为空字符串', () => {
	assert.equal(readPrimaryFromModel({ primary: '' }), null);
});

test('readPrimaryFromModel: object 形态无 primary（只有 fallbacks）', () => {
	assert.equal(readPrimaryFromModel({ fallbacks: ['anthropic/claude-opus-4-7'] }), null);
});

test('readPrimaryFromModel: object 形态 primary 非 string', () => {
	assert.equal(readPrimaryFromModel({ primary: 123 }), null);
});

test('readPrimaryFromModel: null / undefined / number 返回 null', () => {
	assert.equal(readPrimaryFromModel(null), null);
	assert.equal(readPrimaryFromModel(undefined), null);
	assert.equal(readPrimaryFromModel(42), null);
	assert.equal(readPrimaryFromModel(true), null);
});

test('readDefaultPrimary: cfg.agents.defaults.model = string', () => {
	const cfg = { agents: { defaults: { model: 'openai-codex/gpt-5.5' } } };
	assert.equal(readDefaultPrimary(cfg), 'openai-codex/gpt-5.5');
});

test('readDefaultPrimary: cfg.agents.defaults.model = object', () => {
	const cfg = {
		agents: {
			defaults: {
				model: { primary: 'anthropic/claude-opus-4-7', fallbacks: ['openai-codex/gpt-5.5'] },
			},
		},
	};
	assert.equal(readDefaultPrimary(cfg), 'anthropic/claude-opus-4-7');
});

test('readDefaultPrimary: cfg.agents.defaults 缺 / cfg 缺 / 空对象', () => {
	assert.equal(readDefaultPrimary({}), null);
	assert.equal(readDefaultPrimary({ agents: {} }), null);
	assert.equal(readDefaultPrimary({ agents: { defaults: {} } }), null);
	assert.equal(readDefaultPrimary(null), null);
	assert.equal(readDefaultPrimary(undefined), null);
});

test('readAgentPrimary: 找到 entry 且有 primary', () => {
	const cfg = {
		agents: {
			list: [{ id: 'researcher', model: { primary: 'anthropic/claude-opus-4-7' } }],
		},
	};
	assert.equal(readAgentPrimary(cfg, 'researcher'), 'anthropic/claude-opus-4-7');
});

test('readAgentPrimary: 找到 entry 但 model 缺', () => {
	const cfg = { agents: { list: [{ id: 'researcher' }] } };
	assert.equal(readAgentPrimary(cfg, 'researcher'), null);
});

test('readAgentPrimary: list 中没该 agentId', () => {
	const cfg = { agents: { list: [{ id: 'main', model: 'openai-codex/gpt-5.5' }] } };
	assert.equal(readAgentPrimary(cfg, 'researcher'), null);
});

test('readAgentPrimary: list 不是数组 / cfg 缺', () => {
	assert.equal(readAgentPrimary({ agents: { list: 'oops' } }, 'main'), null);
	assert.equal(readAgentPrimary({}, 'main'), null);
	assert.equal(readAgentPrimary(null, 'main'), null);
});

test('findAgentEntry: list 不是数组返回 null', () => {
	assert.equal(findAgentEntry({ agents: {} }, 'main'), null);
});

test('findAgentEntry: list 含 null entry 不崩', () => {
	const cfg = { agents: { list: [null, { id: 'main', model: 'x/y' }] } };
	assert.deepEqual(findAgentEntry(cfg, 'main'), { id: 'main', model: 'x/y' });
});

test('listAllPrimaries: 完整 cfg 装配 default + agents', () => {
	const cfg = {
		agents: {
			defaults: { model: 'openai-codex/gpt-5.5' },
			list: [
				{ id: 'main' },
				{ id: 'researcher', model: { primary: 'anthropic/claude-opus-4-7' } },
				{ id: 'writer', model: 'minimax/abab' },
			],
		},
	};
	assert.deepEqual(listAllPrimaries(cfg), {
		default: { primary: 'openai-codex/gpt-5.5' },
		agents: {
			main: { primary: null },
			researcher: { primary: 'anthropic/claude-opus-4-7' },
			writer: { primary: 'minimax/abab' },
		},
	});
});

test('listAllPrimaries: cfg 没 list → agents 只有补出来的 main', () => {
	const cfg = { agents: { defaults: { model: 'openai-codex/gpt-5.5' } } };
	assert.deepEqual(listAllPrimaries(cfg), {
		default: { primary: 'openai-codex/gpt-5.5' },
		agents: { main: { primary: null } },
	});
});

test('listAllPrimaries: cfg 完全空 → 补 main, default null', () => {
	assert.deepEqual(listAllPrimaries({}), {
		default: { primary: null },
		agents: { main: { primary: null } },
	});
});

test('listAllPrimaries: cfg 已含 main entry → 不覆盖', () => {
	const cfg = {
		agents: { list: [{ id: 'main', model: 'openai-codex/gpt-5.5' }] },
	};
	assert.deepEqual(listAllPrimaries(cfg), {
		default: { primary: null },
		agents: { main: { primary: 'openai-codex/gpt-5.5' } },
	});
});

test('listAllPrimaries: entry 缺 id / id 空字符串 / id 非 string 跳过', () => {
	const cfg = {
		agents: {
			list: [
				{ model: 'x/y' },
				{ id: '', model: 'x/y' },
				{ id: 123, model: 'x/y' },
				{ id: 'ok', model: 'a/b' },
			],
		},
	};
	const result = listAllPrimaries(cfg);
	assert.deepEqual(Object.keys(result.agents).sort(), ['main', 'ok']);
	assert.deepEqual(result.agents.ok, { primary: 'a/b' });
});

test('MAIN_AGENT_ID 导出常量', () => {
	assert.equal(MAIN_AGENT_ID, 'main');
});

// ============ providerSegmentOf ============

test('providerSegmentOf: 正常 <provider>/<model> 取前段', () => {
	assert.equal(providerSegmentOf('minimax/MiniMax-M2.7'), 'minimax');
	assert.equal(providerSegmentOf('openai-codex/gpt-5.5'), 'openai-codex');
});

test('providerSegmentOf: model 段含多个 / 只取第一个之前', () => {
	assert.equal(providerSegmentOf('a/b/c'), 'a');
});

test('providerSegmentOf: 无 / → null', () => {
	assert.equal(providerSegmentOf('bare-model'), null);
});

test('providerSegmentOf: / 在开头（provider 段空）→ null', () => {
	assert.equal(providerSegmentOf('/model'), null);
});

test('providerSegmentOf: 非字符串 / null → null', () => {
	assert.equal(providerSegmentOf(null), null);
	assert.equal(providerSegmentOf(undefined), null);
	assert.equal(providerSegmentOf(123), null);
});

// ============ computeProviderUsable ============

test('computeProviderUsable: primary=null → false', () => {
	assert.equal(computeProviderUsable(null, {}, makeCredDeps()), false);
});

test('computeProviderUsable: isProviderApiKeyConfigured 命中 → true', () => {
	const deps = makeCredDeps({
		isProviderApiKeyConfigured: ({ provider, agentDir }) =>
			provider === 'minimax' && agentDir === '/fake/agents/main/agent',
	});
	assert.equal(computeProviderUsable('minimax/x', {}, deps), true);
});

test('computeProviderUsable: env/账本无但内联 key 存在 → true', () => {
	const cfg = { models: { providers: { minimax: { apiKey: 'sk-xxx' } } } };
	const deps = makeCredDeps({ hasConfiguredSecretInput: (v) => v === 'sk-xxx' });
	assert.equal(computeProviderUsable('minimax/x', cfg, deps), true);
});

test('computeProviderUsable: 该 provider 无 cfg 节点 → 内联判 false → false', () => {
	const cfg = { models: { providers: { other: { apiKey: 'sk-xxx' } } } };
	const deps = makeCredDeps({ hasConfiguredSecretInput: () => true });
	assert.equal(computeProviderUsable('minimax/x', cfg, deps), false);
});

test('computeProviderUsable: 三源全无 → false', () => {
	const cfg = { models: { providers: { minimax: { apiKey: 'sk-xxx' } } } };
	assert.equal(computeProviderUsable('minimax/x', cfg, makeCredDeps()), false);
});

// ============ computeProviderUsableByName（统一原语 / B 修复 / 别名套餐）============

test('computeProviderUsableByName: 裸名有账本/env 凭据 → true（B：裸名不再恒 false）', () => {
	const deps = makeCredDeps({ isProviderApiKeyConfigured: ({ provider }) => provider === 'openai' });
	assert.equal(computeProviderUsableByName('openai', {}, deps), true);
});

test('computeProviderUsableByName: 裸名无任何凭据 → false', () => {
	assert.equal(computeProviderUsableByName('openai', {}, makeCredDeps()), false);
});

test('computeProviderUsableByName: 非字符串 / 空串 → false', () => {
	assert.equal(computeProviderUsableByName(null, {}, makeCredDeps()), false);
	assert.equal(computeProviderUsableByName(undefined, {}, makeCredDeps()), false);
	assert.equal(computeProviderUsableByName('', {}, makeCredDeps()), false);
});

test('computeProviderUsableByName: 别名套餐 —— 基座账本 key 经 isProviderApiKeyConfigured 别名归一点亮变体名', () => {
	// 模拟上游 isProviderApiKeyConfigured 的别名感知：账本只有基座 volcengine，
	// 查询变体名 volcengine-plan 先归一到 volcengine 再命中（两侧归一在 SDK 内完成），
	// 故 mock 不能对 volcengine-plan 直接返回 true，须建模"基座账本 + 归一查找"
	const resolveBase = (p) => (p === 'volcengine-plan' ? 'volcengine' : p);
	const baseLedger = new Set(['volcengine']);
	const deps = makeCredDeps({
		isProviderApiKeyConfigured: ({ provider }) => baseLedger.has(resolveBase(provider)),
	});
	assert.equal(computeProviderUsableByName('volcengine-plan', {}, deps), true);
	assert.equal(computeProviderUsableByName('some-unconfigured', {}, deps), false);
});

test('computeProviderUsableByName: 别名套餐 —— 内联基座 key 经两侧归一让变体名为 true', () => {
	const cfg = { models: { providers: { volcengine: { apiKey: 'sk-volc' } } } };
	const deps = makeCredDeps({
		isProviderApiKeyConfigured: () => false,
		hasConfiguredSecretInput: (v) => v === 'sk-volc',
		resolveProviderIdForAuth: (p) => (p === 'volcengine-plan' ? 'volcengine' : p),
	});
	assert.equal(computeProviderUsableByName('volcengine-plan', cfg, deps), true);
});

test('computeProviderUsableByName: 别名套餐 —— 内联变体 id 节点经 node 侧归一让基座查询为 true（钉死 node 侧归一）', () => {
	// 反向用例：内联节点用变体 id volcengine-plan（带 key），查询用基座名 volcengine。
	// node 侧 resolveProviderIdForAuth 把节点 id volcengine-plan 归一到 volcengine 才能与查询 targetId 命中。
	// 价值：若去掉 hasInlineKey 里对 nodeId 的 resolveProviderIdForAuth（node 侧停在 volcengine-plan ≠ 查询归一的 volcengine），此用例失败 → 钉死 node 侧归一。
	const cfg = { models: { providers: { 'volcengine-plan': { apiKey: 'sk-volc' } } } };
	const deps = makeCredDeps({
		isProviderApiKeyConfigured: () => false,
		hasConfiguredSecretInput: (v) => v === 'sk-volc',
		resolveProviderIdForAuth: (p) => (p === 'volcengine-plan' ? 'volcengine' : p),
	});
	assert.equal(computeProviderUsableByName('volcengine', cfg, deps), true);
});

test('computeProviderUsableByName: 内联节点归一后不同 provider → false', () => {
	const cfg = { models: { providers: { anthropic: { apiKey: 'sk-a' } } } };
	const deps = makeCredDeps({ hasConfiguredSecretInput: () => true });
	assert.equal(computeProviderUsableByName('volcengine-plan', cfg, deps), false);
});

test('computeProviderUsableByName: providers 非对象 → 内联判 false', () => {
	const cfg = { models: { providers: 'oops' } };
	const deps = makeCredDeps({ hasConfiguredSecretInput: () => true });
	assert.equal(computeProviderUsableByName('openai', cfg, deps), false);
});

test('computeProviderUsableByName: 内联节点为 null / 无 apiKey 跳过不崩', () => {
	const cfg = { models: { providers: { a: null, b: {} } } };
	const deps = makeCredDeps({ hasConfiguredSecretInput: (v) => typeof v === 'string' });
	assert.equal(computeProviderUsableByName('a', cfg, deps), false);
});

// ---- 账本 oauth/token 凭据（listUsable oauth gate 回归修复）----

test('computeProviderUsableByName: 账本 oauth-only provider（无 key）→ true', () => {
	const deps = makeCredDeps({
		ensureAuthProfileStore: () => ({
			profiles: { 'openai-codex:default': { provider: 'openai-codex', type: 'oauth' } },
		}),
	});
	assert.equal(computeProviderUsableByName('openai-codex', {}, deps), true);
});

test('computeProviderUsableByName: 账本 token 凭据 → true', () => {
	const deps = makeCredDeps({
		ensureAuthProfileStore: () => ({
			profiles: { 'copilot:default': { provider: 'copilot', type: 'token' } },
		}),
	});
	assert.equal(computeProviderUsableByName('copilot', {}, deps), true);
});

test('computeProviderUsableByName: 账本里别家 oauth、查询 provider 不匹配 → false', () => {
	const deps = makeCredDeps({
		ensureAuthProfileStore: () => ({
			profiles: { 'openai-codex:default': { provider: 'openai-codex', type: 'oauth' } },
		}),
	});
	assert.equal(computeProviderUsableByName('anthropic', {}, deps), false);
});

test('computeProviderUsableByName: 账本 oauth 别名归一 —— 基座 cred 点亮套餐变体名', () => {
	// 账本只有基座 volcengine 的 oauth，查询变体名 volcengine-plan：两侧归一到 volcengine 后命中
	const resolveBase = (p) => (p === 'volcengine-plan' ? 'volcengine' : p);
	const deps = makeCredDeps({
		ensureAuthProfileStore: () => ({
			profiles: { 'volcengine:default': { provider: 'volcengine', type: 'oauth' } },
		}),
		resolveProviderIdForAuth: resolveBase,
	});
	assert.equal(computeProviderUsableByName('volcengine-plan', {}, deps), true);
});

test('computeProviderUsableByName: 账本 cred 用变体 id、查询基座名 —— node 侧归一命中（钉死 node 侧归一）', () => {
	const deps = makeCredDeps({
		ensureAuthProfileStore: () => ({
			profiles: { 'volcengine-plan:default': { provider: 'volcengine-plan', type: 'oauth' } },
		}),
		resolveProviderIdForAuth: (p) => (p === 'volcengine-plan' ? 'volcengine' : p),
	});
	assert.equal(computeProviderUsableByName('volcengine', {}, deps), true);
});

test('computeProviderUsableByName: store 为 null → 账本路 false（无其它源 → false）', () => {
	const deps = makeCredDeps({ ensureAuthProfileStore: () => null });
	assert.equal(computeProviderUsableByName('openai-codex', {}, deps), false);
});

test('computeProviderUsableByName: store.profiles 非对象 → 账本路 false', () => {
	const deps = makeCredDeps({ ensureAuthProfileStore: () => ({ profiles: 'oops' }) });
	assert.equal(computeProviderUsableByName('openai-codex', {}, deps), false);
});

test('computeProviderUsableByName: 账本 profile 边角（null / provider 非串 / 空串）跳过、不误命中', () => {
	const deps = makeCredDeps({
		ensureAuthProfileStore: () => ({
			profiles: { p1: null, p2: { provider: 123 }, p3: { provider: '' } },
		}),
	});
	assert.equal(computeProviderUsableByName('openai-codex', {}, deps), false);
});

test('computeProviderUsableByName: api-key 路命中时短路，不读账本', () => {
	let storeReads = 0;
	const deps = makeCredDeps({
		isProviderApiKeyConfigured: ({ provider }) => provider === 'openai',
		ensureAuthProfileStore: () => {
			storeReads++;
			return { profiles: {} };
		},
	});
	assert.equal(computeProviderUsableByName('openai', {}, deps), true);
	assert.equal(storeReads, 0);
});

test('computeProviderUsableByName: 内联 key 命中时短路，不读账本', () => {
	let storeReads = 0;
	const cfg = { models: { providers: { minimax: { apiKey: 'sk-inline' } } } };
	const deps = makeCredDeps({
		hasConfiguredSecretInput: (v) => v === 'sk-inline',
		ensureAuthProfileStore: () => {
			storeReads++;
			return { profiles: {} };
		},
	});
	assert.equal(computeProviderUsableByName('minimax', cfg, deps), true);
	assert.equal(storeReads, 0);
});

test('computeProviderUsableByName: 查询 provider 归一为空串 → 账本路不误命中（empty-id 守卫，对齐 computeConfiguredProviders）', () => {
	// resolveProviderIdForAuth 把 whitespace-only provider 归一到 ''；
	// 即便账本里有个同样归一到 '' 的 cred，empty-id 守卫也不该误判 usable
	const deps = makeCredDeps({
		resolveProviderIdForAuth: (p) => (p.trim() === '' ? '' : p),
		ensureAuthProfileStore: () => ({ profiles: { p: { provider: '   ', type: 'oauth' } } }),
	});
	assert.equal(computeProviderUsableByName('  ', {}, deps), false);
});

// computeProviderUsable 委托 ByName（取 provider 段）
test('computeProviderUsable: 委托 ByName —— 含斜杠取段后判定', () => {
	const deps = makeCredDeps({ isProviderApiKeyConfigured: ({ provider }) => provider === 'volcengine-plan' });
	assert.equal(computeProviderUsable('volcengine-plan/ark-code-latest', {}, deps), true);
});

// ============ computeHasAnyUsableCredential ============

test('computeHasAnyUsableCredential: 账本非空 → true', () => {
	const deps = makeCredDeps({
		ensureAuthProfileStore: () => ({ profiles: { 'minimax:default': {} } }),
	});
	assert.equal(computeHasAnyUsableCredential({}, deps), true);
});

test('computeHasAnyUsableCredential: 账本空但有内联 key → true', () => {
	const cfg = { models: { providers: { minimax: { apiKey: 'sk-xxx' } } } };
	const deps = makeCredDeps({ hasConfiguredSecretInput: (v) => v === 'sk-xxx' });
	assert.equal(computeHasAnyUsableCredential(cfg, deps), true);
});

test('computeHasAnyUsableCredential: 账本空 + 无内联 → false', () => {
	const cfg = { models: { providers: { minimax: { apiKey: 'sk-xxx' } } } };
	assert.equal(computeHasAnyUsableCredential(cfg, makeCredDeps()), false);
});

test('computeHasAnyUsableCredential: store 无 profiles 字段 + 无 providers 节点 → false', () => {
	const deps = makeCredDeps({ ensureAuthProfileStore: () => ({}) });
	assert.equal(computeHasAnyUsableCredential({}, deps), false);
});

test('computeHasAnyUsableCredential: store 为 null → 退到内联检查', () => {
	const cfg = { models: { providers: { minimax: { apiKey: 'sk-xxx' } } } };
	const deps = makeCredDeps({
		ensureAuthProfileStore: () => null,
		hasConfiguredSecretInput: (v) => v === 'sk-xxx',
	});
	assert.equal(computeHasAnyUsableCredential(cfg, deps), true);
});

test('computeHasAnyUsableCredential: providers 含 null entry 不崩、跳过', () => {
	const cfg = { models: { providers: { a: null, b: { apiKey: 'sk' } } } };
	const deps = makeCredDeps({ hasConfiguredSecretInput: (v) => v === 'sk' });
	assert.equal(computeHasAnyUsableCredential(cfg, deps), true);
});

test('computeHasAnyUsableCredential: providers 非对象 → false', () => {
	const cfg = { models: { providers: 'oops' } };
	assert.equal(computeHasAnyUsableCredential(cfg, makeCredDeps()), false);
});

test('computeHasAnyUsableCredential: 必补 C —— 纯 env-only（账本/内联空，env 命中 default 主模型段）→ true', () => {
	const cfg = { agents: { defaults: { model: 'openai/gpt-5.5' } } };
	const deps = makeCredDeps({ isProviderApiKeyConfigured: ({ provider }) => provider === 'openai' });
	assert.equal(computeHasAnyUsableCredential(cfg, deps), true);
});

test('computeHasAnyUsableCredential: env 命中 agent 主模型段（default 为空）→ true', () => {
	const cfg = { agents: { list: [{ id: 'r', model: 'groq/x' }] } };
	const deps = makeCredDeps({ isProviderApiKeyConfigured: ({ provider }) => provider === 'groq' });
	assert.equal(computeHasAnyUsableCredential(cfg, deps), true);
});

test('computeHasAnyUsableCredential: 候选集有但 env 全不命中 → false', () => {
	const cfg = { agents: { defaults: { model: 'openai/gpt-5.5' } } };
	assert.equal(computeHasAnyUsableCredential(cfg, makeCredDeps()), false);
});

// ============ computeConfiguredProviders ============

test('computeConfiguredProviders: 三源合并 + 别名归一 + 去重 + 升序', () => {
	const cfg = {
		agents: { defaults: { model: 'openai/gpt-5.5' } },
		models: { providers: { 'volcengine-plan': { apiKey: 'sk' } } },
	};
	const deps = makeCredDeps({
		ensureAuthProfileStore: () => ({ profiles: { 'volcengine:default': { provider: 'volcengine', type: 'api_key' } } }),
		hasConfiguredSecretInput: (v) => v === 'sk',
		isProviderApiKeyConfigured: ({ provider }) => provider === 'openai',
		resolveProviderIdForAuth: (p) => (p === 'volcengine-plan' ? 'volcengine' : p),
	});
	// 账本 volcengine + 内联 volcengine-plan(归一 volcengine) 去重 → volcengine；env 候选 openai
	assert.deepEqual(computeConfiguredProviders(cfg, deps), ['openai', 'volcengine']);
});

test('computeConfiguredProviders: store 为 null → 跳过账本源、仅内联', () => {
	const cfg = { models: { providers: { groq: { apiKey: 'k' } } } };
	const deps = makeCredDeps({
		ensureAuthProfileStore: () => null,
		hasConfiguredSecretInput: (v) => v === 'k',
	});
	assert.deepEqual(computeConfiguredProviders(cfg, deps), ['groq']);
});

test('computeConfiguredProviders: 账本 profile 边角（null / provider 非串 / 空串）跳过', () => {
	const deps = makeCredDeps({
		ensureAuthProfileStore: () => ({
			profiles: { p1: null, p2: { provider: 123 }, p3: { provider: '' }, p4: { provider: 'cohere' } },
		}),
	});
	assert.deepEqual(computeConfiguredProviders({}, deps), ['cohere']);
});

test('computeConfiguredProviders: 归一返回空串的 provider 不计入', () => {
	const deps = makeCredDeps({
		ensureAuthProfileStore: () => ({ profiles: { x: { provider: 'weird' } } }),
		resolveProviderIdForAuth: () => '',
	});
	assert.deepEqual(computeConfiguredProviders({}, deps), []);
});

test('computeConfiguredProviders: 内联节点 null / 无 apiKey 跳过', () => {
	const cfg = { models: { providers: { a: null, b: {}, c: { apiKey: 'k' } } } };
	const deps = makeCredDeps({ hasConfiguredSecretInput: (v) => v === 'k' });
	assert.deepEqual(computeConfiguredProviders(cfg, deps), ['c']);
});

test('computeConfiguredProviders: providers 非对象 → 不崩、空集', () => {
	const cfg = { models: { providers: 'oops' } };
	assert.deepEqual(computeConfiguredProviders(cfg, makeCredDeps()), []);
});

// ============ enumerateUsableModels ============

test('enumerateUsableModels: 按 provider 分组、留有凭据的、含变体、丢幽灵、id 去重升序', () => {
	const entries = [
		{ id: 'gpt-5.5', provider: 'openai' },
		{ id: 'gpt-4o', provider: 'openai' },
		{ id: 'gpt-5.5', provider: 'openai' }, // 重复 id
		{ id: 'ark-code-latest', provider: 'volcengine-plan' }, // 变体
		{ id: 'claude', provider: 'anthropic' }, // 无凭据 → 丢
	];
	const deps = makeCredDeps({
		isProviderApiKeyConfigured: ({ provider }) => provider === 'openai' || provider === 'volcengine-plan',
	});
	const { byProvider } = enumerateUsableModels(entries, {}, deps);
	assert.deepEqual(byProvider, {
		openai: ['gpt-4o', 'gpt-5.5'],
		'volcengine-plan': ['ark-code-latest'],
	});
});

test('enumerateUsableModels: 同时返回 configuredProviders（候选含主模型段）', () => {
	const entries = [{ id: 'm', provider: 'openai' }];
	const cfg = { agents: { defaults: { model: 'openai/m' } } };
	const deps = makeCredDeps({ isProviderApiKeyConfigured: ({ provider }) => provider === 'openai' });
	const out = enumerateUsableModels(entries, cfg, deps);
	assert.deepEqual(out.byProvider, { openai: ['m'] });
	assert.deepEqual(out.configuredProviders, ['openai']);
});

test('enumerateUsableModels: 空 / 非数组 entries → 空 byProvider', () => {
	assert.deepEqual(enumerateUsableModels([], {}, makeCredDeps()), { byProvider: {}, configuredProviders: [] });
	assert.deepEqual(enumerateUsableModels(undefined, {}, makeCredDeps()), { byProvider: {}, configuredProviders: [] });
	assert.deepEqual(enumerateUsableModels('nope', {}, makeCredDeps()), { byProvider: {}, configuredProviders: [] });
});

test('enumerateUsableModels: oauth-only provider（账本 oauth、无 key）的模型组进入 byProvider（回归修复）', () => {
	// 复刻本机实测场景：codex 只有 oauth、deepseek 有 api-key，anthropic 无凭据
	const entries = [
		{ id: 'gpt-5.3-codex', provider: 'openai-codex' },
		{ id: 'gpt-5.5-codex', provider: 'openai-codex' },
		{ id: 'deepseek-chat', provider: 'deepseek' },
		{ id: 'claude', provider: 'anthropic' }, // 无凭据 → 丢
	];
	const deps = makeCredDeps({
		isProviderApiKeyConfigured: ({ provider }) => provider === 'deepseek',
		ensureAuthProfileStore: () => ({
			profiles: {
				'openai-codex:default': { provider: 'openai-codex', type: 'oauth' },
				'deepseek:default': { provider: 'deepseek', type: 'api_key' },
			},
		}),
	});
	const { byProvider } = enumerateUsableModels(entries, {}, deps);
	assert.deepEqual(byProvider, {
		'openai-codex': ['gpt-5.3-codex', 'gpt-5.5-codex'],
		deepseek: ['deepseek-chat'],
	});
});

test('enumerateUsableModels: 跳过坏条目（null / 缺 id / 缺 provider / 空串）', () => {
	const entries = [
		null,
		{ provider: 'openai' }, // 缺 id
		{ id: 'x' }, // 缺 provider
		{ id: '', provider: 'openai' }, // id 空串
		{ id: 'y', provider: '' }, // provider 空串
		{ id: 'ok', provider: 'openai' },
	];
	const deps = makeCredDeps({ isProviderApiKeyConfigured: ({ provider }) => provider === 'openai' });
	const { byProvider } = enumerateUsableModels(entries, {}, deps);
	assert.deepEqual(byProvider, { openai: ['ok'] });
});

// ============ listAllPrimariesWithCredentials ============

test('listAllPrimariesWithCredentials: 装配出参（含 providerUsable + hasAny）', () => {
	const cfg = {
		agents: {
			defaults: { model: 'minimax/MiniMax-M2.7' },
			list: [{ id: 'researcher', model: { primary: 'anthropic/claude-opus-4-7' } }],
		},
		models: { providers: { minimax: { apiKey: 'sk-inline' } } },
	};
	const deps = makeCredDeps({ hasConfiguredSecretInput: (v) => v === 'sk-inline' });
	assert.deepEqual(listAllPrimariesWithCredentials(cfg, deps), {
		default: { primary: 'minimax/MiniMax-M2.7', providerUsable: true },
		agents: {
			main: { primary: null, providerUsable: false },
			researcher: { primary: 'anthropic/claude-opus-4-7', providerUsable: false },
		},
		hasAnyUsableCredential: true,
	});
});

test('listAllPrimariesWithCredentials: 空 cfg → 全 false + 补 main', () => {
	assert.deepEqual(listAllPrimariesWithCredentials({}, makeCredDeps()), {
		default: { primary: null, providerUsable: false },
		agents: { main: { primary: null, providerUsable: false } },
		hasAnyUsableCredential: false,
	});
});
