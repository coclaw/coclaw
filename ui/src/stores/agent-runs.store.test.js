import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

import { useAgentRunsStore, POST_ACCEPT_TIMEOUT_MS } from './agent-runs.store.js';

// --- Helper ---

function mockConn(overrides = {}) {
	return {
		state: 'connected',
		request: vi.fn(),
		...overrides,
	};
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
			return Promise.resolve({});
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
			expect(result).toEqual({ runId: 'run-old', accepted: true, endReason: 'superseded' });
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

		test('lifecycle:end → endRun(lifecycle)，run.ended=true 但 entry 保留', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			store.__dispatch({ runId: 'run-1', stream: 'lifecycle', data: { phase: 'end' } });

			const run = store.runs['run-1'];
			expect(run).toBeTruthy();
			expect(run.ended).toBe(true);
			// entry 保留（streamingMsgs 仍可见，等 chat.store 调 dropRun）
			expect(store.getActiveRun('1::agent:main:main')).toBeTruthy();
			// isRunning 立即 false
			expect(store.isRunning('1::agent:main:main')).toBe(false);
		});

		test('lifecycle:error 同样进入 ended 态', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			store.__dispatch({ runId: 'run-1', stream: 'lifecycle', data: { phase: 'error' } });

			expect(store.runs['run-1'].ended).toBe(true);
		});

		test('已 ended 的 run 后续事件被忽略（无更新、无重复 endRun）', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.__dispatch({ runId: 'run-1', stream: 'lifecycle', data: { phase: 'end' } });
			const lastEventAt = store.runs['run-1'].lastEventAt;

			store.__dispatch({ runId: 'run-1', stream: 'assistant', data: { text: 'late' } });

			expect(store.runs['run-1'].lastEventAt).toBe(lastEventAt);
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

		test('cancel 后 lifecycle:end → endRun(lifecycle)，cancelled 与 ended 共存', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.settleWithTransitionByKey('1::agent:main:main');

			store.__dispatch({ runId: 'run-1', stream: 'lifecycle', data: { phase: 'end' } });

			const run = store.runs['run-1'];
			expect(run.cancelled).toBe(true);
			expect(run.ended).toBe(true);
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
			expect(result).toEqual({ runId: 'run-1', accepted: true, endReason: 'claw-removed' });
			expect(store.runs['run-1']).toBeUndefined();
		});
	});

	// =====================================================================
	// runAgent（两阶段 RPC + watcher 接入）
	// =====================================================================

	describe('runAgent', () => {
		test('信号 1：RPC 第二阶段 ok → endReason="rpc"', async () => {
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
			expect(result).toEqual({ runId: 'run-1', accepted: true, endReason: 'rpc' });
			expect(store.runs['run-1'].ended).toBe(true);
		});

		test('信号 1：RPC 第二阶段 error → endReason="rpc"', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });
			ctrl.finalResolve({ status: 'error', error: { message: 'agent failed' } });

			const result = await runPromise;
			expect(result.endReason).toBe('rpc');
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

		test('信号 4：accepted 后 RPC reject → endReason="failed"', async () => {
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

			const result = await runPromise;
			expect(result).toEqual({ runId: 'run-1', accepted: true, endReason: 'failed' });
			expect(store.runs['run-1'].ended).toBe(true);
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
		test('idle 30s 后启动长挂 agent.wait', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });

			expect(ctrl.waitCalls).toBe(0);
			vi.advanceTimersByTime(30_000);
			expect(ctrl.waitCalls).toBe(1);

			ctrl.finalResolve({ status: 'ok' });
			await runPromise;
		});

		test('agent.wait 返回 ok → endReason="wait"', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });
			vi.advanceTimersByTime(30_000);
			ctrl.waitResolve({ status: 'ok' });

			const result = await runPromise;
			expect(result.endReason).toBe('wait');
		});

		test('agent.wait timeout + endedAt → endReason="wait"（abort）', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });
			vi.advanceTimersByTime(30_000);
			ctrl.waitResolve({ status: 'timeout', startedAt: 100, endedAt: 200 });

			const result = await runPromise;
			expect(result.endReason).toBe('wait');
		});

		test('agent.wait timeout 无 endedAt → 立即下一轮 pollOnce', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });
			vi.advanceTimersByTime(30_000);
			expect(ctrl.waitCalls).toBe(1);

			ctrl.waitResolve({ status: 'timeout' });
			await Promise.resolve();
			await Promise.resolve();
			expect(ctrl.waitCalls).toBe(2);

			ctrl.finalResolve({ status: 'ok' });
			await runPromise;
		});

		test('agent.wait reject → endReason="failed"（信号 4）', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });
			vi.advanceTimersByTime(30_000);
			const err = new Error('dc closed');
			err.code = 'DC_CLOSED';
			ctrl.waitReject(err);

			const result = await runPromise;
			expect(result.endReason).toBe('failed');
		});

		test('事件流活跃时 idleTimer 被持续重置（不触发长挂）', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });

			// 推 25s + assistant 事件 + 推 25s → 事件流活跃，无长挂
			vi.advanceTimersByTime(25_000);
			store.__dispatch({ runId: 'run-1', stream: 'assistant', data: { text: 'hi' } });
			vi.advanceTimersByTime(25_000);
			expect(ctrl.waitCalls).toBe(0);

			ctrl.finalResolve({ status: 'ok' });
			await runPromise;
		});

		test('polling 期间 lifecycle:end 到达 → endReason="lifecycle"，飞行 wait 被忽略', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });
			vi.advanceTimersByTime(30_000);
			expect(ctrl.waitCalls).toBe(1);

			// lifecycle 先到
			store.__dispatch({ runId: 'run-1', stream: 'lifecycle', data: { phase: 'end' } });
			ctrl.finalResolve({ status: 'ok' });
			const result = await runPromise;
			expect(result.endReason).toBe('lifecycle');

			// 此后 wait 才 resolve，应被忽略（run.ended）
			ctrl.waitResolve({ status: 'ok' });
		});
	});

	// =====================================================================
	// dropRun（chat.store loadMessages 完成后调用）
	// =====================================================================

	describe('dropRun', () => {
		test('endRun 不删 entry，dropRun 才真正 cleanup', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			store.__dispatch({ runId: 'run-1', stream: 'lifecycle', data: { phase: 'end' } });
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
			store.__dispatch({ runId: 'run-1', stream: 'lifecycle', data: { phase: 'end' } });
			store.dropRun('1::agent:main:main', 'run-1');
			expect(store.runs['run-1']).toBeUndefined();
		});
	});

	// =====================================================================
	// 信号去重（多路同时到达）
	// =====================================================================

	describe('信号去重', () => {
		test('RPC ok + lifecycle:end 同时到达，endRun 只触发一次', async () => {
			const store = useAgentRunsStore();
			const ctrl = mockTwoPhaseConn();

			const runPromise = store.runAgent({
				conn: ctrl.conn, clawId: '1', runKey: 'k1', topicMode: false,
				agentParams: {}, optimisticMsgs: [],
			});
			await Promise.resolve();
			ctrl.fireAccepted({ runId: 'run-1' });

			// lifecycle 先到
			store.__dispatch({ runId: 'run-1', stream: 'lifecycle', data: { phase: 'end' } });
			expect(store.runs['run-1'].ended).toBe(true);
			// RPC res 后到
			ctrl.finalResolve({ status: 'ok' });

			const result = await runPromise;
			// 第一路命中决定 reason
			expect(result.endReason).toBe('lifecycle');
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
