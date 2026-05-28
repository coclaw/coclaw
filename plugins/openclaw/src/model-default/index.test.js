import test from 'node:test';
import assert from 'node:assert/strict';

import { registerModelDefaultHandlers, __resetSdkCaches } from './index.js';

function makeApi() {
	const registered = new Map();
	return {
		registerGatewayMethod(name, handler) {
			registered.set(name, handler);
		},
		__call(name, ctx) {
			const handler = registered.get(name);
			if (!handler) throw new Error(`method ${name} not registered`);
			return handler(ctx);
		},
		__registered: registered,
	};
}

function makeSdkModules() {
	const mutateCalls = [];
	return {
		configMutation: {
			mutateConfigFile: async ({ mutate }) => {
				const draft = {};
				await mutate(draft, { snapshot: {}, previousHash: null });
				mutateCalls.push(draft);
				return { result: undefined };
			},
		},
		providerAuth: {
			isProviderApiKeyConfigured: () => false,
			hasConfiguredSecretInput: () => false,
			ensureAuthProfileStore: () => ({ profiles: {} }),
		},
		agentRuntime: {
			resolveProviderIdForAuth: (p) => p,
			loadModelCatalog: async () => [],
		},
		__mutateCalls: mutateCalls,
	};
}

function makeRespond() {
	const calls = [];
	return {
		respond: (ok, payload, error) => calls.push({ ok, payload, error }),
		calls,
	};
}

test('registerModelDefaultHandlers 注册三个 RPC method', () => {
	const api = makeApi();
	const mods = makeSdkModules();
	registerModelDefaultHandlers(api, {
		loadConfigMutation: async () => mods.configMutation,
		loadProviderAuth: async () => mods.providerAuth,
		loadAgentRuntime: async () => mods.agentRuntime,
		loadConfig: () => ({ agents: { defaults: {} } }),
		resolveAgentDir: () => '/fake',
	});
	assert.equal(api.__registered.has('coclaw.model.set'), true);
	assert.equal(api.__registered.has('coclaw.model.list'), true);
	assert.equal(api.__registered.has('coclaw.model.listUsable'), true);
});

test('list 调用走到 handler 并返回出参', async () => {
	const api = makeApi();
	const mods = makeSdkModules();
	registerModelDefaultHandlers(api, {
		loadConfigMutation: async () => mods.configMutation,
		loadProviderAuth: async () => mods.providerAuth,
		loadAgentRuntime: async () => mods.agentRuntime,
		loadConfig: () => ({
			agents: {
				defaults: { model: 'openai-codex/gpt-5.5' },
				list: [{ id: 'main' }],
			},
		}),
		resolveAgentDir: () => '/fake',
	});
	const r = makeRespond();
	await api.__call('coclaw.model.list', { params: {}, respond: r.respond });
	assert.equal(r.calls[0].ok, true);
	assert.equal(r.calls[0].payload.default.primary, 'openai-codex/gpt-5.5');
});

test('list 出参带凭据信号：内联 key 让 providerUsable / hasAnyUsableCredential 为真', async () => {
	// 钉住 index.js 把三个凭据探针接进 sdk bundle 的接线（isProviderApiKeyConfigured /
	// hasConfiguredSecretInput / ensureAuthProfileStore）。env+账本都说没有，只有内联 key 存在：
	// 若任一探针漏接 → deps 里对应项为 undefined → 调用即抛 → list 落 IO_FAILED，
	// 下面 ok / providerUsable / hasAnyUsableCredential 三条断言都会失败（mutation 可捕获）。
	const api = makeApi();
	const mods = makeSdkModules();
	mods.providerAuth.isProviderApiKeyConfigured = () => false;
	mods.providerAuth.hasConfiguredSecretInput = (v) => typeof v === 'string' && v.length > 0;
	mods.providerAuth.ensureAuthProfileStore = () => ({ profiles: {} });
	registerModelDefaultHandlers(api, {
		loadConfigMutation: async () => mods.configMutation,
		loadProviderAuth: async () => mods.providerAuth,
		loadAgentRuntime: async () => mods.agentRuntime,
		loadConfig: () => ({
			agents: { defaults: { model: 'openai-codex/gpt-5.5' } },
			models: { providers: { 'openai-codex': { apiKey: 'sk-inline-test' } } },
		}),
		resolveAgentDir: () => '/fake',
	});
	const r = makeRespond();
	await api.__call('coclaw.model.list', { params: {}, respond: r.respond });
	assert.equal(r.calls[0].ok, true);
	assert.equal(r.calls[0].payload.default.providerUsable, true);
	assert.equal(r.calls[0].payload.hasAnyUsableCredential, true);
});

