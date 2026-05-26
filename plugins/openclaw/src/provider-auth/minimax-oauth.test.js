import assert from 'node:assert/strict';
import test from 'node:test';

import {
	createMiniMaxOAuth,
	defaultSleep,
	PORTAL_PROVIDER_ID,
	CONFIG_DEFAULT_BASE_URL,
	VALID_REGIONS,
	MAX_POLL_INTERVAL,
	MAX_LOGIN_WINDOW,
} from './minimax-oauth.js';

// --- 共用 fake 工厂 ---

// fake fetch：按调用序列依次返回预设响应。每个响应描述 { ok, jsonBody, textBody, status }
function makeFetch(queue) {
	const calls = [];
	async function fetchImpl(url, init) {
		calls.push({ url, init });
		const spec = queue.shift();
		if (!spec) throw new Error(`unexpected fetch call: ${url}`);
		return {
			ok: spec.ok ?? true,
			statusText: spec.statusText ?? '',
			json: async () => spec.jsonBody,
			text: async () => spec.textBody ?? (spec.jsonBody !== undefined ? JSON.stringify(spec.jsonBody) : ''),
		};
	}
	return { fetchImpl, calls };
}

const fakePkce = () => ({ verifier: 'VERIFIER', challenge: 'CHALLENGE' });
const fakeToForm = (obj) => new URLSearchParams(obj).toString();

function makeOAuth(queue, overrides = {}) {
	const { fetchImpl, calls } = makeFetch(queue);
	const oauth = createMiniMaxOAuth({
		generatePkce: fakePkce,
		toForm: fakeToForm,
		fetchImpl,
		randomState: () => 'STATE',
		randomRequestId: () => 'REQ-ID',
		sleep: async () => {},
		now: () => 0,
		...overrides,
	});
	return { oauth, calls };
}

// === 常量导出 ===

test('exports portal id + cn/global config base urls (with /anthropic suffix) + valid regions', () => {
	assert.equal(PORTAL_PROVIDER_ID, 'minimax-portal');
	assert.equal(CONFIG_DEFAULT_BASE_URL.cn, 'https://api.minimaxi.com/anthropic');
	assert.equal(CONFIG_DEFAULT_BASE_URL.global, 'https://api.minimax.io/anthropic');
	assert.ok(VALID_REGIONS.has('cn'));
	assert.ok(VALID_REGIONS.has('global'));
	assert.equal(VALID_REGIONS.has('xx'), false);
});

// === requestDeviceCode ===

test('requestDeviceCode: cn happy path returns device code fields + clamps interval ≥2000', async () => {
	const { oauth, calls } = makeOAuth([
		{
			ok: true,
			jsonBody: {
				user_code: 'ABCD',
				verification_uri: 'https://verify.example/login',
				expired_in: 1700000000000,
				interval: 1000, // 服务端给 1s，应被兜到 2s
				state: 'STATE',
			},
		},
	]);
	const out = await oauth.requestDeviceCode({ region: 'cn' });
	assert.equal(out.verifier, 'VERIFIER');
	assert.equal(out.userCode, 'ABCD');
	assert.equal(out.verificationUri, 'https://verify.example/login');
	assert.equal(out.expiresAt, 1700000000000);
	assert.equal(out.interval, 2000);
	// 打到 cn /oauth/code 端点
	assert.equal(calls[0].url, 'https://api.minimaxi.com/oauth/code');
	assert.equal(calls[0].init.method, 'POST');
	// 共用上游 client_id + scope + S256
	const body = calls[0].init.body;
	assert.match(body, /client_id=78257093-7e40-4613-99e0-527b14b39113/);
	assert.match(body, /code_challenge=CHALLENGE/);
	assert.match(body, /code_challenge_method=S256/);
});

test('requestDeviceCode: global region hits global endpoint', async () => {
	const { oauth, calls } = makeOAuth([
		{ ok: true, jsonBody: { user_code: 'X', verification_uri: 'u', expired_in: 1, interval: 5000, state: 'STATE' } },
	]);
	const out = await oauth.requestDeviceCode({ region: 'global' });
	assert.equal(calls[0].url, 'https://api.minimax.io/oauth/code');
	assert.equal(out.interval, 5000);
});

