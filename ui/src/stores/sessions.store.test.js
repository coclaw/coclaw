import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { useSessionsStore, __resetSessionsInternals } from './sessions.store.js';

const mockConnections = new Map();

vi.mock('../services/claw-connection-manager.js', () => ({
	useClawConnections: () => ({
		get: (clawId) => mockConnections.get(String(clawId)),
		connect: vi.fn(),
		disconnect: vi.fn(),
		syncConnections: vi.fn(),
		disconnectAll: vi.fn(),
	}),
	__resetClawConnections: vi.fn(),
}));

vi.mock('../services/claws.api.js', () => ({
	listClaws: vi.fn().mockResolvedValue([]),
}));

import { useAgentsStore } from './agents.store.js';
import { useClawsStore } from './claws.store.js';

/**
 * 创建模拟 sessions.list RPC 的连接。
 * @param {object[]} sessions - 形如 [{ key, sessionId, updatedAt }] 的 GatewaySessionRow 数组
 */
function mockConn(sessions = []) {
	return {
		request: vi.fn().mockImplementation((method) => {
			if (method === 'sessions.list') {
				return Promise.resolve({ sessions });
			}
			return Promise.resolve({});
		}),
		on: vi.fn(),
		off: vi.fn(),
	};
}

/** 注册 mock conn 并设置 clawsStore 中 claw 的 dcReady */
function setConn(clawId, conn, { dcReady = true } = {}) {
	mockConnections.set(String(clawId), conn);
	const clawsStore = useClawsStore();
	if (!clawsStore.byId[String(clawId)]) {
		clawsStore.byId[String(clawId)] = { id: String(clawId), dcReady };
	} else {
		clawsStore.byId[String(clawId)].dcReady = dcReady;
	}
}

/** 构造一条 GatewaySessionRow */
function row(key, sessionId, updatedAt) {
	return { key, sessionId, updatedAt };
}

