import { describe, test, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const mockManager = {
	connect: vi.fn(),
	disconnect: vi.fn(),
	syncConnections: vi.fn(),
	disconnectAll: vi.fn(),
	get: vi.fn(),
};

vi.mock('../services/claw-connection-manager.js', () => ({
	useClawConnections: () => mockManager,
	__resetClawConnections: vi.fn(),
}));

// mock remote-log（bots.store 内部 import）
const mockRemoteLog = vi.fn();
vi.mock('../services/remote-log.js', () => ({ remoteLog: (...args) => mockRemoteLog(...args) }));

vi.mock('../utils/plugin-version.js', () => ({
	checkPluginVersion: vi.fn().mockResolvedValue({ ok: true, version: '0.6.0', clawVersion: '2026.3.14', name: null, hostName: 'test-host' }),
	MIN_PLUGIN_VERSION: '0.4.0',
}));

const __fakeRtc = { isReady: true, state: 'connected' };
// 默认 mock：initRtc 成功时设置 conn.rtc，模拟 DC 就绪
const mockInitRtc = vi.fn().mockImplementation(async (_botId, conn) => { conn.rtc = __fakeRtc; return 'rtc'; });
const mockCloseRtcForBot = vi.fn();
vi.mock('../services/webrtc-connection.js', () => ({
	initRtc: (...args) => mockInitRtc(...args),
	closeRtcForClaw: (...args) => mockCloseRtcForBot(...args),
}));

// mock signaling-connection（sig gate 测试所需；默认 connected，个别用例覆盖）
let __mockSigState = 'connected';
const __mockSigListeners = new Map();
const __mockSig = {
	get state() { return __mockSigState; },
	on: vi.fn((ev, cb) => {
		if (!__mockSigListeners.has(ev)) __mockSigListeners.set(ev, new Set());
		__mockSigListeners.get(ev).add(cb);
	}),
	off: vi.fn((ev, cb) => { __mockSigListeners.get(ev)?.delete(cb); }),
	disconnect: vi.fn(),
};
function __emitSigState(next) {
	__mockSigState = next;
	__mockSigListeners.get('state')?.forEach((cb) => cb(next));
}
function __setSigStateSilent(next) {
	__mockSigState = next;
}
vi.mock('../services/signaling-connection.js', () => ({
	useSignalingConnection: () => __mockSig,
}));

import { useAgentRunsStore } from './agent-runs.store.js';
import { useAgentsStore } from './agents.store.js';
import { useClawsStore, __resetAwaitingConnIds } from './claws.store.js';
import { getReadyConn } from './get-ready-conn.js';
import { useDashboardStore } from './dashboard.store.js';
import { useSessionsStore } from './sessions.store.js';
import { useTopicsStore } from './topics.store.js';
import './claw-lifecycle.js'; // 注册生命周期回调

beforeEach(() => {
	setActivePinia(createPinia());
	vi.clearAllMocks();
	mockManager.get.mockReset();
	mockInitRtc.mockReset().mockImplementation(async (_botId, conn) => { conn.rtc = __fakeRtc; return 'rtc'; });
	mockCloseRtcForBot.mockReset();
	mockRemoteLog.mockClear();
	__mockSigState = 'connected';
	__mockSigListeners.clear();
	__mockSig.on.mockClear();
	__mockSig.off.mockClear();
	__resetAwaitingConnIds();
});

describe('setClaws', () => {
	test('populates byId from array', () => {
		const store = useClawsStore();
		store.setClaws([{ id: '1', name: 'Bot A' }, { id: '2', name: 'Bot B' }]);
		expect(Object.keys(store.byId)).toEqual(['1', '2']);
		expect(store.byId['1'].name).toBe('Bot A');
		expect(store.byId['2'].name).toBe('Bot B');
	});

	test('items getter returns array of all bots', () => {
		const store = useClawsStore();
		store.setClaws([{ id: '1', name: 'Bot A' }, { id: '2', name: 'Bot B' }]);
		expect(store.items).toHaveLength(2);
		expect(store.items.map(b => b.id)).toEqual(['1', '2']);
	});

	test('guards against non-array input by setting byId to empty', () => {
		const store = useClawsStore();
		store.setClaws('not-an-array');
		expect(store.items).toEqual([]);
	});

	test('guards against null input by setting byId to empty', () => {
		const store = useClawsStore();
		store.setClaws(null);
		expect(store.items).toEqual([]);
	});

	test('preserves runtime state for existing bots', () => {
		const store = useClawsStore();
		store.byId['1'] = { id: '1', name: 'OldName', online: true, rtcPhase: 'ready', initialized: true, pluginVersionOk: null, pluginInfo: null, rtcTransportInfo: null, lastAliveAt: 0, disconnectedAt: 0, lastSeenAt: null, createdAt: null, updatedAt: null };
		store.setClaws([{ id: '1', name: 'NewName' }]);
		expect(store.byId['1'].name).toBe('NewName');
		expect(store.byId['1'].rtcPhase).toBe('ready');
		expect(store.byId['1'].initialized).toBe(true);
	});
});

describe('addOrUpdateClaw', () => {
	test('inserts new claw with normalized fields and calls connect', () => {
		const store = useClawsStore();
		const fakeConn = { on: vi.fn(), off: vi.fn(), rtc: null, clearRtc: vi.fn(), request: vi.fn().mockResolvedValue({}) };
		mockManager.get.mockReturnValue(fakeConn);
		const bot = {
			id: 42,
			name: 'NewBot',
			online: true,
			lastSeenAt: '2024-01-01',
			createdAt: '2024-01-01',
			updatedAt: '2024-01-02',
		};
		store.addOrUpdateClaw(bot);

		expect(store.byId['42']).toBeDefined();
		expect(store.byId['42'].id).toBe('42');
		expect(store.byId['42'].name).toBe('NewBot');
		expect(store.byId['42'].online).toBe(true);
		expect(mockManager.connect).toHaveBeenCalledOnce();
		expect(mockManager.connect).toHaveBeenCalledWith('42');
	});

	test('normalizes missing optional fields to null and online to false', () => {
		const store = useClawsStore();
		const fakeConn = { state: 'disconnected', on: vi.fn(), __onAlive: null };
		mockManager.get.mockReturnValue(fakeConn);
		store.addOrUpdateClaw({ id: '7' });

		expect(store.byId['7'].name).toBeNull();
		expect(store.byId['7'].online).toBe(false);
		expect(store.byId['7'].lastSeenAt).toBeNull();
	});

	test('updates existing claw in place and calls connect', () => {
		const store = useClawsStore();
		const fakeConn = { state: 'disconnected', on: vi.fn(), off: vi.fn(), __onAlive: null, rtc: null, clearRtc: vi.fn(), request: vi.fn().mockResolvedValue({}) };
		mockManager.get.mockReturnValue(fakeConn);
		store.setClaws([{ id: '1', name: 'OldName', online: false }]);
		store.addOrUpdateClaw({ id: '1', name: 'NewName', online: true });

		expect(Object.keys(store.byId)).toHaveLength(1);
		expect(store.byId['1'].name).toBe('NewName');
		expect(store.byId['1'].online).toBe(true);
		expect(mockManager.connect).toHaveBeenCalledWith('1');
	});

	test('__bridgeConn triggers fullInit for online+uninitialized claw', async () => {
		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadSessionsForClaw').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadTopicsForClaw').mockResolvedValue();

		const fakeConn = {
			on: vi.fn(), off: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
			rtc: null, clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		// __bridgeConn 对 online + !initialized 的 bot 直接触发 __fullInit
		store.addOrUpdateClaw({ id: '10', name: 'Fresh', online: true });
		expect(fakeConn.on).toHaveBeenCalledWith('event:agent', expect.any(Function));
		expect(fakeConn.on).toHaveBeenCalledWith('event:coclaw.info.updated', expect.any(Function));

		await vi.waitFor(() => {
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('10');
			expect(sessionsStore.loadSessionsForClaw).toHaveBeenCalledWith('10');
			expect(topicsStore.loadTopicsForClaw).toHaveBeenCalledWith('10');
		});
	});

	test('__bridgeConn triggers fullInit immediately for online claw', async () => {
		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadSessionsForClaw').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadTopicsForClaw').mockResolvedValue();

		const fakeConn = { on: vi.fn(), off: vi.fn(), request: vi.fn().mockResolvedValue({}), rtc: null, clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '11', name: 'AlreadyReady', online: true });
		await vi.waitFor(() => {
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('11');
			expect(sessionsStore.loadSessionsForClaw).toHaveBeenCalledWith('11');
			expect(topicsStore.loadTopicsForClaw).toHaveBeenCalledWith('11');
		});
	});

	test('does nothing when bot id is falsy', () => {
		const store = useClawsStore();
		store.addOrUpdateClaw({ name: 'No ID' });
		expect(store.items).toHaveLength(0);
		expect(mockManager.connect).not.toHaveBeenCalled();
	});

	test('does nothing when bot is null', () => {
		const store = useClawsStore();
		store.addOrUpdateClaw(null);
		expect(store.items).toHaveLength(0);
		expect(mockManager.connect).not.toHaveBeenCalled();
	});
});

describe('removeClawById', () => {
	test('removes bot from byId and calls disconnect', () => {
		const store = useClawsStore();
		store.setClaws([{ id: '1', name: 'A' }, { id: '2', name: 'B' }]);
		store.removeClawById('1');

		expect(store.byId['1']).toBeUndefined();
		expect(store.byId['2']).toBeDefined();
		expect(mockManager.disconnect).toHaveBeenCalledWith('1');
	});

	test('calls removeSessionsByClawId on sessions store', () => {
		const store = useClawsStore();
		const sessionsStore = useSessionsStore();
		store.setClaws([{ id: '5', name: 'Bot' }]);
		sessionsStore.setSessions([
			{ sessionId: 'sa', clawId: '5' },
			{ sessionId: 'sb', clawId: '99' },
		]);

		store.removeClawById('5');

		expect(sessionsStore.items).toHaveLength(1);
		expect(sessionsStore.items[0].sessionId).toBe('sb');
	});

	test('calls removeByClaw on agentRuns store', () => {
		const store = useClawsStore();
		const agentRunsStore = useAgentRunsStore();
		const spy = vi.spyOn(agentRunsStore, 'removeByClaw');
		store.setClaws([{ id: '3', name: 'Bot' }]);

		store.removeClawById('3');

		expect(spy).toHaveBeenCalledWith('3');
	});

	test('calls removeByClaw on agents store', () => {
		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		agentsStore.byClaw['3'] = { agents: [{ id: 'main' }], defaultId: 'main', loading: false, fetched: true };
		store.setClaws([{ id: '3', name: 'Bot' }]);

		store.removeClawById('3');

		expect(agentsStore.byClaw['3']).toBeUndefined();
	});

	test('calls removeByClaw on topics store', () => {
		const store = useClawsStore();
		const topicsStore = useTopicsStore();
		store.setClaws([{ id: '7', name: 'Bot' }]);
		topicsStore.byId = {
			't1': { topicId: 't1', agentId: 'main', title: 'A', createdAt: 100, clawId: '7' },
			't2': { topicId: 't2', agentId: 'main', title: 'B', createdAt: 200, clawId: '99' },
		};

		store.removeClawById('7');

		expect(topicsStore.byId['t1']).toBeUndefined();
		expect(topicsStore.byId['t2']).toBeDefined();
	});

	test('is a no-op when bot is not found', () => {
		const store = useClawsStore();
		store.setClaws([{ id: '1', name: 'A' }]);

		expect(() => store.removeClawById('999')).not.toThrow();
		expect(store.items).toHaveLength(1);
		expect(mockManager.disconnect).toHaveBeenCalledWith('999');
	});

	test('cleans up all per-claw state in one operation', () => {
		const store = useClawsStore();
		const dashboardStore = useDashboardStore();
		store.setClaws([{ id: '5', name: 'Bot' }, { id: '6', name: 'Bot2' }]);
		store.byId['5'].rtcPhase = 'ready';
		store.byId['5'].rtcTransportInfo = { localType: 'host' };
		dashboardStore.byClaw['5'] = { loading: false, error: null, instance: { name: 'Bot' }, agents: [] };

		store.removeClawById('5');

		expect(store.byId['5']).toBeUndefined();
		expect(store.byId['6']).toBeDefined();
		expect(dashboardStore.byClaw['5']).toBeUndefined();
	});
});

describe('updateClawOnline', () => {
	test('flips online flag for matching bot', () => {
		const store = useClawsStore();
		store.setClaws([{ id: '1', name: 'A', online: false }]);
		store.updateClawOnline('1', true);

		expect(store.byId['1'].online).toBe(true);
	});

	test('coerces truthy value to boolean true', () => {
		const store = useClawsStore();
		store.setClaws([{ id: '1', online: false }]);
		store.updateClawOnline('1', 1);

		expect(store.byId['1'].online).toBe(true);
	});

	test('is a no-op when bot is not found', () => {
		const store = useClawsStore();
		store.setClaws([{ id: '1', online: true }]);

		expect(() => store.updateClawOnline('999', false)).not.toThrow();
		expect(store.byId['1'].online).toBe(true);
	});

	test('bot 离线时保留 agents 和 dashboard 缓存', () => {
		const store = useClawsStore();
		const dashboardStore = useDashboardStore();
		store.setClaws([{ id: '1', online: true }]);

		const agentsStore = useAgentsStore();
		agentsStore.byClaw['1'] = { agents: [{ id: 'main' }], defaultId: 'main', loading: false, fetched: true };
		dashboardStore.byClaw['1'] = { loading: false, error: null, instance: { name: 'Bot' }, agents: [] };

		store.updateClawOnline('1', false);

		expect(store.byId['1'].online).toBe(false);
		// agents / dashboard 缓存保留，供离线时 UI 展示
		expect(agentsStore.byClaw['1']).toBeDefined();
		expect(agentsStore.byClaw['1'].agents).toHaveLength(1);
		expect(dashboardStore.byClaw['1']).toBeDefined();
		expect(dashboardStore.byClaw['1'].instance.name).toBe('Bot');
		// dashboard 缓存中的 online 状态同步更新为 false
		expect(dashboardStore.byClaw['1'].instance.online).toBe(false);
	});

	test('bot 离线时不动 dcReady / disconnectedAt / rtcPhase（presence 与 DC 生命周期解耦）', () => {
		const store = useClawsStore();
		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].dcReady = true;
		store.byId['1'].rtcPhase = 'ready';
		store.byId['1'].disconnectedAt = 0;
		mockManager.get.mockReturnValue(null);

		store.updateClawOnline('1', false);

		expect(store.byId['1'].online).toBe(false);
		// 通信模型 §5.5 + 1ef6782：presence 不写 dcReady / disconnectedAt / rtcPhase
		// 这些字段只由 RTC 状态机（onRtcStateChange / dc.onclose / __ensureRtc）维护
		expect(store.byId['1'].dcReady).toBe(true);
		expect(store.byId['1'].disconnectedAt).toBe(0);
		expect(store.byId['1'].rtcPhase).toBe('ready');
	});

	test('bot 离线时不再调用 __checkAndRecover（offline gate 下不浪费 probe/restart）', () => {
		const store = useClawsStore();
		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].dcReady = true;
		const spy = vi.spyOn(store, '__checkAndRecover').mockResolvedValue(undefined);

		store.updateClawOnline('1', false);

		expect(spy).not.toHaveBeenCalled();
	});

	test('bot 离线 + PC 在 restarting → 调用 rtc.pauseRestart 停 restart 循环', () => {
		const store = useClawsStore();
		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].dcReady = true;

		const fakeRtc = {
			state: 'restarting',
			pauseRestart: vi.fn(),
			probe: vi.fn(),
			nudgeRestart: vi.fn(),
			triggerRestart: vi.fn(),
		};
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.updateClawOnline('1', false);

		expect(fakeRtc.pauseRestart).toHaveBeenCalled();
		// 不再 probe、不主动 restart
		expect(fakeRtc.probe).not.toHaveBeenCalled();
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
	});

	test('bot 离线 + PC 在 connected → 同样调用 pauseRestart（停 keepalive/disconnected timer 防止空烧 restart 预算）', () => {
		const store = useClawsStore();
		store.setClaws([{ id: '1', online: true }]);

		const fakeRtc = {
			state: 'connected',
			isReady: true,
			pauseRestart: vi.fn(),
		};
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.updateClawOnline('1', false);

		expect(fakeRtc.pauseRestart).toHaveBeenCalled();
	});

	test('bot 离线时调用 __clearRetry 取消排队的退避重试（PC 保留；online 回来由 __resumeOnline 重启）', () => {
		const store = useClawsStore();
		store.setClaws([{ id: '1', online: true }]);
		mockManager.get.mockReturnValue(null);
		const clearSpy = vi.spyOn(store, '__clearRetry');

		store.updateClawOnline('1', false);

		// __handleClawGoOffline 会调 __clearRetry
		expect(clearSpy).toHaveBeenCalledWith('1');
	});

	test('bot 离线 + DC 健在：不再主动 probe 或 triggerRestart（等 online 回来再动）', async () => {
		const store = useClawsStore();
		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].dcReady = true;
		store.byId['1'].rtcPhase = 'ready';

		const fakeRtc = {
			state: 'connected',
			probe: vi.fn().mockResolvedValue(true),
			nudgeRestart: vi.fn(),
			triggerRestart: vi.fn(),
			pauseRestart: vi.fn(),
		};
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.updateClawOnline('1', false);
		// 给任何可能的异步动作留 3 个 microtask
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		// offline gate：probe / triggerRestart 都不应被调用
		expect(fakeRtc.probe).not.toHaveBeenCalled();
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
		// dcReady / rtcPhase 都不受 presence 影响（与通信模型 §5.5 / 1ef6782 对齐）
		expect(store.byId['1'].dcReady).toBe(true);
		expect(store.byId['1'].rtcPhase).toBe('ready');
	});

	test('bot 上线时不清理 agents 缓存', () => {
		const store = useClawsStore();
		store.setClaws([{ id: '1', online: false }]);

		const agentsStore = useAgentsStore();
		agentsStore.byClaw['1'] = { agents: [{ id: 'main' }], defaultId: 'main', loading: false, fetched: true };

		store.updateClawOnline('1', true);

		expect(agentsStore.byClaw['1']).toBeDefined();
	});

	test('bot 上线且 initialized=false 时重试初始化', async () => {
		const { checkPluginVersion } = await import('../utils/plugin-version.js');
		checkPluginVersion.mockResolvedValue({ ok: true, version: '0.6.0', clawVersion: '2026.3.14', name: null, hostName: 'test-host' });
		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadSessionsForClaw').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadTopicsForClaw').mockResolvedValue();

		const fakeConn = {
			on: vi.fn(), off: vi.fn(),
			rtc: null, clearRtc: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: false }]);
		// 模拟 __fullInit 失败后的状态
		store.byId['1'].initialized = false;

		store.updateClawOnline('1', true);

		await vi.waitFor(() => {
			expect(store.byId['1'].initialized).toBe(true);
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('1');
		});
	});

	test('bot offline→online + initialized=true → __ensureRtc 而非 fullInit', async () => {
		const store = useClawsStore();
		const fakeConn = {
			on: vi.fn(), off: vi.fn(),
			rtc: null, clearRtc: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: false }]);
		store.byId['1'].initialized = true;
		mockInitRtc.mockClear();

		store.updateClawOnline('1', true);

		// __ensureRtc 被调用（会触发 initRtc）
		await vi.waitFor(() => {
			expect(mockInitRtc).toHaveBeenCalled();
		});
	});

	test('bot offline→online + DC 仍 connected → __ensureRtc 快速返回后加载 dashboard', async () => {
		const store = useClawsStore();
		const dashboardStore = useDashboardStore();
		vi.spyOn(dashboardStore, 'loadDashboard').mockResolvedValue();

		// 模拟 RTC 仍处于 connected 状态
		const fakeRtc = { state: 'connected', isReady: true };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(),
			rtc: fakeRtc, clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '1', name: 'Bot', online: false });
		store.byId['1'].initialized = true;

		store.updateClawOnline('1', true);

		// __ensureRtc 快速返回（RTC 已 connected），然后 .then() 触发 loadDashboard
		await vi.waitFor(() => {
			expect(dashboardStore.loadDashboard).toHaveBeenCalledWith('1');
		});
		expect(store.byId['1'].dcReady).toBe(true);
	});
});

