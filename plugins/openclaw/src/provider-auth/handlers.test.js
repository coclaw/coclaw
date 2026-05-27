import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProviderAuthHandlers } from './handlers.js';
import { PORTAL_PROVIDER_ID, CONFIG_DEFAULT_BASE_URL } from './minimax-oauth.js';
import { getPortalModels } from './portal-model-catalog.js';

// fake sdk —— 只覆盖 handlers 实际调到的方法
function createStubSdk(overrides = {}) {
	return {
		// async；默认返回 truthy store 表示成功
		upsertAuthProfileWithLock: async () => ({ version: 1, profiles: {} }),
		buildApiKeyCredential: (provider, input, _metadata, _options) => ({
			type: 'api_key',
			provider,
			key: input,
		}),
		ensureAuthProfileStore: () => ({ version: 1, profiles: {} }),
		removeProviderAuthProfilesWithLock: async () => ({ version: 1, profiles: {} }),
		// 简单 head4..tail4 mock；短串退化到 head2..tail2 / head1.. 形式
		formatApiKeyPreview: (raw) => {
			const t = raw.trim();
			if (!t) return '…';
			if (t.length <= 8) {
				const head = Math.min(2, t.length);
				const tail = Math.min(2, t.length - head);
				return tail > 0 ? `${t.slice(0, head)}…${t.slice(-tail)}` : `${t.slice(0, head)}…`;
			}
			return `${t.slice(0, 4)}…${t.slice(-4)}`;
		},
		...overrides,
	};
}

function makeRespond() {
	const calls = [];
	function respond(ok, data, err) {
		calls.push({ ok, data, err });
	}
	return { respond, calls };
}

const AGENT_DIR = '/fake/state/agents/main/agent';

function build(sdkOverrides = {}) {
	return buildProviderAuthHandlers({
		sdk: createStubSdk(sdkOverrides),
		resolveAgentDir: () => AGENT_DIR,
	});
}

// === setApiKey ===

test('setApiKey: happy path returns default profileId; SDK called with locked variant + buildApiKeyCredential', async () => {
	const credCalls = [];
	const upsertCalls = [];
	const handlers = buildProviderAuthHandlers({
		sdk: createStubSdk({
			buildApiKeyCredential: (provider, input, metadata, options) => {
				credCalls.push({ provider, input, metadata, options });
				return { type: 'api_key', provider, key: input };
			},
			upsertAuthProfileWithLock: async (params) => {
				upsertCalls.push(params);
				return { version: 1, profiles: {} };
			},
		}),
		resolveAgentDir: () => AGENT_DIR,
	});
	const { respond, calls } = makeRespond();
	await handlers.setApiKey({
		params: { provider: 'groq', apiKey: 'sk-test-abcd1234' },
		respond,
	});
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], { ok: true, data: { profileId: 'groq:default' }, err: undefined });
	assert.equal(credCalls.length, 1);
	assert.equal(credCalls[0].provider, 'groq');
	assert.equal(credCalls[0].input, 'sk-test-abcd1234');
	assert.equal(credCalls[0].metadata, undefined);
	assert.deepEqual(credCalls[0].options, { secretInputMode: 'plaintext' });
	assert.equal(upsertCalls.length, 1);
	assert.equal(upsertCalls[0].profileId, 'groq:default');
	assert.equal(upsertCalls[0].agentDir, AGENT_DIR);
	assert.deepEqual(upsertCalls[0].credential, { type: 'api_key', provider: 'groq', key: 'sk-test-abcd1234' });
});

test('setApiKey: explicit profileId is forwarded to SDK', async () => {
	const upsertCalls = [];
	const handlers = buildProviderAuthHandlers({
		sdk: createStubSdk({
			upsertAuthProfileWithLock: async (params) => {
				upsertCalls.push(params);
				return { version: 1, profiles: {} };
			},
		}),
		resolveAgentDir: () => AGENT_DIR,
	});
	const { respond, calls } = makeRespond();
	await handlers.setApiKey({
		params: { provider: 'groq', apiKey: 'sk-xxx', profileId: 'groq:work' },
		respond,
	});
	assert.deepEqual(calls[0].data, { profileId: 'groq:work' });
	assert.equal(upsertCalls[0].profileId, 'groq:work');
});

test('setApiKey: re-set existing api_key for same provider overwrites without conflict check', async () => {
	// 模拟：第一次 set 写入 → 第二次 set 同 provider 直接顶替
	let calls = 0;
	const handlers = build({
		upsertAuthProfileWithLock: async (params) => {
			calls += 1;
			return { version: 1, profiles: { [params.profileId]: params.credential } };
		},
	});
	const r1 = makeRespond();
	await handlers.setApiKey({ params: { provider: 'groq', apiKey: 'sk-1' }, respond: r1.respond });
	const r2 = makeRespond();
	await handlers.setApiKey({ params: { provider: 'groq', apiKey: 'sk-2' }, respond: r2.respond });
	assert.equal(calls, 2);
	assert.equal(r1.calls[0].ok, true);
	assert.equal(r2.calls[0].ok, true);
	assert.equal(r2.calls[0].data.profileId, 'groq:default');
});

test('setApiKey: missing provider → INVALID_ARGS', async () => {
	const handlers = build();
	const { respond, calls } = makeRespond();
	await handlers.setApiKey({ params: { apiKey: 'sk-x' }, respond });
	assert.equal(calls[0].ok, false);
	assert.equal(calls[0].err.code, 'INVALID_ARGS');
	assert.match(calls[0].err.message, /provider/);
});

test('setApiKey: empty/whitespace provider → INVALID_ARGS', async () => {
	const handlers = build();
	const { respond, calls } = makeRespond();
	await handlers.setApiKey({ params: { provider: '   ', apiKey: 'sk-x' }, respond });
	assert.equal(calls[0].err.code, 'INVALID_ARGS');
});

test('setApiKey: non-string provider → INVALID_ARGS', async () => {
	const handlers = build();
	const { respond, calls } = makeRespond();
	await handlers.setApiKey({ params: { provider: 42, apiKey: 'sk-x' }, respond });
	assert.equal(calls[0].err.code, 'INVALID_ARGS');
});

test('setApiKey: missing apiKey → INVALID_ARGS', async () => {
	const handlers = build();
	const { respond, calls } = makeRespond();
	await handlers.setApiKey({ params: { provider: 'groq' }, respond });
	assert.equal(calls[0].err.code, 'INVALID_ARGS');
	assert.match(calls[0].err.message, /apiKey/);
});

test('setApiKey: whitespace-only apiKey → INVALID_ARGS', async () => {
	const handlers = build();
	const { respond, calls } = makeRespond();
	await handlers.setApiKey({ params: { provider: 'groq', apiKey: '   ' }, respond });
	assert.equal(calls[0].err.code, 'INVALID_ARGS');
	assert.match(calls[0].err.message, /apiKey/);
});

test('setApiKey: profileId provided as empty string → INVALID_ARGS', async () => {
	const handlers = build();
	const { respond, calls } = makeRespond();
	await handlers.setApiKey({
		params: { provider: 'groq', apiKey: 'sk-x', profileId: '' },
		respond,
	});
	assert.equal(calls[0].err.code, 'INVALID_ARGS');
	assert.match(calls[0].err.message, /profileId/);
});

test('setApiKey: SDK rejects → IO_FAILED with message propagation', async () => {
	const handlers = build({
		upsertAuthProfileWithLock: async () => {
			const err = new Error('disk write failed');
			throw err;
		},
	});
	const { respond, calls } = makeRespond();
	await handlers.setApiKey({
		params: { provider: 'groq', apiKey: 'sk-x' },
		respond,
	});
	assert.equal(calls[0].ok, false);
	assert.equal(calls[0].err.code, 'IO_FAILED');
	assert.equal(calls[0].err.message, 'disk write failed');
});

test('setApiKey: SDK error with custom err.code is NOT preserved (always IO_FAILED)', async () => {
	const handlers = build({
		upsertAuthProfileWithLock: async () => {
			const err = new Error('locked');
			err.code = 'LOCK_BUSY';
			throw err;
		},
	});
	const { respond, calls } = makeRespond();
	await handlers.setApiKey({ params: { provider: 'groq', apiKey: 'sk-x' }, respond });
	assert.equal(calls[0].err.code, 'IO_FAILED');
	assert.equal(calls[0].err.message, 'locked');
});

test('setApiKey: SDK returns null (lock contention silently swallowed) → IO_FAILED', async () => {
	const handlers = build({
		upsertAuthProfileWithLock: async () => null,
	});
	const { respond, calls } = makeRespond();
	await handlers.setApiKey({ params: { provider: 'groq', apiKey: 'sk-x' }, respond });
	assert.equal(calls[0].ok, false);
	assert.equal(calls[0].err.code, 'IO_FAILED');
	assert.match(calls[0].err.message, /failed to write/);
});

test('setApiKey: buildApiKeyCredential throws → IO_FAILED', async () => {
	const handlers = build({
		buildApiKeyCredential: () => { throw new Error('bad input shape'); },
	});
	const { respond, calls } = makeRespond();
	await handlers.setApiKey({ params: { provider: 'groq', apiKey: 'sk-x' }, respond });
	assert.equal(calls[0].err.code, 'IO_FAILED');
	assert.equal(calls[0].err.message, 'bad input shape');
});

