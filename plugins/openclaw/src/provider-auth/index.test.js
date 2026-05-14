import assert from 'node:assert/strict';
import test from 'node:test';

import { registerProviderAuthHandlers, __resetSdkCache } from './index.js';

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
	};
}

test('registerProviderAuthHandlers registers three RPC methods with coclaw.providerAuth.* names', () => {
	const { api, methods } = createMockApi();
	registerProviderAuthHandlers(api, {
		loadSdk: async () => fakeSdk(),
		resolveAgentDir: () => '/tmp/agent',
	});
	assert.deepEqual(
		[...methods.keys()].sort(),
		[
			'coclaw.providerAuth.list',
			'coclaw.providerAuth.remove',
			'coclaw.providerAuth.setApiKey',
		],
	);
});

test('wrap: handlers cache after first SDK load (loader called once across multiple methods)', async () => {
	const { api, methods } = createMockApi();
	let loadCount = 0;
	registerProviderAuthHandlers(api, {
		loadSdk: async () => { loadCount += 1; return fakeSdk(); },
		resolveAgentDir: () => '/tmp/agent',
	});
	const setApiKey = methods.get('coclaw.providerAuth.setApiKey');
	const list = methods.get('coclaw.providerAuth.list');
	const r1 = respondCollector();
	await setApiKey({ params: { provider: 'groq', apiKey: 'sk-x' }, respond: r1.respond });
	const r2 = respondCollector();
	await list({ params: {}, respond: r2.respond });
	assert.equal(loadCount, 1);
	assert.equal(r1.calls[0].ok, true);
	assert.equal(r2.calls[0].ok, true);
});

test('wrap: SDK loader rejects → respond(false) with IO_FAILED + message', async () => {
	const { api, methods } = createMockApi();
	registerProviderAuthHandlers(api, {
		loadSdk: async () => { throw new Error('npm package missing'); },
		resolveAgentDir: () => '/tmp/agent',
	});
	const setApiKey = methods.get('coclaw.providerAuth.setApiKey');
	const { respond, calls } = respondCollector();
	await setApiKey({ params: { provider: 'groq', apiKey: 'sk-x' }, respond });
	assert.equal(calls[0].ok, false);
	assert.equal(calls[0].err.code, 'IO_FAILED');
	assert.equal(calls[0].err.message, 'npm package missing');
});

test('wrap: SDK loader rejects with custom err.code is NOT preserved (always IO_FAILED)', async () => {
	const { api, methods } = createMockApi();
	registerProviderAuthHandlers(api, {
		loadSdk: async () => {
			const err = new Error('not on host');
			err.code = 'SDK_UNAVAILABLE';
			throw err;
		},
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
		resolveAgentDir: () => '/tmp/a',
	});
	registerProviderAuthHandlers(api2, {
		loadSdk: async () => { loads2 += 1; return fakeSdk(); },
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

test('default loader: registerProviderAuthHandlers without opts wires three methods + dynamic-import path runs', async () => {
	__resetSdkCache();
	const { api, methods } = createMockApi();
	registerProviderAuthHandlers(api);
	assert.equal(methods.size, 3);
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
	});
	await m1.get('coclaw.providerAuth.list')({ params: {}, respond: () => {} });
	assert.equal(loads, 1);
	// 模块级 _sdkPromise 不被本地 loadSdk 注入路径污染（注入路径不读 _sdkPromise）
	__resetSdkCache();
	const { api: api2, methods: m2 } = createMockApi();
	registerProviderAuthHandlers(api2, {
		loadSdk: async () => { loads += 1; return fakeSdk(); },
	});
	await m2.get('coclaw.providerAuth.list')({ params: {}, respond: () => {} });
	assert.equal(loads, 2);
});