describe('applySnapshot', () => {
	test('sets byId from snapshot items and calls syncConnections + bridgeConn', () => {
		const store = useClawsStore();
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
		const store = useClawsStore();
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

	test('applySnapshot 的 online=false 直接生效（presence 单一来源，不再 preserveOnline）', () => {
		const store = useClawsStore();
		mockManager.get.mockReturnValue(null);

		store.byId['1'] = {
			id: '1', name: 'a', online: true,
			dcReady: true,
		};

		// SSE 是 presence 单一来源；DC 状态独立由 PC 驱动（详见通信模型 §5.5）
		store.applySnapshot([{ id: '1', name: 'a', online: false }]);
		expect(store.byId['1'].online).toBe(false);
		// dcReady 不受 presence 影响
		expect(store.byId['1'].dcReady).toBe(true);
	});

	test('removes bots not in snapshot and cleans up RTC/sessions/agentRuns/topics', () => {
		const store = useClawsStore();
		const sessionsStore = useSessionsStore();
		const agentsStore = useAgentsStore();
		const agentRunsStore = useAgentRunsStore();
		const dashboardStore = useDashboardStore();
		const topicsStore = useTopicsStore();
		const removeAgentsSpy = vi.spyOn(agentsStore, 'removeByClaw');
		const removeSessionsSpy = vi.spyOn(sessionsStore, 'removeSessionsByClawId');
		const removeAgentRunsSpy = vi.spyOn(agentRunsStore, 'removeByClaw');
		const clearDashboardSpy = vi.spyOn(dashboardStore, 'clearDashboard');
		const removeTopicsSpy = vi.spyOn(topicsStore, 'removeByClaw');
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
		expect(removeTopicsSpy).toHaveBeenCalledWith('2');
	});

	test('skips items with null/undefined id', () => {
		const store = useClawsStore();
		mockManager.get.mockReturnValue(null);

		store.applySnapshot([
			{ id: null, name: 'bad' },
			{ id: undefined, name: 'bad2' },
			{ id: '1', name: 'good' },
		]);

		expect(Object.keys(store.byId)).toEqual(['1']);
	});

	test('handles empty items array', () => {
		const store = useClawsStore();
		mockManager.get.mockReturnValue(null);

		store.applySnapshot([]);

		expect(Object.keys(store.byId)).toEqual([]);
		expect(store.fetched).toBe(true);
		expect(mockManager.syncConnections).toHaveBeenCalledWith([]);
	});

	test('applySnapshot 为 rtcPhase=failed 的 online bot 重新尝试 ensureRtc', async () => {
		const store = useClawsStore();
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
		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadSessionsForClaw').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadTopicsForClaw').mockResolvedValue();

		const fakeConn = {
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
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
		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadSessionsForClaw').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadTopicsForClaw').mockResolvedValue();

		const fakeConn = {
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);
		// bot offline → __bridgeConn 不触发 __fullInit
		store.applySnapshot([{ id: '1', name: 'A', online: false }]);
		await new Promise((r) => setTimeout(r, 50));
		expect(mockInitRtc).not.toHaveBeenCalled();
	});

	test('removeClawById 调用 closeRtcForClaw', () => {
		const store = useClawsStore();
		store.setClaws([{ id: '5', name: 'Bot' }]);
		store.removeClawById('5');

		expect(mockCloseRtcForBot).toHaveBeenCalledWith('5');
	});

	test('__fullInit: pluginVersion ok=false + version 存在 → warn outdated 但不抛出', async () => {
		const { checkPluginVersion } = await import('../utils/plugin-version.js');
		checkPluginVersion.mockResolvedValue({ ok: false, version: '0.3.0', clawVersion: '2025.1.0', name: null, hostName: 'h' });
		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(useSessionsStore(), 'loadSessionsForClaw').mockResolvedValue();
		vi.spyOn(useTopicsStore(), 'loadTopicsForClaw').mockResolvedValue();

		const fakeConn = {
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		store.addOrUpdateClaw({ id: '34', name: 'OldPlugin', online: true });

		await vi.waitFor(() => {
			expect(store.byId['34'].pluginVersionOk).toBe(false);
		});
		// version 存在 → "outdated"
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining('plugin version'),
			'outdated',
			'34',
		);
		warnSpy.mockRestore();
		// 恢复默认 mock，避免影响后续测试
		checkPluginVersion.mockResolvedValue({ ok: true, version: '0.6.0', clawVersion: '2026.3.14', name: null, hostName: 'test-host' });
	});

	test('__fullInit: claw online=false 不再因 presence 抛错（持续维护不看 online）', async () => {
		const { checkPluginVersion } = await import('../utils/plugin-version.js');
		checkPluginVersion.mockResolvedValue({ ok: true, version: '0.6.0', clawVersion: '2026.3.14', name: null, hostName: 'h' });
		const store = useClawsStore();
		vi.spyOn(useAgentsStore(), 'loadAgents').mockResolvedValue();
		vi.spyOn(useSessionsStore(), 'loadSessionsForClaw').mockResolvedValue();
		vi.spyOn(useTopicsStore(), 'loadTopicsForClaw').mockResolvedValue();

		const fakeRtc = { isReady: true };
		const fakeConn = {
			rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);
		mockInitRtc.mockImplementation(async (_id, conn) => { conn.rtc = fakeRtc; return 'rtc'; });

		store.setClaws([{ id: 'fi1', name: 'Bot', online: false }]);

		// 直接调用 __fullInit：不应抛 "Claw is offline"
		await expect(store.__fullInit('fi1', fakeConn)).resolves.toBeUndefined();
	});

	test('__fullInit: pluginVersion ok=false + version null → 抛出 Claw is offline', async () => {
		const { checkPluginVersion } = await import('../utils/plugin-version.js');
		checkPluginVersion.mockResolvedValue({ ok: false, version: null, clawVersion: null, name: null, hostName: null });
		const store = useClawsStore();

		const fakeConn = {
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		store.addOrUpdateClaw({ id: '35', name: 'OfflinePlugin', online: true });

		// fullInit 抛出后 .catch 触发 → initialized = false
		await vi.waitFor(() => {
			expect(store.byId['35'].initialized).toBe(false);
		});
		// version null → "check failed"
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining('plugin version'),
			'check failed (claw may be offline)',
			'35',
		);
		warnSpy.mockRestore();
		// 恢复默认 mock，避免影响后续测试
		checkPluginVersion.mockResolvedValue({ ok: true, version: '0.6.0', clawVersion: '2026.3.14', name: null, hostName: 'test-host' });
	});

	test('byId 初始包含 rtcPhase 等字段', () => {
		const store = useClawsStore();
		store.setClaws([{ id: '1', name: 'Bot' }]);
		const bot = store.byId['1'];
		expect(bot.rtcPhase).toBe('idle');
		expect(bot.rtcTransportInfo).toBeNull();
		expect(bot.pluginVersionOk).toBeNull();
		expect(bot.pluginInfo).toBeNull();
	});

	test('bot offline→online → __ensureRtc 触发 close + build', async () => {
		const store = useClawsStore();
		const fakeConn = {
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '50', name: 'Bot', online: false }]);
		store.byId['50'].initialized = true;
		mockInitRtc.mockClear();
		mockCloseRtcForBot.mockClear();

		store.updateClawOnline('50', true);

		await vi.waitFor(() => {
			expect(mockCloseRtcForBot).toHaveBeenCalledWith('50');
			expect(mockInitRtc).toHaveBeenCalledWith('50', fakeConn, expect.objectContaining({
				onRtcStateChange: expect.any(Function),
			}));
		});
	});

	test('bot offline→online + RTC 已 connected → __ensureRtc 直接返回，不做任何操作', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'connected', isReady: true };
		const fakeConn = {
			rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '55', name: 'Bot', online: false }]);
		store.byId['55'].initialized = true;
		mockInitRtc.mockClear();
		mockCloseRtcForBot.mockClear();

		store.updateClawOnline('55', true);
		await new Promise((r) => setTimeout(r, 50));
		// RTC 已 connected → 无需 rebuild
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
		expect(mockInitRtc).not.toHaveBeenCalled();
	});

	test('bot offline→online + RTC 非 connected → close + rebuild', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'failed' };
		const fakeConn = {
			rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '60', name: 'Bot', online: false }]);
		store.byId['60'].initialized = true;
		mockInitRtc.mockClear();
		mockCloseRtcForBot.mockClear();

		store.updateClawOnline('60', true);
		await vi.waitFor(() => {
			expect(mockCloseRtcForBot).toHaveBeenCalledWith('60');
			expect(mockInitRtc).toHaveBeenCalled();
		});
	});

	test('__ensureRtc forceRebuild=true 跳过 connected 检查', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'connected', isReady: true };
		const fakeConn = {
			rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '62', name: 'Bot', online: true }]);
		mockInitRtc.mockClear();
		mockCloseRtcForBot.mockClear();

		await store.__ensureRtc('62', { forceRebuild: true });
		expect(mockCloseRtcForBot).toHaveBeenCalledWith('62');
		expect(mockInitRtc).toHaveBeenCalled();
	});

	test('__ensureRtc 并发防护：同时触发只执行一次', async () => {
		const store = useClawsStore();
		let resolveInit;
		mockInitRtc.mockImplementation(() => new Promise((r) => { resolveInit = r; }));

		const fakeConn = {
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '70', name: 'Bot', online: false }]);
		store.byId['70'].initialized = true;
		mockInitRtc.mockClear();
		mockCloseRtcForBot.mockClear();

		// 同时触发两次
		store.updateClawOnline('70', true);
		store.byId['70'].online = false;
		store.updateClawOnline('70', true);

		await new Promise((r) => setTimeout(r, 50));
		// 只应发起一次 initRtc（第二次被 _rtcInitInProgress 阻挡）
		expect(mockInitRtc).toHaveBeenCalledTimes(1);
		resolveInit('rtc');
	});

	test('__ensureRtc build 重试：首次超时后重试成功', async () => {
		const store = useClawsStore();
		let callCount = 0;
		mockInitRtc.mockImplementation(() => {
			callCount++;
			return Promise.resolve(callCount >= 2 ? 'rtc' : 'ws');
		});

		const fakeConn = {
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '80', name: 'Bot', online: false }]);
		store.byId['80'].initialized = true;

		store.updateClawOnline('80', true);
		await vi.waitFor(() => {
			expect(callCount).toBe(2); // 第 1 次 ws，第 2 次 rtc
		});
	});
});