// === list ===

test('list: returns api_key entry with keyPreview, no raw key', async () => {
	const handlers = build({
		ensureAuthProfileStore: () => ({
			version: 1,
			profiles: {
				'groq:default': { type: 'api_key', provider: 'groq', key: 'sk-test-abcd-1234-XYZW' },
			},
		}),
	});
	const { respond, calls } = makeRespond();
	await handlers.list({ params: {}, respond });
	assert.equal(calls[0].ok, true);
	const out = calls[0].data.profiles;
	assert.equal(out.length, 1);
	assert.equal(out[0].profileId, 'groq:default');
	assert.equal(out[0].provider, 'groq');
	assert.equal(out[0].type, 'api_key');
	assert.equal(out[0].keyPreview, 'sk-t…XYZW');
	// 绝对不带原始 key
	assert.equal('key' in out[0], false);
});

test('list: short api_key (≤8 chars) gets degraded mask', async () => {
	const handlers = build({
		ensureAuthProfileStore: () => ({
			version: 1,
			profiles: { 'x:default': { type: 'api_key', provider: 'x', key: 'abc123' } },
		}),
	});
	const { respond, calls } = makeRespond();
	await handlers.list({ params: {}, respond });
	const preview = calls[0].data.profiles[0].keyPreview;
	// stub formatApiKeyPreview 对 6 字符走 head2..tail2 分支
	assert.equal(preview, 'ab…23');
});

test('list: api_key without `key` (keyRef-only env mode) omits keyPreview', async () => {
	const handlers = build({
		ensureAuthProfileStore: () => ({
			version: 1,
			profiles: {
				'env:default': { type: 'api_key', provider: 'env', keyRef: { env: 'X_API_KEY' } },
			},
		}),
	});
	const { respond, calls } = makeRespond();
	await handlers.list({ params: {}, respond });
	const out = calls[0].data.profiles[0];
	assert.equal('keyPreview' in out, false);
});

test('list: oauth entry exposes email/displayName/expiresAt but no access/refresh', async () => {
	const handlers = build({
		ensureAuthProfileStore: () => ({
			version: 1,
			profiles: {
				'oai:default': {
					type: 'oauth',
					provider: 'openai-codex',
					access: 'SECRET_ACCESS',
					refresh: 'SECRET_REFRESH',
					expires: 1234567890123,
					email: 'a@b.com',
					displayName: 'Alice',
				},
			},
		}),
	});
	const { respond, calls } = makeRespond();
	await handlers.list({ params: {}, respond });
	const out = calls[0].data.profiles[0];
	assert.equal(out.type, 'oauth');
	assert.equal(out.email, 'a@b.com');
	assert.equal(out.displayName, 'Alice');
	assert.equal(out.expiresAt, 1234567890123);
	assert.equal('access' in out, false);
	assert.equal('refresh' in out, false);
	assert.equal('keyPreview' in out, false);
});

test('list: token entry with expires exposes expiresAt but not token', async () => {
	const handlers = build({
		ensureAuthProfileStore: () => ({
			version: 1,
			profiles: {
				't:default': {
					type: 'token',
					provider: 'cli',
					token: 'SECRET_TOKEN',
					expires: 999,
				},
			},
		}),
	});
	const { respond, calls } = makeRespond();
	await handlers.list({ params: {}, respond });
	const out = calls[0].data.profiles[0];
	assert.equal(out.expiresAt, 999);
	assert.equal('token' in out, false);
	assert.equal('keyPreview' in out, false);
});

test('list: token without expires omits expiresAt', async () => {
	const handlers = build({
		ensureAuthProfileStore: () => ({
			version: 1,
			profiles: { 't:default': { type: 'token', provider: 'cli', token: 'X' } },
		}),
	});
	const { respond, calls } = makeRespond();
	await handlers.list({ params: {}, respond });
	const out = calls[0].data.profiles[0];
	assert.equal('expiresAt' in out, false);
});

test('list: filters by provider when params.provider set', async () => {
	const handlers = build({
		ensureAuthProfileStore: () => ({
			version: 1,
			profiles: {
				'groq:default': { type: 'api_key', provider: 'groq', key: 'gk-abcdefgh' },
				'oai:default': { type: 'api_key', provider: 'openai', key: 'sk-abcdefgh' },
			},
		}),
	});
	const { respond, calls } = makeRespond();
	await handlers.list({ params: { provider: 'groq' }, respond });
	const out = calls[0].data.profiles;
	assert.equal(out.length, 1);
	assert.equal(out[0].provider, 'groq');
});

test('list: provider param missing → returns all profiles', async () => {
	const handlers = build({
		ensureAuthProfileStore: () => ({
			version: 1,
			profiles: {
				'a:default': { type: 'api_key', provider: 'a', key: 'aaaaaaaaaa' },
				'b:default': { type: 'api_key', provider: 'b', key: 'bbbbbbbbbb' },
			},
		}),
	});
	const { respond, calls } = makeRespond();
	await handlers.list({ params: {}, respond });
	assert.equal(calls[0].data.profiles.length, 2);
});

test('list: empty/whitespace provider filter → INVALID_ARGS', async () => {
	const handlers = build();
	const { respond, calls } = makeRespond();
	await handlers.list({ params: { provider: '   ' }, respond });
	assert.equal(calls[0].err.code, 'INVALID_ARGS');
});

test('list: store with no profiles returns empty array', async () => {
	const handlers = build({
		ensureAuthProfileStore: () => ({ version: 1, profiles: {} }),
	});
	const { respond, calls } = makeRespond();
	await handlers.list({ params: {}, respond });
	assert.deepEqual(calls[0].data, { profiles: [] });
});

test('list: store.profiles missing → empty array (defensive)', async () => {
	const handlers = build({
		ensureAuthProfileStore: () => ({ version: 1 }),
	});
	const { respond, calls } = makeRespond();
	await handlers.list({ params: {}, respond });
	assert.deepEqual(calls[0].data, { profiles: [] });
});

test('list: malformed entries (null / non-object / missing provider / unknown type) are skipped', async () => {
	const handlers = build({
		ensureAuthProfileStore: () => ({
			version: 1,
			profiles: {
				'bad:1': null,
				'bad:2': 'not-an-object',
				'bad:3': { type: 'api_key' },           // missing provider
				'bad:4': { type: 'api_key', provider: '' }, // empty provider
				'bad:5': { type: 'unknown', provider: 'x' }, // unknown type
				'bad:6': { provider: 'p' },              // missing type
				'good:default': { type: 'api_key', provider: 'good', key: 'gggggggggg' },
			},
		}),
	});
	const { respond, calls } = makeRespond();
	await handlers.list({ params: {}, respond });
	const out = calls[0].data.profiles;
	assert.equal(out.length, 1);
	assert.equal(out[0].profileId, 'good:default');
});

test('list: SDK throws → IO_FAILED', async () => {
	const handlers = build({
		ensureAuthProfileStore: () => { throw new Error('store unreadable'); },
	});
	const { respond, calls } = makeRespond();
	await handlers.list({ params: {}, respond });
	assert.equal(calls[0].err.code, 'IO_FAILED');
	assert.equal(calls[0].err.message, 'store unreadable');
});

test('list: SDK throws non-Error → IO_FAILED with stringified message', async () => {
	const handlers = build({
		ensureAuthProfileStore: () => { throw 'plain string error'; },
	});
	const { respond, calls } = makeRespond();
	await handlers.list({ params: {}, respond });
	assert.equal(calls[0].err.code, 'IO_FAILED');
	assert.equal(calls[0].err.message, 'plain string error');
});

test('list: SDK error with custom err.code is NOT preserved', async () => {
	const handlers = build({
		ensureAuthProfileStore: () => {
			const err = new Error('forbidden');
			err.code = 'EACCES';
			throw err;
		},
	});
	const { respond, calls } = makeRespond();
	await handlers.list({ params: {}, respond });
	assert.equal(calls[0].err.code, 'IO_FAILED');
});

// === remove ===

test('remove: happy path → respond(true, {}), no inner payload', async () => {
	const captured = [];
	const handlers = build({
		removeProviderAuthProfilesWithLock: async (params) => {
			captured.push(params);
			return { version: 1, profiles: {} };
		},
	});
	const { respond, calls } = makeRespond();
	await handlers.remove({ params: { provider: 'groq' }, respond });
	assert.equal(calls[0].ok, true);
	assert.deepEqual(calls[0].data, {});
	assert.deepEqual(captured[0], { provider: 'groq', agentDir: AGENT_DIR });
});

test('remove: idempotent — removing nonexistent provider succeeds (mirrors SDK behavior)', async () => {
	// SDK 在 provider 不存在时 updater 返 false 但仍返回 store（truthy）—— handler 要照样 success
	const handlers = build({
		removeProviderAuthProfilesWithLock: async () => ({ version: 1, profiles: {} }),
	});
	const r1 = makeRespond();
	await handlers.remove({ params: { provider: 'never-existed' }, respond: r1.respond });
	const r2 = makeRespond();
	await handlers.remove({ params: { provider: 'never-existed' }, respond: r2.respond });
	assert.equal(r1.calls[0].ok, true);
	assert.equal(r2.calls[0].ok, true);
});