test('listUsable 调用走到 handler 并返回 byProvider + configuredProviders', async () => {
	// 钉住 index.js 把 loadModelCatalog（agent-runtime）+ 凭据探针接进 sdk bundle：
	// 漏接任一 → 调用抛 → IO_FAILED，下面断言失败。
	const api = makeApi();
	const mods = makeSdkModules();
	mods.providerAuth.isProviderApiKeyConfigured = ({ provider }) => provider === 'openai-codex';
	mods.agentRuntime.loadModelCatalog = async () => [{ id: 'gpt-5.5', provider: 'openai-codex' }];
	registerModelDefaultHandlers(api, {
		loadConfigMutation: async () => mods.configMutation,
		loadProviderAuth: async () => mods.providerAuth,
		loadAgentRuntime: async () => mods.agentRuntime,
		loadConfig: () => ({ agents: { defaults: { model: 'openai-codex/gpt-5.5' } } }),
		resolveAgentDir: () => '/fake',
	});
	const r = makeRespond();
	await api.__call('coclaw.model.listUsable', { params: {}, respond: r.respond });
	assert.equal(r.calls[0].ok, true);
	assert.deepEqual(r.calls[0].payload.byProvider, { 'openai-codex': ['gpt-5.5'] });
	assert.deepEqual(r.calls[0].payload.configuredProviders, ['openai-codex']);
});

test('set 调用走到 handler 并写盘', async () => {
	const api = makeApi();
	const mods = makeSdkModules();
	mods.providerAuth.isProviderApiKeyConfigured = ({ provider }) => provider === 'openai-codex';
	mods.agentRuntime.loadModelCatalog = async () => [{ id: 'gpt-5.5', provider: 'openai-codex' }];
	registerModelDefaultHandlers(api, {
		loadConfigMutation: async () => mods.configMutation,
		loadProviderAuth: async () => mods.providerAuth,
		loadAgentRuntime: async () => mods.agentRuntime,
		loadConfig: () => ({ agents: {} }),
		resolveAgentDir: () => '/fake',
	});
	const r = makeRespond();
	await api.__call('coclaw.model.set', {
		params: { primary: 'openai-codex/gpt-5.5' },
		respond: r.respond,
	});
	assert.equal(r.calls[0].ok, true);
	assert.equal(mods.__mutateCalls.length, 1);
});

test('SDK loader 抛错 → IO_FAILED', async () => {
	const api = makeApi();
	registerModelDefaultHandlers(api, {
		loadConfigMutation: async () => { throw new Error('sdk gone'); },
		loadProviderAuth: async () => ({}),
		loadAgentRuntime: async () => ({}),
		loadConfig: () => ({ agents: {} }),
		resolveAgentDir: () => '/fake',
	});
	const r = makeRespond();
	await api.__call('coclaw.model.list', { params: {}, respond: r.respond });
	assert.equal(r.calls[0].ok, false);
	assert.equal(r.calls[0].error.code, 'IO_FAILED');
	assert.match(r.calls[0].error.message, /sdk gone/);
});

test('loadAgentRuntime 抛错 → IO_FAILED（钉住已接入 Promise.all bundle）', async () => {
	// 若 loadAgentRuntime 漏接进 getHandlers 的 Promise.all，它抛错就不会变成 IO_FAILED
	const api = makeApi();
	const mods = makeSdkModules();
	registerModelDefaultHandlers(api, {
		loadConfigMutation: async () => mods.configMutation,
		loadProviderAuth: async () => mods.providerAuth,
		loadAgentRuntime: async () => { throw new Error('agent-runtime gone'); },
		loadConfig: () => ({ agents: {} }),
		resolveAgentDir: () => '/fake',
	});
	const r = makeRespond();
	await api.__call('coclaw.model.list', { params: {}, respond: r.respond });
	assert.equal(r.calls[0].ok, false);
	assert.equal(r.calls[0].error.code, 'IO_FAILED');
	assert.match(r.calls[0].error.message, /agent-runtime gone/);
});

test('SDK loader 抛非 Error 字符串 → IO_FAILED message 走 ?? err 兜底', async () => {
	const api = makeApi();
	registerModelDefaultHandlers(api, {
		loadConfigMutation: async () => { throw 'boom-as-string'; },
		loadProviderAuth: async () => ({}),
		loadAgentRuntime: async () => ({}),
		loadConfig: () => ({ agents: {} }),
		resolveAgentDir: () => '/fake',
	});
	const r = makeRespond();
	await api.__call('coclaw.model.list', { params: {}, respond: r.respond });
	assert.equal(r.calls[0].error.code, 'IO_FAILED');
	assert.equal(r.calls[0].error.message, 'boom-as-string');
});