describe('__bridgeConn 事件注册', () => {
	test('注册 event:agent 监听', () => {
		const store = useClawsStore();
		const fakeConn = { on: vi.fn(), off: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.applySnapshot([{ id: '1', name: 'A' }]);

		const agentCalls = fakeConn.on.mock.calls.filter(([ev]) => ev === 'event:agent');
		expect(agentCalls).toHaveLength(1);

		// 触发 event:agent 回调，验证 handler 被执行（覆盖 line 272）
		const agentHandler = agentCalls[0][1];
		const payload = { type: 'test', data: {} };
		agentHandler(payload);
		// _lifecycle.dispatchAgentEvent 是 no-op 默认实现，不会抛错
	});

	test('注册 event:coclaw.info.updated 监听', () => {
		const store = useClawsStore();
		const fakeConn = { on: vi.fn(), off: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.applySnapshot([{ id: '1', name: 'A' }]);

		const infoCalls = fakeConn.on.mock.calls.filter(([ev]) => ev === 'event:coclaw.info.updated');
		expect(infoCalls).toHaveLength(1);
	});

	test('event:coclaw.info.updated 更新 pluginInfo', () => {
		const store = useClawsStore();
		const fakeConn = { on: vi.fn(), off: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.applySnapshot([{ id: '1', name: 'A' }]);
		store.byId['1'].pluginInfo = { version: '0.6.0', clawVersion: '2026.3.14', name: null, hostName: 'old-host' };

		// 获取注册的 handler 并调用
		const infoHandler = fakeConn.on.mock.calls.find(([ev]) => ev === 'event:coclaw.info.updated')[1];
		infoHandler({ name: 'My Claw', hostName: 'new-host' });

		expect(store.byId['1'].pluginInfo.name).toBe('My Claw');
		expect(store.byId['1'].pluginInfo.hostName).toBe('new-host');
		// 其他字段保持不变
		expect(store.byId['1'].pluginInfo.version).toBe('0.6.0');
	});

	test('event:coclaw.info.updated 对不存在的 claw 不报错', () => {
		const store = useClawsStore();
		const fakeConn = { on: vi.fn(), off: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.applySnapshot([{ id: '1', name: 'A' }]);
		delete store.byId['1'];

		const infoHandler = fakeConn.on.mock.calls.find(([ev]) => ev === 'event:coclaw.info.updated')[1];
		// 不应抛异常
		infoHandler({ name: 'Test' });
	});

	test('event:coclaw.info.updated 在 pluginInfo 为 null 时初始化', () => {
		const store = useClawsStore();
		const fakeConn = { on: vi.fn(), off: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.applySnapshot([{ id: '1', name: 'A' }]);
		store.byId['1'].pluginInfo = null;

		const infoHandler = fakeConn.on.mock.calls.find(([ev]) => ev === 'event:coclaw.info.updated')[1];
		infoHandler({ name: 'Test', hostName: 'h1' });

		expect(store.byId['1'].pluginInfo.name).toBe('Test');
		expect(store.byId['1'].pluginInfo.hostName).toBe('h1');
	});

	test('event:coclaw.rtc.peerTransport 更新 rtcPeerTransportInfo', () => {
		const store = useClawsStore();
		const fakeConn = { on: vi.fn(), off: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);
		store.applySnapshot([{ id: '1', name: 'A' }]);

		const handler = fakeConn.on.mock.calls.find(([ev]) => ev === 'event:coclaw.rtc.peerTransport')[1];
		handler({ candidateType: 'relay', protocol: 'UDP', relayProtocol: 'TCP' });

		expect(store.byId['1'].rtcPeerTransportInfo).toEqual({
			candidateType: 'relay',
			protocol: 'udp',
			relayProtocol: 'tcp',
		});
	});

	test('event:coclaw.rtc.peerTransport relayProtocol 缺失时保留为 null', () => {
		const store = useClawsStore();
		const fakeConn = { on: vi.fn(), off: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);
		store.applySnapshot([{ id: '1', name: 'A' }]);

		const handler = fakeConn.on.mock.calls.find(([ev]) => ev === 'event:coclaw.rtc.peerTransport')[1];
		handler({ candidateType: 'host', protocol: 'udp', relayProtocol: null });

		expect(store.byId['1'].rtcPeerTransportInfo).toEqual({
			candidateType: 'host',
			protocol: 'udp',
			relayProtocol: null,
		});
	});

	test('event:coclaw.rtc.peerTransport 对不存在的 claw 静默返回', () => {
		const store = useClawsStore();
		const fakeConn = { on: vi.fn(), off: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);
		store.applySnapshot([{ id: '1', name: 'A' }]);
		delete store.byId['1'];

		const handler = fakeConn.on.mock.calls.find(([ev]) => ev === 'event:coclaw.rtc.peerTransport')[1];
		handler({ candidateType: 'relay', protocol: 'udp', relayProtocol: 'udp' }); // 不抛
	});

	test('event:coclaw.rtc.peerTransport payload 为空时静默返回', () => {
		const store = useClawsStore();
		const fakeConn = { on: vi.fn(), off: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);
		store.applySnapshot([{ id: '1', name: 'A' }]);

		const handler = fakeConn.on.mock.calls.find(([ev]) => ev === 'event:coclaw.rtc.peerTransport')[1];
		handler(null);
		handler(undefined);
		expect(store.byId['1'].rtcPeerTransportInfo).toBe(null);
	});

	test('同一 conn 实例不重复注册监听器', () => {
		const store = useClawsStore();
		const fakeConn = { on: vi.fn(), off: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.applySnapshot([{ id: '1', name: 'A' }]);
		store.applySnapshot([{ id: '1', name: 'A' }]);

		// event:agent 只注册一次
		const agentCalls = fakeConn.on.mock.calls.filter(([ev]) => ev === 'event:agent');
		expect(agentCalls).toHaveLength(1);
	});

	test('claw online + 未初始化 → 触发 fullInit', async () => {
		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(useSessionsStore(), 'loadSessionsForClaw').mockResolvedValue();
		vi.spyOn(useTopicsStore(), 'loadTopicsForClaw').mockResolvedValue();

		const fakeConn = { on: vi.fn(), off: vi.fn(), rtc: null, clearRtc: vi.fn(), request: vi.fn().mockResolvedValue({}) };
		mockManager.get.mockReturnValue(fakeConn);

		store.applySnapshot([{ id: '1', name: 'A', online: true }]);
		await vi.waitFor(() => {
			expect(mockInitRtc).toHaveBeenCalled();
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('1');
		});
	});

	test('bot offline → 不触发 fullInit', async () => {
		const store = useClawsStore();
		const fakeConn = { on: vi.fn(), off: vi.fn(), rtc: null, clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.applySnapshot([{ id: '1', name: 'A', online: false }]);
		await new Promise((r) => setTimeout(r, 50));
		expect(mockInitRtc).not.toHaveBeenCalled();
	});

	test('bot 已初始化 → 不触发 fullInit', async () => {
		const store = useClawsStore();
		const fakeConn = { on: vi.fn(), off: vi.fn(), rtc: null, clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', name: 'A', online: true }]);
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
		const store = useClawsStore();
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
		const store = useClawsStore();
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
		const store = useClawsStore();
		const fakeConn = { on: vi.fn(), off: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.applySnapshot([{ id: '1', name: 'A', online: false }]);
		// 删除 bot
		delete store.byId['1'];
		expect(fakeConn.__onGetRtcPhase()).toBe('idle');
	});
});

describe('__bridgeLifecycle 事件处理 — window lifecycle events', () => {
	// 辅助：按旧测试风格触发生命周期事件
	// source=network:online → 派发 network:online CustomEvent，detail 透传 typeChanged
	// source=app:foreground / visibility → 派发 app:foreground（visibility 归并为同一处理路径）
	function emitForegroundResume(source, { typeChanged } = {}) {
		if (source === 'network:online') {
			const detail = typeChanged !== undefined ? { typeChanged } : undefined;
			window.dispatchEvent(new CustomEvent('network:online', detail ? { detail } : undefined));
		} else {
			window.dispatchEvent(new Event('app:foreground'));
		}
	}

	test('network:online + PC connected + 无类型变化 → 跳过（信任 ICE 自检测）', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'connected', isReady: true, probe: vi.fn() };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '71', name: 'Bot', online: true });
		store.byId['71'].dcReady = true;
		store.__bridgeConn('71');
		mockCloseRtcForBot.mockClear();
		mockInitRtc.mockClear();

		emitForegroundResume('network:online', { typeChanged: false });
		await new Promise((r) => setTimeout(r, 50));
		expect(fakeRtc.probe).not.toHaveBeenCalled();
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
	});

	test('source=app:foreground 短后台（<25s）→ 跳过 probe', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'connected', isReady: true, probe: vi.fn() };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '63', name: 'Bot', online: true });
		store.byId['63'].dcReady = true;
		store.__bridgeConn('63');
		mockCloseRtcForBot.mockClear();

		// 模拟 app:background 5s 前
		window.dispatchEvent(new Event('app:background'));
		await new Promise((r) => setTimeout(r, 10));

		emitForegroundResume('app:foreground');
		await new Promise((r) => setTimeout(r, 50));
		expect(fakeRtc.probe).not.toHaveBeenCalled();
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
	});

	test('source=app:foreground 长后台 + probe 成功 → 不 rebuild', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'connected', isReady: true, probe: vi.fn().mockResolvedValue(true) };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '64', name: 'Bot', online: true });
		store.byId['64'].dcReady = true;
		store.__bridgeConn('64');
		mockCloseRtcForBot.mockClear();
		mockInitRtc.mockClear();

		// 未记录 background → _backgroundAt=0 → 短后台守卫不触发 → 进入 probe 路径
		emitForegroundResume('app:foreground');
		await vi.waitFor(() => {
			expect(fakeRtc.probe).toHaveBeenCalledWith(3_000);
		});
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
		expect(mockInitRtc).not.toHaveBeenCalled();
	});

	test('source=app:foreground 长后台 + probe 失败 + PC 变 failed → triggerRestart', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'connected', probe: vi.fn().mockImplementation(async () => {
			// probe 期间 PC 状态变为 failed（probe 失败 + state≠connected → triggerRestart 分支）
			fakeRtc.state = 'failed';
			return false;
		}), triggerRestart: vi.fn() };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '65', name: 'Bot', online: false });
		store.byId['65'].online = true;
		store.byId['65'].initialized = true;
		store.byId['65'].dcReady = true;
		store.__bridgeConn('65');
		mockCloseRtcForBot.mockClear();
		mockInitRtc.mockClear();

		emitForegroundResume('app:foreground');
		await vi.waitFor(() => {
			expect(fakeRtc.probe).toHaveBeenCalled();
		});
		await new Promise((r) => setTimeout(r, 50));
		// probe 失败 + PC 变 disconnected → triggerRestart（非 rebuild）
		expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('probe_failed');
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
		expect(mockInitRtc).not.toHaveBeenCalled();
	});

	test('probe 失败 + PC 仍 connected → 不 rebuild（plugin 繁忙场景）', async () => {
		const store = useClawsStore();
		// probe 返回 false 但 PC 仍然 connected
		const fakeRtc = { state: 'connected', probe: vi.fn().mockResolvedValue(false) };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '73', name: 'Bot', online: false });
		store.byId['73'].online = true;
		store.byId['73'].initialized = true;
		store.byId['73'].dcReady = true;
		store.__bridgeConn('73');
		mockCloseRtcForBot.mockClear();
		mockInitRtc.mockClear();
		mockRemoteLog.mockClear();

		emitForegroundResume('app:foreground');
		await vi.waitFor(() => {
			expect(fakeRtc.probe).toHaveBeenCalled();
		});
		await new Promise((r) => setTimeout(r, 50));
		// PC 仍 connected → 不 rebuild
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
		expect(mockRemoteLog).toHaveBeenCalledWith(expect.stringContaining('probe_timeout_pc_connected'));
	});

	test('dcReady=false → 不触发恢复', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'connected', isReady: true, probe: vi.fn() };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '66', name: 'Bot', online: true });
		store.byId['66'].dcReady = false;
		store.__bridgeConn('66');
		mockCloseRtcForBot.mockClear();

		emitForegroundResume('app:foreground');
		await new Promise((r) => setTimeout(r, 50));
		expect(fakeRtc.probe).not.toHaveBeenCalled();
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
	});

	test('PC 已 closed → 直接 rebuild（不 probe）', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'closed', probe: vi.fn() };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '68', name: 'Bot', online: false });
		store.byId['68'].online = true;
		store.byId['68'].initialized = true;
		store.byId['68'].dcReady = true;
		store.__bridgeConn('68');
		mockCloseRtcForBot.mockClear();

		emitForegroundResume('app:foreground');
		await vi.waitFor(() => {
			expect(mockCloseRtcForBot).toHaveBeenCalledWith('68');
		});
		expect(fakeRtc.probe).not.toHaveBeenCalled();
	});

	test('_rtcInitInProgress 时跳过 checkAndRecover', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'connected', isReady: true, probe: vi.fn() };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '75', name: 'Bot', online: true }]);
		store.byId['75'].initialized = true;
		store.byId['75'].dcReady = true;
		store.__bridgeConn('75');

		// 模拟 _rtcInitInProgress
		let resolveInit;
		mockInitRtc.mockImplementation(() => new Promise((r) => { resolveInit = r; }));
		const p = store.__ensureRtc('75', { forceRebuild: true });

		emitForegroundResume('app:foreground');
		await new Promise((r) => setTimeout(r, 50));
		expect(fakeRtc.probe).not.toHaveBeenCalled();

		resolveInit('rtc');
		await p;
	});

	test('dcReady=true 但 conn.rtc 为 null → 不触发恢复', async () => {
		const store = useClawsStore();
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: null, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '69', name: 'Bot', online: true });
		store.byId['69'].dcReady = true;
		store.__bridgeConn('69');
		mockCloseRtcForBot.mockClear();

		emitForegroundResume('app:foreground');
		await new Promise((r) => setTimeout(r, 50));
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
	});

	test('PC 已 failed → 直接 rebuild（不 probe）', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'failed', probe: vi.fn() };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '67', name: 'Bot', online: false });
		store.byId['67'].online = true;
		store.byId['67'].initialized = true;
		store.byId['67'].dcReady = true;
		store.__bridgeConn('67');
		mockCloseRtcForBot.mockClear();

		emitForegroundResume('app:foreground');
		await vi.waitFor(() => {
			expect(mockCloseRtcForBot).toHaveBeenCalledWith('67');
		});
		expect(fakeRtc.probe).not.toHaveBeenCalled();
	});

	test('network:online + PC failed + 无类型变化 → rebuild（加速长 offline 后恢复）', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'failed', probe: vi.fn() };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '83', name: 'Bot', online: false });
		store.byId['83'].online = true;
		store.byId['83'].initialized = true;
		store.byId['83'].dcReady = true;
		store.__bridgeConn('83');
		mockCloseRtcForBot.mockClear();

		emitForegroundResume('network:online', { typeChanged: false });
		await vi.waitFor(() => {
			expect(mockCloseRtcForBot).toHaveBeenCalledWith('83');
		});
		expect(fakeRtc.probe).not.toHaveBeenCalled();
	});

	test('network:online + PC closed + 无类型变化 → rebuild', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'closed', probe: vi.fn() };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '83b', name: 'Bot', online: false });
		store.byId['83b'].online = true;
		store.byId['83b'].initialized = true;
		store.byId['83b'].dcReady = true;
		store.__bridgeConn('83b');
		mockCloseRtcForBot.mockClear();

		emitForegroundResume('network:online', { typeChanged: false });
		await vi.waitFor(() => {
			expect(mockCloseRtcForBot).toHaveBeenCalledWith('83b');
		});
	});

	test('network:online + typeChanged + PC connected → triggerRestart（ICE restart-first）', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'connected', isReady: true, probe: vi.fn(), triggerRestart: vi.fn() };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '90', name: 'Bot', online: true });
		store.byId['90'].dcReady = true;
		store.__bridgeConn('90');
		mockCloseRtcForBot.mockClear();
		mockInitRtc.mockClear();

		emitForegroundResume('network:online', { typeChanged: true });
		await new Promise((r) => setTimeout(r, 50));
		// connected + typeChanged → triggerRestart（不 rebuild）
		expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('network_type_changed');
		expect(fakeRtc.probe).not.toHaveBeenCalled();
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
		expect(mockInitRtc).not.toHaveBeenCalled();
		expect(mockRemoteLog).toHaveBeenCalledWith(expect.stringContaining('network_type_changed'));
	});

	test('network:online + typeChanged + 多个 claw → connected 触发 triggerRestart，connecting 跳过', async () => {
		const store = useClawsStore();
		const fakeRtcA = { state: 'connected', isReady: true, probe: vi.fn(), triggerRestart: vi.fn() };
		// connecting 状态不匹配 restarting/connected+typeChanged/failed/closed 任何分支 → skip
		const fakeRtcB = { state: 'connecting', probe: vi.fn(), triggerRestart: vi.fn() };
		const conns = {
			'91': { on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(), rtc: fakeRtcA, request: vi.fn().mockResolvedValue({}) },
			'92': { on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(), rtc: fakeRtcB, request: vi.fn().mockResolvedValue({}) },
		};
		mockManager.get.mockImplementation((id) => conns[id]);

		store.addOrUpdateClaw({ id: '91', name: 'A', online: true });
		store.addOrUpdateClaw({ id: '92', name: 'B', online: true });
		// 等待 __fullInit 的 __ensureRtc 完成，释放 _rtcInitInProgress
		await new Promise((r) => setTimeout(r, 50));
		// initRtc mock 会将 conn.rtc 替换为 __fakeRtc，恢复为带 triggerRestart 的 mock
		conns['91'].rtc = fakeRtcA;
		conns['92'].rtc = fakeRtcB;
		store.byId['91'].dcReady = true;
		store.byId['92'].dcReady = true;
		store.__bridgeConn('91');
		store.__bridgeConn('92');
		mockCloseRtcForBot.mockClear();

		emitForegroundResume('network:online', { typeChanged: true });
		await new Promise((r) => setTimeout(r, 50));
		// connected claw → triggerRestart
		expect(fakeRtcA.triggerRestart).toHaveBeenCalledWith('network_type_changed');
		// connecting claw → skipped（不匹配任何恢复分支）
		expect(fakeRtcB.triggerRestart).not.toHaveBeenCalled();
		// 无 rebuild
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
	});

	test('network:online + typeChanged + _rtcInitInProgress → 跳过该 claw', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'connected', isReady: true, probe: vi.fn() };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '93', name: 'Bot', online: true });
		store.byId['93'].dcReady = true;
		store.__bridgeConn('93');

		// 模拟 _rtcInitInProgress
		let resolveInit;
		mockInitRtc.mockImplementation(() => new Promise((r) => { resolveInit = r; }));
		const p = store.__ensureRtc('93', { forceRebuild: true });
		mockCloseRtcForBot.mockClear(); // 清除 ensureRtc 内部的 close 调用

		emitForegroundResume('network:online', { typeChanged: true });
		await new Promise((r) => setTimeout(r, 50));
		// _rtcInitInProgress 阻止了 __handleNetworkOnline 中的 rebuild
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();

		resolveInit('rtc');
		await p;
	});

	test('network:online + typeChanged + 未初始化 → 跳过', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'connected', isReady: true, probe: vi.fn() };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '94', name: 'Bot', online: true });
		store.byId['94'].initialized = false; // 未完成初始化
		store.__bridgeConn('94');
		mockCloseRtcForBot.mockClear();

		emitForegroundResume('network:online', { typeChanged: true });
		await new Promise((r) => setTimeout(r, 50));
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
	});

	test('network:online + typeChanged + PC failed → rebuild', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'failed', probe: vi.fn() };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '96', name: 'Bot', online: false });
		store.byId['96'].online = true;
		store.byId['96'].initialized = true;
		store.byId['96'].dcReady = true;
		store.__bridgeConn('96');
		mockCloseRtcForBot.mockClear();

		emitForegroundResume('network:online', { typeChanged: true });
		await vi.waitFor(() => {
			expect(mockCloseRtcForBot).toHaveBeenCalledWith('96');
		});
	});

	test('network:online + typeChanged + conn.rtc=null → 跳过', async () => {
		const store = useClawsStore();
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: null, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '97', name: 'Bot', online: true });
		store.byId['97'].dcReady = true;
		store.__bridgeConn('97');
		mockCloseRtcForBot.mockClear();

		emitForegroundResume('network:online', { typeChanged: true });
		await new Promise((r) => setTimeout(r, 50));
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
	});

	test('network:online + typeChanged 未传入（undefined）→ 视为无类型变化', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'connected', isReady: true, probe: vi.fn() };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '98', name: 'Bot', online: true });
		store.byId['98'].dcReady = true;
		store.__bridgeConn('98');
		mockCloseRtcForBot.mockClear();

		// 不传 typeChanged → 相当于 typeChanged=false → PC connected 时跳过
		emitForegroundResume('network:online');
		await new Promise((r) => setTimeout(r, 50));
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
		expect(fakeRtc.probe).not.toHaveBeenCalled();
	});

	test('network:online + typeChanged + PC connected → triggerRestart，不同步设置 rtcPhase', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'connected', isReady: true, probe: vi.fn(), triggerRestart: vi.fn() };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '99', name: 'Bot', online: true });
		store.byId['99'].dcReady = true;
		store.byId['99'].rtcPhase = 'ready';
		store.__bridgeConn('99');
		mockCloseRtcForBot.mockClear();

		emitForegroundResume('network:online', { typeChanged: true });
		await new Promise((r) => setTimeout(r, 50));
		// triggerRestart 由 WebRtcConnection 内部管理状态，store 不同步设置 rtcPhase
		expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('network_type_changed');
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
		// rtcPhase 未被 store 修改（由 onRtcStateChange 回调驱动）
		expect(store.byId['99'].rtcPhase).toBe('ready');
	});

	test('network:online + PC failed（无类型变化）rebuild 清除退避状态', async () => {
		const store = useClawsStore();
		// 先让 ensureRtc 失败以触发 __scheduleRetry，建立退避状态
		mockInitRtc.mockImplementation(async () => 'failed');
		const fakeRtc = { state: 'failed', probe: vi.fn() };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '99b', name: 'Bot', online: false });
		store.byId['99b'].online = true;
		store.byId['99b'].initialized = true;
		store.byId['99b'].dcReady = true;
		store.__bridgeConn('99b');

		// 触发 __ensureRtc 使其失败 → __scheduleRetry 建立退避状态
		await store.__ensureRtc('99b', { forceRebuild: true });
		expect(store.byId['99b'].retryCount).toBe(1);
		mockCloseRtcForBot.mockClear();
		mockInitRtc.mockImplementation(async (_id, conn) => { conn.rtc = __fakeRtc; return 'rtc'; });

		// network:online + PC failed → rebuild → __clearRetry 清除退避
		emitForegroundResume('network:online', { typeChanged: false });
		await vi.waitFor(() => {
			expect(mockCloseRtcForBot).toHaveBeenCalledWith('99b');
		});
		await new Promise((r) => setTimeout(r, 50));
		expect(store.byId['99b'].retryCount).toBe(0);
	});

	test('probe in-flight + network:type-changed + PC connected → triggerRestart 安全执行', async () => {
		const store = useClawsStore();
		let probeResolve;
		const fakeRtc = {
			state: 'connected', isReady: true,
			probe: vi.fn().mockImplementation(() => new Promise((r) => { probeResolve = r; })),
			triggerRestart: vi.fn(),
		};
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '102', name: 'Bot', online: true });
		await new Promise((r) => setTimeout(r, 50)); // 等待 __fullInit 完成
		store.byId['102'].dcReady = true;
		store.__bridgeConn('102');
		mockCloseRtcForBot.mockClear();
		mockInitRtc.mockClear();

		// 1) app:foreground 触发 probe（挂起中）
		emitForegroundResume('app:foreground');
		await vi.waitFor(() => {
			expect(fakeRtc.probe).toHaveBeenCalled();
		});

		// 2) network:type-changed + connected → triggerRestart（非 rebuild）
		emitForegroundResume('network:online', { typeChanged: true });
		await new Promise((r) => setTimeout(r, 50));
		expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('network_type_changed');
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();

		// 3) probe 解决（PC 仍 connected）→ __checkAndRecover 跳过（PC 连接健康）
		probeResolve(false);
		await new Promise((r) => setTimeout(r, 50));
		// 无 rebuild 发生
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
	});

	test('app:foreground 未记录过 background（_backgroundAt=0）→ 正常 probe', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'connected', isReady: true, probe: vi.fn().mockResolvedValue(true) };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '85', name: 'Bot', online: true });
		store.byId['85'].dcReady = true;
		store.__bridgeConn('85');
		// 不触发 app:background → _backgroundAt 保持 0
		mockCloseRtcForBot.mockClear();

		emitForegroundResume('app:foreground');
		await vi.waitFor(() => {
			expect(fakeRtc.probe).toHaveBeenCalledWith(3_000);
		});
	});

	test('多个 claw：app:foreground 对所有 claw 触发 checkAndRecover', async () => {
		const store = useClawsStore();
		const fakeRtcA = { state: 'connected', isReady: true, probe: vi.fn().mockResolvedValue(true) };
		const fakeRtcB = { state: 'connected', isReady: true, probe: vi.fn().mockResolvedValue(true) };
		const conns = {
			'100': { on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(), rtc: fakeRtcA, request: vi.fn().mockResolvedValue({}) },
			'101': { on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(), rtc: fakeRtcB, request: vi.fn().mockResolvedValue({}) },
		};
		mockManager.get.mockImplementation((id) => conns[id]);

		store.addOrUpdateClaw({ id: '100', name: 'A', online: true });
		store.addOrUpdateClaw({ id: '101', name: 'B', online: true });
		store.byId['100'].dcReady = true;
		store.byId['101'].dcReady = true;
		store.__bridgeConn('100');
		store.__bridgeConn('101');

		emitForegroundResume('app:foreground');
		await vi.waitFor(() => {
			expect(fakeRtcA.probe).toHaveBeenCalled();
			expect(fakeRtcB.probe).toHaveBeenCalled();
		});
	});

	test('app:foreground 后台恰好 25s（边界值）→ 正常 probe', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'connected', isReady: true, probe: vi.fn().mockResolvedValue(true) };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '86', name: 'Bot', online: true });
		store.byId['86'].dcReady = true;
		store.__bridgeConn('86');
		mockCloseRtcForBot.mockClear();

		// 模拟恰好 25s 后台
		vi.useFakeTimers();
		window.dispatchEvent(new Event('app:background'));
		vi.advanceTimersByTime(25_000);
		emitForegroundResume('app:foreground');
		// bgDuration = 25000，不小于 SHORT_BACKGROUND_MS → 正常 probe
		await vi.waitFor(() => {
			expect(fakeRtc.probe).toHaveBeenCalledWith(3_000);
		});
		vi.useRealTimers();
	});

	// 回归：登出清理后再次桥接，监听器必须重新挂回来
	// 历史 bug：__lifecycleBridged 曾挂在 store 实例上，$reset 不清，重登录时短路返回，
	// app:foreground / network:online 驱动的 RTC 恢复全部失效
	test('__resetClawStoreInternals 后再次 __bridgeConn → 生命周期监听器重新生效', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'connected', isReady: true, probe: vi.fn().mockResolvedValue(true) };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '87', name: 'Bot', online: true });
		store.byId['87'].dcReady = true;
		store.__bridgeConn('87');

		// 首轮：app:foreground 应触发 probe
		emitForegroundResume('app:foreground');
		await vi.waitFor(() => {
			expect(fakeRtc.probe).toHaveBeenCalledTimes(1);
		});

		// 模拟 logout：清理模块级状态（含监听器）
		__resetAwaitingConnIds();

		// 确认清理后事件已不再路由到 store（监听器已摘除）
		fakeRtc.probe.mockClear();
		emitForegroundResume('app:foreground');
		await new Promise((r) => setTimeout(r, 20));
		expect(fakeRtc.probe).not.toHaveBeenCalled();

		// 模拟 re-login：同一 store 实例再次桥接
		store.__bridgeConn('87');
		emitForegroundResume('app:foreground');
		await vi.waitFor(() => {
			expect(fakeRtc.probe).toHaveBeenCalledTimes(1);
		});
	});

});

describe('__refreshIfStale', () => {
	test('断连时长 >= BRIEF_DISCONNECT_MS 时刷新 agents/sessions/topics/dashboard', () => {
		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		const dashboardStore = useDashboardStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadSessionsForClaw').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadTopicsForClaw').mockResolvedValue();
		vi.spyOn(dashboardStore, 'loadDashboard').mockResolvedValue();

		store.setClaws([{ id: '20', name: 'Bot', online: true }]);
		store.byId['20'].initialized = true;
		store.byId['20'].disconnectedAt = Date.now() - 35_000;

		store.__refreshIfStale('20');

		expect(agentsStore.loadAgents).toHaveBeenCalledWith('20');
		expect(sessionsStore.loadSessionsForClaw).toHaveBeenCalledWith('20');
		expect(topicsStore.loadTopicsForClaw).toHaveBeenCalledWith('20');
		expect(dashboardStore.loadDashboard).toHaveBeenCalledWith('20');
		// disconnectedAt 被重置
		expect(store.byId['20'].disconnectedAt).toBe(0);
	});

	test('断连时长 < BRIEF_DISCONNECT_MS 时不刷新', () => {
		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadSessionsForClaw').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadTopicsForClaw').mockResolvedValue();

		store.setClaws([{ id: '21', name: 'Bot', online: true }]);
		store.byId['21'].initialized = true;
		store.byId['21'].disconnectedAt = Date.now() - 2000;

		store.__refreshIfStale('21');

		expect(agentsStore.loadAgents).not.toHaveBeenCalled();
		expect(sessionsStore.loadSessionsForClaw).not.toHaveBeenCalled();
		expect(topicsStore.loadTopicsForClaw).not.toHaveBeenCalled();
	});

	test('disconnectedAt = 0 时不刷新', () => {
		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();

		store.setClaws([{ id: '22', name: 'Bot', online: true }]);
		store.byId['22'].initialized = true;
		store.byId['22'].disconnectedAt = 0;

		store.__refreshIfStale('22');

		expect(agentsStore.loadAgents).not.toHaveBeenCalled();
	});

	test('未初始化时不刷新', () => {
		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();

		store.setClaws([{ id: '23', name: 'Bot', online: true }]);
		store.byId['23'].initialized = false;
		store.byId['23'].disconnectedAt = Date.now() - 35_000;

		store.__refreshIfStale('23');

		expect(agentsStore.loadAgents).not.toHaveBeenCalled();
	});

	test('{force:true} 绕过 BRIEF_DISCONNECT_MS 门槛（短 offline 也刷）', () => {
		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		const dashboardStore = useDashboardStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadSessionsForClaw').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadTopicsForClaw').mockResolvedValue();
		vi.spyOn(dashboardStore, 'loadDashboard').mockResolvedValue();

		store.setClaws([{ id: '24', name: 'Bot', online: true }]);
		store.byId['24'].initialized = true;
		store.byId['24'].disconnectedAt = Date.now() - 2000; // 短于 BRIEF_DISCONNECT_MS

		store.__refreshIfStale('24', { force: true });

		expect(agentsStore.loadAgents).toHaveBeenCalledWith('24');
		expect(sessionsStore.loadSessionsForClaw).toHaveBeenCalledWith('24');
		expect(topicsStore.loadTopicsForClaw).toHaveBeenCalledWith('24');
		expect(dashboardStore.loadDashboard).toHaveBeenCalledWith('24');
		expect(store.byId['24'].disconnectedAt).toBe(0);
	});

	test('{force:true} + disconnectedAt=0（connected-throughout-offline）也刷', () => {
		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();

		store.setClaws([{ id: '25', name: 'Bot', online: true }]);
		store.byId['25'].initialized = true;
		store.byId['25'].disconnectedAt = 0;

		store.__refreshIfStale('25', { force: true });

		// force 下不看 disconnectedAt，即使 0 也刷（对应 connected-throughout-offline 场景）
		expect(agentsStore.loadAgents).toHaveBeenCalledWith('25');
	});

	test('{force:true} + 未初始化 → 仍不刷', () => {
		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();

		store.setClaws([{ id: '26', name: 'Bot', online: true }]);
		store.byId['26'].initialized = false;

		store.__refreshIfStale('26', { force: true });

		// initialized=false 仍然 gate 住（force 不覆盖初始化检查）
		expect(agentsStore.loadAgents).not.toHaveBeenCalled();
	});
});

