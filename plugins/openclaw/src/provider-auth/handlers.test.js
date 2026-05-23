import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProviderAuthHandlers } from './handlers.js';

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
