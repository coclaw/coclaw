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

		test('未知 runId 的事件被忽略', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			// 不应抛错
			store.__dispatch({ runId: 'unknown-run', stream: 'assistant', data: { text: 'hello' } });
			expect(store.runs['run-1'].streamingMsgs).toHaveLength(2);
		});

		test('lifecycle:end 事件 settle run', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			store.__dispatch({ runId: 'run-1', stream: 'lifecycle', data: { phase: 'end' } });

			expect(store.runs['run-1']).toBeUndefined();
			expect(store.runKeyIndex['agent:main:main']).toBeUndefined();
		});

		test('lifecycle:error 事件 settle run', () => {
			const store = useAgentRunsStore();
			registerRun(store);

			store.__dispatch({ runId: 'run-1', stream: 'lifecycle', data: { phase: 'error' } });

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
});