describe('__ensureRtc 后通过 __refreshIfStale 刷新', () => {
	test('RTC 重建成功 + 长时间断连 → 刷新 stores', async () => {
		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		const dashboardStore = useDashboardStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadSessionsForClaw').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadTopicsForClaw').mockResolvedValue();
		vi.spyOn(dashboardStore, 'loadDashboard').mockResolvedValue();

		const fakeConn = {
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '20', name: 'Bot', online: true }]);
		store.byId['20'].initialized = true;
		store.byId['20'].disconnectedAt = Date.now() - 35_000;

		await store.__ensureRtc('20');

		expect(agentsStore.loadAgents).toHaveBeenCalledWith('20');
		expect(sessionsStore.loadSessionsForClaw).toHaveBeenCalledWith('20');
		expect(topicsStore.loadTopicsForClaw).toHaveBeenCalledWith('20');
		expect(dashboardStore.loadDashboard).toHaveBeenCalledWith('20');
	});

	test('RTC 重建成功 + 短暂断连 → 不刷新', async () => {
		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadSessionsForClaw').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadTopicsForClaw').mockResolvedValue();

		const fakeConn = {
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '21', name: 'Bot', online: true }]);
		store.byId['21'].initialized = true;
		store.byId['21'].disconnectedAt = Date.now() - 2000;

		await store.__ensureRtc('21');

		expect(agentsStore.loadAgents).not.toHaveBeenCalled();
		expect(sessionsStore.loadSessionsForClaw).not.toHaveBeenCalled();
		expect(topicsStore.loadTopicsForClaw).not.toHaveBeenCalled();
	});
});

describe('__fullInit 失败重试', () => {
	test('fullInit 失败后 initialized 重置为 false，下次可通过 updateClawOnline 重试', async () => {
		const { checkPluginVersion } = await import('../utils/plugin-version.js');
		checkPluginVersion.mockRejectedValue(new Error('version check failed'));
		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();

		const fakeConn = {
			on: vi.fn(), off: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
			rtc: null, clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		// __bridgeConn 触发 __fullInit（online + !initialized）
		store.addOrUpdateClaw({ id: '30', name: 'Bot', online: true });

		// 等 fullInit 失败
		await vi.waitFor(() => {
			expect(store.byId['30'].initialized).toBe(false);
		});

		// 修复 checkPluginVersion，通过 updateClawOnline 触发重试
		checkPluginVersion.mockResolvedValue({ ok: true, version: '0.6.0', clawVersion: '2026.3.14', name: null, hostName: 'test-host' });
		store.byId['30'].online = false;
		store.updateClawOnline('30', true);

		await vi.waitFor(() => {
			expect(store.byId['30'].initialized).toBe(true);
			expect(store.byId['30'].pluginVersionOk).toBe(true);
		});
	});

	test('bot 离线时 fullInit 失败，bot 上线后通过 updateClawOnline 重试', async () => {
		const { checkPluginVersion } = await import('../utils/plugin-version.js');
		checkPluginVersion.mockResolvedValue({ ok: true, version: '0.6.0', clawVersion: '2026.3.14', name: null, hostName: 'test-host' });

		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadSessionsForClaw').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadTopicsForClaw').mockResolvedValue();

		const fakeConn = {
			on: vi.fn(), off: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
			rtc: null, clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		// bot 离线：__bridgeConn 不触发 __fullInit（claw.online = false）
		store.addOrUpdateClaw({ id: '32', name: 'Bot', online: false });
		await new Promise((r) => setTimeout(r, 50));
		expect(store.byId['32'].initialized).toBe(false);

		// SSE 推送 bot 上线 → updateClawOnline(true) → !initialized 分支 → fullInit 重试
		store.updateClawOnline('32', true);
		await vi.waitFor(() => {
			expect(store.byId['32'].initialized).toBe(true);
			expect(store.byId['32'].pluginVersionOk).toBe(true);
		});
	});

	test('updateClawOnline !initialized + fullInit 失败 → initialized 重置为 false', async () => {
		const { checkPluginVersion } = await import('../utils/plugin-version.js');
		checkPluginVersion.mockRejectedValue(new Error('version check boom'));
		const store = useClawsStore();

		const fakeConn = {
			on: vi.fn(), off: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
			rtc: null, clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		// 先建立 bot（online:false 避免 __bridgeConn 触发 __fullInit）
		store.addOrUpdateClaw({ id: '33', name: 'Bot33', online: false });
		store.byId['33'].initialized = false;

		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		// updateClawOnline 走 !initialized 分支 → __fullInit → .catch 触发 lines 157-158
		store.updateClawOnline('33', true);

		await vi.waitFor(() => {
			expect(store.byId['33'].initialized).toBe(false);
		});
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining('fullInit failed'),
			'33',
			'version check boom',
		);
		warnSpy.mockRestore();
		// 恢复默认 mock，避免影响后续测试
		checkPluginVersion.mockResolvedValue({ ok: true, version: '0.6.0', clawVersion: '2026.3.14', name: null, hostName: 'test-host' });
	});

	test('fullInit 失败不覆盖后续成功的重连（generation guard）', async () => {
		const { checkPluginVersion } = await import('../utils/plugin-version.js');
		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(useSessionsStore(), 'loadSessionsForClaw').mockResolvedValue();
		vi.spyOn(useTopicsStore(), 'loadTopicsForClaw').mockResolvedValue();

		// 第一次 fullInit 用一个永远 pending 的 promise，稍后手动 reject
		let rejectFirst;
		checkPluginVersion.mockReturnValueOnce(new Promise((_, rej) => { rejectFirst = rej; }));
		// 第二次 fullInit 正常成功
		checkPluginVersion.mockResolvedValue({ ok: true, version: '0.6.0', clawVersion: '2026.3.14', name: null, hostName: 'test-host' });

		const fakeConn = {
			on: vi.fn(), off: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
			rtc: null, clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		// __bridgeConn 触发第一次 __fullInit（pending）
		store.addOrUpdateClaw({ id: '31', name: 'Bot', online: true });
		await Promise.resolve();
		expect(store.byId['31'].initialized).toBe(true);

		// 模拟 bot 下线再上线，触发第二次 __fullInit（通过 updateClawOnline 的 !initialized 分支）
		// 先让 initialized 回到 false 以触发重试
		store.byId['31'].initialized = false;
		store.byId['31'].online = false;
		store.updateClawOnline('31', true);
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
		const store = useClawsStore();
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

		store.setClaws([{ id: '90', name: 'Bot', online: true }]);
		expect(store.byId['90'].rtcPhase).toBe('idle');

		await store.__ensureRtc('90');

		expect(phases).toContain('building');
		expect(store.byId['90'].rtcPhase).toBe('ready');
	});

	test('__ensureRtc forceRebuild 时 rtcPhase 变为 recovering', async () => {
		const store = useClawsStore();
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

		store.setClaws([{ id: '91', name: 'Bot', online: true }]);
		store.byId['91'].rtcPhase = 'ready';

		await store.__ensureRtc('91', { forceRebuild: true });

		expect(phases).toContain('recovering');
		expect(store.byId['91'].rtcPhase).toBe('ready');
	});

	test('__ensureRtc 全部重试失败时 rtcPhase 变为 failed', async () => {
		const store = useClawsStore();
		mockInitRtc.mockResolvedValue('ws'); // 始终失败

		const fakeConn = {
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '92', name: 'Bot', online: true }]);

		await store.__ensureRtc('92');

		expect(store.byId['92'].rtcPhase).toBe('failed');
	});

	test('__ensureRtc bail-out 时 rtcPhase 变为 idle（claw 已被删除）', async () => {
		const store = useClawsStore();
		let callCount = 0;
		mockInitRtc.mockImplementation(async () => {
			callCount++;
			// 第一次调用后删除 claw，触发 bail-out
			delete store.byId['93'];
			return 'ws';
		});

		const fakeConn = {
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '93', name: 'Bot', online: true }]);

		await store.__ensureRtc('93');

		// claw 已删除，不应有残留状态断言；callCount 应为 1
		expect(callCount).toBe(1);
	});

	test('__ensureRtc 入口 gate：claw online=false 时直接 early-return，不发 offer', async () => {
		const store = useClawsStore();
		let callCount = 0;
		mockInitRtc.mockImplementation(async () => {
			callCount++;
			return 'failed';
		});

		const fakeConn = {
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: 'off1', name: 'Bot', online: false }]);
		const prevPhase = store.byId['off1'].rtcPhase;

		await store.__ensureRtc('off1');

		// offline gate：0 次 initRtc 调用，rtcPhase 不被提前切到 building/recovering
		expect(callCount).toBe(0);
		expect(store.byId['off1'].rtcPhase).toBe(prevPhase);
	});

	test('__checkAndRecover PC failed → 触发 __ensureRtc rebuild', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'failed', probe: vi.fn() };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc,
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '94', name: 'Bot', online: true }]);
		store.byId['94'].dcReady = true;
		store.byId['94'].rtcPhase = 'ready';
		mockCloseRtcForBot.mockClear();
		mockInitRtc.mockClear();

		await store.__checkAndRecover('94');
		await vi.waitFor(() => {
			expect(mockCloseRtcForBot).toHaveBeenCalledWith('94');
			expect(mockInitRtc).toHaveBeenCalled();
		});
	});

	test('__checkAndRecover probe 失败 + PC 变非 connected → triggerRestart', async () => {
		const store = useClawsStore();
		// probe 返回 false 且 PC 在 probe 期间变为 failed
		const fakeRtc = { state: 'connected', probe: vi.fn().mockImplementation(async () => {
			fakeRtc.state = 'failed';
			return false;
		}), triggerRestart: vi.fn() };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc,
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '95', name: 'ProbeBot', online: true }]);
		store.byId['95'].dcReady = true;
		store.byId['95'].rtcPhase = 'ready';
		mockCloseRtcForBot.mockClear();
		mockRemoteLog.mockClear();

		await store.__checkAndRecover('95', 'app:foreground');
		expect(fakeRtc.probe).toHaveBeenCalled();
		// store 不再同步设置 rtcPhase，由 WebRtcConnection 的 onRtcStateChange 回调驱动
		expect(store.byId['95'].rtcPhase).toBe('ready');
		expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('probe_failed');
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
		expect(mockRemoteLog).toHaveBeenCalledWith(expect.stringContaining('probe_failed'));
	});

	test('__checkAndRecover probe 失败 + PC 仍 connected → 不 rebuild', async () => {
		const store = useClawsStore();
		// probe 返回 false 但 PC 仍然 connected
		const fakeRtc = { state: 'connected', probe: vi.fn().mockResolvedValue(false) };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc,
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '97', name: 'BusyBot', online: true }]);
		store.byId['97'].dcReady = true;
		store.byId['97'].rtcPhase = 'ready';
		mockCloseRtcForBot.mockClear();
		mockRemoteLog.mockClear();

		await store.__checkAndRecover('97', 'app:foreground');
		expect(fakeRtc.probe).toHaveBeenCalled();
		// PC 仍 connected → 不 rebuild
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
		expect(store.byId['97'].rtcPhase).toBe('ready');
		expect(mockRemoteLog).toHaveBeenCalledWith(expect.stringContaining('probe_timeout_pc_connected'));
	});

	test('__checkAndRecover 异常时 catch 不抛出', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'connected', probe: vi.fn().mockRejectedValue(new Error('probe boom')) };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc,
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '96', name: 'ErrBot', online: true }]);
		store.byId['96'].dcReady = true;
		store.byId['96'].rtcPhase = 'ready';

		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await store.__checkAndRecover('96', 'app:foreground');
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining('checkAndRecover failed'),
			'96',
			'probe boom',
		);
		warnSpy.mockRestore();
	});

	test('__checkAndRecover probe 失败 + PC 变 closed → triggerRestart', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'connected', probe: vi.fn().mockImplementation(async () => {
			fakeRtc.state = 'closed';
			return false;
		}), triggerRestart: vi.fn() };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc,
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '99', name: 'ClosedBot', online: true }]);
		store.byId['99'].dcReady = true;
		store.byId['99'].rtcPhase = 'ready';
		mockCloseRtcForBot.mockClear();

		await store.__checkAndRecover('99');
		// store 不再同步设置 rtcPhase，由 WebRtcConnection 的 onRtcStateChange 回调驱动
		expect(store.byId['99'].rtcPhase).toBe('ready');
		expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('probe_failed');
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
	});

	test('__checkAndRecover probe 成功 → 不修改任何状态', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'connected', probe: vi.fn().mockResolvedValue(true) };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc,
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '102', name: 'HealthyBot', online: true }]);
		store.byId['102'].dcReady = true;
		store.byId['102'].rtcPhase = 'ready';
		mockCloseRtcForBot.mockClear();

		await store.__checkAndRecover('102');
		expect(store.byId['102'].rtcPhase).toBe('ready');
		expect(store.byId['102'].dcReady).toBe(true);
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
	});

	test('__checkAndRecover probe 期间 claw 被移除 → 不 rebuild', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'connected', probe: vi.fn().mockImplementation(async () => {
			// probe 期间 claw 被移除
			delete store.byId['103'];
			return false;
		}) };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc,
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '103', name: 'GoneBot', online: true }]);
		store.byId['103'].dcReady = true;
		mockCloseRtcForBot.mockClear();

		await store.__checkAndRecover('103');
		// claw 已不存在 → 不应尝试 rebuild
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
	});

	test('__checkAndRecover probe 失败 + conn.rtc 被置 null → 不 rebuild', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'connected', probe: vi.fn().mockResolvedValue(false) };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc,
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '104', name: 'NullBot', online: true }]);
		store.byId['104'].dcReady = true;
		mockCloseRtcForBot.mockClear();
		mockRemoteLog.mockClear();

		// probe 返回后 rtc 被外部置 null
		fakeRtc.probe.mockImplementation(async () => {
			fakeConn.rtc = null;
			return false;
		});

		await store.__checkAndRecover('104');
		// rtcAfter 为 null → 视为 PC 不可用 → rebuild
		expect(mockRemoteLog).toHaveBeenCalledWith(expect.stringContaining('probe_failed pc=null'));
	});

	test('__checkAndRecover 不存在的 clawId → 无操作', async () => {
		const store = useClawsStore();
		mockCloseRtcForBot.mockClear();
		// 不应抛出
		await store.__checkAndRecover('nonexistent');
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
	});

	test('__checkAndRecover conn 不存在 → 无操作', async () => {
		const store = useClawsStore();
		mockManager.get.mockReturnValue(null);
		store.setClaws([{ id: '105', name: 'NoConnBot', online: true }]);
		store.byId['105'].dcReady = true;
		mockCloseRtcForBot.mockClear();

		await store.__checkAndRecover('105');
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
	});

	test('__checkAndRecover _probeInProgress 防护：并发 probe 被跳过', async () => {
		const store = useClawsStore();
		let probeResolve;
		const fakeRtc = {
			state: 'connected',
			probe: vi.fn().mockImplementation(() => new Promise((r) => { probeResolve = r; })),
		};
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc,
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '106', name: 'ConcBot', online: true }]);
		store.byId['106'].dcReady = true;
		mockCloseRtcForBot.mockClear();

		// 第一次调用：进入 probe 等待
		const p1 = store.__checkAndRecover('106');
		await Promise.resolve();
		expect(fakeRtc.probe).toHaveBeenCalledTimes(1);

		// 第二次调用：_probeInProgress 应阻止
		const p2 = store.__checkAndRecover('106');
		await Promise.resolve();
		expect(fakeRtc.probe).toHaveBeenCalledTimes(1); // 仍然只调用了一次

		// 完成第一次 probe
		probeResolve(true);
		await p1;
		await p2;

		// probe 完成后 _probeInProgress 已清除，可以再次 probe
		store.__checkAndRecover('106');
		await Promise.resolve();
		expect(fakeRtc.probe).toHaveBeenCalledTimes(2);
	});

	test('__checkAndRecover probe 抛异常时 _probeInProgress 仍被清除', async () => {
		const store = useClawsStore();
		const fakeRtc = {
			state: 'connected',
			probe: vi.fn().mockRejectedValue(new Error('probe crash')),
		};
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc,
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '107', name: 'CrashBot', online: true }]);
		store.byId['107'].dcReady = true;

		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await store.__checkAndRecover('107');
		warnSpy.mockRestore();

		// _probeInProgress 应被 finally 清除 → 下次 probe 可以进入
		fakeRtc.probe.mockResolvedValue(true);
		await store.__checkAndRecover('107');
		expect(fakeRtc.probe).toHaveBeenCalledTimes(2);
	});
});

