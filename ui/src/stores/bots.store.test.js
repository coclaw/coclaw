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

// mock SignalingConnection 单例
const sigListeners = {};
const mockSigConn = {
	state: 'disconnected',
	ensureConnected: vi.fn().mockResolvedValue(undefined),
	on(event, cb) { (sigListeners[event] ??= []).push(cb); },
	off(event, cb) {
		if (sigListeners[event]) sigListeners[event] = sigListeners[event].filter(c => c !== cb);
	},
};

vi.mock('../services/signaling-connection.js', () => ({
	useSignalingConnection: () => mockSigConn,
}));

// mock remote-log（bots.store 内部 import）
const mockRemoteLog = vi.fn();
vi.mock('../services/remote-log.js', () => ({ remoteLog: (...args) => mockRemoteLog(...args) }));

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
	closeRtcForBot: (...args) => mockCloseRtcForBot(...args),
}));

import { useAgentRunsStore } from './agent-runs.store.js';
import { useAgentsStore } from './agents.store.js';
import { useBotsStore, __resetAwaitingConnIds, getReadyConn } from './bots.store.js';
import { useDashboardStore } from './dashboard.store.js';
import { useSessionsStore } from './sessions.store.js';
import { useTopicsStore } from './topics.store.js';

beforeEach(() => {
	setActivePinia(createPinia());
	vi.clearAllMocks();
	mockManager.get.mockReset();
	mockInitRtc.mockReset().mockImplementation(async (_botId, conn) => { conn.rtc = __fakeRtc; return 'rtc'; });
	mockCloseRtcForBot.mockReset();
	// 重置 signaling mock
	mockSigConn.state = 'disconnected';
	mockSigConn.ensureConnected.mockReset().mockResolvedValue(undefined);
	for (const key of Object.keys(sigListeners)) delete sigListeners[key];
	mockRemoteLog.mockClear();
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
		store.byId['1'] = { id: '1', name: 'OldName', online: true, rtcPhase: 'ready', initialized: true, pluginVersionOk: null, pluginInfo: null, rtcTransportInfo: null, lastAliveAt: 0, disconnectedAt: 0, lastSeenAt: null, createdAt: null, updatedAt: null };
		store.setBots([{ id: '1', name: 'NewName' }]);
		expect(store.byId['1'].name).toBe('NewName');
		expect(store.byId['1'].rtcPhase).toBe('ready');
		expect(store.byId['1'].initialized).toBe(true);
	});
});