test('remove: missing provider → INVALID_ARGS', async () => {
	const handlers = build();
	const { respond, calls } = makeRespond();
	await handlers.remove({ params: {}, respond });
	assert.equal(calls[0].err.code, 'INVALID_ARGS');
});

test('remove: non-string provider → INVALID_ARGS', async () => {
	const handlers = build();
	const { respond, calls } = makeRespond();
	await handlers.remove({ params: { provider: null }, respond });
	assert.equal(calls[0].err.code, 'INVALID_ARGS');
});

test('remove: SDK rejects → IO_FAILED', async () => {
	const handlers = build({
		removeProviderAuthProfilesWithLock: async () => {
			const err = new Error('lock contention');
			throw err;
		},
	});
	const { respond, calls } = makeRespond();
	await handlers.remove({ params: { provider: 'groq' }, respond });
	assert.equal(calls[0].err.code, 'IO_FAILED');
	assert.equal(calls[0].err.message, 'lock contention');
});

test('remove: SDK returns null (silent lock failure) → IO_FAILED', async () => {
	const handlers = build({
		removeProviderAuthProfilesWithLock: async () => null,
	});
	const { respond, calls } = makeRespond();
	await handlers.remove({ params: { provider: 'groq' }, respond });
	assert.equal(calls[0].ok, false);
	assert.equal(calls[0].err.code, 'IO_FAILED');
	assert.match(calls[0].err.message, /failed to update/);
});

test('remove: SDK error with custom err.code is NOT preserved', async () => {
	const handlers = build({
		removeProviderAuthProfilesWithLock: async () => {
			const err = new Error('access denied');
			err.code = 'EACCES';
			throw err;
		},
	});
	const { respond, calls } = makeRespond();
	await handlers.remove({ params: { provider: 'groq' }, respond });
	assert.equal(calls[0].err.code, 'IO_FAILED');
});

test('remove: undefined params object → INVALID_ARGS (defensive)', async () => {
	const handlers = build();
	const { respond, calls } = makeRespond();
	await handlers.remove({ respond });
	assert.equal(calls[0].err.code, 'INVALID_ARGS');
});

// === concurrency: verify the handler awaits SDK serialization (mock simulates lock) ===

test('parallel setApiKey: handlers serialize on the SDK lock and both succeed', async () => {
	// 真锁安全由 SDK 的 updateAuthProfileStoreWithLock 保证；
	// 这里用一把 mock lock 验证我们的 handler 不会绕过 SDK 的串行点
	let inFlight = 0;
	let maxConcurrent = 0;
	const completionOrder = [];
	let releaseFirst;
	const firstRunning = new Promise((r) => { releaseFirst = r; });
	let firstStarted = false;
	const handlers = build({
		upsertAuthProfileWithLock: async (params) => {
			inFlight += 1;
			maxConcurrent = Math.max(maxConcurrent, inFlight);
			// 第一次进入：等待外部释放，模拟"持锁中"
			if (!firstStarted) {
				firstStarted = true;
				await firstRunning;
			}
			completionOrder.push(params.profileId);
			inFlight -= 1;
			return { version: 1, profiles: {} };
		},
	});
	const r1 = makeRespond();
	const r2 = makeRespond();
	const p1 = handlers.setApiKey({ params: { provider: 'a', apiKey: 'k1' }, respond: r1.respond });
	const p2 = handlers.setApiKey({ params: { provider: 'b', apiKey: 'k2' }, respond: r2.respond });
	// 至此两个 handler 都进了 SDK，第二个被卡在 inFlight=2（mock 不真锁，所以 inFlight 可能短暂叠到 2，
	// 但真 SDK 是 file-lock 串行的——这里关键是 handler 都正确 await 了 SDK 调用，没有 fire-and-forget）
	releaseFirst();
	await Promise.all([p1, p2]);
	assert.equal(r1.calls[0].ok, true);
	assert.equal(r2.calls[0].ok, true);
	// mock 只卡了第一个进入的 SDK 调用——其它直接落 completion；所以 b 先完成、a 后完成
	assert.deepEqual(completionOrder, ['b:default', 'a:default']);
	// inFlight 叠到 2 → 两个 handler 都进了 SDK 后第一个还没 resolve，
	// 证明 handler 是真并发发起调用、await SDK 串行点，而不是顺序 fire-and-await
	assert.ok(maxConcurrent >= 2, `expected handlers to call SDK concurrently; saw maxConcurrent=${maxConcurrent}`);
});

// === end-to-end fixtures: 让 set / list / remove 共用同一份 in-memory store 串起来跑 ===
// 真实 SDK 的 updateAuthProfileStoreWithLock 是 read-modify-write + 文件锁，
// 这里用 in-memory 等价物（共享 store + mutex），模拟 set→store→list 的 round-trip 行为。
// 单元测试环境没有 openclaw npm 包；这套 stub 用来钉死 handler 与 SDK 契约的衔接面，
// 真正的磁盘/锁安全留给上游 SDK 自己的单测。

function createRoundTripSdk(initialProfiles = {}) {
	const store = { version: 1, profiles: { ...initialProfiles } };
	let lockChain = Promise.resolve();
	async function withLock(fn) {
		const prev = lockChain;
		let release;
		lockChain = new Promise((r) => { release = r; });
		try {
			await prev;
			return await fn();
		}
		finally { release(); }
	}
	return {
		__store: store,
		buildApiKeyCredential: (provider, input, _metadata, _options) => ({
			type: 'api_key',
			provider,
			key: input,
		}),
		upsertAuthProfileWithLock: async ({ profileId, credential }) => withLock(async () => {
			store.profiles[profileId] = { ...credential };
			return { version: store.version, profiles: { ...store.profiles } };
		}),
		removeProviderAuthProfilesWithLock: async ({ provider }) => withLock(async () => {
			let removed = false;
			for (const id of Object.keys(store.profiles)) {
				if (store.profiles[id]?.provider === provider) {
					delete store.profiles[id];
					removed = true;
				}
			}
			// SDK 真实行为：找不到 provider 也返回 store（truthy），不返 null
			void removed;
			return { version: store.version, profiles: { ...store.profiles } };
		}),
		ensureAuthProfileStore: () => ({
			version: store.version,
			profiles: { ...store.profiles },
		}),
		formatApiKeyPreview: (raw) => {
			const t = raw.trim();
			if (t.length <= 8) return `${t.slice(0, 2)}…${t.slice(-2)}`;
			return `${t.slice(0, 4)}…${t.slice(-4)}`;
		},
	};
}

function buildRoundTripHandlers(initialProfiles) {
	const sdk = createRoundTripSdk(initialProfiles);
	const handlers = buildProviderAuthHandlers({ sdk, resolveAgentDir: () => AGENT_DIR });
	return { handlers, sdk };
}

test('round-trip: set then list returns the just-written profile with masked preview', async () => {
	const { handlers, sdk } = buildRoundTripHandlers();
	const r1 = makeRespond();
	await handlers.setApiKey({
		params: { provider: 'groq', apiKey: 'sk-test-abcd-1234-XYZW' },
		respond: r1.respond,
	});
	assert.equal(r1.calls[0].ok, true);
	assert.deepEqual(r1.calls[0].data, { profileId: 'groq:default' });

	const r2 = makeRespond();
	await handlers.list({ params: {}, respond: r2.respond });
	assert.equal(r2.calls[0].ok, true);
	const profiles = r2.calls[0].data.profiles;
	assert.equal(profiles.length, 1);
	assert.equal(profiles[0].profileId, 'groq:default');
	assert.equal(profiles[0].provider, 'groq');
	assert.equal(profiles[0].type, 'api_key');
	assert.equal(profiles[0].keyPreview, 'sk-t…XYZW');
	// 凭据不外流
	assert.equal('key' in profiles[0], false);
	// 内部 store 真的写了
	assert.equal(sdk.__store.profiles['groq:default'].key, 'sk-test-abcd-1234-XYZW');
});

test('round-trip: remove then list drops the targeted provider but keeps others', async () => {
	const { handlers, sdk } = buildRoundTripHandlers({
		'groq:default': { type: 'api_key', provider: 'groq', key: 'gk-aaaaaaaaaa' },
		'groq:work': { type: 'api_key', provider: 'groq', key: 'gk-bbbbbbbbbb' },
		'openai:default': { type: 'api_key', provider: 'openai', key: 'sk-cccccccccc' },
	});

	const r1 = makeRespond();
	await handlers.remove({ params: { provider: 'groq' }, respond: r1.respond });
	assert.equal(r1.calls[0].ok, true);
	assert.deepEqual(r1.calls[0].data, {});

	const r2 = makeRespond();
	await handlers.list({ params: {}, respond: r2.respond });
	const profiles = r2.calls[0].data.profiles;
	assert.equal(profiles.length, 1);
	assert.equal(profiles[0].profileId, 'openai:default');
	// store 里 groq 系列都没了
	assert.equal('groq:default' in sdk.__store.profiles, false);
	assert.equal('groq:work' in sdk.__store.profiles, false);
});

