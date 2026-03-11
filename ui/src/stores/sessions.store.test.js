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

import { useBotsStore } from './bots.store.js';

function mockConn(items = [], state = 'connected') {
	return {
		state,
		request: vi.fn().mockResolvedValue({ items }),
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
		// 没有 mockConnections 条目 → get() 返回 undefined

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

		const conn1 = mockConn([
			{ sessionId: 's1', title: 'Session 1', indexed: true },
		]);
		const conn2 = mockConn([
			{ sessionId: 's2', title: 'Session 2', indexed: false },
		]);
		mockConnections.set('bot-1', conn1);
		mockConnections.set('bot-2', conn2);

		const store = useSessionsStore();
		await store.loadAllSessions();

		expect(store.items).toEqual([
			{ sessionId: 's1', sessionKey: null, title: 'Session 1', derivedTitle: null, indexed: true, botId: 'bot-1' },
			{ sessionId: 's2', sessionKey: null, title: 'Session 2', derivedTitle: null, indexed: false, botId: 'bot-2' },
		]);
	});

	test('loadAllSessions should preserve sessionKey from server response', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([{ id: 'bot-1', name: 'Bot 1', online: true }]);

		const conn = mockConn([
			{ sessionId: 's1', sessionKey: 'agent:main:main', title: 'Main', indexed: true },
			{ sessionId: 's2', title: 'No Key', indexed: true },
		]);
		mockConnections.set('bot-1', conn);

		const store = useSessionsStore();
		await store.loadAllSessions();

		expect(store.items[0].sessionKey).toBe('agent:main:main');
		expect(store.items[1].sessionKey).toBeNull();
	});

	test('loadAllSessions should dedup sessions by sessionId', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([
			{ id: 'bot-1', name: 'Bot 1', online: true },
			{ id: 'bot-2', name: 'Bot 2', online: true },
		]);

		const conn1 = mockConn([
			{ sessionId: 'dup', title: 'From Bot 1', indexed: true },
		]);
		const conn2 = mockConn([
			{ sessionId: 'dup', title: 'From Bot 2', indexed: false },
		]);
		mockConnections.set('bot-1', conn1);
		mockConnections.set('bot-2', conn2);

		const store = useSessionsStore();
		await store.loadAllSessions();

		// 先到先得，保留 bot-1 的版本
		expect(store.items).toHaveLength(1);
		expect(store.items[0].botId).toBe('bot-1');
	});

	test('loadAllSessions should skip bots without connected WS', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([
			{ id: 'bot-on', name: 'Online', online: true },
			{ id: 'bot-off', name: 'Offline', online: false },
		]);

		const connOn = mockConn([
			{ sessionId: 's-on', title: 'Online Session', indexed: true },
		]);
		mockConnections.set('bot-on', connOn);
		// bot-off 没有连接

		const store = useSessionsStore();
		await store.loadAllSessions();

		expect(connOn.request).toHaveBeenCalledTimes(1);
		expect(store.items).toEqual([
			{ sessionId: 's-on', sessionKey: null, title: 'Online Session', derivedTitle: null, indexed: true, botId: 'bot-on' },
		]);
	});

	test('loadAllSessions should still load other bots when one fails', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([
			{ id: 'bot-ok', name: 'OK', online: true },
			{ id: 'bot-fail', name: 'Fail', online: true },
		]);

		const connOk = mockConn([
			{ sessionId: 's-ok', title: 'OK Session', indexed: true },
		]);
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
			{ sessionId: 's-ok', sessionKey: null, title: 'OK Session', derivedTitle: null, indexed: true, botId: 'bot-ok' },
		]);
	});

	test('setSessions should directly set items', () => {
		const store = useSessionsStore();
		const items = [
			{ sessionId: 'x', title: 'X', indexed: false, botId: 'b' },
		];
		store.setSessions(items);
		expect(store.items).toEqual(items);
	});

	test('concurrent loadAllSessions should join the same request', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([{ id: 'bot-1', name: 'B', online: true }]);

		const conn = mockConn([
			{ sessionId: 's1', sessionKey: 'agent:main:main', title: 'Main', indexed: true },
		]);
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

		const conn = mockConn([]);
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
			{ sessionId: 's1', botId: 'bot-1' },
			{ sessionId: 's2', botId: 'bot-2' },
			{ sessionId: 's3', botId: 'bot-1' },
		]);

		store.removeSessionsByBotId('bot-1');

		expect(store.items).toHaveLength(1);
		expect(store.items[0].sessionId).toBe('s2');
	});

	test('removeSessionsByBotId should coerce numeric botId to string', () => {
		const store = useSessionsStore();
		store.setSessions([
			{ sessionId: 's1', botId: '42' },
			{ sessionId: 's2', botId: '99' },
		]);

		store.removeSessionsByBotId(42);

		expect(store.items).toHaveLength(1);
		expect(store.items[0].sessionId).toBe('s2');
	});

	test('removeSessionsByBotId should be a no-op when no sessions match', () => {
		const store = useSessionsStore();
		store.setSessions([
			{ sessionId: 's1', botId: 'bot-1' },
		]);

		store.removeSessionsByBotId('bot-999');

		expect(store.items).toHaveLength(1);
	});
});
