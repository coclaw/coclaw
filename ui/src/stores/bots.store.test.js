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
/** 触发信令 WS 状态变更 */
function fireSigState(s) {
	mockSigConn.state = s;
	for (const cb of sigListeners['state'] ?? []) cb(s);
}

vi.mock('../services/signaling-connection.js', () => ({
	useSignalingConnection: () => mockSigConn,
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
		expect(store.byId['42'].connState).toBe('disconnected'); // 信令 WS 尚未连接
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

		const fakeConn = {
			on: vi.fn(), off: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
			rtc: null, clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateBot({ id: '10', name: 'Fresh', online: true });
		expect(fakeConn.on).toHaveBeenCalledWith('event:agent', expect.any(Function));

		// 模拟信令 WS 连接就绪 → __bridgeSignaling 写入 connState → __onBotConnected
		fireSigState('connected');
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

		const fakeConn = { on: vi.fn(), off: vi.fn(), request: vi.fn().mockResolvedValue({}), rtc: null, clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		// 信令 WS 已连接 → __bridgeConn 同步状态 → 立即触发 __onBotConnected
		mockSigConn.state = 'connected';
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
			on: vi.fn(), off: vi.fn(),
			rtc: null, clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);
		mockSigConn.state = 'connected';

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
			on: vi.fn(), off: vi.fn(),
			rtc: null, clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		mockManager.get.mockReturnValue(fakeConn);
		mockSigConn.state = 'connected';

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

	test('preserves online=true when connState is connected', () => {
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
		const agentsStore = useAgentsStore();
		const agentRunsStore = useAgentRunsStore();
		const removeAgentsSpy = vi.spyOn(agentsStore, 'removeByBot');
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
		expect(removeAgentsSpy).toHaveBeenCalledWith('2');
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
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);

		// 信令 WS 连接就绪 → __onBotConnected → __fullInit → __ensureRtc
		fireSigState('connected');
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
		store.applySnapshot([{ id: '1', name: 'A', online: false }]);
		// 信令连接就绪，但 bot offline → __fullInit 抛出 Bot is offline
		fireSigState('connected');
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

		const fakeConn = {
			rtc: null, on: vi.fn(),
			off: vi.fn(), clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);
		store.applySnapshot([{ id: '2', name: 'B', online: true }]);
		expect(mockInitRtc).not.toHaveBeenCalled();

		// 首次 connected → __fullInit → __ensureRtc
		fireSigState('connected');
		await vi.waitFor(() => {
			expect(mockInitRtc).toHaveBeenCalled();
		});
		mockInitRtc.mockClear();

		// 模拟断连 → 重连（已 initialized）→ __ensureRtc → initRtc
		fireSigState('disconnected');
		fakeConn.rtc = null; // RTC 在断连期间丢失
		fireSigState('connected');
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
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);
		mockSigConn.state = 'connected';

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
			rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);
		mockSigConn.state = 'connected';

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
			rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);
		mockSigConn.state = 'connected';

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
			rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);
		mockSigConn.state = 'connected';

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
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);
		mockSigConn.state = 'connected';

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
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);
		mockSigConn.state = 'connected';

		store.setBots([{ id: '80', name: 'Bot', online: false }]);
		store.byId['80'].connState = 'connected';
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
});

