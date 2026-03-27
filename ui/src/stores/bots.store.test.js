import { describe, test, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const mockManager = {
	connect: vi.fn(),
	disconnect: vi.fn(),
	syncConnections: vi.fn(),
	disconnectAll: vi.fn(),
	get: vi.fn(),
};

vi.mock('../services/bot-connection-manager.js', () => ({
	useBotConnections: () => mockManager,
	__resetBotConnections: vi.fn(),
}));

vi.mock('../services/bots.api.js', () => ({
	listBots: vi.fn(),
}));

vi.mock('../utils/plugin-version.js', () => ({
	checkPluginVersion: vi.fn().mockResolvedValue({ ok: true, version: '0.6.0', clawVersion: '2026.3.14' }),
	MIN_PLUGIN_VERSION: '0.4.0',
}));

const mockInitRtcAndSelectTransport = vi.fn().mockResolvedValue(undefined);
const mockCloseRtcForBot = vi.fn();
vi.mock('../services/webrtc-connection.js', () => ({
	initRtcAndSelectTransport: (...args) => mockInitRtcAndSelectTransport(...args),
	closeRtcForBot: (...args) => mockCloseRtcForBot(...args),
}));

import { listBots } from '../services/bots.api.js';
import { useAgentsStore } from './agents.store.js';
import { useBotsStore, __resetAwaitingConnIds } from './bots.store.js';
import { useSessionsStore } from './sessions.store.js';
import { useTopicsStore } from './topics.store.js';

beforeEach(() => {
	setActivePinia(createPinia());
	vi.clearAllMocks();
	mockManager.get.mockReset();
	mockInitRtcAndSelectTransport.mockReset().mockResolvedValue(undefined);
	mockCloseRtcForBot.mockReset();
	__resetAwaitingConnIds();
});

describe('setBots', () => {
	test('sets items to provided array', () => {
		const store = useBotsStore();
		const bots = [{ id: '1', name: 'Bot A' }, { id: '2', name: 'Bot B' }];
		store.setBots(bots);
		expect(store.items).toEqual(bots);
	});

	test('guards against non-array input by setting items to []', () => {
		const store = useBotsStore();
		store.setBots('not-an-array');
		expect(store.items).toEqual([]);
	});

	test('guards against null input by setting items to []', () => {
		const store = useBotsStore();
		store.setBots(null);
		expect(store.items).toEqual([]);
	});
});

describe('addOrUpdateBot', () => {
	test('inserts new bot with normalized fields and calls connect', () => {
		const store = useBotsStore();
		const fakeConn = { state: 'connecting', on: vi.fn(), off: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);
		const bot = {
			id: 42,
			name: 'NewBot',
			online: true,
			lastSeenAt: '2024-01-01',
			createdAt: '2024-01-01',
			updatedAt: '2024-01-02',
		};
		store.addOrUpdateBot(bot);

		expect(store.items).toHaveLength(1);
		expect(store.items[0]).toEqual({
			id: '42',
			name: 'NewBot',
			online: true,
			lastSeenAt: '2024-01-01',
			createdAt: '2024-01-01',
			updatedAt: '2024-01-02',
		});
		expect(mockManager.connect).toHaveBeenCalledOnce();
		expect(mockManager.connect).toHaveBeenCalledWith('42');
	});

	test('normalizes missing optional fields to null and online to false', () => {
		const store = useBotsStore();
		store.addOrUpdateBot({ id: '7' });

		expect(store.items[0]).toEqual({
			id: '7',
			name: null,
			online: false,
			lastSeenAt: null,
			createdAt: null,
			updatedAt: null,
		});
	});

	test('inserts new bot at the front of items', () => {
		const store = useBotsStore();
		store.setBots([{ id: '1', name: 'Existing' }]);
		store.addOrUpdateBot({ id: '2', name: 'NewBot' });

		expect(store.items[0].id).toBe('2');
		expect(store.items[1].id).toBe('1');
	});

	test('updates existing bot in place and calls connect', () => {
		const store = useBotsStore();
		store.setBots([{ id: '1', name: 'OldName', online: false }]);
		store.addOrUpdateBot({ id: '1', name: 'NewName', online: true });

		expect(store.items).toHaveLength(1);
		expect(store.items[0].name).toBe('NewName');
		expect(store.items[0].online).toBe(true);
		expect(mockManager.connect).toHaveBeenCalledWith('1');
	});

	test('registers __listenForReady so agents/sessions/topics load when connection becomes ready', async () => {
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadAllSessions').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadAllTopics').mockResolvedValue();

		let stateCallback;
		const fakeConn = {
			state: 'connecting',
			on: vi.fn((event, cb) => { if (event === 'state') stateCallback = cb; }),
			off: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateBot({ id: '10', name: 'Fresh' });

		expect(fakeConn.on).toHaveBeenCalledWith('state', expect.any(Function));

		// 模拟连接就绪
		stateCallback('connected');
		await vi.waitFor(() => {
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('10');
			expect(sessionsStore.loadAllSessions).toHaveBeenCalled();
			expect(topicsStore.loadAllTopics).toHaveBeenCalled();
		});
	});

	test('immediately fires ready callback if connection is already connected on addOrUpdateBot', async () => {
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadAllSessions').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadAllTopics').mockResolvedValue();

		const fakeConn = { state: 'connected', on: vi.fn(), off: vi.fn(), request: vi.fn().mockResolvedValue({}) };
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateBot({ id: '11', name: 'AlreadyReady' });

		await vi.waitFor(() => {
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('11');
			expect(sessionsStore.loadAllSessions).toHaveBeenCalled();
			expect(topicsStore.loadAllTopics).toHaveBeenCalled();
		});
		// 注册持久 state 监听器（用于 WS 重连时重新触发传输选择）
		expect(fakeConn.on).toHaveBeenCalledWith('state', expect.any(Function));
	});

	test('does nothing when bot id is falsy', () => {
		const store = useBotsStore();
		store.addOrUpdateBot({ name: 'No ID' });
		expect(store.items).toHaveLength(0);
		expect(mockManager.connect).not.toHaveBeenCalled();
	});

	test('does nothing when bot is null', () => {
		const store = useBotsStore();
		store.addOrUpdateBot(null);
		expect(store.items).toHaveLength(0);
		expect(mockManager.connect).not.toHaveBeenCalled();
	});
});

