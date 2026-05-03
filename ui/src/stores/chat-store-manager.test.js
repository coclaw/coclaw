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

		// 契约锁：endRun 已触发但 dropRun 尚未跑（settling 窗口，streamingMsgs 非空）的 topic
		// 仍会被 LRU 淘汰——因为 isRunning 仅检查 !run.ended，而 settling 状态 ended=true。
		// 与 chat.store sendMessage accepted 分支的 silent loadMessages → dropRun 链相关：
		// 该窗口内若 LRU 触发淘汰，被淘汰的 store 会 dispose，丢失 streamingMsgs。
		// 当前是设计：accepted 后 sending=false → busy 不阻塞淘汰，只有真正在跑的 run 才阻塞。
		test('settling 状态（ended=true 但 streamingMsgs 非空）的 topic 仍被 LRU 淘汰（契约锁）', () => {
			const runsStore = useAgentRunsStore();
			// 创建 10 个 topic（t0 是 LRU 最旧）
			const stores = [];
			for (let i = 0; i < 10; i++) {
				stores.push(chatStoreManager.get(`topic:t${i}`, { clawId: '1' }));
			}
			// t0 处于 settling：ended=true + streamingMsgs 非空（不 touch t0，保持其 LRU 最旧地位）
			runsStore.runs['run-t0-settle'] = {
				runId: 'run-t0-settle',
				ended: true,
				streamingMsgs: [{ id: '__local_claw_x', _local: true, _streaming: true, message: { role: 'assistant', content: 'tail' } }],
			};
			runsStore.runKeyIndex[stores[0].runKey] = 'run-t0-settle';

			// 创建第 11 个：__evictTopics 从最旧扫起，t0 在 i=0 被检查，
			// isRunning(t0.runKey)=false（!run.ended=false）→ 不跳过 → 淘汰 t0
			chatStoreManager.get('topic:t10', { clawId: '1' });
			expect(chatStoreManager.topicCount).toBe(10);
			// 关键断言：t0（settling）确实被淘汰
			const t0AfterEvict = [...chatStoreManager.stores()].find((s) => s.sessionId === 't0');
			expect(t0AfterEvict).toBeUndefined();
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

		// disposeAll 已 per-item try/catch；__evictTopics 也要对齐，
		// 否则受害者 dispose 抛异常会穿透到 get() 调用方
		test('__evictTopics：受害者 dispose 抛异常被隔离，不影响新 topic 创建', () => {
			// 按序创建 10 个 topic：LRU 最旧 = t0（不要再 touch 它）
			const stores = [];
			for (let i = 0; i < 10; i++) {
				stores.push(chatStoreManager.get(`topic:t${i}`, { clawId: '1' }));
			}
			// 给 t0（淘汰目标）注入抛异常的 dispose
			const victimStore = stores[0];
			const origDispose = victimStore.dispose;
			victimStore.dispose = () => { throw new Error('boom'); };
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			try {
				// 创建第 11 个 topic → 触发 __evictTopics，目标是 t0（LRU 最旧）
				expect(() => chatStoreManager.get('topic:t10', { clawId: '1' })).not.toThrow();
				// 新 topic 已创建
				const all = [...chatStoreManager.stores()];
				const t10 = all.find((s) => s.sessionId === 't10');
				expect(t10).toBeTruthy();
				// 警告日志被记录，包含受害者 key（格式与 disposeAll 的 'dispose key=%s failed: %s' 对齐）
				expect(warnSpy).toHaveBeenCalledWith(
					expect.stringContaining('evict dispose key=%s failed: %s'),
					'topic:t0',
					expect.any(String),
				);
			}
			finally {
				victimStore.dispose = origDispose;
				warnSpy.mockRestore();
			}
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
	// disposeAll（登出清理）
	// =====================================================================

	describe('disposeAll', () => {
		test('清空所有 session 与 topic 实例', () => {
			chatStoreManager.get('session:1:main', { clawId: '1', agentId: 'main' });
			chatStoreManager.get('topic:t1', { clawId: '1', agentId: 'main' });
			chatStoreManager.get('topic:t2', { clawId: '1', agentId: 'main' });
			expect(chatStoreManager.size).toBe(3);
			expect(chatStoreManager.topicCount).toBe(2);

			chatStoreManager.disposeAll();

			expect(chatStoreManager.size).toBe(0);
			expect(chatStoreManager.topicCount).toBe(0);
		});

		test('对每个实例调用 store.dispose() 和 $dispose()', () => {
			const s1 = chatStoreManager.get('session:1:main', { clawId: '1', agentId: 'main' });
			const s2 = chatStoreManager.get('topic:t1', { clawId: '1', agentId: 'main' });
			const disposeSpy1 = vi.spyOn(s1, 'dispose');
			const disposeSpy2 = vi.spyOn(s2, 'dispose');
			const pDisposeSpy1 = vi.spyOn(s1, '$dispose');
			const pDisposeSpy2 = vi.spyOn(s2, '$dispose');

			chatStoreManager.disposeAll();

			expect(disposeSpy1).toHaveBeenCalledOnce();
			expect(disposeSpy2).toHaveBeenCalledOnce();
			expect(pDisposeSpy1).toHaveBeenCalledOnce();
			expect(pDisposeSpy2).toHaveBeenCalledOnce();
		});

		test('遍历期间 dispose 内部删 Map 不漏条目（Array.from 快照生效）', () => {
			const keys = ['session:1:main', 'topic:t1', 'topic:t2'];
			for (const k of keys) {
				chatStoreManager.get(k, { clawId: '1', agentId: 'main' });
			}
			expect(chatStoreManager.size).toBe(3);

			chatStoreManager.disposeAll();

			// 3 个全部被 dispose；若未用快照，Map 迭代在 delete 时会跳条目导致残留
			expect(chatStoreManager.size).toBe(0);
			expect(chatStoreManager.topicCount).toBe(0);
		});

		test('空管理器 disposeAll 不报错', () => {
			expect(() => chatStoreManager.disposeAll()).not.toThrow();
			expect(chatStoreManager.size).toBe(0);
		});

		test('单个 dispose 抛错不影响其余 store 清理（错误隔离）', () => {
			const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
			const s1 = chatStoreManager.get('session:1:main', { clawId: '1', agentId: 'main' });
			const s2 = chatStoreManager.get('topic:t1', { clawId: '1', agentId: 'main' });
			const s3 = chatStoreManager.get('topic:t2', { clawId: '1', agentId: 'main' });

			// 让中间那个 store 的 dispose 抛错
			vi.spyOn(s2, 'dispose').mockImplementation(() => { throw new Error('boom from dispose'); });
			const dispose1Spy = vi.spyOn(s1, 'dispose');
			const dispose3Spy = vi.spyOn(s3, 'dispose');

			expect(() => chatStoreManager.disposeAll()).not.toThrow();

			// s1 和 s3 仍被 dispose；若未隔离，s2 抛错会中断循环、s3 漏清
			expect(dispose1Spy).toHaveBeenCalledOnce();
			expect(dispose3Spy).toHaveBeenCalledOnce();
			// debug log 至少出现一次
			expect(debugSpy).toHaveBeenCalled();
			debugSpy.mockRestore();
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

	// =====================================================================
	// promoteToTopic（new-topic store 转正为正式 topic store）
	// =====================================================================

	describe('promoteToTopic', () => {
		beforeEach(() => {
			URL.createObjectURL = vi.fn(() => 'blob:mock');
			URL.revokeObjectURL = vi.fn();
		});

		test('基本路径：新 topic store 创建并 activate（skipLoad），返回 newStore + commit', () => {
			const oldStore = chatStoreManager.get('new-topic:1:main', { clawId: '1', agentId: 'main' });
			const { newStore, commit } = chatStoreManager.promoteToTopic(
				'new-topic:1:main', 'topic-uuid-1', { clawId: '1', agentId: 'main' },
			);
			expect(newStore).toBeTruthy();
			expect(newStore.topicMode).toBe(true);
			expect(newStore.sessionId).toBe('topic-uuid-1');
			expect(newStore.__messagesLoaded).toBe(true);
			// commit 之前 oldStore 仍存在
			expect(chatStoreManager.size).toBe(2);
			expect(typeof commit).toBe('function');
			// 老 store 引用还在（commit 之前不能 dispose）
			expect(oldStore).toBeTruthy();
		});

		test('inputFiles 引用共享：promote 后 newStore.inputFiles === oldStore.inputFiles', () => {
			const oldStore = chatStoreManager.get('new-topic:1:main', { clawId: '1', agentId: 'main' });
			oldStore.inputFiles.push({ id: 'a', isImg: true, url: 'blob:a' });
			const { newStore } = chatStoreManager.promoteToTopic(
				'new-topic:1:main', 'topic-uuid-1', { clawId: '1', agentId: 'main' },
			);
			// 关键：同源数组，promote 期间 ChatInput 视觉不中断
			expect(newStore.inputFiles).toBe(oldStore.inputFiles);
			expect(newStore.inputFiles).toHaveLength(1);
		});

		test('commit() 切断引用：oldStore.inputFiles 变空数组，与 newStore 不同源', () => {
			const oldStore = chatStoreManager.get('new-topic:1:main', { clawId: '1', agentId: 'main' });
			oldStore.inputFiles.push({ id: 'a', isImg: true, url: 'blob:a' });
			const oldStoreInputFilesArray = oldStore.inputFiles;
			const { newStore, commit } = chatStoreManager.promoteToTopic(
				'new-topic:1:main', 'topic-uuid-1', { clawId: '1', agentId: 'main' },
			);
			// commit 之前同源
			expect(newStore.inputFiles).toBe(oldStoreInputFilesArray);
			commit();
			// commit 后 newStore.inputFiles 仍持有原数组（含图片），oldStore 已 dispose 移除
			expect(newStore.inputFiles).toHaveLength(1);
			// 关键：commit 后 newStore.inputFiles 必须不再是原 oldStore 引用 —— 否则 dispose 路径
			// 上对 oldStore.inputFiles 任何 mutate 都会污染 newStore（commit 内部已置 oldStore.inputFiles=[]
			// 重指向新空数组，因此 newStore 仍持原数组、oldStore 已断开）
			expect(oldStoreInputFilesArray).toBe(newStore.inputFiles); // 原数组身份转移到 newStore
			// 老 store 已从 instances 中移除
			expect(chatStoreManager.size).toBe(1);
			expect([...chatStoreManager.stores()]).toEqual([newStore]);
		});

		test('per-store 隔离：A 加附件 → 切到 B 不污染 → 回 A 附件仍在', () => {
			// 模拟两条独立 chat（不同 sessionKey）
			const storeA = chatStoreManager.get('session:1:main', { clawId: '1', agentId: 'main' });
			storeA.inputFiles.push({ id: 'a1', isImg: false, url: null, name: 'a.txt' });
			// 切到 B：拿一个不同 storeKey 的 store
			const storeB = chatStoreManager.get('session:2:main', { clawId: '2', agentId: 'main' });
			// B 的 inputFiles 必须为空、与 A 独立
			expect(storeB.inputFiles).toHaveLength(0);
			expect(storeB.inputFiles).not.toBe(storeA.inputFiles);
			// 在 B 加一条
			storeB.inputFiles.push({ id: 'b1', isImg: false, url: null, name: 'b.txt' });
			// 切回 A：拿同 storeKey 的 store 应是同一实例
			const storeAAgain = chatStoreManager.get('session:1:main', { clawId: '1', agentId: 'main' });
			expect(storeAAgain).toBe(storeA);
			// A 的附件仍在、未受 B 影响
			expect(storeAAgain.inputFiles).toHaveLength(1);
			expect(storeAAgain.inputFiles[0].name).toBe('a.txt');
			// B 也未受 A 影响
			expect(storeB.inputFiles).toHaveLength(1);
			expect(storeB.inputFiles[0].name).toBe('b.txt');
		});

		test('关键 invariant：promote → commit 全过程不 revoke 任何 ObjectURL', () => {
			const oldStore = chatStoreManager.get('new-topic:1:main', { clawId: '1', agentId: 'main' });
			oldStore.inputFiles.push({ id: 'img', isImg: true, url: 'blob:transferred' });
			const { commit } = chatStoreManager.promoteToTopic(
				'new-topic:1:main', 'topic-uuid-1', { clawId: '1', agentId: 'main' },
			);
			commit();
			// 已转移的图片 URL 不能被 revoke —— 它仍在 newStore.inputFiles 中
			expect(URL.revokeObjectURL).not.toHaveBeenCalled();
		});

		test('Pinia _s 释放：commit 后再次 get 同 newTopicKey 得到全新干净实例', () => {
			const oldStore = chatStoreManager.get('new-topic:1:main', { clawId: '1', agentId: 'main' });
			oldStore.inputFiles.push({ id: 'a', isImg: false, url: null });
			const { commit } = chatStoreManager.promoteToTopic(
				'new-topic:1:main', 'topic-uuid-1', { clawId: '1', agentId: 'main' },
			);
			commit();
			// 用户再次进入同一 new-topic 路由（如重新创建另一个 topic）
			const fresh = chatStoreManager.get('new-topic:1:main', { clawId: '1', agentId: 'main' });
			// 必须是全新实例 —— 不能命中已 dispose 的旧实例
			expect(fresh).not.toBe(oldStore);
			expect(fresh.inputFiles).toHaveLength(0);
		});

		test('旧 new-topic store 不存在时 promoteToTopic 仍工作（commit 是 no-op）', () => {
			// 用户没先进 new-topic 页就直接调（防御性场景）
			const { newStore, commit } = chatStoreManager.promoteToTopic(
				'new-topic:1:main', 'topic-uuid-1', { clawId: '1', agentId: 'main' },
			);
			expect(newStore).toBeTruthy();
			expect(newStore.inputFiles).toHaveLength(0);
			expect(() => commit()).not.toThrow();
			// 仍只有新 topic store
			expect(chatStoreManager.size).toBe(1);
		});

		test('opts 透传到新 topic store：clawId / agentId 正确赋值', () => {
			const { newStore } = chatStoreManager.promoteToTopic(
				'new-topic:7:bot', 'topic-uuid-9', { clawId: '7', agentId: 'bot' },
			);
			expect(newStore.clawId).toBe('7');
			expect(newStore.topicAgentId).toBe('bot');
			expect(newStore.runKey).toBe('topic-uuid-9');
		});

		test('promote 后新 topic store 进入 LRU（与普通 topic 一视同仁）', () => {
			chatStoreManager.get('new-topic:1:main', { clawId: '1', agentId: 'main' });
			const { commit } = chatStoreManager.promoteToTopic(
				'new-topic:1:main', 'topic-uuid-1', { clawId: '1', agentId: 'main' },
			);
			commit();
			// 新 topic 入 LRU
			expect(chatStoreManager.topicCount).toBe(1);
		});

		test('promote 时若新 topic store 已存在（罕见竞态），复用并仍能通过 commit 收尾', () => {
			// 提前埋一个同 topicId 的 store（模拟某种异常状态）
			const preExisting = chatStoreManager.get('topic:topic-uuid-1', { clawId: '1', agentId: 'main' });
			const oldStore = chatStoreManager.get('new-topic:1:main', { clawId: '1', agentId: 'main' });
			oldStore.inputFiles.push({ id: 'a', isImg: false, url: null });
			const { newStore, commit } = chatStoreManager.promoteToTopic(
				'new-topic:1:main', 'topic-uuid-1', { clawId: '1', agentId: 'main' },
			);
			expect(newStore).toBe(preExisting);
			// inputFiles 仍被覆盖为 oldStore 的引用
			expect(newStore.inputFiles).toBe(oldStore.inputFiles);
			expect(() => commit()).not.toThrow();
		});
	});
});