test('requestDeviceCode: missing interval defaults to 2000', async () => {
	const { oauth } = makeOAuth([
		{ ok: true, jsonBody: { user_code: 'X', verification_uri: 'u', expired_in: 1, state: 'STATE' } },
	]);
	const out = await oauth.requestDeviceCode({ region: 'cn' });
	assert.equal(out.interval, 2000);
});

test('requestDeviceCode: HTTP not-ok throws with body text', async () => {
	const { oauth } = makeOAuth([
		{ ok: false, statusText: 'Bad Request', textBody: 'invalid client' },
	]);
	await assert.rejects(
		() => oauth.requestDeviceCode({ region: 'cn' }),
		/MiniMax OAuth authorization failed: invalid client/,
	);
});

test('requestDeviceCode: HTTP not-ok falls back to statusText when no body', async () => {
	const { oauth } = makeOAuth([
		{ ok: false, statusText: 'Bad Request', textBody: '' },
	]);
	await assert.rejects(
		() => oauth.requestDeviceCode({ region: 'cn' }),
		/MiniMax OAuth authorization failed: Bad Request/,
	);
});

test('requestDeviceCode: incomplete payload (no user_code) throws payload.error', async () => {
	const { oauth } = makeOAuth([
		{ ok: true, jsonBody: { verification_uri: 'u', error: 'server says no', state: 'STATE' } },
	]);
	await assert.rejects(
		() => oauth.requestDeviceCode({ region: 'cn' }),
		/server says no/,
	);
});

test('requestDeviceCode: incomplete payload without error uses generic message', async () => {
	const { oauth } = makeOAuth([
		{ ok: true, jsonBody: { user_code: 'X', state: 'STATE' } }, // 缺 verification_uri
	]);
	await assert.rejects(
		() => oauth.requestDeviceCode({ region: 'cn' }),
		/incomplete payload/,
	);
});

test('requestDeviceCode: missing expired_in throws (fail-closed; else poll never times out)', async () => {
	const { oauth } = makeOAuth([
		{ ok: true, jsonBody: { user_code: 'X', verification_uri: 'u', state: 'STATE' } }, // 无 expired_in
	]);
	await assert.rejects(
		() => oauth.requestDeviceCode({ region: 'cn' }),
		/invalid expiry/,
	);
});

test('requestDeviceCode: non-numeric expired_in throws', async () => {
	const { oauth } = makeOAuth([
		{ ok: true, jsonBody: { user_code: 'X', verification_uri: 'u', expired_in: 'soon', state: 'STATE' } },
	]);
	await assert.rejects(
		() => oauth.requestDeviceCode({ region: 'cn' }),
		/invalid expiry/,
	);
});

test('requestDeviceCode: state mismatch throws (CSRF guard)', async () => {
	const { oauth } = makeOAuth([
		{ ok: true, jsonBody: { user_code: 'X', verification_uri: 'u', expired_in: 1, state: 'DIFFERENT' } },
	]);
	await assert.rejects(
		() => oauth.requestDeviceCode({ region: 'cn' }),
		/state mismatch/,
	);
});

// === pollUntilSettled ===

const POLL_ARGS = { region: 'cn', userCode: 'ABCD', verifier: 'VERIFIER', expiresAt: 1000, interval: 2000 };

test('pollUntilSettled: success on first poll returns token', async () => {
	const { oauth, calls } = makeOAuth([
		{
			ok: true,
			jsonBody: {
				status: 'success',
				access_token: 'ACCESS',
				refresh_token: 'REFRESH',
				expired_in: 9999,
				resource_url: 'https://acct.example/anthropic',
			},
		},
	]);
	const out = await oauth.pollUntilSettled({ ...POLL_ARGS, signal: new AbortController().signal });
	assert.deepEqual(out, {
		status: 'success',
		token: { access: 'ACCESS', refresh: 'REFRESH', expires: 9999, resourceUrl: 'https://acct.example/anthropic' },
	});
	assert.equal(calls[0].url, 'https://api.minimaxi.com/oauth/token');
});

