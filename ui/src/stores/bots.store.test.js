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

const __fakeRtc = { isReady: true, state: 'connected' };
// 默认 mock：initRtc 成功时设置 conn.rtc，模拟 DC 就绪
const mockInitRtc = vi.fn().mockImplementation(async (_botId, conn) => { conn.rtc = __fakeRtc; return 'rtc'; });
const mockCloseRtcForBot = vi.fn();
vi.mock('../services/webrtc-connection.js', () => ({
	initRtc: (...args) => mockInitRtc(...args),
	initRtc: (...args) => mockInitRtc(...args),
	closeRtcForBot: (...args) => mockCloseRtcForBot(...args),
}));

import { listBots } from '../services/bots.api.js';
import { useAgentRunsStore } from './agent-runs.store.js';
import { useAgentsStore } from './agents.store.js';
import { useBotsStore, __resetAwaitingConnIds } from './bots.store.js';
import { useDashboardStore } from './dashboard.store.js';
import { useSessionsStore } from './sessions.store.js';
import { useTopicsStore } from './topics.store.js';

beforeEach(() => {
	setActivePinia(createPinia());
	vi.clearAllMocks();
	mockManager.get.mockReset();
	mockInitRtc.mockReset().mockImplementation(async (_botId, conn) => { conn.rtc = __fakeRtc; return 'rtc'; });
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
		store.byId['1'] = { id: '1', name: 'OldName', online: true, connState: 'connected', initialized: true, pluginVersionOk: null, pluginInfo: null, rtcState: null, rtcTransportInfo: null, lastAliveAt: 0, disconnectedAt: 0, lastSeenAt: null, createdAt: null, updatedAt: null };
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
			rtc: null, clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateBot({ id: '10', name: 'Fresh', online: true });
		expect(fakeConn.on).toHaveBeenCalledWith('state', expect.any(Function));

		// 模拟连接就绪 → bridge 写入 connState → watcher 触发 __onBotConnected
		fakeConn.state = 'connected';
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

		const fakeConn = { state: 'connected', on: vi.fn(), off: vi.fn(), request: vi.fn().mockResolvedValue({}), __onAlive: null, disconnectedAt: 0, lastAliveAt: 0, rtc: null, clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateBot({ id: '11', name: 'AlreadyReady', online: true });

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
		store.byId['5'].rtcState = 'connected';
		store.byId['5'].rtcTransportInfo = { localType: 'host' };

		store.removeBotById('5');

		expect(store.byId['5']).toBeUndefined();
		expect(store.byId['6']).toBeDefined();
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

	test('bot 上线且 connState=connected 但 initialized=false 时重试初始化', async () => {
		const { checkPluginVersion } = await import('../utils/plugin-version.js');
		checkPluginVersion.mockResolvedValue({ ok: true, version: '0.6.0', clawVersion: '2026.3.14' });
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadAllSessions').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadAllTopics').mockResolvedValue();

		const fakeConn = {
			state: 'connected', on: vi.fn(), off: vi.fn(), __onAlive: null,
			disconnectedAt: 0, lastAliveAt: 0, rtc: null, clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setBots([{ id: '1', online: false }]);
		// 模拟 __fullInit 失败后的状态
		store.byId['1'].connState = 'connected';
		store.byId['1'].initialized = false;

		store.updateBotOnline('1', true);

		await vi.waitFor(() => {
			expect(store.byId['1'].initialized).toBe(true);
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('1');
		});
	});

	test('bot 上线但 initialized=true 时走 __ensureRtc 而非 __onBotConnected', () => {
		const store = useBotsStore();
		const fakeConn = {
			state: 'connected', on: vi.fn(), off: vi.fn(), __onAlive: null,
			disconnectedAt: 0, lastAliveAt: 0, rtc: null, clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setBots([{ id: '1', online: false }]);
		store.byId['1'].connState = 'connected';
		store.byId['1'].initialized = true;

		const spy = vi.spyOn(store, '__onBotConnected');
		store.updateBotOnline('1', true);

		expect(spy).not.toHaveBeenCalled();
	});
});

describe('applySnapshot', () => {
	test('sets byId from snapshot items and calls syncConnections + bridgeConn', () => {
		const store = useBotsStore();
		mockManager.get.mockReturnValue(null);

		const items = [
			{ id: '1', name: 'A', online: true },
			{ id: '2', name: 'B', online: false },
		];
		store.applySnapshot(items);

		expect(Object.keys(store.byId)).toEqual(['1', '2']);
		expect(store.byId['1'].name).toBe('A');
		expect(store.byId['1'].online).toBe(true);
		expect(store.byId['2'].online).toBe(false);
		expect(store.fetched).toBe(true);
		expect(mockManager.syncConnections).toHaveBeenCalledWith(['1', '2']);
	});

	test('preserves runtime state for existing bots', () => {
		const store = useBotsStore();
		mockManager.get.mockReturnValue(null);

		// 先添加一个 bot，模拟已有运行时状态
		store.byId['1'] = {
			id: '1', name: 'old', online: false,
			connState: 'connected', initialized: true,
			pluginVersionOk: true,
		};

		store.applySnapshot([{ id: '1', name: 'new', online: false }]);

		// 基础信息更新
		expect(store.byId['1'].name).toBe('new');
		// 运行时状态保留
		expect(store.byId['1'].connState).toBe('connected');
		expect(store.byId['1'].initialized).toBe(true);
	});

	test('preserves online=true when connState is connected (same as loadBots)', () => {
		const store = useBotsStore();
		mockManager.get.mockReturnValue(null);

		store.byId['1'] = {
			id: '1', name: 'a', online: true,
			connState: 'connected',
		};

		// 快照说 offline，但 WS 已连接 → 保留 online=true
		store.applySnapshot([{ id: '1', name: 'a', online: false }]);
		expect(store.byId['1'].online).toBe(true);
	});

	test('removes bots not in snapshot and cleans up RTC/sessions/agentRuns', () => {
		const store = useBotsStore();
		const sessionsStore = useSessionsStore();
		const agentRunsStore = useAgentRunsStore();
		const removeSessionsSpy = vi.spyOn(sessionsStore, 'removeSessionsByBotId');
		const removeAgentRunsSpy = vi.spyOn(agentRunsStore, 'removeByBot');
		mockManager.get.mockReturnValue(null);

		store.byId['1'] = { id: '1', name: 'old' };
		store.byId['2'] = { id: '2', name: 'will-be-removed' };

		store.applySnapshot([{ id: '1', name: 'kept' }]);

		expect(store.byId['1']).toBeDefined();
		expect(store.byId['2']).toBeUndefined();
		// 被移除的 bot 应清理关联资源
		expect(mockCloseRtcForBot).toHaveBeenCalledWith('2');
		expect(removeSessionsSpy).toHaveBeenCalledWith('2');
		expect(removeAgentRunsSpy).toHaveBeenCalledWith('2');
	});

	test('skips items with null/undefined id', () => {
		const store = useBotsStore();
		mockManager.get.mockReturnValue(null);

		store.applySnapshot([
			{ id: null, name: 'bad' },
			{ id: undefined, name: 'bad2' },
			{ id: '1', name: 'good' },
		]);

		expect(Object.keys(store.byId)).toEqual(['1']);
	});

	test('handles empty items array', () => {
		const store = useBotsStore();
		mockManager.get.mockReturnValue(null);

		store.applySnapshot([]);

		expect(Object.keys(store.byId)).toEqual([]);
		expect(store.fetched).toBe(true);
		expect(mockManager.syncConnections).toHaveBeenCalledWith([]);
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
			rtc: null, clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);
		listBots.mockResolvedValue([{ id: '1', name: 'A', online: true }]);

		await store.loadBots();
		expect(fakeConn.on).toHaveBeenCalledWith('state', expect.any(Function));

		// 模拟 WS 连接就绪
		fakeConn.state = 'connected';
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
		const fakeConn = { state: 'connected', on: vi.fn(), off: vi.fn(), __onAlive: null, disconnectedAt: 0, lastAliveAt: 0, rtc: null, clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);
		listBots.mockResolvedValue([{ id: '1', name: 'A', online: true }]);

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
		const fakeConn = { state: 'connected', on: vi.fn(), off: vi.fn(), __onAlive: null, disconnectedAt: 0, lastAliveAt: 0, rtc: null, clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);
		listBots.mockResolvedValue([{ id: '1', name: 'A', online: true }]);

		await store.loadBots();


		await vi.waitFor(() => {
			expect(store.byId['1'].pluginVersionOk).toBe(true);
			expect(store.byId['1'].pluginInfo).toEqual({ version: '0.6.0', clawVersion: '2026.3.14' });
		});
	});

	test('plugin version check RPC 失败（version: null，bot 不可达）→ fullInit 中止，initialized 重置', async () => {
		const { checkPluginVersion } = await import('../utils/plugin-version.js');
		checkPluginVersion.mockResolvedValue({ ok: false, version: null, clawVersion: null });
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		const fakeConn = {
			state: 'connected', on: vi.fn(), off: vi.fn(), __onAlive: null,
			disconnectedAt: 0, lastAliveAt: 0, rtc: null, clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);
		listBots.mockResolvedValue([{ id: '2', name: 'B', online: true }]);

		await store.loadBots();

		// bot 不可达 → fullInit 抛出 → initialized 重置为 false
		await vi.waitFor(() => {
			expect(store.byId['2'].pluginVersionOk).toBe(false);
			expect(store.byId['2'].initialized).toBe(false);
		});
		// loadAgents 不应被调用（fullInit 在 checkPluginVersion 后中止）
		expect(agentsStore.loadAgents).not.toHaveBeenCalled();
	});

	test('plugin version 真正过旧（version 有值）时继续 loadAgents', async () => {
		const { checkPluginVersion } = await import('../utils/plugin-version.js');
		checkPluginVersion.mockResolvedValue({ ok: false, version: '0.3.0', clawVersion: '2025.1.1' });
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadAllSessions').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadAllTopics').mockResolvedValue();
		const fakeConn = { state: 'connected', on: vi.fn(), off: vi.fn(), __onAlive: null, disconnectedAt: 0, lastAliveAt: 0, rtc: null, clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);
		listBots.mockResolvedValue([{ id: '2', name: 'B', online: true }]);

		await store.loadBots();

		await vi.waitFor(() => {
			expect(store.byId['2'].pluginVersionOk).toBe(false);
			expect(store.byId['2'].pluginInfo).toEqual({ version: '0.3.0', clawVersion: '2025.1.1' });
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('2');
			expect(sessionsStore.loadAllSessions).toHaveBeenCalled();
			expect(topicsStore.loadAllTopics).toHaveBeenCalled();
		});
	});

	test('preserves online=true when connState is connected even if HTTP returns online=false', async () => {
		const store = useBotsStore();
		// 预设 bot，模拟 WS 已连接
		store.byId['1'] = {
			id: '1', name: 'A', online: true, connState: 'connected',
			initialized: true, pluginVersionOk: null,
			pluginInfo: null, rtcState: null, rtcTransportInfo: null,
			lastAliveAt: Date.now(), disconnectedAt: 0, lastSeenAt: null,
			createdAt: null, updatedAt: null,
		};
		// HTTP 返回 online: false（server 尚未感知重连）
		listBots.mockResolvedValue([{ id: '1', name: 'A-updated', online: false }]);
		mockManager.get.mockReturnValue(null);

		await store.loadBots();

		// online 应被保留为 true
		expect(store.byId['1'].online).toBe(true);
		// 其他基础信息应被更新
		expect(store.byId['1'].name).toBe('A-updated');
	});

	test('allows HTTP online=false when connState is not connected', async () => {
		const store = useBotsStore();
		store.byId['1'] = {
			id: '1', name: 'A', online: true, connState: 'disconnected',
			initialized: false, pluginVersionOk: null,
			pluginInfo: null, rtcState: null, rtcTransportInfo: null,
			lastAliveAt: 0, disconnectedAt: 0, lastSeenAt: null,
			createdAt: null, updatedAt: null,
		};
		listBots.mockResolvedValue([{ id: '1', name: 'A', online: false }]);
		mockManager.get.mockReturnValue(null);

		await store.loadBots();

		// connState 不是 connected，应正常接受 HTTP 的 online 值
		expect(store.byId['1'].online).toBe(false);
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
	test('__fullInit: bot online 时通过 __ensureRtc 调用 initRtc', async () => {
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadAllSessions').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadAllTopics').mockResolvedValue();

		const fakeConn = {
			state: 'connected', rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(), __onAlive: null, disconnectedAt: 0, lastAliveAt: 0,
		};
		mockManager.get.mockReturnValue(fakeConn);
		listBots.mockResolvedValue([{ id: '1', name: 'A', online: true }]);

		await store.loadBots();

		await vi.waitFor(() => {
			expect(mockInitRtc).toHaveBeenCalledWith('1', fakeConn, expect.objectContaining({
				onRtcStateChange: expect.any(Function),
			}));
		});
	});

	test('__fullInit: bot offline 时不调用 initRtc', async () => {
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadAllSessions').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadAllTopics').mockResolvedValue();

		const fakeConn = {
			state: 'connected', rtc: null,			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(), __onAlive: null, disconnectedAt: 0, lastAliveAt: 0,
		};
		mockManager.get.mockReturnValue(fakeConn);
		listBots.mockResolvedValue([{ id: '1', name: 'A', online: false }]);

		await store.loadBots();
		// 等一个 tick 确保异步不会触发
		await new Promise((r) => setTimeout(r, 50));
		expect(mockInitRtc).not.toHaveBeenCalled();
	});

	test('WS 重连 + bot 在线 → __ensureRtc 触发 build', async () => {
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadAllSessions').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadAllTopics').mockResolvedValue();

		let stateCallback;
		const fakeConn = {
			state: 'connecting', rtc: null, on: vi.fn((event, cb) => { if (event === 'state') stateCallback = cb; }),
			off: vi.fn(), clearRtc: vi.fn(), __onAlive: null, disconnectedAt: 0, lastAliveAt: 0,
		};
		mockManager.get.mockReturnValue(fakeConn);
		listBots.mockResolvedValue([{ id: '2', name: 'B', online: true }]);

		await store.loadBots();
		expect(mockInitRtc).not.toHaveBeenCalled();

		// 首次 connected → __fullInit → __ensureRtc
		fakeConn.state = 'connected';
		stateCallback('connected');
		await vi.waitFor(() => {
			expect(mockInitRtc).toHaveBeenCalled();
		});
		mockInitRtc.mockClear();

		// 模拟断连 → 重连（已 initialized）→ 单次 initRtc（非 __ensureRtc）
		fakeConn.state = 'disconnected';
		stateCallback('disconnected');
		fakeConn.state = 'connected';
		stateCallback('connected');
		await vi.waitFor(() => {
			expect(mockInitRtc).toHaveBeenCalledWith('2', fakeConn, expect.objectContaining({
				onRtcStateChange: expect.any(Function),
			}));
		});
	});

	test('removeBotById 调用 closeRtcForBot', () => {
		const store = useBotsStore();
		store.setBots([{ id: '5', name: 'Bot' }]);
		store.removeBotById('5');

		expect(mockCloseRtcForBot).toHaveBeenCalledWith('5');
	});

	test('byId 初始包含 connState、rtcState 等字段', () => {
		const store = useBotsStore();
		store.setBots([{ id: '1', name: 'Bot' }]);
		const bot = store.byId['1'];
		expect(bot.connState).toBe('disconnected');
		expect(bot.rtcState).toBeNull();
		expect(bot.rtcTransportInfo).toBeNull();
		expect(bot.pluginVersionOk).toBeNull();
		expect(bot.pluginInfo).toBeNull();
	});

	test('bot offline→online → __ensureRtc 触发 close + build', async () => {
		const store = useBotsStore();
		const fakeConn = {
			state: 'connected', rtc: null,			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(), __onAlive: null, disconnectedAt: 0, lastAliveAt: 0,
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setBots([{ id: '50', name: 'Bot', online: false }]);
		store.byId['50'].connState = 'connected';
		store.byId['50'].initialized = true;
		mockInitRtc.mockClear();
		mockCloseRtcForBot.mockClear();

		store.updateBotOnline('50', true);
		await vi.waitFor(() => {
			expect(mockCloseRtcForBot).toHaveBeenCalledWith('50');
			expect(mockInitRtc).toHaveBeenCalledWith('50', fakeConn, expect.objectContaining({
				onRtcStateChange: expect.any(Function),
			}));
		});
	});

	test('bot offline→online + RTC 已 connected → __ensureRtc 直接返回，不做任何操作', async () => {
		const store = useBotsStore();
		const fakeRtc = { state: 'connected', attemptIceRestart: vi.fn() };
		const fakeConn = {
			state: 'connected', rtc: fakeRtc,			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(), __onAlive: null, disconnectedAt: 0, lastAliveAt: 0,
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setBots([{ id: '55', name: 'Bot', online: false }]);
		store.byId['55'].connState = 'connected';
		store.byId['55'].initialized = true;
		mockInitRtc.mockClear();
		mockCloseRtcForBot.mockClear();

		store.updateBotOnline('55', true);
		await new Promise((r) => setTimeout(r, 50));
		// RTC 已 connected → 无需 ICE restart、无需 rebuild
		expect(fakeRtc.attemptIceRestart).not.toHaveBeenCalled();
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
		expect(mockInitRtc).not.toHaveBeenCalled();
	});

	test('bot offline→online + 已有 RTC → ICE restart 优先', async () => {
		const store = useBotsStore();
		const fakeRtc = { state: 'disconnected', attemptIceRestart: vi.fn().mockResolvedValue(true) };
		const fakeConn = {
			state: 'connected', rtc: fakeRtc,			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(), __onAlive: null, disconnectedAt: 0, lastAliveAt: 0,
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setBots([{ id: '60', name: 'Bot', online: false }]);
		store.byId['60'].connState = 'connected';
		store.byId['60'].initialized = true;
		mockInitRtc.mockClear();
		mockCloseRtcForBot.mockClear();

		store.updateBotOnline('60', true);
		await vi.waitFor(() => {
			expect(fakeRtc.attemptIceRestart).toHaveBeenCalledWith(5000);
		});
		// ICE restart 成功 → 不调 closeRtcForBot 和 initRtc
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
		expect(mockInitRtc).not.toHaveBeenCalled();
	});

	test('bot offline→online + ICE restart 失败 → close + build', async () => {
		const store = useBotsStore();
		const fakeRtc = { state: 'disconnected', attemptIceRestart: vi.fn().mockResolvedValue(false) };
		const fakeConn = {
			state: 'connected', rtc: fakeRtc,			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(), __onAlive: null, disconnectedAt: 0, lastAliveAt: 0,
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setBots([{ id: '61', name: 'Bot', online: false }]);
		store.byId['61'].connState = 'connected';
		store.byId['61'].initialized = true;
		mockInitRtc.mockClear();
		mockCloseRtcForBot.mockClear();

		store.updateBotOnline('61', true);
		await vi.waitFor(() => {
			expect(mockCloseRtcForBot).toHaveBeenCalledWith('61');
			expect(mockInitRtc).toHaveBeenCalled();
		});
	});

	test('__ensureRtc 并发防护：同时触发只执行一次', async () => {
		const store = useBotsStore();
		let resolveInit;
		mockInitRtc.mockImplementation(() => new Promise((r) => { resolveInit = r; }));

		const fakeConn = {
			state: 'connected', rtc: null,			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(), __onAlive: null, disconnectedAt: 0, lastAliveAt: 0,
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setBots([{ id: '70', name: 'Bot', online: false }]);
		store.byId['70'].connState = 'connected';
		store.byId['70'].initialized = true;
		mockInitRtc.mockClear();
		mockCloseRtcForBot.mockClear();

		// 同时触发两次
		store.updateBotOnline('70', true);
		store.byId['70'].online = false;
		store.updateBotOnline('70', true);

		await new Promise((r) => setTimeout(r, 50));
		// 只应发起一次 initRtc（第二次被 _rtcInitInProgress 阻挡）
		expect(mockInitRtc).toHaveBeenCalledTimes(1);
		resolveInit('rtc');
	});

	test('__ensureRtc build 重试：首次超时后重试成功', async () => {
		const store = useBotsStore();
		let callCount = 0;
		mockInitRtc.mockImplementation(() => {
			callCount++;
			return Promise.resolve(callCount >= 2 ? 'rtc' : 'ws');
		});

		const fakeConn = {
			state: 'connected', rtc: null,			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(), __onAlive: null, disconnectedAt: 0, lastAliveAt: 0,
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setBots([{ id: '80', name: 'Bot', online: false }]);
		store.byId['80'].connState = 'connected';
		store.byId['80'].initialized = true;

		store.updateBotOnline('80', true);
		await vi.waitFor(() => {
			expect(callCount).toBe(2); // 第 1 次 ws，第 2 次 rtc
		});
	});
});

describe('重连后批量状态刷新', () => {
	test('断连时长 >= BRIEF_DISCONNECT_MS 时刷新 agents/sessions/topics/dashboard（不刷新 bots）', async () => {
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		const dashboardStore = useDashboardStore();
		vi.spyOn(store, 'loadBots').mockResolvedValue();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadAllSessions').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadAllTopics').mockResolvedValue();
		vi.spyOn(dashboardStore, 'loadDashboard').mockResolvedValue();

		let stateCallback;
		const fakeConn = {
			state: 'connecting',
			disconnectedAt: Date.now() - 10_000,
			on: vi.fn((event, cb) => { if (event === 'state') stateCallback = cb; }),
			off: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
			__onAlive: null,
			lastAliveAt: 0,
			rtc: null, clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateBot({ id: '20', name: 'Bot', online: true });
		// 首次 connected：全量初始化
		fakeConn.state = 'connected';
		stateCallback('connected');
		await vi.waitFor(() => {
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('20');
		});

		store.loadBots.mockClear();
		agentsStore.loadAgents.mockClear();
		sessionsStore.loadAllSessions.mockClear();
		topicsStore.loadAllTopics.mockClear();
		dashboardStore.loadDashboard.mockClear();

		// 模拟断连
		fakeConn.state = 'disconnected';
		stateCallback('disconnected');


		// 模拟断连 10s 后重连
		fakeConn.disconnectedAt = Date.now() - 10_000;
		fakeConn.state = 'connected';
		stateCallback('connected');


		await vi.waitFor(() => {
			// bot 列表由 SSE 快照维护，WS 重连不再调用 loadBots
			expect(store.loadBots).not.toHaveBeenCalled();
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('20');
			expect(sessionsStore.loadAllSessions).toHaveBeenCalled();
			expect(topicsStore.loadAllTopics).toHaveBeenCalled();
			expect(dashboardStore.loadDashboard).toHaveBeenCalledWith('20');
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
			rtc: null, clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateBot({ id: '21', name: 'Bot', online: true });
		fakeConn.state = 'connected';
		stateCallback('connected');
		await vi.waitFor(() => {
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('21');
		});

		agentsStore.loadAgents.mockClear();
		sessionsStore.loadAllSessions.mockClear();
		topicsStore.loadAllTopics.mockClear();

		// 模拟断连
		fakeConn.state = 'disconnected';
		stateCallback('disconnected');


		// 模拟短暂抖动（2s）
		fakeConn.disconnectedAt = Date.now() - 2000;
		fakeConn.state = 'connected';
		stateCallback('connected');

		await Promise.resolve();

		expect(agentsStore.loadAgents).not.toHaveBeenCalled();
		expect(sessionsStore.loadAllSessions).not.toHaveBeenCalled();
		expect(topicsStore.loadAllTopics).not.toHaveBeenCalled();
	});
});

describe('__fullInit 失败重试', () => {
	test('fullInit 失败后 initialized 重置为 false，下次重连可重试', async () => {
		const { checkPluginVersion } = await import('../utils/plugin-version.js');
		checkPluginVersion.mockRejectedValue(new Error('version check failed'));
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();

		let stateCallback;
		const fakeConn = {
			state: 'connecting',
			disconnectedAt: 0,
			on: vi.fn((event, cb) => { if (event === 'state') stateCallback = cb; }),
			off: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
			__onAlive: null,
			lastAliveAt: 0,
			rtc: null, clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateBot({ id: '30', name: 'Bot', online: true });
		fakeConn.state = 'connected';
		stateCallback('connected');

		// 等 fullInit 失败
		await vi.waitFor(() => {
			expect(store.byId['30'].initialized).toBe(false);
		});

		// 修复 checkPluginVersion，模拟重连
		checkPluginVersion.mockResolvedValue({ ok: true, version: '0.6.0', clawVersion: '2026.3.14' });
		fakeConn.state = 'disconnected';
		stateCallback('disconnected');
		fakeConn.state = 'connected';
		stateCallback('connected');

		await vi.waitFor(() => {
			expect(store.byId['30'].initialized).toBe(true);
			expect(store.byId['30'].pluginVersionOk).toBe(true);
		});
	});

	test('bot 离线时 fullInit 因 pluginVersion 不可达而失败，bot 上线后通过 updateBotOnline 重试', async () => {
		const { checkPluginVersion } = await import('../utils/plugin-version.js');
		// 首次 __fullInit 因 bot 离线直接抛出 "Bot is offline"，不会到达 checkPluginVersion
		// 重试：bot 上线后 checkPluginVersion 成功
		checkPluginVersion.mockResolvedValue({ ok: true, version: '0.6.0', clawVersion: '2026.3.14' });

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
			rtc: null, clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		// 首次绑定：bot 离线
		store.addOrUpdateBot({ id: '32', name: 'Bot', online: false });
		fakeConn.state = 'connected';
		stateCallback('connected');

		// fullInit 应因 "Bot is offline" 而失败 → initialized 重置
		await vi.waitFor(() => {
			expect(store.byId['32'].initialized).toBe(false);
		});

		// SSE 推送 bot 上线 → updateBotOnline(true) → !initialized 分支 → __onBotConnected → fullInit 重试
		store.updateBotOnline('32', true);
		await vi.waitFor(() => {
			expect(store.byId['32'].initialized).toBe(true);
			expect(store.byId['32'].pluginVersionOk).toBe(true);
		});
	});

	test('fullInit 失败不覆盖后续成功的重连（generation guard）', async () => {
		const { checkPluginVersion } = await import('../utils/plugin-version.js');
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(useSessionsStore(), 'loadAllSessions').mockResolvedValue();
		vi.spyOn(useTopicsStore(), 'loadAllTopics').mockResolvedValue();

		// 第一次 fullInit 用一个永远 pending 的 promise，稍后手动 reject
		let rejectFirst;
		checkPluginVersion.mockReturnValueOnce(new Promise((_, rej) => { rejectFirst = rej; }));
		// 第二次 fullInit 正常成功
		checkPluginVersion.mockResolvedValue({ ok: true, version: '0.6.0', clawVersion: '2026.3.14' });
		vi.spyOn(store, 'loadBots').mockResolvedValue();

		let stateCallback;
		const fakeConn = {
			state: 'connecting',
			disconnectedAt: Date.now() - 10_000,
			on: vi.fn((event, cb) => { if (event === 'state') stateCallback = cb; }),
			off: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
			__onAlive: null,
			lastAliveAt: 0,
			rtc: null, clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateBot({ id: '31', name: 'Bot', online: true });

		// 首次连接，触发 fullInit（pending）
		fakeConn.state = 'connected';
		stateCallback('connected');
		await Promise.resolve();
		expect(store.byId['31'].initialized).toBe(true);

		// 模拟快速断连重连，触发第二次 __onBotConnected（走 reconnect 分支，因为 initialized=true）
		fakeConn.state = 'disconnected';
		stateCallback('disconnected');
		fakeConn.state = 'connected';
		stateCallback('connected');
		await Promise.resolve();

		// 此时第一次 fullInit 迟到地失败
		rejectFirst(new Error('late failure'));
		await Promise.resolve();
		await Promise.resolve();

		// generation guard 应保护 initialized 不被迟到的失败覆盖
		expect(store.byId['31'].initialized).toBe(true);
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