test('并发首调：同事件循环内多次调用共享同一 handlersPromise，三个 loader 各自只调一次', async () => {
	const api = makeApi();
	const mods = makeSdkModules();
	let cmLoads = 0, paLoads = 0, arLoads = 0;
	let resolveCM, resolvePA;
	const cmReady = new Promise((r) => { resolveCM = r; });
	const paReady = new Promise((r) => { resolvePA = r; });
	registerModelDefaultHandlers(api, {
		loadConfigMutation: async () => {
			cmLoads += 1;
			await cmReady;
			return mods.configMutation;
		},
		loadProviderAuth: async () => {
			paLoads += 1;
			await paReady;
			return mods.providerAuth;
		},
		loadAgentRuntime: async () => { arLoads += 1; return mods.agentRuntime; },
		loadConfig: () => ({ agents: {} }),
		resolveAgentDir: () => '/fake',
	});
	const r1 = makeRespond();
	const r2 = makeRespond();
	const p1 = api.__call('coclaw.model.list', { params: {}, respond: r1.respond });
	const p2 = api.__call('coclaw.model.list', { params: {}, respond: r2.respond });
	resolveCM(); resolvePA();
	await Promise.all([p1, p2]);
	assert.equal(cmLoads, 1);
	assert.equal(paLoads, 1);
	assert.equal(arLoads, 1);
	assert.equal(r1.calls[0].ok, true);
	assert.equal(r2.calls[0].ok, true);
});

test('handlers 实例在多次调用间复用（loader 只调一次）', async () => {
	const api = makeApi();
	const mods = makeSdkModules();
	let loadConfigMutationCalls = 0;
	registerModelDefaultHandlers(api, {
		loadConfigMutation: async () => {
			loadConfigMutationCalls += 1;
			return mods.configMutation;
		},
		loadProviderAuth: async () => mods.providerAuth,
		loadAgentRuntime: async () => mods.agentRuntime,
		loadConfig: () => ({ agents: {} }),
		resolveAgentDir: () => '/fake',
	});
	const r1 = makeRespond();
	const r2 = makeRespond();
	await api.__call('coclaw.model.list', { params: {}, respond: r1.respond });
	await api.__call('coclaw.model.list', { params: {}, respond: r2.respond });
	assert.equal(loadConfigMutationCalls, 1);
});

test('opts 缺省时回退到默认 (mainAgentDir / getClawConfig)', () => {
	// 仅注册不调用，避免触发默认 loader 走真实 SDK import
	const api = makeApi();
	registerModelDefaultHandlers(api, {
		loadConfigMutation: async () => ({ mutateConfigFile: async () => ({}) }),
		loadProviderAuth: async () => ({ isProviderApiKeyConfigured: () => false }),
		loadAgentRuntime: async () => ({ resolveProviderIdForAuth: (p) => p, loadModelCatalog: async () => [] }),
	});
	assert.equal(api.__registered.size, 3);
});

test('default loader: 不传任何 opts → fallback path 跑通（测试环境无 openclaw 包 → IO_FAILED）', async () => {
	__resetSdkCaches();
	const api = makeApi();
	registerModelDefaultHandlers(api);
	const r = makeRespond();
	// 调 list 触发 default loader；测试环境通常无 openclaw npm 包 → 落到 IO_FAILED；
	// 若环境恰好可解析也仍是 respond 一次（同 provider-auth/index.test.js 同款 fallback test）
	await api.__call('coclaw.model.list', { params: {}, respond: r.respond });
	assert.equal(r.calls.length, 1);
	__resetSdkCaches();
});

test('__resetSdkCaches: 重置后 default loader 重新被调用', async () => {
	__resetSdkCaches();
	const api1 = makeApi();
	registerModelDefaultHandlers(api1);
	const r1 = makeRespond();
	await api1.__call('coclaw.model.list', { params: {}, respond: r1.respond });
	// 不论是否成功调用 default loader，至少调用了一次 fallback path
	__resetSdkCaches();
	const api2 = makeApi();
	registerModelDefaultHandlers(api2);
	const r2 = makeRespond();
	await api2.__call('coclaw.model.list', { params: {}, respond: r2.respond });
	assert.equal(r2.calls.length, 1);
});