test('pollUntilSettled: pending then success sleeps once between polls', async () => {
	let sleeps = 0;
	const { oauth } = makeOAuth(
		[
			{ ok: true, jsonBody: { status: 'pending' } },
			{ ok: true, jsonBody: { status: 'success', access_token: 'A', refresh_token: 'R', expired_in: 1 } },
		],
		{ sleep: async (ms) => { sleeps += 1; assert.equal(ms, 2000); } },
	);
	const out = await oauth.pollUntilSettled({ ...POLL_ARGS, signal: new AbortController().signal });
	assert.equal(out.status, 'success');
	assert.equal(sleeps, 1);
});

test('pollUntilSettled: token endpoint reports error → status error with message', async () => {
	const { oauth } = makeOAuth([
		{ ok: true, jsonBody: { status: 'error' } },
	]);
	const out = await oauth.pollUntilSettled({ ...POLL_ARGS, signal: new AbortController().signal });
	assert.equal(out.status, 'error');
	assert.match(out.message, /An error occurred/);
});

test('pollUntilSettled: HTTP not-ok with base_resp.status_msg → error message', async () => {
	const { oauth } = makeOAuth([
		{ ok: false, jsonBody: { base_resp: { status_code: 1004, status_msg: 'rate limited' } } },
	]);
	const out = await oauth.pollUntilSettled({ ...POLL_ARGS, signal: new AbortController().signal });
	assert.equal(out.status, 'error');
	assert.equal(out.message, 'rate limited');
});

test('pollUntilSettled: HTTP not-ok with no parseable body → error with raw text', async () => {
	const { oauth } = makeOAuth([
		{ ok: false, textBody: 'gateway boom' },
	]);
	const out = await oauth.pollUntilSettled({ ...POLL_ARGS, signal: new AbortController().signal });
	assert.equal(out.status, 'error');
	assert.equal(out.message, 'gateway boom');
});

test('pollUntilSettled: HTTP not-ok empty body → generic parse error', async () => {
	const { oauth } = makeOAuth([
		{ ok: false, textBody: '' },
	]);
	const out = await oauth.pollUntilSettled({ ...POLL_ARGS, signal: new AbortController().signal });
	assert.equal(out.status, 'error');
	assert.match(out.message, /failed to parse/);
});

test('pollUntilSettled: ok response but empty/invalid body → error', async () => {
	const { oauth } = makeOAuth([
		{ ok: true, textBody: 'not json' },
	]);
	const out = await oauth.pollUntilSettled({ ...POLL_ARGS, signal: new AbortController().signal });
	assert.equal(out.status, 'error');
	assert.match(out.message, /failed to parse/);
});

test('pollUntilSettled: success status but incomplete token → error', async () => {
	const { oauth } = makeOAuth([
		{ ok: true, jsonBody: { status: 'success', access_token: 'A' } }, // 缺 refresh/expired
	]);
	const out = await oauth.pollUntilSettled({ ...POLL_ARGS, signal: new AbortController().signal });
	assert.equal(out.status, 'error');
	assert.match(out.message, /incomplete token/);
});

test('pollUntilSettled: aborted before first poll → cancelled, no fetch', async () => {
	const { oauth, calls } = makeOAuth([]);
	const ac = new AbortController();
	ac.abort();
	const out = await oauth.pollUntilSettled({ ...POLL_ARGS, signal: ac.signal });
	assert.deepEqual(out, { status: 'cancelled' });
	assert.equal(calls.length, 0);
});

test('pollUntilSettled: expired (now ≥ expiresAt) → timeout, no fetch', async () => {
	const { oauth, calls } = makeOAuth([], { now: () => 5000 });
	const out = await oauth.pollUntilSettled({ ...POLL_ARGS, signal: new AbortController().signal });
	assert.deepEqual(out, { status: 'timeout' });
	assert.equal(calls.length, 0);
});

