import assert from 'node:assert/strict';
import test from 'node:test';

import { registerProviderAuthHandlers, __resetSdkCache } from './index.js';

const ALL_METHODS = [
	'coclaw.providerAuth.cancelOauth',
	'coclaw.providerAuth.list',
	'coclaw.providerAuth.loginOauth',
	'coclaw.providerAuth.remove',
	'coclaw.providerAuth.setApiKey',
];

function createMockApi() {
	const methods = new Map();
	return {
		api: {
			registerGatewayMethod(name, handler) {
				methods.set(name, handler);
			},
		},
		methods,
	};
}

function respondCollector() {
	const calls = [];
	function respond(ok, data, err) {
		calls.push({ ok, data, err });
	}
	return { respond, calls };
}

function fakeSdk() {
	return {
		upsertAuthProfileWithLock: async (p) => ({ version: 1, profiles: { [p.profileId]: p.credential } }),
		buildApiKeyCredential: (provider, input) => ({ type: 'api_key', provider, key: input }),
		ensureAuthProfileStore: () => ({ version: 1, profiles: {} }),
		removeProviderAuthProfilesWithLock: async () => ({ version: 1, profiles: {} }),
		formatApiKeyPreview: (raw) => `${raw.slice(0, 2)}…${raw.slice(-2)}`,
		// OAuth 设备码流需要的 PKCE / 表单编码器（createMiniMaxOAuth 仅存引用，非 oauth 路径不调）
		generatePkceVerifierChallenge: () => ({ verifier: 'v', challenge: 'c' }),
		toFormUrlEncoded: (obj) => new URLSearchParams(obj).toString(),
	};
}

// config-mutation 子入口 stub：OAuth 写 cfg 用；非 oauth 路径不调
function fakeConfigMutation() {
	return { mutateConfigFile: async () => {} };
}

// 给非 oauth 测试统一注入两个 loader 的便捷封装
function registerWithStubs(api, opts = {}) {
	registerProviderAuthHandlers(api, {
		loadSdk: async () => fakeSdk(),
		loadConfigMutation: async () => fakeConfigMutation(),
		resolveAgentDir: () => '/tmp/agent',
		...opts,
	});
}

test('registerProviderAuthHandlers registers all five coclaw.providerAuth.* methods', () => {
	const { api, methods } = createMockApi();
	registerWithStubs(api);
	assert.deepEqual([...methods.keys()].sort(), ALL_METHODS);
});

test('wrap: handlers cache after first SDK load (loader called once across multiple methods)', async () => {
	const { api, methods } = createMockApi();
	let loadCount = 0;
	let cmCount = 0;
	registerProviderAuthHandlers(api, {
		loadSdk: async () => { loadCount += 1; return fakeSdk(); },
		loadConfigMutation: async () => { cmCount += 1; return fakeConfigMutation(); },
		resolveAgentDir: () => '/tmp/agent',
	});
	const setApiKey = methods.get('coclaw.providerAuth.setApiKey');
	const list = methods.get('coclaw.providerAuth.list');
	const r1 = respondCollector();
	await setApiKey({ params: { provider: 'groq', apiKey: 'sk-x' }, respond: r1.respond });
	const r2 = respondCollector();
	await list({ params: {}, respond: r2.respond });
	assert.equal(loadCount, 1);
	assert.equal(cmCount, 1);
	assert.equal(r1.calls[0].ok, true);
	assert.equal(r2.calls[0].ok, true);
});

test('wrap: SDK loader rejects → respond(false) with IO_FAILED + message', async () => {
	const { api, methods } = createMockApi();
	registerProviderAuthHandlers(api, {
		loadSdk: async () => { throw new Error('npm package missing'); },
		loadConfigMutation: async () => fakeConfigMutation(),
		resolveAgentDir: () => '/tmp/agent',
	});
	const setApiKey = methods.get('coclaw.providerAuth.setApiKey');
	const { respond, calls } = respondCollector();
	await setApiKey({ params: { provider: 'groq', apiKey: 'sk-x' }, respond });
	assert.equal(calls[0].ok, false);
	assert.equal(calls[0].err.code, 'IO_FAILED');
	assert.equal(calls[0].err.message, 'npm package missing');
});

