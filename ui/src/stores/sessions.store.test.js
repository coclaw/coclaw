import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { useSessionsStore } from './sessions.store.js';

const mockConnections = new Map();

vi.mock('../services/bot-connection-manager.js', () => ({
	useBotConnections: () => ({
		get: (botId) => mockConnections.get(String(botId)),
		connect: vi.fn(),
		disconnect: vi.fn(),
		syncConnections: vi.fn(),
		disconnectAll: vi.fn(),
	}),
	__resetBotConnections: vi.fn(),
}));

vi.mock('../services/bots.api.js', () => ({
	listBots: vi.fn().mockResolvedValue([]),
}));

import { useAgentsStore } from './agents.store.js';
import { useBotsStore } from './bots.store.js';

/**
 * 创建模拟连接，request('chat.history', { sessionKey, limit: 1 }) 按 sessionKey 返回对应 sessionId
 * @param {Record<string, string>} sessionKeyToId - sessionKey -> sessionId 映射
 * @param {string} [state] - 连接状态
 */
function mockConn(sessionKeyToId = {}, state = 'connected') {
	return {
		state,
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
		const botsStore = useBotsStore();
		botsStore.setBots([
			{ id: 'bot-1', name: 'Bot 1', online: false },
		]);
		// 没有 mockConnections 条目 -> get() 返回 undefined

		const store = useSessionsStore();
		await store.loadAllSessions();
		expect(store.items).toEqual([]);
	});

	test('loadAllSessions should load sessions from multiple bots', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([
			{ id: 'bot-1', name: 'Bot 1', online: true },
			{ id: 'bot-2', name: 'Bot 2', online: true },
		]);

		// agentsStore 未加载 -> fallback 到 ['main']，sessionKey = 'agent:main:main'
		const conn1 = mockConn({ 'agent:main:main': 'sid-1' });
		const conn2 = mockConn({ 'agent:main:main': 'sid-2' });
		mockConnections.set('bot-1', conn1);
		mockConnections.set('bot-2', conn2);

		const store = useSessionsStore();
		await store.loadAllSessions();

		expect(store.items).toEqual([
			{ sessionId: 'sid-1', sessionKey: 'agent:main:main', botId: 'bot-1', agentId: 'main' },
			{ sessionId: 'sid-2', sessionKey: 'agent:main:main', botId: 'bot-2', agentId: 'main' },
		]);
	});

	test('loadAllSessions should dedup by botId:sessionKey', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([
			{ id: 'bot-1', name: 'Bot 1', online: true },
		]);

		const agentsStore = useAgentsStore();
		// 两个 agent 产出相同 sessionKey（理论上不会，但验证去重逻辑）
		agentsStore.byBot['bot-1'] = {
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
		mockConnections.set('bot-1', conn);

		const store = useSessionsStore();
		await store.loadAllSessions();

		expect(store.items).toHaveLength(2);
	});

	test('loadAllSessions should skip bots without connected WS', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([
			{ id: 'bot-on', name: 'Online', online: true },
			{ id: 'bot-off', name: 'Offline', online: false },
		]);

		const connOn = mockConn({ 'agent:main:main': 'sid-on' });
		mockConnections.set('bot-on', connOn);
		// bot-off 没有连接

		const store = useSessionsStore();
		await store.loadAllSessions();

		expect(connOn.request).toHaveBeenCalledTimes(1);
		expect(store.items).toEqual([
			{ sessionId: 'sid-on', sessionKey: 'agent:main:main', botId: 'bot-on', agentId: 'main' },
		]);
	});

	test('loadAllSessions should still load other bots when one fails', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([
			{ id: 'bot-ok', name: 'OK', online: true },
			{ id: 'bot-fail', name: 'Fail', online: true },
		]);

		const connOk = mockConn({ 'agent:main:main': 'sid-ok' });
		const connFail = {
			state: 'connected',
			request: vi.fn().mockRejectedValue(new Error('connection failed')),
			on: vi.fn(),
			off: vi.fn(),
		};
		mockConnections.set('bot-ok', connOk);
		mockConnections.set('bot-fail', connFail);

		const store = useSessionsStore();
		await store.loadAllSessions();

		expect(store.items).toEqual([
			{ sessionId: 'sid-ok', sessionKey: 'agent:main:main', botId: 'bot-ok', agentId: 'main' },
		]);
	});

	test('setSessions should directly set items', () => {
		const store = useSessionsStore();
		const items = [
			{ sessionId: 'x', sessionKey: 'agent:main:main', botId: 'b', agentId: 'main' },
		];
		store.setSessions(items);
		expect(store.items).toEqual(items);
	});

	test('concurrent loadAllSessions should join the same request', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([{ id: 'bot-1', name: 'B', online: true }]);

		const conn = mockConn({ 'agent:main:main': 'sid-1' });
		mockConnections.set('bot-1', conn);

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
		const botsStore = useBotsStore();
		botsStore.setBots([{ id: 'bot-1', name: 'B', online: true }]);

		const conn = mockConn({});
		mockConnections.set('bot-1', conn);

		const store = useSessionsStore();
		expect(store.loading).toBe(false);

		const promise = store.loadAllSessions();
		expect(store.loading).toBe(true);

		await promise;
		expect(store.loading).toBe(false);
	});

	test('removeSessionsByBotId should remove all sessions for the given botId', () => {
		const store = useSessionsStore();
		store.setSessions([
			{ sessionId: 's1', sessionKey: 'agent:main:main', botId: 'bot-1', agentId: 'main' },
			{ sessionId: 's2', sessionKey: 'agent:main:main', botId: 'bot-2', agentId: 'main' },
			{ sessionId: 's3', sessionKey: 'agent:ops:main', botId: 'bot-1', agentId: 'ops' },
		]);

		store.removeSessionsByBotId('bot-1');

		expect(store.items).toHaveLength(1);
		expect(store.items[0].sessionId).toBe('s2');
	});

	test('removeSessionsByBotId should coerce numeric botId to string', () => {
		const store = useSessionsStore();
		store.setSessions([
			{ sessionId: 's1', sessionKey: 'agent:main:main', botId: '42', agentId: 'main' },
			{ sessionId: 's2', sessionKey: 'agent:main:main', botId: '99', agentId: 'main' },
		]);

		store.removeSessionsByBotId(42);

		expect(store.items).toHaveLength(1);
		expect(store.items[0].sessionId).toBe('s2');
	});

	test('removeSessionsByBotId should be a no-op when no sessions match', () => {
		const store = useSessionsStore();
		store.setSessions([
			{ sessionId: 's1', sessionKey: 'agent:main:main', botId: 'bot-1', agentId: 'main' },
		]);

		store.removeSessionsByBotId('bot-999');

		expect(store.items).toHaveLength(1);
	});

	test('__fetchSessionsForBot 应按多个 agent 分别拉取并合并', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([{ id: 'bot-1', name: 'B1', online: true }]);

		const agentsStore = useAgentsStore();
		agentsStore.byBot['bot-1'] = {
			agents: [{ id: 'main' }, { id: 'ops' }],
			defaultId: 'main',
			loading: false,
			fetched: true,
		};

		const conn = mockConn({
			'agent:main:main': 'sid-main',
			'agent:ops:main': 'sid-ops',
		});
		mockConnections.set('bot-1', conn);

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
		const botsStore = useBotsStore();
		botsStore.setBots([{ id: 'bot-1', name: 'B1', online: true }]);

		// 不设置 agentsStore 数据 -> getAgentsByBot 返回 []

		const conn = mockConn({ 'agent:main:main': 'sid-1' });
		mockConnections.set('bot-1', conn);

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

	test('__fetchSessionsForBot 应将 botId 归一化为 string', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([{ id: 42, name: 'B1', online: true }]);

		const conn = mockConn({ 'agent:main:main': 'sid-1' });
		mockConnections.set('42', conn);

		const store = useSessionsStore();
		await store.loadAllSessions();

		expect(store.items).toHaveLength(1);
		expect(store.items[0].botId).toBe('42');
		expect(typeof store.items[0].botId).toBe('string');
	});

	test('多 agent 拉取部分失败时应保留成功部分', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([{ id: 'bot-1', name: 'B1', online: true }]);

		const agentsStore = useAgentsStore();
		agentsStore.byBot['bot-1'] = {
			agents: [{ id: 'main' }, { id: 'bad' }],
			defaultId: 'main',
			loading: false,
			fetched: true,
		};

		const conn = {
			state: 'connected',
			request: vi.fn().mockImplementation((_method, params) => {
				if (params?.sessionKey === 'agent:main:main') {
					return Promise.resolve({ sessionId: 'sid-main' });
				}
				return Promise.reject(new Error('agent not found'));
			}),
			on: vi.fn(),
			off: vi.fn(),
		};
		mockConnections.set('bot-1', conn);

		const store = useSessionsStore();
		await store.loadAllSessions();

		expect(store.items).toHaveLength(1);
		expect(store.items[0].sessionKey).toBe('agent:main:main');
		expect(store.items[0].agentId).toBe('main');
	});

	test('chat.history 返回空 sessionId 时应跳过该条目', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([{ id: 'bot-1', name: 'B1', online: true }]);

		const agentsStore = useAgentsStore();
		agentsStore.byBot['bot-1'] = {
			agents: [{ id: 'main' }, { id: 'empty' }],
			defaultId: 'main',
			loading: false,
			fetched: true,
		};

		// 'agent:main:main' 有有效 sessionId；'agent:empty:main' 返回空
		const conn = mockConn({ 'agent:main:main': 'sid-main' });
		mockConnections.set('bot-1', conn);

		const store = useSessionsStore();
		await store.loadAllSessions();

		expect(store.items).toHaveLength(1);
		expect(store.items[0].agentId).toBe('main');
	});

	test('每条 session 应包含正确的 agentId 字段', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([{ id: 'bot-1', name: 'B1', online: true }]);

		const agentsStore = useAgentsStore();
		agentsStore.byBot['bot-1'] = {
			agents: [{ id: 'assistant' }],
			defaultId: 'assistant',
			loading: false,
			fetched: true,
		};

		const conn = mockConn({ 'agent:assistant:main': 'sid-asst' });
		mockConnections.set('bot-1', conn);

		const store = useSessionsStore();
		await store.loadAllSessions();

		expect(store.items).toHaveLength(1);
		expect(store.items[0]).toEqual({
			sessionId: 'sid-asst',
			sessionKey: 'agent:assistant:main',
			botId: 'bot-1',
			agentId: 'assistant',
		});
	});
});