describe('__bridgeSignaling 事件处理', () => {
	test('foreground-resume → 对有 RTC 的 bot 调用 tryIceRestart', () => {
		const store = useBotsStore();
		const mockTryRestart = vi.fn().mockReturnValue(true);
		const fakeConn = {
			on: vi.fn(), off: vi.fn(),
			rtc: { tryIceRestart: mockTryRestart, isReady: true, state: 'disconnected' },
			clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateBot({ id: '62', name: 'Bot', online: true });
		// 注册 __bridgeSignaling
		store.__bridgeConn('62');

		// 触发 foreground-resume
		for (const cb of sigListeners['foreground-resume'] ?? []) cb();

		expect(mockTryRestart).toHaveBeenCalled();
	});
});

describe('重连后批量状态刷新', () => {
	test('断连时长 >= BRIEF_DISCONNECT_MS 时刷新 agents/sessions/topics/dashboard（不刷新 bots）', async () => {
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
			on: vi.fn(), off: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
			rtc: null, clearRtc: vi.fn(),
			disconnectedAt: 0,
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateBot({ id: '20', name: 'Bot', online: true });
		// 首次 connected：全量初始化
		fireSigState('connected');
		await vi.waitFor(() => {
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('20');
		});

		agentsStore.loadAgents.mockClear();
		sessionsStore.loadAllSessions.mockClear();
		topicsStore.loadAllTopics.mockClear();
		dashboardStore.loadDashboard.mockClear();

		// 模拟断连 → __bridgeSignaling 设置 bot.disconnectedAt
		fireSigState('disconnected');

		// 手动回退 disconnectedAt 模拟 10s 前断连
		store.byId['20'].disconnectedAt = Date.now() - 10_000;

		// 重连
		fireSigState('connected');

		await vi.waitFor(() => {
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

		const fakeConn = {
			on: vi.fn(), off: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
			rtc: null, clearRtc: vi.fn(),
			disconnectedAt: 0,
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateBot({ id: '21', name: 'Bot', online: true });
		fireSigState('connected');
		await vi.waitFor(() => {
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('21');
		});

		agentsStore.loadAgents.mockClear();
		sessionsStore.loadAllSessions.mockClear();
		topicsStore.loadAllTopics.mockClear();

		// 模拟断连
		fireSigState('disconnected');

		// 模拟短暂抖动（2s）
		store.byId['21'].disconnectedAt = Date.now() - 2000;
		fireSigState('connected');

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

		const fakeConn = {
			on: vi.fn(), off: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
			rtc: null, clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateBot({ id: '30', name: 'Bot', online: true });
		fireSigState('connected');

		// 等 fullInit 失败
		await vi.waitFor(() => {
			expect(store.byId['30'].initialized).toBe(false);
		});

		// 修复 checkPluginVersion，模拟重连
		checkPluginVersion.mockResolvedValue({ ok: true, version: '0.6.0', clawVersion: '2026.3.14' });
		fireSigState('disconnected');
		fireSigState('connected');

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

		const fakeConn = {
			on: vi.fn(), off: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
			rtc: null, clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		// 首次绑定：bot 离线
		store.addOrUpdateBot({ id: '32', name: 'Bot', online: false });
		fireSigState('connected');

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

		const fakeConn = {
			on: vi.fn(), off: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
			rtc: null, clearRtc: vi.fn(),
			disconnectedAt: Date.now() - 10_000,
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateBot({ id: '31', name: 'Bot', online: true });

		// 首次连接，触发 fullInit（pending）
		fireSigState('connected');
		await Promise.resolve();
		expect(store.byId['31'].initialized).toBe(true);

		// 模拟快速断连重连，触发第二次 __onBotConnected（走 reconnect 分支，因为 initialized=true）
		fireSigState('disconnected');
		store.byId['31'].disconnectedAt = Date.now() - 10_000;
		fireSigState('connected');
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
	test('信令 WS 状态变更实时写入 byId[id].connState', () => {
		const store = useBotsStore();
		const fakeConn = { on: vi.fn(), off: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);
		store.applySnapshot([{ id: '1', name: 'A' }]);
		expect(store.byId['1'].connState).toBe('disconnected');

		fireSigState('connecting');
		expect(store.byId['1'].connState).toBe('connecting');

		fireSigState('connected');
		expect(store.byId['1'].connState).toBe('connected');

		fireSigState('disconnected');
		expect(store.byId['1'].connState).toBe('disconnected');
		expect(store.byId['1'].disconnectedAt).toBeGreaterThan(0);
	});
});

describe('dcReady 响应式标记', () => {
	test('createBotState 初始 dcReady 为 false', () => {
		const store = useBotsStore();
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);
		expect(store.byId['1'].dcReady).toBe(false);
	});

	test('WS disconnected 时 dcReady 置为 false', () => {
		const store = useBotsStore();
		const fakeConn = { on: vi.fn(), off: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);
		store.fetched = false;
		store.applySnapshot([{ id: '1', name: 'A' }]);

		// 模拟 dcReady 为 true
		store.byId['1'].dcReady = true;

		// 信令 WS 断开 → dcReady 应置 false
		fireSigState('disconnected');
		expect(store.byId['1'].dcReady).toBe(false);
	});

	test('__rtcCallbacks: rtcState failed/closed 时 dcReady 置为 false', () => {
		const store = useBotsStore();
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);
		store.byId['1'].dcReady = true;

		const cbs = store.__rtcCallbacks('1');

		cbs.onRtcStateChange('failed', null);
		expect(store.byId['1'].dcReady).toBe(false);

		store.byId['1'].dcReady = true;
		cbs.onRtcStateChange('closed', null);
		expect(store.byId['1'].dcReady).toBe(false);
	});

	test('__rtcCallbacks: rtcState connected 时不改变 dcReady', () => {
		const store = useBotsStore();
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);
		store.byId['1'].dcReady = false;

		const cbs = store.__rtcCallbacks('1');
		cbs.onRtcStateChange('connected', null);
		// dcReady 由 initRtc resolve 设置，rtcState 的 connected 回调不应改变它
		expect(store.byId['1'].dcReady).toBe(false);
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
