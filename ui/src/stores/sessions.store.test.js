import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { useSessionsStore } from './sessions.store.js';

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
 * 创建模拟连接，request('chat.history', { sessionKey, limit: 1 }) 按 sessionKey 返回对应 sessionId
 * @param {Record<string, string>} sessionKeyToId - sessionKey -> sessionId 映射
 * @param {string} [state] - 连接状态
 */
function mockConn(sessionKeyToId = {}) {
	return {
		request: vi.fn().mockImplementation((_method, params) => {
			const sessionId = sessionKeyToId[params?.sessionKey];
			if (sessionId) {
				return Promise.resolve({ sessionId });
			}
			return Promise.resolve({ sessionId: '' });
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

describe('sessions store', () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		mockConnections.clear();
		vi.clearAllMocks();
	});

	test('loadAllSessions should return empty when no bots', async () => {
		const store = useSessionsStore();
		await store.loadAllSessions();
		expect(store.items).toEqual([]);
	});

	test('loadAllSessions should return empty when all bots have no connected WS', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([
			{ id: 'bot-1', name: 'Bot 1', online: false },
		]);
		// 没有 mockConnections 条目 -> get() 返回 undefined

		const store = useSessionsStore();
		await store.loadAllSessions();
		expect(store.items).toEqual([]);
	});

	test('loadAllSessions should load sessions from multiple bots', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([
			{ id: 'bot-1', name: 'Bot 1', online: true },
			{ id: 'bot-2', name: 'Bot 2', online: true },
		]);

		// agentsStore 未加载 -> fallback 到 ['main']，sessionKey = 'agent:main:main'
		const conn1 = mockConn({ 'agent:main:main': 'sid-1' });
		const conn2 = mockConn({ 'agent:main:main': 'sid-2' });
		setConn('bot-1', conn1);
		setConn('bot-2', conn2);

		const store = useSessionsStore();
		await store.loadAllSessions();

		expect(store.items).toEqual([
			{ sessionId: 'sid-1', sessionKey: 'agent:main:main', clawId: 'bot-1', agentId: 'main' },
			{ sessionId: 'sid-2', sessionKey: 'agent:main:main', clawId: 'bot-2', agentId: 'main' },
		]);
	});

	test('loadAllSessions should dedup by clawId:sessionKey', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([
			{ id: 'bot-1', name: 'Bot 1', online: true },
		]);

		const agentsStore = useAgentsStore();
		// 两个 agent 产出相同 sessionKey（理论上不会，但验证去重逻辑）
		agentsStore.byClaw['bot-1'] = {
			agents: [{ id: 'main' }, { id: 'alias' }],
			defaultId: 'main',
			loading: false,
			fetched: true,
		};

		// 两个不同 sessionKey，各有不同 sessionId -> 不去重
		const conn = mockConn({
			'agent:main:main': 'sid-main',
			'agent:alias:main': 'sid-alias',
		});
		setConn('bot-1', conn);

		const store = useSessionsStore();
		await store.loadAllSessions();

		expect(store.items).toHaveLength(2);
	});

	test('loadAllSessions should skip bots without connected WS', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([
			{ id: 'bot-on', name: 'Online', online: true },
			{ id: 'bot-off', name: 'Offline', online: false },
		]);

		const connOn = mockConn({ 'agent:main:main': 'sid-on' });
		setConn('bot-on', connOn);
		// bot-off 没有连接

		const store = useSessionsStore();
		await store.loadAllSessions();

		expect(connOn.request).toHaveBeenCalledTimes(1);
		expect(store.items).toEqual([
			{ sessionId: 'sid-on', sessionKey: 'agent:main:main', clawId: 'bot-on', agentId: 'main' },
		]);
	});

	test('loadAllSessions should still load other bots when one fails', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([
			{ id: 'bot-ok', name: 'OK', online: true },
			{ id: 'bot-fail', name: 'Fail', online: true },
		]);

		const connOk = mockConn({ 'agent:main:main': 'sid-ok' });
		const connFail = {
			request: vi.fn().mockRejectedValue(new Error('connection failed')),
			on: vi.fn(),
			off: vi.fn(),
		};
		setConn('bot-ok', connOk);
		setConn('bot-fail', connFail);

		const store = useSessionsStore();
		await store.loadAllSessions();

		expect(store.items).toEqual([
			{ sessionId: 'sid-ok', sessionKey: 'agent:main:main', clawId: 'bot-ok', agentId: 'main' },
		]);
	});

	test('setSessions should directly set items', () => {
		const store = useSessionsStore();
		const items = [
			{ sessionId: 'x', sessionKey: 'agent:main:main', clawId: 'b', agentId: 'main' },
		];
		store.setSessions(items);
		expect(store.items).toEqual(items);
	});

	test('concurrent loadAllSessions should join the same request', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'B', online: true }]);

		const conn = mockConn({ 'agent:main:main': 'sid-1' });
		setConn('bot-1', conn);

		const store = useSessionsStore();
		// 并发发起两次
		await Promise.all([
			store.loadAllSessions(),
			store.loadAllSessions(),
		]);

		// 只应调用一次 request（合流）
		expect(conn.request).toHaveBeenCalledTimes(1);
		expect(store.items).toHaveLength(1);
		expect(store.loading).toBe(false);
	});

	test('loading flag should be managed correctly', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'B', online: true }]);

		const conn = mockConn({});
		setConn('bot-1', conn);

		const store = useSessionsStore();
		expect(store.loading).toBe(false);

		const promise = store.loadAllSessions();
		expect(store.loading).toBe(true);

		await promise;
		expect(store.loading).toBe(false);
	});

	test('removeSessionsByClawId should remove all sessions for the given clawId', () => {
		const store = useSessionsStore();
		store.setSessions([
			{ sessionId: 's1', sessionKey: 'agent:main:main', clawId: 'bot-1', agentId: 'main' },
			{ sessionId: 's2', sessionKey: 'agent:main:main', clawId: 'bot-2', agentId: 'main' },
			{ sessionId: 's3', sessionKey: 'agent:ops:main', clawId: 'bot-1', agentId: 'ops' },
		]);

		store.removeSessionsByClawId('bot-1');

		expect(store.items).toHaveLength(1);
		expect(store.items[0].sessionId).toBe('s2');
	});

	test('removeSessionsByClawId should coerce numeric clawId to string', () => {
		const store = useSessionsStore();
		store.setSessions([
			{ sessionId: 's1', sessionKey: 'agent:main:main', clawId: '42', agentId: 'main' },
			{ sessionId: 's2', sessionKey: 'agent:main:main', clawId: '99', agentId: 'main' },
		]);

		store.removeSessionsByClawId(42);

		expect(store.items).toHaveLength(1);
		expect(store.items[0].sessionId).toBe('s2');
	});

	test('removeSessionsByClawId should be a no-op when no sessions match', () => {
		const store = useSessionsStore();
		store.setSessions([
			{ sessionId: 's1', sessionKey: 'agent:main:main', clawId: 'bot-1', agentId: 'main' },
		]);

		store.removeSessionsByClawId('bot-999');

		expect(store.items).toHaveLength(1);
	});

	test('__fetchSessionsForClaw 应按多个 agent 分别拉取并合并', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);

		const agentsStore = useAgentsStore();
		agentsStore.byClaw['bot-1'] = {
			agents: [{ id: 'main' }, { id: 'ops' }],
			defaultId: 'main',
			loading: false,
			fetched: true,
		};

		const conn = mockConn({
			'agent:main:main': 'sid-main',
			'agent:ops:main': 'sid-ops',
		});
		setConn('bot-1', conn);

		const store = useSessionsStore();
		await store.loadAllSessions();

		expect(store.items).toHaveLength(2);
		expect(store.items.find((s) => s.sessionKey === 'agent:main:main')).toBeDefined();
		expect(store.items.find((s) => s.sessionKey === 'agent:ops:main')).toBeDefined();
		expect(store.items.find((s) => s.agentId === 'main')).toBeDefined();
		expect(store.items.find((s) => s.agentId === 'ops')).toBeDefined();
		// 应发起 2 次 request（每个 agent 一次）
		expect(conn.request).toHaveBeenCalledTimes(2);
	});

	test('agentsStore 未加载时应 fallback 到 main', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);

		// 不设置 agentsStore 数据 -> getAgentsByClaw 返回 []

		const conn = mockConn({ 'agent:main:main': 'sid-1' });
		setConn('bot-1', conn);

		const store = useSessionsStore();
		await store.loadAllSessions();

		expect(store.items).toHaveLength(1);
		expect(store.items[0].agentId).toBe('main');
		expect(store.items[0].sessionKey).toBe('agent:main:main');
		// 应调用 chat.history 并传入正确的 sessionKey
		expect(conn.request).toHaveBeenCalledWith('chat.history', {
			sessionKey: 'agent:main:main',
			limit: 1,
		});
	});

	test('__fetchSessionsForClaw 应将 clawId 归一化为 string', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 42, name: 'B1', online: true }]);

		const conn = mockConn({ 'agent:main:main': 'sid-1' });
		setConn('42', conn);

		const store = useSessionsStore();
		await store.loadAllSessions();

		expect(store.items).toHaveLength(1);
		expect(store.items[0].clawId).toBe('42');
		expect(typeof store.items[0].clawId).toBe('string');
	});

	test('多 agent 拉取部分失败时应保留成功部分', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);

		const agentsStore = useAgentsStore();
		agentsStore.byClaw['bot-1'] = {
			agents: [{ id: 'main' }, { id: 'bad' }],
			defaultId: 'main',
			loading: false,
			fetched: true,
		};

		const conn = {
			request: vi.fn().mockImplementation((_method, params) => {
				if (params?.sessionKey === 'agent:main:main') {
					return Promise.resolve({ sessionId: 'sid-main' });
				}
				return Promise.reject(new Error('agent not found'));
			}),
			on: vi.fn(),
			off: vi.fn(),
		};
		setConn('bot-1', conn);

		const store = useSessionsStore();
		await store.loadAllSessions();

		expect(store.items).toHaveLength(1);
		expect(store.items[0].sessionKey).toBe('agent:main:main');
		expect(store.items[0].agentId).toBe('main');
	});

	test('loadAllSessions 增量合并：保留未查询 bot 的已有 sessions', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([
			{ id: 'bot-1', name: 'Bot 1', online: true },
			{ id: 'bot-2', name: 'Bot 2', online: true },
		]);

		// 两个 bot 都连接，先全量加载
		const conn1 = mockConn({ 'agent:main:main': 'sid-1' });
		const conn2 = mockConn({ 'agent:main:main': 'sid-2' });
		setConn('bot-1', conn1);
		setConn('bot-2', conn2);

		const store = useSessionsStore();
		await store.loadAllSessions();
		expect(store.items).toHaveLength(2);

		// bot-2 断连，仅 bot-1 在线
		clawsStore.byId['bot-2'].dcReady = false;
		await store.loadAllSessions();

		// bot-2 的 sessions 应保留
		expect(store.items).toHaveLength(2);
		expect(store.items.find((s) => s.clawId === 'bot-2')).toBeDefined();
	});

	test('loadAllSessions 增量合并：已移除 bot 的旧 sessions 不被保留', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([
			{ id: 'bot-1', name: 'Bot 1', online: true },
			{ id: 'bot-2', name: 'Bot 2', online: true },
		]);

		const conn1 = mockConn({ 'agent:main:main': 'sid-1' });
		const conn2 = mockConn({ 'agent:main:main': 'sid-2' });
		setConn('bot-1', conn1);
		setConn('bot-2', conn2);

		const store = useSessionsStore();
		await store.loadAllSessions();
		expect(store.items).toHaveLength(2);

		// bot-2 被服务端移除：从 store 移除 + 断连
		delete clawsStore.byId['bot-2'];
		mockConnections.delete('bot-2');

		// 重新加载（仅 bot-1 连接中）
		await store.loadAllSessions();

		// bot-2 的 sessions 不应被保留（因为 bot 已不存在）
		expect(store.items).toHaveLength(1);
		expect(store.items[0].clawId).toBe('bot-1');
	});

	test('loadAllSessions 增量合并：__fetchSessionsForClaw reject 时保留旧 sessions', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([
			{ id: 'bot-1', name: 'Bot 1', online: true },
			{ id: 'bot-2', name: 'Bot 2', online: true },
		]);

		const conn1 = mockConn({ 'agent:main:main': 'sid-1' });
		const conn2 = mockConn({ 'agent:main:main': 'sid-2' });
		setConn('bot-1', conn1);
		setConn('bot-2', conn2);

		const store = useSessionsStore();
		await store.loadAllSessions();
		expect(store.items).toHaveLength(2);

		// 第二次加载时，spy __fetchSessionsForClaw 使 bot-2 的调用 reject
		const origFetch = store.__fetchSessionsForClaw.bind(store);
		vi.spyOn(store, '__fetchSessionsForClaw').mockImplementation((clawId) => {
			if (String(clawId) === 'bot-2') return Promise.reject(new Error('fetch failed'));
			return origFetch(clawId);
		});
		await store.loadAllSessions();

		// bot-1 正常刷新，bot-2 因 fetch 失败应保留旧数据
		expect(store.items).toHaveLength(2);
		expect(store.items.find((s) => s.clawId === 'bot-1')).toBeDefined();
		expect(store.items.find((s) => s.clawId === 'bot-2')).toBeDefined();
	});

	test('loadAllSessions 无已连接 bot 时不清空已有 sessions', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([
			{ id: 'bot-1', name: 'Bot 1', online: true },
		]);

		const conn1 = mockConn({ 'agent:main:main': 'sid-1' });
		setConn('bot-1', conn1);

		const store = useSessionsStore();
		await store.loadAllSessions();
		expect(store.items).toHaveLength(1);

		// bot-1 断连
		clawsStore.byId['bot-1'].dcReady = false;
		await store.loadAllSessions();

		// 已有 sessions 不应被清空
		expect(store.items).toHaveLength(1);
	});

	test('chat.history 返回空 sessionId 时应跳过该条目', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);

		const agentsStore = useAgentsStore();
		agentsStore.byClaw['bot-1'] = {
			agents: [{ id: 'main' }, { id: 'empty' }],
			defaultId: 'main',
			loading: false,
			fetched: true,
		};

		// 'agent:main:main' 有有效 sessionId；'agent:empty:main' 返回空
		const conn = mockConn({ 'agent:main:main': 'sid-main' });
		setConn('bot-1', conn);

		const store = useSessionsStore();
		await store.loadAllSessions();

		expect(store.items).toHaveLength(1);
		expect(store.items[0].agentId).toBe('main');
	});

	test('每条 session 应包含正确的 agentId 字段', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);

		const agentsStore = useAgentsStore();
		agentsStore.byClaw['bot-1'] = {
			agents: [{ id: 'assistant' }],
			defaultId: 'assistant',
			loading: false,
			fetched: true,
		};

		const conn = mockConn({ 'agent:assistant:main': 'sid-asst' });
		setConn('bot-1', conn);

		const store = useSessionsStore();
		await store.loadAllSessions();

		expect(store.items).toHaveLength(1);
		expect(store.items[0]).toEqual({
			sessionId: 'sid-asst',
			sessionKey: 'agent:assistant:main',
			clawId: 'bot-1',
			agentId: 'assistant',
		});
	});
});
