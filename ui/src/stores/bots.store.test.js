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
import { useAgentRunsStore } from './agent-runs.store.js';
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
	test('populates byId from array', () => {
		const store = useBotsStore();
		store.setBots([{ id: '1', name: 'Bot A' }, { id: '2', name: 'Bot B' }]);
		expect(Object.keys(store.byId)).toEqual(['1', '2']);
		expect(store.byId['1'].name).toBe('Bot A');
		expect(store.byId['2'].name).toBe('Bot B');
	});

	test('items getter returns array of all bots', () => {
		const store = useBotsStore();
		store.setBots([{ id: '1', name: 'Bot A' }, { id: '2', name: 'Bot B' }]);
		expect(store.items).toHaveLength(2);
		expect(store.items.map(b => b.id)).toEqual(['1', '2']);
	});

	test('guards against non-array input by setting byId to empty', () => {
		const store = useBotsStore();
		store.setBots('not-an-array');
		expect(store.items).toEqual([]);
	});

	test('guards against null input by setting byId to empty', () => {
		const store = useBotsStore();
		store.setBots(null);
		expect(store.items).toEqual([]);
	});

	test('preserves runtime state for existing bots', () => {
		const store = useBotsStore();
		store.byId['1'] = { id: '1', name: 'OldName', online: true, connState: 'connected', initialized: true, transportMode: 'rtc', pluginVersionOk: null, pluginInfo: null, rtcState: null, rtcTransportInfo: null, lastAliveAt: 0, disconnectedAt: 0, lastSeenAt: null, createdAt: null, updatedAt: null };
		store.setBots([{ id: '1', name: 'NewName' }]);
		expect(store.byId['1'].name).toBe('NewName');
		expect(store.byId['1'].connState).toBe('connected');
		expect(store.byId['1'].initialized).toBe(true);
	});
});

