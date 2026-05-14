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
		modelsRuntime: {
			buildModelsProviderData: async () => ({
				byProvider: new Map([['openai-codex', new Set(['gpt-5.5'])]]),
			}),
		},
		providerAuth: {
			isProviderAuthProfileConfigured: () => true,
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

test('registerModelDefaultHandlers 注册两个 RPC method', () => {
	const api = makeApi();
	const mods = makeSdkModules();
	registerModelDefaultHandlers(api, {
		loadConfigMutation: async () => mods.configMutation,
		loadModelsProviderRuntime: async () => mods.modelsRuntime,
		loadProviderAuth: async () => mods.providerAuth,
		loadConfig: () => ({ agents: { defaults: {} } }),
		resolveAgentDir: () => '/fake',
	});
	assert.equal(api.__registered.has('coclaw.model.set'), true);
	assert.equal(api.__registered.has('coclaw.model.list'), true);
});

test('list 调用走到 handler 并返回出参', async () => {
	const api = makeApi();
	const mods = makeSdkModules();
	registerModelDefaultHandlers(api, {
		loadConfigMutation: async () => mods.configMutation,
		loadModelsProviderRuntime: async () => mods.modelsRuntime,
		loadProviderAuth: async () => mods.providerAuth,
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

test('set 调用走到 handler 并写盘', async () => {
	const api = makeApi();
	const mods = makeSdkModules();
	registerModelDefaultHandlers(api, {
		loadConfigMutation: async () => mods.configMutation,
		loadModelsProviderRuntime: async () => mods.modelsRuntime,
		loadProviderAuth: async () => mods.providerAuth,
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
		loadModelsProviderRuntime: async () => ({}),
		loadProviderAuth: async () => ({}),
		loadConfig: () => ({ agents: {} }),
		resolveAgentDir: () => '/fake',
	});
	const r = makeRespond();
	await api.__call('coclaw.model.list', { params: {}, respond: r.respond });
	assert.equal(r.calls[0].ok, false);
	assert.equal(r.calls[0].error.code, 'IO_FAILED');
	assert.match(r.calls[0].error.message, /sdk gone/);
});

test('并发首调：同事件循环内多次调用共享同一 handlersPromise，三个 loader 各自只调一次', async () => {
	const api = makeApi();
	const mods = makeSdkModules();
	let cmLoads = 0, mrLoads = 0, paLoads = 0;
	let resolveCM, resolveMR, resolvePA;
	const cmReady = new Promise((r) => { resolveCM = r; });
	const mrReady = new Promise((r) => { resolveMR = r; });
	const paReady = new Promise((r) => { resolvePA = r; });
	registerModelDefaultHandlers(api, {
		loadConfigMutation: async () => {
			cmLoads += 1;
			await cmReady;
			return mods.configMutation;
		},
		loadModelsProviderRuntime: async () => {
			mrLoads += 1;
			await mrReady;
			return mods.modelsRuntime;
		},
		loadProviderAuth: async () => {
			paLoads += 1;
			await paReady;
			return mods.providerAuth;
		},
		loadConfig: () => ({ agents: {} }),
		resolveAgentDir: () => '/fake',
	});
	const r1 = makeRespond();
	const r2 = makeRespond();
	const p1 = api.__call('coclaw.model.list', { params: {}, respond: r1.respond });
	const p2 = api.__call('coclaw.model.list', { params: {}, respond: r2.respond });
	resolveCM(); resolveMR(); resolvePA();
	await Promise.all([p1, p2]);
	assert.equal(cmLoads, 1);
	assert.equal(mrLoads, 1);
	assert.equal(paLoads, 1);
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
		loadModelsProviderRuntime: async () => mods.modelsRuntime,
		loadProviderAuth: async () => mods.providerAuth,
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
		loadModelsProviderRuntime: async () => ({ buildModelsProviderData: async () => ({}) }),
		loadProviderAuth: async () => ({ isProviderAuthProfileConfigured: () => false }),
	});
	assert.equal(api.__registered.size, 2);
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
