import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { useSessionsStore } from './sessions.store.js';

vi.mock('../services/gateway.ws.js', () => ({
	createGatewayRpcClient: vi.fn(),
}));

vi.mock('../services/bots.api.js', () => ({
	listBots: vi.fn().mockResolvedValue([]),
}));

import { createGatewayRpcClient } from '../services/gateway.ws.js';
import { useBotsStore } from './bots.store.js';

function mockRpcClient(items) {
	return {
		request: vi.fn().mockResolvedValue({ items }),
		close: vi.fn(),
	};
}

describe('sessions store', () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		vi.clearAllMocks();
	});

	test('loadAllSessions should return empty when no bots', async () => {
		const store = useSessionsStore();
		await store.loadAllSessions();
		expect(store.items).toEqual([]);
		expect(createGatewayRpcClient).not.toHaveBeenCalled();
	});

	test('loadAllSessions should return empty when all bots offline', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([
			{ id: 'bot-1', name: 'Bot 1', online: false },
		]);

		const store = useSessionsStore();
		await store.loadAllSessions();
		expect(store.items).toEqual([]);
		expect(createGatewayRpcClient).not.toHaveBeenCalled();
	});

	test('loadAllSessions should load sessions from multiple bots', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([
			{ id: 'bot-1', name: 'Bot 1', online: true },
			{ id: 'bot-2', name: 'Bot 2', online: true },
		]);

		const client1 = mockRpcClient([
			{ sessionId: 's1', title: 'Session 1', indexed: true },
		]);
		const client2 = mockRpcClient([
			{ sessionId: 's2', title: 'Session 2', indexed: false },
		]);
		createGatewayRpcClient
			.mockResolvedValueOnce(client1)
			.mockResolvedValueOnce(client2);

		const store = useSessionsStore();
		await store.loadAllSessions();

		expect(store.items).toEqual([
			{ sessionId: 's1', sessionKey: null, title: 'Session 1', derivedTitle: null, indexed: true, botId: 'bot-1' },
			{ sessionId: 's2', sessionKey: null, title: 'Session 2', derivedTitle: null, indexed: false, botId: 'bot-2' },
		]);
		expect(client1.close).toHaveBeenCalled();
		expect(client2.close).toHaveBeenCalled();
	});

	test('loadAllSessions should preserve sessionKey from server response', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([{ id: 'bot-1', name: 'Bot 1', online: true }]);

		const client = mockRpcClient([
			{ sessionId: 's1', sessionKey: 'agent:main:main', title: 'Main', indexed: true },
			{ sessionId: 's2', title: 'No Key', indexed: true },
		]);
		createGatewayRpcClient.mockResolvedValueOnce(client);

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

		const client1 = mockRpcClient([
			{ sessionId: 'dup', title: 'From Bot 1', indexed: true },
		]);
		const client2 = mockRpcClient([
			{ sessionId: 'dup', title: 'From Bot 2', indexed: false },
		]);
		createGatewayRpcClient
			.mockResolvedValueOnce(client1)
			.mockResolvedValueOnce(client2);

		const store = useSessionsStore();
		await store.loadAllSessions();

		// 先到先得，保留 bot-1 的版本
		expect(store.items).toHaveLength(1);
		expect(store.items[0].botId).toBe('bot-1');
	});

	test('loadAllSessions should skip offline bots', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([
			{ id: 'bot-on', name: 'Online', online: true },
			{ id: 'bot-off', name: 'Offline', online: false },
		]);

		const clientOn = mockRpcClient([
			{ sessionId: 's-on', title: 'Online Session', indexed: true },
		]);
		createGatewayRpcClient.mockResolvedValueOnce(clientOn);

		const store = useSessionsStore();
		await store.loadAllSessions();

		// 仅拉取在线 bot，离线 bot 不创建 rpcClient
		expect(createGatewayRpcClient).toHaveBeenCalledTimes(1);
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

		const clientOk = mockRpcClient([
			{ sessionId: 's-ok', title: 'OK Session', indexed: true },
		]);
		createGatewayRpcClient
			.mockResolvedValueOnce(clientOk)
			.mockRejectedValueOnce(new Error('connection failed'));

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

		const client = mockRpcClient([
			{ sessionId: 's1', sessionKey: 'agent:main:main', title: 'Main', indexed: true },
		]);
		createGatewayRpcClient.mockResolvedValue(client);

		const store = useSessionsStore();
		// 并发发起两次
		await Promise.all([
			store.loadAllSessions(),
			store.loadAllSessions(),
		]);

		// 只应建立一次 RPC 连接
		expect(createGatewayRpcClient).toHaveBeenCalledTimes(1);
		expect(store.items).toHaveLength(1);
		expect(store.loading).toBe(false);
	});

	test('loading flag should be managed correctly', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([{ id: 'bot-1', name: 'B', online: true }]);

		const client = mockRpcClient([]);
		createGatewayRpcClient.mockResolvedValue(client);

		const store = useSessionsStore();
		expect(store.loading).toBe(false);

		const promise = store.loadAllSessions();
		expect(store.loading).toBe(true);

		await promise;
		expect(store.loading).toBe(false);
	});
});