describe('ICE restart store 交互', () => {
	test('__rtcCallbacks: restarting 设置 rtcPhase 和 disconnectedAt', () => {
		const store = useClawsStore();
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);
		store.byId['1'].rtcPhase = 'ready';
		store.byId['1'].disconnectedAt = 0;

		const cbs = store.__rtcCallbacks('1');
		cbs.onRtcStateChange('restarting', null);

		expect(store.byId['1'].rtcPhase).toBe('restarting');
		expect(store.byId['1'].disconnectedAt).toBeGreaterThan(0);
	});

	test('__rtcCallbacks: restarting 保留已有 disconnectedAt', () => {
		const store = useClawsStore();
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);
		store.byId['1'].disconnectedAt = 12345;

		const cbs = store.__rtcCallbacks('1');
		cbs.onRtcStateChange('restarting', null);

		// 已有值不被覆盖
		expect(store.byId['1'].disconnectedAt).toBe(12345);
	});

	test('__handleNetworkOnline: restarting → nudgeRestart', async () => {
		const store = useClawsStore();
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);
		store.byId['1'].initialized = true;

		const fakeRtc = { state: 'restarting', nudgeRestart: vi.fn(), probe: vi.fn() };
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.__handleNetworkOnline(true);

		expect(fakeRtc.nudgeRestart).toHaveBeenCalledTimes(1);
		// 不应触发 rebuild
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
	});

	test('__handleNetworkOnline: claw offline + restarting → 被 gate 挡住，不 nudgeRestart', async () => {
		const store = useClawsStore();
		store.applySnapshot([{ id: 'off2', name: 'B', online: false }]);
		store.byId['off2'].initialized = true;

		const fakeRtc = { state: 'restarting', nudgeRestart: vi.fn(), probe: vi.fn() };
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.__handleNetworkOnline(true);

		// offline 被 gate 挡住：不 nudge、不 trigger；恢复交给 online→true 的 __resumeOnline
		expect(fakeRtc.nudgeRestart).not.toHaveBeenCalled();
	});

	test('__handleNetworkOnline: claw offline + connected + typeChanged → 被 gate 挡住，不 triggerRestart', async () => {
		const store = useClawsStore();
		store.applySnapshot([{ id: 'off3', name: 'C', online: false }]);
		store.byId['off3'].initialized = true;

		const fakeRtc = { state: 'connected', triggerRestart: vi.fn(), nudgeRestart: vi.fn(), probe: vi.fn() };
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.__handleNetworkOnline(true);

		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
	});

	test('__handleNetworkOnline: claw offline + PC failed → 被 gate 挡住，不 rebuild', async () => {
		const store = useClawsStore();
		store.applySnapshot([{ id: 'off4', name: 'D', online: false }]);
		store.byId['off4'].initialized = true;

		const fakeRtc = { state: 'failed', nudgeRestart: vi.fn(), triggerRestart: vi.fn(), probe: vi.fn() };
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);
		mockInitRtc.mockClear();
		mockInitRtc.mockResolvedValue('failed');
		mockCloseRtcForBot.mockClear();

		store.__handleNetworkOnline(false);
		await Promise.resolve();
		await Promise.resolve();

		// offline gate 挡住：不 rebuild、不 triggerRestart
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
		expect(mockInitRtc).not.toHaveBeenCalled();
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
	});

	test('__checkAndRecover: restarting → nudgeRestart', async () => {
		const store = useClawsStore();
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);
		store.byId['1'].dcReady = true;

		const fakeRtc = { state: 'restarting', nudgeRestart: vi.fn(), probe: vi.fn() };
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		await store.__checkAndRecover('1', 'app:foreground');

		expect(fakeRtc.nudgeRestart).toHaveBeenCalledTimes(1);
		expect(fakeRtc.probe).not.toHaveBeenCalled();
	});
});

describe('dcReady 响应式标记', () => {
	test('createClawState 初始 dcReady 为 false', () => {
		const store = useClawsStore();
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);
		expect(store.byId['1'].dcReady).toBe(false);
	});

	test('createClawState 初始 retryCount / retryNextAt 为 0', () => {
		const store = useClawsStore();
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);
		expect(store.byId['1'].retryCount).toBe(0);
		expect(store.byId['1'].retryNextAt).toBe(0);
	});

	test('__rtcCallbacks: failed/closed 时 dcReady 置为 false，设置 disconnectedAt 和 rtcPhase', () => {
		const store = useClawsStore();
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

	test('__rtcCallbacks: failed/closed 时清空 rtcPeerTransportInfo（新连接会重新推送）', () => {
		const store = useClawsStore();
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);
		store.byId['1'].rtcPeerTransportInfo = { candidateType: 'relay', protocol: 'udp', relayProtocol: 'tcp' };

		const cbs = store.__rtcCallbacks('1');
		cbs.onRtcStateChange('failed', null);
		expect(store.byId['1'].rtcPeerTransportInfo).toBe(null);

		// 重新赋值，closed 路径也清空
		store.byId['1'].rtcPeerTransportInfo = { candidateType: 'relay', protocol: 'udp', relayProtocol: 'tcp' };
		cbs.onRtcStateChange('closed', null);
		expect(store.byId['1'].rtcPeerTransportInfo).toBe(null);
	});

	test('__rtcCallbacks: connected + dcReady 已为 true → rtcPhase 恢复 ready，disconnectedAt 清 0（wasDisconnected=false 分支兜底清 stamp）', () => {
		const store = useClawsStore();
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);
		store.byId['1'].dcReady = true;
		store.byId['1'].rtcPhase = 'restarting'; // ICE restart 后 connected
		// 模拟上一次 onRtcStateChange('restarting') stamp 的 disconnectedAt
		store.byId['1'].disconnectedAt = Date.now() - 5_000;

		const fakeConn = { rtc: { isReady: true } };
		mockManager.get.mockReturnValue(fakeConn);

		const cbs = store.__rtcCallbacks('1');
		cbs.onRtcStateChange('connected', null);
		// 无条件恢复 rtcPhase（ICE restart 成功后 dcReady 仍为 true）
		expect(store.byId['1'].dcReady).toBe(true);
		expect(store.byId['1'].rtcPhase).toBe('ready');
		// 修 pre-existing 漏洞：即使 wasDisconnected=false 也清 disconnectedAt，
		// 防止多次 restart 间累积最旧 stamp，污染后续 gap 判断
		expect(store.byId['1'].disconnectedAt).toBe(0);
	});

	test('__rtcCallbacks: connected + !dcReady + rtc.isReady → 被动恢复设置 dcReady 和 rtcPhase', () => {
		const store = useClawsStore();
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
		const store = useClawsStore();
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);
		store.byId['1'].dcReady = false;

		const fakeConn = { rtc: { isReady: false } };
		mockManager.get.mockReturnValue(fakeConn);

		const cbs = store.__rtcCallbacks('1');
		cbs.onRtcStateChange('connected', null);
		expect(store.byId['1'].dcReady).toBe(false);
	});

	test('__rtcCallbacks: 被动恢复触发 __refreshIfStale', () => {
		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadSessionsForClaw').mockResolvedValue();

		store.applySnapshot([{ id: '1', name: 'A', online: true }]);
		store.byId['1'].initialized = true;
		store.byId['1'].dcReady = false;
		store.byId['1'].disconnectedAt = Date.now() - 35_000; // 长间隔

		const fakeConn = { rtc: { isReady: true }, request: vi.fn().mockResolvedValue({}) };
		mockManager.get.mockReturnValue(fakeConn);

		const cbs = store.__rtcCallbacks('1');
		cbs.onRtcStateChange('connected', null);
		expect(store.byId['1'].dcReady).toBe(true);
		expect(agentsStore.loadAgents).toHaveBeenCalledWith('1');
		expect(sessionsStore.loadSessionsForClaw).toHaveBeenCalledWith('1');
		expect(store.byId['1'].disconnectedAt).toBe(0);
	});

	test('__rtcCallbacks: transportInfo 存储', () => {
		const store = useClawsStore();
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);

		const cbs = store.__rtcCallbacks('1');
		const info = { localType: 'relay', localProtocol: 'udp', remoteType: 'host', remoteProtocol: 'udp', relayProtocol: 'tcp' };
		cbs.onRtcStateChange('connected', info);
		expect(store.byId['1'].rtcTransportInfo).toEqual(info);
	});

	test('__rtcCallbacks: bot 已移除时安全跳过', () => {
		const store = useClawsStore();
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
		useClawsStore();
		expect(getReadyConn('999')).toBeNull();
	});

	test('dcReady=false 时返回 null', () => {
		const store = useClawsStore();
		store.byId['1'] = { id: '1', dcReady: false };
		expect(getReadyConn('1')).toBeNull();
	});

	test('dcReady=true 且 conn 存在时返回 conn', () => {
		const store = useClawsStore();
		store.byId['1'] = { id: '1', dcReady: true };
		const fakeConn = { request: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);
		expect(getReadyConn('1')).toBe(fakeConn);
	});

	test('dcReady=true 但 conn 不存在时返回 null', () => {
		const store = useClawsStore();
		store.byId['1'] = { id: '1', dcReady: true };
		mockManager.get.mockReturnValue(undefined);
		expect(getReadyConn('1')).toBeNull();
	});

	test('clawId 归一化为 string', () => {
		const store = useClawsStore();
		store.byId['42'] = { id: '42', dcReady: true };
		const fakeConn = { request: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);
		expect(getReadyConn(42)).toBe(fakeConn);
	});
});

describe('运行时字段防御', () => {
	test('server snapshot 含运行时字段同名属性时不覆盖运行时状态（online 未变）', () => {
		const store = useClawsStore();
		const fakeConn = { on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(), rtc: null, request: vi.fn().mockResolvedValue({}) };
		mockManager.get.mockReturnValue(fakeConn);

		// 首次快照建立 bot
		store.applySnapshot([{ id: '1', name: 'Bot', online: true }]);
		const bot = store.byId['1'];
		bot.dcReady = true;
		bot.rtcPhase = 'ready';
		bot.initialized = true;
		bot.pluginVersionOk = true;
		bot.pluginInfo = { version: '1.0' };
		bot.rtcTransportInfo = { localType: 'host' };
		bot.lastAliveAt = 12345;
		bot.disconnectedAt = 999;

		// 第二次快照：保持 online=true（避免触发 Phase 3 online-transition 副作用），
		// 但 payload 含运行时字段同名属性——这些应被 RUNTIME_FIELDS 保护、不覆盖
		store.applySnapshot([{
			id: '1', name: 'BotRenamed', online: true,
			dcReady: false, rtcPhase: 'idle', initialized: false,
			pluginVersionOk: null, pluginInfo: null, rtcTransportInfo: null,
			lastAliveAt: 0, disconnectedAt: 0,
		}]);

		const updated = store.byId['1'];
		// server 非运行时字段应更新
		expect(updated.name).toBe('BotRenamed');
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

	test('addOrUpdateClaw 不覆盖运行时字段', () => {
		const store = useClawsStore();
		const fakeConn = { on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(), rtc: null, request: vi.fn().mockResolvedValue({}) };
		mockManager.get.mockReturnValue(fakeConn);

		// 建立 bot
		store.addOrUpdateClaw({ id: '2', name: 'Bot', online: false });
		const bot = store.byId['2'];
		bot.dcReady = true;
		bot.rtcPhase = 'ready';
		bot.initialized = true;

		// 更新时意外包含运行时字段
		store.addOrUpdateClaw({ id: '2', name: 'Renamed', dcReady: false, rtcPhase: 'idle', initialized: false });

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
		store.setClaws([{ id, name: 'Bot', online: true }]);
		store.byId[id].rtcPhase = 'failed';
		store.byId[id].initialized = true;
		return fakeConn;
	}

	test('__ensureRtc 失败后安排退避 timer', async () => {
		const store = useClawsStore();
		mockInitRtc.mockResolvedValue('failed');
		const fakeConn = { rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '50', name: 'Bot', online: false });
		store.byId['50'].online = true;
		store.byId['50'].initialized = true;

		await store.__ensureRtc('50');

		expect(store.byId['50'].rtcPhase).toBe('failed');
		// retryCount / retryNextAt 应被写入
		expect(store.byId['50'].retryCount).toBe(1);
		expect(store.byId['50'].retryNextAt).toBeGreaterThan(0);
		// scheduleRetry 被调用 → timer 触发后 __ensureRtc 应被调用
		mockInitRtc.mockClear();
		mockInitRtc.mockResolvedValue('failed');
		vi.advanceTimersByTime(3_000);
		await Promise.resolve(); // 让 timer callback 执行
		await Promise.resolve(); // 让 __ensureRtc 内的 await 链完成
		expect(mockInitRtc).toHaveBeenCalled();
	});

	test('退避 timer 触发后重新调用 __ensureRtc', async () => {
		const store = useClawsStore();
		const fakeConn = { rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '50', name: 'Bot', online: false });
		store.byId['50'].online = true;
		store.byId['50'].initialized = true;
		store.byId['50'].rtcPhase = 'failed';

		store.__scheduleRetry('50');
		mockInitRtc.mockClear();
		mockInitRtc.mockResolvedValue('failed');

		vi.advanceTimersByTime(3_000);
		await Promise.resolve();
		await Promise.resolve();
		expect(mockInitRtc).toHaveBeenCalled();
	});

	test('连续失败时退避延迟指数增长', () => {
		const store = useClawsStore();
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

		// 延迟序列：3s, 6s, 12s, 24s, 48s
		expect(delays).toEqual([3_000, 6_000, 12_000, 24_000, 48_000]);
	});

	test('__ensureRtc 成功时清除退避状态', async () => {
		const store = useClawsStore();
		const fakeConn = { rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '50', name: 'Bot', online: false });
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

	test('updateClawOnline(false) 清退避 retry 状态（offline 恢复动作按下暂停）', () => {
		const store = useClawsStore();
		setupFailedBot(store);
		store.__scheduleRetry('50');
		expect(store.byId['50'].retryCount).toBeGreaterThan(0);

		store.updateClawOnline('50', false);

		// __handleClawGoOffline 会 __clearRetry：count 和 nextAt 归 0，timer 停
		expect(store.byId['50'].retryCount).toBe(0);
		expect(store.byId['50'].retryNextAt).toBe(0);
	});

	test('removeClawById 清除退避', () => {
		const store = useClawsStore();
		setupFailedBot(store);
		store.__scheduleRetry('50');

		store.removeClawById('50');

		mockInitRtc.mockClear();
		vi.advanceTimersByTime(300_000);
		expect(mockInitRtc).not.toHaveBeenCalled();
	});

	test('__scheduleRetry 在 claw 已删后早退（防 __ensureRtc async race）', () => {
		// race 场景：__ensureRtc 内部 await 期间，removeClawById 并发删除 claw；
		// 随后 __ensureRtc finally 调 __scheduleRetry 时 byId 已无此 claw
		const store = useClawsStore();
		setupFailedBot(store);
		store.removeClawById('50');

		// 删除后再调 __scheduleRetry 应静默早退，不抛、不新建 retry state
		expect(() => store.__scheduleRetry('50')).not.toThrow();

		// timer 不应被排上
		mockInitRtc.mockClear();
		vi.advanceTimersByTime(300_000);
		expect(mockInitRtc).not.toHaveBeenCalled();
	});

	test('外部事件（applySnapshot）重置退避计数', () => {
		const store = useClawsStore();
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
		// 应回到初始延迟 3s
		expect(delays[0]).toBe(3_000);
	});

	test('最大次数（8）耗尽后不再安排', () => {
		const store = useClawsStore();
		setupFailedBot(store);

		for (let i = 0; i < 8; i++) {
			store.__scheduleRetry('50');
		}

		// 第 9 次不应安排
		const _timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
		store.__scheduleRetry('50');
		// setTimeout 可能被 vitest 内部调用，检查 mockInitRtc
		vi.restoreAllMocks();

		mockInitRtc.mockClear();
		vi.advanceTimersByTime(600_000);
		// 上面最后的 scheduleRetry（第 9 次）不应调度 __ensureRtc
		// 但前 8 次有 timer 可能在此期间触发；由于 count 已达上限，最后不再调度
	});

	test('被动失败（__rtcCallbacks）+ 非 _rtcInitInProgress 启动退避', async () => {
		const store = useClawsStore();
		const fakeConn = { rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '50', name: 'Bot', online: false });
		store.byId['50'].online = true;
		store.byId['50'].initialized = true;

		// 获取 __rtcCallbacks 并模拟被动失败
		const cbs = store.__rtcCallbacks('50');
		cbs.onRtcStateChange('failed', null);

		expect(store.byId['50'].rtcPhase).toBe('failed');
		mockInitRtc.mockClear();
		mockInitRtc.mockResolvedValue('failed');
		vi.advanceTimersByTime(3_000);
		await Promise.resolve();
		await Promise.resolve();
		expect(mockInitRtc).toHaveBeenCalled();
	});

	test('_rtcInitInProgress 时 __rtcCallbacks 不启动退避', async () => {
		const store = useClawsStore();
		const fakeConn = { rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '50', name: 'Bot', online: false });
		store.byId['50'].online = true;
		store.byId['50'].initialized = true;

		const scheduleSpy = vi.spyOn(store, '__scheduleRetry');

		// 使 __ensureRtc 进入但第一次 initRtc 不立即完成
		let resolveFirst;
		let callIdx = 0;
		mockInitRtc.mockImplementation(() => {
			callIdx++;
			if (callIdx === 1) return new Promise((r) => { resolveFirst = r; });
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
		const store = useClawsStore();
		setupFailedBot(store);
		store.__scheduleRetry('50');

		// 在 timer 触发前恢复 bot
		store.byId['50'].rtcPhase = 'ready';

		mockInitRtc.mockClear();
		vi.advanceTimersByTime(3_000);
		// __ensureRtc 不应被调用
		expect(mockInitRtc).not.toHaveBeenCalled();
	});

	test('__scheduleRetry 写入 retryCount / retryNextAt', () => {
		const store = useClawsStore();
		setupFailedBot(store);

		const before = Date.now();
		store.__scheduleRetry('50');
		expect(store.byId['50'].retryCount).toBe(1);
		expect(store.byId['50'].retryNextAt).toBeGreaterThanOrEqual(before + 3_000);

		store.__scheduleRetry('50');
		expect(store.byId['50'].retryCount).toBe(2);
		expect(store.byId['50'].retryNextAt).toBeGreaterThanOrEqual(before + 6_000);
	});

	test('__clearRetry 重置 retryCount / retryNextAt', () => {
		const store = useClawsStore();
		setupFailedBot(store);
		store.__scheduleRetry('50');
		expect(store.byId['50'].retryCount).toBe(1);

		store.__clearRetry('50');
		expect(store.byId['50'].retryCount).toBe(0);
		expect(store.byId['50'].retryNextAt).toBe(0);
	});

	test('重试耗尽后 retryCount 归零', () => {
		const store = useClawsStore();
		setupFailedBot(store);

		for (let i = 0; i < 6; i++) {
			store.__scheduleRetry('50');
		}
		// 第 6 次超出 MAX_BACKOFF_RETRIES(5)，应归零
		expect(store.byId['50'].retryCount).toBe(0);
		expect(store.byId['50'].retryNextAt).toBe(0);
	});

	test('timer 触发时 claw 已被删除 → 清理退出', () => {
		const store = useClawsStore();
		setupFailedBot(store);
		store.__scheduleRetry('50');

		delete store.byId['50'];

		mockInitRtc.mockClear();
		vi.advanceTimersByTime(3_000);
		expect(mockInitRtc).not.toHaveBeenCalled();
	});

	test('__scheduleRetry 入口 gate：claw offline 时不排队退避', async () => {
		const store = useClawsStore();
		setupFailedBot(store);
		store.byId['50'].online = false;

		store.__scheduleRetry('50');

		// offline → 不排 timer、不写字段
		expect(store.byId['50'].retryCount).toBe(0);
		expect(store.byId['50'].retryNextAt).toBe(0);
		// 就算时间推进也不会调 __ensureRtc
		mockInitRtc.mockClear();
		vi.advanceTimersByTime(300_000);
		await Promise.resolve();
		expect(mockInitRtc).not.toHaveBeenCalled();
	});

	test('退避序列完整验证（含 cap 到 RETRY_BACKOFF_MAX_MS）', () => {
		const store = useClawsStore();
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

		// 3s, 6s, 12s, 24s, 48s
		expect(delays).toEqual([3_000, 6_000, 12_000, 24_000, 48_000]);
	});

	test('clearRetry 后旧 timer callback 不再执行', () => {
		const store = useClawsStore();
		setupFailedBot(store);

		store.__scheduleRetry('50');
		expect(store.byId['50'].retryCount).toBe(1);

		store.__clearRetry('50');
		expect(store.byId['50'].retryCount).toBe(0);
		expect(store.byId['50'].retryNextAt).toBe(0);

		// 推进时间使旧 timer 本应到期
		mockInitRtc.mockClear();
		vi.advanceTimersByTime(3_000);

		// initRtc 不应被调用，退避状态仍为清空
		expect(mockInitRtc).not.toHaveBeenCalled();
		expect(store.byId['50'].retryCount).toBe(0);
		expect(store.byId['50'].retryNextAt).toBe(0);
	});
});

describe('remoteLog 诊断日志', () => {
	test('bot online→offline 记录 remoteLog', () => {
		const store = useClawsStore();
		store.setClaws([{ id: '1', online: true }]);
		mockRemoteLog.mockClear();

		store.updateClawOnline('1', false);
		expect(mockRemoteLog).toHaveBeenCalledWith('claw.online true→false claw=1');
	});

	test('applySnapshot 记录 remoteLog', () => {
		const store = useClawsStore();
		mockRemoteLog.mockClear();

		store.applySnapshot([{ id: '1', online: false }]);
		expect(mockRemoteLog).toHaveBeenCalledWith('claw.snapshot count=1');
	});

	test('__ensureRtc 成功记录 bot.rtcReady', async () => {
		const store = useClawsStore();
		const conn = { on: vi.fn(), rtc: null, clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(conn);
		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;
		mockRemoteLog.mockClear();

		mockInitRtc.mockImplementation(async (_id, c) => { c.rtc = __fakeRtc; return 'rtc'; });
		await store.__ensureRtc('1');
		expect(mockRemoteLog).toHaveBeenCalledWith('claw.rtcReady claw=1');
	});

	test('__ensureRtc 失败记录 bot.rtcFailed', async () => {
		const store = useClawsStore();
		const conn = { on: vi.fn(), rtc: null, clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(conn);
		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;
		mockRemoteLog.mockClear();

		mockInitRtc.mockResolvedValue('failed');
		await store.__ensureRtc('1');
		expect(mockRemoteLog).toHaveBeenCalledWith(expect.stringContaining('claw.rtcFailed claw=1'));
	});

	test('removeClawById 记录 bot.removed', () => {
		const store = useClawsStore();
		store.setClaws([{ id: '1' }]);
		mockRemoteLog.mockClear();

		store.removeClawById('1');
		expect(mockRemoteLog).toHaveBeenCalledWith('claw.removed claw=1');
	});

	test('addOrUpdateClaw 记录 bot.upsert', () => {
		const store = useClawsStore();
		const conn = { on: vi.fn(), rtc: null, clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(conn);
		mockRemoteLog.mockClear();

		store.addOrUpdateClaw({ id: '5', name: 'New' });
		expect(mockRemoteLog).toHaveBeenCalledWith('claw.upsert claw=5');
	});

	test('__scheduleRetry 记录 bot.retryScheduled', () => {
		const store = useClawsStore();
		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].rtcPhase = 'failed';
		mockRemoteLog.mockClear();

		store.__scheduleRetry('1');
		expect(mockRemoteLog).toHaveBeenCalledWith(expect.stringContaining('claw.retryScheduled claw=1'));
	});
});

describe('__fullInit 插件版本检查分支', () => {
	test('pluginVersionOk=false + version 存在 → warn 但继续初始化', async () => {
		const { checkPluginVersion } = await import('../utils/plugin-version.js');
		checkPluginVersion.mockResolvedValue({ ok: false, version: '0.3.0', clawVersion: '2026.1.1', name: null, hostName: 'h' });

		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadSessionsForClaw').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadTopicsForClaw').mockResolvedValue();

		const fakeConn = {
			on: vi.fn(), off: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
			rtc: null, clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		store.addOrUpdateClaw({ id: '90', name: 'Outdated', online: true });

		await vi.waitFor(() => {
			expect(store.byId['90'].pluginVersionOk).toBe(false);
		});
		// warn 第二个参数为 'outdated'
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining('plugin version'),
			'outdated',
			'90',
		);
		// 初始化应继续完成（initClawResources 被调用）
		expect(agentsStore.loadAgents).toHaveBeenCalledWith('90');
		warnSpy.mockRestore();
		checkPluginVersion.mockResolvedValue({ ok: true, version: '0.6.0', clawVersion: '2026.3.14', name: null, hostName: 'test-host' });
	});

	test('pluginVersionOk=false + version 为空 → 抛出异常，initialized 重置', async () => {
		const { checkPluginVersion } = await import('../utils/plugin-version.js');
		checkPluginVersion.mockResolvedValue({ ok: false, version: null, clawVersion: null, name: null, hostName: null });

		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();

		const fakeConn = {
			on: vi.fn(), off: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
			rtc: null, clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		store.addOrUpdateClaw({ id: '91', name: 'Offline', online: true });

		await vi.waitFor(() => {
			expect(store.byId['91'].initialized).toBe(false);
		});
		// warn 第二个参数为 'check failed (bot may be offline)'
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining('plugin version'),
			'check failed (claw may be offline)',
			'91',
		);
		// initClawResources 不应被调用（抛异常退出）
		expect(agentsStore.loadAgents).not.toHaveBeenCalled();
		warnSpy.mockRestore();
		checkPluginVersion.mockResolvedValue({ ok: true, version: '0.6.0', clawVersion: '2026.3.14', name: null, hostName: 'test-host' });
	});
});

describe('__refreshIfStale pluginInfo 刷新', () => {
	test('断连后 __refreshIfStale 触发 checkPluginVersion 更新 pluginInfo', async () => {
		const { checkPluginVersion } = await import('../utils/plugin-version.js');
		checkPluginVersion.mockResolvedValue({ ok: true, version: '0.7.0', clawVersion: '2026.4.1', name: 'MyClaw', hostName: 'my-host' });

		const store = useClawsStore();
		const fakeConn = { on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '95', name: 'Bot', online: true }]);
		store.byId['95'].initialized = true;
		store.byId['95'].disconnectedAt = Date.now() - 35_000;

		store.__refreshIfStale('95');

		// 等待 checkPluginVersion promise resolve
		await vi.waitFor(() => {
			expect(store.byId['95'].pluginVersionOk).toBe(true);
			expect(store.byId['95'].pluginInfo.version).toBe('0.7.0');
			expect(store.byId['95'].pluginInfo.name).toBe('MyClaw');
			expect(store.byId['95'].pluginInfo.hostName).toBe('my-host');
		});
	});

	test('__refreshIfStale checkPluginVersion 失败时不抛异常', async () => {
		const { checkPluginVersion } = await import('../utils/plugin-version.js');
		checkPluginVersion.mockRejectedValue(new Error('network error'));

		const store = useClawsStore();
		const fakeConn = { on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '96', name: 'Bot', online: true }]);
		store.byId['96'].initialized = true;
		store.byId['96'].disconnectedAt = Date.now() - 35_000;

		// 不应抛出异常
		expect(() => store.__refreshIfStale('96')).not.toThrow();
		// 等待 promise rejection 被 catch
		await new Promise((r) => setTimeout(r, 50));
	});
});

