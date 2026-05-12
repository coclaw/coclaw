// @vitest-environment jsdom
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

import {
	RemoteLog, useRemoteLog, remoteLog, __resetRemoteLog,
	httpSender, buildUiStartText,
	BATCH_SIZE, DEBOUNCE_MS, MAX_RING, MAX_PENDING,
	MAX_ATTEMPTS, MAX_DURATION_MS,
	BACKOFF_BASE_MS, BACKOFF_CAP_MS,
	ENDPOINT_PATH, HTTP_TIMEOUT_MS,
} from './remote-log.js';
import {
	useSignalingConnection, __resetSignalingConnection,
} from './signaling-connection.js';

/**
 * 用 vi.useFakeTimers() 控时；用 random=0 让退避计算可预测；用 vi.advanceTimersByTimeAsync
 * 让 Promise microtask 也按时序推进，避免 fake timer 与微任务竞态。
 */
function mkRl(over = {}) {
	const sendCalls = [];
	let respond = () => ({ kind: 'success' });
	const rl = new RemoteLog({
		send: (payload) => {
			sendCalls.push(payload);
			return Promise.resolve(respond(payload, sendCalls.length));
		},
		uiId: over.uiId || 'A_test_id_21__________',
		now: over.now || (() => Date.now()),
		random: over.random ?? (() => 0),
		...over.opts,
	});
	return {
		rl, sendCalls,
		set respond(fn) { respond = fn; },
		get respond() { return respond; },
	};
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	__resetSignalingConnection();
	__resetRemoteLog();
});

describe('RemoteLog buffering & triggers', () => {
	test('log() 入 ring buffer 并附加 ts', () => {
		const { rl } = mkRl();
		rl.log('hello');
		expect(rl.__ring).toHaveLength(1);
		expect(rl.__ring[0].text).toBe('hello');
		expect(typeof rl.__ring[0].ts).toBe('number');
	});

	test('正常负载下 ring 保持小（pack-at-100 同步榨干）', async () => {
		// pack 在 ring 达到 BATCH_SIZE 时同步把所有 entry 移到 pending，所以 ring 永远不会涨到 MAX_RING；
		// MAX_RING 是 pack 因故失效时的兜底防线。
		const ctx = mkRl();
		ctx.respond = () => new Promise(() => {}); // 让 in-flight 永挂，pending 越积越多
		for (let i = 0; i < BATCH_SIZE * 5; i++) ctx.rl.log(`m${i}`);
		await vi.advanceTimersByTimeAsync(0);
		expect(ctx.rl.__ring.length).toBeLessThan(BATCH_SIZE);
	});

	test('ring 触达兜底上限时丢最旧 entry（直接灌入 ring 模拟 pack 无法推进的极端场景）', () => {
		const ctx = mkRl();
		ctx.respond = () => new Promise(() => {}); // 阻住 in-flight，pending 不被消化
		for (let i = 0; i < MAX_RING; i++) {
			ctx.rl.__ring.push({ ts: 0, text: `m${i}` });
		}
		// 此时 ring.length === MAX_RING；再 push 一条 → shift 触发 → ring 仍 MAX_RING
		ctx.rl.log('latest');
		// 同步路径：log → push → shift(m0) → pack 把 ring 全部送进 pending（10 batch）+ pump 摘 batch1 为 inFlight
		const allTexts = [
			...(ctx.rl.__inFlight?.logs.map((l) => l.text) ?? []),
			...ctx.rl.__pending.flatMap((b) => b.logs.map((l) => l.text)),
		];
		expect(allTexts).not.toContain('m0');
		expect(allTexts[0]).toBe('m1');
		expect(allTexts.at(-1)).toBe('latest');
		expect(allTexts.length).toBe(MAX_RING);
	});

	test('攒够 BATCH_SIZE 立即封批并触发发送', async () => {
		const { rl, sendCalls } = mkRl();
		for (let i = 0; i < BATCH_SIZE; i++) {
			rl.log(`m${i}`);
		}
		expect(rl.__ring).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(0);
		expect(sendCalls).toHaveLength(1);
		expect(sendCalls[0].uiId).toBe('A_test_id_21__________');
		expect(sendCalls[0].seq).toBe(1);
		expect(sendCalls[0].logs).toHaveLength(BATCH_SIZE);
	});

	test('未达 BATCH_SIZE 时 DEBOUNCE_MS 触发封批', async () => {
		const { rl, sendCalls } = mkRl();
		rl.log('a');
		rl.log('b');
		// 还未到 5s，不发
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
		expect(sendCalls).toHaveLength(0);
		// 跨过阈值
		await vi.advanceTimersByTimeAsync(1);
		expect(sendCalls).toHaveLength(1);
		expect(sendCalls[0].logs.map(l => l.text)).toEqual(['a', 'b']);
	});

	test('封批后 debounce 计时重置（下批又需 DEBOUNCE_MS 才发）', async () => {
		const { rl, sendCalls } = mkRl();
		rl.log('a');
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
		expect(sendCalls).toHaveLength(1);
		rl.log('b');
		// 立即检查不会再发
		await vi.advanceTimersByTimeAsync(0);
		expect(sendCalls).toHaveLength(1);
		// 满足 debounce 才发
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
		expect(sendCalls).toHaveLength(2);
		expect(sendCalls[1].seq).toBe(2);
	});

	test('seq 跨封批单调递增、不重置', async () => {
		const { rl, sendCalls } = mkRl();
		for (let i = 0; i < BATCH_SIZE * 3; i++) rl.log(`m${i}`);
		await vi.advanceTimersByTimeAsync(0);
		// 第一批已发 → in-flight，剩 2 批在 pending；每批 ack 后再发下一批
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);
		expect(sendCalls.map(s => s.seq)).toEqual([1, 2, 3]);
	});
});

