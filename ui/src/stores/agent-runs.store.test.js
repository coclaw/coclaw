// @vitest-environment node
import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// agent-runs.store 用 remoteLog 上报 rpc-grace 期满的诊断信号，测试中屏蔽网络路径仅捕获调用
const remoteLogCalls = [];
vi.mock('../services/remote-log.js', () => ({
	remoteLog: (text) => { remoteLogCalls.push(text); },
}));

import { useAgentRunsStore, POST_ACCEPT_TIMEOUT_MS, RPC_GRACE_MS, IDLE_THRESHOLD_MS } from './agent-runs.store.js';

// --- Helper ---

function mockConn(overrides = {}) {
	return {
		state: 'connected',
		// 抛错以暴露用例未列举的隐性 RPC（默认 mockConn 的 register-only 用例不应触发任何 conn.request）
		request: vi.fn((method) => {
			throw new Error(`mockConn: unexpected RPC method "${method}"`);
		}),
		...overrides,
	};
}

/**
 * 关闭 run 的 24h post-acceptance memory timer。
 * IDLE_THRESHOLD_MS 当前等于 POST_ACCEPT_TIMEOUT_MS（24h 实质禁用 idle 探测），
 * watcher 类测试推进 IDLE_THRESHOLD_MS 触发 __pollOnce 时会同时撞上 memory timer，
 * memory timer 先注册先 fire 会把 idleTimer 提前清掉导致 wait(0) 不触发。
 * watcher 用例的关注点是 idle 探测语义，不应被异常兜底干扰，统一在 fireAccepted 后调用。
 */
function relaxMemoryTimer(store, runId = 'run-1') {
	const run = store.runs[runId];
	if (run?.__timer) {
		clearTimeout(run.__timer);
		run.__timer = null;
	}
}

function registerRun(store, overrides = {}) {
	const conn = overrides.conn ?? mockConn();
	store.register(overrides.runId ?? 'run-1', {
		clawId: overrides.clawId ?? '1',
		runKey: overrides.runKey ?? '1::agent:main:main',
		topicMode: overrides.topicMode ?? false,
		conn,
		streamingMsgs: overrides.streamingMsgs ?? [
			{ id: '__local_user_1', _local: true, message: { role: 'user', content: 'hi' } },
			{ id: '__local_claw_1', _local: true, _streaming: true, _startTime: 1000, message: { role: 'assistant', content: '', stopReason: null } },
		],
		anchorMsgId: overrides.anchorMsgId ?? undefined,
	});
	return conn;
}

/**
 * 构造支持两阶段 RPC 的 conn mock：
 *   - request('agent', ...) 返回受控 promise；onAccepted 在测试触发时调用
 *   - request('agent.wait', ...) 返回受控 promise
 * 测试通过返回的 ctrl 操控时机
 */
function mockTwoPhaseConn() {
	const ctrl = {
		acceptedPayload: null,
		finalResolve: null,
		finalReject: null,
		waitResolve: null,
		waitReject: null,
		waitCalls: 0,
		onAcceptedCb: null,
	};
	const conn = {
		state: 'connected',
		request: vi.fn((method, params, opts) => {
			if (method === 'agent') {
				if (opts?.onAccepted) ctrl.onAcceptedCb = opts.onAccepted;
				return new Promise((resolve, reject) => {
					ctrl.finalResolve = resolve;
					ctrl.finalReject = reject;
				});
			}
			if (method === 'agent.wait') {
				ctrl.waitCalls += 1;
				return new Promise((resolve, reject) => {
					ctrl.waitResolve = resolve;
					ctrl.waitReject = reject;
				});
			}
			// 抛错以暴露用例未列举的隐性 RPC（runAgent 路径只调 agent + agent.wait）
			throw new Error(`mockTwoPhaseConn: unexpected RPC method "${method}"`);
		}),
	};
	ctrl.conn = conn;
	ctrl.fireAccepted = (payload = { runId: 'run-1', status: 'accepted' }) => {
		ctrl.acceptedPayload = payload;
		ctrl.onAcceptedCb?.(payload);
	};
	return ctrl;
}

// --- Tests ---