describe('isConnectingRtc / unreachableClaws getters', () => {
	// 用 setClaws 走完整 createClawState 流程，再调整运行时字段
	// 避免手写 byId 绕过 shape 校验（日后若 getter 新增字段依赖可抓住假阳性）
	function seed(store, entries) {
		store.setClaws(entries.map((e) => ({ id: e.id, name: e.id, online: e.online ?? false })));
		for (const e of entries) {
			const claw = store.byId[e.id];
			claw.rtcPhase = e.rtcPhase ?? 'idle';
			claw.retryNextAt = e.retryNextAt ?? 0;
		}
	}

	test('无 claw 时 isConnectingRtc=false, unreachableClaws=[]', () => {
		const store = useClawsStore();
		expect(store.isConnectingRtc).toBe(false);
		expect(store.unreachableClaws).toEqual([]);
	});

	test('building / recovering / restarting 的 online claw 触发 isConnectingRtc', () => {
		for (const phase of ['building', 'recovering', 'restarting']) {
			setActivePinia(createPinia());
			const store = useClawsStore();
			seed(store, [{ id: 'b1', online: true, rtcPhase: phase }]);
			expect(store.isConnectingRtc).toBe(true);
		}
	});

	test('failed + retryNextAt>0 的 online claw 触发 isConnectingRtc（排着退避）', () => {
		const store = useClawsStore();
		seed(store, [{ id: 'b1', online: true, rtcPhase: 'failed', retryNextAt: Date.now() + 5_000 }]);
		expect(store.isConnectingRtc).toBe(true);
	});

	test('failed + retryNextAt=0 的 online claw 不触发 isConnectingRtc（退避耗尽）', () => {
		const store = useClawsStore();
		seed(store, [{ id: 'b1', online: true, rtcPhase: 'failed', retryNextAt: 0 }]);
		expect(store.isConnectingRtc).toBe(false);
	});

	test('offline claw 即使 rtcPhase=building 也不触发 isConnectingRtc', () => {
		const store = useClawsStore();
		seed(store, [{ id: 'b1', online: false, rtcPhase: 'building' }]);
		expect(store.isConnectingRtc).toBe(false);
	});

	test('ready 的 online claw 不触发 isConnectingRtc', () => {
		const store = useClawsStore();
		seed(store, [{ id: 'b1', online: true, rtcPhase: 'ready' }]);
		expect(store.isConnectingRtc).toBe(false);
	});

	test('unreachableClaws 只含 online && failed && retryNextAt=0 的 claw', () => {
		const store = useClawsStore();
		seed(store, [
			{ id: 'ok', online: true, rtcPhase: 'ready' },
			{ id: 'building', online: true, rtcPhase: 'building' },
			{ id: 'retrying', online: true, rtcPhase: 'failed', retryNextAt: Date.now() + 1000 },
			{ id: 'exhausted', online: true, rtcPhase: 'failed', retryNextAt: 0 },
			{ id: 'offline-failed', online: false, rtcPhase: 'failed', retryNextAt: 0 },
		]);
		expect(store.unreachableClaws.map((c) => c.id)).toEqual(['exhausted']);
	});
});

describe('manualRetryUnreachable', () => {
	test('过滤 online=false 的 claw，只对不可达 online claw 发起重试', async () => {
		const store = useClawsStore();
		const fakeConn = { rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: 'online-bad', name: 'A', online: true });
		store.addOrUpdateClaw({ id: 'offline-bad', name: 'B', online: false });
		store.byId['online-bad'].initialized = true;
		store.byId['online-bad'].rtcPhase = 'failed';
		store.byId['online-bad'].retryNextAt = 0;
		store.byId['offline-bad'].initialized = true;
		store.byId['offline-bad'].rtcPhase = 'failed';
		store.byId['offline-bad'].retryNextAt = 0;

		const ensureSpy = vi.spyOn(store, '__ensureRtc').mockResolvedValue();
		store.manualRetryUnreachable();

		expect(ensureSpy).toHaveBeenCalledTimes(1);
		expect(ensureSpy).toHaveBeenCalledWith('online-bad');
	});

	test('对仍排着退避的 failed claw 不触发（避免打断系统节奏）', () => {
		const store = useClawsStore();
		const fakeConn = { rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: 'waiting', name: 'A', online: true });
		store.byId['waiting'].initialized = true;
		store.byId['waiting'].rtcPhase = 'failed';
		store.byId['waiting'].retryNextAt = Date.now() + 10_000;

		const ensureSpy = vi.spyOn(store, '__ensureRtc').mockResolvedValue();
		store.manualRetryUnreachable();

		expect(ensureSpy).not.toHaveBeenCalled();
	});

	test('清除退避状态后调用 __ensureRtc', () => {
		const store = useClawsStore();
		const fakeConn = { rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: 'bad', name: 'A', online: true });
		store.byId['bad'].initialized = true;
		store.byId['bad'].rtcPhase = 'failed';
		store.byId['bad'].retryCount = 3;
		store.byId['bad'].retryNextAt = 0;

		const clearSpy = vi.spyOn(store, '__clearRetry');
		const ensureSpy = vi.spyOn(store, '__ensureRtc').mockResolvedValue();

		store.manualRetryUnreachable();

		expect(clearSpy).toHaveBeenCalledWith('bad');
		expect(ensureSpy).toHaveBeenCalledWith('bad');
		// 调用顺序：先清退避再建连
		expect(clearSpy.mock.invocationCallOrder[0])
			.toBeLessThan(ensureSpy.mock.invocationCallOrder[0]);
	});

	test('没有目标 claw 时静默返回，不调 __ensureRtc', () => {
		const store = useClawsStore();
		const fakeConn = { rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: 'healthy', name: 'A', online: true });
		store.byId['healthy'].rtcPhase = 'ready';

		const ensureSpy = vi.spyOn(store, '__ensureRtc').mockResolvedValue();
		store.manualRetryUnreachable();

		expect(ensureSpy).not.toHaveBeenCalled();
	});

	test('多个目标：全部发起重试', () => {
		const store = useClawsStore();
		const fakeConn = { rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: 'a', name: 'A', online: true });
		store.addOrUpdateClaw({ id: 'b', name: 'B', online: true });
		store.byId['a'].initialized = true;
		store.byId['a'].rtcPhase = 'failed';
		store.byId['a'].retryNextAt = 0;
		store.byId['b'].initialized = true;
		store.byId['b'].rtcPhase = 'failed';
		store.byId['b'].retryNextAt = 0;

		const ensureSpy = vi.spyOn(store, '__ensureRtc').mockResolvedValue();
		store.manualRetryUnreachable();

		expect(ensureSpy).toHaveBeenCalledTimes(2);
		const ids = ensureSpy.mock.calls.map((call) => call[0]).sort();
		expect(ids).toEqual(['a', 'b']);
	});
});

describe('__handleClawGoOffline helper', () => {
	test('dashboard 同步 + clearRetry + PC restarting 时 pauseRestart；不动 dcReady/disconnectedAt/rtcPhase', () => {
		const store = useClawsStore();
		const dashboardStore = useDashboardStore();
		dashboardStore.byClaw['1'] = { loading: false, error: null, instance: { name: 'Bot', online: true }, agents: [] };

		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;
		store.byId['1'].dcReady = true;
		store.byId['1'].rtcPhase = 'ready';
		store.byId['1'].disconnectedAt = 0;

		const fakeRtc = { state: 'restarting', pauseRestart: vi.fn() };
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);
		const clearSpy = vi.spyOn(store, '__clearRetry');

		store.__handleClawGoOffline('1');

		expect(dashboardStore.byClaw['1'].instance.online).toBe(false);
		expect(clearSpy).toHaveBeenCalledWith('1');
		expect(fakeRtc.pauseRestart).toHaveBeenCalled();
		// 通信模型 §5.5：presence 与 DC 生命周期解耦，offline 不写 DC 侧字段
		expect(store.byId['1'].dcReady).toBe(true);
		expect(store.byId['1'].disconnectedAt).toBe(0);
		expect(store.byId['1'].rtcPhase).toBe('ready');
	});

	test('PC 已在 restart（onRtcStateChange stamp 过 disconnectedAt）时，offline 不覆盖/不清除该 stamp', () => {
		const store = useClawsStore();
		const prevAt = Date.now() - 30_000;
		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].disconnectedAt = prevAt;
		store.byId['1'].rtcPhase = 'restarting';

		const fakeConn = { rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.__handleClawGoOffline('1');

		// 由 onRtcStateChange('restarting') stamp 的 disconnectedAt 保持不变
		expect(store.byId['1'].disconnectedAt).toBe(prevAt);
		expect(store.byId['1'].rtcPhase).toBe('restarting');
	});

	test('PC 为 null 时 pauseRestart 不报错', () => {
		const store = useClawsStore();
		store.setClaws([{ id: '1', online: true }]);
		const fakeConn = { rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		expect(() => store.__handleClawGoOffline('1')).not.toThrow();
	});

	test('PC 为 connected 也调 pauseRestart（停 keepalive/disconnected timer）；dcReady 不受影响', () => {
		const store = useClawsStore();
		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;
		store.byId['1'].dcReady = true;

		const fakeRtc = { state: 'connected', pauseRestart: vi.fn() };
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.__handleClawGoOffline('1');

		// connected 状态下也要调 pauseRestart（防止 keepalive probe 失败 → 空烧 restart 预算）
		expect(fakeRtc.pauseRestart).toHaveBeenCalled();
		// DC 本身仍 open（SCTP 跨 ICE restart 存活）→ dcReady 不被 presence 污染
		expect(store.byId['1'].dcReady).toBe(true);
	});
});