test('round-trip: concurrent set on same profileId serializes via SDK lock; last write wins', async () => {
	const { handlers, sdk } = buildRoundTripHandlers();
	const r1 = makeRespond();
	const r2 = makeRespond();
	// 两次并发 setApiKey 打到同一 profileId（同 provider + 缺省 profileId）
	const p1 = handlers.setApiKey({
		params: { provider: 'groq', apiKey: 'sk-first-1111' },
		respond: r1.respond,
	});
	const p2 = handlers.setApiKey({
		params: { provider: 'groq', apiKey: 'sk-second-2222' },
		respond: r2.respond,
	});
	await Promise.all([p1, p2]);

	assert.equal(r1.calls[0].ok, true);
	assert.equal(r2.calls[0].ok, true);
	assert.deepEqual(r1.calls[0].data, { profileId: 'groq:default' });
	assert.deepEqual(r2.calls[0].data, { profileId: 'groq:default' });

	// list 应只看到一条；key 是 last-writer-wins
	const r3 = makeRespond();
	await handlers.list({ params: {}, respond: r3.respond });
	const profiles = r3.calls[0].data.profiles;
	assert.equal(profiles.length, 1);
	assert.equal(profiles[0].profileId, 'groq:default');
	// 由 mutex 串行保证：发起顺序 p1→p2，因此最终持久化的是 p2 的 key
	assert.equal(sdk.__store.profiles['groq:default'].key, 'sk-second-2222');
});

// === OAuth: loginOauth / cancelOauth ===

const PORTAL_PROFILE_ID = `${PORTAL_PROVIDER_ID}:default`;

// fake registry：记录登记 / 移除，可注入 throw 验证防御
function createStubRegistry(overrides = {}) {
	const store = new Map();
	const events = [];
	return {
		store,
		events,
		registerLogin(loginId, entry) {
			events.push(['register', loginId]);
			store.set(loginId, entry);
		},
		getLogin(loginId) {
			return store.get(loginId);
		},
		removeLogin(loginId) {
			events.push(['remove', loginId]);
			store.delete(loginId);
		},
		...overrides,
	};
}

// fake oauth：requestDeviceCode 返回固定设备码；pollUntilSettled 返回预设终态
function createStubOAuth(overrides = {}) {
	return {
		requestDeviceCode: async () => ({
			verifier: 'VERIFIER',
			userCode: 'USER-CODE',
			verificationUri: 'https://verify.example',
			expiresAt: 1700000000000,
			interval: 2000,
		}),
		pollUntilSettled: async () => ({
			status: 'success',
			token: { access: 'ACCESS', refresh: 'REFRESH', expires: 9999, resourceUrl: 'https://acct.example/anthropic' },
		}),
		...overrides,
	};
}

// 成功用例断言写入配置的就是内置静态表的清单——直接取 getPortalModels，验证写路径用的就是它
const EXPECTED_PORTAL_MODELS = getPortalModels(PORTAL_PROVIDER_ID);

// 把 oauth handler 构建出来；scheduleBackground 收集后台 promise，便于确定性 await
function buildOAuthHandlers({ sdkOverrides = {}, oauthOverrides = {}, registry, mutateConfigFile } = {}) {
	const bg = [];
	const mutateCalls = [];
	const logs = [];
	const defaultMutate = async ({ afterWrite, mutate }) => {
		const draft = { models: undefined };
		mutate(draft);
		mutateCalls.push({ afterWrite, draft });
	};
	const sdk = createStubSdk({
		mutateConfigFile: mutateConfigFile ?? defaultMutate,
		...sdkOverrides,
	});
	const reg = registry ?? createStubRegistry();
	const handlers = buildProviderAuthHandlers({
		sdk,
		resolveAgentDir: () => AGENT_DIR,
		oauth: createStubOAuth(oauthOverrides),
		registry: reg,
		genLoginId: () => 'LOGIN-1',
		scheduleBackground: (p) => { bg.push(p); },
		logRemote: (text) => { logs.push(text); },
	});
	return { handlers, bg, mutateCalls, registry: reg, sdk, logs };
}

test('loginOauth: invalid region → INVALID_ARGS, no device-code request', async () => {
	let requested = false;
	const { handlers } = buildOAuthHandlers({
		oauthOverrides: { requestDeviceCode: async () => { requested = true; return {}; } },
	});
	const { respond, calls } = makeRespond();
	await handlers.loginOauth({ params: { region: 'eu' }, respond });
	assert.equal(calls.length, 1); // 单帧错误，无 phase-2
	assert.equal(calls[0].ok, false);
	assert.equal(calls[0].err.code, 'INVALID_ARGS');
	assert.equal(requested, false);
});

test('loginOauth: phase-1 returns accepted frame with status + loginId + device code fields', async () => {
	const { handlers, bg, registry } = buildOAuthHandlers();
	const { respond, calls } = makeRespond();
	await handlers.loginOauth({ params: { region: 'cn' }, respond });
	// phase-1 帧
	assert.equal(calls[0].ok, true);
	assert.deepEqual(calls[0].data, {
		status: 'accepted',
		loginId: 'LOGIN-1',
		verificationUri: 'https://verify.example',
		userCode: 'USER-CODE',
		expiresAt: 1700000000000,
		interval: 2000,
	});
	// 登记发生在 respond accepted 之前
	assert.deepEqual(registry.events[0], ['register', 'LOGIN-1']);
	assert.equal(bg.length, 1);
});

test('loginOauth: registers loginId strictly BEFORE responding accepted (immediate cancel can find it)', async () => {
	const { respond, calls } = makeRespond();
	let respondCountAtRegister = -1;
	// 自定义 registry：在 registerLogin 时刻记录"已发出的 respond 数"，钉死时序而非靠两条独立数组推断
	const registry = createStubRegistry({
		registerLogin(loginId, entry) {
			respondCountAtRegister = calls.length;
			this.events.push(['register', loginId]);
			this.store.set(loginId, entry);
		},
	});
	const { handlers } = buildOAuthHandlers({ registry });
	await handlers.loginOauth({ params: { region: 'cn' }, respond });
	assert.equal(respondCountAtRegister, 0); // 登记那一刻还没 respond 过 → register 严格早于 accepted
	assert.equal(calls.length, 1); // 截至 phase-1 恰好一帧
	assert.equal(calls[0].data.status, 'accepted');
});

test('loginOauth: region defaults to cn when params omitted', async () => {
	let seenRegion;
	const { handlers, bg } = buildOAuthHandlers({
		oauthOverrides: {
			requestDeviceCode: async ({ region }) => {
				seenRegion = region;
				return { verifier: 'v', userCode: 'u', verificationUri: 'uri', expiresAt: 1, interval: 2000 };
			},
		},
	});
	const { respond } = makeRespond();
	await handlers.loginOauth({ respond });
	await Promise.all(bg);
	assert.equal(seenRegion, 'cn');
});

test('loginOauth: requestDeviceCode failure → single IO_FAILED frame, no registry, no background', async () => {
	const registry = createStubRegistry();
	const { handlers, bg } = buildOAuthHandlers({
		registry,
		oauthOverrides: { requestDeviceCode: async () => { throw new Error('network down'); } },
	});
	const { respond, calls } = makeRespond();
	await handlers.loginOauth({ params: { region: 'cn' }, respond });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].err.code, 'IO_FAILED');
	assert.equal(calls[0].err.message, 'network down');
	assert.equal(registry.events.length, 0);
	assert.equal(bg.length, 0);
});

test('loginOauth phase-2 success: writes oauth credential + provider cfg (static catalog), responds ok, clears registry', async () => {
	const upsertCalls = [];
	const { handlers, bg, mutateCalls, registry, logs } = buildOAuthHandlers({
		sdkOverrides: {
			upsertAuthProfileWithLock: async (p) => { upsertCalls.push(p); return { version: 1, profiles: {} }; },
		},
	});
	const { respond, calls } = makeRespond();
	await handlers.loginOauth({ params: { region: 'cn' }, respond });
	await Promise.all(bg);

	// 终态打了一条 ok 诊断（终态级、低频；带写入的模型数 = 静态表 2 个）
	assert.equal(logs.length, 1);
	assert.match(logs[0], /^providerAuth\.oauth\.ok loginId=LOGIN-1 profileId=.* models=2$/);

	// 写凭据：oauth 形态 + 共享锁入口 + main agentDir
	assert.equal(upsertCalls.length, 1);
	assert.equal(upsertCalls[0].profileId, PORTAL_PROFILE_ID);
	assert.equal(upsertCalls[0].agentDir, AGENT_DIR);
	assert.deepEqual(upsertCalls[0].credential, {
		type: 'oauth',
		provider: PORTAL_PROVIDER_ID,
		access: 'ACCESS',
		refresh: 'REFRESH',
		expires: 9999,
	});
	// 写配置：hot-reload afterWrite + provider 节点形态 + baseUrl 用动态 resourceUrl + 内置静态清单
	assert.equal(mutateCalls.length, 1);
	assert.deepEqual(mutateCalls[0].afterWrite, { mode: 'auto' });
	assert.deepEqual(mutateCalls[0].draft.models.providers[PORTAL_PROVIDER_ID], {
		baseUrl: 'https://acct.example/anthropic',
		api: 'anthropic-messages',
		authHeader: true,
		models: EXPECTED_PORTAL_MODELS,
	});
	// phase-2 终态帧
	assert.equal(calls.length, 2); // exactly-once：accepted + ok，无重复 respond
	const final = calls.at(-1);
	assert.equal(final.ok, true);
	assert.deepEqual(final.data, { status: 'ok', profileId: PORTAL_PROFILE_ID });
	// registry 清理
	assert.deepEqual(registry.events.at(-1), ['remove', 'LOGIN-1']);
});