test('wrap: config-mutation loader rejects → respond(false) with IO_FAILED', async () => {
	const { api, methods } = createMockApi();
	registerProviderAuthHandlers(api, {
		loadSdk: async () => fakeSdk(),
		loadConfigMutation: async () => { throw new Error('cfg sdk missing'); },
		resolveAgentDir: () => '/tmp/agent',
	});
	const list = methods.get('coclaw.providerAuth.list');
	const { respond, calls } = respondCollector();
	await list({ params: {}, respond });
	assert.equal(calls[0].err.code, 'IO_FAILED');
	assert.equal(calls[0].err.message, 'cfg sdk missing');
});

test('wrap: SDK loader rejects with custom err.code is NOT preserved (always IO_FAILED)', async () => {
	const { api, methods } = createMockApi();
	registerProviderAuthHandlers(api, {
		loadSdk: async () => {
			const err = new Error('not on host');
			err.code = 'SDK_UNAVAILABLE';
			throw err;
		},
		loadConfigMutation: async () => fakeConfigMutation(),
		resolveAgentDir: () => '/tmp/agent',
	});
	const list = methods.get('coclaw.providerAuth.list');
	const { respond, calls } = respondCollector();
	await list({ params: {}, respond });
	assert.equal(calls[0].err.code, 'IO_FAILED');
});

test('wrap: SDK loader rejects with non-Error → message stringified', async () => {
	const { api, methods } = createMockApi();
	registerProviderAuthHandlers(api, {
		loadSdk: async () => { throw 'boom'; },
		loadConfigMutation: async () => fakeConfigMutation(),
		resolveAgentDir: () => '/tmp/agent',
	});
	const remove = methods.get('coclaw.providerAuth.remove');
	const { respond, calls } = respondCollector();
	await remove({ params: { provider: 'groq' }, respond });
	assert.equal(calls[0].err.code, 'IO_FAILED');
	assert.equal(calls[0].err.message, 'boom');
});

test('wrap: per-registration handlersPromise is isolated (two registers do not share state)', async () => {
	const { api: api1, methods: methods1 } = createMockApi();
	const { api: api2, methods: methods2 } = createMockApi();
	let loads1 = 0;
	let loads2 = 0;
	registerProviderAuthHandlers(api1, {
		loadSdk: async () => { loads1 += 1; return fakeSdk(); },
		loadConfigMutation: async () => fakeConfigMutation(),
		resolveAgentDir: () => '/tmp/a',
	});
	registerProviderAuthHandlers(api2, {
		loadSdk: async () => { loads2 += 1; return fakeSdk(); },
		loadConfigMutation: async () => fakeConfigMutation(),
		resolveAgentDir: () => '/tmp/b',
	});
	const r1 = respondCollector();
	await methods1.get('coclaw.providerAuth.list')({ params: {}, respond: r1.respond });
	const r2 = respondCollector();
	await methods2.get('coclaw.providerAuth.list')({ params: {}, respond: r2.respond });
	// 各自的 loader 各调一次
	assert.equal(loads1, 1);
	assert.equal(loads2, 1);
	assert.equal(r1.calls[0].ok, true);
	assert.equal(r2.calls[0].ok, true);
});

