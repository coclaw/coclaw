/**
 * S3 集成验证脚本：UI 远程日志 HTTP 通道（场景 ① + ②）
 *
 * 任务文档：docs/tasks/ui-remote-log-http-channel.md
 * 设计文档：docs/designs/ui-remote-log-http-channel.md §3 / §4 / §5.1
 *
 * 验证范围：
 *   ① server 重启窗口：UI in-flight batch 重传产生的重复打印 ≤ 1 batch
 *   ② 弱网注入：5xx 下重试退避 + 顺序恢复符合 §3.3 / §3.4
 *
 * 场景 ③（跨 login/logout）见 ui/e2e/remote-log-cross-auth.e2e.spec.js
 *
 * 执行：
 *   cd server && node scripts/verify-log-ui-integration.mjs
 *
 * 设计意图：
 *   - 用真实 server log-ui 路由（in-process express）：覆盖 attachLogUiBodyParser、
 *     handlePostLogUi、acceptBatch / fmtRemoteLogTs 整条链路
 *   - 客户端用最小协议适配（与 ui/src/services/remote-log.js 的 RemoteLog 算法一致），
 *     原因：ui 端模块依赖 import.meta.env / window 等浏览器全局，
 *     node 直接 import 会失败；RemoteLog 自身已在 ui 单测中充分覆盖
 *   - 场景 ② 使用 enqueue + drain 模式：两批 batch 同时入队，验证 §3.3 "in-flight
 *     batch 退避期间，新 batch 排队等待"的真实路径——而非靠 await 串行化得到
 *     trivially-true 的"顺序"
 *   - 资源管理：每个场景在 try/finally 中归位 console.info / 关闭 server，
 *     防止断言失败时污染后续场景
 */

import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import axios from 'axios';
import express from 'express';

import { attachLogUiBodyParser, logUiRouter } from '../src/routes/log-ui.route.js';
import {
	__resetUiLogState,
	stopUiLogCleanupTimer,
} from '../src/services/log-ui.svc.js';

const VALID_UI_ID = 'V1StGXR8_Z5jdHi6B-myT'; // 21-char nanoid 样例
const BATCH_RE = /\[batch=([A-Za-z0-9_-]{8}):(\d+)\]/;

/** 收集 console.info 输出（与 server 真实 stdout 行为一致）。*/
function captureConsoleInfo() {
	const lines = [];
	const orig = console.info;
	console.info = (...args) => {
		lines.push(args.map(String).join(' '));
	};
	return {
		lines,
		restore: () => { console.info = orig; },
	};
}

/**
 * 创建 in-process express app：
 *   - 真实 log-ui 路由
 *   - 可选 identity 中间件（模拟有/无 session）
 *   - 可选 adversary 中间件（前 N 次返 503 模拟弱网）
 */
function makeApp({ identity, failuresLeft = 0 } = {}) {
	const state = { failuresLeft };
	const app = express();
	attachLogUiBodyParser(app);
	app.use('/api/v1/log/ui', (req, _res, next) => {
		if (identity) {
			req.user = { id: identity };
			req.isAuthenticated = () => true;
		}
		else {
			req.user = null;
			req.isAuthenticated = () => false;
		}
		next();
	});
	if (failuresLeft > 0) {
		app.use('/api/v1/log/ui', (_req, res, next) => {
			if (state.failuresLeft > 0) {
				state.failuresLeft -= 1;
				res.status(503).json({ code: 'WEAK_NET_INJECT' });
				return;
			}
			next();
		});
	}
	app.use('/api/v1/log', logUiRouter);
	return { app, state };
}

function listen(app) {
	return new Promise((resolve, reject) => {
		const server = app.listen(0, '127.0.0.1', () => resolve(server));
		// listen 路径上 EADDRINUSE 等错误以 error 事件抛出；不处理会让 Promise 永挂
		server.once('error', reject);
	});
}

function close(server) {
	return new Promise((resolve) => server.close(resolve));
}

/** 统计每个 seq 出现次数（按 `[batch=...:N]` 短前缀解析）。*/
function countBySeq(lines) {
	const counts = new Map();
	for (const l of lines) {
		const m = l.match(BATCH_RE);
		if (!m) continue;
		const seq = Number(m[2]);
		counts.set(seq, (counts.get(seq) || 0) + 1);
	}
	return counts;
}