describe('addOrUpdateBot', () => {
	test('inserts new bot with normalized fields and calls connect', () => {
		const store = useBotsStore();
		const fakeConn = { state: 'connecting', on: vi.fn(), off: vi.fn(), __onAlive: null };
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

		expect(store.byId['42']).toBeDefined();
		expect(store.byId['42'].id).toBe('42');
		expect(store.byId['42'].name).toBe('NewBot');
		expect(store.byId['42'].online).toBe(true);
		expect(store.byId['42'].connState).toBe('connecting'); // bridge syncs
		expect(mockManager.connect).toHaveBeenCalledOnce();
		expect(mockManager.connect).toHaveBeenCalledWith('42');
	});

	test('normalizes missing optional fields to null and online to false', () => {
		const store = useBotsStore();
		const fakeConn = { state: 'disconnected', on: vi.fn(), __onAlive: null };
		mockManager.get.mockReturnValue(fakeConn);
		store.addOrUpdateBot({ id: '7' });

		expect(store.byId['7'].name).toBeNull();
		expect(store.byId['7'].online).toBe(false);
		expect(store.byId['7'].lastSeenAt).toBeNull();
	});

	test('updates existing bot in place and calls connect', () => {
		const store = useBotsStore();
		const fakeConn = { state: 'disconnected', on: vi.fn(), __onAlive: null };
		mockManager.get.mockReturnValue(fakeConn);
		store.setBots([{ id: '1', name: 'OldName', online: false }]);
		store.addOrUpdateBot({ id: '1', name: 'NewName', online: true });

		expect(Object.keys(store.byId)).toHaveLength(1);
		expect(store.byId['1'].name).toBe('NewName');
		expect(store.byId['1'].online).toBe(true);
		expect(mockManager.connect).toHaveBeenCalledWith('1');
	});

	test('watcher triggers agents/sessions/topics load when connection becomes ready', async () => {
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
			__onAlive: null,
			disconnectedAt: 0,
			lastAliveAt: 0,
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateBot({ id: '10', name: 'Fresh' });
		expect(fakeConn.on).toHaveBeenCalledWith('state', expect.any(Function));

		// 模拟连接就绪 → bridge 写入 connState → watcher 触发 __onBotConnected
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

		const fakeConn = { state: 'connected', on: vi.fn(), off: vi.fn(), request: vi.fn().mockResolvedValue({}), __onAlive: null, disconnectedAt: 0, lastAliveAt: 0 };
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateBot({ id: '11', name: 'AlreadyReady' });

		// bridge syncs connState='connected' → watcher fires → __onBotConnected
		await vi.waitFor(() => {
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('11');
			expect(sessionsStore.loadAllSessions).toHaveBeenCalled();
			expect(topicsStore.loadAllTopics).toHaveBeenCalled();
		});
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
	test('removes bot from byId and calls disconnect', () => {
		const store = useBotsStore();
		store.setBots([{ id: '1', name: 'A' }, { id: '2', name: 'B' }]);
		store.removeBotById('1');

		expect(store.byId['1']).toBeUndefined();
		expect(store.byId['2']).toBeDefined();
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

	test('calls removeByBot on agentRuns store', () => {
		const store = useBotsStore();
		const agentRunsStore = useAgentRunsStore();
		const spy = vi.spyOn(agentRunsStore, 'removeByBot');
		store.setBots([{ id: '3', name: 'Bot' }]);

		store.removeBotById('3');

		expect(spy).toHaveBeenCalledWith('3');
	});

	test('is a no-op when bot is not found', () => {
		const store = useBotsStore();
		store.setBots([{ id: '1', name: 'A' }]);

		expect(() => store.removeBotById('999')).not.toThrow();
		expect(store.items).toHaveLength(1);
		expect(mockManager.disconnect).toHaveBeenCalledWith('999');
	});

	test('cleans up all per-bot state in one operation', () => {
		const store = useBotsStore();
		store.setBots([{ id: '5', name: 'Bot' }, { id: '6', name: 'Bot2' }]);
		store.byId['5'].transportMode = 'rtc';
		store.byId['5'].rtcState = 'connected';
		store.byId['5'].rtcTransportInfo = { localType: 'host' };
		store.byId['6'].transportMode = 'ws';

		store.removeBotById('5');

		expect(store.byId['5']).toBeUndefined();
		expect(store.byId['6'].transportMode).toBe('ws');
	});
});

describe('updateBotOnline', () => {
	test('flips online flag for matching bot', () => {
		const store = useBotsStore();
		store.setBots([{ id: '1', name: 'A', online: false }]);
		store.updateBotOnline('1', true);

		expect(store.byId['1'].online).toBe(true);
	});

	test('coerces truthy value to boolean true', () => {
		const store = useBotsStore();
		store.setBots([{ id: '1', online: false }]);
		store.updateBotOnline('1', 1);

		expect(store.byId['1'].online).toBe(true);
	});

	test('is a no-op when bot is not found', () => {
		const store = useBotsStore();
		store.setBots([{ id: '1', online: true }]);

		expect(() => store.updateBotOnline('999', false)).not.toThrow();
		expect(store.byId['1'].online).toBe(true);
	});

	test('bot 离线时清理 agents 缓存', () => {
		const store = useBotsStore();
		store.setBots([{ id: '1', online: true }]);

		const agentsStore = useAgentsStore();
		agentsStore.byBot['1'] = { agents: [{ id: 'main' }], defaultId: 'main', loading: false, fetched: true };

		store.updateBotOnline('1', false);

		expect(store.byId['1'].online).toBe(false);
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
		mockManager.get.mockReturnValue(null);

		await store.loadBots();

		expect(store.byId['1']).toBeDefined();
		expect(store.byId['2']).toBeDefined();
		expect(store.byId['1'].id).toBe('1');
		expect(mockManager.syncConnections).toHaveBeenCalledOnce();
		expect(mockManager.syncConnections).toHaveBeenCalledWith(['1', '2']);
	});

	test('returns the items array', async () => {
		const store = useBotsStore();
		listBots.mockResolvedValue([{ id: 3, name: 'C' }]);
		mockManager.get.mockReturnValue(null);

		const result = await store.loadBots();

		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('3');
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

	test('bridges conn state and triggers full init when connection becomes ready', async () => {
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
			__onAlive: null,
			disconnectedAt: 0,
			lastAliveAt: 0,
		};
		mockManager.get.mockReturnValue(fakeConn);
		listBots.mockResolvedValue([{ id: '1', name: 'A' }]);

		await store.loadBots();
		expect(fakeConn.on).toHaveBeenCalledWith('state', expect.any(Function));

		// 模拟 WS 连接就绪
		stateCallback('connected');


		await vi.waitFor(() => {
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('1');
		});
		await vi.waitFor(() => {
			expect(sessionsStore.loadAllSessions).toHaveBeenCalled();
		});
	});

	test('immediately triggers full init for already-connected bots', async () => {
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadAllSessions').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadAllTopics').mockResolvedValue();
		const fakeConn = { state: 'connected', on: vi.fn(), off: vi.fn(), __onAlive: null, disconnectedAt: 0, lastAliveAt: 0 };
		mockManager.get.mockReturnValue(fakeConn);
		listBots.mockResolvedValue([{ id: '1', name: 'A' }]);

		await store.loadBots();

		// bridge syncs connState='connected', watcher triggers __onBotConnected
		await vi.waitFor(() => {
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('1');
		});
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
		const fakeConn = { state: 'connected', on: vi.fn(), off: vi.fn(), __onAlive: null, disconnectedAt: 0, lastAliveAt: 0 };
		mockManager.get.mockReturnValue(fakeConn);
		listBots.mockResolvedValue([{ id: '1', name: 'A' }]);

		await store.loadBots();


		await vi.waitFor(() => {
			expect(store.byId['1'].pluginVersionOk).toBe(true);
			expect(store.byId['1'].pluginInfo).toEqual({ version: '0.6.0', clawVersion: '2026.3.14' });
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
		const fakeConn = { state: 'connected', on: vi.fn(), off: vi.fn(), __onAlive: null, disconnectedAt: 0, lastAliveAt: 0 };
		mockManager.get.mockReturnValue(fakeConn);
		listBots.mockResolvedValue([{ id: '2', name: 'B' }]);

		await store.loadBots();


		await vi.waitFor(() => {
			expect(store.byId['2'].pluginVersionOk).toBe(false);
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('2');
			expect(sessionsStore.loadAllSessions).toHaveBeenCalled();
			expect(topicsStore.loadAllTopics).toHaveBeenCalled();
		});
	});

	test('does not register duplicate bridge for the same conn instance', async () => {
		const store = useBotsStore();
		vi.spyOn(useTopicsStore(), 'loadAllTopics').mockResolvedValue();
		const fakeConn = { state: 'connecting', on: vi.fn(), off: vi.fn(), __onAlive: null, disconnectedAt: 0, lastAliveAt: 0 };
		mockManager.get.mockReturnValue(fakeConn);
		listBots.mockResolvedValue([{ id: '1', name: 'A' }]);

		await store.loadBots();
		await store.loadBots();

		// on('state') should be called only once for the same conn instance
		const stateCalls = fakeConn.on.mock.calls.filter(([ev]) => ev === 'state');
		expect(stateCalls).toHaveLength(1);
	});

	test('bridge 注册 session-expired 监听并派发 auth:session-expired', async () => {
		const store = useBotsStore();
		vi.spyOn(useTopicsStore(), 'loadAllTopics').mockResolvedValue();
		const fakeConn = { state: 'connecting', on: vi.fn(), off: vi.fn(), __onAlive: null, disconnectedAt: 0, lastAliveAt: 0 };
		mockManager.get.mockReturnValue(fakeConn);
		listBots.mockResolvedValue([{ id: '1', name: 'A' }]);

		await store.loadBots();

		// 应注册 session-expired 监听
		const sessionExpiredCalls = fakeConn.on.mock.calls.filter(([ev]) => ev === 'session-expired');
		expect(sessionExpiredCalls).toHaveLength(1);

		// 触发后应派发 window 事件
		const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
		sessionExpiredCalls[0][1]();
		const event = dispatchSpy.mock.calls.find(
			([e]) => e instanceof CustomEvent && e.type === 'auth:session-expired',
		);
		expect(event).toBeTruthy();
		dispatchSpy.mockRestore();
	});
});

describe('WebRTC 集成', () => {
	test('__bridgeConn + watcher 为已 connected 的 bot 调用 initRtcAndSelectTransport', async () => {
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadAllSessions').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadAllTopics').mockResolvedValue();

		const fakeConn = { state: 'connected', on: vi.fn(), off: vi.fn(), __onAlive: null, disconnectedAt: 0, lastAliveAt: 0 };
		mockManager.get.mockReturnValue(fakeConn);
		listBots.mockResolvedValue([{ id: '1', name: 'A' }]);

		await store.loadBots();


		await vi.waitFor(() => {
			expect(mockInitRtcAndSelectTransport).toHaveBeenCalledWith('1', fakeConn);
		});
	});

	test('为 connecting 的 bot 在就绪后调用 initRtcAndSelectTransport', async () => {
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
			__onAlive: null,
			disconnectedAt: 0,
			lastAliveAt: 0,
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

	test('byId 初始包含 connState、transportMode、rtcState 等字段', () => {
		const store = useBotsStore();
		store.setBots([{ id: '1', name: 'Bot' }]);
		const bot = store.byId['1'];
		expect(bot.connState).toBe('disconnected');
		expect(bot.transportMode).toBeNull();
		expect(bot.rtcState).toBeNull();
		expect(bot.rtcTransportInfo).toBeNull();
		expect(bot.pluginVersionOk).toBeNull();
		expect(bot.pluginInfo).toBeNull();
	});
});

describe('重连后批量状态刷新', () => {
	test('断连时长 >= BRIEF_DISCONNECT_MS 时刷新 agents/sessions/topics', async () => {
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
			disconnectedAt: Date.now() - 10_000,
			on: vi.fn((event, cb) => { if (event === 'state') stateCallback = cb; }),
			off: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
			__onAlive: null,
			lastAliveAt: 0,
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateBot({ id: '20', name: 'Bot' });
		// 首次 connected：全量初始化
		stateCallback('connected');
		await vi.waitFor(() => {
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('20');
		});

		agentsStore.loadAgents.mockClear();
		sessionsStore.loadAllSessions.mockClear();
		topicsStore.loadAllTopics.mockClear();

		// 模拟断连
		stateCallback('disconnected');


		// 模拟断连 10s 后重连
		fakeConn.disconnectedAt = Date.now() - 10_000;
		stateCallback('connected');


		await vi.waitFor(() => {
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('20');
			expect(sessionsStore.loadAllSessions).toHaveBeenCalled();
			expect(topicsStore.loadAllTopics).toHaveBeenCalled();
		});
	});

	test('断连时长 < BRIEF_DISCONNECT_MS 时不刷新 agents/sessions/topics', async () => {
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
			disconnectedAt: 0,
			on: vi.fn((event, cb) => { if (event === 'state') stateCallback = cb; }),
			off: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
			__onAlive: null,
			lastAliveAt: 0,
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateBot({ id: '21', name: 'Bot' });
		stateCallback('connected');
		await vi.waitFor(() => {
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('21');
		});

		agentsStore.loadAgents.mockClear();
		sessionsStore.loadAllSessions.mockClear();
		topicsStore.loadAllTopics.mockClear();

		// 模拟断连
		stateCallback('disconnected');


		// 模拟短暂抖动（2s）
		fakeConn.disconnectedAt = Date.now() - 2000;
		stateCallback('connected');

		await Promise.resolve();

		expect(agentsStore.loadAgents).not.toHaveBeenCalled();
		expect(sessionsStore.loadAllSessions).not.toHaveBeenCalled();
		expect(topicsStore.loadAllTopics).not.toHaveBeenCalled();
	});
});

describe('bridge connState 同步', () => {
	test('bridge 将 conn.on(state) 实时写入 byId[id].connState', async () => {
		const store = useBotsStore();
		let stateCallback;
		const fakeConn = {
			state: 'disconnected',
			on: vi.fn((event, cb) => { if (event === 'state') stateCallback = cb; }),
			__onAlive: null,
			disconnectedAt: 0,
			lastAliveAt: 0,
		};
		mockManager.get.mockReturnValue(fakeConn);
		listBots.mockResolvedValue([{ id: '1', name: 'A' }]);

		await store.loadBots();
		expect(store.byId['1'].connState).toBe('disconnected');

		stateCallback('connecting');
		expect(store.byId['1'].connState).toBe('connecting');

		stateCallback('connected');
		expect(store.byId['1'].connState).toBe('connected');

		fakeConn.disconnectedAt = Date.now();
		stateCallback('disconnected');
		expect(store.byId['1'].connState).toBe('disconnected');
		expect(store.byId['1'].disconnectedAt).toBeGreaterThan(0);
	});

	test('__onAlive 回调实时同步 lastAliveAt', async () => {
		const store = useBotsStore();
		const fakeConn = {
			state: 'disconnected',
			on: vi.fn(),
			__onAlive: null,
			disconnectedAt: 0,
			lastAliveAt: 0,
		};
		mockManager.get.mockReturnValue(fakeConn);
		listBots.mockResolvedValue([{ id: '1', name: 'A' }]);

		await store.loadBots();

		// bridge 应注册 __onAlive 回调
		expect(fakeConn.__onAlive).toBeInstanceOf(Function);

		const ts = Date.now();
		fakeConn.__onAlive(ts);
		expect(store.byId['1'].lastAliveAt).toBe(ts);
	});
});