test('wrap: concurrent first-call invocations only trigger one SDK load (in-flight share)', async () => {
	const { api, methods } = createMockApi();
	let loads = 0;
	let resolveLoad;
	const sdkReady = new Promise((r) => { resolveLoad = r; });
	registerProviderAuthHandlers(api, {
		loadSdk: async () => {
			loads += 1;
			await sdkReady;
			return fakeSdk();
		},
		loadConfigMutation: async () => fakeConfigMutation(),
		resolveAgentDir: () => '/tmp/agent',
	});
	const setApiKey = methods.get('coclaw.providerAuth.setApiKey');
	const r1 = respondCollector();
	const r2 = respondCollector();
	const p1 = setApiKey({ params: { provider: 'a', apiKey: 'k1' }, respond: r1.respond });
	const p2 = setApiKey({ params: { provider: 'b', apiKey: 'k2' }, respond: r2.respond });
	resolveLoad();
	await Promise.all([p1, p2]);
	assert.equal(loads, 1);
	assert.equal(r1.calls[0].ok, true);
	assert.equal(r2.calls[0].ok, true);
});

// === OAuth 方法的 index 接线（不触网：region 校验 / cancel 走早返路径） ===

test('loginOauth wired through index: invalid region → INVALID_ARGS (no network)', async () => {
	const { api, methods } = createMockApi();
	registerWithStubs(api);
	const loginOauth = methods.get('coclaw.providerAuth.loginOauth');
	const { respond, calls } = respondCollector();
	await loginOauth({ params: { region: 'eu' }, respond });
	assert.equal(calls[0].err.code, 'INVALID_ARGS');
});

test('cancelOauth wired through index with default registry: unknown loginId → {}', async () => {
	const { api, methods } = createMockApi();
	registerWithStubs(api);
	const cancelOauth = methods.get('coclaw.providerAuth.cancelOauth');
	const { respond, calls } = respondCollector();
	await cancelOauth({ params: { loginId: 'nope' }, respond });
	assert.equal(calls[0].ok, true);
	assert.deepEqual(calls[0].data, {});
});

test('custom registry injection is honored', async () => {
	const { api, methods } = createMockApi();
	const ac = new AbortController();
	const reg = {
		registerLogin() {},
		getLogin: (id) => (id === 'L1' ? { abortController: ac } : undefined),
		removeLogin() {},
	};
	registerWithStubs(api, { registry: reg });
	const cancelOauth = methods.get('coclaw.providerAuth.cancelOauth');
	const { respond, calls } = respondCollector();
	await cancelOauth({ params: { loginId: 'L1' }, respond });
	assert.equal(ac.signal.aborted, true);
	assert.equal(calls[0].ok, true);
});

test('default loader: registerProviderAuthHandlers without opts wires five methods + dynamic-import path runs', async () => {
	__resetSdkCache();
	const { api, methods } = createMockApi();
	registerProviderAuthHandlers(api);
	assert.equal(methods.size, 5);
	const remove = methods.get('coclaw.providerAuth.remove');
	const { respond, calls } = respondCollector();
	await remove({ params: { provider: 'groq' }, respond });
	// 测试环境通常无 openclaw npm 包 → 落到 IO_FAILED；若环境恰好可解析也仍是 respond 一次
	assert.equal(calls.length, 1);
	__resetSdkCache();
});

test('__resetSdkCache: after reset, default loader is invoked again on next register call', async () => {
	__resetSdkCache();
	let loads = 0;
	const { api: api1, methods: m1 } = createMockApi();
	registerProviderAuthHandlers(api1, {
		loadSdk: async () => { loads += 1; return fakeSdk(); },
		loadConfigMutation: async () => fakeConfigMutation(),
	});
	await m1.get('coclaw.providerAuth.list')({ params: {}, respond: () => {} });
	assert.equal(loads, 1);
	// 模块级 _sdkPromise 不被本地 loadSdk 注入路径污染（注入路径不读 _sdkPromise）
	__resetSdkCache();
	const { api: api2, methods: m2 } = createMockApi();
	registerProviderAuthHandlers(api2, {
		loadSdk: async () => { loads += 1; return fakeSdk(); },
		loadConfigMutation: async () => fakeConfigMutation(),
	});
	await m2.get('coclaw.providerAuth.list')({ params: {}, respond: () => {} });
	assert.equal(loads, 2);
});