describe('RemoteLog sequential send (1 in-flight)', () => {
	test('in-flight 时新 batch 进 pending；ack 后顺序发出', async () => {
		const ctx = mkRl();
		let resolveFirst = null;
		ctx.respond = (_p, n) => {
			if (n === 1) {
				return new Promise(r => { resolveFirst = () => r({ kind: 'success' }); });
			}
			return { kind: 'success' };
		};
		// 先攒一批
		for (let i = 0; i < BATCH_SIZE; i++) ctx.rl.log(`a${i}`);
		await vi.advanceTimersByTimeAsync(0);
		expect(ctx.sendCalls).toHaveLength(1);
		// 再攒第二批；不会立刻发，等第一批 ack
		for (let i = 0; i < BATCH_SIZE; i++) ctx.rl.log(`b${i}`);
		await vi.advanceTimersByTimeAsync(0);
		expect(ctx.sendCalls).toHaveLength(1);
		// 放第一批的锁
		resolveFirst();
		await vi.advanceTimersByTimeAsync(0);
		expect(ctx.sendCalls).toHaveLength(2);
		expect(ctx.sendCalls[1].seq).toBe(2);
	});

	test('pending 队列满时丢最旧整批，in-flight 不被驱逐', async () => {
		const ctx = mkRl();
		ctx.respond = () => new Promise(() => {}); // 第一批永挂，阻住所有后续
		// 第一批：填满 100 条 → 触发立即 pack，seq=1 → in-flight
		for (let i = 0; i < BATCH_SIZE; i++) ctx.rl.log(`m${i}`);
		await vi.advanceTimersByTimeAsync(0);
		expect(ctx.sendCalls).toHaveLength(1);
		// 再封 MAX_PENDING + 2 批：seq=2..13
		for (let b = 0; b < MAX_PENDING + 2; b++) {
			for (let i = 0; i < BATCH_SIZE; i++) ctx.rl.log(`b${b}_${i}`);
		}
		await vi.advanceTimersByTimeAsync(0);
		// in-flight 仍是 seq=1（不会被驱逐）
		expect(ctx.rl.__inFlight?.seq).toBe(1);
		// pending 应正好 MAX_PENDING，包含 seq=4..13（seq=2 / seq=3 是最旧的待发，被驱逐）
		expect(ctx.rl.__pending).toHaveLength(MAX_PENDING);
		expect(ctx.rl.__pending.map((b) => b.seq)).toEqual(
			Array.from({ length: MAX_PENDING }, (_, i) => i + 4),
		);
	});

	test('4xx 丢弃当前 batch 后，下一个 pending batch 立即接力', async () => {
		const ctx = mkRl();
		let phase = 0;
		ctx.respond = () => {
			phase += 1;
			if (phase === 1) return { kind: 'badRequest' };
			return { kind: 'success' };
		};
		for (let i = 0; i < BATCH_SIZE; i++) ctx.rl.log(`a${i}`); // seq=1
		for (let i = 0; i < BATCH_SIZE; i++) ctx.rl.log(`b${i}`); // seq=2
		await vi.advanceTimersByTimeAsync(0);
		// seq=1 → 4xx → 立即放弃；seq=2 接力
		expect(ctx.sendCalls.length).toBeGreaterThanOrEqual(2);
		expect(ctx.sendCalls[0].seq).toBe(1);
		expect(ctx.sendCalls[1].seq).toBe(2);
		expect(ctx.rl.__inFlight).toBe(null);
	});

	test('重试发送同一 payload（同 seq + 同 logs 内容）', async () => {
		const ctx = mkRl({ random: () => 0 });
		let n = 0;
		ctx.respond = () => {
			n += 1;
			if (n <= 2) return { kind: 'retryable' };
			return { kind: 'success' };
		};
		for (let i = 0; i < BATCH_SIZE; i++) ctx.rl.log(`m${i}`);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(BACKOFF_BASE_MS);
		await vi.advanceTimersByTimeAsync(2000);
		expect(ctx.sendCalls).toHaveLength(3);
		const seqs = ctx.sendCalls.map((c) => c.seq);
		expect(seqs).toEqual([1, 1, 1]);
		const logTexts = ctx.sendCalls.map((c) => c.logs.map((l) => l.text).join(','));
		expect(new Set(logTexts).size).toBe(1); // 三次 payload 完全一致
	});
});