test('loginOauth phase-2 success: preserves sibling providers (only overwrites the minimax-portal node)', async () => {
	// draft 起始就坐着一个用户自配 provider + 一份旧的 minimax-portal 节点；
	// 登录写配置时只能覆盖 minimax-portal，不能重建整个 providers map 把旁边的抹掉
	const sibling = { baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages', models: [{ id: 'claude', name: 'Claude' }] };
	const mutateCalls = [];
	const mutateConfigFile = async ({ afterWrite, mutate }) => {
		const draft = {
			models: {
				providers: {
					anthropic: structuredClone(sibling),
					[PORTAL_PROVIDER_ID]: { baseUrl: 'old', api: 'anthropic-messages', authHeader: true, models: [{ id: 'OLD', name: 'OLD' }] },
				},
			},
		};
		mutate(draft);
		mutateCalls.push({ afterWrite, draft });
	};
	const { handlers, bg } = buildOAuthHandlers({ mutateConfigFile });
	const { respond } = makeRespond();
	await handlers.loginOauth({ params: { region: 'cn' }, respond });
	await Promise.all(bg);

	assert.equal(mutateCalls.length, 1);
	const providers = mutateCalls[0].draft.models.providers;
	// 旁边的 provider 原样保留
	assert.deepEqual(providers.anthropic, sibling);
	// minimax-portal 被刷成静态表
	assert.deepEqual(providers[PORTAL_PROVIDER_ID].models, EXPECTED_PORTAL_MODELS);
});

test('loginOauth phase-2 success: missing resourceUrl falls back to cn config base url', async () => {
	const { handlers, bg, mutateCalls } = buildOAuthHandlers({
		oauthOverrides: {
			pollUntilSettled: async () => ({
				status: 'success',
				token: { access: 'A', refresh: 'R', expires: 1 }, // 无 resourceUrl
			}),
		},
	});
	const { respond } = makeRespond();
	await handlers.loginOauth({ params: { region: 'cn' }, respond });
	await Promise.all(bg);
	assert.equal(mutateCalls[0].draft.models.providers[PORTAL_PROVIDER_ID].baseUrl, CONFIG_DEFAULT_BASE_URL.cn);
});

test('loginOauth phase-2: upsert returns null → status error + IO_FAILED, no cfg write', async () => {
	const { handlers, bg, mutateCalls, registry, logs } = buildOAuthHandlers({
		sdkOverrides: { upsertAuthProfileWithLock: async () => null },
	});
	const { respond, calls } = makeRespond();
	await handlers.loginOauth({ params: { region: 'cn' }, respond });
	await Promise.all(bg);
	assert.equal(calls.length, 2); // exactly-once：accepted + error
	const final = calls.at(-1);
	assert.equal(final.ok, false);
	assert.deepEqual(final.data, { status: 'error' });
	assert.equal(final.err.code, 'IO_FAILED');
	assert.match(final.err.message, /failed to write/);
	assert.equal(mutateCalls.length, 0);
	assert.deepEqual(registry.events.at(-1), ['remove', 'LOGIN-1']); // finally 清理
	assert.match(logs.at(-1), /^providerAuth\.oauth\.io-failed loginId=LOGIN-1 stage=credential/);
});

test('loginOauth phase-2: mutateConfigFile throws → status error + IO_FAILED', async () => {
	const { handlers, bg, registry, logs } = buildOAuthHandlers({
		mutateConfigFile: async () => { throw new Error('cfg locked'); },
	});
	const { respond, calls } = makeRespond();
	await handlers.loginOauth({ params: { region: 'cn' }, respond });
	await Promise.all(bg);
	assert.equal(calls.length, 2); // exactly-once：accepted + error
	const final = calls.at(-1);
	assert.equal(final.ok, false);
	assert.deepEqual(final.data, { status: 'error' });
	assert.equal(final.err.code, 'IO_FAILED');
	assert.equal(final.err.message, 'cfg locked');
	assert.deepEqual(registry.events.at(-1), ['remove', 'LOGIN-1']); // finally 清理
	assert.match(logs.at(-1), /^providerAuth\.oauth\.io-failed loginId=LOGIN-1 stage=config/);
});

test('loginOauth phase-2: poll error → status error + OAUTH_FAILED with message', async () => {
	const { handlers, bg, registry, logs } = buildOAuthHandlers({
		oauthOverrides: { pollUntilSettled: async () => ({ status: 'error', message: 'auth denied' }) },
	});
	const { respond, calls } = makeRespond();
	await handlers.loginOauth({ params: { region: 'cn' }, respond });
	await Promise.all(bg);
	assert.equal(calls.length, 2); // exactly-once：accepted + error
	const final = calls.at(-1);
	assert.deepEqual(final.data, { status: 'error' });
	assert.equal(final.err.code, 'OAUTH_FAILED');
	assert.equal(final.err.message, 'auth denied');
	assert.deepEqual(registry.events.at(-1), ['remove', 'LOGIN-1']); // finally 清理
	assert.match(logs.at(-1), /^providerAuth\.oauth\.error loginId=LOGIN-1 msg=auth denied/);
});

test('loginOauth phase-2: poll error without message uses default message', async () => {
	const { handlers, bg } = buildOAuthHandlers({
		oauthOverrides: { pollUntilSettled: async () => ({ status: 'error' }) },
	});
	const { respond, calls } = makeRespond();
	await handlers.loginOauth({ params: { region: 'cn' }, respond });
	await Promise.all(bg);
	assert.match(calls.at(-1).err.message, /authorization failed/);
});

test('loginOauth phase-2: poll timeout → status timeout + OAUTH_TIMEOUT', async () => {
	const { handlers, bg, registry, logs } = buildOAuthHandlers({
		oauthOverrides: { pollUntilSettled: async () => ({ status: 'timeout' }) },
	});
	const { respond, calls } = makeRespond();
	await handlers.loginOauth({ params: { region: 'cn' }, respond });
	await Promise.all(bg);
	assert.equal(calls.length, 2); // exactly-once：accepted + timeout
	const final = calls.at(-1);
	assert.deepEqual(final.data, { status: 'timeout' });
	assert.equal(final.err.code, 'OAUTH_TIMEOUT');
	assert.deepEqual(registry.events.at(-1), ['remove', 'LOGIN-1']); // finally 清理
	assert.match(logs.at(-1), /^providerAuth\.oauth\.timeout loginId=LOGIN-1/);
});

test('loginOauth phase-2: poll cancelled → status cancelled + OAUTH_CANCELLED', async () => {
	const { handlers, bg, registry, logs } = buildOAuthHandlers({
		oauthOverrides: { pollUntilSettled: async () => ({ status: 'cancelled' }) },
	});
	const { respond, calls } = makeRespond();
	await handlers.loginOauth({ params: { region: 'cn' }, respond });
	await Promise.all(bg);
	assert.equal(calls.length, 2); // exactly-once：accepted + cancelled
	const final = calls.at(-1);
	assert.deepEqual(final.data, { status: 'cancelled' });
	assert.equal(final.err.code, 'OAUTH_CANCELLED');
	assert.deepEqual(registry.events.at(-1), ['remove', 'LOGIN-1']); // finally 清理
	assert.match(logs.at(-1), /^providerAuth\.oauth\.cancelled loginId=LOGIN-1/);
});

test('loginOauth phase-2: pollUntilSettled throws → defensive OAUTH_FAILED + registry cleared', async () => {
	const registry = createStubRegistry();
	const { handlers, bg, logs } = buildOAuthHandlers({
		registry,
		oauthOverrides: { pollUntilSettled: async () => { throw new Error('poll exploded'); } },
	});
	const { respond, calls } = makeRespond();
	await handlers.loginOauth({ params: { region: 'cn' }, respond });
	await Promise.all(bg);
	assert.equal(calls.length, 2); // exactly-once：accepted + 终态，无重复 respond
	const final = calls.at(-1);
	assert.equal(final.ok, false);
	assert.deepEqual(final.data, { status: 'error' });
	assert.equal(final.err.code, 'OAUTH_FAILED');
	assert.equal(final.err.message, 'poll exploded');
	assert.deepEqual(registry.events.at(-1), ['remove', 'LOGIN-1']);
	assert.match(logs.at(-1), /^providerAuth\.oauth\.error loginId=LOGIN-1 stage=poll msg=poll exploded/);
});

test('loginOauth: mutate creates models container when draft has none, and reuses existing providers', async () => {
	// 已有 models.providers 对象 → mutate 只增本节点，不重建容器
	const existing = { models: { providers: { other: { baseUrl: 'x' } } } };
	const { handlers, bg } = buildOAuthHandlers({
		mutateConfigFile: async ({ mutate }) => { mutate(existing); },
	});
	const { respond } = makeRespond();
	await handlers.loginOauth({ params: { region: 'cn' }, respond });
	await Promise.all(bg);
	assert.ok(existing.models.providers.other); // 原节点保留
	assert.ok(existing.models.providers[PORTAL_PROVIDER_ID]); // 新节点写入
});

test('loginOauth: mutate replaces non-object models / array providers defensively', async () => {
	const weird = { models: 'garbage' };
	const { handlers, bg } = buildOAuthHandlers({
		mutateConfigFile: async ({ mutate }) => { mutate(weird); },
	});
	const { respond } = makeRespond();
	await handlers.loginOauth({ params: { region: 'cn' }, respond });
	await Promise.all(bg);
	assert.equal(typeof weird.models, 'object');
	assert.ok(weird.models.providers[PORTAL_PROVIDER_ID]);

	const arrProviders = { models: { providers: ['bad'] } };
	const h2 = buildOAuthHandlers({ mutateConfigFile: async ({ mutate }) => { mutate(arrProviders); } });
	const r2 = makeRespond();
	await h2.handlers.loginOauth({ params: { region: 'cn' }, respond: r2.respond });
	await Promise.all(h2.bg);
	assert.ok(!Array.isArray(arrProviders.models.providers));
	assert.ok(arrProviders.models.providers[PORTAL_PROVIDER_ID]);
});

test('loginOauth: defaults (no genLoginId / scheduleBackground) — fire-and-forget swallows finally throw', async () => {
	// 不注入 genLoginId（走 randomUUID 默认）和 scheduleBackground（走默认 .catch(()=>{})）；
	// registry.removeLogin 抛错 → 后台 promise reject → 默认 .catch 吞掉，不带垮进程
	let removeThrew = false;
	const registry = createStubRegistry({
		removeLogin() { removeThrew = true; throw new Error('registry cleanup boom'); },
	});
	const handlers = buildProviderAuthHandlers({
		sdk: createStubSdk({ mutateConfigFile: async ({ mutate }) => { mutate({ models: undefined }); } }),
		resolveAgentDir: () => AGENT_DIR,
		oauth: createStubOAuth(),
		registry,
		logRemote: () => {},
	});
	const { respond, calls } = makeRespond();
	await handlers.loginOauth({ params: { region: 'cn' }, respond });
	// 让后台微任务跑完（默认 fire-and-forget 无法 await，用 setImmediate flush）
	await new Promise((r) => setImmediate(r));
	// phase-1 accepted 帧 loginId 是真 uuid（randomUUID 默认）
	assert.equal(calls[0].data.status, 'accepted');
	assert.match(calls[0].data.loginId, /[0-9a-f-]{36}/);
	// phase-2 ok 帧仍发出（finally 抛错发生在 respond 之后）
	assert.equal(calls.at(-1).data.status, 'ok');
	assert.equal(removeThrew, true);
});

test('cancelOauth: missing loginId → INVALID_ARGS', async () => {
	const { handlers } = buildOAuthHandlers();
	const { respond, calls } = makeRespond();
	await handlers.cancelOauth({ params: {}, respond });
	assert.equal(calls.length, 1); // 单发，exactly-once
	assert.equal(calls[0].err.code, 'INVALID_ARGS');
});

test('cancelOauth: known loginId aborts its controller and responds {}', async () => {
	const registry = createStubRegistry();
	const ac = new AbortController();
	registry.store.set('LOGIN-1', { abortController: ac });
	const { handlers } = buildOAuthHandlers({ registry });
	const { respond, calls } = makeRespond();
	await handlers.cancelOauth({ params: { loginId: 'LOGIN-1' }, respond });
	assert.equal(ac.signal.aborted, true);
	assert.equal(calls.length, 1); // 单发，exactly-once
	assert.equal(calls[0].ok, true);
	assert.deepEqual(calls[0].data, {});
});

test('cancelOauth: unknown loginId is idempotent (responds {})', async () => {
	const { handlers } = buildOAuthHandlers();
	const { respond, calls } = makeRespond();
	await handlers.cancelOauth({ params: { loginId: 'never-registered' }, respond });
	assert.equal(calls.length, 1); // 单发，exactly-once
	assert.equal(calls[0].ok, true);
	assert.deepEqual(calls[0].data, {});
});

test('cancelOauth: registry.getLogin throws → defensive IO_FAILED', async () => {
	const registry = createStubRegistry({
		getLogin() { throw new Error('registry broken'); },
	});
	const { handlers } = buildOAuthHandlers({ registry });
	const { respond, calls } = makeRespond();
	await handlers.cancelOauth({ params: { loginId: 'x' }, respond });
	assert.equal(calls.length, 1); // 单发，exactly-once
	assert.equal(calls[0].err.code, 'IO_FAILED');
	assert.equal(calls[0].err.message, 'registry broken');
});

test('loginOauth: outer catch — genLoginId throws → IO_FAILED', async () => {
	const handlers = buildProviderAuthHandlers({
		sdk: createStubSdk(),
		resolveAgentDir: () => AGENT_DIR,
		oauth: createStubOAuth(),
		registry: createStubRegistry(),
		genLoginId: () => { throw new Error('uuid fail'); },
		scheduleBackground: () => {},
		logRemote: () => {},
	});
	const { respond, calls } = makeRespond();
	await handlers.loginOauth({ params: { region: 'cn' }, respond });
	assert.equal(calls[0].err.code, 'IO_FAILED');
	assert.equal(calls[0].err.message, 'uuid fail');
});

// === 通用设备码登录（B1：驱动上游 provider 的 device_code run） ===

// codex/copilot 实际验证 note 模板（URL 行 + Code 行）
const DEVICE_NOTE = [
	'Open this URL in your LOCAL browser and enter the code below.',
	'URL: https://auth.openai.com/codex/device',
	'Code: ABCD-1234',
	'Code expires in 15 minutes. Never share it.',
].join('\n');

const PROVIDER_ID = 'openai-codex';
const DEVICE_CRED = { type: 'oauth', provider: PROVIDER_ID, access: 'ACC', refresh: 'REF', expires: 9999 };
const DEVICE_PROFILE = { profileId: 'openai-codex:foo@bar.com', credential: DEVICE_CRED };

// fake device_code 方法：按脚本 emit notes 后 resolve(result) / reject(error)；可注入 gate 延迟 resolve
function makeDeviceMethod({ notes = [DEVICE_NOTE], result, error, gate, onCtx } = {}) {
	return {
		id: 'device',
		kind: 'device_code',
		run: async (ctx) => {
			if (onCtx) onCtx(ctx);
			for (const n of notes) {
				 
				await ctx.prompter.note(n);
			}
			if (gate) await gate;
			if (error) throw error;
			return result ?? { profiles: [DEVICE_PROFILE] };
		},
	};
}

function buildDeviceCodeHandlers({
	providers,
	resolveProviders,
	resolveConfig = () => ({ existing: 1 }),
	sdkOverrides = {},
	mutateConfigFile,
	registry,
} = {}) {
	const bg = [];
	const mutateCalls = [];
	const upsertCalls = [];
	const logs = [];
	const defaultMutate = async ({ afterWrite, mutate }) => {
		const draft = {};
		mutate(draft);
		mutateCalls.push({ afterWrite, draft });
	};
	const sdk = createStubSdk({
		upsertAuthProfileWithLock: async (params) => { upsertCalls.push(params); return { version: 1, profiles: {} }; },
		mutateConfigFile: mutateConfigFile ?? defaultMutate,
		...sdkOverrides,
	});
	const reg = registry ?? createStubRegistry();
	const handlers = buildProviderAuthHandlers({
		sdk,
		resolveAgentDir: () => AGENT_DIR,
		registry: reg,
		genLoginId: () => 'DEV-LOGIN-1',
		scheduleBackground: (p) => { bg.push(p); },
		logRemote: (t) => { logs.push(t); },
		resolveConfig,
		resolveProviders: resolveProviders ?? (() => providers),
	});
	return { handlers, bg, mutateCalls, upsertCalls, registry: reg, logs, sdk };
}

// 等所有已调度后台 promise 跑完（phase-1 + phase-2 都已 respond）
const flushBg = (bg) => Promise.all(bg);

test('loginOauth 路由: minimax-portal → B2（不碰 resolveProviders）', async () => {
	// resolveProviders 默认抛错；若路由错走 B1 会炸。这里用 B2 stub（oauth）验证走 minimax
	const { handlers, bg } = buildOAuthHandlers();
	const { respond, calls } = makeRespond();
	await handlers.loginOauth({ params: { provider: PORTAL_PROVIDER_ID, region: 'cn' }, respond });
	assert.equal(calls[0].data.status, 'accepted');
	assert.equal(calls[0].data.userCode, 'USER-CODE'); // minimax stub 的码 → 确属 B2
	await flushBg(bg);
});

test('loginOauth 校验: provider 给了但是空串/空白/非串 → INVALID_ARGS 单帧（不漏进 B1）', async () => {
	// resolveProviders 默认抛错；若漏进 B1 会得 IO_FAILED 而非 INVALID_ARGS
	for (const bad of ['', '   ', 42, {}, null]) {
		const { handlers, bg } = buildDeviceCodeHandlers({ resolveProviders: () => { throw new Error('should not reach B1'); } });
		const { respond, calls } = makeRespond();

		await handlers.loginOauth({ params: { provider: bad }, respond });
		await flushBg(bg);
		assert.equal(calls.length, 1, `provider=${JSON.stringify(bad)} 应单帧`);
		assert.equal(calls[0].ok, false);
		assert.equal(calls[0].data, undefined);
		assert.equal(calls[0].err.code, 'INVALID_ARGS', `provider=${JSON.stringify(bad)} 应 INVALID_ARGS`);
	}
});

test('loginOauth 校验: provider 缺省（省略或显式 undefined）仍走 B2，不被校验挡住', async () => {
	// 向后兼容：不传 provider = MiniMax；校验只针对"给了但非法"。省略字段与显式 undefined 等价（params?.provider 都得 undefined）
	for (const params of [{ region: 'cn' }, { provider: undefined, region: 'cn' }]) {
		const { handlers, bg } = buildOAuthHandlers();
		const { respond, calls } = makeRespond();

		await handlers.loginOauth({ params, respond });
		assert.equal(calls[0].data.status, 'accepted', `params=${JSON.stringify(params)} 应走 B2 accepted`);
		assert.equal(calls[0].data.userCode, 'USER-CODE'); // B2 stub 的码
		await flushBg(bg);
	}
});

test('B1 成功: 验证 note → accepted（结构化字段+rawText），run resolve → 写凭据+configPatch+ok', async () => {
	const configPatch = { agents: { defaults: { models: { 'openai-codex/gpt': {} } } } };
	const { handlers, bg, upsertCalls, mutateCalls, registry } = buildDeviceCodeHandlers({
		providers: [{ id: PROVIDER_ID, auth: [makeDeviceMethod({ result: { profiles: [DEVICE_PROFILE], configPatch } })] }],
	});
	const { respond, calls } = makeRespond();
	await handlers.loginOauth({ params: { provider: PROVIDER_ID }, respond });
	await flushBg(bg);
	// phase-1 accepted
	assert.deepEqual(calls[0], {
		ok: true,
		data: {
			status: 'accepted',
			loginId: 'DEV-LOGIN-1',
			provider: PROVIDER_ID,
			verificationUri: 'https://auth.openai.com/codex/device',
			userCode: 'ABCD-1234',
			rawText: DEVICE_NOTE,
		},
		err: undefined,
	});
	// phase-2 ok
	assert.deepEqual(calls.at(-1), {
		ok: true,
		data: { status: 'ok', provider: PROVIDER_ID, profileIds: ['openai-codex:foo@bar.com'] },
		err: undefined,
	});
	assert.equal(calls.length, 2); // 恰好 accepted + 终态两帧，不多发不漏发
	// 写凭据
	assert.equal(upsertCalls.length, 1);
	assert.equal(upsertCalls[0].profileId, 'openai-codex:foo@bar.com');
	assert.equal(upsertCalls[0].agentDir, AGENT_DIR);
	assert.deepEqual(upsertCalls[0].credential, DEVICE_CRED);
	// configPatch 深合并进 cfg（hot-reload）
	assert.equal(mutateCalls.length, 1);
	assert.deepEqual(mutateCalls[0].afterWrite, { mode: 'auto' });
	assert.deepEqual(mutateCalls[0].draft, configPatch);
	// 登记→移除
	assert.deepEqual(registry.events, [['register', 'DEV-LOGIN-1'], ['remove', 'DEV-LOGIN-1']]);
});

test('B1 成功无 configPatch: 不调 mutateConfigFile，仍 ok', async () => {
	const { handlers, bg, mutateCalls, upsertCalls } = buildDeviceCodeHandlers({
		providers: [{ id: PROVIDER_ID, auth: [makeDeviceMethod({ result: { profiles: [DEVICE_PROFILE] } })] }],
	});
	const { respond, calls } = makeRespond();
	await handlers.loginOauth({ params: { provider: PROVIDER_ID }, respond });
	await flushBg(bg);
	assert.equal(calls.at(-1).data.status, 'ok');
	assert.equal(calls.length, 2);
	assert.equal(upsertCalls.length, 1);
	assert.equal(mutateCalls.length, 0);
});

test('B1 成功 configPatch 是数组: 视为无 patch，不调 mutateConfigFile', async () => {
	const { handlers, bg, mutateCalls } = buildDeviceCodeHandlers({
		providers: [{ id: PROVIDER_ID, auth: [makeDeviceMethod({ result: { profiles: [DEVICE_PROFILE], configPatch: [] } })] }],
	});
	const { respond, calls } = makeRespond();
	await handlers.loginOauth({ params: { provider: PROVIDER_ID }, respond });
	await flushBg(bg);
	assert.equal(calls.at(-1).data.status, 'ok');
	assert.equal(mutateCalls.length, 0);
});

test('B1 空 profiles（上游吞失败）: accepted → phase-2 OAUTH_FAILED，不写凭据', async () => {
	const { handlers, bg, upsertCalls, registry } = buildDeviceCodeHandlers({
		providers: [{ id: PROVIDER_ID, auth: [makeDeviceMethod({ result: { profiles: [] } })] }],
	});
	const { respond, calls } = makeRespond();
	await handlers.loginOauth({ params: { provider: PROVIDER_ID }, respond });
	await flushBg(bg);
	assert.equal(calls[0].data.status, 'accepted');
	assert.equal(calls.at(-1).ok, false);
	assert.deepEqual(calls.at(-1).data, { status: 'error' });
	assert.equal(calls.at(-1).err.code, 'OAUTH_FAILED');
	assert.equal(calls.length, 2);
	assert.equal(upsertCalls.length, 0);
	// 终态必清 registry（accepted 已登记 → 终态移除）
	assert.deepEqual(registry.events, [['register', 'DEV-LOGIN-1'], ['remove', 'DEV-LOGIN-1']]);
});

test('B1 run 在 note 之后 reject: accepted → phase-2 OAUTH_FAILED 带 message', async () => {
	const { handlers, bg, registry } = buildDeviceCodeHandlers({
		providers: [{ id: PROVIDER_ID, auth: [makeDeviceMethod({ error: new Error('network down') })] }],
	});
	const { respond, calls } = makeRespond();
	await handlers.loginOauth({ params: { provider: PROVIDER_ID }, respond });
	await flushBg(bg);
	assert.equal(calls[0].data.status, 'accepted');
	assert.equal(calls.at(-1).ok, false);
	assert.deepEqual(calls.at(-1).data, { status: 'error' });
	assert.equal(calls.at(-1).err.code, 'OAUTH_FAILED');
	assert.equal(calls.at(-1).err.message, 'network down');
	assert.equal(calls.length, 2);
	assert.deepEqual(registry.events, [['register', 'DEV-LOGIN-1'], ['remove', 'DEV-LOGIN-1']]);
});

test('B1 run 在任何 note 之前 reject: 单帧错误（无 accepted）', async () => {
	const { handlers, bg, registry } = buildDeviceCodeHandlers({
		providers: [{ id: PROVIDER_ID, auth: [makeDeviceMethod({ notes: [], error: new Error('device endpoint 404') })] }],
	});
	const { respond, calls } = makeRespond();
	await handlers.loginOauth({ params: { provider: PROVIDER_ID }, respond });
	await flushBg(bg);
	assert.equal(calls.length, 1); // 单帧
	assert.equal(calls[0].ok, false);
	assert.equal(calls[0].data, undefined); // payload undefined = phase-1 之前的单帧错误
	assert.equal(calls[0].err.code, 'OAUTH_FAILED');
	assert.equal(calls[0].err.message, 'device endpoint 404');
	// 从未登记（onNote 没触发）
	assert.deepEqual(registry.events, []);
});

test('B1 成功但全程无 note（phase-1 未发）: 单帧 ok，仍写凭据', async () => {
	const { handlers, bg, upsertCalls } = buildDeviceCodeHandlers({
		providers: [{ id: PROVIDER_ID, auth: [makeDeviceMethod({ notes: [], result: { profiles: [DEVICE_PROFILE] } })] }],
	});
	const { respond, calls } = makeRespond();
	await handlers.loginOauth({ params: { provider: PROVIDER_ID }, respond });
	await flushBg(bg);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].ok, true);
	assert.equal(calls[0].data.status, 'ok');
	assert.equal(upsertCalls.length, 1);
});