describe('__resumeOnline helper', () => {
	test('rtc.state === restarting + restartPaused=true → triggerRestart(online_resume)，不 __ensureRtc', () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'restarting', restartPaused: true, triggerRestart: vi.fn() };
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;
		const ensureSpy = vi.spyOn(store, '__ensureRtc').mockResolvedValue();

		store.__resumeOnline('1');

		expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('online_resume');
		expect(ensureSpy).not.toHaveBeenCalled();
	});

	test('rtc.state === restarting + restartPaused=false → 不 triggerRestart（正常 restart 进行中，避免 attemptCount 泄漏）', () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'restarting', restartPaused: false, triggerRestart: vi.fn() };
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;
		const ensureSpy = vi.spyOn(store, '__ensureRtc').mockResolvedValue();

		store.__resumeOnline('1');

		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
		expect(ensureSpy).not.toHaveBeenCalled();
	});

	test('rtc.state === connected + restartPaused=true → 调 resumeRecovery + __ensureRtc 早退', async () => {
		const store = useClawsStore();
		const dashboardStore = useDashboardStore();
		vi.spyOn(dashboardStore, 'loadDashboard').mockResolvedValue();

		const fakeRtc = {
			state: 'connected',
			isReady: true,
			restartPaused: true,
			resumeRecovery: vi.fn(),
			triggerRestart: vi.fn(),
		};
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;

		mockInitRtc.mockClear();
		store.__resumeOnline('1');
		await vi.waitFor(() => {
			expect(dashboardStore.loadDashboard).toHaveBeenCalledWith('1');
		});

		// connected + paused 走 resumeRecovery，不 triggerRestart、不 rebuild
		expect(fakeRtc.resumeRecovery).toHaveBeenCalled();
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
		expect(mockInitRtc).not.toHaveBeenCalled();
	});

	test('rtc.state === connected + restartPaused=false → 不调 resumeRecovery（无需解冻）', async () => {
		const store = useClawsStore();
		const dashboardStore = useDashboardStore();
		vi.spyOn(dashboardStore, 'loadDashboard').mockResolvedValue();

		const fakeRtc = {
			state: 'connected',
			isReady: true,
			restartPaused: false,
			resumeRecovery: vi.fn(),
			triggerRestart: vi.fn(),
		};
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;

		store.__resumeOnline('1');
		await vi.waitFor(() => {
			expect(dashboardStore.loadDashboard).toHaveBeenCalledWith('1');
		});

		expect(fakeRtc.resumeRecovery).not.toHaveBeenCalled();
	});

	test('rtc.state === connected → __ensureRtc 早退校正 dcReady（不 rebuild），后 loadDashboard', async () => {
		const store = useClawsStore();
		const dashboardStore = useDashboardStore();
		vi.spyOn(dashboardStore, 'loadDashboard').mockResolvedValue();

		const fakeRtc = { state: 'connected', isReady: true, triggerRestart: vi.fn() };
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;

		mockInitRtc.mockClear();
		store.__resumeOnline('1');
		await vi.waitFor(() => {
			expect(dashboardStore.loadDashboard).toHaveBeenCalledWith('1');
		});
		// 不会 rebuild（initRtc 不被调）
		expect(mockInitRtc).not.toHaveBeenCalled();
		// triggerRestart 只在 restarting 分支调用
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
		// __ensureRtc 早退后把 dcReady 同步为 true
		expect(store.byId['1'].dcReady).toBe(true);
		expect(store.byId['1'].rtcPhase).toBe('ready');
	});

	test('rtc === null → __ensureRtc 走 rebuild', async () => {
		const store = useClawsStore();
		const fakeConn = { rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;

		mockInitRtc.mockClear();
		store.__resumeOnline('1');

		await vi.waitFor(() => {
			expect(mockInitRtc).toHaveBeenCalledWith('1', fakeConn, expect.any(Object));
		});
	});

	test('rtc.state === failed → __ensureRtc 走 rebuild', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'failed', triggerRestart: vi.fn() };
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;

		mockInitRtc.mockClear();
		store.__resumeOnline('1');

		await vi.waitFor(() => {
			expect(mockInitRtc).toHaveBeenCalled();
		});
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
	});

	test('conn 不存在 → 安全返回', () => {
		const store = useClawsStore();
		mockManager.get.mockReturnValue(null);
		store.setClaws([{ id: '1', online: true }]);

		expect(() => store.__resumeOnline('1')).not.toThrow();
	});

	test('调 __resumeOnline 时调 __clearRetry', () => {
		const store = useClawsStore();
		const fakeConn = { rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;
		const clearSpy = vi.spyOn(store, '__clearRetry');

		store.__resumeOnline('1');

		expect(clearSpy).toHaveBeenCalledWith('1');
	});

	test('集成：offline → resume (restarting+paused) → force refresh + triggerRestart', async () => {
		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		const dashboardStore = useDashboardStore();
		// 4 个下游 store 的 loader 都需要 mockResolvedValue，否则 refreshClawResources 里的
		// .catch(() => {}) 会因为某个 loader 返回非 Promise 而抛 TypeError 中断后续调用
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadSessionsForClaw').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadTopicsForClaw').mockResolvedValue();
		vi.spyOn(dashboardStore, 'loadDashboard').mockResolvedValue();

		const fakeRtc = { state: 'restarting', restartPaused: true, isReady: true, pauseRestart: vi.fn(), triggerRestart: vi.fn() };
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;
		store.byId['1'].dcReady = true;

		// Step 1: offline → pauseRestart；不动 dcReady/disconnectedAt
		store.__handleClawGoOffline('1');
		expect(store.byId['1'].dcReady).toBe(true);
		expect(store.byId['1'].disconnectedAt).toBe(0);

		// Step 2: resume online → force refresh（presence 事件即刷新信号，不看 gap）+ triggerRestart
		store.__resumeOnline('1');
		expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('online_resume');

		// force refresh 不依赖 dcReady 翻转：即使 dcReady 从未被清，4 个下游 loader 也必须被调
		await vi.waitFor(() => {
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('1');
		});
		expect(sessionsStore.loadSessionsForClaw).toHaveBeenCalledWith('1');
		expect(topicsStore.loadTopicsForClaw).toHaveBeenCalledWith('1');
		expect(dashboardStore.loadDashboard).toHaveBeenCalledWith('1');

		// Step 3: 模拟 WebRtcConnection 内部 restart 成功 → onRtcStateChange('connected')
		// 因 dcReady 整段为 true，wasDisconnected=false → 不再调 __refreshIfStale（避免重复刷）
		agentsStore.loadAgents.mockClear();
		store.__rtcCallbacks('1').onRtcStateChange('connected');
		expect(store.byId['1'].dcReady).toBe(true);
		expect(store.byId['1'].rtcPhase).toBe('ready');
		// connected 分支兜底清 disconnectedAt（修 pre-existing 累积 stamp 漏洞）
		expect(store.byId['1'].disconnectedAt).toBe(0);
		// 短窗等一下看有没有触发——force refresh 已经在 __resumeOnline 做过，这里不应再刷
		await new Promise((r) => setTimeout(r, 10));
		expect(agentsStore.loadAgents).not.toHaveBeenCalled();

		// 幂等验证：模拟 __attemptRestart 消费 paused 标志 + PC 已转入 connected，再次 __resumeOnline 不应重复 triggerRestart
		fakeRtc.restartPaused = false;
		fakeRtc.state = 'connected';
		store.__resumeOnline('1');
		expect(fakeRtc.triggerRestart).toHaveBeenCalledTimes(1);
		// 唯一一次 triggerRestart 的 reason 是 online_resume
		expect(fakeRtc.triggerRestart.mock.calls[0][0]).toBe('online_resume');
	});

	test('集成：connected-throughout-offline → force refresh 触发下游 loader（不依赖 dcReady 翻转）', async () => {
		const store = useClawsStore();
		const dashboardStore = useDashboardStore();
		vi.spyOn(dashboardStore, 'loadDashboard').mockResolvedValue();
		const agentsStore = useAgentsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		const sessionsStore = useSessionsStore();
		vi.spyOn(sessionsStore, 'loadSessionsForClaw').mockResolvedValue();
		const topicsStore = useTopicsStore();
		vi.spyOn(topicsStore, 'loadTopicsForClaw').mockResolvedValue();

		// PC 整段保持 connected（未经历 restart），只有 store 侧的 online 字段翻转
		const fakeRtc = { state: 'connected', isReady: true, restartPaused: false, pauseRestart: vi.fn(), triggerRestart: vi.fn(), resumeRecovery: vi.fn() };
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;
		store.byId['1'].dcReady = true;
		store.byId['1'].rtcPhase = 'ready';

		// Step 1: offline → pauseRestart；dcReady/disconnectedAt/rtcPhase 全部不动
		store.__handleClawGoOffline('1');
		expect(store.byId['1'].dcReady).toBe(true);
		expect(store.byId['1'].disconnectedAt).toBe(0);
		expect(store.byId['1'].rtcPhase).toBe('ready');

		// 模拟 pauseRestart 后的状态（store 侧 rtc mock 的 restartPaused 仍为 false，无需改）
		// Step 2: online → __resumeOnline force refresh（不看 gap）
		store.__resumeOnline('1');

		// force refresh 即使 disconnectedAt=0（短 offline 或 connected-throughout）也触发下游刷新
		await vi.waitFor(() => {
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('1');
		});
		expect(sessionsStore.loadSessionsForClaw).toHaveBeenCalledWith('1');
		expect(topicsStore.loadTopicsForClaw).toHaveBeenCalledWith('1');
		expect(dashboardStore.loadDashboard).toHaveBeenCalledWith('1');

		// __ensureRtc 内部早退：dcReady 保持 true、rtcPhase='ready'
		expect(store.byId['1'].dcReady).toBe(true);
		expect(store.byId['1'].rtcPhase).toBe('ready');
		// 不走 triggerRestart
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
	});

	test('集成：rebuild 路径 force refresh 延后到 rebuild 成功后（避免 dcReady=false 时 loader 被 gate 静默 skip）', async () => {
		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		const dashboardStore = useDashboardStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadSessionsForClaw').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadTopicsForClaw').mockResolvedValue();
		vi.spyOn(dashboardStore, 'loadDashboard').mockResolvedValue();

		// 初态 rtc=null（rebuild 路径）；rebuild 成功由 mockInitRtc 返回 'rtc'
		const fakeConn = { rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;
		// 模拟前一次 onRtcStateChange('failed') 已清 dcReady、stamp disconnectedAt
		store.byId['1'].dcReady = false;
		store.byId['1'].disconnectedAt = Date.now() - 5_000;

		mockInitRtc.mockClear();
		mockInitRtc.mockResolvedValue('rtc');

		store.__resumeOnline('1');

		// rebuild 成功后 __ensureRtc 写 dcReady=true，然后链上 force refresh 才跑
		await vi.waitFor(() => {
			expect(mockInitRtc).toHaveBeenCalled();
			expect(store.byId['1'].dcReady).toBe(true);
		});
		await vi.waitFor(() => {
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('1');
		});
		// 所有 4 个 loader 都要调（rebuild 后 dcReady=true → getReadyConn 不 gate）
		expect(sessionsStore.loadSessionsForClaw).toHaveBeenCalledWith('1');
		expect(topicsStore.loadTopicsForClaw).toHaveBeenCalledWith('1');
		expect(dashboardStore.loadDashboard).toHaveBeenCalledWith('1');
	});

	test('connected 分支入口立即 force refresh（DC 预期可用）', () => {
		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(useSessionsStore(), 'loadSessionsForClaw').mockResolvedValue();
		vi.spyOn(useTopicsStore(), 'loadTopicsForClaw').mockResolvedValue();
		vi.spyOn(useDashboardStore(), 'loadDashboard').mockResolvedValue();

		const fakeRtc = { state: 'connected', isReady: true, restartPaused: false, resumeRecovery: vi.fn(), triggerRestart: vi.fn() };
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;
		store.byId['1'].dcReady = true;

		store.__resumeOnline('1');

		// connected 路径：入口同步（fire-and-forget）触发 force refresh；loader 可立即发起
		expect(agentsStore.loadAgents).toHaveBeenCalledWith('1');
	});

	test('restarting+paused 分支入口立即 force refresh（DC 可能仍 open）', () => {
		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(useSessionsStore(), 'loadSessionsForClaw').mockResolvedValue();
		vi.spyOn(useTopicsStore(), 'loadTopicsForClaw').mockResolvedValue();
		vi.spyOn(useDashboardStore(), 'loadDashboard').mockResolvedValue();

		const fakeRtc = { state: 'restarting', restartPaused: true, triggerRestart: vi.fn() };
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;
		// dcReady 在 restarting 期间仍可为 true（SCTP 存活）
		store.byId['1'].dcReady = true;

		store.__resumeOnline('1');

		// restarting 路径：入口同步触发 force refresh
		expect(agentsStore.loadAgents).toHaveBeenCalledWith('1');
		expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('online_resume');
	});

	test('rebuild 路径：第一次 __ensureRtc 被 _rtcInitInProgress 守卫早退，force refresh 延到真正完成（标记机制）', async () => {
		// 场景 F：__ensureRtc 在 in-progress 时早退，.then 立即 fire 但 rebuild 未完成。
		// 新机制：__resumeOnline 打标记 _pendingForceRefreshOnRebuild；任何 __ensureRtc
		// 真正成功时 consume 标记并 force refresh。
		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		const dashboardStore = useDashboardStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadSessionsForClaw').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadTopicsForClaw').mockResolvedValue();
		vi.spyOn(dashboardStore, 'loadDashboard').mockResolvedValue();

		// initRtc 延迟 resolve 模拟长 rebuild
		let resolveInit;
		mockInitRtc.mockImplementation(() => new Promise((r) => { resolveInit = r; }));

		const fakeConn = { rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;
		store.byId['1'].dcReady = false; // rebuild 前的典型状态

		// Step 1: 第一次调 __ensureRtc 直接（模拟已有 rebuild 在进行）
		const inflight = store.__ensureRtc('1');
		// 让 await initRtc 挂起
		await Promise.resolve();

		// Step 2: __resumeOnline 进入——此时 rtc 是 null（initRtc 尚未返回 'rtc'），canRefreshNow=false
		//   第二次 __ensureRtc 会命中 _rtcInitInProgress 早退
		store.__resumeOnline('1');

		// 短 tick：loader 还不应被调（dcReady 仍 false）
		await Promise.resolve();
		expect(agentsStore.loadAgents).not.toHaveBeenCalled();

		// Step 3: rebuild 真正完成
		resolveInit('rtc');
		await inflight;

		// __ensureRtc 成功路径 consume 标记 → force refresh
		await vi.waitFor(() => {
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('1');
		});
		expect(sessionsStore.loadSessionsForClaw).toHaveBeenCalledWith('1');
		expect(topicsStore.loadTopicsForClaw).toHaveBeenCalledWith('1');
		expect(dashboardStore.loadDashboard).toHaveBeenCalledWith('1');
	});

	test('removeClawById / applySnapshot 删 claw / __resetClawStoreInternals 会清 pending force-refresh 标记', async () => {
		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(useSessionsStore(), 'loadSessionsForClaw').mockResolvedValue();
		vi.spyOn(useTopicsStore(), 'loadTopicsForClaw').mockResolvedValue();
		vi.spyOn(useDashboardStore(), 'loadDashboard').mockResolvedValue();

		// 复用模块级 `_pendingForceRefreshOnRebuild`：通过"rebuild 分支 add + 验证 consume"间接断言清理
		// 每个 sub-case：add 标记 → 触发清理 → 新建同 id 再跑 rebuild → 不应再被 force（已被清除）
		const mkRtcNull = () => ({ rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() });

		// Case 1: removeClawById 清标记
		mockManager.get.mockReturnValue(mkRtcNull());
		store.setClaws([{ id: 'A', online: true }]);
		store.byId['A'].initialized = true;
		store.byId['A'].dcReady = false;
		mockInitRtc.mockResolvedValue('failed'); // 让 __ensureRtc 失败 + add 残留
		store.__resumeOnline('A');
		await vi.waitFor(() => {
			expect(mockInitRtc).toHaveBeenCalledTimes(3);
		});
		// 此时 _pendingForceRefreshOnRebuild 里有 'A'
		store.removeClawById('A');
		// 再 setup 同 id，让 rebuild 成功；由于标记已被 removeClawById 清，不应走 force 分支
		mockManager.get.mockReturnValue(mkRtcNull());
		store.setClaws([{ id: 'A', online: true }]);
		store.byId['A'].initialized = true;
		store.byId['A'].dcReady = false;
		mockInitRtc.mockResolvedValue('rtc');
		agentsStore.loadAgents.mockClear();
		// 直接调 __ensureRtc（不走 __resumeOnline，避免重新 add 标记）
		await store.__ensureRtc('A');
		// 成功时 consume：标记已被 removeClawById 清 → force=false；disconnectedAt=0 → 非 force 刷被 gap gate skip
		expect(agentsStore.loadAgents).not.toHaveBeenCalled();
	});

	test('rebuild 路径：当前 __ensureRtc 失败、退避重试最终成功也能触发 force refresh', async () => {
		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadSessionsForClaw').mockResolvedValue();
		vi.spyOn(useTopicsStore(), 'loadTopicsForClaw').mockResolvedValue();
		vi.spyOn(useDashboardStore(), 'loadDashboard').mockResolvedValue();

		// 前 3 次（RTC_BUILD_MAX_RETRIES）失败，第 4 次（退避重试后）成功
		let call = 0;
		mockInitRtc.mockImplementation(() => {
			call++;
			return Promise.resolve(call >= 4 ? 'rtc' : 'failed');
		});

		const fakeConn = { rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;
		store.byId['1'].dcReady = false;

		// __resumeOnline rebuild 分支 → 标记 pendingForceRefresh；第一次 __ensureRtc 内部循环
		// 3 次全失败 → __scheduleRetry 排退避
		store.__resumeOnline('1');

		await vi.waitFor(() => {
			expect(call).toBe(3);
		});
		// 第 3 次失败后 rtcPhase=failed；loader 尚未被调（dcReady 仍 false，且没成功）
		expect(agentsStore.loadAgents).not.toHaveBeenCalled();

		// 触发退避重试（__scheduleRetry 内部 setTimeout → 第 4 次 initRtc → 'rtc'）
		await vi.waitFor(() => {
			expect(call).toBe(4);
		}, { timeout: 10_000 });

		// 退避成功：_pendingForceRefreshOnRebuild 仍有标记 → consume 触发 force refresh
		await vi.waitFor(() => {
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('1');
		});
		expect(sessionsStore.loadSessionsForClaw).toHaveBeenCalledWith('1');
	});
});

describe('offline gate on recovery paths', () => {
	test('__ensureRtc 入口 offline gate：offline claw 不建 RTC', async () => {
		const store = useClawsStore();
		const fakeConn = { rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '1', name: 'A', online: false });
		store.byId['1'].initialized = true;
		const phaseBefore = store.byId['1'].rtcPhase;

		mockInitRtc.mockClear();
		await store.__ensureRtc('1');

		expect(mockInitRtc).not.toHaveBeenCalled();
		// rtcPhase 不被提前切到 building/recovering
		expect(store.byId['1'].rtcPhase).toBe(phaseBefore);
	});

	test('__ensureRtc 循环中途 claw 翻 offline → bail-out + rtcPhase=failed', async () => {
		const store = useClawsStore();
		const fakeConn = { rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		// 用 setClaws 避开 addOrUpdateClaw 触发的 __bridgeConn → __fullInit 副作用
		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;

		// 第一轮 initRtc 失败 + 翻 offline；第二轮迭代前检测到 online=false → bail
		let call = 0;
		mockInitRtc.mockImplementation(async () => {
			call++;
			if (call === 1) {
				store.byId['1'].online = false;
			}
			return 'failed';
		});

		await store.__ensureRtc('1');

		// 第一轮跑完，第二轮 iteration 在 initRtc 之前检测到 offline → bail
		expect(call).toBe(1);
		// bail-out (offline 分支) → phase 显式置为 failed
		expect(store.byId['1'].rtcPhase).toBe('failed');
	});

	test('__scheduleRetry offline gate：offline claw 不排队退避', () => {
		const store = useClawsStore();
		store.addOrUpdateClaw({ id: '1', name: 'A', online: false });
		store.byId['1'].initialized = true;

		store.__scheduleRetry('1');

		expect(store.byId['1'].retryCount).toBe(0);
		expect(store.byId['1'].retryNextAt).toBe(0);
	});

	test('__checkAndRecover offline gate：offline claw 不 probe/restart', async () => {
		const store = useClawsStore();
		const fakeRtc = {
			state: 'connected',
			probe: vi.fn().mockResolvedValue(true),
			triggerRestart: vi.fn(),
			nudgeRestart: vi.fn(),
		};
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '1', name: 'A', online: false });
		store.byId['1'].dcReady = true;

		await store.__checkAndRecover('1', 'test');

		expect(fakeRtc.probe).not.toHaveBeenCalled();
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
		expect(fakeRtc.nudgeRestart).not.toHaveBeenCalled();
	});

	test('__handleNetworkOnline offline gate：offline claw 不参与 network 恢复路径', () => {
		const store = useClawsStore();
		const fakeRtc = {
			state: 'failed',
			triggerRestart: vi.fn(),
			nudgeRestart: vi.fn(),
		};
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '1', name: 'A', online: false });
		store.byId['1'].initialized = true;
		const ensureSpy = vi.spyOn(store, '__ensureRtc').mockResolvedValue();

		store.__handleNetworkOnline(false);

		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
		expect(fakeRtc.nudgeRestart).not.toHaveBeenCalled();
		expect(ensureSpy).not.toHaveBeenCalled();
	});
});

describe('applySnapshot online transition dispatch', () => {
	test('online false→true + initialized → __resumeOnline', async () => {
		const store = useClawsStore();
		const fakeConn = { rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		// 先放一个 offline + initialized 的 claw
		store.byId['1'] = {
			...createTestClaw('1'),
			online: false,
			initialized: true,
		};

		const resumeSpy = vi.spyOn(store, '__resumeOnline');
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);

		expect(resumeSpy).toHaveBeenCalledWith('1');
	});

	test('online true→false + initialized → __handleClawGoOffline', () => {
		const store = useClawsStore();
		mockManager.get.mockReturnValue(null);

		store.byId['1'] = {
			...createTestClaw('1'),
			online: true,
			initialized: true,
		};

		const goOfflineSpy = vi.spyOn(store, '__handleClawGoOffline');
		store.applySnapshot([{ id: '1', name: 'A', online: false }]);

		expect(goOfflineSpy).toHaveBeenCalledWith('1');
	});

	test('online 未变 + rtcPhase=failed + initialized → __resumeOnline（server 重启兜底）', () => {
		const store = useClawsStore();
		const fakeConn = { rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.byId['1'] = {
			...createTestClaw('1'),
			online: true,
			initialized: true,
			rtcPhase: 'failed',
		};

		const resumeSpy = vi.spyOn(store, '__resumeOnline');
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);

		expect(resumeSpy).toHaveBeenCalledWith('1');
	});

	test('online 未变 + rtcPhase=ready → 不触发 resume/offline（snapshot no-op）', () => {
		const store = useClawsStore();
		mockManager.get.mockReturnValue(null);

		store.byId['1'] = {
			...createTestClaw('1'),
			online: true,
			initialized: true,
			rtcPhase: 'ready',
		};

		const resumeSpy = vi.spyOn(store, '__resumeOnline');
		const goOfflineSpy = vi.spyOn(store, '__handleClawGoOffline');
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);

		expect(resumeSpy).not.toHaveBeenCalled();
		expect(goOfflineSpy).not.toHaveBeenCalled();
	});

	test('online false→true 且 rtcPhase=failed → 只 __resumeOnline 一次（去重）', () => {
		const store = useClawsStore();
		const fakeConn = { rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.byId['1'] = {
			...createTestClaw('1'),
			online: false,
			initialized: true,
			rtcPhase: 'failed',
		};

		const resumeSpy = vi.spyOn(store, '__resumeOnline');
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);

		expect(resumeSpy).toHaveBeenCalledTimes(1);
	});
});