describe('removeBotById', () => {
	test('removes bot from items and calls disconnect', () => {
		const store = useBotsStore();
		store.setBots([{ id: '1', name: 'A' }, { id: '2', name: 'B' }]);
		store.removeBotById('1');

		expect(store.items).toHaveLength(1);
		expect(store.items[0].id).toBe('2');
		expect(mockManager.disconnect).toHaveBeenCalledWith('1');
	});

	test('calls removeSessionsByBotId on sessions store', () => {
		const store = useBotsStore();
		const sessionsStore = useSessionsStore();
		store.setBots([{ id: '5', name: 'Bot' }]);
		sessionsStore.setSessions([
			{ sessionId: 'sa', botId: '5' },
			{ sessionId: 'sb', botId: '99' },
		]);

		store.removeBotById('5');

		expect(sessionsStore.items).toHaveLength(1);
		expect(sessionsStore.items[0].sessionId).toBe('sb');
	});

	test('is a no-op when bot is not found', () => {
		const store = useBotsStore();
		store.setBots([{ id: '1', name: 'A' }]);

		expect(() => store.removeBotById('999')).not.toThrow();
		expect(store.items).toHaveLength(1);
		// disconnect still called but items unchanged
		expect(mockManager.disconnect).toHaveBeenCalledWith('999');
	});
});

describe('updateBotOnline', () => {
	test('flips online flag for matching bot', () => {
		const store = useBotsStore();
		store.setBots([{ id: '1', name: 'A', online: false }]);
		store.updateBotOnline('1', true);

		expect(store.items[0].online).toBe(true);
	});

	test('coerces truthy value to boolean true', () => {
		const store = useBotsStore();
		store.setBots([{ id: '1', online: false }]);
		store.updateBotOnline('1', 1);

		expect(store.items[0].online).toBe(true);
	});

	test('is a no-op when bot is not found', () => {
		const store = useBotsStore();
		store.setBots([{ id: '1', online: true }]);

		expect(() => store.updateBotOnline('999', false)).not.toThrow();
		expect(store.items[0].online).toBe(true);
	});

	test('bot 离线时清理 agents 缓存', () => {
		const store = useBotsStore();
		store.setBots([{ id: '1', online: true }]);

		const agentsStore = useAgentsStore();
		agentsStore.byBot['1'] = { agents: [{ id: 'main' }], defaultId: 'main', loading: false, fetched: true };

		store.updateBotOnline('1', false);

		expect(store.items[0].online).toBe(false);
		expect(agentsStore.byBot['1']).toBeUndefined();
	});

	test('bot 上线时不清理 agents 缓存', () => {
		const store = useBotsStore();
		store.setBots([{ id: '1', online: false }]);

		const agentsStore = useAgentsStore();
		agentsStore.byBot['1'] = { agents: [{ id: 'main' }], defaultId: 'main', loading: false, fetched: true };

		store.updateBotOnline('1', true);

		expect(agentsStore.byBot['1']).toBeDefined();
	});
});