describe('useAgentRunsStore', () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		vi.useFakeTimers();
		remoteLogCalls.length = 0;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// =====================================================================
	// register
	// =====================================================================

	describe('register', () => {
		test('注册 run 并建立索引', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			expect(store.runs['run-1']).toBeTruthy();
			expect(store.runs['run-1'].ended).toBe(false);
			expect(store.runs['run-1'].cancelled).toBe(false);
			expect(store.runKeyIndex['1::agent:main:main']).toBe('run-1');
		});

		test('同一 runKey 重复注册时清理旧 run', () => {
			const store = useAgentRunsStore();
			registerRun(store, { runId: 'run-1', runKey: '1::agent:main:main' });
			registerRun(store, { runId: 'run-2', runKey: '1::agent:main:main' });

			expect(store.runs['run-1']).toBeUndefined();
			expect(store.runs['run-2']).toBeTruthy();
			expect(store.runKeyIndex['1::agent:main:main']).toBe('run-2');
		});

		test('同一 runKey 重复注册时旧 runAgent 的 finalPromise 被唤起（endReason="superseded"）', async () => {
			const store = useAgentRunsStore();
			const ctrl1 = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl1.conn, clawId: '1', runKey: 'k-same', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl1.fireAccepted({ runId: 'run-old' });
			expect(store.runs['run-old'].ended).toBe(false);

			// 用户发新消息：同 runKey 注册新 run
			registerRun(store, { runId: 'run-new', runKey: 'k-same', clawId: '1' });

			const result = await runPromise;
			expect(result).toEqual({ runId: 'run-old', accepted: true, endReason: 'superseded', errorMessage: null });
			expect(store.runs['run-old']).toBeUndefined();
			expect(store.runs['run-new']).toBeTruthy();
		});

		test('注册时存储 anchorMsgId', () => {
			const store = useAgentRunsStore();
			registerRun(store, { anchorMsgId: 'msg-42' });

			expect(store.runs['run-1'].anchorMsgId).toBe('msg-42');
		});

		test('anchorMsgId 默认为 null', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			expect(store.runs['run-1'].anchorMsgId).toBeNull();
		});

		test('注册后 watcher 已就位且 idleTimer 已 arm', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			const run = store.runs['run-1'];
			expect(run.__watcher).toBeTruthy();
			expect(run.__watcher.idleTimer).toBeTruthy();
		});

		test('不再自行注册 event:agent 监听器（由 clawsStore 集中桥接）', () => {
			const store = useAgentRunsStore();
			const conn = mockConn({ on: vi.fn(), off: vi.fn() });
			registerRun(store, { conn });

			expect(conn.on).not.toHaveBeenCalled();
		});

		test('注册时打 agent.run.registered 诊断信号（含 runId/runKey/clawId）', () => {
			const store = useAgentRunsStore();
			registerRun(store, { runId: 'run-X', runKey: 'k-X', clawId: 'cl-X' });

			expect(remoteLogCalls.find((t) => t.startsWith('agent.run.registered'))).toBe(
				'agent.run.registered runId=run-X runKey=k-X clawId=cl-X',
			);
		});
	});

	// =====================================================================
	// runAgent — pre-acceptance 诊断信号
	// =====================================================================

	describe('runAgent pre-acceptance', () => {
		test('preAcceptError 分支打 agent.run.preaccept-failed（带 code/msg）', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();
			const promise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k-pre', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			// 不触发 onAccepted，直接 reject 主 RPC（模拟 DC 断 / RTC_LOST）
			const err = new Error('connection closed');
			err.code = 'DC_CLOSED';
			ctrl.finalReject(err);

			await expect(promise).rejects.toMatchObject({ code: 'DC_CLOSED' });
			expect(remoteLogCalls.find((t) => t.startsWith('agent.run.preaccept-failed'))).toBe(
				'agent.run.preaccept-failed runKey=k-pre code=DC_CLOSED msg=connection closed',
			);
		});

		test('norun 分支（RPC ok=true 但未 accepted）打 agent.run.norun', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();
			const promise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k-norun', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			// 直接 resolve 主 RPC，不触发 onAccepted —— 极罕见的 norun 路径
			ctrl.finalResolve({ status: 'ok' });

			const result = await promise;
			expect(result).toEqual({ runId: null, accepted: false, endReason: 'norun', errorMessage: null });
			expect(remoteLogCalls.find((t) => t.startsWith('agent.run.norun'))).toBe(
				'agent.run.norun runKey=k-norun',
			);
		});
	});

	// =====================================================================
	// getters
	// =====================================================================

	describe('getters', () => {
		test('getActiveRun 返回 entry（无论 ended/cancelled）', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			expect(store.getActiveRun('1::agent:main:main')?.runId).toBe('run-1');
		});

		test('getActiveRun 无匹配 runKey 时返回 null', () => {
			const store = useAgentRunsStore();
			expect(store.getActiveRun('nonexistent')).toBeNull();
		});

		test('isRunning 仅 ended 时返回 false（cancelled 不影响：cancel coordination tick 仍需继续）', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			expect(store.isRunning('1::agent:main:main')).toBe(true);

			// cancelled 不让 isRunning 变 false（让 cancel tick 能继续 abort 到 run 真终态）
			store.runs['run-1'].cancelled = true;
			expect(store.isRunning('1::agent:main:main')).toBe(true);

			store.runs['run-1'].ended = true;
			expect(store.isRunning('1::agent:main:main')).toBe(false);
		});

		test('isRunning 不存在时为 false', () => {
			const store = useAgentRunsStore();
			expect(store.isRunning('nonexistent')).toBe(false);
		});

		test('busy: 任意 entry 存在即为 true', () => {
			const store = useAgentRunsStore();
			expect(store.busy).toBe(false);
			registerRun(store);
			expect(store.busy).toBe(true);
		});
	});

	// =====================================================================
	// __dispatch（事件路由）
	// =====================================================================

	describe('__dispatch', () => {
		test('将 assistant 事件路由到正确的 run', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			store.__dispatch({ runId: 'run-1', stream: 'assistant', data: { text: 'hello' } });

			const run = store.runs['run-1'];
			const botEntry = run.streamingMsgs.find((m) => m._streaming && m.message.role === 'assistant');
			expect(Array.isArray(botEntry.message.content)).toBe(true);
			expect(botEntry.message.content.some((b) => b.type === 'text' && b.text === 'hello')).toBe(true);
		});

		test('非 lifecycle 事件 → 更新 lastEventAt 并重置 idleTimer', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			expect(store.runs['run-1'].lastEventAt).toBe(0);
			const t0 = store.runs['run-1'].__watcher.idleTimer;
			vi.advanceTimersByTime(10_000); // 推 10s
			store.__dispatch({ runId: 'run-1', stream: 'assistant', data: { text: 'hi' } });
			expect(store.runs['run-1'].lastEventAt).toBeGreaterThan(0);
			// idleTimer 已被重置为新句柄
			expect(store.runs['run-1'].__watcher.idleTimer).not.toBe(t0);
		});

		test('未知 runId 的事件被忽略', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			store.__dispatch({ runId: 'unknown-run', stream: 'assistant', data: { text: 'hello' } });
			expect(store.runs['run-1'].streamingMsgs).toHaveLength(2);
		});

		test('lifecycle:end → 不挂 grace、不 endRun，仅刷新 idleTimer（OpenClaw 一次 run 内会 emit 多次中间段）', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			const t0 = store.runs['run-1'].__watcher.idleTimer;

			vi.advanceTimersByTime(5_000);
			store.__dispatch({ runId: 'run-1', stream: 'lifecycle', data: { phase: 'end' } });

			const run = store.runs['run-1'];
			expect(run).toBeTruthy();
			expect(run.ended).toBe(false);
			expect(run.__pendingEnd).toBeNull();
			expect(run.lastEventAt).toBeGreaterThan(0);
			expect(run.__watcher.idleTimer).not.toBe(t0);
			expect(store.isRunning('1::agent:main:main')).toBe(true);
		});

		test('lifecycle:error → 同样不 endRun，仅刷新 idleTimer', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			store.__dispatch({ runId: 'run-1', stream: 'lifecycle', data: { phase: 'error' } });

			expect(store.runs['run-1'].ended).toBe(false);
			expect(store.runs['run-1'].__pendingEnd).toBeNull();
			expect(store.isRunning('1::agent:main:main')).toBe(true);
		});

		test('已 ended 的 run 后续事件被忽略（无更新、无重复 endRun）', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			// 用 settle('manual') 直接驱动 ended（绕过 watcher 路径）
			store.__endRun('run-1', 'manual');
			expect(store.runs['run-1'].ended).toBe(true);
			const lastEventAt = store.runs['run-1'].lastEventAt;

			store.__dispatch({ runId: 'run-1', stream: 'assistant', data: { text: 'late' } });

			expect(store.runs['run-1'].lastEventAt).toBe(lastEventAt);
		});

		// 用户报 bug 的核心回归：
		// "终止按钮已消逝 + 用户刷新还能看到任务继续执行步骤并最终完成"
		//
		// 真因：lifecycle:end 不可靠——OpenClaw 一次 run 内会 emit 多次（compaction-retry /
		// model-fallback / live-switch），payload 无字段可区分中间段 vs 真终态。旧实现把第一个
		// 当真终态导致提前 endRun、后续事件被 __dispatch 入口的 ended guard 丢弃。
		// 阶段 1 修复：lifecycle 不再驱动 endRun，仅当普通流量；终态信号靠 RPC 二阶段 res 收尾。
		test('BUG 回归屏障：lifecycle:end 后续事件仍被应用，run 保持 running，最终 RPC 收尾', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			const runKey = '1::agent:main:main';

			// 前置：plugin 已推过几个正常 streaming 事件
			store.__dispatch({ runId: 'run-1', stream: 'assistant', data: { text: '让我想想' } });
			expect(store.isRunning(runKey)).toBe(true);
			const lengthAfterStep0 = store.runs['run-1'].streamingMsgs.length;

			// step 1：上游 emit 第一个中间段 lifecycle:end（compaction-retry 等）
			store.__dispatch({ runId: 'run-1', stream: 'lifecycle', data: { phase: 'end' } });
			vi.advanceTimersByTime(RPC_GRACE_MS); // 即使过了 grace，仍然不 endRun

			// 关键：UI 端 run 仍 running，终止按钮还在
			expect(store.runs['run-1'].ended).toBe(false);
			expect(store.isRunning(runKey)).toBe(true);
			expect(store.runs['run-1'].__pendingEnd).toBeNull();

			// step 2：OpenClaw 继续推下一段——事件被正常应用而非丢弃
			store.__dispatch({ runId: 'run-1', stream: 'assistant', data: { text: '继续推一段' } });
			store.__dispatch({ runId: 'run-1', stream: 'tool', data: { phase: 'start', name: 'check' } });
			store.__dispatch({ runId: 'run-1', stream: 'tool', data: { phase: 'result', result: '成功' } });

			// 硬断言"后续事件被处理"：tool start 写入了 toolCall block，tool result 插入了 toolResult + 新 assistant 占位
			const msgs = store.runs['run-1'].streamingMsgs;
			expect(msgs.length).toBeGreaterThan(lengthAfterStep0);
			const toolResult = msgs.find((m) => m._local && m.message?.role === 'toolResult');
			expect(toolResult).toBeTruthy();
			const allToolCalls = msgs.flatMap((m) => Array.isArray(m.message?.content) ? m.message.content : [])
				.filter((b) => b.type === 'toolCall' && b.name === 'check');
			expect(allToolCalls.length).toBeGreaterThan(0);
			expect(store.isRunning(runKey)).toBe(true);
		});
	});

	// =====================================================================
	// settle（外部 API：手动 settle，立即 cleanup）
	// =====================================================================

	describe('settle', () => {
		test('手动 settle 清理 run', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			store.settle('1::agent:main:main');

			expect(store.runs['run-1']).toBeUndefined();
			expect(store.runKeyIndex['1::agent:main:main']).toBeUndefined();
			expect(store.isRunning('1::agent:main:main')).toBe(false);
		});

		test('settle 不存在的 runKey 不报错', () => {
			const store = useAgentRunsStore();
			store.settle('nonexistent');
		});
	});

	// =====================================================================
	// settleWithTransitionByKey (cancelSend 阶段 1)
	// =====================================================================

	describe('settleWithTransitionByKey', () => {
		test('标记 cancelled=true，watcher 仍跑，streamingMsgs 保留', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			store.settleWithTransitionByKey('1::agent:main:main');

			const run = store.runs['run-1'];
			expect(run).toBeTruthy();
			expect(run.cancelled).toBe(true);
			expect(run.ended).toBe(false);
			expect(run.streamingMsgs.length).toBe(2);
			// 24h 兜底 timer 保留
			expect(run.__timer).toBeTruthy();
		});

		test('cancelled 后 isRunning 仍 true（让 cancel tick 继续 abort 直到真终态），getActiveRun 仍返回', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.settleWithTransitionByKey('1::agent:main:main');

			expect(store.isRunning('1::agent:main:main')).toBe(true);
			expect(store.getActiveRun('1::agent:main:main')).toBeTruthy();
		});

		test('cancel 后 lifecycle:end → 仍不 endRun（与 cancelled 无关；终态等 rpc/wait/failed）', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.settleWithTransitionByKey('1::agent:main:main');

			store.__dispatch({ runId: 'run-1', stream: 'lifecycle', data: { phase: 'end' } });
			vi.advanceTimersByTime(RPC_GRACE_MS);

			const run = store.runs['run-1'];
			expect(run.cancelled).toBe(true);
			expect(run.ended).toBe(false);
			expect(run.__pendingEnd).toBeNull();
		});

		test('cancel 后服务端仍推送 content 事件 → streamingMsgs 继续更新', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.settleWithTransitionByKey('1::agent:main:main');

			store.__dispatch({ runId: 'run-1', stream: 'assistant', data: { text: 'after-cancel-content' } });

			const run = store.runs['run-1'];
			expect(run).toBeTruthy();
			expect(run.cancelled).toBe(true);
			expect(run.lastEventAt).toBeGreaterThan(0);
		});

		test('不存在 / 已 ended / 已 cancelled 时 no-op', () => {
			const store = useAgentRunsStore();

			store.settleWithTransitionByKey('missing');

			registerRun(store, { runId: 'run-a', runKey: 'k-a' });
			store.settle('k-a');
			store.settleWithTransitionByKey('k-a');

			registerRun(store, { runId: 'run-b', runKey: 'k-b' });
			store.settleWithTransitionByKey('k-b');
			store.settleWithTransitionByKey('k-b'); // 第二次 no-op
			expect(store.runs['run-b'].cancelled).toBe(true);
		});
	});

	// =====================================================================
	// settleByCancel（cancel 协调启发终态主动收尾，不清 runKeyIndex）
	// =====================================================================

	describe('settleByCancel', () => {
		test('cancel-gone 走 __endRun + 保留 entry（runKeyIndex 不清，等 dropRun 释放）', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			store.settleByCancel('1::agent:main:main', 'cancel-gone');

			const run = store.runs['run-1'];
			expect(run).toBeTruthy();
			// ended 已置；entry 仍在内存里，runKeyIndex 仍指向同一 runId
			expect(run.ended).toBe(true);
			expect(store.runKeyIndex['1::agent:main:main']).toBe('run-1');
			// __endRun 已停 idleTimer + post-accept timer
			expect(run.__watcher?.idleTimer).toBeNull();
			expect(run.__timer).toBeNull();
			// agent.run.end 上报 reason=cancel-gone
			expect(remoteLogCalls).toContain('agent.run.end runId=run-1 reason=cancel-gone');
		});

		test('cancel-not-supported 走 __endRun，agent.run.end 上报 reason=cancel-not-supported', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			store.settleByCancel('1::agent:main:main', 'cancel-not-supported');

			expect(store.runs['run-1'].ended).toBe(true);
			expect(remoteLogCalls).toContain('agent.run.end runId=run-1 reason=cancel-not-supported');
		});

		test('runKey 不存在时 no-op（不抛错、不上报）', () => {
			const store = useAgentRunsStore();
			expect(() => store.settleByCancel('nonexistent', 'cancel-gone')).not.toThrow();
			expect(remoteLogCalls.find((t) => t.startsWith('agent.run.end'))).toBeFalsy();
		});

		test('已 ended 时 no-op（避免重复 endRun + 重复 remoteLog）', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.__endRun('run-1', 'rpc');
			const before = remoteLogCalls.filter((t) => t.startsWith('agent.run.end')).length;

			store.settleByCancel('1::agent:main:main', 'cancel-gone');

			const after = remoteLogCalls.filter((t) => t.startsWith('agent.run.end')).length;
			expect(after).toBe(before);
		});

		test('settleByCancel 后调 dropRun(runKey, runId) 仍能正确释放（runKeyIndex 没被破坏）', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			store.settleByCancel('1::agent:main:main', 'cancel-gone');
			expect(store.runs['run-1']).toBeTruthy();

			// 关键：__cleanupRun 没有提前清 runKeyIndex，dropRun 的 runId 校验通过 → 真正释放
			store.dropRun('1::agent:main:main', 'run-1');

			expect(store.runs['run-1']).toBeUndefined();
			expect(store.runKeyIndex['1::agent:main:main']).toBeUndefined();
		});
	});

	// =====================================================================
	// stripLocalUserMsgs
	// =====================================================================

	describe('stripLocalUserMsgs', () => {
		test('无锚点 + server 有 user 消息 → strip', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.runs['run-1'].streamingMsgs = [
				{ id: 'u1', _local: true, message: { role: 'user', content: 'hi' } },
				{ id: 'b1', _local: true, _streaming: true, message: { role: 'assistant', content: '' } },
			];
			const serverMsgs = [
				{ id: 's1', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
			];

			store.stripLocalUserMsgs('1::agent:main:main', serverMsgs);

			expect(store.runs['run-1'].streamingMsgs).toHaveLength(1);
			expect(store.runs['run-1'].streamingMsgs[0].id).toBe('b1');
		});

		test('无锚点 + server 无 user 消息 → 保留', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.runs['run-1'].streamingMsgs = [
				{ id: 'u1', _local: true, message: { role: 'user', content: 'hi' } },
				{ id: 'b1', _local: true, _streaming: true, message: { role: 'assistant', content: '' } },
			];

			store.stripLocalUserMsgs('1::agent:main:main', []);

			expect(store.runs['run-1'].streamingMsgs).toHaveLength(2);
		});

		test('有锚点 + 锚点后有 user 消息 → strip', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.runs['run-1'].anchorMsgId = 'anchor-1';
			store.runs['run-1'].streamingMsgs = [
				{ id: 'u1', _local: true, message: { role: 'user', content: 'hi' } },
				{ id: 'b1', _local: true, _streaming: true, message: { role: 'assistant', content: '' } },
			];
			const serverMsgs = [
				{ id: 'old-1', message: { role: 'user', content: '旧消息' } },
				{ id: 'anchor-1', message: { role: 'assistant', content: '旧回复' } },
				{ id: 'new-1', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
			];

			store.stripLocalUserMsgs('1::agent:main:main', serverMsgs);

			expect(store.runs['run-1'].streamingMsgs).toHaveLength(1);
			expect(store.runs['run-1'].streamingMsgs[0].id).toBe('b1');
		});

		test('有锚点 + 锚点后无 user 消息 → 保留', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.runs['run-1'].anchorMsgId = 'anchor-1';
			store.runs['run-1'].streamingMsgs = [
				{ id: 'u1', _local: true, message: { role: 'user', content: 'hi' } },
				{ id: 'b1', _local: true, _streaming: true, message: { role: 'assistant', content: '' } },
			];
			const serverMsgs = [
				{ id: 'old-1', message: { role: 'user', content: '旧消息' } },
				{ id: 'anchor-1', message: { role: 'assistant', content: '旧回复' } },
			];

			store.stripLocalUserMsgs('1::agent:main:main', serverMsgs);

			expect(store.runs['run-1'].streamingMsgs).toHaveLength(2);
		});

		test('锚点被分页截断 → 视为已持久化 → strip', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.runs['run-1'].anchorMsgId = 'anchor-gone';
			store.runs['run-1'].streamingMsgs = [
				{ id: 'u1', _local: true, message: { role: 'user', content: 'hi' } },
				{ id: 'b1', _local: true, _streaming: true, message: { role: 'assistant', content: '' } },
			];
			const serverMsgs = [
				{ id: 'far-away', message: { role: 'assistant', content: '很后面的消息' } },
			];

			store.stripLocalUserMsgs('1::agent:main:main', serverMsgs);

			expect(store.runs['run-1'].streamingMsgs).toHaveLength(1);
			expect(store.runs['run-1'].streamingMsgs[0].id).toBe('b1');
			// 锚点找不到时不升级；allMessages 会 fallback 到末尾追加
			expect(store.runs['run-1'].anchorMsgId).toBe('anchor-gone');
		});

		test('strip 同时把 anchorMsgId 升级到 server 那条 user 消息', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.runs['run-1'].anchorMsgId = 'anchor-1';
			store.runs['run-1'].streamingMsgs = [
				{ id: 'u1', _local: true, message: { role: 'user', content: 'hi' } },
				{ id: 'b1', _local: true, _streaming: true, message: { role: 'assistant', content: '' } },
			];
			const serverMsgs = [
				{ id: 'old-1', message: { role: 'user', content: '旧消息' } },
				{ id: 'anchor-1', message: { role: 'assistant', content: '旧回复' } },
				{ id: 'new-user-1', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
				{ id: 'new-asst-1', message: { role: 'assistant', content: '思考中...' } },
			];

			store.stripLocalUserMsgs('1::agent:main:main', serverMsgs);

			expect(store.runs['run-1'].anchorMsgId).toBe('new-user-1');
		});

		test('多条 user 消息时 anchor 升到锚点后第一条', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.runs['run-1'].anchorMsgId = 'anchor-1';
			store.runs['run-1'].streamingMsgs = [
				{ id: 'u1', _local: true, message: { role: 'user', content: 'hi' } },
				{ id: 'b1', _local: true, _streaming: true, message: { role: 'assistant', content: '' } },
			];
			const serverMsgs = [
				{ id: 'anchor-1', message: { role: 'assistant', content: '旧回复' } },
				{ id: 'first-user', message: { role: 'user', content: '本次发送' } },
				{ id: 'mid-asst', message: { role: 'assistant', content: '思考中...' } },
				{ id: 'second-user', message: { role: 'user', content: '后续手动追加' } },
			];

			store.stripLocalUserMsgs('1::agent:main:main', serverMsgs);

			// 锚点应升到第一条匹配的 user，而非后续的 user
			expect(store.runs['run-1'].anchorMsgId).toBe('first-user');
		});

		test('无锚点 → strip 但 anchor 保持 null（让 allMessages 走末尾追加）', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.runs['run-1'].anchorMsgId = null;
			store.runs['run-1'].streamingMsgs = [
				{ id: 'u1', _local: true, message: { role: 'user', content: 'hi' } },
				{ id: 'b1', _local: true, _streaming: true, message: { role: 'assistant', content: '' } },
			];
			const serverMsgs = [
				{ id: 'first-user', message: { role: 'user', content: 'hi' } },
				{ id: 'first-asst', message: { role: 'assistant', content: '回复中...' } },
			];

			store.stripLocalUserMsgs('1::agent:main:main', serverMsgs);

			expect(store.runs['run-1'].streamingMsgs).toHaveLength(1);
			// 无锚点不能升级——既包含真正的"首条消息"，也可能是 activate 失败导致 messages=[]
			// 时遗留的状态（此时 server 第一条 user 是远古历史，升级会错位）。
			expect(store.runs['run-1'].anchorMsgId).toBeNull();
		});

		test('无锚点 + server 已有更老历史：strip 后 anchor 仍为 null，allMessages 末尾追加 → 当前轮 botTask isStreaming=true', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.runs['run-1'].anchorMsgId = null;
			store.runs['run-1'].streamingMsgs = [
				{ id: 'u1', _local: true, message: { role: 'user', content: '当前发送' } },
				{
					id: 'b1', _local: true, _streaming: true,
					message: { role: 'assistant', content: '', stopReason: null },
				},
			];
			// 模拟 activate 失败 + 用户发消息 + 刷新成功 拉到的完整 transcript
			const serverMsgs = [
				{ type: 'message', id: 'old-u-1', message: { role: 'user', content: '远古问题', timestamp: 1000 } },
				{
					type: 'message', id: 'old-a-1',
					timestamp: 2000,
					message: { role: 'assistant', content: [{ type: 'text', text: '远古回答' }], stopReason: 'end_turn', timestamp: 2000 },
				},
				{ type: 'message', id: 'curr-u', message: { role: 'user', content: '当前发送', timestamp: 8000 } },
				{
					type: 'message', id: 'curr-a-mid',
					timestamp: 12000,
					message: { role: 'assistant', content: [{ type: 'thinking', thinking: '思考中...' }], stopReason: null, timestamp: 12000 },
				},
			];

			store.stripLocalUserMsgs('1::agent:main:main', serverMsgs);

			// 关键不变量：anchor 保持 null，避免被错误升到 'old-u-1'
			expect(store.runs['run-1'].anchorMsgId).toBeNull();
			expect(store.runs['run-1'].streamingMsgs).toHaveLength(1);
			expect(store.runs['run-1'].streamingMsgs[0].id).toBe('b1');
		});

		test('同 run 期内重复调用幂等：第二次早返回，anchor 不再变动', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.runs['run-1'].anchorMsgId = 'anchor-1';
			store.runs['run-1'].streamingMsgs = [
				{ id: 'u1', _local: true, message: { role: 'user', content: 'hi' } },
				{ id: 'b1', _local: true, _streaming: true, message: { role: 'assistant', content: '' } },
			];
			const serverMsgs = [
				{ id: 'anchor-1', message: { role: 'assistant', content: '旧回复' } },
				{ id: 'new-user-1', message: { role: 'user', content: 'hi' } },
			];

			store.stripLocalUserMsgs('1::agent:main:main', serverMsgs);
			expect(store.runs['run-1'].anchorMsgId).toBe('new-user-1');
			expect(store.runs['run-1'].streamingMsgs).toHaveLength(1);

			// 第二次调用：streamingMsgs 已无 _local user → 早 return；anchor 与 streamingMsgs 都不变动
			// 即便有人后续在 server 末尾追加更多 user 消息也不应再次推进 anchor
			const refreshed = [
				...serverMsgs,
				{ id: 'asst-mid', message: { role: 'assistant', content: '思考中...' } },
				{ id: 'unrelated-user', message: { role: 'user', content: 'race-追加' } },
			];
			store.stripLocalUserMsgs('1::agent:main:main', refreshed);
			expect(store.runs['run-1'].anchorMsgId).toBe('new-user-1');
			expect(store.runs['run-1'].streamingMsgs).toHaveLength(1);
		});

		test('无 _local user 消息时 streamingMsgs 不变', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.runs['run-1'].streamingMsgs = [
				{ id: 'b1', _local: true, _streaming: true, message: { role: 'assistant', content: '' } },
			];

			store.stripLocalUserMsgs('1::agent:main:main', []);

			expect(store.runs['run-1'].streamingMsgs).toHaveLength(1);
		});

		test('ended run 不操作', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.runs['run-1'].ended = true;
			store.runs['run-1'].streamingMsgs = [
				{ id: 'u1', _local: true, message: { role: 'user', content: 'hi' } },
			];

			store.stripLocalUserMsgs('1::agent:main:main', [{ id: 's1', message: { role: 'user', content: 'hi' } }]);

			expect(store.runs['run-1'].streamingMsgs).toHaveLength(1);
		});

		test('不存在的 runKey 不报错', () => {
			const store = useAgentRunsStore();
			expect(() => store.stripLocalUserMsgs('nonexistent')).not.toThrow();
		});

		test('strip 时释放被移除 user 消息的 _attachments blob URL', () => {
			const origRevoke = URL.revokeObjectURL;
			URL.revokeObjectURL = vi.fn();
			const store = useAgentRunsStore();
			registerRun(store);
			store.runs['run-1'].streamingMsgs = [
				{
					id: 'u1', _local: true,
					message: { role: 'user', content: 'hi' },
					_attachments: [{ url: 'blob:img1' }, { url: null }, { url: 'blob:voice1' }],
				},
				{ id: 'b1', _local: true, _streaming: true, message: { role: 'assistant', content: '' } },
			];
			const serverMsgs = [{ id: 's1', message: { role: 'user', content: 'hi' } }];

			store.stripLocalUserMsgs('1::agent:main:main', serverMsgs);

			expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:img1');
			expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:voice1');
			expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
			URL.revokeObjectURL = origRevoke;
		});
	});

	// =====================================================================
	// __cleanupRun blob URL 释放
	// =====================================================================

	describe('__cleanupRun blob URL', () => {
		test('settle 时释放 streamingMsgs 中 _attachments 的 blob URL', () => {
			const origRevoke = URL.revokeObjectURL;
			URL.revokeObjectURL = vi.fn();
			const store = useAgentRunsStore();
			registerRun(store);
			store.runs['run-1'].streamingMsgs = [
				{
					id: 'u1', _local: true,
					message: { role: 'user', content: 'hi' },
					_attachments: [{ url: 'blob:att1' }, { url: 'blob:att2' }],
				},
				{ id: 'b1', _local: true, _streaming: true, message: { role: 'assistant', content: '' } },
			];

			store.settle('1::agent:main:main');

			expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:att1');
			expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:att2');
			expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
			URL.revokeObjectURL = origRevoke;
		});

		test('无 _attachments 的消息不报错', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.runs['run-1'].streamingMsgs = [
				{ id: 'b1', message: { role: 'assistant', content: '' } },
			];
			expect(() => store.settle('1::agent:main:main')).not.toThrow();
		});
	});

	// =====================================================================
	// post-acceptance 24h 兜底
	// =====================================================================

	describe('timeout', () => {
		test('post-acceptance 24h 后自动 endRun + cleanup', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			expect(store.isRunning('1::agent:main:main')).toBe(true);

			vi.advanceTimersByTime(POST_ACCEPT_TIMEOUT_MS);

			expect(store.isRunning('1::agent:main:main')).toBe(false);
			expect(store.runs['run-1']).toBeUndefined();
		});

		test('settle 清除超时定时器', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			store.settle('1::agent:main:main');

			vi.advanceTimersByTime(POST_ACCEPT_TIMEOUT_MS);
		});
	});

	// =====================================================================
	// removeByClaw
	// =====================================================================

	describe('removeByClaw', () => {
		test('清理指定 claw 的所有活跃 runs', () => {
			const store = useAgentRunsStore();
			registerRun(store, { runId: 'run-1', runKey: 'key1', clawId: '1' });
			registerRun(store, { runId: 'run-2', runKey: 'key2', clawId: '1' });
			registerRun(store, { runId: 'run-3', runKey: 'key3', clawId: '2' });

			store.removeByClaw('1');

			expect(store.runs['run-1']).toBeUndefined();
			expect(store.runs['run-2']).toBeUndefined();
			expect(store.runs['run-3']).toBeTruthy();
		});

		test('无活跃 runs 时不报错', () => {
			const store = useAgentRunsStore();
			store.removeByClaw('nonexistent');
		});

		test('未 ended run 被 removeByClaw 时唤起 finalPromise（endReason="claw-removed"）', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });
			expect(store.runs['run-1'].ended).toBe(false);

			store.removeByClaw('1');

			const result = await runPromise;
			expect(result).toEqual({ runId: 'run-1', accepted: true, endReason: 'claw-removed', errorMessage: null });
			expect(store.runs['run-1']).toBeUndefined();
		});
	});

	// =====================================================================
	// runAgent（两阶段 RPC + watcher 接入）
	// =====================================================================

	describe('runAgent', () => {
		test('信号 1：RPC 第二阶段 ok → endReason="rpc" + errorMessage=null', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn,
				clawId: '1',
				runKey: 'k1',
				topicMode: false,
				agentParams: { message: 'hi' },
				optimisticMsgs: [{ id: 'l1', _local: true, message: { role: 'user', content: 'hi' } }],
			});

			// 等 microtask 让 conn.request 投出
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1', status: 'accepted' });

			expect(store.runs['run-1']).toBeTruthy();
			expect(store.runs['run-1'].ended).toBe(false);

			// 第二阶段 res 到达
			ctrl.finalResolve({ status: 'ok' });

			const result = await runPromise;
			expect(result).toEqual({ runId: 'run-1', accepted: true, endReason: 'rpc', errorMessage: null });
			expect(store.runs['run-1'].ended).toBe(true);
		});

		test('信号 1：RPC 第二阶段 status="error" → endReason="failed" + errorMessage 取自 summary（业务级失败防御）', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });
			ctrl.finalResolve({ status: 'error', summary: 'FailoverError: model unavailable' });

			const result = await runPromise;
			expect(result.endReason).toBe('failed');
			expect(result.errorMessage).toBe('FailoverError: model unavailable');
		});

		test('信号 1：status="error" 但 summary 缺失 → errorMessage 回退到 error 字段', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });
			ctrl.finalResolve({ status: 'error', error: 'agent.wait error string' });

			const result = await runPromise;
			expect(result.errorMessage).toBe('agent.wait error string');
		});

		test('信号 1：RPC 第二阶段 status="timeout" + 未 cancelled → endReason="rpc-timeout" 携 errorMessage', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });
			ctrl.finalResolve({ status: 'timeout', summary: 'wait timed out' });

			const result = await runPromise;
			expect(result.endReason).toBe('rpc-timeout');
			expect(result.errorMessage).toBe('wait timed out');
		});

		test('信号 1：status="error" 且 summary 为 object（协议偏离）→ stringify 兜底', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });
			// 协议偏离：summary 是 object 而非 string
			ctrl.finalResolve({ status: 'error', summary: { code: 'X', message: 'oops' } });

			const result = await runPromise;
			expect(result.endReason).toBe('failed');
			// 不丢成 undefined：String(obj) → '[object Object]'
			expect(typeof result.errorMessage).toBe('string');
			expect(result.errorMessage).toBe('[object Object]');
		});

		test('信号 1：status="timeout" 但 run.cancelled=true（取消路径）→ endReason="rpc"，不弹错', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });
			// 模拟用户取消：标记 cancelled=true
			store.runs['run-1'].cancelled = true;
			ctrl.finalResolve({ status: 'timeout', summary: 'aborted' });

			const result = await runPromise;
			expect(result.endReason).toBe('rpc');
			expect(result.errorMessage).toBeNull();
		});

		test('信号 1：status="error" 但 run.cancelled=true（取消路径）→ endReason="rpc"，与 timeout 取消语义对称', async () => {
			// A3：用户取消时上游恰好回 status="error"（plugin 内部异常 + 取消 race），
			// 应与 status="timeout" 取消路径同样静默收尾，不报错误 toast
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });
			store.runs['run-1'].cancelled = true;
			ctrl.finalResolve({ status: 'error', summary: 'plugin internal error' });

			const result = await runPromise;
			expect(result.endReason).toBe('rpc');
			expect(result.errorMessage).toBeNull();
			expect(store.runs['run-1'].__endError).toBeNull();
		});

		test('pre-acceptance 错误（DC 断）→ runAgent reject，未 register', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			const err = new Error('rtc lost');
			err.code = 'RTC_LOST';
			ctrl.finalReject(err);

			await expect(runPromise).rejects.toThrow('rtc lost');
			expect(store.runs['run-1']).toBeUndefined();
		});

		test('信号 3：accepted 后 RPC reject → endReason="failed" + errorMessage 取自 err.message', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });

			const err = new Error('FailoverError: No API key found for provider "openai"');
			err.code = 'UNAVAILABLE';
			ctrl.finalReject(err);

			const result = await runPromise;
			expect(result).toEqual({
				runId: 'run-1',
				accepted: true,
				endReason: 'failed',
				errorMessage: 'FailoverError: No API key found for provider "openai"',
			});
			expect(store.runs['run-1'].ended).toBe(true);
		});

		test('信号 3：accepted 后 RPC reject + run.cancelled=true（取消路径）→ endReason="rpc"，不报失败', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });

			store.runs['run-1'].cancelled = true;
			const err = new Error('cancelled');
			err.code = 'CANCELLED';
			ctrl.finalReject(err);

			const result = await runPromise;
			expect(result.endReason).toBe('rpc');
			expect(result.errorMessage).toBeNull();
			expect(store.runs['run-1'].__endError).toBeNull();
		});

		test('onAccepted 钩子在 register 之后被调用', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();
			let runIdAtCallback = null;
			let runRegistered = false;

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
				onAccepted: (payload) => {
					runIdAtCallback = payload?.runId;
					runRegistered = !!store.runs[payload?.runId];
				},
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1', status: 'accepted' });

			expect(runIdAtCallback).toBe('run-1');
			expect(runRegistered).toBe(true);

			ctrl.finalResolve({ status: 'ok' });
			await runPromise;
		});
	});

	// =====================================================================
	// watcher（idle / pollOnce / agent.wait 各分支）
	// =====================================================================

	describe('watcher', () => {
		test('idle 阈值后用 agent.wait(timeoutMs=0) 即时探测', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });
			relaxMemoryTimer(store);

			expect(ctrl.waitCalls).toBe(0);
			vi.advanceTimersByTime(IDLE_THRESHOLD_MS);
			expect(ctrl.waitCalls).toBe(1);
			// 关键：服务端 timeoutMs=0 不订阅 lifecycle 流，避免被中间段污染
			const waitArgs = ctrl.conn.request.mock.calls.find((c) => c[0] === 'agent.wait')[1];
			expect(waitArgs.timeoutMs).toBe(0);

			ctrl.finalResolve({ status: 'ok' });
			await runPromise;
		});

		test('agent.wait 返回 ok（命中 dedupe / agent-job cache）→ 挂 grace；grace 满后 endReason="wait"', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });
			relaxMemoryTimer(store);
			vi.advanceTimersByTime(IDLE_THRESHOLD_MS);
			ctrl.waitResolve({ status: 'ok' });

			// grace 满后才 endRun('wait')
			await vi.advanceTimersByTimeAsync(RPC_GRACE_MS);
			const result = await runPromise;
			expect(result.endReason).toBe('wait');
		});

		test('agent.wait 返回 error → 同样挂 grace；grace 满后 endReason="wait"', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });
			relaxMemoryTimer(store);
			vi.advanceTimersByTime(IDLE_THRESHOLD_MS);
			ctrl.waitResolve({ status: 'error' });

			await vi.advanceTimersByTimeAsync(RPC_GRACE_MS);
			const result = await runPromise;
			expect(result.endReason).toBe('wait');
		});

		test('agent.wait timeout + endedAt → 挂 grace；grace 满后 endReason="wait"（abort/TTL 写入）', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });
			relaxMemoryTimer(store);
			vi.advanceTimersByTime(IDLE_THRESHOLD_MS);
			ctrl.waitResolve({ status: 'timeout', startedAt: 100, endedAt: 200 });

			await vi.advanceTimersByTimeAsync(RPC_GRACE_MS);
			const result = await runPromise;
			expect(result.endReason).toBe('wait');
		});

		test('agent.wait 返回未知 status（防御分支）→ 按结束处理挂 grace，避免死循环', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });
			relaxMemoryTimer(store);
			vi.advanceTimersByTime(IDLE_THRESHOLD_MS);

			ctrl.waitResolve({ status: 'mystery' }); // 无效协议响应
			await vi.advanceTimersByTimeAsync(RPC_GRACE_MS);
			const result = await runPromise;
			expect(result.endReason).toBe('wait');
		});

		test('agent.wait timeout 无 endedAt（run 仍活跃）→ 重 arm idleTimer，不递归（tight loop 防御）', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });
			relaxMemoryTimer(store);
			vi.advanceTimersByTime(IDLE_THRESHOLD_MS);
			expect(ctrl.waitCalls).toBe(1);

			ctrl.waitResolve({ status: 'timeout' });
			await Promise.resolve();
			await Promise.resolve();
			// 关键：wait(0) 即时返回，若递归调用就是 tight loop。必须等下一个 idle 周期
			expect(ctrl.waitCalls).toBe(1);
			expect(store.runs['run-1'].__watcher.idleTimer).toBeTruthy();

			// 推进下一个 idle 周期才看到第 2 次探测
			vi.advanceTimersByTime(IDLE_THRESHOLD_MS);
			expect(ctrl.waitCalls).toBe(2);

			ctrl.finalResolve({ status: 'ok' });
			await runPromise;
		});

		test('agent.wait reject → 重 arm idleTimer 等下一周期（不判死，等真权威信号）', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });
			relaxMemoryTimer(store);
			vi.advanceTimersByTime(IDLE_THRESHOLD_MS);
			expect(ctrl.waitCalls).toBe(1);

			// wait reject（模拟 ICE restart 期间 RPC 超时）
			const err = new Error('rpc timeout');
			err.code = 'RPC_TIMEOUT';
			ctrl.waitReject(err);
			await Promise.resolve();
			await Promise.resolve();

			// 不立即下一轮，run 仍 running，idleTimer 已重 arm
			expect(ctrl.waitCalls).toBe(1);
			expect(store.runs['run-1'].ended).toBe(false);
			expect(store.isRunning('k1')).toBe(true);
			expect(store.runs['run-1'].__watcher.idleTimer).toBeTruthy();

			// 下一周期 wait 拿到 ok → 正常收尾
			vi.advanceTimersByTime(IDLE_THRESHOLD_MS);
			expect(ctrl.waitCalls).toBe(2);
			ctrl.waitResolve({ status: 'ok' });
			await vi.advanceTimersByTimeAsync(RPC_GRACE_MS);
			const result = await runPromise;
			expect(result.endReason).toBe('wait');
		});

		test('agent.wait 连续 reject → 持续按 idle 周期重试，不卡死', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });
			relaxMemoryTimer(store);

			// 连续 3 个周期 reject
			for (let i = 1; i <= 3; i++) {
				vi.advanceTimersByTime(IDLE_THRESHOLD_MS);
				expect(ctrl.waitCalls).toBe(i);
				const err = new Error('rpc timeout');
				err.code = 'RPC_TIMEOUT';
				ctrl.waitReject(err);
				await Promise.resolve();
				await Promise.resolve();
			}
			expect(store.runs['run-1'].ended).toBe(false);

			// 主 agent() RPC 用 timeout=0 仍 pending，最终 finalResolve 走信号 1
			ctrl.finalResolve({ status: 'ok' });
			const result = await runPromise;
			expect(result.endReason).toBe('rpc');
		});

		test('主 RPC reject 与 wait reject 同步发生 → 主 RPC 先判死，wait catch 不触发新 pollOnce（hot loop 防御）', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });
			relaxMemoryTimer(store);
			vi.advanceTimersByTime(IDLE_THRESHOLD_MS);
			expect(ctrl.waitCalls).toBe(1);

			// 模拟 __rejectAllPending：同步 reject 两个 pending RPC（主 RPC 先注册先 reject）
			const rpcErr = new Error('rtc lost');
			rpcErr.code = 'RTC_LOST';
			const waitErr = new Error('rtc lost');
			waitErr.code = 'RTC_LOST';
			ctrl.finalReject(rpcErr);
			ctrl.waitReject(waitErr);

			const result = await runPromise;
			expect(result.endReason).toBe('failed');
			// wait catch 进入时主 RPC 已 endRun + cleanup → guard 拦截，不发起新一轮
			expect(ctrl.waitCalls).toBe(1);
		});

		test('wait reject 期间主 agent() RPC reject → endReason="failed"（信号 3 兜底判死）', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });
			relaxMemoryTimer(store);
			vi.advanceTimersByTime(IDLE_THRESHOLD_MS);
			expect(ctrl.waitCalls).toBe(1);

			// wait reject 不判死
			const waitErr = new Error('rpc timeout');
			waitErr.code = 'RPC_TIMEOUT';
			ctrl.waitReject(waitErr);
			await Promise.resolve();
			await Promise.resolve();
			expect(store.runs['run-1'].ended).toBe(false);

			// DC 物理死亡 → 主 RPC reject → __onRpcFailed → endRun('failed')
			const rpcErr = new Error('rtc lost');
			rpcErr.code = 'RTC_LOST';
			ctrl.finalReject(rpcErr);
			const result = await runPromise;
			expect(result.endReason).toBe('failed');
		});

		test('事件流活跃时 idleTimer 被持续重置（不触发探测）', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });

			// 推 50s + assistant 事件 + 推 50s → 事件流活跃，无 wait 探测
			vi.advanceTimersByTime(50_000);
			store.__dispatch({ runId: 'run-1', stream: 'assistant', data: { text: 'hi' } });
			vi.advanceTimersByTime(50_000);
			expect(ctrl.waitCalls).toBe(0);

			ctrl.finalResolve({ status: 'ok' });
			await runPromise;
		});

		test('lifecycle 事件期间 idleTimer 被持续重置（不再驱动 endRun，仅刷新静默计时）', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });

			// 推 50s + 中间段 lifecycle:end + 推 50s → 仍未触发探测
			vi.advanceTimersByTime(50_000);
			store.__dispatch({ runId: 'run-1', stream: 'lifecycle', data: { phase: 'end' } });
			vi.advanceTimersByTime(50_000);
			expect(ctrl.waitCalls).toBe(0);
			expect(store.runs['run-1'].ended).toBe(false);
			expect(store.runs['run-1'].__pendingEnd).toBeNull();

			ctrl.finalResolve({ status: 'ok' });
			await runPromise;
		});

		test('polling 期间 wait 终态先到 + grace 内 rpc 不到 → endReason="wait"', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });
			relaxMemoryTimer(store);
			vi.advanceTimersByTime(IDLE_THRESHOLD_MS);
			expect(ctrl.waitCalls).toBe(1);

			// wait 终态先到 → 挂 grace
			ctrl.waitResolve({ status: 'ok' });
			await Promise.resolve();
			await Promise.resolve();
			expect(store.runs['run-1'].ended).toBe(false);
			expect(store.runs['run-1'].__pendingEnd?.reason).toBe('wait');

			// 推进 grace（rpc 仍未到）→ 降级 endRun('wait')
			await vi.advanceTimersByTimeAsync(RPC_GRACE_MS);
			const result = await runPromise;
			expect(result.endReason).toBe('wait');

			// 此后 rpc res 才 resolve，应被忽略（run.ended）
			ctrl.finalResolve({ status: 'ok' });
		});

		test('polling 期间 wait 终态先到 + grace 内 RPC ok 到达 → endReason="rpc"（rpc 优先）', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });
			relaxMemoryTimer(store);
			vi.advanceTimersByTime(IDLE_THRESHOLD_MS);
			expect(ctrl.waitCalls).toBe(1);

			// wait 终态先到 → 挂 grace
			ctrl.waitResolve({ status: 'ok' });
			await Promise.resolve();
			await Promise.resolve();
			expect(store.runs['run-1'].__pendingEnd?.reason).toBe('wait');

			// grace 期间 RPC ok 到达 → 清 grace + 走 'rpc' 路径
			ctrl.finalResolve({ status: 'ok' });
			const result = await runPromise;
			expect(result.endReason).toBe('rpc');
		});
	});

	// =====================================================================
	// dropRun（chat.store loadMessages 完成后调用）
	// =====================================================================

	describe('dropRun', () => {
		test('endRun 不删 entry，dropRun 才真正 cleanup', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			store.__endRun('run-1', 'wait');
			// endRun 后 entry 仍在
			expect(store.runs['run-1']).toBeTruthy();
			expect(store.runs['run-1'].ended).toBe(true);

			store.dropRun('1::agent:main:main');

			expect(store.runs['run-1']).toBeUndefined();
			expect(store.runKeyIndex['1::agent:main:main']).toBeUndefined();
		});

		test('dropRun 释放 streamingMsgs 中 blob URL', () => {
			const origRevoke = URL.revokeObjectURL;
			URL.revokeObjectURL = vi.fn();
			const store = useAgentRunsStore();
			registerRun(store);
			store.runs['run-1'].streamingMsgs = [
				{ id: 'a', _attachments: [{ url: 'blob:x' }] },
			];

			store.dropRun('1::agent:main:main');

			expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:x');
			URL.revokeObjectURL = origRevoke;
		});

		test('不存在的 runKey 不报错', () => {
			const store = useAgentRunsStore();
			expect(() => store.dropRun('nonexistent')).not.toThrow();
		});

		test('expectedRunId 不匹配时跳过清理（防 loadMessages 期间 runKey 被新 run 覆盖误删）', () => {
			const store = useAgentRunsStore();
			registerRun(store, { runId: 'run-new', runKey: '1::agent:main:main' });
			// 模拟：旧 runPromise.then 闭包里的 expectedRunId 是 run-old，但 runKey 已被 run-new 占据
			store.dropRun('1::agent:main:main', 'run-old');
			// run-new 未被误删
			expect(store.runs['run-new']).toBeTruthy();
			expect(store.runKeyIndex['1::agent:main:main']).toBe('run-new');
		});

		test('expectedRunId 匹配时正常清理', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.__endRun('run-1', 'wait');
			store.dropRun('1::agent:main:main', 'run-1');
			expect(store.runs['run-1']).toBeUndefined();
		});
	});

	// =====================================================================
	// 信号去重（多路同时到达）
	// =====================================================================

	describe('信号去重', () => {
		test('wait 终态 + grace 内 RPC ok 到达 → endRun 只触发一次，endReason="rpc"（rpc 优先）', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });
			relaxMemoryTimer(store);
			vi.advanceTimersByTime(IDLE_THRESHOLD_MS);

			// wait 终态先到 → 挂 grace（ended 仍 false）
			ctrl.waitResolve({ status: 'ok' });
			await Promise.resolve();
			await Promise.resolve();
			expect(store.runs['run-1'].ended).toBe(false);
			expect(store.runs['run-1'].__pendingEnd?.reason).toBe('wait');

			// grace 期间 RPC res 到达 → 清 grace + endRun('rpc')，endRun 只触发一次
			ctrl.finalResolve({ status: 'ok' });

			const result = await runPromise;
			expect(result.endReason).toBe('rpc');
			expect(store.runs['run-1'].__pendingEnd).toBeNull();
		});
	});

	// =====================================================================
	// run 终结路径诊断 remoteLog（agent.run.end / agent.run.drop / agent.run.preempt）
	// =====================================================================
	// 所有判 run 结束的路径必须经 __endRun，统一在此打 'agent.run.end' 信号；
	// dropRun 真正释放 streamingMsgs 时打 'agent.run.drop'；register 抢占同 runKey
	// 旧 run 时打 'agent.run.preempt' 串起新旧 runId。覆盖目的是让服务端日志能定位
	// "任务未完成" 误判走的是哪条结束路径。

	describe('agent.run.end remoteLog', () => {
		const findEnd = (runId, reason) => remoteLogCalls.find(
			(t) => t === `agent.run.end runId=${runId} reason=${reason}`,
		);

		test('reason="rpc"：信号 1 RPC 二阶段 ok 到达', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();
			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });
			ctrl.finalResolve({ status: 'ok' });
			await runPromise;
			expect(findEnd('run-1', 'rpc')).toBeTruthy();
		});

		test('reason="wait"：信号 2 agent.wait(0) 终态 + grace 期满', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();
			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });
			relaxMemoryTimer(store);
			vi.advanceTimersByTime(IDLE_THRESHOLD_MS);
			ctrl.waitResolve({ status: 'ok' });
			await vi.advanceTimersByTimeAsync(RPC_GRACE_MS);
			await runPromise;
			expect(findEnd('run-1', 'wait')).toBeTruthy();
		});

		test('reason="failed"：信号 3 主 RPC reject', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();
			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });
			const err = new Error('dc closed');
			err.code = 'DC_CLOSED';
			ctrl.finalReject(err);
			await runPromise;
			expect(findEnd('run-1', 'failed')).toBeTruthy();
		});

		test('reason="timeout"：post-acceptance 24h 兜底', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			vi.advanceTimersByTime(POST_ACCEPT_TIMEOUT_MS);
			expect(findEnd('run-1', 'timeout')).toBeTruthy();
		});

		test('reason="manual"：手动 settle', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.settle('1::agent:main:main');
			expect(findEnd('run-1', 'manual')).toBeTruthy();
		});

		test('reason="superseded"：同 runKey 旧 run 被新 run 抢占', () => {
			const store = useAgentRunsStore();
			registerRun(store, { runId: 'run-old', runKey: 'k-same' });
			registerRun(store, { runId: 'run-new', runKey: 'k-same' });
			expect(findEnd('run-old', 'superseded')).toBeTruthy();
		});

		test('reason="claw-removed"：claw 被移除', () => {
			const store = useAgentRunsStore();
			registerRun(store, { runId: 'run-1', clawId: '1' });
			store.removeByClaw('1');
			expect(findEnd('run-1', 'claw-removed')).toBeTruthy();
		});

		test('reason="logout"：resetAll 登出清理', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.resetAll();
			expect(findEnd('run-1', 'logout')).toBeTruthy();
		});

		test('reason="cancel-gone"：cancel 协调启发判定 run 已结束', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.settleByCancel('1::agent:main:main', 'cancel-gone');
			expect(findEnd('run-1', 'cancel-gone')).toBeTruthy();
		});

		test('reason="cancel-not-supported"：plugin 侧门缺失，UI 主动收尾', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.settleByCancel('1::agent:main:main', 'cancel-not-supported');
			expect(findEnd('run-1', 'cancel-not-supported')).toBeTruthy();
		});

		test('已 ended run 第二次 endRun 不重复打 log（去重）', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.__endRun('run-1', 'wait'); // 第一次打
			const before = remoteLogCalls.filter((t) => t.startsWith('agent.run.end ')).length;

			store.settle('1::agent:main:main'); // 已 ended，不应再走 __endRun

			const after = remoteLogCalls.filter((t) => t.startsWith('agent.run.end ')).length;
			expect(after).toBe(before);
		});
	});

	describe('agent.run.drop remoteLog', () => {
		test('真正清理时打 log（runKey + runId）', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.__endRun('run-1', 'wait');

			store.dropRun('1::agent:main:main');

			expect(remoteLogCalls).toContain('agent.run.drop runKey=1::agent:main:main runId=run-1');
		});

		test('runKey 不存在时不打 log', () => {
			const store = useAgentRunsStore();
			store.dropRun('nonexistent');
			expect(remoteLogCalls.find((t) => t.startsWith('agent.run.drop'))).toBeFalsy();
		});

		test('expectedRunId 不匹配时不打 log（防误清新 run 的同时也不污染日志）', () => {
			const store = useAgentRunsStore();
			registerRun(store, { runId: 'run-new', runKey: '1::agent:main:main' });
			store.dropRun('1::agent:main:main', 'run-old');
			expect(remoteLogCalls.find((t) => t.startsWith('agent.run.drop'))).toBeFalsy();
		});
	});

	describe('agent.run.preempt remoteLog', () => {
		test('同 runKey 抢占时打 log（含新旧 runId）', () => {
			const store = useAgentRunsStore();
			registerRun(store, { runId: 'run-old', runKey: 'k-same' });
			registerRun(store, { runId: 'run-new', runKey: 'k-same' });

			expect(remoteLogCalls).toContain(
				'agent.run.preempt runKey=k-same newRunId=run-new oldRunId=run-old',
			);
		});

		test('register 全新 runKey 时不打 preempt log', () => {
			const store = useAgentRunsStore();
			registerRun(store, { runId: 'run-1', runKey: 'k-fresh' });
			expect(remoteLogCalls.find((t) => t.startsWith('agent.run.preempt'))).toBeFalsy();
		});
	});

	// =====================================================================
	// rpc grace 边缘行为（方案 D 引入）
	// =====================================================================

	describe('rpc grace', () => {
		test('failed 路径（信号 3）跳过 grace，立即 endRun', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });

			// 网络异常：上游 rpc 二阶段不可能再到，立即收尾
			const err = new Error('dc closed');
			err.code = 'DC_CLOSED';
			ctrl.finalReject(err);

			const result = await runPromise;
			expect(result.endReason).toBe('failed');
			expect(store.runs['run-1'].ended).toBe(true);
			expect(store.runs['run-1'].__pendingEnd).toBeNull();
		});

		test('pending 已挂时第二次 schedulePendingEnd 不重复挂（先到的 reason 优先）', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			// 第一次：wait 挂 grace
			store.__schedulePendingEnd('run-1', 'wait');
			const firstTimer = store.runs['run-1'].__pendingEnd?.timer;
			expect(firstTimer).toBeTruthy();

			// 第二次：再次 schedule，pending 不应被替换
			store.__schedulePendingEnd('run-1', 'wait');
			expect(store.runs['run-1'].__pendingEnd?.timer).toBe(firstTimer);
			expect(store.runs['run-1'].__pendingEnd.reason).toBe('wait');
		});

		test('grace 期间 settle("manual") 清 pending timer，不泄漏', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			// 挂 grace
			store.__schedulePendingEnd('run-1', 'wait');
			expect(store.runs['run-1'].__pendingEnd).toBeTruthy();

			// settle('manual') 触发 cleanup → endRun → 清 pending
			store.settle('1::agent:main:main');
			expect(store.runs['run-1']).toBeUndefined();

			// 推进 RPC_GRACE_MS：原 pending timer 若未清，会触发 endRun 报错或重复触发；
			// 这里推进后无副作用即证明 timer 已被清
			expect(() => vi.advanceTimersByTime(RPC_GRACE_MS)).not.toThrow();
		});

		test('grace 期满降级 → 打 rpc-grace-elapsed 诊断 remoteLog', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			store.__schedulePendingEnd('run-1', 'wait');
			expect(remoteLogCalls.find((t) => t.includes('rpc-grace-elapsed'))).toBeFalsy();

			vi.advanceTimersByTime(RPC_GRACE_MS);

			const elapsed = remoteLogCalls.find((t) => t.includes('rpc-grace-elapsed'));
			expect(elapsed).toMatch(/agent\.run\.rpc-grace-elapsed runId=run-1 reason=wait/);
		});

		test('grace 内 rpc 抢先到达 → 不打诊断 remoteLog', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			store.__schedulePendingEnd('run-1', 'wait');
			// rpc 抢先（grace 满前）
			store.__onRpcDone('run-1');

			expect(store.runs['run-1'].ended).toBe(true);
			expect(remoteLogCalls.find((t) => t.includes('rpc-grace-elapsed'))).toBeFalsy();

			// 推进残余时间也不应再打（pending 已清）
			vi.advanceTimersByTime(RPC_GRACE_MS);
			expect(remoteLogCalls.find((t) => t.includes('rpc-grace-elapsed'))).toBeFalsy();
		});
	});

	// =====================================================================
	// resetAll（登出清理）
	// =====================================================================

	describe('resetAll', () => {
		test('清空 runs 与 runKeyIndex', () => {
			const store = useAgentRunsStore();
			registerRun(store, { runId: 'run-a', runKey: 'k-a', clawId: '1' });
			registerRun(store, { runId: 'run-b', runKey: 'k-b', clawId: '2' });

			store.resetAll();

			expect(store.runs).toEqual({});
			expect(store.runKeyIndex).toEqual({});
			expect(store.busy).toBe(false);
		});

		test('每个 run 的 24h 兜底 timer 和 idleTimer 被 clear', () => {
			const store = useAgentRunsStore();
			registerRun(store, { runId: 'run-a', runKey: 'k-a' });
			registerRun(store, { runId: 'run-b', runKey: 'k-b' });
			// 捕获 run 原引用：__cleanupRun 虽然删 Map 条目，但原对象上的 __timer/__watcher.idleTimer
			// 会在 __endRun 里被置 null（参见 agent-runs.store.js:329-341）。通过原引用断言。
			const runA = store.runs['run-a'];
			const runB = store.runs['run-b'];
			expect(runA.__timer).toBeTruthy();
			expect(runA.__watcher.idleTimer).toBeTruthy();
			expect(runB.__timer).toBeTruthy();
			expect(runB.__watcher.idleTimer).toBeTruthy();
			const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

			store.resetAll();

			// 若代码忘记 clearTimeout，这两断言会失败
			expect(runA.__timer).toBeNull();
			expect(runA.__watcher.idleTimer).toBeNull();
			expect(runB.__timer).toBeNull();
			expect(runB.__watcher.idleTimer).toBeNull();
			// 并确保 clearTimeout 被调用（__endRun + __cleanupRun 双层共 4 次：2 run × 2 timer）
			expect(clearSpy).toHaveBeenCalled();
			clearSpy.mockRestore();
		});

		test('释放所有 run 的 streamingMsgs 中 _attachments blob URL', () => {
			const origRevoke = URL.revokeObjectURL;
			URL.revokeObjectURL = vi.fn();
			const store = useAgentRunsStore();
			registerRun(store, { runId: 'run-a', runKey: 'k-a' });
			store.runs['run-a'].streamingMsgs = [
				{ id: 'u1', _local: true, message: { role: 'user', content: 'hi' },
					_attachments: [{ url: 'blob:a1' }, { url: 'blob:a2' }] },
			];
			registerRun(store, { runId: 'run-b', runKey: 'k-b' });
			store.runs['run-b'].streamingMsgs = [
				{ id: 'u2', _local: true, message: { role: 'user', content: 'hi' },
					_attachments: [{ url: 'blob:b1' }] },
			];

			store.resetAll();

			expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:a1');
			expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:a2');
			expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:b1');
			URL.revokeObjectURL = origRevoke;
		});

		test('唤起未结束 run 的 onEnd（runAgent finalPromise 被 resolve，endReason="logout"）', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });
			expect(store.runs['run-1'].ended).toBe(false);

			store.resetAll();

			const result = await runPromise;
			expect(result).toEqual({ runId: 'run-1', accepted: true, endReason: 'logout', errorMessage: null });
			expect(store.runs['run-1']).toBeUndefined();
		});

		test('空注册表时不报错', () => {
			const store = useAgentRunsStore();
			expect(() => store.resetAll()).not.toThrow();
		});

		test('单个 run cleanup 抛错不影响其余 run 清理（错误隔离）', () => {
			const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
			const store = useAgentRunsStore();
			registerRun(store, { runId: 'run-a', runKey: 'k-a' });
			registerRun(store, { runId: 'run-b', runKey: 'k-b' });
			registerRun(store, { runId: 'run-c', runKey: 'k-c' });

			// 让中间 run 的 __cleanupRun 抛错（模拟 URL.revokeObjectURL 边界异常等）
			const origCleanup = store.__cleanupRun.bind(store);
			const cleanupSpy = vi.spyOn(store, '__cleanupRun').mockImplementation((runId, reason) => {
				if (runId === 'run-b') throw new Error('boom from cleanup');
				return origCleanup(runId, reason);
			});

			expect(() => store.resetAll()).not.toThrow();

			// a 和 c 都被清掉；若未隔离，循环从 b 处中断，c 会残留
			expect(store.runs['run-a']).toBeUndefined();
			expect(store.runs['run-c']).toBeUndefined();
			// b 因为抛错未完成清理，仍残留（这是预期——隔离不掩盖失败项，只保护后续项）
			expect(store.runs['run-b']).toBeDefined();
			expect(cleanupSpy).toHaveBeenCalledTimes(3);
			expect(debugSpy).toHaveBeenCalled();
			cleanupSpy.mockRestore();
			debugSpy.mockRestore();
		});
	});

	// =====================================================================
	// busy
	// =====================================================================

	describe('busy', () => {
		test('无 entry 时为 false', () => {
			expect(useAgentRunsStore().busy).toBe(false);
		});

		test('任意 entry 存在即 true（含 ended/cancelled）', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			expect(store.busy).toBe(true);
			store.runs['run-1'].ended = true;
			expect(store.busy).toBe(true);
		});

		test('dropRun 后为 false', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.settle('1::agent:main:main');
			expect(store.busy).toBe(false);
		});
	});
});