describe('sig gate (signaling WS 冻结闸)', () => {
	function setupClaw(store, { id = '1', online = true, rtcState = 'connected', restartPaused = false } = {}) {
		const fakeRtc = {
			state: rtcState,
			isReady: true,
			restartPaused,
			pauseRestart: vi.fn(),
			resumeRecovery: vi.fn(),
			triggerRestart: vi.fn(),
			nudgeRestart: vi.fn(),
			probe: vi.fn().mockResolvedValue(true),
		};
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockImplementation((x) => (String(x) === id ? fakeConn : null));
		store.byId[id] = { ...createTestClaw(id), online, initialized: true, dcReady: rtcState === 'connected' };
		// 模拟 applySnapshot 已跑过：`fetched` 是 __freeze/__resumeAllClawsForSigOnline 的 gate，
		// 未 fetched 时 helper no-op（过滤 logout 误触场景），测试里需显式置为 true
		store.fetched = true;
		return { fakeConn, fakeRtc };
	}

	test('初态 sig.state=connected：on 被调 1 次，无 freeze', () => {
		const store = useClawsStore();
		const { fakeRtc } = setupClaw(store);
		store.__bridgeLifecycle();
		expect(__mockSig.on).toHaveBeenCalledWith('state', expect.any(Function));
		expect(fakeRtc.pauseRestart).not.toHaveBeenCalled();
	});

	test('初态 sig.state=disconnected（byId 空）：不崩，listener 已挂', () => {
		const store = useClawsStore();
		__mockSigState = 'disconnected';
		store.__bridgeLifecycle();
		expect(__mockSig.on).toHaveBeenCalledWith('state', expect.any(Function));
	});

	test('初态 sig.state=connecting：立即冻结已有 claw', () => {
		const store = useClawsStore();
		__mockSigState = 'connecting';
		const { fakeRtc } = setupClaw(store);
		store.__bridgeLifecycle();
		expect(fakeRtc.pauseRestart).toHaveBeenCalledTimes(1);
	});

	test('connected→disconnected：遍历 byId 调 pauseRestart + clearRetry，不调 __handleClawGoOffline', () => {
		const store = useClawsStore();
		const { fakeRtc: rtcA } = setupClaw(store, { id: '1', online: true });
		const fakeRtcB = {
			state: 'restarting', isReady: false, restartPaused: false,
			pauseRestart: vi.fn(), resumeRecovery: vi.fn(), triggerRestart: vi.fn(),
			nudgeRestart: vi.fn(), probe: vi.fn(),
		};
		const fakeConnB = { rtc: fakeRtcB, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockImplementation((x) => {
			if (String(x) === '1') return { rtc: rtcA, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
			if (String(x) === '2') return fakeConnB;
			return null;
		});
		store.byId['2'] = { ...createTestClaw('2'), online: false, initialized: true };

		const clearRetrySpy = vi.spyOn(store, '__clearRetry');
		const offlineSpy = vi.spyOn(store, '__handleClawGoOffline');

		store.__bridgeLifecycle();
		__emitSigState('disconnected');

		expect(rtcA.pauseRestart).toHaveBeenCalledTimes(1);
		expect(fakeRtcB.pauseRestart).toHaveBeenCalledTimes(1); // 也对 offline claw 调（幂等）
		expect(clearRetrySpy).toHaveBeenCalledWith('1');
		expect(clearRetrySpy).toHaveBeenCalledWith('2');
		// __freezeAllClawsForSigOffline 走与 __handleClawGoOffline 不同的路径，
		// 不调它（避免 syncDashboardOffline 污染 presence 维度）
		expect(offlineSpy).not.toHaveBeenCalled();
	});

	test('disconnected→connected：仅对 online claw 调 __resumeOnline，offline claw 不动', () => {
		__mockSigState = 'disconnected';
		const store = useClawsStore();
		setupClaw(store, { id: '1', online: true });
		store.byId['2'] = { ...createTestClaw('2'), online: false, initialized: true };
		store.__bridgeLifecycle();

		const resumeSpy = vi.spyOn(store, '__resumeOnline').mockImplementation(() => {});
		__emitSigState('connected');

		expect(resumeSpy).toHaveBeenCalledTimes(1);
		expect(resumeSpy).toHaveBeenCalledWith('1');
	});

	test('forceReconnect 二连发 disconnected→connecting：handler 去重，freeze 仅 1 次', () => {
		const store = useClawsStore();
		const { fakeRtc } = setupClaw(store);
		store.__bridgeLifecycle();

		__emitSigState('disconnected');
		__emitSigState('connecting');

		expect(fakeRtc.pauseRestart).toHaveBeenCalledTimes(1);
	});

	test('__ensureRtc 入口 _sigOffline=true 早退（initRtc 未调）', async () => {
		__mockSigState = 'disconnected';
		const store = useClawsStore();
		setupClaw(store, { rtcState: 'failed' });
		store.__bridgeLifecycle();
		mockInitRtc.mockClear();

		await store.__ensureRtc('1');
		expect(mockInitRtc).not.toHaveBeenCalled();
	});

	test('__ensureRtc 循环中途 sig 掉线：bail sig_offline，rtcPhase 保持进入前的状态（不被写成 failed）', async () => {
		const store = useClawsStore();
		setupClaw(store, { rtcState: 'failed' });
		store.byId['1'].rtcPhase = 'ready'; // 预置 'ready'，触发 __ensureRtc 内部 'recovering' 分支
		store.__bridgeLifecycle();

		mockInitRtc.mockReset();
		mockInitRtc.mockImplementationOnce(async () => {
			__emitSigState('disconnected');
			return 'failed';
		});

		await store.__ensureRtc('1');
		expect(mockInitRtc).toHaveBeenCalledTimes(1);
		// __ensureRtc 入口把 rtcPhase 写成 'recovering'；循环 bail 'sig_offline' 分支不改 phase
		// （对比 'offline' 分支会写 'failed'），正向断言留在 'recovering' 可证明三分支确实分开
		expect(store.byId['1'].rtcPhase).toBe('recovering');
		expect(mockRemoteLog).toHaveBeenCalledWith(expect.stringContaining('reason=sig_offline'));
	});

	test('__ensureRtc 循环中途 claw 翻 offline（对照组）：bail offline 分支确实写 rtcPhase=failed', async () => {
		const store = useClawsStore();
		setupClaw(store, { rtcState: 'failed' });
		store.byId['1'].rtcPhase = 'ready';
		store.__bridgeLifecycle();

		mockInitRtc.mockReset();
		mockInitRtc.mockImplementationOnce(async () => {
			store.byId['1'].online = false;
			return 'failed';
		});

		await store.__ensureRtc('1');
		expect(store.byId['1'].rtcPhase).toBe('failed');
		expect(mockRemoteLog).toHaveBeenCalledWith(expect.stringContaining('reason=offline'));
	});

	test('__scheduleRetry 入口 _sigOffline=true 早退（retryCount 不变）', () => {
		__mockSigState = 'disconnected';
		const store = useClawsStore();
		setupClaw(store, { rtcState: 'failed' });
		store.__bridgeLifecycle();
		store.byId['1'].retryCount = 0;

		store.__scheduleRetry('1');
		expect(store.byId['1'].retryCount).toBe(0);
		expect(store.byId['1'].retryNextAt).toBe(0);
	});

	test('__checkAndRecover _sigOffline=true 早退（probe 未调）', async () => {
		__mockSigState = 'disconnected';
		const store = useClawsStore();
		const { fakeRtc } = setupClaw(store);
		store.byId['1'].dcReady = true;
		store.__bridgeLifecycle();

		await store.__checkAndRecover('1', 'test');
		expect(fakeRtc.probe).not.toHaveBeenCalled();
	});

	test('__handleNetworkOnline _sigOffline=true 入口早退', () => {
		__mockSigState = 'disconnected';
		const store = useClawsStore();
		const { fakeRtc } = setupClaw(store, { rtcState: 'restarting' });
		store.__bridgeLifecycle();

		store.__handleNetworkOnline(false);
		expect(fakeRtc.nudgeRestart).not.toHaveBeenCalled();
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
	});

	test('__resumeOnline _sigOffline=true 入口早退', () => {
		__mockSigState = 'disconnected';
		const store = useClawsStore();
		const { fakeRtc } = setupClaw(store, { rtcState: 'restarting', restartPaused: true });
		store.__bridgeLifecycle();
		mockInitRtc.mockClear();

		store.__resumeOnline('1');
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
		expect(fakeRtc.resumeRecovery).not.toHaveBeenCalled();
		expect(mockInitRtc).not.toHaveBeenCalled();
	});

	test('freeze 清退避：先 __scheduleRetry 拿到真 timer → sig 掉线 → timer 被 clear，retry state 清零', () => {
		vi.useFakeTimers();
		try {
			const store = useClawsStore();
			setupClaw(store, { rtcState: 'failed' });
			store.byId['1'].rtcPhase = 'failed';
			store.__bridgeLifecycle();

			// 触发真实的 __scheduleRetry：挂 timer + 设 retryCount/retryNextAt
			store.__scheduleRetry('1');
			expect(store.byId['1'].retryCount).toBe(1);
			expect(store.byId['1'].retryNextAt).toBeGreaterThan(0);

			__emitSigState('disconnected');

			// timer 被 clearTimeout，retry state 彻底清零
			expect(store.byId['1'].retryCount).toBe(0);
			expect(store.byId['1'].retryNextAt).toBe(0);
			// 快进时间验证 timer 不再 fire（若 fire 会调 __ensureRtc，但此时 _sigOffline 已 gate）
			mockInitRtc.mockClear();
			vi.advanceTimersByTime(60_000);
			expect(mockInitRtc).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	test('resume 分派：rtc.state=connected + restartPaused=true → 走 resumeRecovery（不 triggerRestart）', () => {
		__mockSigState = 'disconnected';
		const store = useClawsStore();
		const { fakeRtc } = setupClaw(store, { rtcState: 'connected', restartPaused: true });
		store.__bridgeLifecycle();

		__emitSigState('connected');

		expect(fakeRtc.resumeRecovery).toHaveBeenCalledTimes(1);
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
	});

	test('两把锁协调：claw offline + sig down → claw online（sig 仍 down）不 resume → sig online 才 resume', () => {
		const store = useClawsStore();
		const { fakeRtc } = setupClaw(store, { rtcState: 'restarting', restartPaused: true, online: true });
		store.__bridgeLifecycle();

		// 1. claw 先 offline
		store.updateClawOnline('1', false);
		expect(fakeRtc.pauseRestart).toHaveBeenCalledTimes(1);
		fakeRtc.pauseRestart.mockClear();

		// 2. sig down：再 pause 一次（幂等）
		__emitSigState('disconnected');
		expect(fakeRtc.pauseRestart).toHaveBeenCalledTimes(1);

		// 3. claw online 回来（sig 仍 down）：__resumeOnline 被调但入口 gate 早退
		store.updateClawOnline('1', true);
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();

		// 4. sig 回来：__resumeAllClawsForSigOnline 遍历 online claw，调 __resumeOnline 成功
		__emitSigState('connected');
		expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('online_resume');
	});

	test('__resetClawStoreInternals 调 sig.off（同一 cb）', () => {
		const store = useClawsStore();
		setupClaw(store);
		store.__bridgeLifecycle();
		expect(__mockSig.on).toHaveBeenCalledTimes(1);
		const onCb = __mockSig.on.mock.calls[0][1];

		__resetAwaitingConnIds();
		expect(__mockSig.off).toHaveBeenCalledWith('state', onCb);
	});

	test('回归：_sigOffline=true 时 __handleClawGoOffline 仍完整执行（sig gate 不污染既有 claw.online 路径）', () => {
		__mockSigState = 'disconnected';
		const store = useClawsStore();
		const { fakeRtc } = setupClaw(store);
		store.__bridgeLifecycle();
		// bridge 的初态同步已调用过一次 pauseRestart，清 spy 状态再断言
		fakeRtc.pauseRestart.mockClear();
		const clearRetrySpy = vi.spyOn(store, '__clearRetry');

		store.__handleClawGoOffline('1');
		// __handleClawGoOffline 的核心动作：pauseRestart + __clearRetry（+ syncDashboardOffline 由 dashboard 层单独测）
		expect(fakeRtc.pauseRestart).toHaveBeenCalledTimes(1);
		expect(clearRetrySpy).toHaveBeenCalledWith('1');
	});

	test('__freezeAllClawsForSigOffline byId 为空：无日志无动作', () => {
		const store = useClawsStore();
		store.__bridgeLifecycle();
		mockRemoteLog.mockClear();

		__emitSigState('disconnected');
		expect(mockRemoteLog).not.toHaveBeenCalledWith(expect.stringContaining('claw.sigOffline'));
	});

	// -------- review 修复：#1 首启补救（SSE snapshot 先于 sig 握手到达导致 initialized=false）--------

	test('#1 sig 恢复：initialized=false 的 online claw 被补跑 __fullInit', () => {
		__mockSigState = 'disconnected';
		const store = useClawsStore();
		const { fakeConn } = setupClaw(store);
		// 模拟首启竞态结果：SSE snapshot 先到 + __fullInit 被 sig gate 拦过
		store.byId['1'].initialized = false;
		store.__bridgeLifecycle();
		const fullInitSpy = vi.spyOn(store, '__fullInit').mockResolvedValue();

		__emitSigState('connected');

		expect(fullInitSpy).toHaveBeenCalledTimes(1);
		expect(fullInitSpy).toHaveBeenCalledWith('1', fakeConn);
		expect(store.byId['1'].initialized).toBe(true);
		expect(store.byId['1'].__initAttempt).toBe(1);
	});

	test('#1 sig 恢复：__fullInit 拒绝时 initialized 回滚为 false（catch 分支）', async () => {
		__mockSigState = 'disconnected';
		const store = useClawsStore();
		setupClaw(store);
		store.byId['1'].initialized = false;
		store.__bridgeLifecycle();
		const fullInitSpy = vi.spyOn(store, '__fullInit').mockRejectedValue(new Error('sig gate blocked again'));
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		__emitSigState('connected');
		// 等微任务消化 catch
		await Promise.resolve();
		await Promise.resolve();

		expect(fullInitSpy).toHaveBeenCalledTimes(1);
		expect(store.byId['1'].initialized).toBe(false);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining('fullInit (sig resume) failed'),
			'1',
			expect.stringContaining('sig gate blocked again'),
		);
		warnSpy.mockRestore();
	});

	test('#1 对照组 sig 恢复：initialized=true 的 online claw 走 __resumeOnline，不调 __fullInit', () => {
		__mockSigState = 'disconnected';
		const store = useClawsStore();
		setupClaw(store, { rtcState: 'connected', restartPaused: true });
		store.byId['1'].initialized = true;
		store.__bridgeLifecycle();
		const fullInitSpy = vi.spyOn(store, '__fullInit').mockResolvedValue();
		const resumeSpy = vi.spyOn(store, '__resumeOnline');

		__emitSigState('connected');

		expect(fullInitSpy).not.toHaveBeenCalled();
		expect(resumeSpy).toHaveBeenCalledWith('1');
	});

	// -------- review 修复：#2 typeChanged 跨 sig-gate 记账 --------

	test('#2 sig down + network:online(typeChanged=true) → sig up：connected+paused 升级为 triggerRestart(online_resume)', () => {
		const store = useClawsStore();
		const { fakeRtc } = setupClaw(store, { rtcState: 'connected', restartPaused: true });
		store.__bridgeLifecycle();

		__emitSigState('disconnected');
		// 模拟 network:online typeChanged=true 事件（sig 不通时走 sig gate return 路径，只记账不动作）
		store.__handleNetworkOnline(true);
		// 记账后还没 sig up，fakeRtc 不应被触发
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
		expect(fakeRtc.resumeRecovery).not.toHaveBeenCalled();

		__emitSigState('connected');

		expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('online_resume');
		expect(fakeRtc.resumeRecovery).not.toHaveBeenCalled();
	});

	test('#2 对照组 sig down + network:online(typeChanged=false) → sig up：connected+paused 走 resumeRecovery', () => {
		const store = useClawsStore();
		const { fakeRtc } = setupClaw(store, { rtcState: 'connected', restartPaused: true });
		store.__bridgeLifecycle();

		__emitSigState('disconnected');
		store.__handleNetworkOnline(false);
		__emitSigState('connected');

		expect(fakeRtc.resumeRecovery).toHaveBeenCalledTimes(1);
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
	});

	test('#2 typeChanged 标记消费后清零：下一轮 sig down/up 不粘着', () => {
		const store = useClawsStore();
		const { fakeRtc } = setupClaw(store, { rtcState: 'connected', restartPaused: true });
		store.__bridgeLifecycle();

		// 第一轮：带 typeChanged → 升级为 triggerRestart
		__emitSigState('disconnected');
		store.__handleNetworkOnline(true);
		__emitSigState('connected');
		expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('online_resume');
		fakeRtc.triggerRestart.mockClear();
		fakeRtc.resumeRecovery.mockClear();

		// 第二轮：不带 typeChanged（无 network:online 事件）→ 标记已消费应走 resumeRecovery
		__emitSigState('disconnected');
		__emitSigState('connected');
		expect(fakeRtc.resumeRecovery).toHaveBeenCalledTimes(1);
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
	});

	// -------- review round 3 修复：per-claw Set 覆盖漏网路径（sig 在线/sig 恢复时 claw 仍 offline）--------

	test('#2 round3: sig 在线 + claw offline 期间 typeChanged → claw 回 online 时 forceRestart', () => {
		// 外部 review round 3 #1 核心场景：机器人离线时换网，信号此前被丢
		const store = useClawsStore();
		const { fakeRtc } = setupClaw(store, { rtcState: 'connected', restartPaused: true });
		store.__bridgeLifecycle();
		store.byId['1'].online = false;

		// sig 仍在线（不走 sig gate return）+ claw offline + typeChanged
		// 主循环 `!claw.online continue` 会跳过，但预循环把 '1' 加入 Set
		store.__handleNetworkOnline(true);
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();

		// claw 回 online → updateClawOnline 调 __resumeOnline → 消费 Set → forceRestart
		store.updateClawOnline('1', true);

		expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('online_resume');
		expect(fakeRtc.resumeRecovery).not.toHaveBeenCalled();
	});

	test('#2 round3: sig offline + typeChanged + sig resume 时 claw 仍 offline → claw 后续回 online 时 forceRestart', () => {
		// 外部 review round 3 #1 另一场景：sig 恢复时 claw 还没回来
		// boolean 版本在 sig resume 会消费掉标记，此时 offline claw 被跳过，信号丢失
		const store = useClawsStore();
		const { fakeRtc } = setupClaw(store, { rtcState: 'connected', restartPaused: true });
		store.__bridgeLifecycle();

		__emitSigState('disconnected');
		store.byId['1'].online = false;
		store.__handleNetworkOnline(true); // Set 记账 '1'

		// sig 恢复 + claw 仍 offline：__resumeAllClawsForSigOnline 对 offline claw 不动
		// 旧设计：boolean 在此处消费清零 → 后续 claw 回 online 时信号已丢
		// 新设计：Set 条目保留
		__emitSigState('connected');
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();

		// claw 稍后回 online → __resumeOnline 消费 Set → forceRestart
		store.updateClawOnline('1', true);

		expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('online_resume');
		expect(fakeRtc.resumeRecovery).not.toHaveBeenCalled();
	});

	test('#2 round3: 主循环 connected+paused + typeChanged 处理后清 Set（再 resume 不虚发 triggerRestart）', () => {
		// 场景：claw connected+paused（某瞬态，如 sig 刚 down→up 期间）+ typeChanged
		// 预循环把 claw 加入 Set（willHandleNow=false，因 paused）；主循环 connected+typeChanged
		// 分支直接 triggerRestart('network_type_changed') 当场处理 → 必须清 Set。
		// 若不清，后续任一 __resumeOnline 会消费到陈旧条目，在已健康连接上虚发 online_resume。
		const store = useClawsStore();
		const { fakeRtc } = setupClaw(store, { rtcState: 'connected', restartPaused: true });
		store.__bridgeLifecycle();

		store.__handleNetworkOnline(true);
		// 主循环 network_type_changed 分支已触发
		expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('network_type_changed');
		fakeRtc.triggerRestart.mockClear();

		// sig 翻转 down/up（触发 __resumeAllClawsForSigOnline → __resumeOnline 尝试消费 Set）
		__emitSigState('disconnected');
		__emitSigState('connected');

		// Set 已被主循环 delete 清掉，__resumeOnline 消费返回 false
		// → connected+paused（__freezeAllClawsForSigOffline 再次 pauseRestart）走 resumeRecovery
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
		expect(fakeRtc.resumeRecovery).toHaveBeenCalledTimes(1);
	});

	test('#2 round3: removeClawById 清 Set 条目（重用同 id 时不污染恢复路径）', () => {
		const store = useClawsStore();
		setupClaw(store, { rtcState: 'connected', restartPaused: true });
		store.__bridgeLifecycle();

		store.__handleNetworkOnline(true); // '1' 进 Set（paused 不满足 willHandleNow）
		store.removeClawById('1');

		// 重建同 id claw，直接走恢复路径
		const { fakeRtc: rtcB } = setupClaw(store, { rtcState: 'connected', restartPaused: true });
		store.__resumeOnline('1');

		// Set 被 removeClawById 清理后，消费不到 → 走默认 resumeRecovery 不 forceRestart
		expect(rtcB.triggerRestart).not.toHaveBeenCalled();
		expect(rtcB.resumeRecovery).toHaveBeenCalledTimes(1);
	});
});

/** 造一个完整的 claw state，供 applySnapshot 测试用（保留运行时字段） */
function createTestClaw(id) {
	return {
		id, name: `claw-${id}`,
		online: false,
		lastSeenAt: null, createdAt: null, updatedAt: null,
		rtcPhase: 'idle', lastAliveAt: 0, disconnectedAt: 0,
		initialized: false,
		pluginVersionOk: null, pluginInfo: null, pluginUserConfig: null,
		rtcTransportInfo: null, rtcPeerTransportInfo: null,
		dcReady: false,
		retryCount: 0, retryNextAt: 0,
	};
}