describe('loadBots', () => {
	test('fetches bots, normalizes id to string, and calls syncConnections', async () => {
		const store = useBotsStore();
		const bots = [{ id: 1, name: 'A' }, { id: '2', name: 'B' }];
		listBots.mockResolvedValue(bots);

		await store.loadBots();

		// bot.id 应被归一化为 string
		expect(store.items[0].id).toBe('1');
		expect(store.items[1].id).toBe('2');
		expect(mockManager.syncConnections).toHaveBeenCalledOnce();
		expect(mockManager.syncConnections).toHaveBeenCalledWith(['1', '2']);
	});

	test('returns the normalized bots array', async () => {
		const store = useBotsStore();
		listBots.mockResolvedValue([{ id: 3, name: 'C' }]);

		const result = await store.loadBots();

		expect(result).toEqual([{ id: '3', name: 'C' }]);
	});

	test('sets loading to true during fetch', async () => {
		const store = useBotsStore();
		let loadingDuringFetch = null;
		listBots.mockImplementation(() => {
			loadingDuringFetch = store.loading;
			return Promise.resolve([]);
		});

		await store.loadBots();

		expect(loadingDuringFetch).toBe(true);
	});

	test('resets loading to false after successful fetch', async () => {
		const store = useBotsStore();
		listBots.mockResolvedValue([]);

		await store.loadBots();

		expect(store.loading).toBe(false);
	});

	test('resets loading to false even on error', async () => {
		const store = useBotsStore();
		listBots.mockRejectedValue(new Error('network error'));

		await expect(store.loadBots()).rejects.toThrow('network error');
		expect(store.loading).toBe(false);
	});

	test('registers persistent state listener on non-connected connections and triggers full init on connected', async () => {
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadAllSessions').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadAllTopics').mockResolvedValue();

		// 模拟一个处于 connecting 状态的连接
		let stateCallback;
		const fakeConn = {
			state: 'connecting',
			on: vi.fn((event, cb) => { if (event === 'state') stateCallback = cb; }),
			off: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);
		listBots.mockResolvedValue([{ id: '1', name: 'A' }]);

		await store.loadBots();

		// 注册持久 state 监听器（不移除）
		expect(fakeConn.on).toHaveBeenCalledWith('state', expect.any(Function));

		// 模拟 WS 连接就绪
		stateCallback('connected');

		// 持久监听器不调用 off
		expect(fakeConn.off).not.toHaveBeenCalled();
		// fire 是 async（含 checkPluginVersion），需等待
		await vi.waitFor(() => {
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('1');
		});
		await vi.waitFor(() => {
			expect(sessionsStore.loadAllSessions).toHaveBeenCalled();
		});
	});

	test('immediately triggers full init for already-connected bots and registers persistent listener', async () => {
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadAllSessions').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadAllTopics').mockResolvedValue();
		const fakeConn = { state: 'connected', on: vi.fn(), off: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);
		listBots.mockResolvedValue([{ id: '1', name: 'A' }]);

		await store.loadBots();

		// 注册持久 state 监听器（用于 WS 重连时重新触发传输选择）
		expect(fakeConn.on).toHaveBeenCalledWith('state', expect.any(Function));
		expect(agentsStore.loadAgents).toHaveBeenCalledWith('1');
		await vi.waitFor(() => {
			expect(sessionsStore.loadAllSessions).toHaveBeenCalled();
		});
	});

	test('stores pluginVersionOk and pluginInfo per bot after version check', async () => {
		const { checkPluginVersion } = await import('../utils/plugin-version.js');
		checkPluginVersion.mockResolvedValue({ ok: true, version: '0.6.0', clawVersion: '2026.3.14' });
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadAllSessions').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadAllTopics').mockResolvedValue();
		const fakeConn = { state: 'connected', on: vi.fn(), off: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);
		listBots.mockResolvedValue([{ id: '1', name: 'A' }]);

		await store.loadBots();

		await vi.waitFor(() => {
			expect(store.pluginVersionOk['1']).toBe(true);
			expect(store.pluginInfo['1']).toEqual({ version: '0.6.0', clawVersion: '2026.3.14' });
		});
	});

	test('proceeds to loadAgents even when plugin version check fails', async () => {
		const { checkPluginVersion } = await import('../utils/plugin-version.js');
		checkPluginVersion.mockResolvedValue({ ok: false, version: null, clawVersion: null });
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadAllSessions').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadAllTopics').mockResolvedValue();
		const fakeConn = { state: 'connected', on: vi.fn(), off: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);
		listBots.mockResolvedValue([{ id: '2', name: 'B' }]);

		await store.loadBots();

		await vi.waitFor(() => {
			expect(store.pluginVersionOk['2']).toBe(false);
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('2');
			expect(sessionsStore.loadAllSessions).toHaveBeenCalled();
			expect(topicsStore.loadAllTopics).toHaveBeenCalled();
		});
	});

	test('does not register duplicate listeners for the same botId', async () => {
		const store = useBotsStore();
		vi.spyOn(useTopicsStore(), 'loadAllTopics').mockResolvedValue();
		const fakeConn = { state: 'connecting', on: vi.fn(), off: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);
		listBots.mockResolvedValue([{ id: '1', name: 'A' }]);

		await store.loadBots();
		await store.loadBots();

		// on should be called only once for the same botId
		expect(fakeConn.on).toHaveBeenCalledTimes(1);
	});
});