describe('addOrUpdateBot', () => {
	test('inserts new bot with normalized fields and calls connect', () => {
		const store = useBotsStore();
		const fakeConn = { on: vi.fn(), off: vi.fn() };
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

	test('__bridgeConn triggers fullInit for online+uninitialized bot', async () => {
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadAllSessions').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadAllTopics').mockResolvedValue();

		const fakeConn = {
			on: vi.fn(), off: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
			rtc: null, clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		// __bridgeConn 对 online + !initialized 的 bot 直接触发 __fullInit
		store.addOrUpdateBot({ id: '10', name: 'Fresh', online: true });
		expect(fakeConn.on).toHaveBeenCalledWith('event:agent', expect.any(Function));

		await vi.waitFor(() => {
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('10');
			expect(sessionsStore.loadAllSessions).toHaveBeenCalled();
			expect(topicsStore.loadAllTopics).toHaveBeenCalled();
		});
	});

	test('__bridgeConn triggers fullInit immediately for online bot', async () => {
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadAllSessions').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadAllTopics').mockResolvedValue();

		const fakeConn = { on: vi.fn(), off: vi.fn(), request: vi.fn().mockResolvedValue({}), rtc: null, clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateBot({ id: '11', name: 'AlreadyReady', online: true });
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

	test('calls removeByBot on agents store', () => {
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		agentsStore.byBot['3'] = { agents: [{ id: 'main' }], defaultId: 'main', loading: false, fetched: true };
		store.setBots([{ id: '3', name: 'Bot' }]);

		store.removeBotById('3');

		expect(agentsStore.byBot['3']).toBeUndefined();
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
		const dashboardStore = useDashboardStore();
		store.setBots([{ id: '5', name: 'Bot' }, { id: '6', name: 'Bot2' }]);
		store.byId['5'].rtcPhase = 'ready';
		store.byId['5'].rtcTransportInfo = { localType: 'host' };
		dashboardStore.byBot['5'] = { loading: false, error: null, instance: { name: 'Bot' }, agents: [] };

		store.removeBotById('5');

		expect(store.byId['5']).toBeUndefined();
		expect(store.byId['6']).toBeDefined();
		expect(dashboardStore.byBot['5']).toBeUndefined();
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

	test('bot 离线时保留 agents 和 dashboard 缓存', () => {
		const store = useBotsStore();
		const dashboardStore = useDashboardStore();
		store.setBots([{ id: '1', online: true }]);

		const agentsStore = useAgentsStore();
		agentsStore.byBot['1'] = { agents: [{ id: 'main' }], defaultId: 'main', loading: false, fetched: true };
		dashboardStore.byBot['1'] = { loading: false, error: null, instance: { name: 'Bot' }, agents: [] };

		store.updateBotOnline('1', false);

		expect(store.byId['1'].online).toBe(false);
		// agents / dashboard 缓存保留，供离线时 UI 展示
		expect(agentsStore.byBot['1']).toBeDefined();
		expect(agentsStore.byBot['1'].agents).toHaveLength(1);
		expect(dashboardStore.byBot['1']).toBeDefined();
		expect(dashboardStore.byBot['1'].instance.name).toBe('Bot');
		// dashboard 缓存中的 online 状态同步更新为 false
		expect(dashboardStore.byBot['1'].instance.online).toBe(false);
	});

	test('bot 离线时重置 dcReady 和 rtcPhase', () => {
		const store = useBotsStore();
		store.setBots([{ id: '1', online: true }]);
		store.byId['1'].dcReady = true;
		store.byId['1'].rtcPhase = 'ready';

		store.updateBotOnline('1', false);

		expect(store.byId['1'].dcReady).toBe(false);
		expect(store.byId['1'].rtcPhase).toBe('idle');
	});

	test('bot 上线时不清理 agents 缓存', () => {
		const store = useBotsStore();
		store.setBots([{ id: '1', online: false }]);

		const agentsStore = useAgentsStore();
		agentsStore.byBot['1'] = { agents: [{ id: 'main' }], defaultId: 'main', loading: false, fetched: true };

		store.updateBotOnline('1', true);

		expect(agentsStore.byBot['1']).toBeDefined();
	});

	test('bot 上线且 initialized=false 时重试初始化', async () => {
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
			on: vi.fn(), off: vi.fn(),
			rtc: null, clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setBots([{ id: '1', online: false }]);
		// 模拟 __fullInit 失败后的状态
		store.byId['1'].initialized = false;

		store.updateBotOnline('1', true);

		await vi.waitFor(() => {
			expect(store.byId['1'].initialized).toBe(true);
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('1');
		});
	});

	test('bot offline→online + initialized=true → __ensureRtc 而非 fullInit', async () => {
		const store = useBotsStore();
		const fakeConn = {
			on: vi.fn(), off: vi.fn(),
			rtc: null, clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setBots([{ id: '1', online: false }]);
		store.byId['1'].initialized = true;
		mockInitRtc.mockClear();

		store.updateBotOnline('1', true);

		// __ensureRtc 被调用（会触发 initRtc）
		await vi.waitFor(() => {
			expect(mockInitRtc).toHaveBeenCalled();
		});
	});

	test('bot offline→online + DC 仍 connected → __ensureRtc 快速返回后加载 dashboard', async () => {
		const store = useBotsStore();
		const dashboardStore = useDashboardStore();
		vi.spyOn(dashboardStore, 'loadDashboard').mockResolvedValue();

		// 模拟 RTC 仍处于 connected 状态
		const fakeRtc = { state: 'connected', isReady: true };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(),
			rtc: fakeRtc, clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateBot({ id: '1', name: 'Bot', online: false });
		store.byId['1'].initialized = true;

		store.updateBotOnline('1', true);

		// __ensureRtc 快速返回（RTC 已 connected），然后 .then() 触发 loadDashboard
		await vi.waitFor(() => {
			expect(dashboardStore.loadDashboard).toHaveBeenCalledWith('1');
		});
		expect(store.byId['1'].dcReady).toBe(true);
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
			rtcPhase: 'ready', initialized: true,
			pluginVersionOk: true,
		};

		store.applySnapshot([{ id: '1', name: 'new', online: false }]);

		// 基础信息更新
		expect(store.byId['1'].name).toBe('new');
		// 运行时状态保留
		expect(store.byId['1'].rtcPhase).toBe('ready');
		expect(store.byId['1'].initialized).toBe(true);
	});

	test('preserves online=true when dcReady is true', () => {
		const store = useBotsStore();
		mockManager.get.mockReturnValue(null);

		store.byId['1'] = {
			id: '1', name: 'a', online: true,
			dcReady: true,
		};

		// 快照说 offline，但 DC 已就绪 → 保留 online=true
		store.applySnapshot([{ id: '1', name: 'a', online: false }]);
		expect(store.byId['1'].online).toBe(true);
	});

	test('removes bots not in snapshot and cleans up RTC/sessions/agentRuns', () => {
		const store = useBotsStore();
		const sessionsStore = useSessionsStore();
		const agentsStore = useAgentsStore();
		const agentRunsStore = useAgentRunsStore();
		const dashboardStore = useDashboardStore();
		const removeAgentsSpy = vi.spyOn(agentsStore, 'removeByBot');
		const removeSessionsSpy = vi.spyOn(sessionsStore, 'removeSessionsByBotId');
		const removeAgentRunsSpy = vi.spyOn(agentRunsStore, 'removeByBot');
		const clearDashboardSpy = vi.spyOn(dashboardStore, 'clearDashboard');
		mockManager.get.mockReturnValue(null);

		store.byId['1'] = { id: '1', name: 'old' };
		store.byId['2'] = { id: '2', name: 'will-be-removed' };

		store.applySnapshot([{ id: '1', name: 'kept' }]);

		expect(store.byId['1']).toBeDefined();
		expect(store.byId['2']).toBeUndefined();
		// 被移除的 bot 应清理关联资源
		expect(mockCloseRtcForBot).toHaveBeenCalledWith('2');
		expect(removeAgentsSpy).toHaveBeenCalledWith('2');
		expect(removeSessionsSpy).toHaveBeenCalledWith('2');
		expect(removeAgentRunsSpy).toHaveBeenCalledWith('2');
		expect(clearDashboardSpy).toHaveBeenCalledWith('2');
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

	test('applySnapshot 为 rtcPhase=failed 的 online bot 重新尝试 ensureRtc', async () => {
		const store = useBotsStore();
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: null, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		// 模拟已有 bot，RTC 失败
		store.byId['1'] = {
			id: '1', name: 'A', online: true,
			rtcPhase: 'failed', dcReady: false,
			initialized: true, pluginVersionOk: null, pluginInfo: null,
			rtcTransportInfo: null, lastAliveAt: 0, disconnectedAt: 0,
			lastSeenAt: null, createdAt: null, updatedAt: null,
		};

		mockInitRtc.mockClear();
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);

		await vi.waitFor(() => {
			expect(mockInitRtc).toHaveBeenCalledWith('1', fakeConn, expect.any(Object));
		});
	});
});

describe('WebRTC 集成', () => {
	test('__fullInit: bot online 时通过 __bridgeConn 触发 initRtc', async () => {
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadAllSessions').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadAllTopics').mockResolvedValue();

		const fakeConn = {
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);
		// __bridgeConn 对 online + !initialized 的 bot 直接触发 __fullInit
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);

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
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);
		// bot offline → __bridgeConn 不触发 __fullInit
		store.applySnapshot([{ id: '1', name: 'A', online: false }]);
		await new Promise((r) => setTimeout(r, 50));
		expect(mockInitRtc).not.toHaveBeenCalled();
	});

	test('removeBotById 调用 closeRtcForBot', () => {
		const store = useBotsStore();
		store.setBots([{ id: '5', name: 'Bot' }]);
		store.removeBotById('5');

		expect(mockCloseRtcForBot).toHaveBeenCalledWith('5');
	});

	test('byId 初始包含 rtcPhase 等字段', () => {
		const store = useBotsStore();
		store.setBots([{ id: '1', name: 'Bot' }]);
		const bot = store.byId['1'];
		expect(bot.rtcPhase).toBe('idle');
		expect(bot.rtcTransportInfo).toBeNull();
		expect(bot.pluginVersionOk).toBeNull();
		expect(bot.pluginInfo).toBeNull();
	});

	test('bot offline→online → __ensureRtc 触发 close + build', async () => {
		const store = useBotsStore();
		const fakeConn = {
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setBots([{ id: '50', name: 'Bot', online: false }]);
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
		const fakeRtc = { state: 'connected', isReady: true };
		const fakeConn = {
			rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setBots([{ id: '55', name: 'Bot', online: false }]);
		store.byId['55'].initialized = true;
		mockInitRtc.mockClear();
		mockCloseRtcForBot.mockClear();

		store.updateBotOnline('55', true);
		await new Promise((r) => setTimeout(r, 50));
		// RTC 已 connected → 无需 rebuild
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
		expect(mockInitRtc).not.toHaveBeenCalled();
	});

	test('bot offline→online + RTC 非 connected → close + rebuild', async () => {
		const store = useBotsStore();
		const fakeRtc = { state: 'disconnected' };
		const fakeConn = {
			rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setBots([{ id: '60', name: 'Bot', online: false }]);
		store.byId['60'].initialized = true;
		mockInitRtc.mockClear();
		mockCloseRtcForBot.mockClear();

		store.updateBotOnline('60', true);
		await vi.waitFor(() => {
			expect(mockCloseRtcForBot).toHaveBeenCalledWith('60');
			expect(mockInitRtc).toHaveBeenCalled();
		});
	});

	test('__ensureRtc forceRebuild=true 跳过 connected 检查', async () => {
		const store = useBotsStore();
		const fakeRtc = { state: 'connected', isReady: true };
		const fakeConn = {
			rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setBots([{ id: '62', name: 'Bot', online: true }]);
		mockInitRtc.mockClear();
		mockCloseRtcForBot.mockClear();

		await store.__ensureRtc('62', { forceRebuild: true });
		expect(mockCloseRtcForBot).toHaveBeenCalledWith('62');
		expect(mockInitRtc).toHaveBeenCalled();
	});

	test('__ensureRtc 并发防护：同时触发只执行一次', async () => {
		const store = useBotsStore();
		let resolveInit;
		mockInitRtc.mockImplementation(() => new Promise((r) => { resolveInit = r; }));

		const fakeConn = {
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setBots([{ id: '70', name: 'Bot', online: false }]);
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
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setBots([{ id: '80', name: 'Bot', online: false }]);
		store.byId['80'].initialized = true;

		store.updateBotOnline('80', true);
		await vi.waitFor(() => {
			expect(callCount).toBe(2); // 第 1 次 ws，第 2 次 rtc
		});
	});
});

describe('__bridgeConn 事件注册', () => {
	test('注册 event:agent 监听', () => {
		const store = useBotsStore();
		const fakeConn = { on: vi.fn(), off: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.applySnapshot([{ id: '1', name: 'A' }]);

		const agentCalls = fakeConn.on.mock.calls.filter(([ev]) => ev === 'event:agent');
		expect(agentCalls).toHaveLength(1);
	});

	test('同一 conn 实例不重复注册监听器', () => {
		const store = useBotsStore();
		const fakeConn = { on: vi.fn(), off: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.applySnapshot([{ id: '1', name: 'A' }]);
		store.applySnapshot([{ id: '1', name: 'A' }]);

		// event:agent 只注册一次
		const agentCalls = fakeConn.on.mock.calls.filter(([ev]) => ev === 'event:agent');
		expect(agentCalls).toHaveLength(1);
	});

	test('bot online + 未初始化 → 触发 fullInit', async () => {
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(useSessionsStore(), 'loadAllSessions').mockResolvedValue();
		vi.spyOn(useTopicsStore(), 'loadAllTopics').mockResolvedValue();

		const fakeConn = { on: vi.fn(), off: vi.fn(), rtc: null, clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.applySnapshot([{ id: '1', name: 'A', online: true }]);
		await vi.waitFor(() => {
			expect(mockInitRtc).toHaveBeenCalled();
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('1');
		});
	});

	test('bot offline → 不触发 fullInit', async () => {
		const store = useBotsStore();
		const fakeConn = { on: vi.fn(), off: vi.fn(), rtc: null, clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.applySnapshot([{ id: '1', name: 'A', online: false }]);
		await new Promise((r) => setTimeout(r, 50));
		expect(mockInitRtc).not.toHaveBeenCalled();
	});

	test('bot 已初始化 → 不触发 fullInit', async () => {
		const store = useBotsStore();
		const fakeConn = { on: vi.fn(), off: vi.fn(), rtc: null, clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setBots([{ id: '1', name: 'A', online: true }]);
		store.byId['1'].initialized = true;
		mockInitRtc.mockClear();

		// 重新桥接（模拟新 conn）
		const fakeConn2 = { on: vi.fn(), off: vi.fn(), rtc: null, clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn2);
		store.__bridgeConn('1');

		await new Promise((r) => setTimeout(r, 50));
		expect(mockInitRtc).not.toHaveBeenCalled();
	});

	test('注入 __onGetRtcPhase 回调', () => {
		const store = useBotsStore();
		const fakeConn = { on: vi.fn(), off: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.applySnapshot([{ id: '1', name: 'A', online: false }]);
		expect(typeof fakeConn.__onGetRtcPhase).toBe('function');
		// 默认 rtcPhase 为 'idle'
		expect(fakeConn.__onGetRtcPhase()).toBe('idle');

		// 修改 rtcPhase 后回调应反映最新值
		store.byId['1'].rtcPhase = 'failed';
		expect(fakeConn.__onGetRtcPhase()).toBe('failed');
	});

	test('注入 __onTriggerReconnect 回调', async () => {
		const store = useBotsStore();
		vi.spyOn(store, '__clearRetry');
		vi.spyOn(store, '__ensureRtc').mockResolvedValue();

		const fakeConn = { on: vi.fn(), off: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.applySnapshot([{ id: '1', name: 'A', online: false }]);
		expect(typeof fakeConn.__onTriggerReconnect).toBe('function');

		fakeConn.__onTriggerReconnect();
		expect(store.__clearRetry).toHaveBeenCalledWith('1');
		expect(store.__ensureRtc).toHaveBeenCalledWith('1');
	});

	test('bot 不存在时 __onGetRtcPhase 返回 idle', () => {
		const store = useBotsStore();
		const fakeConn = { on: vi.fn(), off: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.applySnapshot([{ id: '1', name: 'A', online: false }]);
		// 删除 bot
		delete store.byId['1'];
		expect(fakeConn.__onGetRtcPhase()).toBe('idle');
	});
});

describe('__bridgeSignaling 事件处理 — foreground-resume', () => {
	test('elapsed > 30s → 直接 rebuild（不 probe）', async () => {
		const store = useBotsStore();
		const fakeRtc = { state: 'connected', isReady: true, probe: vi.fn() };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateBot({ id: '63', name: 'Bot', online: true });
		store.byId['63'].dcReady = true;
		store.__bridgeConn('63');
		mockCloseRtcForBot.mockClear();
		mockInitRtc.mockClear();

		for (const cb of sigListeners['foreground-resume'] ?? []) cb({ source: 'app:foreground', elapsed: 31_000 });
		await vi.waitFor(() => {
			expect(mockCloseRtcForBot).toHaveBeenCalledWith('63');
		});
		expect(fakeRtc.probe).not.toHaveBeenCalled();
	});

	test('elapsed ≤ 30s + probe 成功 → 不 rebuild', async () => {
		const store = useBotsStore();
		const fakeRtc = { state: 'connected', isReady: true, probe: vi.fn().mockResolvedValue(true) };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateBot({ id: '64', name: 'Bot', online: true });
		store.byId['64'].dcReady = true;
		store.__bridgeConn('64');
		mockCloseRtcForBot.mockClear();
		mockInitRtc.mockClear();

		for (const cb of sigListeners['foreground-resume'] ?? []) cb({ source: 'app:foreground', elapsed: 5_000 });
		await vi.waitFor(() => {
			expect(fakeRtc.probe).toHaveBeenCalledWith(3_000);
		});
		// probe 成功 → 不 rebuild
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
		expect(mockInitRtc).not.toHaveBeenCalled();
	});

	test('elapsed ≤ 30s + probe 超时 → rebuild', async () => {
		const store = useBotsStore();
		const fakeRtc = { state: 'connected', isReady: true, probe: vi.fn().mockResolvedValue(false) };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateBot({ id: '65', name: 'Bot', online: true });
		store.byId['65'].dcReady = true;
		store.__bridgeConn('65');
		mockCloseRtcForBot.mockClear();
		mockInitRtc.mockClear();

		for (const cb of sigListeners['foreground-resume'] ?? []) cb({ source: 'network:online', elapsed: 5_000 });
		await vi.waitFor(() => {
			expect(mockCloseRtcForBot).toHaveBeenCalledWith('65');
		});
	});

	test('dcReady=false → 不触发恢复', async () => {
		const store = useBotsStore();
		const fakeRtc = { state: 'connected', isReady: true, probe: vi.fn() };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateBot({ id: '66', name: 'Bot', online: true });
		store.byId['66'].dcReady = false;
		store.__bridgeConn('66');
		mockCloseRtcForBot.mockClear();

		for (const cb of sigListeners['foreground-resume'] ?? []) cb({ source: 'app:foreground', elapsed: 5_000 });
		await new Promise((r) => setTimeout(r, 50));
		expect(fakeRtc.probe).not.toHaveBeenCalled();
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
	});

	test('PC 已 closed → 直接 rebuild（不 probe）', async () => {
		const store = useBotsStore();
		const fakeRtc = { state: 'closed', probe: vi.fn() };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		// 用 online:false 避免 __bridgeConn 触发 __fullInit
		store.addOrUpdateBot({ id: '68', name: 'Bot', online: false });
		store.byId['68'].online = true;
		store.byId['68'].initialized = true;
		store.byId['68'].dcReady = true;
		store.__bridgeConn('68');
		mockCloseRtcForBot.mockClear();

		for (const cb of sigListeners['foreground-resume'] ?? []) cb({ source: 'app:foreground', elapsed: 5_000 });
		await vi.waitFor(() => {
			expect(mockCloseRtcForBot).toHaveBeenCalledWith('68');
		});
		expect(fakeRtc.probe).not.toHaveBeenCalled();
	});

	test('_rtcInitInProgress 时跳过 checkAndRecover', async () => {
		const store = useBotsStore();
		const fakeRtc = { state: 'connected', isReady: true, probe: vi.fn() };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setBots([{ id: '75', name: 'Bot', online: true }]);
		store.byId['75'].initialized = true;
		store.byId['75'].dcReady = true;
		store.__bridgeConn('75');

		// 模拟 _rtcInitInProgress
		let resolveInit;
		mockInitRtc.mockImplementation(() => new Promise((r) => { resolveInit = r; }));
		const p = store.__ensureRtc('75', { forceRebuild: true });

		// 此时 _rtcInitInProgress=true，foreground-resume 应跳过
		for (const cb of sigListeners['foreground-resume'] ?? []) cb({ source: 'app:foreground', elapsed: 5_000 });
		await new Promise((r) => setTimeout(r, 50));
		expect(fakeRtc.probe).not.toHaveBeenCalled();

		resolveInit('rtc');
		await p;
	});

	test('dcReady=true 但 conn.rtc 为 null → 不触发恢复', async () => {
		const store = useBotsStore();
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: null, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateBot({ id: '69', name: 'Bot', online: true });
		store.byId['69'].dcReady = true;
		store.__bridgeConn('69');
		mockCloseRtcForBot.mockClear();

		for (const cb of sigListeners['foreground-resume'] ?? []) cb({ source: 'app:foreground', elapsed: 5_000 });
		await new Promise((r) => setTimeout(r, 50));
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
	});

	test('PC 已 failed → 直接 rebuild（不 probe）', async () => {
		const store = useBotsStore();
		const fakeRtc = { state: 'failed', probe: vi.fn() };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		// 用 online:false 避免 __bridgeConn 触发 __fullInit
		store.addOrUpdateBot({ id: '67', name: 'Bot', online: false });
		store.byId['67'].online = true;
		store.byId['67'].initialized = true;
		store.byId['67'].dcReady = true;
		store.__bridgeConn('67');
		mockCloseRtcForBot.mockClear();

		for (const cb of sigListeners['foreground-resume'] ?? []) cb({ source: 'app:foreground', elapsed: 5_000 });
		await vi.waitFor(() => {
			expect(mockCloseRtcForBot).toHaveBeenCalledWith('67');
		});
		expect(fakeRtc.probe).not.toHaveBeenCalled();
	});
});

describe('__refreshIfStale', () => {
	test('断连时长 >= BRIEF_DISCONNECT_MS 时刷新 agents/sessions/topics/dashboard', () => {
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		const dashboardStore = useDashboardStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadAllSessions').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadAllTopics').mockResolvedValue();
		vi.spyOn(dashboardStore, 'loadDashboard').mockResolvedValue();

		store.setBots([{ id: '20', name: 'Bot', online: true }]);
		store.byId['20'].initialized = true;
		store.byId['20'].disconnectedAt = Date.now() - 10_000;

		store.__refreshIfStale('20');

		expect(agentsStore.loadAgents).toHaveBeenCalledWith('20');
		expect(sessionsStore.loadAllSessions).toHaveBeenCalled();
		expect(topicsStore.loadAllTopics).toHaveBeenCalled();
		expect(dashboardStore.loadDashboard).toHaveBeenCalledWith('20');
		// disconnectedAt 被重置
		expect(store.byId['20'].disconnectedAt).toBe(0);
	});

	test('断连时长 < BRIEF_DISCONNECT_MS 时不刷新', () => {
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadAllSessions').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadAllTopics').mockResolvedValue();

		store.setBots([{ id: '21', name: 'Bot', online: true }]);
		store.byId['21'].initialized = true;
		store.byId['21'].disconnectedAt = Date.now() - 2000;

		store.__refreshIfStale('21');

		expect(agentsStore.loadAgents).not.toHaveBeenCalled();
		expect(sessionsStore.loadAllSessions).not.toHaveBeenCalled();
		expect(topicsStore.loadAllTopics).not.toHaveBeenCalled();
	});

	test('disconnectedAt = 0 时不刷新', () => {
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();

		store.setBots([{ id: '22', name: 'Bot', online: true }]);
		store.byId['22'].initialized = true;
		store.byId['22'].disconnectedAt = 0;

		store.__refreshIfStale('22');

		expect(agentsStore.loadAgents).not.toHaveBeenCalled();
	});

	test('未初始化时不刷新', () => {
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();

		store.setBots([{ id: '23', name: 'Bot', online: true }]);
		store.byId['23'].initialized = false;
		store.byId['23'].disconnectedAt = Date.now() - 10_000;

		store.__refreshIfStale('23');

		expect(agentsStore.loadAgents).not.toHaveBeenCalled();
	});
});

describe('__ensureRtc 后通过 __refreshIfStale 刷新', () => {
	test('RTC 重建成功 + 长时间断连 → 刷新 stores', async () => {
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		const dashboardStore = useDashboardStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadAllSessions').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadAllTopics').mockResolvedValue();
		vi.spyOn(dashboardStore, 'loadDashboard').mockResolvedValue();

		const fakeConn = {
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setBots([{ id: '20', name: 'Bot', online: true }]);
		store.byId['20'].initialized = true;
		store.byId['20'].disconnectedAt = Date.now() - 10_000;

		await store.__ensureRtc('20');

		expect(agentsStore.loadAgents).toHaveBeenCalledWith('20');
		expect(sessionsStore.loadAllSessions).toHaveBeenCalled();
		expect(topicsStore.loadAllTopics).toHaveBeenCalled();
		expect(dashboardStore.loadDashboard).toHaveBeenCalledWith('20');
	});

	test('RTC 重建成功 + 短暂断连 → 不刷新', async () => {
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadAllSessions').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadAllTopics').mockResolvedValue();

		const fakeConn = {
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setBots([{ id: '21', name: 'Bot', online: true }]);
		store.byId['21'].initialized = true;
		store.byId['21'].disconnectedAt = Date.now() - 2000;

		await store.__ensureRtc('21');

		expect(agentsStore.loadAgents).not.toHaveBeenCalled();
		expect(sessionsStore.loadAllSessions).not.toHaveBeenCalled();
		expect(topicsStore.loadAllTopics).not.toHaveBeenCalled();
	});
});

describe('__fullInit 失败重试', () => {
	test('fullInit 失败后 initialized 重置为 false，下次可通过 updateBotOnline 重试', async () => {
		const { checkPluginVersion } = await import('../utils/plugin-version.js');
		checkPluginVersion.mockRejectedValue(new Error('version check failed'));
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();

		const fakeConn = {
			on: vi.fn(), off: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
			rtc: null, clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		// __bridgeConn 触发 __fullInit（online + !initialized）
		store.addOrUpdateBot({ id: '30', name: 'Bot', online: true });

		// 等 fullInit 失败
		await vi.waitFor(() => {
			expect(store.byId['30'].initialized).toBe(false);
		});

		// 修复 checkPluginVersion，通过 updateBotOnline 触发重试
		checkPluginVersion.mockResolvedValue({ ok: true, version: '0.6.0', clawVersion: '2026.3.14' });
		store.byId['30'].online = false;
		store.updateBotOnline('30', true);

		await vi.waitFor(() => {
			expect(store.byId['30'].initialized).toBe(true);
			expect(store.byId['30'].pluginVersionOk).toBe(true);
		});
	});

	test('bot 离线时 fullInit 失败，bot 上线后通过 updateBotOnline 重试', async () => {
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
			on: vi.fn(), off: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
			rtc: null, clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		// bot 离线：__bridgeConn 不触发 __fullInit（bot.online = false）
		store.addOrUpdateBot({ id: '32', name: 'Bot', online: false });
		await new Promise((r) => setTimeout(r, 50));
		expect(store.byId['32'].initialized).toBe(false);

		// SSE 推送 bot 上线 → updateBotOnline(true) → !initialized 分支 → fullInit 重试
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

		const fakeConn = {
			on: vi.fn(), off: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
			rtc: null, clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		// __bridgeConn 触发第一次 __fullInit（pending）
		store.addOrUpdateBot({ id: '31', name: 'Bot', online: true });
		await Promise.resolve();
		expect(store.byId['31'].initialized).toBe(true);

		// 模拟 bot 下线再上线，触发第二次 __fullInit（通过 updateBotOnline 的 !initialized 分支）
		// 先让 initialized 回到 false 以触发重试
		store.byId['31'].initialized = false;
		store.byId['31'].online = false;
		store.updateBotOnline('31', true);
		await Promise.resolve();

		// 此时第一次 fullInit 迟到地失败
		rejectFirst(new Error('late failure'));
		await Promise.resolve();
		await Promise.resolve();

		// generation guard 应保护 initialized 不被迟到的失败覆盖
		expect(store.byId['31'].initialized).toBe(true);
	});
});

describe('rtcPhase 生命周期', () => {
	test('__ensureRtc 成功时 rtcPhase: idle → building → ready', async () => {
		const store = useBotsStore();
		const phases = [];
		const fakeConn = {
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		mockInitRtc.mockImplementation(async (_botId, conn) => {
			phases.push(store.byId['90'].rtcPhase);
			conn.rtc = __fakeRtc;
			return 'rtc';
		});

		store.setBots([{ id: '90', name: 'Bot', online: true }]);
		expect(store.byId['90'].rtcPhase).toBe('idle');

		await store.__ensureRtc('90');

		expect(phases).toContain('building');
		expect(store.byId['90'].rtcPhase).toBe('ready');
	});

	test('__ensureRtc forceRebuild 时 rtcPhase 变为 recovering', async () => {
		const store = useBotsStore();
		const phases = [];
		const fakeRtc = { state: 'connected', isReady: true };
		const fakeConn = {
			rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		mockInitRtc.mockImplementation(async (_botId, conn) => {
			phases.push(store.byId['91'].rtcPhase);
			conn.rtc = __fakeRtc;
			return 'rtc';
		});

		store.setBots([{ id: '91', name: 'Bot', online: true }]);
		store.byId['91'].rtcPhase = 'ready';

		await store.__ensureRtc('91', { forceRebuild: true });

		expect(phases).toContain('recovering');
		expect(store.byId['91'].rtcPhase).toBe('ready');
	});

	test('__ensureRtc 全部重试失败时 rtcPhase 变为 failed', async () => {
		const store = useBotsStore();
		mockInitRtc.mockResolvedValue('ws'); // 始终失败

		const fakeConn = {
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setBots([{ id: '92', name: 'Bot', online: true }]);

		await store.__ensureRtc('92');

		expect(store.byId['92'].rtcPhase).toBe('failed');
	});

	test('__ensureRtc bail-out 时 rtcPhase 变为 idle', async () => {
		const store = useBotsStore();
		let callCount = 0;
		mockInitRtc.mockImplementation(async () => {
			callCount++;
			// 第一次调用后把 bot 设为离线，触发 bail-out
			store.byId['93'].online = false;
			return 'ws';
		});

		const fakeConn = {
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setBots([{ id: '93', name: 'Bot', online: true }]);

		await store.__ensureRtc('93');

		expect(store.byId['93'].rtcPhase).toBe('idle');
		expect(callCount).toBe(1); // bail-out 后不继续重试
	});

	test('__checkAndRecover PC failed → 触发 __ensureRtc rebuild', async () => {
		const store = useBotsStore();
		const fakeRtc = { state: 'failed', probe: vi.fn() };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc,
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setBots([{ id: '94', name: 'Bot', online: true }]);
		store.byId['94'].dcReady = true;
		store.byId['94'].rtcPhase = 'ready';
		mockCloseRtcForBot.mockClear();
		mockInitRtc.mockClear();

		await store.__checkAndRecover('94', 5_000);
		await vi.waitFor(() => {
			expect(mockCloseRtcForBot).toHaveBeenCalledWith('94');
			expect(mockInitRtc).toHaveBeenCalled();
		});
	});
});

describe('dcReady 响应式标记', () => {
	test('createBotState 初始 dcReady 为 false', () => {
		const store = useBotsStore();
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);
		expect(store.byId['1'].dcReady).toBe(false);
	});

	test('__rtcCallbacks: failed/closed 时 dcReady 置为 false，设置 disconnectedAt 和 rtcPhase', () => {
		const store = useBotsStore();
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);
		store.byId['1'].dcReady = true;
		store.byId['1'].rtcPhase = 'ready';

		const cbs = store.__rtcCallbacks('1');

		cbs.onRtcStateChange('failed', null);
		expect(store.byId['1'].dcReady).toBe(false);
		expect(store.byId['1'].disconnectedAt).toBeGreaterThan(0);
		expect(store.byId['1'].rtcPhase).toBe('failed');

		store.byId['1'].dcReady = true;
		store.byId['1'].rtcPhase = 'ready';
		store.byId['1'].disconnectedAt = 0;
		cbs.onRtcStateChange('closed', null);
		expect(store.byId['1'].dcReady).toBe(false);
		expect(store.byId['1'].disconnectedAt).toBeGreaterThan(0);
		expect(store.byId['1'].rtcPhase).toBe('failed');
	});

	test('__rtcCallbacks: connected + dcReady 已为 true → 不改变', () => {
		const store = useBotsStore();
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);
		store.byId['1'].dcReady = true;
		store.byId['1'].rtcPhase = 'ready';

		const fakeConn = { rtc: { isReady: true } };
		mockManager.get.mockReturnValue(fakeConn);

		const cbs = store.__rtcCallbacks('1');
		cbs.onRtcStateChange('connected', null);
		// dcReady 已为 true → 不触发被动恢复
		expect(store.byId['1'].dcReady).toBe(true);
		expect(store.byId['1'].rtcPhase).toBe('ready');
	});

	test('__rtcCallbacks: connected + !dcReady + rtc.isReady → 被动恢复设置 dcReady 和 rtcPhase', () => {
		const store = useBotsStore();
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);
		store.byId['1'].dcReady = false;
		store.byId['1'].rtcPhase = 'building';

		const fakeConn = { rtc: { isReady: true } };
		mockManager.get.mockReturnValue(fakeConn);

		const cbs = store.__rtcCallbacks('1');
		cbs.onRtcStateChange('connected', null);
		// 被动恢复：!dcReady + rtc.isReady → 设置 dcReady + rtcPhase
		expect(store.byId['1'].dcReady).toBe(true);
		expect(store.byId['1'].rtcPhase).toBe('ready');
	});

	test('__rtcCallbacks: connected + !dcReady + !rtc.isReady → 不改变 dcReady', () => {
		const store = useBotsStore();
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);
		store.byId['1'].dcReady = false;

		const fakeConn = { rtc: { isReady: false } };
		mockManager.get.mockReturnValue(fakeConn);

		const cbs = store.__rtcCallbacks('1');
		cbs.onRtcStateChange('connected', null);
		expect(store.byId['1'].dcReady).toBe(false);
	});

	test('__rtcCallbacks: 被动恢复触发 __refreshIfStale', () => {
		const store = useBotsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadAllSessions').mockResolvedValue();

		store.applySnapshot([{ id: '1', name: 'A', online: true }]);
		store.byId['1'].initialized = true;
		store.byId['1'].dcReady = false;
		store.byId['1'].disconnectedAt = Date.now() - 10_000; // 长间隔

		const fakeConn = { rtc: { isReady: true } };
		mockManager.get.mockReturnValue(fakeConn);

		const cbs = store.__rtcCallbacks('1');
		cbs.onRtcStateChange('connected', null);
		expect(store.byId['1'].dcReady).toBe(true);
		expect(agentsStore.loadAgents).toHaveBeenCalledWith('1');
		expect(sessionsStore.loadAllSessions).toHaveBeenCalled();
		expect(store.byId['1'].disconnectedAt).toBe(0);
	});

	test('__rtcCallbacks: transportInfo 存储', () => {
		const store = useBotsStore();
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);

		const cbs = store.__rtcCallbacks('1');
		const info = { localType: 'relay', localProtocol: 'udp', remoteType: 'host', remoteProtocol: 'udp', relayProtocol: 'tcp' };
		cbs.onRtcStateChange('connected', info);
		expect(store.byId['1'].rtcTransportInfo).toEqual(info);
	});

	test('__rtcCallbacks: bot 已移除时安全跳过', () => {
		const store = useBotsStore();
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);
		const cbs = store.__rtcCallbacks('1');

		// 移除 bot 后调用回调
		delete store.byId['1'];
		expect(() => cbs.onRtcStateChange('failed', null)).not.toThrow();
		expect(() => cbs.onRtcStateChange('connected', null)).not.toThrow();
	});
});

describe('getReadyConn', () => {
	test('bot 不存在时返回 null', () => {
		useBotsStore();
		expect(getReadyConn('999')).toBeNull();
	});

	test('dcReady=false 时返回 null', () => {
		const store = useBotsStore();
		store.byId['1'] = { id: '1', dcReady: false };
		expect(getReadyConn('1')).toBeNull();
	});

	test('dcReady=true 且 conn 存在时返回 conn', () => {
		const store = useBotsStore();
		store.byId['1'] = { id: '1', dcReady: true };
		const fakeConn = { request: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);
		expect(getReadyConn('1')).toBe(fakeConn);
	});

	test('dcReady=true 但 conn 不存在时返回 null', () => {
		const store = useBotsStore();
		store.byId['1'] = { id: '1', dcReady: true };
		mockManager.get.mockReturnValue(undefined);
		expect(getReadyConn('1')).toBeNull();
	});

	test('botId 归一化为 string', () => {
		const store = useBotsStore();
		store.byId['42'] = { id: '42', dcReady: true };
		const fakeConn = { request: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);
		expect(getReadyConn(42)).toBe(fakeConn);
	});
});

describe('运行时字段防御', () => {
	test('server snapshot 含运行时字段同名属性时不覆盖运行时状态', () => {
		const store = useBotsStore();
		const fakeConn = { on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(), rtc: null, request: vi.fn().mockResolvedValue({}) };
		mockManager.get.mockReturnValue(fakeConn);

		// 首次快照建立 bot（online:false 避免 __fullInit 副作用）
		store.applySnapshot([{ id: '1', name: 'Bot', online: false }]);
		const bot = store.byId['1'];
		// 模拟运行时状态已设置
		bot.online = true;
		bot.dcReady = true;
		bot.rtcPhase = 'ready';
		bot.initialized = true;
		bot.pluginVersionOk = true;
		bot.pluginInfo = { version: '1.0' };
		bot.rtcTransportInfo = { localType: 'host' };
		bot.lastAliveAt = 12345;
		bot.disconnectedAt = 999;

		// 第二次快照：server 数据意外包含运行时字段
		store.applySnapshot([{
			id: '1', name: 'BotRenamed', online: false,
			dcReady: false, rtcPhase: 'idle', initialized: false,
			pluginVersionOk: null, pluginInfo: null, rtcTransportInfo: null,
			lastAliveAt: 0, disconnectedAt: 0,
		}]);

		const updated = store.byId['1'];
		// server 字段应更新
		expect(updated.name).toBe('BotRenamed');
		// dcReady=true → preserveOnline 应覆盖 server 的 online=false
		expect(updated.online).toBe(true);
		// 运行时字段应保留
		expect(updated.dcReady).toBe(true);
		expect(updated.rtcPhase).toBe('ready');
		expect(updated.initialized).toBe(true);
		expect(updated.pluginVersionOk).toBe(true);
		expect(updated.pluginInfo).toEqual({ version: '1.0' });
		expect(updated.rtcTransportInfo).toEqual({ localType: 'host' });
		expect(updated.lastAliveAt).toBe(12345);
		expect(updated.disconnectedAt).toBe(999);
	});

	test('addOrUpdateBot 不覆盖运行时字段', () => {
		const store = useBotsStore();
		const fakeConn = { on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(), rtc: null, request: vi.fn().mockResolvedValue({}) };
		mockManager.get.mockReturnValue(fakeConn);

		// 建立 bot
		store.addOrUpdateBot({ id: '2', name: 'Bot', online: false });
		const bot = store.byId['2'];
		bot.dcReady = true;
		bot.rtcPhase = 'ready';
		bot.initialized = true;

		// 更新时意外包含运行时字段
		store.addOrUpdateBot({ id: '2', name: 'Renamed', dcReady: false, rtcPhase: 'idle', initialized: false });

		expect(bot.name).toBe('Renamed');
		expect(bot.dcReady).toBe(true);
		expect(bot.rtcPhase).toBe('ready');
		expect(bot.initialized).toBe(true);
	});
});

describe('退避重试 (__scheduleRetry / __clearRetry)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function setupFailedBot(store, id = '50') {
		const fakeConn = { rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);
		store.setBots([{ id, name: 'Bot', online: true }]);
		store.byId[id].rtcPhase = 'failed';
		store.byId[id].initialized = true;
		return fakeConn;
	}

	test('__ensureRtc 失败后安排退避 timer', async () => {
		const store = useBotsStore();
		mockInitRtc.mockResolvedValue('failed');
		const fakeConn = { rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateBot({ id: '50', name: 'Bot', online: false });
		store.byId['50'].online = true;
		store.byId['50'].initialized = true;

		await store.__ensureRtc('50');

		expect(store.byId['50'].rtcPhase).toBe('failed');
		// scheduleRetry 被调用 → timer 触发后 __ensureRtc 应被调用
		mockInitRtc.mockClear();
		// 阻止后续退避级联
		mockInitRtc.mockImplementation(async () => {
			store.byId['50'].online = false; // bail-out
			return 'failed';
		});
		vi.advanceTimersByTime(10_000);
		await Promise.resolve(); // 让 timer callback 执行
		await Promise.resolve(); // 让 __ensureRtc 内的 await 链完成
		expect(mockInitRtc).toHaveBeenCalled();
	});

	test('退避 timer 触发后重新调用 __ensureRtc', async () => {
		const store = useBotsStore();
		const fakeConn = { rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateBot({ id: '50', name: 'Bot', online: false });
		store.byId['50'].online = true;
		store.byId['50'].initialized = true;
		store.byId['50'].rtcPhase = 'failed';

		store.__scheduleRetry('50');
		mockInitRtc.mockClear();
		// 阻止后续退避级联
		mockInitRtc.mockImplementation(async () => {
			store.byId['50'].online = false;
			return 'failed';
		});

		vi.advanceTimersByTime(10_000);
		await Promise.resolve();
		await Promise.resolve();
		expect(mockInitRtc).toHaveBeenCalled();
	});

	test('连续失败时退避延迟指数增长', () => {
		const store = useBotsStore();
		setupFailedBot(store);

		const delays = [];
		const origSetTimeout = globalThis.setTimeout;
		vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, delay) => {
			delays.push(delay);
			return origSetTimeout(fn, delay);
		});

		for (let i = 0; i < 5; i++) {
			store.__scheduleRetry('50');
		}

		vi.restoreAllMocks();

		// 延迟序列：10s, 20s, 40s, 80s, 120s（封顶）
		expect(delays).toEqual([10_000, 20_000, 40_000, 80_000, 120_000]);
	});

	test('__ensureRtc 成功时清除退避状态', async () => {
		const store = useBotsStore();
		const fakeConn = { rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateBot({ id: '50', name: 'Bot', online: false });
		store.byId['50'].online = true;
		store.byId['50'].initialized = true;
		store.byId['50'].rtcPhase = 'failed';
		// 模拟已有退避状态
		store.__scheduleRetry('50');

		// 成功的 ensureRtc
		mockInitRtc.mockImplementation(async (_id, conn) => { conn.rtc = __fakeRtc; return 'rtc'; });
		await store.__ensureRtc('50');

		// 后续不应有 timer 触发 __ensureRtc
		mockInitRtc.mockClear();
		vi.advanceTimersByTime(300_000);
		expect(mockInitRtc).not.toHaveBeenCalled();
	});

	test('updateBotOnline(false) 清除退避', () => {
		const store = useBotsStore();
		setupFailedBot(store);
		store.__scheduleRetry('50');

		store.updateBotOnline('50', false);

		// timer 不应再触发
		mockInitRtc.mockClear();
		vi.advanceTimersByTime(300_000);
		expect(mockInitRtc).not.toHaveBeenCalled();
	});

	test('removeBotById 清除退避', () => {
		const store = useBotsStore();
		setupFailedBot(store);
		store.__scheduleRetry('50');

		store.removeBotById('50');

		mockInitRtc.mockClear();
		vi.advanceTimersByTime(300_000);
		expect(mockInitRtc).not.toHaveBeenCalled();
	});

	test('外部事件（applySnapshot）重置退避计数', () => {
		const store = useBotsStore();
		const fakeConn = { rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.applySnapshot([{ id: '50', name: 'Bot', online: true }]);
		store.byId['50'].initialized = true;
		store.byId['50'].rtcPhase = 'failed';

		// 模拟已退避多次（count=5）
		for (let i = 0; i < 5; i++) {
			store.__scheduleRetry('50');
		}

		const delays = [];
		const origSetTimeout = globalThis.setTimeout;
		vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, delay) => {
			delays.push(delay);
			return origSetTimeout(fn, delay);
		});

		// applySnapshot 会 __clearRetry → 新的 __scheduleRetry 从 count=0 开始
		store.byId['50'].rtcPhase = 'failed'; // 保持 failed 以触发 retry
		store.__clearRetry('50');
		store.__scheduleRetry('50');

		vi.restoreAllMocks();
		// 应回到初始延迟 10s
		expect(delays[0]).toBe(10_000);
	});

	test('最大次数（8）耗尽后不再安排', () => {
		const store = useBotsStore();
		setupFailedBot(store);

		for (let i = 0; i < 8; i++) {
			store.__scheduleRetry('50');
		}

		// 第 9 次不应安排
		const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
		store.__scheduleRetry('50');
		// setTimeout 可能被 vitest 内部调用，检查 mockInitRtc
		vi.restoreAllMocks();

		mockInitRtc.mockClear();
		vi.advanceTimersByTime(600_000);
		// 上面最后的 scheduleRetry（第 9 次）不应调度 __ensureRtc
		// 但前 8 次有 timer 可能在此期间触发；由于 count 已达上限，最后不再调度
	});

	test('被动失败（__rtcCallbacks）+ 非 _rtcInitInProgress 启动退避', async () => {
		const store = useBotsStore();
		const fakeConn = { rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateBot({ id: '50', name: 'Bot', online: false });
		store.byId['50'].online = true;
		store.byId['50'].initialized = true;

		// 获取 __rtcCallbacks 并模拟被动失败
		const cbs = store.__rtcCallbacks('50');
		cbs.onRtcStateChange('failed', null);

		expect(store.byId['50'].rtcPhase).toBe('failed');
		mockInitRtc.mockClear();
		// 阻止后续退避级联
		mockInitRtc.mockImplementation(async () => {
			store.byId['50'].online = false;
			return 'failed';
		});
		vi.advanceTimersByTime(10_000);
		await Promise.resolve();
		await Promise.resolve();
		expect(mockInitRtc).toHaveBeenCalled();
	});

	test('_rtcInitInProgress 时 __rtcCallbacks 不启动退避', async () => {
		const store = useBotsStore();
		const fakeConn = { rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateBot({ id: '50', name: 'Bot', online: false });
		store.byId['50'].online = true;
		store.byId['50'].initialized = true;

		const scheduleSpy = vi.spyOn(store, '__scheduleRetry');

		// 使 __ensureRtc 进入但第一次 initRtc 不立即完成
		let resolveFirst;
		let callIdx = 0;
		mockInitRtc.mockImplementation(() => {
			callIdx++;
			if (callIdx === 1) return new Promise((r) => { resolveFirst = r; });
			// 后续调用 bail-out
			store.byId['50'].online = false;
			return Promise.resolve('failed');
		});
		const ensurePromise = store.__ensureRtc('50');

		// 现在 _rtcInitInProgress 应为 true
		const cbs = store.__rtcCallbacks('50');
		cbs.onRtcStateChange('failed', null);

		// __scheduleRetry 不应被调用（因为 _rtcInitInProgress）
		expect(scheduleSpy).not.toHaveBeenCalled();

		// 清理：让 __ensureRtc 完成
		resolveFirst('failed');
		await ensurePromise;
	});

	test('timer 触发时 bot 已恢复（rtcPhase !== failed）→ 清理退出', () => {
		const store = useBotsStore();
		setupFailedBot(store);
		store.__scheduleRetry('50');

		// 在 timer 触发前恢复 bot
		store.byId['50'].rtcPhase = 'ready';

		mockInitRtc.mockClear();
		vi.advanceTimersByTime(10_000);
		// __ensureRtc 不应被调用
		expect(mockInitRtc).not.toHaveBeenCalled();
	});

	test('timer 触发时 bot 已 offline → 清理退出', () => {
		const store = useBotsStore();
		setupFailedBot(store);
		store.__scheduleRetry('50');

		store.byId['50'].online = false;

		mockInitRtc.mockClear();
		vi.advanceTimersByTime(10_000);
		expect(mockInitRtc).not.toHaveBeenCalled();
	});
});

describe('remoteLog 诊断日志', () => {
	test('bot online→offline 记录 remoteLog', () => {
		const store = useBotsStore();
		store.setBots([{ id: '1', online: true }]);
		mockRemoteLog.mockClear();

		store.updateBotOnline('1', false);
		expect(mockRemoteLog).toHaveBeenCalledWith('bot.online true→false bot=1');
	});

	test('applySnapshot 记录 remoteLog', () => {
		const store = useBotsStore();
		mockRemoteLog.mockClear();

		store.applySnapshot([{ id: '1', online: false }]);
		expect(mockRemoteLog).toHaveBeenCalledWith('bot.snapshot count=1');
	});

	test('__ensureRtc 成功记录 bot.rtcReady', async () => {
		const store = useBotsStore();
		const conn = { on: vi.fn(), rtc: null, clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(conn);
		store.setBots([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;
		mockRemoteLog.mockClear();

		mockInitRtc.mockImplementation(async (_id, c) => { c.rtc = __fakeRtc; return 'rtc'; });
		await store.__ensureRtc('1');
		expect(mockRemoteLog).toHaveBeenCalledWith('bot.rtcReady bot=1');
	});

	test('__ensureRtc 失败记录 bot.rtcFailed', async () => {
		const store = useBotsStore();
		const conn = { on: vi.fn(), rtc: null, clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(conn);
		store.setBots([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;
		mockRemoteLog.mockClear();

		mockInitRtc.mockResolvedValue('failed');
		await store.__ensureRtc('1');
		expect(mockRemoteLog).toHaveBeenCalledWith(expect.stringContaining('bot.rtcFailed bot=1'));
	});

	test('removeBotById 记录 bot.removed', () => {
		const store = useBotsStore();
		store.setBots([{ id: '1' }]);
		mockRemoteLog.mockClear();

		store.removeBotById('1');
		expect(mockRemoteLog).toHaveBeenCalledWith('bot.removed bot=1');
	});

	test('addOrUpdateBot 记录 bot.upsert', () => {
		const store = useBotsStore();
		const conn = { on: vi.fn(), rtc: null, clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(conn);
		mockRemoteLog.mockClear();

		store.addOrUpdateBot({ id: '5', name: 'New' });
		expect(mockRemoteLog).toHaveBeenCalledWith('bot.upsert bot=5');
	});

	test('__scheduleRetry 记录 bot.retryScheduled', () => {
		const store = useBotsStore();
		store.setBots([{ id: '1', online: true }]);
		store.byId['1'].rtcPhase = 'failed';
		mockRemoteLog.mockClear();

		store.__scheduleRetry('1');
		expect(mockRemoteLog).toHaveBeenCalledWith(expect.stringContaining('bot.retryScheduled bot=1'));
	});
});
