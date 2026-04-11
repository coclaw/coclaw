import { describe, test, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

import { chatStoreManager } from './chat-store-manager.js';
import { useAgentRunsStore } from './agent-runs.store.js';

// --- Mocks ---

vi.mock('../services/claw-connection-manager.js', () => ({
	useClawConnections: () => ({
		get: vi.fn(),
		connect: vi.fn(),
		disconnect: vi.fn(),
		syncConnections: vi.fn(),
		disconnectAll: vi.fn(),
	}),
	__resetClawConnections: vi.fn(),
}));

vi.mock('../utils/file-helper.js', () => ({}));

// --- Tests ---

describe('chatStoreManager', () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		chatStoreManager.__reset();
	});

	// =====================================================================
	// get
	// =====================================================================

	describe('get', () => {
		test('创建 session store 并缓存', () => {
			const store = chatStoreManager.get('session:1:main', { clawId: '1', agentId: 'main' });
			expect(store).toBeTruthy();
			expect(store.clawId).toBe('1');
			expect(store.chatSessionKey).toBe('agent:main:main');
			expect(store.topicMode).toBe(false);

			// 再次获取返回同一实例
			const same = chatStoreManager.get('session:1:main');
			expect(same).toBe(store);
		});

		test('创建 topic store', () => {
			const store = chatStoreManager.get('topic:uuid-1', { clawId: '2', agentId: 'research' });
			expect(store.topicMode).toBe(true);
			expect(store.sessionId).toBe('uuid-1');
			expect(store.topicAgentId).toBe('research');
		});

		test('size 正确反映实例数', () => {
			expect(chatStoreManager.size).toBe(0);
			chatStoreManager.get('session:1:main', { clawId: '1' });
			expect(chatStoreManager.size).toBe(1);
			chatStoreManager.get('topic:t1', { clawId: '1' });
			expect(chatStoreManager.size).toBe(2);
		});

		test('topicCount 仅统计 topic 实例', () => {
			chatStoreManager.get('session:1:main', { clawId: '1' });
			chatStoreManager.get('topic:t1', { clawId: '1' });
			chatStoreManager.get('topic:t2', { clawId: '1' });
			expect(chatStoreManager.topicCount).toBe(2);
		});
	});

	// =====================================================================
	// dispose
	// =====================================================================

	describe('dispose', () => {
		test('销毁实例并从索引移除', () => {
			chatStoreManager.get('session:1:main', { clawId: '1' });
			expect(chatStoreManager.size).toBe(1);

			chatStoreManager.dispose('session:1:main');
			expect(chatStoreManager.size).toBe(0);
		});

		test('销毁 topic 实例同时更新 LRU', () => {
			chatStoreManager.get('topic:t1', { clawId: '1' });
			chatStoreManager.get('topic:t2', { clawId: '1' });
			expect(chatStoreManager.topicCount).toBe(2);

			chatStoreManager.dispose('topic:t1');
			expect(chatStoreManager.topicCount).toBe(1);
		});

		test('销毁不存在的 key 不报错', () => {
			chatStoreManager.dispose('nonexistent');
		});
	});

	// =====================================================================
	// LRU 淘汰
	// =====================================================================

	describe('topic LRU eviction', () => {
		test('超过上限时淘汰最久未用的 topic', () => {
			// 创建 11 个 topic（上限为 10）
			for (let i = 0; i < 11; i++) {
				chatStoreManager.get(`topic:t${i}`, { clawId: '1' });
			}
			// 第 1 个（t0）应被淘汰
			expect(chatStoreManager.topicCount).toBe(10);
			expect(chatStoreManager.size).toBe(10);
		});

		test('session 实例不受淘汰影响', () => {
			chatStoreManager.get('session:1:main', { clawId: '1' });
			for (let i = 0; i < 11; i++) {
				chatStoreManager.get(`topic:t${i}`, { clawId: '1' });
			}
			// session 仍在
			expect(chatStoreManager.size).toBe(11); // 1 session + 10 topics
		});

		test('有活跃 run 的 topic 跳过淘汰，淘汰下一个', () => {
			const runsStore = useAgentRunsStore();
			// 创建 10 个 topic
			for (let i = 0; i < 10; i++) {
				chatStoreManager.get(`topic:t${i}`, { clawId: '1' });
			}
			// 让 t0（最旧）有活跃 run → 淘汰时跳过 t0，淘汰 t1
			const t0Store = chatStoreManager.get('topic:t0');
			runsStore.runs['run-t0'] = { status: 'streaming' };
			runsStore.runKeyIndex[t0Store.runKey] = 'run-t0';

			// 创建第 11 个 → 应跳过 t0，淘汰 t1
			chatStoreManager.get('topic:t10', { clawId: '1' });
			expect(chatStoreManager.topicCount).toBe(10);
			// t0 仍在，t1 被淘汰
			expect(chatStoreManager.get('topic:t0')).toBeTruthy();
		});

		test('所有 topic 都有活跃 run 时淘汰被阻断', () => {
			const runsStore = useAgentRunsStore();
			// 创建 10 个 topic，全部设为活跃 run
			for (let i = 0; i < 10; i++) {
				chatStoreManager.get(`topic:t${i}`, { clawId: '1' });
				const s = chatStoreManager.get(`topic:t${i}`);
				runsStore.runs[`run-t${i}`] = { status: 'streaming' };
				runsStore.runKeyIndex[s.runKey] = `run-t${i}`;
			}

			// 预先为 t10 的 runKey 注册活跃 run（runKey = sessionId = 't10'）
			runsStore.runs['run-t10'] = { status: 'streaming' };
			runsStore.runKeyIndex['t10'] = 'run-t10';

			const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
			// 创建第 11 个 → 淘汰被阻断，总数为 11
			chatStoreManager.get('topic:t10', { clawId: '1' });
			expect(chatStoreManager.topicCount).toBe(11);
			expect(debugSpy).toHaveBeenCalledWith(
				expect.stringContaining('eviction blocked'),
				expect.any(Number),
			);
			debugSpy.mockRestore();
		});

		test('重复访问 topic 更新 LRU 顺序', () => {
			for (let i = 0; i < 10; i++) {
				chatStoreManager.get(`topic:t${i}`, { clawId: '1' });
			}
			// 访问 t0（最旧），使其变为最新
			chatStoreManager.get('topic:t0');

			// 创建第 11 个 → 应淘汰 t1（现在最旧）
			chatStoreManager.get('topic:t10', { clawId: '1' });
			expect(chatStoreManager.topicCount).toBe(10);
		});
	});

	// =====================================================================
	// __reset
	// =====================================================================

	// =====================================================================
	// stores
	// =====================================================================

	describe('stores', () => {
		test('返回所有实例的迭代器', () => {
			chatStoreManager.get('session:1:main', { clawId: '1' });
			chatStoreManager.get('topic:t1', { clawId: '1' });
			const all = [...chatStoreManager.stores()];
			expect(all).toHaveLength(2);
		});

		test('空时返回空迭代器', () => {
			expect([...chatStoreManager.stores()]).toHaveLength(0);
		});
	});

	// =====================================================================
	// __reset
	// =====================================================================

	describe('__reset', () => {
		test('清空所有实例', () => {
			chatStoreManager.get('session:1:main', { clawId: '1' });
			chatStoreManager.get('topic:t1', { clawId: '1' });
			chatStoreManager.__reset();

			expect(chatStoreManager.size).toBe(0);
			expect(chatStoreManager.topicCount).toBe(0);
		});
	});

	// =====================================================================
	// 跨 claw 同名 agent 隔离（回归测试，对应 runKey 跨 claw 串 bug）
	// =====================================================================

	describe('cross-claw runKey isolation', () => {
		test('两个不同 clawId 的同名 agent store 拥有独立 runKey', () => {
			const a = chatStoreManager.get('session:A:main', { clawId: 'A', agentId: 'main' });
			const b = chatStoreManager.get('session:B:main', { clawId: 'B', agentId: 'main' });
			// chatSessionKey 相同，但 runKey 必须不同
			expect(a.chatSessionKey).toBe('agent:main:main');
			expect(b.chatSessionKey).toBe('agent:main:main');
			expect(a.runKey).not.toBe(b.runKey);
			expect(a.runKey).toBe('A::agent:main:main');
			expect(b.runKey).toBe('B::agent:main:main');
		});

		test('A 注册 run 不影响 B 的 isSending / allMessages', () => {
			const runsStore = useAgentRunsStore();
			const a = chatStoreManager.get('session:A:main', { clawId: 'A', agentId: 'main' });
			const b = chatStoreManager.get('session:B:main', { clawId: 'B', agentId: 'main' });

			runsStore.register('run-a', {
				clawId: 'A',
				runKey: a.runKey,
				topicMode: false,
				conn: { state: 'connected' },
				streamingMsgs: [
					{ id: '__local_user_1', _local: true, message: { role: 'user', content: 'hi' } },
					{ id: '__local_claw_1', _local: true, _streaming: true, message: { role: 'assistant', content: 'streaming...' } },
				],
			});

			// A 看到自己的 run
			expect(a.isSending).toBe(true);
			expect(a.allMessages).toHaveLength(2);
			// B 应当完全不受影响
			expect(b.isSending).toBe(false);
			expect(b.allMessages).toHaveLength(0);
		});

		test('B 后注册 run 不驱逐 A 的已有 run', () => {
			const runsStore = useAgentRunsStore();
			const a = chatStoreManager.get('session:A:main', { clawId: 'A', agentId: 'main' });
			const b = chatStoreManager.get('session:B:main', { clawId: 'B', agentId: 'main' });

			runsStore.register('run-a', {
				clawId: 'A', runKey: a.runKey, topicMode: false,
				conn: { state: 'connected' }, streamingMsgs: [],
			});
			runsStore.register('run-b', {
				clawId: 'B', runKey: b.runKey, topicMode: false,
				conn: { state: 'connected' }, streamingMsgs: [],
			});

			// 两个 run 共存
			expect(runsStore.runs['run-a']).toBeTruthy();
			expect(runsStore.runs['run-b']).toBeTruthy();
			expect(runsStore.runKeyIndex[a.runKey]).toBe('run-a');
			expect(runsStore.runKeyIndex[b.runKey]).toBe('run-b');
		});
	});
});