test('B1 取消: accepted 后 cancel，run 到期 resolve → phase-2 cancelled，不写凭据', async () => {
	let release;
	const gate = new Promise((r) => { release = r; });
	const { handlers, bg, upsertCalls, registry } = buildDeviceCodeHandlers({
		providers: [{ id: PROVIDER_ID, auth: [makeDeviceMethod({ gate, result: { profiles: [DEVICE_PROFILE] } })] }],
	});
	const { respond, calls } = makeRespond();
	await handlers.loginOauth({ params: { provider: PROVIDER_ID }, respond });
	// 让 note 吐出 → accepted + 登记
	await new Promise((r) => setImmediate(r));
	assert.equal(calls[0].data.status, 'accepted');
	assert.ok(registry.store.get('DEV-LOGIN-1'));
	// 取消
	const cancel = makeRespond();
	await handlers.cancelOauth({ params: { loginId: 'DEV-LOGIN-1' }, respond: cancel.respond });
	assert.deepEqual(cancel.calls[0], { ok: true, data: {}, err: undefined });
	// 放行 run resolve
	release();
	await flushBg(bg);
	assert.equal(calls.at(-1).ok, false);
	assert.deepEqual(calls.at(-1).data, { status: 'cancelled' });
	assert.equal(calls.at(-1).err.code, 'OAUTH_CANCELLED');
	assert.equal(upsertCalls.length, 0); // 取消不写凭据
	// 终态必清 registry，且 cancelOauth 自身不调 removeLogin（只 abort）→ 只有一对 register/remove
	assert.deepEqual(registry.events, [['register', 'DEV-LOGIN-1'], ['remove', 'DEV-LOGIN-1']]);
	assert.equal(registry.store.has('DEV-LOGIN-1'), false);
});