// --- 场景 ① ---

/**
 * 场景 ①：server 重启窗口下重传重复 ≤ 1 batch
 *
 * 时序：
 *   - Epoch1: UI 顺序送 seq=1, seq=2
 *   - server 重启（in-memory map 清空 = process restart 后的等价状态）
 *   - Epoch2: UI 因 seq=2 ack 未抵达发起重传 → 新 server lastSeq=0 → 接受 → 1 batch 重复
 *           : UI 继续 seq=3, seq=4
 *
 * 期望：
 *   - seq=1 打印 1 次
 *   - seq=2 打印 2 次（恰好 1 batch 重复，对应设计 §5.1）
 *   - seq=3, 4 各 1 次
 */
async function scenario1() {
	__resetUiLogState();
	stopUiLogCleanupTimer();
	const cap = captureConsoleInfo();
	let server1 = null;
	let server2 = null;
	try {
		const { app: app1 } = makeApp({ identity: null });
		server1 = await listen(app1);
		const port1 = server1.address().port;
		const http1 = axios.create({ baseURL: `http://127.0.0.1:${port1}` });

		// Epoch1
		for (const seq of [1, 2]) {
			const res = await http1.post('/api/v1/log/ui', {
				uiId: VALID_UI_ID,
				seq,
				logs: [{ ts: Date.now(), text: `epoch1.evt${seq}` }],
			});
			assert.equal(res.status, 200);
		}
		await close(server1);
		server1 = null;

		// "server 重启" 模拟：清空内存 dedup map（对应 server process restart）
		__resetUiLogState();

		const { app: app2 } = makeApp({ identity: null });
		server2 = await listen(app2);
		const http2 = axios.create({ baseURL: `http://127.0.0.1:${server2.address().port}` });

		// UI 重传 seq=2（in-flight batch 的副本到达新 server）
		let res = await http2.post('/api/v1/log/ui', {
			uiId: VALID_UI_ID,
			seq: 2,
			logs: [{ ts: Date.now(), text: 'epoch1.evt2' }],
		});
		assert.equal(res.status, 200);
		// UI 续发 seq=3, 4
		for (const seq of [3, 4]) {
			res = await http2.post('/api/v1/log/ui', {
				uiId: VALID_UI_ID,
				seq,
				logs: [{ ts: Date.now(), text: `epoch2.evt${seq}` }],
			});
			assert.equal(res.status, 200);
		}
		await close(server2);
		server2 = null;

		const counts = countBySeq(cap.lines);
		assert.equal(counts.get(1), 1, `seq=1 expected 1 print, got ${counts.get(1)}`);
		assert.equal(counts.get(2), 2, `seq=2 expected 2 prints (1-batch dup), got ${counts.get(2)}`);
		assert.equal(counts.get(3), 1, `seq=3 expected 1 print, got ${counts.get(3)}`);
		assert.equal(counts.get(4), 1, `seq=4 expected 1 print, got ${counts.get(4)}`);

		const dupSeqs = [...counts.entries()].filter(([, c]) => c > 1);
		assert.equal(dupSeqs.length, 1, `expected exactly 1 duplicated batch across restart, got ${dupSeqs.length}`);

		return {
			ok: true,
			counts: Object.fromEntries(counts),
			sampleLines: cap.lines.filter((l) => BATCH_RE.test(l)),
		};
	}
	finally {
		cap.restore();
		if (server1) await close(server1).catch(() => {});
		if (server2) await close(server2).catch(() => {});
	}
}

// --- 场景 ② ---

/**
 * 最小客户端：与 ui RemoteLog 顺序发送 + 退避算法一致
 *   - 同时 1 batch in-flight
 *   - 5xx / 网络错误 → 指数退避 1s,2s,4s,8s,16s,...,60s + 抖动
 *   - 4xx (非 408/429) → 整批丢弃
 *   - 408/429 → 重试（场景 ② 仅注 503，不在此实现 Retry-After 解析；
 *     算法与 ui/src/services/remote-log.js 同源，由 ui 单测覆盖该分支）
 *   - 单 batch 上限 8 次 / 10 分钟
 *
 * API：
 *   - `enqueue(batch)` 同步把 batch 推入 pending；首次 enqueue 启动 pump 循环
 *   - `drain()` 等待 pump 完成；多次 enqueue 共用同一 pumpPromise
 *   这是验证 §3.3 "in-flight 退避期间新 batch 排队"必需的：若改成 send+await 的串行
 *   形式，b2 在 b1 完全结束后才入队，"in-flight 排队"路径根本不会被触达。
 */
