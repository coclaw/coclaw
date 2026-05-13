// @vitest-environment jsdom
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

import {
	RemoteLog, useRemoteLog, remoteLog, __resetRemoteLog,
	httpSender,
	BATCH_SIZE, DEBOUNCE, MAX_RING, MAX_PENDING,
	RETRY_DELAYS,
	ENDPOINT_PATH, HTTP_TIMEOUT,
} from './remote-log.js';
import {
	useSignalingConnection, __resetSignalingConnection,
} from './signaling-connection.js';

/**
 * 用 vi.useFakeTimers() 控时；advanceTimersByTimeAsync 同步推进 timer + microtask，
 * 避免 fake timer 与 async/await 微任务竞态。
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

describe('RETRY_DELAYS contract (literal anchor)', () => {
	// 数组本身是行为契约；任何长度/边界值/总和改动都应有意识地评估测试覆盖与发布说明
	test('数组本体精确锁定（防中段无意改动）', () => {
		expect(RETRY_DELAYS).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000]);
	});

	test('共 10 次重试（首发 + 10 = 11 次发送）', () => {
		expect(RETRY_DELAYS).toHaveLength(10);
	});

	test('首次重试 1 秒（指数起点）', () => {
		expect(RETRY_DELAYS[0]).toBe(1000);
	});

	test('cap 30 秒（亦为 Retry-After 上限）', () => {
		expect(Math.max(...RETRY_DELAYS)).toBe(30000);
	});

	test('累计 ~181s（设计稿 §3.4 / changeset 行为口径一致）', () => {
		const sum = RETRY_DELAYS.reduce((a, b) => a + b, 0);
		expect(sum).toBe(181_000);
	});
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
		ctx.respond = () => new Promise(() => {}); // 阻住消费循环：第一批永挂，其余留 __pending
		for (let i = 0; i < MAX_RING; i++) {
			ctx.rl.__ring.push({ ts: 0, text: `m${i}` });
		}
		// 此时 ring.length === MAX_RING；再 push 一条 → shift 触发 → ring 仍 MAX_RING
		ctx.rl.log('latest');
		// 同步路径：log → push → shift(m0) → pack 把 ring 全部送进 pending（10 batch）→ drain 同步 shift 第一批进 send（永挂）
		// 第一批已被 shift 走（payload 见 sendCalls），剩 9 批仍在 __pending
		const allTexts = [
			...ctx.sendCalls.flatMap((p) => p.logs.map((l) => l.text)),
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

	test('未达 BATCH_SIZE 时 DEBOUNCE 触发封批', async () => {
		const { rl, sendCalls } = mkRl();
		rl.log('a');
		rl.log('b');
		// 还未到 5s，不发
		await vi.advanceTimersByTimeAsync(DEBOUNCE - 1);
		expect(sendCalls).toHaveLength(0);
		// 跨过阈值
		await vi.advanceTimersByTimeAsync(1);
		expect(sendCalls).toHaveLength(1);
		expect(sendCalls[0].logs.map(l => l.text)).toEqual(['a', 'b']);
	});

	test('封批后 debounce 计时重置（下批又需 DEBOUNCE 才发）', async () => {
		const { rl, sendCalls } = mkRl();
		rl.log('a');
		await vi.advanceTimersByTimeAsync(DEBOUNCE);
		expect(sendCalls).toHaveLength(1);
		rl.log('b');
		// 立即检查不会再发
		await vi.advanceTimersByTimeAsync(0);
		expect(sendCalls).toHaveLength(1);
		// 满足 debounce 才发
		await vi.advanceTimersByTimeAsync(DEBOUNCE);
		expect(sendCalls).toHaveLength(2);
		expect(sendCalls[1].seq).toBe(2);
	});

	test('seq 跨封批单调递增、不重置', async () => {
		const { rl, sendCalls } = mkRl();
		for (let i = 0; i < BATCH_SIZE * 3; i++) rl.log(`m${i}`);
		await vi.advanceTimersByTimeAsync(0);
		expect(sendCalls.map(s => s.seq)).toEqual([1, 2, 3]);
	});
});

describe('RemoteLog sequential send (单 async 消费循环)', () => {
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
		expect(ctx.rl.__draining).toBe(true); // 消费循环正在 await 第一批
		// 再攒第二批；不会立刻发，等第一批 ack；__pack 的 __drain() 重入早返回（__draining 守卫）
		for (let i = 0; i < BATCH_SIZE; i++) ctx.rl.log(`b${i}`);
		await vi.advanceTimersByTimeAsync(0);
		expect(ctx.sendCalls).toHaveLength(1); // 第二批没被重复 ship 出去
		expect(ctx.rl.__draining).toBe(true); // 仍在 await 第一批
		expect(ctx.rl.__pending.map((b) => b.seq)).toEqual([2]); // 第二批已入 pending 等接力
		// 放第一批的锁
		resolveFirst();
		await vi.advanceTimersByTimeAsync(0);
		expect(ctx.sendCalls).toHaveLength(2);
		expect(ctx.sendCalls[1].seq).toBe(2);
		expect(ctx.rl.__draining).toBe(false);
	});

	test('pending 队列满时丢最旧整批，正在发送的 batch 不被驱逐', async () => {
		const ctx = mkRl();
		ctx.respond = () => new Promise(() => {}); // 第一批永挂，阻住所有后续
		// 第一批：填满 100 条 → 触发立即 pack，seq=1 → 进入 send 等待
		for (let i = 0; i < BATCH_SIZE; i++) ctx.rl.log(`m${i}`);
		await vi.advanceTimersByTimeAsync(0);
		expect(ctx.sendCalls).toHaveLength(1);
		// 再封 MAX_PENDING + 2 批：seq=2..13
		for (let b = 0; b < MAX_PENDING + 2; b++) {
			for (let i = 0; i < BATCH_SIZE; i++) ctx.rl.log(`b${b}_${i}`);
		}
		await vi.advanceTimersByTimeAsync(0);
		// pending 应正好 MAX_PENDING，包含 seq=4..13（seq=2 / seq=3 是最旧的待发，被驱逐）
		expect(ctx.rl.__pending).toHaveLength(MAX_PENDING);
		expect(ctx.rl.__pending.map((b) => b.seq)).toEqual(
			Array.from({ length: MAX_PENDING }, (_, i) => i + 4),
		);
		// 正在发送的 batch 是 seq=1（已 shift 出 pending）
		expect(ctx.sendCalls[0].seq).toBe(1);
		// 即使 pending 满了驱逐最旧，正在飞的 seq=1 不会被回灌覆盖
		expect(ctx.rl.__pending.map((b) => b.seq)).not.toContain(1);
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
		expect(ctx.rl.__pending).toHaveLength(0);
	});

	test('重试发送同一 payload（同 seq + 同 logs 内容）', async () => {
		const ctx = mkRl();
		let n = 0;
		ctx.respond = () => {
			n += 1;
			if (n <= 2) return { kind: 'retryable' };
			return { kind: 'success' };
		};
		for (let i = 0; i < BATCH_SIZE; i++) ctx.rl.log(`m${i}`);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0]);
		await vi.advanceTimersByTimeAsync(RETRY_DELAYS[1]);
		expect(ctx.sendCalls).toHaveLength(3);
		const seqs = ctx.sendCalls.map((c) => c.seq);
		expect(seqs).toEqual([1, 1, 1]);
		const logTexts = ctx.sendCalls.map((c) => c.logs.map((l) => l.text).join(','));
		expect(new Set(logTexts).size).toBe(1); // 三次 payload 完全一致
	});

	test('A-S1：drain 跑空 finally 后再 push 能干净重启（消费循环可重入）', async () => {
		const ctx = mkRl();
		for (let i = 0; i < BATCH_SIZE; i++) ctx.rl.log(`a${i}`);
		await vi.advanceTimersByTimeAsync(0);
		expect(ctx.sendCalls).toHaveLength(1);
		// drain 已退出 finally
		expect(ctx.rl.__draining).toBe(false);
		expect(ctx.rl.__pending).toHaveLength(0);
		// 再封一批
		for (let i = 0; i < BATCH_SIZE; i++) ctx.rl.log(`b${i}`);
		await vi.advanceTimersByTimeAsync(0);
		expect(ctx.sendCalls).toHaveLength(2);
		expect(ctx.sendCalls[1].seq).toBe(2);
	});
});

describe('RemoteLog retry & backoff (数组驱动)', () => {
	test('2xx 移除整批', async () => {
		const ctx = mkRl();
		for (let i = 0; i < BATCH_SIZE; i++) ctx.rl.log(`m${i}`);
		await vi.advanceTimersByTimeAsync(0);
		expect(ctx.sendCalls).toHaveLength(1);
		expect(ctx.rl.__pending).toHaveLength(0);
	});

	test('4xx (非 408/429) 整批丢弃，不重试', async () => {
		const ctx = mkRl();
		ctx.respond = () => ({ kind: 'badRequest' });
		for (let i = 0; i < BATCH_SIZE; i++) ctx.rl.log(`m${i}`);
		await vi.advanceTimersByTimeAsync(0);
		expect(ctx.sendCalls).toHaveLength(1);
		// 之后不再重试
		await vi.advanceTimersByTimeAsync(Math.max(...RETRY_DELAYS) * 2);
		expect(ctx.sendCalls).toHaveLength(1);
	});

	test('retryable 走 RETRY_DELAYS 表节奏', async () => {
		const ctx = mkRl();
		ctx.respond = () => ({ kind: 'retryable' });
		for (let i = 0; i < BATCH_SIZE; i++) ctx.rl.log(`m${i}`);
		await vi.advanceTimersByTimeAsync(0);
		expect(ctx.sendCalls).toHaveLength(1);

		for (let i = 0; i < RETRY_DELAYS.length; i++) {
			await vi.advanceTimersByTimeAsync(RETRY_DELAYS[i] - 1);
			expect(ctx.sendCalls.length).toBe(i + 1);
			await vi.advanceTimersByTimeAsync(1);
			expect(ctx.sendCalls.length).toBe(i + 2);
		}
		// 已走完首发 + 10 次重试 = 11 次发送；之后不再尝试
		expect(ctx.sendCalls.length).toBe(RETRY_DELAYS.length + 1);
		await vi.advanceTimersByTimeAsync(Math.max(...RETRY_DELAYS));
		expect(ctx.sendCalls.length).toBe(RETRY_DELAYS.length + 1);
	});

	test('Retry-After: 0 立即重试（不退化为数组首项）', async () => {
		const ctx = mkRl();
		let phase = 0;
		ctx.respond = () => {
			phase += 1;
			if (phase === 1) return { kind: 'retryable', retryAfter: 0 };
			return { kind: 'success' };
		};
		for (let i = 0; i < BATCH_SIZE; i++) ctx.rl.log(`m${i}`);
		await vi.advanceTimersByTimeAsync(0);
		expect(ctx.sendCalls).toHaveLength(2);
	});

	test('408 / 429 走 retryable；retryAfter 优先于数组项', async () => {
		const ctx = mkRl();
		let phase = 0;
		ctx.respond = () => {
			phase += 1;
			if (phase === 1) return { kind: 'retryable', retryAfter: 3000 };
			return { kind: 'success' };
		};
		for (let i = 0; i < BATCH_SIZE; i++) ctx.rl.log(`m${i}`);
		await vi.advanceTimersByTimeAsync(0);
		expect(ctx.sendCalls).toHaveLength(1);
		// 还没到 retry-after 不发
		await vi.advanceTimersByTimeAsync(2999);
		expect(ctx.sendCalls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(ctx.sendCalls).toHaveLength(2);
	});

	test('Retry-After 超过 cap 时被压回 30s', async () => {
		const ctx = mkRl();
		let phase = 0;
		ctx.respond = () => {
			phase += 1;
			if (phase === 1) return { kind: 'retryable', retryAfter: 120_000 }; // server 给 2min
			return { kind: 'success' };
		};
		for (let i = 0; i < BATCH_SIZE; i++) ctx.rl.log(`m${i}`);
		await vi.advanceTimersByTimeAsync(0);
		expect(ctx.sendCalls).toHaveLength(1);
		// 推进到刚好 30s 之前
		await vi.advanceTimersByTimeAsync(29_999);
		expect(ctx.sendCalls).toHaveLength(1);
		// 跨过 30s
		await vi.advanceTimersByTimeAsync(1);
		expect(ctx.sendCalls).toHaveLength(2);
	});

	test('network 错误（send Promise reject）走 retryable', async () => {
		let n = 0;
		const rl = new RemoteLog({
			send: () => {
				n += 1;
				if (n === 1) return Promise.reject(new Error('net'));
				return Promise.resolve({ kind: 'success' });
			},
			uiId: 'B_____________________',
		});
		for (let i = 0; i < BATCH_SIZE; i++) rl.log(`m${i}`);
		await vi.advanceTimersByTimeAsync(0);
		expect(n).toBe(1);
		await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0]);
		expect(n).toBe(2);
	});

	test('send 返回 undefined / 未知 kind 当作 network 错误', async () => {
		const ctx = mkRl();
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
		await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0]);
		expect(n).toBe(2);
		await vi.advanceTimersByTimeAsync(RETRY_DELAYS[1]);
		expect(n).toBe(3);
	});
});

describe('AbortSignal 集成 (B-S1)', () => {
	test('stop() 后不再发送 / 不再调度', async () => {
		const ctx = mkRl();
		// 仅入 ring 不触发立即封批（不到 BATCH_SIZE）
		for (let i = 0; i < BATCH_SIZE - 1; i++) ctx.rl.log(`m${i}`);
		ctx.rl.stop();
		await vi.advanceTimersByTimeAsync(DEBOUNCE * 2);
		expect(ctx.sendCalls).toHaveLength(0);
		// stop 后 log 调用直接 no-op
		ctx.rl.log('after-stop');
		await vi.advanceTimersByTimeAsync(DEBOUNCE * 2);
		expect(ctx.sendCalls).toHaveLength(0);
	});

	test('sleep 期间 stop() 打断退避，不进入下一次重试', async () => {
		const ctx = mkRl();
		ctx.respond = () => ({ kind: 'retryable' });
		for (let i = 0; i < BATCH_SIZE; i++) ctx.rl.log(`m${i}`);
		await vi.advanceTimersByTimeAsync(0);
		expect(ctx.sendCalls).toHaveLength(1);
		// 正在 sleep RETRY_DELAYS[0]=1000ms；走 500ms 后 abort
		await vi.advanceTimersByTimeAsync(500);
		ctx.rl.stop();
		// 即使继续 advance，不会再发
		await vi.advanceTimersByTimeAsync(Math.max(...RETRY_DELAYS) * 2);
		expect(ctx.sendCalls).toHaveLength(1);
	});

	test('axios cancel（CanceledError 名）→ stop 后退路靠 signal.aborted 区分，不靠 err.name', async () => {
		// 模拟 axios v1 cancel：send 抛 name='CanceledError' 的 error
		const ctx = mkRl();
		let n = 0;
		ctx.respond = () => {
			n += 1;
			if (n === 1) {
				return new Promise((_res, rej) => {
					// 模拟 stop() 触发 → axios 抛 CanceledError 异步 reject
					setTimeout(() => rej(Object.assign(new Error('canceled'), { name: 'CanceledError' })), 100);
				});
			}
			return { kind: 'success' };
		};
		for (let i = 0; i < BATCH_SIZE; i++) ctx.rl.log(`m${i}`);
		await vi.advanceTimersByTimeAsync(0);
		expect(n).toBe(1);
		// stop 之后让 cancel reject 跑完
		ctx.rl.stop();
		await vi.advanceTimersByTimeAsync(100);
		// 即使 err.name === 'CanceledError'（非 AbortError），上层因 signal.aborted=true 提前退出
		await vi.advanceTimersByTimeAsync(Math.max(...RETRY_DELAYS) * 2);
		expect(n).toBe(1);
	});

	test('stop() 之后已在飞的 send 迟到 retryable 不调度新 retry', async () => {
		const ctx = mkRl();
		let resolver = null;
		ctx.respond = () => new Promise((r) => { resolver = r; });
		for (let i = 0; i < BATCH_SIZE; i++) ctx.rl.log(`m${i}`);
		await vi.advanceTimersByTimeAsync(0);
		expect(ctx.sendCalls).toHaveLength(1);
		ctx.rl.stop();
		// 迟到 retryable
		resolver({ kind: 'retryable' });
		await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0] * 5);
		expect(ctx.sendCalls).toHaveLength(1);
	});
});

describe('RemoteLog 跨登录态：行为不变', () => {
	test('login / logout 类外部事件不触发任何 flush 或状态切换', async () => {
		const ctx = mkRl();
		ctx.rl.log('before-login');
		// 模拟用户登录 / 登出：纯外部状态变化，RemoteLog 无感知
		await vi.advanceTimersByTimeAsync(DEBOUNCE - 1);
		expect(ctx.sendCalls).toHaveLength(0);
		ctx.rl.log('after-logout');
		await vi.advanceTimersByTimeAsync(2);
		expect(ctx.sendCalls).toHaveLength(1);
		// 两条 log 同一 batch（同一 uiId / 同一 seq）；登录态变化对发送行为无影响
		expect(ctx.sendCalls[0].logs.map(l => l.text)).toEqual(['before-login', 'after-logout']);
	});

	test('seq 跨多次封批单调递增，无重置点', async () => {
		const ctx = mkRl();
		for (let round = 0; round < 3; round++) {
			ctx.rl.log(`r${round}`);
			await vi.advanceTimersByTimeAsync(DEBOUNCE);
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
		expect(http.post).toHaveBeenCalledWith(
			ENDPOINT_PATH,
			expect.any(Object),
			expect.objectContaining({ timeout: HTTP_TIMEOUT }),
		);
	});

	test('signal 透传到 axios.post 选项', async () => {
		const http = mkHttp(() => Promise.resolve({ status: 200 }));
		const ctrl = new AbortController();
		await httpSender(http, { uiId: 'x', seq: 1, logs: [] }, ctrl.signal);
		expect(http.post).toHaveBeenCalledWith(
			ENDPOINT_PATH,
			expect.any(Object),
			expect.objectContaining({ signal: ctrl.signal }),
		);
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
		expect(r).toEqual({ kind: 'retryable', retryAfter: 7000 });
	});

	test('408 没带 Retry-After → retryable 无 retryAfter', async () => {
		const http = mkHttp(() => Promise.reject({ response: { status: 408, headers: {} } }));
		const r = await httpSender(http, { uiId: 'x', seq: 1, logs: [] });
		expect(r.kind).toBe('retryable');
		expect(r.retryAfter).toBeUndefined();
	});

	test('Retry-After 是 HTTP-date → 转 ms 偏移', async () => {
		vi.useRealTimers();
		const future = new Date(Date.now() + 5000).toUTCString();
		const http = mkHttp(() => Promise.reject({
			response: { status: 429, headers: { 'retry-after': future } },
		}));
		const r = await httpSender(http, { uiId: 'x', seq: 1, logs: [] });
		expect(r.kind).toBe('retryable');
		expect(r.retryAfter).toBeGreaterThan(3000);
		expect(r.retryAfter).toBeLessThan(6000);
		vi.useFakeTimers();
	});

	test('5xx → retryable，带 Retry-After 时也解析（503 常见）', async () => {
		// 无 Retry-After 的 5xx
		for (const status of [500, 502, 504]) {
			const http = mkHttp(() => Promise.reject({ response: { status, headers: {} } }));
			const r = await httpSender(http, { uiId: 'x', seq: 1, logs: [] });
			expect(r.kind).toBe('retryable');
			expect(r.retryAfter).toBeUndefined();
		}
		// 503 带 Retry-After
		const http503 = mkHttp(() => Promise.reject({
			response: { status: 503, headers: { 'retry-after': '15' } },
		}));
		const r = await httpSender(http503, { uiId: 'x', seq: 1, logs: [] });
		expect(r).toEqual({ kind: 'retryable', retryAfter: 15_000 });
	});

	test('network error（无 response）→ network', async () => {
		const http = mkHttp(() => Promise.reject(new Error('ECONNABORTED')));
		const r = await httpSender(http, { uiId: 'x', seq: 1, logs: [] });
		expect(r.kind).toBe('network');
	});
});

describe('单例 useRemoteLog / remoteLog', () => {
	test('useRemoteLog 是单例', () => {
		const a = useRemoteLog({ send: () => Promise.resolve({ kind: 'success' }), skipSigBridge: true });
		const b = useRemoteLog();
		expect(a).toBe(b);
	});

	test('首次初始化生成实例并暴露 uiId', () => {
		const rl = useRemoteLog({
			send: () => Promise.resolve({ kind: 'success' }),
			uiId: 'INIT__________________',
			skipSigBridge: true,
		});
		expect(rl.uiId).toBe('INIT__________________');
		// useRemoteLog 不再自动入队任何 log；ui.start 由 caller 显式发送
		expect(rl.__ring).toHaveLength(0);
	});

	test('remoteLog() 便捷函数路由到单例', async () => {
		const sent = [];
		useRemoteLog({
			send: (p) => { sent.push(p); return Promise.resolve({ kind: 'success' }); },
			uiId: 'C_____________________',
			skipSigBridge: true,
		});
		remoteLog('via-helper');
		// 触发 5s debounce 发送
		await vi.advanceTimersByTimeAsync(DEBOUNCE + 1);
		expect(sent).toHaveLength(1);
		expect(sent[0].logs[0].text).toBe('via-helper');
	});

	test('桥接 sigConn.log 事件 → remoteLog', async () => {
		const sigConn = useSignalingConnection({ WebSocket: class { addEventListener(){} removeEventListener(){} send(){} close(){} } });
		const sent = [];
		useRemoteLog({
			send: (p) => { sent.push(p); return Promise.resolve({ kind: 'success' }); },
			uiId: 'D_____________________',
		});
		sigConn.__emit('log', 'sig.test-event');
		await vi.advanceTimersByTimeAsync(DEBOUNCE + 1);
		expect(sent[0].logs.some(l => l.text === 'sig.test-event')).toBe(true);
	});

	test('__resetRemoteLog 卸载 sigConn log 监听器，不会泄漏到下一轮单例', async () => {
		const sigConn = useSignalingConnection({ WebSocket: class { addEventListener(){} removeEventListener(){} send(){} close(){} } });
		const firstSends = [];
		useRemoteLog({
			send: (p) => { firstSends.push(p); return Promise.resolve({ kind: 'success' }); },
			uiId: 'F1____________________',
		});
		__resetRemoteLog();
		const secondSends = [];
		useRemoteLog({
			send: (p) => { secondSends.push(p); return Promise.resolve({ kind: 'success' }); },
			uiId: 'F2____________________',
		});
		// 触发一次 sig 'log' 事件——第一轮的监听器已被 off 掉，应只调一次新单例的 log
		sigConn.__emit('log', 'sig.unique-event');
		await vi.advanceTimersByTimeAsync(DEBOUNCE + 1);
		expect(firstSends).toHaveLength(0);
		const allTexts = secondSends.flatMap((p) => p.logs.map((l) => l.text));
		expect(allTexts.filter((t) => t === 'sig.unique-event')).toHaveLength(1);
	});

	test('useRemoteLog: sigConn 桥接失败时静默 warn（catch 路径）', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		// 让 attachSigBridge 抛错触发 useRemoteLog 内部 try/catch
		const origAttach = RemoteLog.prototype.attachSigBridge;
		RemoteLog.prototype.attachSigBridge = function failingAttach() { throw new Error('sig-boom'); };
		try {
			expect(() => useRemoteLog({
				send: () => Promise.resolve({ kind: 'success' }),
				uiId: 'SIGFAIL_______________',
			})).not.toThrow();
			const warnedBridge = warnSpy.mock.calls.some((c) => /sigConn|bridge/.test(String(c[0] || '')));
			expect(warnedBridge).toBe(true);
		} finally {
			RemoteLog.prototype.attachSigBridge = origAttach;
			warnSpy.mockRestore();
		}
	});

	test('skipSigBridge=true 时 sigConn.log 事件不入队', async () => {
		const sigConn = useSignalingConnection({ WebSocket: class { addEventListener(){} removeEventListener(){} send(){} close(){} } });
		const sent = [];
		useRemoteLog({
			send: (p) => { sent.push(p); return Promise.resolve({ kind: 'success' }); },
			uiId: 'E_____________________',
			skipSigBridge: true,
		});
		sigConn.__emit('log', 'sig.skipped');
		await vi.advanceTimersByTimeAsync(DEBOUNCE + 1);
		expect(sent).toHaveLength(0);
	});
});

describe('RemoteLog 构造保护', () => {
	test('未提供 send 时抛错', () => {
		expect(() => new RemoteLog({})).toThrow(/send is required/);
	});
});

describe('httpSender Retry-After 边界', () => {
	test('Retry-After 是 garbage → retryable 无 retryAfter', async () => {
		const http = { post: () => Promise.reject({ response: { status: 429, headers: { 'retry-after': 'not-a-date' } } }) };
		const r = await httpSender(http, { uiId: 'x', seq: 1, logs: [] });
		expect(r.kind).toBe('retryable');
		expect(r.retryAfter).toBeUndefined();
	});

	test('Retry-After 为负秒数 → 仍 retryable，retryAfter 不为 NaN', async () => {
		const http = { post: () => Promise.reject({ response: { status: 429, headers: { 'retry-after': '-5' } } }) };
		const r = await httpSender(http, { uiId: 'x', seq: 1, logs: [] });
		expect(r.kind).toBe('retryable');
		if (r.retryAfter !== undefined) {
			expect(Number.isFinite(r.retryAfter)).toBe(true);
		}
	});
});