test('B1 provider 无 device_code 方法（只有 oauth）: NOT_FOUND 单帧', async () => {
	const { handlers, bg } = buildDeviceCodeHandlers({
		providers: [{ id: PROVIDER_ID, auth: [{ id: 'oauth', kind: 'oauth', run: async () => ({ profiles: [] }) }] }],
	});
	const { respond, calls } = makeRespond();
	await handlers.loginOauth({ params: { provider: PROVIDER_ID }, respond });
	await flushBg(bg);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].ok, false);
	assert.equal(calls[0].data, undefined); // 单帧错误 payload 必为 undefined（phase-1 未发）
	assert.equal(calls[0].err.code, 'NOT_FOUND');
});

test('B1 resolveProviders 抛错: 单帧 IO_FAILED（phase-1 之前）', async () => {
	const { handlers, bg } = buildDeviceCodeHandlers({
		resolveProviders: () => { throw new Error('loader boom'); },
	});
	const { respond, calls } = makeRespond();
	await handlers.loginOauth({ params: { provider: PROVIDER_ID }, respond });
	await flushBg(bg);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].data, undefined); // 单帧错误 payload 必为 undefined（phase-1 之前）
	assert.equal(calls[0].err.code, 'IO_FAILED');
	assert.equal(calls[0].err.message, 'loader boom');
});