function createMinimalClient(http) {
	const sendTimes = []; // { at, seq } 用于断言退避时序
	let inFlight = null;
	let pumpPromise = null;
	/** @type {{uiId:string, seq:number, logs:{ts:number,text:string}[], attempts?:number, firstAttemptAt?:number}[]} */
	const pending = [];

	function backoff(attempt) {
		// 与 ui BACKOFF_BASE_MS=1000, CAP=60_000 对齐
		const base = Math.min(1000 * 2 ** (attempt - 1), 60_000);
		const jitter = base * 0.2 * Math.random();
		return Math.floor(base + jitter);
	}

	async function sendOnce(batch) {
		sendTimes.push({ at: Date.now(), seq: batch.seq });
		try {
			await http.post('/api/v1/log/ui', {
				uiId: batch.uiId,
				seq: batch.seq,
				logs: batch.logs,
			});
			return { kind: 'success' };
		}
		catch (err) {
			const status = err?.response?.status;
			if (status === 408 || status === 429) return { kind: 'retryable' };
			if (typeof status === 'number' && status >= 500) return { kind: 'retryable' };
			if (typeof status === 'number' && status >= 400) return { kind: 'badRequest' };
			return { kind: 'network', error: err };
		}
	}

	async function pumpLoop() {
		try {
			while (pending.length > 0) {
				const batch = pending.shift();
				inFlight = batch;
				batch.attempts = 0;
				batch.firstAttemptAt = 0;
				while (inFlight) {
					batch.attempts += 1;
					if (!batch.firstAttemptAt) batch.firstAttemptAt = Date.now();
					const res = await sendOnce(batch);
					if (res.kind === 'success' || res.kind === 'badRequest') {
						inFlight = null;
						break;
					}
					const elapsed = Date.now() - batch.firstAttemptAt;
					if (batch.attempts >= 8 || elapsed >= 10 * 60 * 1000) {
						inFlight = null;
						break;
					}
					await sleep(backoff(batch.attempts));
				}
			}
		}
		finally {
			pumpPromise = null;
		}
	}

	return {
		enqueue(batch) {
			pending.push(batch);
			if (!pumpPromise) pumpPromise = pumpLoop();
		},
		drain() {
			return pumpPromise || Promise.resolve();
		},
		sendTimes,
	};
}

/**
 * 场景 ②：弱网 5xx 注入下的重试退避 + 真实"in-flight 排队"顺序恢复
 *
 * - 服务端前 2 次返 503，第 3 次开始正常
 * - 客户端**同时入队** seq=1 + seq=2（不串行 await）
 * - 期望：
 *   - seq=1 经 2 次失败 + 1 次成功 = 3 次发送；间隔 ~1s, ~2s
 *   - seq=2 在 seq=1 的最后一次（成功）尝试**之后**才首次发出 —— 这是设计 §3.3
 *     "single in-flight batch" 的真实路径，由排队/pump 顺序而非测试 await 串行化保证
 *   - 服务端打印 seq=1 一次、seq=2 一次（无重复）
 */