test('pollUntilSettled: abort during sleep → cancelled on next loop top', async () => {
	const ac = new AbortController();
	const { oauth } = makeOAuth(
		[{ ok: true, jsonBody: { status: 'pending' } }],
		{ sleep: async () => { ac.abort(); } },
	);
	const out = await oauth.pollUntilSettled({ ...POLL_ARGS, signal: ac.signal });
	assert.deepEqual(out, { status: 'cancelled' });
});

test('pollUntilSettled: interval falsy falls back to 2000', async () => {
	let observed;
	const { oauth } = makeOAuth(
		[
			{ ok: true, jsonBody: { status: 'pending' } },
			{ ok: true, jsonBody: { status: 'success', access_token: 'A', refresh_token: 'R', expired_in: 1 } },
		],
		{ sleep: async (ms) => { observed = ms; } },
	);
	await oauth.pollUntilSettled({ ...POLL_ARGS, interval: 0, signal: new AbortController().signal });
	assert.equal(observed, 2000);
});

// === 服务端给离谱值时的独立硬上限（不论服务端说什么，到点必停） ===

test('requestDeviceCode: oversized interval is capped to MAX_POLL_INTERVAL (accepted-frame value)', async () => {
	const { oauth } = makeOAuth([
		{ ok: true, jsonBody: { user_code: 'X', verification_uri: 'u', expired_in: 1, interval: 999_999_999, state: 'STATE' } },
	]);
	const out = await oauth.requestDeviceCode({ region: 'cn' });
	assert.equal(out.interval, MAX_POLL_INTERVAL);
});

test('requestDeviceCode: non-numeric interval falls back to a finite number (never NaN to UI)', async () => {
	const { oauth } = makeOAuth([
		{ ok: true, jsonBody: { user_code: 'X', verification_uri: 'u', expired_in: 1, interval: 'soon', state: 'STATE' } },
	]);
	const out = await oauth.requestDeviceCode({ region: 'cn' });
	assert.equal(Number.isFinite(out.interval), true);
	assert.equal(out.interval, 2000);
});

test('pollUntilSettled: absurd expiresAt is bounded by an independent hard window → timeout, not infinite poll', async () => {
	// 服务端把截止时刻给成离谱大值（如单位写错成微秒 ≈ 1e15）且一直回 pending。
	// 没有独立硬上限时 now()>=expiresAt 恒为 false → 永不超时、永不清理、发起方挂死。
	// 本测试钉死：循环以独立硬上限自我终止。无硬上限时 fetch 会被调到超过阈值而抛错（红）。
	let clock = 0;
	let polls = 0;
	const oauth = createMiniMaxOAuth({
		generatePkce: fakePkce,
		toForm: fakeToForm,
		fetchImpl: async () => {
			polls += 1;
			if (polls > 10) throw new Error('poll never terminated: no independent hard ceiling');
			return { ok: true, statusText: '', json: async () => ({}), text: async () => JSON.stringify({ status: 'pending' }) };
		},
		// 每次读时钟前进半个硬窗口，几轮即跨过 hardDeadline
		now: () => { const v = clock; clock += MAX_LOGIN_WINDOW / 2; return v; },
		sleep: async () => {},
	});
	const out = await oauth.pollUntilSettled({
		region: 'cn', userCode: 'U', verifier: 'V',
		expiresAt: 1e15, interval: 2000, signal: new AbortController().signal,
	});
	assert.deepEqual(out, { status: 'timeout' });
});

test('pollUntilSettled: oversized interval clamps the inter-poll sleep to MAX_POLL_INTERVAL', async () => {
	let observed;
	const { oauth } = makeOAuth(
		[
			{ ok: true, jsonBody: { status: 'pending' } },
			{ ok: true, jsonBody: { status: 'success', access_token: 'A', refresh_token: 'R', expired_in: 1 } },
		],
		{ sleep: async (ms) => { observed = ms; } },
	);
	await oauth.pollUntilSettled({ ...POLL_ARGS, interval: 999_999_999, signal: new AbortController().signal });
	assert.ok(observed <= MAX_POLL_INTERVAL, `expected sleep clamped to ≤${MAX_POLL_INTERVAL}, saw ${observed}`);
});

