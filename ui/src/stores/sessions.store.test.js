// @vitest-environment node
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

		// 跨入口合流：loadAllSessions 内部对每个 claw 调 loadSessionsForClaw，与外部直接
		// 调 loadSessionsForClaw 共享同一份 _perClawLoading 飞行缓存，并发时只发一次 RPC
		test('跨入口并发：loadAllSessions 与 loadSessionsForClaw 同 claw 合流到一次 RPC', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);

			let resolveReq;
			const conn = {
				request: vi.fn().mockImplementation(() => new Promise((r) => { resolveReq = r; })),
				on: vi.fn(),
				off: vi.fn(),
			};
			setConn('bot-1', conn);

			const store = useSessionsStore();
			// 先发起 loadAllSessions，再发起 loadSessionsForClaw（同 claw）
			const allPromise = store.loadAllSessions();
			const perClawPromise = store.loadSessionsForClaw('bot-1');

			// 关键断言：两个入口应共享 _perClawLoading，conn.request 只被调一次
			expect(conn.request).toHaveBeenCalledTimes(1);

			resolveReq({ sessions: [row('agent:main:main', 'sid-1', 1000)] });
			await Promise.all([allPromise, perClawPromise]);

			expect(store.items).toHaveLength(1);
			expect(store.items[0].sessionId).toBe('sid-1');
		});
	});

	// raw 缓存 / getRawSessionsForClaw：dashboard 经此入口取原始元数据，
	// 与业务列表（SessionItem）共享一次 fetch 与同生命周期
	describe('getRawSessionsForClaw / raw 缓存', () => {
		test('首次调用：无缓存 → 触发 sessions.list 并返回 raw 数组', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);
			const rawRows = [
				row('agent:main:main', 'sid-1', 1000),
				row('agent:main:sess-orph', 'sid-2', 2000),
			];
			const conn = mockConn(rawRows);
			setConn('bot-1', conn);

			const store = useSessionsStore();
			const raw = await store.getRawSessionsForClaw('bot-1');

			expect(conn.request).toHaveBeenCalledTimes(1);
			expect(conn.request).toHaveBeenCalledWith('sessions.list', {}, { timeout: 60_000 });
			expect(raw).toEqual(rawRows);
		});

		test('已有缓存 + 无 force → 直接返回缓存，不重发 RPC', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);
			const rawRows = [row('agent:main:main', 'sid-1', 1000)];
			const conn = mockConn(rawRows);
			setConn('bot-1', conn);

			const store = useSessionsStore();
			await store.getRawSessionsForClaw('bot-1');
			expect(conn.request).toHaveBeenCalledTimes(1);

			const raw2 = await store.getRawSessionsForClaw('bot-1');
			expect(conn.request).toHaveBeenCalledTimes(1); // 仍是 1，不重发
			expect(raw2).toEqual(rawRows);
		});

		test('已有缓存 + force=true → 重新拉取并更新缓存', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);
			const conn = mockConn([row('agent:main:main', 'sid-1', 1000)]);
			setConn('bot-1', conn);

			const store = useSessionsStore();
			await store.getRawSessionsForClaw('bot-1');
			expect(conn.request).toHaveBeenCalledTimes(1);

			conn.request.mockResolvedValue({
				sessions: [row('agent:main:main', 'sid-new', 2000)],
			});
			const raw2 = await store.getRawSessionsForClaw('bot-1', { force: true });
			expect(conn.request).toHaveBeenCalledTimes(2); // force 触发了重拉
			expect(raw2).toEqual([row('agent:main:main', 'sid-new', 2000)]);
		});

		test('非 force 调用合流到非 force 飞行：只发一次 RPC', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);
			let resolveReq;
			const conn = {
				request: vi.fn().mockImplementation(() => new Promise((r) => { resolveReq = r; })),
				on: vi.fn(),
				off: vi.fn(),
			};
			setConn('bot-1', conn);

			const store = useSessionsStore();
			// 先启动 loadSessionsForClaw（非 force 飞行），再并发非 force getRaw
			const loadPromise = store.loadSessionsForClaw('bot-1');
			const rawPromise = store.getRawSessionsForClaw('bot-1');

			expect(conn.request).toHaveBeenCalledTimes(1);

			resolveReq({ sessions: [row('agent:main:main', 'sid-1', 1000)] });
			const [, raw] = await Promise.all([loadPromise, rawPromise]);

			expect(raw).toEqual([row('agent:main:main', 'sid-1', 1000)]);
		});

		test('force 调用看到非 force 飞行：等其完成后启动新一轮（不被合流吞掉）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);

			let resolveFirst;
			let resolveSecond;
			const conn = {
				request: vi.fn()
					.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
					.mockImplementationOnce(() => new Promise((r) => { resolveSecond = r; })),
				on: vi.fn(),
				off: vi.fn(),
			};
			setConn('bot-1', conn);

			const store = useSessionsStore();
			// 启动非 force 飞行（不 await）
			const nonForcePromise = store.loadSessionsForClaw('bot-1');
			// force=true 进入：当前飞行非 force，不能合流，应等其完成再启动新一轮
			const forcePromise = store.getRawSessionsForClaw('bot-1', { force: true });

			// 此刻只发了第一次 RPC，第二次（force 触发的）还没启动
			expect(conn.request).toHaveBeenCalledTimes(1);

			// 完成第一次飞行：force 调用等到结果后启动第二次 RPC
			resolveFirst({ sessions: [row('agent:main:main', 'sid-old', 1000)] });
			await nonForcePromise;
			// 让 microtask 队列跑完，force 的"chain after"应已触发第二次 RPC
			await Promise.resolve();
			await Promise.resolve();
			expect(conn.request).toHaveBeenCalledTimes(2);

			// 完成第二次：force 拿到新 raw
			resolveSecond({ sessions: [row('agent:main:main', 'sid-new', 2000)] });
			const raw = await forcePromise;
			expect(raw).toEqual([row('agent:main:main', 'sid-new', 2000)]);
		});

		test('多个并发 force 调用合流到同一份 force 飞行（只发一次 RPC）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);

			let resolveReq;
			const conn = {
				request: vi.fn().mockImplementation(() => new Promise((r) => { resolveReq = r; })),
				on: vi.fn(),
				off: vi.fn(),
			};
			setConn('bot-1', conn);

			const store = useSessionsStore();
			const p1 = store.getRawSessionsForClaw('bot-1', { force: true });
			const p2 = store.getRawSessionsForClaw('bot-1', { force: true });

			// force 之间合流，conn.request 只被调一次
			expect(conn.request).toHaveBeenCalledTimes(1);

			resolveReq({ sessions: [row('agent:main:main', 'sid-1', 1000)] });
			const [raw1, raw2] = await Promise.all([p1, p2]);

			expect(raw1).toEqual([row('agent:main:main', 'sid-1', 1000)]);
			expect(raw2).toEqual([row('agent:main:main', 'sid-1', 1000)]);
		});

		test('非 force 调用合流到 force 飞行（拿新数据，单次 RPC）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);

			let resolveReq;
			const conn = {
				request: vi.fn().mockImplementation(() => new Promise((r) => { resolveReq = r; })),
				on: vi.fn(),
				off: vi.fn(),
			};
			setConn('bot-1', conn);

			const store = useSessionsStore();
			// 启动 force 飞行
			const forcePromise = store.getRawSessionsForClaw('bot-1', { force: true });
			// 紧跟非 force 调用：合流（force 已经在拉新数据，非 force 跟着即可）
			const nonForcePromise = store.getRawSessionsForClaw('bot-1');

			expect(conn.request).toHaveBeenCalledTimes(1);

			resolveReq({ sessions: [row('agent:main:main', 'sid-1', 1000)] });
			const [forced, nonForced] = await Promise.all([forcePromise, nonForcePromise]);

			expect(forced).toEqual([row('agent:main:main', 'sid-1', 1000)]);
			expect(nonForced).toEqual([row('agent:main:main', 'sid-1', 1000)]);
		});

		test('fetch 失败时 raw 保留旧值（与 SessionItem 同生命周期）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);
			const conn = mockConn([row('agent:main:main', 'sid-1', 1000)]);
			setConn('bot-1', conn);

			const store = useSessionsStore();
			// 第一次成功
			await store.getRawSessionsForClaw('bot-1');
			expect(store.items.find((s) => s.clawId === 'bot-1').sessionId).toBe('sid-1');

			// 第二次 reject：raw 和 SessionItem 都保留旧值
			conn.request.mockRejectedValueOnce(new Error('boom'));
			const raw2 = await store.getRawSessionsForClaw('bot-1', { force: true });

			// raw 保留第一次的旧值
			expect(raw2).toEqual([row('agent:main:main', 'sid-1', 1000)]);
			// SessionItem 也保留旧值（mergeFetchResults 失败路径）
			expect(store.items.find((s) => s.clawId === 'bot-1').sessionId).toBe('sid-1');
		});

		test('fetch 失败且无旧缓存：返回空数组（首次连接失败的合理表现）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);
			const conn = {
				request: vi.fn().mockRejectedValue(new Error('boom')),
				on: vi.fn(),
				off: vi.fn(),
			};
			setConn('bot-1', conn);

			const store = useSessionsStore();
			const raw = await store.getRawSessionsForClaw('bot-1');
			expect(raw).toEqual([]);
		});

		test('无 ready conn：返回空数组，不写 raw', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: false }]);
			const conn = mockConn([row('agent:main:main', 'sid-1', 1)]);
			setConn('bot-1', conn, { dcReady: false });

			const store = useSessionsStore();
			const raw = await store.getRawSessionsForClaw('bot-1');
			expect(raw).toEqual([]);
			expect(conn.request).not.toHaveBeenCalled();
		});

		test('removeSessionsByClawId 清 raw 缓存：下次 getRaw 触发重拉', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);
			const conn = mockConn([row('agent:main:main', 'sid-1', 1000)]);
			setConn('bot-1', conn);

			const store = useSessionsStore();
			await store.getRawSessionsForClaw('bot-1');
			expect(conn.request).toHaveBeenCalledTimes(1);

			// removeSessionsByClawId 应清 raw（SessionItem + raw 同生命周期）
			store.removeSessionsByClawId('bot-1');

			// 同 id 重新 setConn，下次 getRaw 应触发新 fetch
			conn.request.mockClear();
			await store.getRawSessionsForClaw('bot-1');
			expect(conn.request).toHaveBeenCalledTimes(1); // 缓存已清 → 重拉
		});

		test('__resetSessionsInternals 清 raw 缓存：下次 getRaw 触发重拉', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);
			const conn = mockConn([row('agent:main:main', 'sid-1', 1000)]);
			setConn('bot-1', conn);

			const store = useSessionsStore();
			await store.getRawSessionsForClaw('bot-1');
			expect(conn.request).toHaveBeenCalledTimes(1);

			__resetSessionsInternals();

			conn.request.mockClear();
			await store.getRawSessionsForClaw('bot-1');
			expect(conn.request).toHaveBeenCalledTimes(1); // raw 已清 → 重拉
		});

		test('fetch 期间 claw 被移除：raw 不被回填（与 SessionItem 一致）', async () => {
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
			const inflight = store.getRawSessionsForClaw('bot-1');

			// fetch 期间移除 claw
			delete clawsStore.byId['bot-1'];
			store.removeSessionsByClawId('bot-1');

			resolveReq({ sessions: [row('agent:main:main', 'sid-late', 1)] });
			const raw = await inflight;

			// raw 不被回填到已移除 claw
			expect(raw).toEqual([]);
			// SessionItem 也未写入
			expect(store.items.find((s) => s.clawId === 'bot-1')).toBeUndefined();
		});

		// 联合断言：成功路径下 raw 与 SessionItem 在同一次 fetch 后一起更新（同生同死的正面验证）
		test('成功路径联合：raw 与 SessionItem 在同一次 force refresh 后一起更新到新值', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);
			const conn = mockConn([row('agent:main:main', 'sid-old', 1000)]);
			setConn('bot-1', conn);

			const store = useSessionsStore();
			await store.getRawSessionsForClaw('bot-1');
			expect(store.items.find((s) => s.clawId === 'bot-1').sessionId).toBe('sid-old');
			expect((await store.getRawSessionsForClaw('bot-1'))[0].sessionId).toBe('sid-old');

			// 改 mock 返回新数据，走 force 重拉
			conn.request.mockResolvedValue({
				sessions: [row('agent:main:main', 'sid-new', 2000)],
			});
			const newRaw = await store.getRawSessionsForClaw('bot-1', { force: true });

			// raw 和 SessionItem 一起更新到新值
			expect(newRaw[0].sessionId).toBe('sid-new');
			expect(newRaw[0].updatedAt).toBe(2000);
			expect(store.items.find((s) => s.clawId === 'bot-1').sessionId).toBe('sid-new');
			expect(store.items.find((s) => s.clawId === 'bot-1').updatedAt).toBe(2000);
		});

		// 同 id 重绑场景下，飞行 dedup 的 finally 身份检查（_perClawLoading.get(id)?.p === promise）
		// 保证旧 finally 不擦掉新 entry，新调用走独立请求。
		// 注：本测试只锁住"飞行 dedup 不串"——旧 fetch 完成后写入 raw 时是否被旧数据污染，
		// 受现有"写入身份不验证"预存问题影响（见 ui/TODO.md #3），本测试不断言 raw 内容。
		test('同 id 重绑 + 旧请求延迟 resolve：新调用走独立请求（飞行 dedup 不串）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B-old', online: true }]);

			let resolveOld;
			const oldConn = {
				request: vi.fn().mockImplementation(() => new Promise((r) => { resolveOld = r; })),
				on: vi.fn(),
				off: vi.fn(),
			};
			setConn('bot-1', oldConn);

			const store = useSessionsStore();
			const oldInflight = store.getRawSessionsForClaw('bot-1');
			expect(oldConn.request).toHaveBeenCalledTimes(1);

			// claw 被移除（cleanupClawResources 一次性调用）
			delete clawsStore.byId['bot-1'];
			store.removeSessionsByClawId('bot-1');

			// 同 id 重绑新 claw，立即拉新数据
			clawsStore.setClaws([{ id: 'bot-1', name: 'B-new', online: true }]);
			const newConn = mockConn([row('agent:main:main', 'sid-new', 5000)]);
			setConn('bot-1', newConn);
			const newRaw = await store.getRawSessionsForClaw('bot-1', { force: true });

			// 新调用走独立请求（不被旧 dedup 命中）
			expect(newConn.request).toHaveBeenCalledTimes(1);
			expect(newRaw).toEqual([row('agent:main:main', 'sid-new', 5000)]);

			// 旧 fetch 即使后续延迟 resolve，旧 finally 也不能擦掉新 entry
			// （只要 _perClawLoading 仍指向新 entry / 已空，dedup 状态就稳定）
			resolveOld({ sessions: [row('agent:main:main', 'sid-old', 1000)] });
			await oldInflight;
		});

		// 多 claw 首屏联合：N 只 claw 各发恰好 1 次 sessions.list（不是 N²、不是 0）
		test('多 claw 首屏 getRawSessionsForClaw：N 只 claw 各发恰好 1 次', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([
				{ id: 'bot-1', name: 'B1', online: true },
				{ id: 'bot-2', name: 'B2', online: true },
				{ id: 'bot-3', name: 'B3', online: true },
			]);

			const conn1 = mockConn([row('agent:main:main', 'sid-1', 1)]);
			const conn2 = mockConn([row('agent:main:main', 'sid-2', 2)]);
			const conn3 = mockConn([row('agent:main:main', 'sid-3', 3)]);
			setConn('bot-1', conn1);
			setConn('bot-2', conn2);
			setConn('bot-3', conn3);

			const store = useSessionsStore();
			await Promise.all([
				store.getRawSessionsForClaw('bot-1'),
				store.getRawSessionsForClaw('bot-2'),
				store.getRawSessionsForClaw('bot-3'),
			]);

			expect(conn1.request).toHaveBeenCalledTimes(1);
			expect(conn2.request).toHaveBeenCalledTimes(1);
			expect(conn3.request).toHaveBeenCalledTimes(1);
		});
	});
});