async function scenario2() {
	__resetUiLogState();
	stopUiLogCleanupTimer();
	const cap = captureConsoleInfo();
	let server = null;
	try {
		const FAILS = 2;
		const { app, state } = makeApp({ identity: 'tester-123', failuresLeft: FAILS });
		server = await listen(app);
		const http = axios.create({ baseURL: `http://127.0.0.1:${server.address().port}` });

		const client = createMinimalClient(http);

		// 关键：两批 batch **同时** 入队；pump 启动后 seq=1 进入 in-flight，
		// seq=2 留在 pending 等 seq=1 完成。这才是 §3.3 真实测试路径。
		client.enqueue({
			uiId: VALID_UI_ID,
			seq: 1,
			logs: [{ ts: Date.now(), text: 'weaknet.evt1' }],
		});
		client.enqueue({
			uiId: VALID_UI_ID,
			seq: 2,
			logs: [{ ts: Date.now(), text: 'weaknet.evt2' }],
		});
		await client.drain();

		await close(server);
		server = null;

		// adversary 应已耗尽（FAILS 次 503 后清零；客户端尝试 FAILS+1 次成功送达 seq=1）
		assert.equal(state.failuresLeft, 0, `expected adversary exhausted, got ${state.failuresLeft}`);

		const sendTimes = client.sendTimes;
		const seq1Attempts = sendTimes.filter((s) => s.seq === 1);
		const seq2Attempts = sendTimes.filter((s) => s.seq === 2);
		assert.equal(seq1Attempts.length, FAILS + 1, `seq=1 expected ${FAILS + 1} attempts, got ${seq1Attempts.length}`);
		assert.equal(seq2Attempts.length, 1, `seq=2 expected 1 attempt, got ${seq2Attempts.length}`);

		// 顺序：seq=1 的最后一次尝试 < seq=2 的首次尝试（pump-级别 in-flight 排队保证）
		const lastSeq1At = seq1Attempts[seq1Attempts.length - 1].at;
		const firstSeq2At = seq2Attempts[0].at;
		assert.ok(
			firstSeq2At >= lastSeq1At,
			`seq=2 first attempt ${firstSeq2At} should be >= seq=1 last attempt ${lastSeq1At}`,
		);

		// 退避时序：1st gap ~1000ms, 2nd gap ~2000ms（容许 ±50% 抖动 + 调度漂移）
		const gaps = [];
		for (let i = 1; i < seq1Attempts.length; i++) {
			gaps.push(seq1Attempts[i].at - seq1Attempts[i - 1].at);
		}
		assert.ok(gaps[0] >= 800 && gaps[0] <= 2500, `1st retry gap ${gaps[0]}ms not in [800,2500]`);
		assert.ok(gaps[1] >= 1700 && gaps[1] <= 4000, `2nd retry gap ${gaps[1]}ms not in [1700,4000]`);

		// 服务端打印：seq=1 一次、seq=2 一次（503 不打印；成功才打印）
		const counts = countBySeq(cap.lines);
		assert.equal(counts.get(1), 1, `seq=1 expected 1 print after backoff, got ${counts.get(1)}`);
		assert.equal(counts.get(2), 1, `seq=2 expected 1 print, got ${counts.get(2)}`);

		// 身份段：所有打印应携带 [user:tester-123]
		for (const l of cap.lines.filter((x) => BATCH_RE.test(x))) {
			assert.match(l, /\[user:tester-123\]/, `line missing user identity tag: ${l}`);
		}

		return {
			ok: true,
			retryGaps: gaps,
			sendCount: { seq1: seq1Attempts.length, seq2: seq2Attempts.length },
			interleavingOk: firstSeq2At >= lastSeq1At,
			sampleLines: cap.lines.filter((l) => BATCH_RE.test(l)),
		};
	}
	finally {
		cap.restore();
		if (server) await close(server).catch(() => {});
	}
}

// --- 主入口 ---

async function main() {
	const results = [];
	let allOk = true;

	for (const [name, fn] of [['scenario1', scenario1], ['scenario2', scenario2]]) {
		const t0 = Date.now();
		try {
			const r = await fn();
			const elapsed = Date.now() - t0;
			console.log(`\n=== ${name} PASS (${elapsed}ms) ===`);
			console.log(JSON.stringify(r, null, 2));
			results.push({ name, ok: true, elapsedMs: elapsed, ...r });
		}
		catch (err) {
			const elapsed = Date.now() - t0;
			allOk = false;
			console.error(`\n=== ${name} FAIL (${elapsed}ms) ===`);
			console.error(err?.stack || err);
			results.push({ name, ok: false, elapsedMs: elapsed, error: String(err?.message || err) });
		}
	}

	stopUiLogCleanupTimer();
	console.log('\n=== SUMMARY ===');
	for (const r of results) {
		console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.elapsedMs}ms`);
	}
	process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
	console.error('verify-log-ui-integration: unhandled error', err);
	process.exit(2);
});