describe('sessions store', () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		mockConnections.clear();
		__resetSessionsInternals();
		vi.clearAllMocks();
	});

	test('loadAllSessions 无 claws 时返回空', async () => {
		const store = useSessionsStore();
		await store.loadAllSessions();
		expect(store.items).toEqual([]);
	});

	test('loadAllSessions 全部 claws 离线时不动 items', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot 1', online: false }]);

		const store = useSessionsStore();
		await store.loadAllSessions();
		expect(store.items).toEqual([]);
	});

	test('loadAllSessions 多 claw 各拉 sessions.list 一次，按 agent 切片', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([
			{ id: 'bot-1', name: 'Bot 1', online: true },
			{ id: 'bot-2', name: 'Bot 2', online: true },
		]);

		const conn1 = mockConn([row('agent:main:main', 'sid-1', 1000)]);
		const conn2 = mockConn([row('agent:main:main', 'sid-2', 2000)]);
		setConn('bot-1', conn1);
		setConn('bot-2', conn2);

		const store = useSessionsStore();
		await store.loadAllSessions();

		expect(store.items).toHaveLength(2);
		const it1 = store.items.find((s) => s.clawId === 'bot-1');
		expect(it1).toMatchObject({
			sessionId: 'sid-1',
			sessionKey: 'agent:main:main',
			agentId: 'main',
			updatedAt: 1000,
			bumpedAt: null,
		});
		const it2 = store.items.find((s) => s.clawId === 'bot-2');
		expect(it2.updatedAt).toBe(2000);
		// 每只 claw 只调用一次 sessions.list
		expect(conn1.request).toHaveBeenCalledWith('sessions.list', {}, { timeout: 60_000 });
		expect(conn1.request).toHaveBeenCalledTimes(1);
		expect(conn2.request).toHaveBeenCalledTimes(1);
	});

	test('row 缺 sessionId（仅有 updatedAt）：updatedAt 仍计入，sessionId 留空', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);

		const conn = mockConn([
			{ key: 'agent:main:main', sessionId: '', updatedAt: 1234 },
			{ key: 'agent:main:sess-x', sessionId: 'orph', updatedAt: 5000 },
		]);
		setConn('bot-1', conn);

		const store = useSessionsStore();
		await store.loadAllSessions();

		expect(store.items).toHaveLength(1);
		expect(store.items[0]).toMatchObject({
			sessionId: '', // live key 的 sessionId 为空 → 占位空串
			updatedAt: 5000, // 但 max(updatedAt) 仍有效
		});
	});

	test('row 缺 updatedAt（仅有 sessionId）：sessionId 仍写入，updatedAt 落底', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);

		const conn = mockConn([
			{ key: 'agent:main:main', sessionId: 'sid-live', updatedAt: null },
		]);
		setConn('bot-1', conn);

		const store = useSessionsStore();
		await store.loadAllSessions();

		// 只有 sessionId、无 updatedAt → 保留为可访问条目；updatedAt fallback 为 null
		expect(store.items).toHaveLength(1);
		expect(store.items[0]).toMatchObject({
			sessionId: 'sid-live',
			updatedAt: null,
		});
	});

	test('row 全缺（既没 sessionId 也没 updatedAt）：跳过该 agent', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);

		const conn = mockConn([
			{ key: 'agent:main:main', sessionId: '', updatedAt: null },
		]);
		setConn('bot-1', conn);

		const store = useSessionsStore();
		await store.loadAllSessions();

		expect(store.items).toHaveLength(0);
	});

	test('updatedAt 取该 agent 名下所有 session 的 max', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);

		// 同一 agent 'main' 下有 live + 两个 orphan，各自不同 updatedAt
		const conn = mockConn([
			row('agent:main:main', 'sid-live', 5000),
			row('agent:main:sess-1', 'sid-orph-1', 9000),
			row('agent:main:sess-2', 'sid-orph-2', 7000),
		]);
		setConn('bot-1', conn);

		const store = useSessionsStore();
		await store.loadAllSessions();

		expect(store.items).toHaveLength(1);
		expect(store.items[0]).toMatchObject({
			sessionId: 'sid-live',
			updatedAt: 9000,
		});
	});

	test('多 agent：各按 prefix 切片、互不串', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);

		const agentsStore = useAgentsStore();
		agentsStore.byClaw['bot-1'] = {
			agents: [{ id: 'main' }, { id: 'ops' }],
			defaultId: 'main',
			loading: false,
			fetched: true,
		};

		const conn = mockConn([
			row('agent:main:main', 'sid-main', 1000),
			row('agent:ops:main', 'sid-ops', 2000),
			row('agent:ops:sess-x', 'sid-ops-orph', 3000),
		]);
		setConn('bot-1', conn);

		const store = useSessionsStore();
		await store.loadAllSessions();

		expect(store.items).toHaveLength(2);
		expect(store.items.find((s) => s.agentId === 'main').updatedAt).toBe(1000);
		expect(store.items.find((s) => s.agentId === 'ops').updatedAt).toBe(3000);
	});

	test('agentsStore 未加载时 fallback 到 main', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);

		const conn = mockConn([row('agent:main:main', 'sid-1', 1234)]);
		setConn('bot-1', conn);

		const store = useSessionsStore();
		await store.loadAllSessions();

		expect(store.items).toHaveLength(1);
		expect(store.items[0].agentId).toBe('main');
		expect(store.items[0].sessionKey).toBe('agent:main:main');
	});

	test('sessions.list 失败的 claw 保留旧 sessions，其它 claw 仍刷新', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([
			{ id: 'bot-ok', name: 'OK', online: true },
			{ id: 'bot-fail', name: 'Fail', online: true },
		]);

		const connOk = mockConn([row('agent:main:main', 'sid-ok', 1000)]);
		const connFail = {
			request: vi.fn().mockRejectedValue(new Error('boom')),
			on: vi.fn(),
			off: vi.fn(),
		};
		setConn('bot-ok', connOk);
		setConn('bot-fail', connFail);

		const store = useSessionsStore();
		// 先种入 bot-fail 的旧数据
		store.setSessions([
			{ sessionId: 'sid-fail-old', sessionKey: 'agent:main:main', clawId: 'bot-fail', agentId: 'main', updatedAt: 500, bumpedAt: null },
		]);

		await store.loadAllSessions();

		expect(store.items).toHaveLength(2);
		expect(store.items.find((s) => s.clawId === 'bot-ok').sessionId).toBe('sid-ok');
		// bot-fail fetch 失败 → 旧条目保留
		expect(store.items.find((s) => s.clawId === 'bot-fail').sessionId).toBe('sid-fail-old');
	});

	test('某 agent 完全无 session（list 返回空切片）→ 该 agent 不进 items', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);

		const agentsStore = useAgentsStore();
		agentsStore.byClaw['bot-1'] = {
			agents: [{ id: 'main' }, { id: 'unused' }],
			defaultId: 'main',
			loading: false,
			fetched: true,
		};

		const conn = mockConn([row('agent:main:main', 'sid-main', 1000)]);
		setConn('bot-1', conn);

		const store = useSessionsStore();
		await store.loadAllSessions();

		expect(store.items).toHaveLength(1);
		expect(store.items[0].agentId).toBe('main');
	});

	test('clawId 归一化为 string', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 42, name: 'B1', online: true }]);

		const conn = mockConn([row('agent:main:main', 'sid-1', 1)]);
		setConn('42', conn);

		const store = useSessionsStore();
		await store.loadAllSessions();

		expect(store.items).toHaveLength(1);
		expect(store.items[0].clawId).toBe('42');
		expect(typeof store.items[0].clawId).toBe('string');
	});

	test('并发 loadAllSessions 合流', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'B', online: true }]);

		const conn = mockConn([row('agent:main:main', 'sid-1', 1)]);
		setConn('bot-1', conn);

		const store = useSessionsStore();
		await Promise.all([store.loadAllSessions(), store.loadAllSessions()]);

		expect(conn.request).toHaveBeenCalledTimes(1);
		expect(store.items).toHaveLength(1);
	});

	test('removeSessionsByClawId 移除指定 claw 所有 sessions', () => {
		const store = useSessionsStore();
		store.setSessions([
			{ sessionId: 's1', sessionKey: 'agent:main:main', clawId: 'bot-1', agentId: 'main', updatedAt: 1, bumpedAt: null },
			{ sessionId: 's2', sessionKey: 'agent:main:main', clawId: 'bot-2', agentId: 'main', updatedAt: 2, bumpedAt: null },
		]);

		store.removeSessionsByClawId('bot-1');

		expect(store.items).toHaveLength(1);
		expect(store.items[0].clawId).toBe('bot-2');
	});

	test('增量合并：未查询 claw 旧 sessions 保留，已移除的 claw 旧 sessions 清除', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([
			{ id: 'bot-1', name: 'Bot 1', online: true },
			{ id: 'bot-2', name: 'Bot 2', online: true },
		]);

		const conn1 = mockConn([row('agent:main:main', 'sid-1', 1)]);
		const conn2 = mockConn([row('agent:main:main', 'sid-2', 2)]);
		setConn('bot-1', conn1);
		setConn('bot-2', conn2);

		const store = useSessionsStore();
		await store.loadAllSessions();
		expect(store.items).toHaveLength(2);

		// bot-2 离线 → 保留旧
		clawsStore.byId['bot-2'].dcReady = false;
		await store.loadAllSessions();
		expect(store.items).toHaveLength(2);

		// bot-2 被移除 → 旧清除
		delete clawsStore.byId['bot-2'];
		mockConnections.delete('bot-2');
		await store.loadAllSessions();
		expect(store.items).toHaveLength(1);
		expect(store.items[0].clawId).toBe('bot-1');
	});

	test('已查询 claw 但 server 真空（list 空）→ 该 claw 旧条目清空（无 bumpedAt 时）', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);
		const store = useSessionsStore();
		store.setSessions([{
			sessionId: 'sid-stale', sessionKey: 'agent:main:main',
			clawId: 'bot-1', agentId: 'main', updatedAt: 100, bumpedAt: null,
		}]);

		const conn = mockConn([]); // server 全空
		setConn('bot-1', conn);

		await store.loadAllSessions();

		expect(store.items).toHaveLength(0);
	});

	describe('bumpActivity', () => {
		test('已存在 item 时纯覆盖 bumpedAt，不动 updatedAt', () => {
			const store = useSessionsStore();
			store.setSessions([{
				sessionId: 'sid', sessionKey: 'agent:main:main',
				clawId: 'bot-1', agentId: 'main', updatedAt: 1000, bumpedAt: null,
			}]);

			store.bumpActivity('bot-1', 'main', 5000);

			expect(store.items[0].bumpedAt).toBe(5000);
			expect(store.items[0].updatedAt).toBe(1000);
		});

		test('不存在 item 时 upsert 占位条目（updatedAt=null）', () => {
			const store = useSessionsStore();
			store.bumpActivity('bot-1', 'main', 7777);

			expect(store.items).toHaveLength(1);
			expect(store.items[0]).toMatchObject({
				sessionId: '',
				sessionKey: 'agent:main:main',
				clawId: 'bot-1',
				agentId: 'main',
				updatedAt: null,
				bumpedAt: 7777,
			});
		});

		test('clawId 归一化为 string', () => {
			const store = useSessionsStore();
			store.bumpActivity(42, 'main', 1);
			expect(store.items[0].clawId).toBe('42');
			expect(typeof store.items[0].clawId).toBe('string');
		});

		test('缺 clawId / agentId 时安全跳过', () => {
			const store = useSessionsStore();
			store.bumpActivity('', 'main', 1);
			store.bumpActivity('bot-1', '', 1);
			expect(store.items).toHaveLength(0);
		});

		test('默认 ts 用 Date.now()', () => {
			const store = useSessionsStore();
			const before = Date.now();
			store.bumpActivity('bot-1', 'main');
			const after = Date.now();
			expect(store.items[0].bumpedAt).toBeGreaterThanOrEqual(before);
			expect(store.items[0].bumpedAt).toBeLessThanOrEqual(after);
		});
	});

	describe('sessions.list refresh 不冲掉本地 bumpedAt', () => {
		test('已查询 claw 中 server 没返回但本地有 bumpedAt 的 chat：保留为 bump-only', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);

			const store = useSessionsStore();
			// 模拟用户刚 bump 完，server 还没把消息写盘
			store.bumpActivity('bot-1', 'main', 9999);

			const conn = mockConn([]); // server 真空
			setConn('bot-1', conn);

			await store.loadAllSessions();

			expect(store.items).toHaveLength(1);
			expect(store.items[0]).toMatchObject({
				clawId: 'bot-1',
				agentId: 'main',
				sessionId: '',
				updatedAt: null,
				bumpedAt: 9999,
			});
		});

		test('server 返回了该 chat 的新数据：保留 bumpedAt + 写入 updatedAt', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);

			const store = useSessionsStore();
			store.bumpActivity('bot-1', 'main', 9999);

			const conn = mockConn([row('agent:main:main', 'sid-new', 5000)]);
			setConn('bot-1', conn);

			await store.loadAllSessions();

			expect(store.items).toHaveLength(1);
			expect(store.items[0]).toMatchObject({
				sessionId: 'sid-new',
				clawId: 'bot-1',
				agentId: 'main',
				updatedAt: 5000,
				bumpedAt: 9999,
			});
		});
	});

	describe('getActivity getter', () => {
		test('返回 max(updatedAt, bumpedAt)', () => {
			const store = useSessionsStore();
			store.setSessions([
				{ sessionId: 'a', sessionKey: 'agent:main:main', clawId: 'b1', agentId: 'main', updatedAt: 100, bumpedAt: 5000 },
				{ sessionId: 'b', sessionKey: 'agent:main:main', clawId: 'b2', agentId: 'main', updatedAt: 8000, bumpedAt: null },
				{ sessionId: 'c', sessionKey: 'agent:foo:main', clawId: 'b1', agentId: 'foo', updatedAt: null, bumpedAt: 3000 },
			]);

			expect(store.getActivity('b1', 'main')).toBe(5000);
			expect(store.getActivity('b2', 'main')).toBe(8000);
			expect(store.getActivity('b1', 'foo')).toBe(3000);
		});

		test('查不到对应 chat 返回 0', () => {
			const store = useSessionsStore();
			expect(store.getActivity('nope', 'main')).toBe(0);
		});
	});

	describe('loadSessionsForClaw (per-claw)', () => {
		test('只刷新指定 claw，其它 claw 旧数据保留', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([
				{ id: 'bot-1', name: 'Bot 1', online: true },
				{ id: 'bot-2', name: 'Bot 2', online: true },
			]);
			const conn1 = mockConn([row('agent:main:main', 'sid-1', 1000)]);
			const conn2 = mockConn([row('agent:main:main', 'sid-2', 2000)]);
			setConn('bot-1', conn1);
			setConn('bot-2', conn2);

			const store = useSessionsStore();
			await store.loadAllSessions();
			expect(store.items).toHaveLength(2);

			conn1.request.mockResolvedValue({
				sessions: [row('agent:main:main', 'sid-1-new', 1500)],
			});
			await store.loadSessionsForClaw('bot-1');

			expect(store.items).toHaveLength(2);
			expect(store.items.find((s) => s.clawId === 'bot-1').sessionId).toBe('sid-1-new');
			expect(store.items.find((s) => s.clawId === 'bot-2').sessionId).toBe('sid-2');
			expect(conn2.request).toHaveBeenCalledTimes(1);
		});

		test('无连接时跳过', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B', online: true }]);
			const conn = mockConn([row('agent:main:main', 'sid-1', 1)]);
			setConn('bot-1', conn);

			const store = useSessionsStore();
			await store.loadAllSessions();

			clawsStore.byId['bot-1'].dcReady = false;
			await store.loadSessionsForClaw('bot-1');
			expect(conn.request).toHaveBeenCalledTimes(1);
		});

		test('同 claw 并发合流到同一 promise', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B', online: true }]);
			const conn = mockConn([row('agent:main:main', 'sid-1', 1)]);
			setConn('bot-1', conn);

			const store = useSessionsStore();
			await Promise.all([
				store.loadSessionsForClaw('bot-1'),
				store.loadSessionsForClaw('bot-1'),
			]);
			expect(conn.request).toHaveBeenCalledTimes(1);
		});

		test('fetch 期间 claw 被移除：不写回幽灵数据', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B', online: true }]);
			let resolveReq;
			const conn = {
				request: vi.fn().mockImplementation(() => new Promise((r) => { resolveReq = r; })),
				on: vi.fn(),
				off: vi.fn(),
			};
			setConn('bot-1', conn);

			const store = useSessionsStore();
			const inflight = store.loadSessionsForClaw('bot-1');

			delete clawsStore.byId['bot-1'];
			store.removeSessionsByClawId('bot-1');

			resolveReq({ sessions: [row('agent:main:main', 'sid-late', 1)] });
			await inflight;

			expect(store.items.find((s) => s.clawId === 'bot-1')).toBeUndefined();
		});

		test('removeSessionsByClawId 同步清飞行中 dedup（同 id 重绑后新调用走独立请求）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);

			let resolveOld;
			const oldConn = {
				request: vi.fn().mockImplementation(() => new Promise((r) => { resolveOld = r; })),
				on: vi.fn(),
				off: vi.fn(),
			};
			setConn('bot-1', oldConn);

			const store = useSessionsStore();
			const oldPromise = store.loadSessionsForClaw('bot-1');
			expect(oldConn.request).toHaveBeenCalledTimes(1);

			delete clawsStore.byId['bot-1'];
			store.removeSessionsByClawId('bot-1');
			clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);
			const newConn = mockConn([row('agent:main:main', 'sid-new', 1)]);
			setConn('bot-1', newConn);

			const newPromise = store.loadSessionsForClaw('bot-1');
			expect(newConn.request).toHaveBeenCalledTimes(1);
			await newPromise;
			expect(store.items.find((s) => s.clawId === 'bot-1')?.sessionId).toBe('sid-new');

			resolveOld({ sessions: [] });
			await oldPromise;
		});

		test('__doLoadAll：fetch 期间 conn 消失，不清空旧 sessions', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);
			const store = useSessionsStore();
			store.setSessions([{
				sessionId: 'sid-old', sessionKey: 'agent:main:main',
				clawId: 'bot-1', agentId: 'main', updatedAt: 100, bumpedAt: null,
			}]);

			// sessions.list 返回空 + 同步抹掉 conn → result-time getReadyConn 复核应跳过该 claw
			const conn = {
				request: vi.fn().mockImplementation(() => {
					mockConnections.delete('bot-1');
					return Promise.resolve({ sessions: [] });
				}),
				on: vi.fn(),
				off: vi.fn(),
			};
			setConn('bot-1', conn);

			await store.loadAllSessions();
			expect(store.items.find((s) => s.clawId === 'bot-1')?.sessionId).toBe('sid-old');
		});
	});
});
