import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

import { useAgentRunsStore } from './agent-runs.store.js';

// --- Helper ---

function mockConn() {
	return { state: 'connected' };
}

function registerRun(store, overrides = {}) {
	const conn = overrides.conn ?? mockConn();
	store.register(overrides.runId ?? 'run-1', {
		clawId: overrides.clawId ?? '1',
		runKey: overrides.runKey ?? 'agent:main:main',
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
			expect(store.runs['run-1'].settled).toBe(false);
			expect(store.runKeyIndex['agent:main:main']).toBe('run-1');
		});

		test('同一 runKey 重复注册时清理旧 run', () => {
			const store = useAgentRunsStore();
			registerRun(store, { runId: 'run-1', runKey: 'agent:main:main' });
			registerRun(store, { runId: 'run-2', runKey: 'agent:main:main' });

			expect(store.runs['run-1']).toBeUndefined();
			expect(store.runs['run-2']).toBeTruthy();
			expect(store.runKeyIndex['agent:main:main']).toBe('run-2');
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

		test('不再自行注册 event:agent 监听器（由 clawsStore 集中桥接）', () => {
			const store = useAgentRunsStore();
			const conn = { state: 'connected', on: vi.fn(), off: vi.fn() };
			registerRun(store, { conn });

			// conn.on 不应被调用（事件由 clawsStore.__bridgeConn 统一注册）
			expect(conn.on).not.toHaveBeenCalled();
		});
	});

	// =====================================================================
	// getters
	// =====================================================================

	describe('getters', () => {
		test('getActiveRun 返回活跃 run', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			const run = store.getActiveRun('agent:main:main');
			expect(run).toBeTruthy();
			expect(run.runId).toBe('run-1');
		});

		test('getActiveRun 无匹配 runKey 时返回 null', () => {
			const store = useAgentRunsStore();
			expect(store.getActiveRun('nonexistent')).toBeNull();
		});

		test('isRunning 正确反映 run 状态', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			expect(store.isRunning('agent:main:main')).toBe(true);
			expect(store.isRunning('nonexistent')).toBe(false);
		});

		test('isRunIdle：无匹配 run 时返回 false', () => {
			const store = useAgentRunsStore();
			expect(store.isRunIdle('nonexistent')).toBe(false);
		});

		test('isRunIdle：lastEventAt 为 0（尚未收到事件）时返回 false', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			expect(store.isRunIdle('agent:main:main')).toBe(false);
		});

		test('isRunIdle：lastEventAt 较新时返回 false', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.runs['run-1'].lastEventAt = Date.now() - 3000;
			expect(store.isRunIdle('agent:main:main')).toBe(false);
		});

		test('isRunIdle：lastEventAt 超过阈值时返回 true', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.runs['run-1'].lastEventAt = Date.now() - 15_000;
			expect(store.isRunIdle('agent:main:main')).toBe(true);
		});

		test('isRunIdle：run 已 settled 时返回 false', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.runs['run-1'].lastEventAt = Date.now() - 15_000;
			store.runs['run-1'].settled = true;
			expect(store.isRunIdle('agent:main:main')).toBe(false);
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

		test('更新 lastEventAt', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			expect(store.runs['run-1'].lastEventAt).toBe(0);
			store.__dispatch({ runId: 'run-1', stream: 'assistant', data: { text: 'hello' } });
			expect(store.runs['run-1'].lastEventAt).toBeGreaterThan(0);
		});

		test('未知 runId 的事件被忽略', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			// 不应抛错
			store.__dispatch({ runId: 'unknown-run', stream: 'assistant', data: { text: 'hello' } });
			expect(store.runs['run-1'].streamingMsgs).toHaveLength(2);
		});

		test('lifecycle:end 进入 settling 过渡态', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			store.__dispatch({ runId: 'run-1', stream: 'lifecycle', data: { phase: 'end' } });

			// settling 过渡：run 仍存在但标记为 settling
			const run = store.runs['run-1'];
			expect(run.settling).toBe(true);
			// getActiveRun 仍返回（保留 streamingMsgs）
			expect(store.getActiveRun('agent:main:main')).toBeTruthy();
		});

		test('settling 过渡 500ms 后自动清理', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			store.__dispatch({ runId: 'run-1', stream: 'lifecycle', data: { phase: 'end' } });
			expect(store.runs['run-1']).toBeTruthy();

			vi.advanceTimersByTime(500);

			expect(store.runs['run-1']).toBeUndefined();
			expect(store.runKeyIndex['agent:main:main']).toBeUndefined();
		});

		test('lifecycle:error 同样进入 settling 过渡态', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			store.__dispatch({ runId: 'run-1', stream: 'lifecycle', data: { phase: 'error' } });

			expect(store.runs['run-1']?.settling).toBe(true);
			vi.advanceTimersByTime(500);
			expect(store.runs['run-1']).toBeUndefined();
		});
	});

	// =====================================================================
	// settle
	// =====================================================================

	describe('settle', () => {
		test('手动 settle 清理 run', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			store.settle('agent:main:main');

			expect(store.runs['run-1']).toBeUndefined();
			expect(store.runKeyIndex['agent:main:main']).toBeUndefined();
			expect(store.isRunning('agent:main:main')).toBe(false);
		});

		test('settle 不存在的 runKey 不报错', () => {
			const store = useAgentRunsStore();
			store.settle('nonexistent');
		});
	});

	// =====================================================================
	// completeSettle
	// =====================================================================

	describe('completeSettle', () => {
		test('在 settling 状态下立即清理 run', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			// 进入 settling
			store.__dispatch({ runId: 'run-1', stream: 'lifecycle', data: { phase: 'end' } });
			expect(store.runs['run-1']?.settling).toBe(true);

			store.completeSettle('agent:main:main');

			expect(store.runs['run-1']).toBeUndefined();
			expect(store.runKeyIndex['agent:main:main']).toBeUndefined();
		});

		test('非 settling 状态下不操作', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			store.completeSettle('agent:main:main');

			// run 仍在
			expect(store.runs['run-1']).toBeTruthy();
		});

		test('不存在的 runKey 不报错', () => {
			const store = useAgentRunsStore();
			store.completeSettle('nonexistent');
		});
	});

	// =====================================================================
	// reconcileAfterLoad
	// =====================================================================

	describe('reconcileAfterLoad', () => {
		test('服务端消息有终止 assistant + 事件流静默 → settle', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			// 模拟事件流已停止（lastEventAt 在 3s+ 之前）
			store.runs['run-1'].lastEventAt = Date.now() - 5000;

			const serverMessages = [
				{ message: { role: 'user', content: 'hi' } },
				{ message: { role: 'assistant', content: 'hello', stopReason: 'stop' } },
			];

			store.reconcileAfterLoad('agent:main:main', serverMessages);

			expect(store.runs['run-1']).toBeUndefined();
		});

		test('事件流仍活跃时不 settle', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			// 刚收到事件
			store.runs['run-1'].lastEventAt = Date.now();

			const serverMessages = [
				{ message: { role: 'assistant', content: 'hello', stopReason: 'stop' } },
			];

			store.reconcileAfterLoad('agent:main:main', serverMessages);

			// 不应 settle
			expect(store.runs['run-1']).toBeTruthy();
		});

		test('服务端消息无终止 assistant 时不 settle', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.runs['run-1'].lastEventAt = Date.now() - 5000;

			const serverMessages = [
				{ message: { role: 'user', content: 'hi' } },
			];

			store.reconcileAfterLoad('agent:main:main', serverMessages);

			expect(store.runs['run-1']).toBeTruthy();
		});

		test('stopReason 为 toolUse 时不视为终止', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.runs['run-1'].lastEventAt = Date.now() - 5000;

			const serverMessages = [
				{ message: { role: 'assistant', content: '', stopReason: 'toolUse' } },
			];

			store.reconcileAfterLoad('agent:main:main', serverMessages);

			expect(store.runs['run-1']).toBeTruthy();
		});

		test('settling 状态的 run 不做 reconcile（由 completeSettle 处理）', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			store.__dispatch({ runId: 'run-1', stream: 'lifecycle', data: { phase: 'end' } });
			expect(store.runs['run-1']?.settling).toBe(true);

			const serverMessages = [
				{ message: { role: 'assistant', content: 'hello', stopReason: 'stop' } },
			];
			store.reconcileAfterLoad('agent:main:main', serverMessages);

			// 仍在 settling，未被 reconcile 清理（因为 reconcile 跳过 settling）
			expect(store.runs['run-1']).toBeTruthy();
		});

		test('lastEventAt=0 时视为非 stale（尚未收到事件），不 settle', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			// lastEventAt 从未更新（刚注册，尚未收到任何事件）
			expect(store.runs['run-1'].lastEventAt).toBe(0);

			const serverMessages = [
				{ message: { role: 'assistant', content: 'hello', stopReason: 'stop' } },
			];

			store.reconcileAfterLoad('agent:main:main', serverMessages);

			// 不应被 settle——run 刚注册，事件尚未到达
			expect(store.runs['run-1']).toBeTruthy();
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

			store.stripLocalUserMsgs('agent:main:main', serverMsgs);

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

			store.stripLocalUserMsgs('agent:main:main', []);

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

			store.stripLocalUserMsgs('agent:main:main', serverMsgs);

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
			// server 只有锚点之前的旧 user 消息，锚点之后无 user 消息
			const serverMsgs = [
				{ id: 'old-1', message: { role: 'user', content: '旧消息' } },
				{ id: 'anchor-1', message: { role: 'assistant', content: '旧回复' } },
			];

			store.stripLocalUserMsgs('agent:main:main', serverMsgs);

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
			// 锚点 ID 不在 serverMessages 中
			const serverMsgs = [
				{ id: 'far-away', message: { role: 'assistant', content: '很后面的消息' } },
			];

			store.stripLocalUserMsgs('agent:main:main', serverMsgs);

			expect(store.runs['run-1'].streamingMsgs).toHaveLength(1);
			expect(store.runs['run-1'].streamingMsgs[0].id).toBe('b1');
		});

		test('无 _local user 消息时 streamingMsgs 不变', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.runs['run-1'].streamingMsgs = [
				{ id: 'b1', _local: true, _streaming: true, message: { role: 'assistant', content: '' } },
			];

			store.stripLocalUserMsgs('agent:main:main', []);

			expect(store.runs['run-1'].streamingMsgs).toHaveLength(1);
			expect(store.runs['run-1'].streamingMsgs[0].id).toBe('b1');
		});

		test('settled run 不操作', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.runs['run-1'].settled = true;
			store.runs['run-1'].streamingMsgs = [
				{ id: 'u1', _local: true, message: { role: 'user', content: 'hi' } },
			];

			store.stripLocalUserMsgs('agent:main:main', [{ id: 's1', message: { role: 'user', content: 'hi' } }]);

			expect(store.runs['run-1'].streamingMsgs).toHaveLength(1);
		});

		test('settling run 不操作', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.runs['run-1'].settling = true;
			store.runs['run-1'].streamingMsgs = [
				{ id: 'u1', _local: true, message: { role: 'user', content: 'hi' } },
			];

			store.stripLocalUserMsgs('agent:main:main', [{ id: 's1', message: { role: 'user', content: 'hi' } }]);

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

			store.stripLocalUserMsgs('agent:main:main', serverMsgs);

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

			store.settle('agent:main:main');

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
			expect(() => store.settle('agent:main:main')).not.toThrow();
		});
	});

	// =====================================================================
	// post-acceptance timeout
	// =====================================================================

	describe('timeout', () => {
		test('post-acceptance 超时后自动 settle', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			expect(store.isRunning('agent:main:main')).toBe(true);

			vi.advanceTimersByTime(30 * 60_000);

			expect(store.isRunning('agent:main:main')).toBe(false);
			expect(store.runs['run-1']).toBeUndefined();
		});

		test('settle 清除超时定时器（不会二次触发）', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			store.settle('agent:main:main');

			// 推进时间不应报错
			vi.advanceTimersByTime(30 * 60_000);
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
			// bot 2 的 run 不受影响
			expect(store.runs['run-3']).toBeTruthy();
		});

		test('无活跃 runs 时不报错', () => {
			const store = useAgentRunsStore();
			store.removeByClaw('nonexistent');
		});
	});

	// =====================================================================
	// markLoadInFlight / clearLoadInFlight + settle fallback 推迟（#193）
	// =====================================================================

	describe('settle fallback 与 loadInFlight（#193）', () => {
		test('loadInFlight 为 true 时 settle fallback 推迟清理', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			// lifecycle:end → settling
			store.__dispatch({ runId: 'run-1', stream: 'lifecycle', data: { phase: 'end' } });
			expect(store.runs['run-1']?.settling).toBe(true);

			// 标记 loadMessages 正在进行
			store.markLoadInFlight('agent:main:main');

			// 500ms 后 fallback 不应清理
			vi.advanceTimersByTime(500);
			expect(store.runs['run-1']).toBeTruthy();
			expect(store.getActiveRun('agent:main:main')).toBeTruthy();
		});

		test('loadInFlight 清除后下一次 fallback 正常清理', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			store.__dispatch({ runId: 'run-1', stream: 'lifecycle', data: { phase: 'end' } });
			store.markLoadInFlight('agent:main:main');

			// 第一次 fallback 推迟
			vi.advanceTimersByTime(500);
			expect(store.runs['run-1']).toBeTruthy();

			// 模拟 loadMessages 失败，清除标记
			store.clearLoadInFlight('agent:main:main');

			// 第二次 fallback 应正常清理
			vi.advanceTimersByTime(500);
			expect(store.runs['run-1']).toBeUndefined();
		});

		test('completeSettle 在 loadInFlight 期间仍可正常清理', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			store.__dispatch({ runId: 'run-1', stream: 'lifecycle', data: { phase: 'end' } });
			store.markLoadInFlight('agent:main:main');

			// loadMessages 成功 → completeSettle
			store.completeSettle('agent:main:main');

			expect(store.runs['run-1']).toBeUndefined();
		});

		test('markLoadInFlight 对不存在的 runKey 不报错', () => {
			const store = useAgentRunsStore();
			store.markLoadInFlight('nonexistent');
		});

		test('clearLoadInFlight 对不存在的 runKey 不报错', () => {
			const store = useAgentRunsStore();
			store.clearLoadInFlight('nonexistent');
		});

		test('markLoadInFlight 对已 settled 的 run 不设置标记', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.settle('agent:main:main');

			// run 已被清理，markLoadInFlight 应为 no-op
			store.markLoadInFlight('agent:main:main');
		});

		test('多次推迟后 clearLoadInFlight 使下一次 fallback 清理', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			store.__dispatch({ runId: 'run-1', stream: 'lifecycle', data: { phase: 'end' } });
			store.markLoadInFlight('agent:main:main');

			// 推迟 3 次
			vi.advanceTimersByTime(500);
			expect(store.runs['run-1']).toBeTruthy();
			vi.advanceTimersByTime(500);
			expect(store.runs['run-1']).toBeTruthy();
			vi.advanceTimersByTime(500);
			expect(store.runs['run-1']).toBeTruthy();

			// 清除标记后下一次 fallback 正常清理
			store.clearLoadInFlight('agent:main:main');
			vi.advanceTimersByTime(500);
			expect(store.runs['run-1']).toBeUndefined();
		});

		test('removeByClaw 清理 settling + loadInFlight 的 run 无悬挂 timer', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			store.__dispatch({ runId: 'run-1', stream: 'lifecycle', data: { phase: 'end' } });
			store.markLoadInFlight('agent:main:main');

			// removeByClaw 应直接清理，含 __settleTimer
			store.removeByClaw('1');
			expect(store.runs['run-1']).toBeUndefined();

			// 后续 timer 触发不应报错
			vi.advanceTimersByTime(1000);
		});

		test('settle() 在 loadInFlight 为 true 时仍立即清理（用户取消优先）', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			store.__dispatch({ runId: 'run-1', stream: 'lifecycle', data: { phase: 'end' } });
			store.markLoadInFlight('agent:main:main');

			// 用户主动 settle 应立即生效，不受 loadInFlight 阻挡
			store.settle('agent:main:main');
			expect(store.runs['run-1']).toBeUndefined();
		});
	});

	// =====================================================================
	// busy getter
	// =====================================================================

	describe('busy', () => {
		test('无 run 时为 false', () => {
			expect(useAgentRunsStore().busy).toBe(false);
		});

		test('有未 settled 的 run 时为 true', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			expect(store.busy).toBe(true);
		});

		test('所有 run settled 后为 false', () => {
			const store = useAgentRunsStore();
			registerRun(store);
			store.settle('agent:main:main');
			expect(store.busy).toBe(false);
		});
	});
});