describe('RemoteLog retry & backoff', () => {
	test('2xx 移除整批', async () => {
		const ctx = mkRl();
		for (let i = 0; i < BATCH_SIZE; i++) ctx.rl.log(`m${i}`);
		await vi.advanceTimersByTimeAsync(0);
		expect(ctx.sendCalls).toHaveLength(1);
		expect(ctx.rl.__inFlight).toBe(null);
	});

	test('4xx (非 408/429) 整批丢弃，不重试', async () => {
		const ctx = mkRl();
		ctx.respond = () => ({ kind: 'badRequest' });
		for (let i = 0; i < BATCH_SIZE; i++) ctx.rl.log(`m${i}`);
		await vi.advanceTimersByTimeAsync(0);
		expect(ctx.sendCalls).toHaveLength(1);
		// 之后不再重试
		await vi.advanceTimersByTimeAsync(BACKOFF_CAP_MS * 2);
		expect(ctx.sendCalls).toHaveLength(1);
		expect(ctx.rl.__inFlight).toBe(null);
	});

	test('5xx 指数退避 1s → 2s → 4s → ... 上限 60s（random=0 时无抖动）', async () => {
		const ctx = mkRl({ random: () => 0 });
		ctx.respond = () => ({ kind: 'retryable' });
		for (let i = 0; i < BATCH_SIZE; i++) ctx.rl.log(`m${i}`);
		await vi.advanceTimersByTimeAsync(0);
		expect(ctx.sendCalls).toHaveLength(1);

		const expected = [BACKOFF_BASE_MS, 2000, 4000, 8000, 16000, 32000, BACKOFF_CAP_MS];
		for (let i = 0; i < expected.length; i++) {
			await vi.advanceTimersByTimeAsync(expected[i] - 1);
			expect(ctx.sendCalls.length).toBe(i + 1);
			await vi.advanceTimersByTimeAsync(1);
			expect(ctx.sendCalls.length).toBe(i + 2);
		}
		// 累计共 MAX_ATTEMPTS 次发送后，第 MAX_ATTEMPTS 次的 retryable 结果命中上限丢弃
		expect(ctx.sendCalls.length).toBe(MAX_ATTEMPTS);
		expect(ctx.rl.__inFlight).toBe(null);
	});

	test('达到 MAX_ATTEMPTS 后丢弃整批', async () => {
		const ctx = mkRl({ random: () => 0 });
		ctx.respond = () => ({ kind: 'retryable' });
		for (let i = 0; i < BATCH_SIZE; i++) ctx.rl.log(`m${i}`);
		await vi.advanceTimersByTimeAsync(0);
		// 跑足够久让所有 backoff 完成；MAX_ATTEMPTS=8 → 累积 ≈ 127s
		await vi.advanceTimersByTimeAsync(BACKOFF_CAP_MS * MAX_ATTEMPTS + 5_000);
		expect(ctx.sendCalls.length).toBe(MAX_ATTEMPTS);
		expect(ctx.rl.__inFlight).toBe(null);
	});

	test('总耗时超 MAX_DURATION_MS 后丢弃整批（与 MAX_ATTEMPTS 路径严格区分）', async () => {
		let t = 1_000_000_000;
		const ctx = mkRl({ now: () => t });
		ctx.respond = () => {
			// 每次响应让时间往前推 ≈ 1/3 MAX_DURATION_MS（>= 200s），4 次后命中 10min 上限；
			// 此时 attempts 仅 ~4 远低于 MAX_ATTEMPTS=8，能区分两条退出路径
			t += Math.floor(MAX_DURATION_MS / 3) + 1;
			return { kind: 'retryable' };
		};
		for (let i = 0; i < BATCH_SIZE; i++) ctx.rl.log(`m${i}`);
		await vi.advanceTimersByTimeAsync(0);
		// 推到足够远让退避时钟全部跑完
		for (let i = 0; i < 10; i++) {
			await vi.advanceTimersByTimeAsync(BACKOFF_CAP_MS + 1);
		}
		expect(ctx.rl.__inFlight).toBe(null);
		expect(ctx.sendCalls.length).toBeLessThan(MAX_ATTEMPTS); // 严格小于：不是 attempts 路径
		expect(ctx.sendCalls.length).toBeGreaterThanOrEqual(3);
	});

	test('Retry-After: 0 立即重试（不退化为指数退避）', async () => {
		const ctx = mkRl({ random: () => 0 });
		let phase = 0;
		ctx.respond = () => {
			phase += 1;
			if (phase === 1) return { kind: 'retryable', retryAfterMs: 0 };
			return { kind: 'success' };
		};
		for (let i = 0; i < BATCH_SIZE; i++) ctx.rl.log(`m${i}`);
		// 0ms 退避时 timer 在 advanceTimersByTimeAsync(0) 推进当前帧时就会 fire，
		// 同时 microtask 链也走完——若被错误地降级为 BACKOFF_BASE_MS=1000ms，第二次发送不会出现
		await vi.advanceTimersByTimeAsync(0);
		expect(ctx.sendCalls).toHaveLength(2);
	});

	test('408 / 429 走 retryable；retryAfterMs 优先', async () => {
		const ctx = mkRl({ random: () => 0 });
		let phase = 0;
		ctx.respond = () => {
			phase += 1;
			if (phase === 1) return { kind: 'retryable', retryAfterMs: 3_000 };
			return { kind: 'success' };
		};
		for (let i = 0; i < BATCH_SIZE; i++) ctx.rl.log(`m${i}`);
		await vi.advanceTimersByTimeAsync(0);
		expect(ctx.sendCalls).toHaveLength(1);
		// 还没到 retry-after 不发
		await vi.advanceTimersByTimeAsync(2_999);
		expect(ctx.sendCalls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(ctx.sendCalls).toHaveLength(2);
	});

	test('network 错误（send 抛异常）走 retryable', async () => {
		const ctx = mkRl({ random: () => 0 });
		let n = 0;
		ctx.respond = () => {
			n += 1;
			if (n === 1) throw new Error('boom');
			return { kind: 'success' };
		};
		// 直接覆盖：用 throw 模拟 promise rejection
		const rl = new RemoteLog({
			send: () => {
				n += 1;
				if (n === 1) return Promise.reject(new Error('net'));
				return Promise.resolve({ kind: 'success' });
			},
			random: () => 0,
			uiId: 'B_____________________',
		});
		for (let i = 0; i < BATCH_SIZE; i++) rl.log(`m${i}`);
		await vi.advanceTimersByTimeAsync(0);
		expect(n).toBe(1);
		await vi.advanceTimersByTimeAsync(BACKOFF_BASE_MS);
		expect(n).toBe(2);
		expect(rl.__inFlight).toBe(null);
	});

	test('send 返回 undefined / 未知 kind 当作 network 错误', async () => {
		const ctx = mkRl({ random: () => 0 });
		let n = 0;
		ctx.respond = () => {
			n += 1;
			if (n === 1) return undefined;
			if (n === 2) return { kind: 'weird' };
			return { kind: 'success' };
		};
		for (let i = 0; i < BATCH_SIZE; i++) ctx.rl.log(`m${i}`);
		await vi.advanceTimersByTimeAsync(0);
		expect(n).toBe(1);
		await vi.advanceTimersByTimeAsync(BACKOFF_BASE_MS + 5);
		expect(n).toBe(2);
		await vi.advanceTimersByTimeAsync(2000 + 5);
		expect(n).toBe(3);
		expect(ctx.rl.__inFlight).toBe(null);
	});

	test('stop() 后不再发送 / 不再调度', async () => {
		const ctx = mkRl();
		// 仅入 ring 不触发立即封批（不到 BATCH_SIZE）
		for (let i = 0; i < BATCH_SIZE - 1; i++) ctx.rl.log(`m${i}`);
		ctx.rl.stop();
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
		expect(ctx.sendCalls).toHaveLength(0);
		// stop 后 log 调用直接 no-op
		ctx.rl.log('after-stop');
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
		expect(ctx.sendCalls).toHaveLength(0);
	});

	test('stop() 后已在飞的 send 迟到 retryable 响应不再调度新 retry', async () => {
		const ctx = mkRl({ random: () => 0 });
		let resolver = null;
		ctx.respond = () => new Promise((r) => { resolver = r; });
		for (let i = 0; i < BATCH_SIZE; i++) ctx.rl.log(`m${i}`);
		await vi.advanceTimersByTimeAsync(0);
		expect(ctx.sendCalls).toHaveLength(1);
		// stop 后再让 in-flight 收到 retryable —— 应被 __stopped 守卫吞掉
		ctx.rl.stop();
		resolver({ kind: 'retryable' });
		await vi.advanceTimersByTimeAsync(BACKOFF_BASE_MS * 5);
		expect(ctx.sendCalls).toHaveLength(1); // 没有第二次发送
		expect(ctx.rl.__inFlight).toBe(null);
	});
});

describe('RemoteLog 跨登录态：行为不变', () => {
	test('login / logout 类外部事件不触发任何 flush 或状态切换', async () => {
		const ctx = mkRl();
		ctx.rl.log('before-login');
		// 模拟用户登录 / 登出：纯外部状态变化，RemoteLog 无感知
		// 不调任何 hook（设计上就没有）；ring 保持原状
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
		expect(ctx.sendCalls).toHaveLength(0);
		ctx.rl.log('after-logout');
		await vi.advanceTimersByTimeAsync(2);
		expect(ctx.sendCalls).toHaveLength(1);
		// 两条 log 同一 batch（同一 uiId / 同一 seq）；登录态变化对发送行为无影响
		expect(ctx.sendCalls[0].logs.map(l => l.text)).toEqual(['before-login', 'after-logout']);
	});

	test('seq 跨多次封批单调递增，无重置点', async () => {
		const ctx = mkRl();
		// 三次 debounce 触发
		for (let round = 0; round < 3; round++) {
			ctx.rl.log(`r${round}`);
			await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
		}
		expect(ctx.sendCalls.map(s => s.seq)).toEqual([1, 2, 3]);
	});
});

describe('httpSender 适配器', () => {
	function mkHttp(respond) {
		return { post: vi.fn().mockImplementation(respond) };
	}

	test('2xx → success', async () => {
		const http = mkHttp(() => Promise.resolve({ status: 200 }));
		const r = await httpSender(http, { uiId: 'x', seq: 1, logs: [] });
		expect(r).toEqual({ kind: 'success' });
		expect(http.post).toHaveBeenCalledWith(ENDPOINT_PATH, expect.any(Object), { timeout: HTTP_TIMEOUT_MS });
	});

	test('400 / 413 → badRequest', async () => {
		for (const status of [400, 403, 404, 413]) {
			const http = mkHttp(() => Promise.reject({ response: { status } }));
			const r = await httpSender(http, { uiId: 'x', seq: 1, logs: [] });
			expect(r).toEqual({ kind: 'badRequest' });
		}
	});

	test('408 / 429 → retryable，Retry-After 秒数解析为 ms', async () => {
		const http = mkHttp(() => Promise.reject({
			response: { status: 429, headers: { 'retry-after': '7' } },
		}));
		const r = await httpSender(http, { uiId: 'x', seq: 1, logs: [] });
		expect(r).toEqual({ kind: 'retryable', retryAfterMs: 7000 });
	});

	test('408 没带 Retry-After → retryable 无 retryAfterMs', async () => {
		const http = mkHttp(() => Promise.reject({ response: { status: 408, headers: {} } }));
		const r = await httpSender(http, { uiId: 'x', seq: 1, logs: [] });
		expect(r.kind).toBe('retryable');
		expect(r.retryAfterMs).toBeUndefined();
	});

	test('Retry-After 是 HTTP-date → 转 ms 偏移', async () => {
		vi.useRealTimers();
		const future = new Date(Date.now() + 5000).toUTCString();
		const http = mkHttp(() => Promise.reject({
			response: { status: 429, headers: { 'retry-after': future } },
		}));
		const r = await httpSender(http, { uiId: 'x', seq: 1, logs: [] });
		expect(r.kind).toBe('retryable');
		expect(r.retryAfterMs).toBeGreaterThan(3000);
		expect(r.retryAfterMs).toBeLessThan(6000);
		vi.useFakeTimers();
	});

	test('5xx → retryable', async () => {
		for (const status of [500, 502, 503, 504]) {
			const http = mkHttp(() => Promise.reject({ response: { status } }));
			const r = await httpSender(http, { uiId: 'x', seq: 1, logs: [] });
			expect(r).toEqual({ kind: 'retryable' });
		}
	});

	test('network error（无 response）→ network', async () => {
		const http = mkHttp(() => Promise.reject(new Error('ECONNABORTED')));
		const r = await httpSender(http, { uiId: 'x', seq: 1, logs: [] });
		expect(r.kind).toBe('network');
	});
});

describe('buildUiStartText (ui.start 首条 log)', () => {
	test('包含必备字段 uiId / version / platform / theme / tz / ua', () => {
		vi.stubGlobal('__APP_VERSION__', '9.9.9');
		const text = buildUiStartText('TESTID_______________');
		expect(text.startsWith('ui.start ')).toBe(true);
		expect(text).toContain('uiId=TESTID_______________');
		expect(text).toContain('version=9.9.9');
		expect(text).toMatch(/platform=(web|cap-\w+|electron-\w+|electron)/);
		expect(text).toMatch(/theme=(light|dark|no-pref)/);
		expect(text).toMatch(/tz=\S+/);
		expect(text).toMatch(/lang=\S+/);
		expect(text).toMatch(/ua="[^"]+"/);
	});

	test('navigator.deviceMemory / connection 不可读时整字段省略（不写 unknown）', () => {
		const ndm = Object.getOwnPropertyDescriptor(navigator, 'deviceMemory');
		const nconn = Object.getOwnPropertyDescriptor(navigator, 'connection');
		Object.defineProperty(navigator, 'deviceMemory', { configurable: true, get: () => undefined });
		Object.defineProperty(navigator, 'connection', { configurable: true, get: () => undefined });
		try {
			const text = buildUiStartText('Y_____________________');
			expect(text).not.toMatch(/mem=/);
			expect(text).not.toMatch(/net=/);
			expect(text).not.toMatch(/unknown/);
		} finally {
			if (ndm) Object.defineProperty(navigator, 'deviceMemory', ndm); else delete navigator.deviceMemory;
			if (nconn) Object.defineProperty(navigator, 'connection', nconn); else delete navigator.connection;
		}
	});

	test('version 未注入时回退 unknown', () => {
		const orig = globalThis.__APP_VERSION__;
		vi.unstubAllGlobals();
		// @ts-ignore
		globalThis.__APP_VERSION__ = '';
		try {
			const text = buildUiStartText('Z_____________________');
			expect(text).toContain('version=unknown');
		} finally {
			globalThis.__APP_VERSION__ = orig;
		}
	});
});

describe('单例 useRemoteLog / remoteLog', () => {
	test('useRemoteLog 是单例', () => {
		const a = useRemoteLog({ send: () => Promise.resolve({ kind: 'success' }), skipUiStart: true, skipSigBridge: true });
		const b = useRemoteLog();
		expect(a).toBe(b);
	});

	test('首次初始化自动入队 ui.start', async () => {
		const sent = [];
		const rl = useRemoteLog({
			send: (p) => { sent.push(p); return Promise.resolve({ kind: 'success' }); },
			uiId: 'INIT__________________',
			skipSigBridge: true,
		});
		expect(rl.uiId).toBe('INIT__________________');
		expect(rl.__ring.length).toBeGreaterThanOrEqual(1);
		expect(rl.__ring[0].text.startsWith('ui.start ')).toBe(true);
	});

	test('remoteLog() 便捷函数路由到单例', async () => {
		const sent = [];
		useRemoteLog({
			send: (p) => { sent.push(p); return Promise.resolve({ kind: 'success' }); },
			uiId: 'C_____________________',
			skipUiStart: true,
			skipSigBridge: true,
		});
		remoteLog('via-helper');
		// 触发 5s debounce 发送
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
		expect(sent).toHaveLength(1);
		expect(sent[0].logs[0].text).toBe('via-helper');
	});

	test('桥接 sigConn.log 事件 → remoteLog', async () => {
		const sigConn = useSignalingConnection({ WebSocket: class { addEventListener(){} removeEventListener(){} send(){} close(){} } });
		const sent = [];
		useRemoteLog({
			send: (p) => { sent.push(p); return Promise.resolve({ kind: 'success' }); },
			uiId: 'D_____________________',
			skipUiStart: true,
		});
		sigConn.__emit('log', 'sig.test-event');
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
		expect(sent[0].logs.some(l => l.text === 'sig.test-event')).toBe(true);
	});

	test('__resetRemoteLog 卸载 sigConn log 监听器，不会泄漏到下一轮单例', async () => {
		const sigConn = useSignalingConnection({ WebSocket: class { addEventListener(){} removeEventListener(){} send(){} close(){} } });
		const firstSends = [];
		useRemoteLog({
			send: (p) => { firstSends.push(p); return Promise.resolve({ kind: 'success' }); },
			uiId: 'F1____________________',
			skipUiStart: true,
		});
		__resetRemoteLog();
		const secondSends = [];
		useRemoteLog({
			send: (p) => { secondSends.push(p); return Promise.resolve({ kind: 'success' }); },
			uiId: 'F2____________________',
			skipUiStart: true,
		});
		// 触发一次 sig 'log' 事件——第一轮的监听器已被 off 掉，应只调一次新单例的 log
		sigConn.__emit('log', 'sig.unique-event');
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
		expect(firstSends).toHaveLength(0);
		const allTexts = secondSends.flatMap((p) => p.logs.map((l) => l.text));
		// 关键：只出现 1 次，不会因泄漏的旧 listener 而出现 2 次
		expect(allTexts.filter((t) => t === 'sig.unique-event')).toHaveLength(1);
	});

	test('skipSigBridge=true 时 sigConn.log 事件不入队', async () => {
		const sigConn = useSignalingConnection({ WebSocket: class { addEventListener(){} removeEventListener(){} send(){} close(){} } });
		const sent = [];
		useRemoteLog({
			send: (p) => { sent.push(p); return Promise.resolve({ kind: 'success' }); },
			uiId: 'E_____________________',
			skipUiStart: true,
			skipSigBridge: true,
		});
		sigConn.__emit('log', 'sig.skipped');
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
		expect(sent).toHaveLength(0);
	});
});

describe('RemoteLog 构造保护', () => {
	test('未提供 send 时抛错', () => {
		expect(() => new RemoteLog({})).toThrow(/send is required/);
	});
});

describe('platform / theme / retry-after 分支补充', () => {
	function withGlobals(stubs, fn) {
		const restore = [];
		for (const [k, v] of Object.entries(stubs)) {
			const had = Object.prototype.hasOwnProperty.call(globalThis, k);
			const old = globalThis[k];
			globalThis[k] = v;
			restore.push(() => { if (had) globalThis[k] = old; else delete globalThis[k]; });
		}
		try { return fn(); } finally { restore.forEach(r => r()); }
	}

	test('Capacitor 原生 android → cap-android', () => {
		withGlobals({
			Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
		}, () => {
			const text = buildUiStartText('id_____________________');
			expect(text).toContain('platform=cap-android');
		});
	});

	test('Capacitor 原生 ios → cap-ios', () => {
		withGlobals({
			Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
		}, () => {
			expect(buildUiStartText('x_____________________')).toContain('platform=cap-ios');
		});
	});

	test('Capacitor 原生但 platform 为空 → cap-unknown', () => {
		withGlobals({
			Capacitor: { isNativePlatform: () => true, getPlatform: () => '' },
		}, () => {
			expect(buildUiStartText('x_____________________')).toContain('platform=cap-unknown');
		});
	});

	test('Electron Windows / Mac / Linux / 其他', () => {
		const cases = [
			{ ua: 'Mozilla/5.0 (Windows NT 10.0)', expected: 'electron-win' },
			{ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', expected: 'electron-mac' },
			{ ua: 'Mozilla/5.0 (X11; Linux x86_64)', expected: 'electron-linux' },
		];
		for (const c of cases) {
			const origUa = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
			Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => c.ua });
			withGlobals({ electronAPI: {} }, () => {
				expect(buildUiStartText('x_____________________')).toContain(`platform=${c.expected}`);
			});
			if (origUa) Object.defineProperty(navigator, 'userAgent', origUa); else delete navigator.userAgent;
		}
	});

	test('Electron 但 UA 不识别 → platform=electron', () => {
		const origUa = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
		Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => 'Unknown/OS' });
		try {
			withGlobals({ electronAPI: {} }, () => {
				expect(buildUiStartText('x_____________________')).toContain('platform=electron');
			});
		} finally {
			if (origUa) Object.defineProperty(navigator, 'userAgent', origUa); else delete navigator.userAgent;
		}
	});

	test('detectTheme: dark / light / no-pref', () => {
		const origMm = window.matchMedia;
		window.matchMedia = (q) => ({ matches: q.includes('dark') });
		expect(buildUiStartText('a_____________________')).toContain('theme=dark');
		window.matchMedia = (q) => ({ matches: q.includes('light') });
		expect(buildUiStartText('a_____________________')).toContain('theme=light');
		window.matchMedia = () => ({ matches: false });
		expect(buildUiStartText('a_____________________')).toContain('theme=no-pref');
		// matchMedia 抛错 → no-pref
		window.matchMedia = () => { throw new Error('not supported'); };
		expect(buildUiStartText('a_____________________')).toContain('theme=no-pref');
		window.matchMedia = origMm;
	});

	test('httpSender: Retry-After 是 garbage → retryable 无 retryAfterMs', async () => {
		const http = { post: () => Promise.reject({ response: { status: 429, headers: { 'retry-after': 'not-a-date' } } }) };
		const r = await httpSender(http, { uiId: 'x', seq: 1, logs: [] });
		expect(r.kind).toBe('retryable');
		expect(r.retryAfterMs).toBeUndefined();
	});

	test('httpSender: Retry-After 为负秒数 → 仍 retryable，retryAfterMs 不为 NaN', async () => {
		const http = { post: () => Promise.reject({ response: { status: 429, headers: { 'retry-after': '-5' } } }) };
		const r = await httpSender(http, { uiId: 'x', seq: 1, logs: [] });
		expect(r.kind).toBe('retryable');
		// 实现可能把负秒数视为 garbage 也可能视为合法（Date.parse 在部分实现里能容忍），
		// 关键是不产生 NaN 让 setTimeout 报错
		if (r.retryAfterMs !== undefined) {
			expect(Number.isFinite(r.retryAfterMs)).toBe(true);
		}
	});
});