describe('WebRTC 集成', () => {
	test('__listenForReady 中为已 connected 的 bot 调用 initRtcAndSelectTransport', async () => {
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadAllSessions').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadAllTopics').mockResolvedValue();

		const fakeConn = { state: 'connected', on: vi.fn(), off: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);
		listBots.mockResolvedValue([{ id: '1', name: 'A' }]);

		await store.loadBots();

		await vi.waitFor(() => {
			expect(mockInitRtcAndSelectTransport).toHaveBeenCalledWith('1', fakeConn);
		});
	});

	test('__listenForReady 中为 connecting 的 bot 在就绪后调用 initRtcAndSelectTransport', async () => {
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadAllSessions').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadAllTopics').mockResolvedValue();

		let stateCallback;
		const fakeConn = {
			state: 'connecting',
			on: vi.fn((event, cb) => { if (event === 'state') stateCallback = cb; }),
			off: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);
		listBots.mockResolvedValue([{ id: '2', name: 'B' }]);

		await store.loadBots();
		expect(mockInitRtcAndSelectTransport).not.toHaveBeenCalled();

		stateCallback('connected');

		await vi.waitFor(() => {
			expect(mockInitRtcAndSelectTransport).toHaveBeenCalledWith('2', fakeConn);
		});
	});

	test('removeBotById 调用 closeRtcForBot', () => {
		const store = useBotsStore();
		store.setBots([{ id: '5', name: 'Bot' }]);
		store.removeBotById('5');

		expect(mockCloseRtcForBot).toHaveBeenCalledWith('5');
	});

	test('removeBotById 清理传输相关状态', () => {
		const store = useBotsStore();
		store.setBots([{ id: '5', name: 'Bot' }, { id: '6', name: 'Bot2' }]);
		store.transportModes = { '5': 'rtc', '6': 'ws' };
		store.rtcStates = { '5': 'connected', '6': 'idle' };
		store.rtcTransportInfo = { '5': { localType: 'host' }, '6': { localType: 'relay' } };

		store.removeBotById('5');

		expect(store.transportModes).toEqual({ '6': 'ws' });
		expect(store.rtcStates).toEqual({ '6': 'idle' });
		expect(store.rtcTransportInfo).toEqual({ '6': { localType: 'relay' } });
	});

	test('state 初始包含 rtcStates、rtcTransportInfo 和 transportModes', () => {
		const store = useBotsStore();
		expect(store.rtcStates).toEqual({});
		expect(store.rtcTransportInfo).toEqual({});
		expect(store.transportModes).toEqual({});
	});
});