test('pollUntilSettled: success with non-numeric token expired_in → incomplete error (parity with device-code guard)', async () => {
	const { oauth } = makeOAuth([
		{ ok: true, jsonBody: { status: 'success', access_token: 'A', refresh_token: 'R', expired_in: '3600' } },
	]);
	const out = await oauth.pollUntilSettled({ ...POLL_ARGS, signal: new AbortController().signal });
	assert.equal(out.status, 'error');
	assert.match(out.message, /incomplete token/);
});

test('pollUntilSettled: non-string resource_url is dropped (handler then falls back to default baseUrl)', async () => {
	const { oauth } = makeOAuth([
		{ ok: true, jsonBody: { status: 'success', access_token: 'A', refresh_token: 'R', expired_in: 9999, resource_url: 12345 } },
	]);
	const out = await oauth.pollUntilSettled({ ...POLL_ARGS, signal: new AbortController().signal });
	assert.equal(out.status, 'success');
	assert.equal(out.token.resourceUrl, undefined);
});

// === 默认依赖（不注入 randomState / randomRequestId / now / sleep，走生产默认） ===

test('createMiniMaxOAuth: real default randomState/randomRequestId/now wired when omitted', async () => {
	const seenRequestIds = [];
	async function fetchImpl(url, init) {
		if (url.endsWith('/oauth/code')) {
			// 回显请求里的 state，让默认随机 state 的往返校验通过
			const params = new URLSearchParams(init.body);
			seenRequestIds.push(init.headers['x-request-id']);
			return {
				ok: true,
				json: async () => ({
					user_code: 'U',
					verification_uri: 'uri',
					expired_in: Date.now() + 100_000, // 远未来，配合默认 now 不会 timeout
					interval: 2000,
					state: params.get('state'),
				}),
				text: async () => '',
			};
		}
		// token 首轮即 success → 不触发默认 sleep（defaultSleep 已在上面直测覆盖）
		return {
			ok: true,
			text: async () => JSON.stringify({ status: 'success', access_token: 'A', refresh_token: 'R', expired_in: 1 }),
		};
	}
	const oauth = createMiniMaxOAuth({ generatePkce: fakePkce, toForm: fakeToForm, fetchImpl });
	const dc = await oauth.requestDeviceCode({ region: 'cn' });
	assert.equal(dc.userCode, 'U');
	// x-request-id 来自默认 randomRequestId（真 uuid）
	assert.match(seenRequestIds[0], /[0-9a-f-]{36}/);
	// 默认 randomState 产生的 state 通过了回显往返校验（否则上面 requestDeviceCode 会抛 state mismatch）
	const out = await oauth.pollUntilSettled({
		region: 'cn',
		userCode: 'U',
		verifier: dc.verifier,
		expiresAt: dc.expiresAt,
		interval: dc.interval,
		signal: new AbortController().signal,
	});
	assert.equal(out.status, 'success');
});

// === defaultSleep（三条路径直测，用极小 ms 避免久等） ===

test('defaultSleep: already-aborted signal resolves immediately', async () => {
	const ac = new AbortController();
	ac.abort();
	await defaultSleep(10_000, ac.signal); // 不会真等 10s
});

test('defaultSleep: resolves (to undefined) after timeout when no signal given', async () => {
	// 无 signal 路径：到点自然 resolve；断言 resolve 值而非做恒真的时间比较
	assert.equal(await defaultSleep(5), undefined);
});

test('defaultSleep: abort mid-sleep clears timer and resolves early', async () => {
	const ac = new AbortController();
	const p = defaultSleep(10_000, ac.signal);
	ac.abort();
	await p; // abort 触发提前 resolve，不等 10s
});