test('B1 resolveProviders 默认未注入: 调用即抛 → 单帧 IO_FAILED', async () => {
	// 不经 buildDeviceCodeHandlers（它总注入 resolveProviders）；直接构建，走默认抛错 thunk
	const handlers = buildProviderAuthHandlers({
		sdk: createStubSdk(),
		resolveAgentDir: () => AGENT_DIR,
		registry: createStubRegistry(),
		genLoginId: () => 'X',
		scheduleBackground: () => {},
		logRemote: () => {},
		resolveConfig: () => ({}),
	});
	const { respond, calls } = makeRespond();
	await handlers.loginOauth({ params: { provider: PROVIDER_ID }, respond });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].err.code, 'IO_FAILED');
	assert.equal(calls[0].err.message, 'provider catalog runtime not injected');
});

test('B1 写凭据返回 null: accepted → phase-2 IO_FAILED', async () => {
	const { handlers, bg, registry } = buildDeviceCodeHandlers({
		providers: [{ id: PROVIDER_ID, auth: [makeDeviceMethod()] }],
		sdkOverrides: { upsertAuthProfileWithLock: async () => null },
	});
	const { respond, calls } = makeRespond();
	await handlers.loginOauth({ params: { provider: PROVIDER_ID }, respond });
	await flushBg(bg);
	assert.equal(calls[0].data.status, 'accepted');
	assert.equal(calls.at(-1).ok, false);
	assert.deepEqual(calls.at(-1).data, { status: 'error' }); // phase-2 error 帧必带 status payload
	assert.equal(calls.at(-1).err.code, 'IO_FAILED');
	assert.equal(calls.at(-1).err.message, 'failed to write auth-profiles store');
	assert.equal(calls.length, 2);
	assert.deepEqual(registry.events, [['register', 'DEV-LOGIN-1'], ['remove', 'DEV-LOGIN-1']]);
});

test('B1 mutateConfigFile 抛错: accepted → phase-2 IO_FAILED', async () => {
	const configPatch = { agents: { defaults: { models: { 'm': {} } } } };
	const { handlers, bg } = buildDeviceCodeHandlers({
		providers: [{ id: PROVIDER_ID, auth: [makeDeviceMethod({ result: { profiles: [DEVICE_PROFILE], configPatch } })] }],
		mutateConfigFile: async () => { throw new Error('cfg locked'); },
	});
	const { respond, calls } = makeRespond();
	await handlers.loginOauth({ params: { provider: PROVIDER_ID }, respond });
	await flushBg(bg);
	assert.equal(calls.at(-1).ok, false);
	assert.deepEqual(calls.at(-1).data, { status: 'error' }); // phase-2 error 帧必带 status payload
	assert.equal(calls.at(-1).err.code, 'IO_FAILED');
	assert.equal(calls.at(-1).err.message, 'cfg locked');
	assert.equal(calls.length, 2);
});

test('B1 config 来源: resolveConfig 结果传给 resolveProviders + ctx；providerRefs 单元素', async () => {
	let seenResolveArgs;
	let seenCtxConfig;
	const handlersBundle = buildDeviceCodeHandlers({
		resolveConfig: () => ({ marker: 7 }),
		resolveProviders: (args) => {
			seenResolveArgs = args;
			return [{ id: PROVIDER_ID, auth: [makeDeviceMethod({ onCtx: (ctx) => { seenCtxConfig = ctx.config; } })] }];
		},
	});
	const { respond } = makeRespond();
	await handlersBundle.handlers.loginOauth({ params: { provider: PROVIDER_ID }, respond });
	await flushBg(handlersBundle.bg);
	assert.deepEqual(seenResolveArgs, { config: { marker: 7 }, providerRefs: [PROVIDER_ID] });
	assert.deepEqual(seenCtxConfig, { marker: 7 });
});

test('B1 resolveConfig 返回 null → config 兜底 {}', async () => {
	let seenResolveArgs;
	const handlersBundle = buildDeviceCodeHandlers({
		resolveConfig: () => null,
		resolveProviders: (args) => {
			seenResolveArgs = args;
			return [{ id: PROVIDER_ID, auth: [makeDeviceMethod()] }];
		},
	});
	const { respond, calls } = makeRespond();
	await handlersBundle.handlers.loginOauth({ params: { provider: PROVIDER_ID }, respond });
	await flushBg(handlersBundle.bg);
	assert.deepEqual(seenResolveArgs.config, {});
	assert.equal(calls.at(-1).data.status, 'ok');
});

test('B1 outer catch: resolveConfig 抛错 → 单帧 IO_FAILED', async () => {
	const { handlers, bg } = buildDeviceCodeHandlers({
		resolveConfig: () => { throw new Error('config read boom'); },
	});
	const { respond, calls } = makeRespond();
	await handlers.loginOauth({ params: { provider: PROVIDER_ID }, respond });
	await flushBg(bg);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].err.code, 'IO_FAILED');
	assert.equal(calls[0].err.message, 'config read boom');
});

test('B1 note 过滤: 帮助/前导 note 不触发 phase-1，只有真验证 note 触发一次', async () => {
	const helpNote = 'Trouble with device code login? See https://docs.openclaw.ai/start/faq';
	const preamble = 'This will open a GitHub device login to authorize Copilot.';
	const secondUrlNote = 'URL: https://auth.openai.com/codex/device\nCode: ZZZZ-0000';
	const { handlers, bg } = buildDeviceCodeHandlers({
		providers: [{ id: PROVIDER_ID, auth: [makeDeviceMethod({
			notes: [helpNote, preamble, DEVICE_NOTE, secondUrlNote],
			result: { profiles: [DEVICE_PROFILE] },
		})] }],
	});
	const { respond, calls } = makeRespond();
	await handlers.loginOauth({ params: { provider: PROVIDER_ID }, respond });
	await flushBg(bg);
	// 只有一帧 accepted，且来自 DEVICE_NOTE（首个真验证 note），不是 secondUrlNote
	const accepted = calls.filter((c) => c.data?.status === 'accepted');
	assert.equal(accepted.length, 1);
	assert.equal(accepted[0].data.userCode, 'ABCD-1234');
	assert.equal(calls.at(-1).data.status, 'ok');
});

test('B1 验证 note 抠不到结构化字段: accepted 带 null + rawText 全文', async () => {
	const note = 'Authorize at https://x.example/dev to continue.';
	const { handlers, bg } = buildDeviceCodeHandlers({
		providers: [{ id: PROVIDER_ID, auth: [makeDeviceMethod({ notes: [note], result: { profiles: [DEVICE_PROFILE] } })] }],
	});
	const { respond, calls } = makeRespond();
	await handlers.loginOauth({ params: { provider: PROVIDER_ID }, respond });
	await flushBg(bg);
	assert.deepEqual(calls[0].data, {
		status: 'accepted',
		loginId: 'DEV-LOGIN-1',
		provider: PROVIDER_ID,
		verificationUri: 'https://x.example/dev',
		userCode: null,
		rawText: note,
	});
});
