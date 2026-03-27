import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

import { useAgentRunsStore } from './agent-runs.store.js';

// --- Helper ---

function mockConn() {
	return {
		state: 'connected',
		on: vi.fn(),
		off: vi.fn(),
	};
}

function registerRun(store, overrides = {}) {
	const conn = overrides.conn ?? mockConn();
	store.register(overrides.runId ?? 'run-1', {
		botId: overrides.botId ?? '1',
		runKey: overrides.runKey ?? 'agent:main:main',
		topicMode: overrides.topicMode ?? false,
		conn,
		streamingMsgs: overrides.streamingMsgs ?? [
			{ id: '__local_user_1', _local: true, message: { role: 'user', content: 'hi' } },
			{ id: '__local_bot_1', _local: true, _streaming: true, _startTime: 1000, message: { role: 'assistant', content: '', stopReason: null } },
		],
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

		test('注册时在 connection 上注册 event:agent 监听器', () => {
			const store = useAgentRunsStore();
			const conn = mockConn();
			registerRun(store, { conn });

			expect(conn.on).toHaveBeenCalledWith('event:agent', expect.any(Function));
		});

		test('同一 botId 多个 run 只注册一次监听器', () => {
			const store = useAgentRunsStore();
			const conn = mockConn();
			registerRun(store, { runId: 'run-1', runKey: 'key1', conn });
			registerRun(store, { runId: 'run-2', runKey: 'key2', conn });

			expect(conn.on).toHaveBeenCalledTimes(1);
		});

		test('同一 runKey 重复注册时清理旧 run', () => {
			const store = useAgentRunsStore();
			registerRun(store, { runId: 'run-1', runKey: 'agent:main:main' });
			registerRun(store, { runId: 'run-2', runKey: 'agent:main:main' });

			expect(store.runs['run-1']).toBeUndefined();
			expect(store.runs['run-2']).toBeTruthy();
			expect(store.runKeyIndex['agent:main:main']).toBe('run-2');
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

		test('settle 后移除空闲 connection 的监听器', () => {
			const store = useAgentRunsStore();
			const conn = mockConn();
			registerRun(store, { conn });

			store.settle('agent:main:main');

			expect(conn.off).toHaveBeenCalledWith('event:agent', expect.any(Function));
		});

		test('同一 botId 有其他活跃 run 时不移除监听器', () => {
			const store = useAgentRunsStore();
			const conn = mockConn();
			registerRun(store, { runId: 'run-1', runKey: 'key1', conn });
			registerRun(store, { runId: 'run-2', runKey: 'key2', conn });

			store.settle('key1');

			// 不应移除监听器（run-2 仍活跃）
			expect(conn.off).not.toHaveBeenCalled();
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

		test('lastEventAt=0 时视为事件流已静默', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			// lastEventAt 从未更新（断连后从未收到事件）
			expect(store.runs['run-1'].lastEventAt).toBe(0);

			const serverMessages = [
				{ message: { role: 'assistant', content: 'hello', stopReason: 'stop' } },
			];

			store.reconcileAfterLoad('agent:main:main', serverMessages);

			expect(store.runs['run-1']).toBeUndefined();
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
	// removeByBot
	// =====================================================================

	describe('removeByBot', () => {
		test('清理指定 bot 的所有活跃 runs', () => {
			const store = useAgentRunsStore();
			const conn = mockConn();
			registerRun(store, { runId: 'run-1', runKey: 'key1', botId: '1', conn });
			registerRun(store, { runId: 'run-2', runKey: 'key2', botId: '1', conn });
			registerRun(store, { runId: 'run-3', runKey: 'key3', botId: '2', conn });

			store.removeByBot('1');

			expect(store.runs['run-1']).toBeUndefined();
			expect(store.runs['run-2']).toBeUndefined();
			// bot 2 的 run 不受影响
			expect(store.runs['run-3']).toBeTruthy();
		});

		test('清理指定 bot 的监听器', () => {
			const store = useAgentRunsStore();
			const conn = mockConn();
			registerRun(store, { botId: '1', conn });

			store.removeByBot('1');

			expect(conn.off).toHaveBeenCalledWith('event:agent', expect.any(Function));
		});

		test('无活跃 runs 时不报错', () => {
			const store = useAgentRunsStore();
			store.removeByBot('nonexistent');
		});
	});

	// =====================================================================
	// conn 实例替换
	// =====================================================================

	describe('conn 实例替换', () => {
		test('新 conn 实例应重新注册监听器', () => {
			const store = useAgentRunsStore();
			const connOld = mockConn();
			const connNew = mockConn();

			registerRun(store, { runId: 'run-1', runKey: 'key1', botId: '1', conn: connOld });
			expect(connOld.on).toHaveBeenCalledTimes(1);

			// 模拟 bot 移除后重新添加（conn 实例被替换）
			store.removeByBot('1');

			// 用新 conn 注册新 run
			registerRun(store, { runId: 'run-2', runKey: 'key2', botId: '1', conn: connNew });

			// 新 conn 应注册了监听器
			expect(connNew.on).toHaveBeenCalledWith('event:agent', expect.any(Function));
		});

		test('同一 conn 实例不重复注册', () => {
			const store = useAgentRunsStore();
			const conn = mockConn();

			registerRun(store, { runId: 'run-1', runKey: 'key1', botId: '1', conn });
			registerRun(store, { runId: 'run-2', runKey: 'key2', botId: '1', conn });

			// 同实例只注册一次
			expect(conn.on).toHaveBeenCalledTimes(1);
		});

		test('未经 removeByBot 时 conn 替换也能正确处理', () => {
			const store = useAgentRunsStore();
			const connOld = mockConn();
			const connNew = mockConn();

			// 注册 run-1 用旧 conn
			registerRun(store, { runId: 'run-1', runKey: 'key1', botId: '1', conn: connOld });

			// settle run-1（清理 listener）
			store.settle('key1');
			expect(connOld.off).toHaveBeenCalled();

			// 注册 run-2 用新 conn
			registerRun(store, { runId: 'run-2', runKey: 'key2', botId: '1', conn: connNew });
			expect(connNew.on).toHaveBeenCalledWith('event:agent', expect.any(Function));
		});
	});
});
