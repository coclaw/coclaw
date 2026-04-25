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
import { useClawsStore, __resetAwaitingConnIds, __test__ as __clawsTest } from './claws.store.js';
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

	test('updates existing claw in place and calls connect (does not override online)', () => {
		const store = useClawsStore();
		const fakeConn = { state: 'disconnected', on: vi.fn(), off: vi.fn(), __onAlive: null, rtc: null, clearRtc: vi.fn(), request: vi.fn().mockResolvedValue({}) };
		mockManager.get.mockReturnValue(fakeConn);
		store.setClaws([{ id: '1', name: 'OldName', online: false }]);
		// addOrUpdateClaw 覆盖 name 等普通字段，但 online 属于 GATED_FIELDS，
		// 必须走 updateClawOnline / applySnapshot 专用入口（以触发 gate 副作用）
		store.addOrUpdateClaw({ id: '1', name: 'NewName', online: true });

		expect(Object.keys(store.byId)).toHaveLength(1);
		expect(store.byId['1'].name).toBe('NewName');
		expect(store.byId['1'].online).toBe(false); // online 被 GATED_FIELDS 拒，保持原值
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

	// P0-3: probe pending 时 removeClawById 必须清 _probeInProgress，
	// 否则同 id remove→re-add 时新 claw 被旧 probe guard 阻塞
	test('probe pending 时 removeClawById 立即清 _probeInProgress（白盒）', async () => {
		const store = useClawsStore();
		// probe 永不 resolve：模拟 in-flight
		const fakeRtc = {
			state: 'connected',
			probe: vi.fn().mockImplementation(() => new Promise(() => {})),
		};
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '50', name: 'P', online: true }]);
		store.byId['50'].dcReady = true;

		// 触发 __checkAndRecover 进入 probe 等待
		store.__checkAndRecover('50');
		await Promise.resolve();
		expect(__clawsTest._probeInProgress.get('50')).toBe(true);

		// removeClawById 必须清 _probeInProgress
		store.removeClawById('50');
		expect(__clawsTest._probeInProgress.has('50')).toBe(false);
	});

	test('probe pending 时 remove + 立即 re-add 同 id：新 claw 不被旧 probe guard 阻塞', async () => {
		const store = useClawsStore();
		// 第一个 conn 的 probe 永不 resolve；第二个 conn 的 probe 立刻 resolve(true)
		const probeOld = vi.fn().mockImplementation(() => new Promise(() => {}));
		const fakeRtcOld = { state: 'connected', probe: probeOld };
		const fakeConnOld = { rtc: fakeRtcOld, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };

		const probeNew = vi.fn().mockResolvedValue(true);
		const fakeRtcNew = { state: 'connected', probe: probeNew };
		const fakeConnNew = { rtc: fakeRtcNew, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };

		// 第一次 mock 返回 old，重置后第二次返回 new
		mockManager.get.mockReturnValue(fakeConnOld);

		store.setClaws([{ id: '51', name: 'R', online: true }]);
		store.byId['51'].dcReady = true;

		// 触发 __checkAndRecover → 旧 probe in flight，_probeInProgress.set
		store.__checkAndRecover('51');
		await Promise.resolve();
		expect(probeOld).toHaveBeenCalledTimes(1);
		expect(__clawsTest._probeInProgress.has('51')).toBe(true);

		// 立即 remove 同 id（旧 probe 仍 pending）
		store.removeClawById('51');
		expect(__clawsTest._probeInProgress.has('51')).toBe(false);
		// remove 内部已调 closeRtcForClaw 一次；清掉，关注后续路径
		mockCloseRtcForBot.mockClear();

		// re-add 同 id；切换 mock 让 conn.rtc 用 new
		mockManager.get.mockReturnValue(fakeConnNew);
		store.addOrUpdateClaw({ id: '51', name: 'R', online: true });
		store.byId['51'].dcReady = true;

		// 新一轮 __checkAndRecover 必须能进入 probe（旧 guard 不该阻塞）
		store.__checkAndRecover('51');
		await Promise.resolve();
		expect(probeNew).toHaveBeenCalledTimes(1);
		// 完成新 probe 后 _probeInProgress 已清
		await Promise.resolve();
		await Promise.resolve();
		expect(__clawsTest._probeInProgress.has('51')).toBe(false);
		// 旧 probe 仍未 resolve；不应被记入新 claw 的恢复路径（rebuild 未触发）
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
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

	test('bot offline→online + DC 仍 connected → __ensureRtc 快速返回，dcReady=true，不刷 dashboard', async () => {
		// round 7：DC 延续场景（connected/restarting）不刷任何业务数据（包括 dashboard），
		// 与 agents/sessions/topics 对称；rebuild 场景由 _pendingForceRefreshOnRebuild
		// 消费点的 refreshClawResources 统一刷
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

		// __ensureRtc 快速返回（RTC 已 connected）；dashboard 不单独刷
		await new Promise((r) => setTimeout(r, 10));
		expect(store.byId['1'].dcReady).toBe(true);
		expect(dashboardStore.loadDashboard).not.toHaveBeenCalled();
	});

	test('bot 上线 + initialized=false + conn 未 bridge → 不提前置 initialized=true（避免卡死）', () => {
		// Finding 3: 历史上 L264-277 会先置 initialized=true 再查 conn，若 conn 尚未 bridge
		// 则没有 __fullInit 被 fire，claw 就卡在 initialized=true + dcReady=false + 永不再 init
		// （applySnapshot Phase 3 rescue 因 initialized=true 跳过、__bridgeConn 因 _bridgedConns 短路跳过）。
		// 修法：先查 conn、判存在、再置——对齐 applySnapshot Phase 3 / __resumeAllClawsForSigOnline 两处 rescue 分支。
		const store = useClawsStore();
		store.setClaws([{ id: '1', online: false }]);
		store.byId['1'].initialized = false;
		// 模拟 conn 未 bridge：manager.get 返回 null
		mockManager.get.mockReturnValue(null);

		store.updateClawOnline('1', true);

		expect(store.byId['1'].online).toBe(true);
		// conn 缺失 → initialized 必须保持 false（等后续 __bridgeConn 接手时再 init）
		expect(store.byId['1'].initialized).toBe(false);
	});

	test('bot offline→online + DC 仍 connected → syncDashboardOnline 复原 dashboard.instance.online=true（与 syncDashboardOffline 对称）', async () => {
		// Finding 2: offline 时 syncDashboardOffline 硬写 instance.online=false；DC 延续场景下
		// 若不刷 dashboard，该字段会长期陈旧留 false（直到 app:foreground / 手动进 ManageClawsPage）。
		// 修法：__resumeOnline 入口调 syncDashboardOnline（展示层同步，不刷聚合数据——保持与"仅 rebuild 才刷"原则一致）。
		const store = useClawsStore();
		const dashboardStore = useDashboardStore();
		vi.spyOn(dashboardStore, 'loadDashboard').mockResolvedValue();

		// dashboard 缓存预置（含 instance.online=true）
		store.addOrUpdateClaw({ id: '1', name: 'Bot', online: true });
		store.byId['1'].initialized = true;
		dashboardStore.byClaw['1'] = {
			loading: false, error: null,
			instance: { name: 'Bot', online: true }, agents: [],
		};

		// offline → syncDashboardOffline 写 false
		mockManager.get.mockReturnValue(null);
		store.updateClawOnline('1', false);
		expect(dashboardStore.byClaw['1'].instance.online).toBe(false);

		// online 恢复（DC 延续）
		const fakeRtc = { state: 'connected', isReady: true, restartPaused: false };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(),
			rtc: fakeRtc, clearRtc: vi.fn(),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.updateClawOnline('1', true);

		// syncDashboardOnline 复原 instance.online=true
		expect(dashboardStore.byClaw['1'].instance.online).toBe(true);
		// 聚合数据（loadDashboard）仍不刷——DC 延续场景保持"仅 rebuild 才刷"原则
		await new Promise((r) => setTimeout(r, 10));
		expect(dashboardStore.loadDashboard).not.toHaveBeenCalled();
	});

	test('同值 offline→offline 幂等：remoteLog / pauseRestart 仅一次', () => {
		// 已 offline 时再次 updateClawOnline(id,false)：presence 未翻转，
		// 但 __handleClawGoOffline 仍被无条件调（当前实现）——remoteLog 只在
		// prev!==next 时打；pauseRestart 对底层 restart 状态是幂等（内部 state gate 决定）
		// 此 test 锁定：日志去重 + 底层 pauseRestart 调用幂等仅一次
		const store = useClawsStore();
		const fakeRtc = {
			state: 'connected',
			pauseRestart: vi.fn(),
		};
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;

		// 第一次 true→false：计入一次 remoteLog + pauseRestart
		store.updateClawOnline('1', false);
		const onlineLogs1 = mockRemoteLog.mock.calls
			.filter((args) => typeof args[0] === 'string' && args[0].startsWith('claw.online'));
		expect(onlineLogs1.length).toBe(1);
		expect(fakeRtc.pauseRestart).toHaveBeenCalledTimes(1);

		// 第二次 false→false：presence 未翻转 → 不再打 remoteLog
		store.updateClawOnline('1', false);
		const onlineLogs2 = mockRemoteLog.mock.calls
			.filter((args) => typeof args[0] === 'string' && args[0].startsWith('claw.online'));
		expect(onlineLogs2.length).toBe(1);
	});

	test('同值 online→online 幂等：第二次不再 __fullInit / __resumeOnline', async () => {
		// initialized=true 的情况下，重复 SSE online=true 不应重复调 __resumeOnline；
		// 已 online 再 online 时 prev!==next 分支不入（prev=true next=true），
		// 也不会走 !initialized 分支（initialized=true）
		const store = useClawsStore();
		const fakeRtc = { state: 'connected', isReady: true, restartPaused: false };
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: false }]);
		store.byId['1'].initialized = true;

		const resumeSpy = vi.spyOn(store, '__resumeOnline');

		// 第一次 offline→online：走 prev=false → __resumeOnline
		store.updateClawOnline('1', true);
		expect(resumeSpy).toHaveBeenCalledTimes(1);

		// 第二次 online→online：prev=next → 不进 prev===false 分支，不再 __resumeOnline
		store.updateClawOnline('1', true);
		expect(resumeSpy).toHaveBeenCalledTimes(1);
	});

	// P1-3: 同值 online + rtcPhase=failed → rescue 路径（与 applySnapshot Phase 3 对称）
	test('同值 online→online + rtcPhase=failed：触发 __resumeOnline rescue', () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'failed', isReady: false, restartPaused: false, triggerRestart: vi.fn() };
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;
		store.byId['1'].rtcPhase = 'failed';

		const resumeSpy = vi.spyOn(store, '__resumeOnline').mockImplementation(() => {});

		// SSE 推送同值 online=true，但 rtcPhase 已死 → 走 rescue 兜底
		store.updateClawOnline('1', true);

		expect(resumeSpy).toHaveBeenCalledTimes(1);
		expect(resumeSpy).toHaveBeenCalledWith('1');
	});

	test('同值 online→online + rtcPhase=ready：不调 __resumeOnline（同值健康仍幂等）', () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'connected', isReady: true };
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;
		store.byId['1'].rtcPhase = 'ready';

		const resumeSpy = vi.spyOn(store, '__resumeOnline').mockImplementation(() => {});

		store.updateClawOnline('1', true);

		// 同值 healthy → 不进 rescue，不调 __resumeOnline
		expect(resumeSpy).not.toHaveBeenCalled();
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

	test('applySnapshot 二次快照补救：已桥接 offline !initialized 的 claw 变 online → 触发 fullInit', async () => {
		// 背景：__bridgeConn L458 `_bridgedConns.get === conn` 会在二次 snapshot 时短路不再 fire
		// fullInit；Phase 3 原 `!initialized continue` 也跳过——两边夹住 claw 永远卡在
		// online=true + initialized=false + dcReady=false。修法：Phase 3 对 !initialized + online
		// 的 claw 显式补 __fullInit（复刻 __bridgeConn L509 和 __resumeAllClawsForSigOnline L590-606）
		const store = useClawsStore();
		const fakeConn = {
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		// 首次 snapshot：online=false → __bridgeConn L509 不 fire（online 条件不满足），
		// 但 conn 已被 __bridgeConn 加入 _bridgedConns（短路标记）
		store.applySnapshot([{ id: '1', name: 'A', online: false }]);
		expect(mockInitRtc).not.toHaveBeenCalled();
		expect(store.byId['1'].initialized).toBe(false);

		// 二次 snapshot：online=true。__bridgeConn L458 短路、Phase 3 原代码 L349 也跳过
		// → 修法前此处 initRtc 永不被调。修法后 Phase 3 补救分支应触发 fullInit
		mockInitRtc.mockClear();
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);

		await vi.waitFor(() => {
			expect(mockInitRtc).toHaveBeenCalledWith('1', fakeConn, expect.any(Object));
		});
		expect(store.byId['1'].initialized).toBe(true);
	});

	test('applySnapshot 二次快照补救：_rtcInitInProgress 持锁时不重 fire（防空转日志风暴）', async () => {
		// 防风暴 gate：前次 rescue 的 __fullInit 还在 await __ensureRtc，若此时二次 snapshot 到达
		// 又进 rescue 分支，__fullInit 入口的 `remoteLog('claw.fullInit')` 会重复打发。
		// 修法：rescue 前查 `_rtcInitInProgress.get(id)`，若在飞则跳过
		const store = useClawsStore();
		const fakeConn = {
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		// 让 initRtc 返回 pending promise → __ensureRtc 持 `_rtcInitInProgress[id]=true`
		let resolveInit;
		mockInitRtc.mockImplementation(() => new Promise((r) => { resolveInit = r; }));

		// 首次 snapshot：online=true → __bridgeConn fire fullInit → 进 __ensureRtc 持锁
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);
		await Promise.resolve();
		await Promise.resolve();
		expect(mockInitRtc).toHaveBeenCalledTimes(1);

		// 人为把 initialized 回滚（模拟 __fullInit 的 catch rollback），保持 `_rtcInitInProgress` 持锁
		store.byId['1'].initialized = false;

		// 二次 snapshot：rescue 看到 !initialized + online，但 `_rtcInitInProgress` 持锁 → 短路
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);
		await Promise.resolve();
		expect(mockInitRtc).toHaveBeenCalledTimes(1); // 没被二次调用
		expect(store.byId['1'].initialized).toBe(false); // rescue 没把 initialized 写 true

		resolveInit('rtc');
	});

	test('applySnapshot 二次快照补救：_rtcRetryState 有条目时不重 fire（尊重 backoff 节流）', async () => {
		// 防风暴 gate：前次 rescue 的 __ensureRtc 已耗尽轮循环排了 __scheduleRetry backoff，
		// 此时二次 snapshot 到达又进 rescue，新 __fullInit → 新 __ensureRtc → 再排 retry（count++）
		// 会打破 backoff 节流。修法：rescue 前查 `_rtcRetryState.has(id)`，有则跳过让 backoff 接管
		const store = useClawsStore();
		const fakeConn = {
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		// 预置 claw：已桥接过（_bridgedConns 持有）+ online=true + !initialized
		store.applySnapshot([{ id: '1', name: 'A', online: false }]);

		// 人为排一个 retry backoff（模拟 __scheduleRetry 已排队中）
		store.__scheduleRetry('1'); // 不会真排（!online 会早退）——换条路径
		// __scheduleRetry 在 !online 下早退；直接写 online=true 后再 scheduleRetry
		store.byId['1'].online = true;
		store.byId['1'].initialized = false;
		store.__scheduleRetry('1');

		mockInitRtc.mockClear();
		// 二次 snapshot：rescue 看 !initialized + online，但 `_rtcRetryState` 已有条目 → 短路
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);
		await Promise.resolve();
		expect(mockInitRtc).not.toHaveBeenCalled();
		expect(store.byId['1'].initialized).toBe(false);

		store.__clearRetry('1'); // 清理排队
	});

	test('applySnapshot 二次快照补救：conn 未 bridge 时不 fire，等 __bridgeConn 接手', () => {
		// 边界：conn 还没被 syncConnections 建出来时，Phase 3 补救应跳过（复刻
		// __resumeAllClawsForSigOnline L600 的同样处理）
		const store = useClawsStore();
		mockManager.get.mockReturnValue(null); // conn=null 模拟未 bridge

		store.applySnapshot([{ id: '1', name: 'A', online: false }]);
		mockInitRtc.mockClear();
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);

		expect(mockInitRtc).not.toHaveBeenCalled();
		// initialized 保持 false，等 __bridgeConn 下次 fire 或下次 snapshot 接手
		expect(store.byId['1'].initialized).toBe(false);
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

	test('source=app:foreground 长后台 + probe 失败 + PC 变 failed → 走 __ensureRtc rebuild', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'connected', probe: vi.fn().mockImplementation(async () => {
			// probe 期间 PC 状态变为 failed —— triggerRestart 会被服务层 gate 哑火，必须 rebuild
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
		// probe 失败 + PC 变 failed → rebuild（与 pre-probe failed 路径对称）
		await vi.waitFor(() => {
			expect(mockCloseRtcForBot).toHaveBeenCalledWith('65');
			expect(mockInitRtc).toHaveBeenCalled();
		});
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
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

	test('network:online + typeChanged + _rtcInitInProgress 完成后 → typeChanged 标记被 __ensureRtc 消费、后续 __resumeOnline 不再 triggerRestart', async () => {
		// 验证 B2：rebuild 进行中（rtc 暂时为 null）时 __handleNetworkOnline 命中
		// `rtc?.state === 'connected'`=false 分支 → 给 '93' 打标
		// `_pendingTypeChangedRestartClaws.add`；rebuild 主循环又因 _rtcInitInProgress 短路。
		// 待 init 完成后 __ensureRtc 成功路径主动清 _pendingTypeChangedRestartClaws，
		// 后续 sig disconnect→connect 走 __resumeAllClawsForSigOnline → __resumeOnline 时不再升级
		// 为 triggerRestart('online_resume')。
		const store = useClawsStore();
		const fakeRtc = {
			state: 'connected', isReady: true, restartPaused: false,
			probe: vi.fn(), triggerRestart: vi.fn(), nudgeRestart: vi.fn(), resumeRecovery: vi.fn(),
		};
		const fakeConn = {
			on: vi.fn(), off: vi.fn(),
			// clearRtc 真正把 rtc 置 null，模拟 ensureRtc rebuild 路径行为
			clearRtc: vi.fn(function () { this.rtc = null; }),
			rtc: fakeRtc, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '93', name: 'Bot', online: true });
		store.byId['93'].dcReady = true;
		store.byId['93'].initialized = true;
		store.fetched = true; // __resumeAllClawsForSigOnline 入口 gate
		store.__bridgeConn('93');
		store.__bridgeLifecycle();

		// 模拟 _rtcInitInProgress：mockInitRtc 返回 pending promise，await 期间 rtc=null
		let resolveInit;
		mockInitRtc.mockImplementation(async (_id, conn) => {
			await new Promise((r) => { resolveInit = r; });
			conn.rtc = fakeRtc;
			return 'rtc';
		});
		const p = store.__ensureRtc('93', { forceRebuild: true });
		// 等 ensureRtc 推进到 await initRtc（此时 rtc=null）
		await new Promise((r) => setTimeout(r, 10));

		// 触发 typeChanged：rtc 为 null + initialized=true → willHandleNow=false → 入 Set 打标；
		// 主循环 `_rtcInitInProgress` 短路 → 不 rebuild
		emitForegroundResume('network:online', { typeChanged: true });
		await new Promise((r) => setTimeout(r, 10));

		// init 完成 → __ensureRtc 成功路径执行 _pendingTypeChangedRestartClaws.delete
		resolveInit('rtc');
		await p;

		// 清 mock，区分前后阶段对 triggerRestart 的调用
		fakeRtc.triggerRestart.mockClear();
		fakeRtc.resumeRecovery.mockClear();

		// 后续 sig disconnect → connect → __resumeAllClawsForSigOnline → __resumeOnline('93')
		__emitSigState('disconnected');
		__emitSigState('connected');
		await new Promise((r) => setTimeout(r, 10));

		// 断言：typeChanged 标记已被 __ensureRtc 成功路径消费 → __resumeOnline 不会升级为
		// triggerRestart('online_resume')。fakeRtc.state='connected' + restartPaused=false →
		// 走 __ensureRtc 早退路径（rtc.state==='connected'），triggerRestart/resumeRecovery 都不调
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
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

	test('network:online + typeChanged + !initialized → 跳过（initialized gate 短路，rtc=null 分支不介入）', async () => {
		const store = useClawsStore();
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: null, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		// 用 online=false 建 claw → __bridgeConn 不触发 __fullInit（L509 分支条件不成立）
		// → _rtcInitInProgress 不被占用、initialized 保持 false
		// 再手动置 online=true 以让 online gate 放行，仅 !initialized 作为真正的拦截点
		store.addOrUpdateClaw({ id: '97', name: 'Bot', online: false });
		store.__bridgeConn('97');
		store.byId['97'].online = true;
		store.byId['97'].dcReady = true;
		mockCloseRtcForBot.mockClear();
		mockInitRtc.mockClear();

		emitForegroundResume('network:online', { typeChanged: true });
		await new Promise((r) => setTimeout(r, 50));
		// 未发起任何 rebuild：既不走 rtc=null 的新分支，也不走 failed/closed 分支
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
		expect(mockInitRtc).not.toHaveBeenCalled();
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

	test('network:online + initialized + rtc=null + rtcPhase=failed → 立即 rebuild（抢退避时机）', async () => {
		const store = useClawsStore();
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: null, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '99c', name: 'Bot', online: false });
		store.byId['99c'].online = true;
		store.byId['99c'].initialized = true;
		store.byId['99c'].dcReady = false;
		store.byId['99c'].rtcPhase = 'failed';
		store.__bridgeConn('99c');
		mockInitRtc.mockClear();

		emitForegroundResume('network:online', { typeChanged: true });
		await vi.waitFor(() => {
			expect(mockInitRtc).toHaveBeenCalledWith('99c', fakeConn, expect.any(Object));
		});
		expect(store.byId['99c'].rtcPhase).toBe('ready');
	});

	test('network:online + initialized + rtc=null + !dcReady + rtcPhase=recovering → 立即 rebuild', async () => {
		const store = useClawsStore();
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: null, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '99d', name: 'Bot', online: false });
		store.byId['99d'].online = true;
		store.byId['99d'].initialized = true;
		store.byId['99d'].dcReady = false;
		store.byId['99d'].rtcPhase = 'recovering';
		store.__bridgeConn('99d');
		mockInitRtc.mockClear();

		emitForegroundResume('network:online', { typeChanged: false });
		await vi.waitFor(() => {
			expect(mockInitRtc).toHaveBeenCalledWith('99d', fakeConn, expect.any(Object));
		});
		expect(store.byId['99d'].rtcPhase).toBe('ready');
	});

	test('network:online + initialized + rtc=null + !dcReady + rtcPhase=idle → 立即 rebuild（覆盖默认 phase）', async () => {
		const store = useClawsStore();
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: null, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		// createClawState 默认 rtcPhase='idle' + dcReady=false —— 覆盖"!dcReady"侧的触发
		// 路径，防止未来条件收紧成 phase in {failed, recovering} 而静默丢失 idle 场景
		store.addOrUpdateClaw({ id: '99f', name: 'Bot', online: false });
		store.byId['99f'].online = true;
		store.byId['99f'].initialized = true;
		store.__bridgeConn('99f');
		mockInitRtc.mockClear();

		emitForegroundResume('network:online', { typeChanged: true });
		await vi.waitFor(() => {
			expect(mockInitRtc).toHaveBeenCalledWith('99f', fakeConn, expect.any(Object));
		});
		expect(store.byId['99f'].rtcPhase).toBe('ready');
	});

	test('network:online + initialized + rtc=null + rtcPhase=ready + dcReady=true → 跳过（防御性边界，不应存在的组合）', async () => {
		const store = useClawsStore();
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: null, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '99e', name: 'Bot', online: false });
		store.byId['99e'].online = true;
		store.byId['99e'].initialized = true;
		store.byId['99e'].dcReady = true;
		store.byId['99e'].rtcPhase = 'ready';
		store.__bridgeConn('99e');
		mockInitRtc.mockClear();

		emitForegroundResume('network:online', { typeChanged: true });
		await new Promise((r) => setTimeout(r, 50));
		expect(mockInitRtc).not.toHaveBeenCalled();
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

	test('__checkAndRecover probe 失败 + PC 变 failed → 走 __ensureRtc rebuild', async () => {
		const store = useClawsStore();
		// probe 返回 false 且 PC 在 probe 期间变为 failed —— triggerRestart 会被 service 端 gate 哑火，
		// 必须直接 rebuild 与 pre-probe 路径对称
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
		mockInitRtc.mockClear();
		mockRemoteLog.mockClear();

		await store.__checkAndRecover('95', 'app:foreground');
		expect(fakeRtc.probe).toHaveBeenCalled();
		// triggerRestart 在 failed 状态会被服务层 gate 哑火，必须改走 rebuild
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
		await vi.waitFor(() => {
			expect(mockCloseRtcForBot).toHaveBeenCalledWith('95');
			expect(mockInitRtc).toHaveBeenCalled();
		});
		expect(mockRemoteLog).toHaveBeenCalledWith(expect.stringContaining('probe_failed_pc_failed action=rebuild source=app:foreground'));
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

	test('__checkAndRecover probe 失败 + PC 变 closed → 走 __ensureRtc rebuild', async () => {
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
		mockInitRtc.mockClear();
		mockRemoteLog.mockClear();

		await store.__checkAndRecover('99', 'manual');
		// closed 同样走 rebuild（triggerRestart 会被服务层 gate 哑火）
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
		await vi.waitFor(() => {
			expect(mockCloseRtcForBot).toHaveBeenCalledWith('99');
			expect(mockInitRtc).toHaveBeenCalled();
		});
		expect(mockRemoteLog).toHaveBeenCalledWith(expect.stringContaining('probe_failed_pc_closed action=rebuild source=manual'));
	});

	test('__checkAndRecover probe 失败 + PC 变 restarting → triggerRestart(probe_failed)', async () => {
		const store = useClawsStore();
		// probe 期间 PC 进入 transient restarting（非 failed/closed）→ 维持 triggerRestart 路径，不 rebuild
		const fakeRtc = { state: 'connected', probe: vi.fn().mockImplementation(async () => {
			fakeRtc.state = 'restarting';
			return false;
		}), triggerRestart: vi.fn() };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc,
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '99r', name: 'RestartingBot', online: true }]);
		store.byId['99r'].dcReady = true;
		store.byId['99r'].rtcPhase = 'ready';
		mockCloseRtcForBot.mockClear();
		mockInitRtc.mockClear();
		mockRemoteLog.mockClear();

		await store.__checkAndRecover('99r');
		expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('probe_failed');
		// transient 路径不动 rtcPhase，也不 rebuild
		expect(store.byId['99r'].rtcPhase).toBe('ready');
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
		expect(mockInitRtc).not.toHaveBeenCalled();
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

	test('addOrUpdateClaw 不覆盖 online（GATED_FIELDS 防御性契约）', () => {
		// 外部 review round 5 #2：server 当前 claw.bound / claw.nameUpdated payload 不带 online，
		// 但该契约是隐式的。UI 侧用 GATED_FIELDS 把 online 纳入黑名单，防御未来 server 误发
		// 旁路绕过 updateClawOnline / applySnapshot 的 gate 副作用（pause/resume/retry 清理）。
		const store = useClawsStore();
		const fakeConn = { on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(), rtc: null, request: vi.fn().mockResolvedValue({}) };
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: '2', name: 'Bot', online: false });
		expect(store.byId['2'].online).toBe(false);

		// 模拟未来 server 扩展 payload 意外带了 online=true
		store.addOrUpdateClaw({ id: '2', name: 'Renamed', online: true });
		expect(store.byId['2'].name).toBe('Renamed'); // 非 gated 字段正常更新
		expect(store.byId['2'].online).toBe(false); // online 被拒，保持原值
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

	test('rtc.state === connected + restartPaused=true → 调 resumeRecovery + __ensureRtc 早退（不刷 dashboard）', async () => {
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
		// 等一小窗：connected + paused → resumeRecovery + __ensureRtc 早退
		await new Promise((r) => setTimeout(r, 10));

		// connected + paused 走 resumeRecovery，不 triggerRestart、不 rebuild
		expect(fakeRtc.resumeRecovery).toHaveBeenCalled();
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
		expect(mockInitRtc).not.toHaveBeenCalled();
		// DC 延续场景 → dashboard 与 agents/sessions/topics 对称不刷
		expect(dashboardStore.loadDashboard).not.toHaveBeenCalled();
	});

	test('rtc.state === connected + restartPaused=false → 不调 resumeRecovery（无需解冻；不刷 dashboard）', async () => {
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
		await new Promise((r) => setTimeout(r, 10));

		expect(fakeRtc.resumeRecovery).not.toHaveBeenCalled();
		// DC 延续场景 → dashboard 不单独刷
		expect(dashboardStore.loadDashboard).not.toHaveBeenCalled();
	});

	test('rtc.state === connected → __ensureRtc 早退校正 dcReady（不 rebuild，不刷 dashboard）', async () => {
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
		await new Promise((r) => setTimeout(r, 10));
		// 不会 rebuild（initRtc 不被调）
		expect(mockInitRtc).not.toHaveBeenCalled();
		// triggerRestart 只在 restarting 分支调用
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
		// __ensureRtc 早退后把 dcReady 同步为 true
		expect(store.byId['1'].dcReady).toBe(true);
		expect(store.byId['1'].rtcPhase).toBe('ready');
		// DC 延续场景 → dashboard 不单独刷
		expect(dashboardStore.loadDashboard).not.toHaveBeenCalled();
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

	// P1-1: 与 null/closed/failed 对称——idle / connecting 也归为 rebuild 分支
	test('rtc.state === idle → __ensureRtc 走 rebuild（与 null/closed 对称）', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'idle', triggerRestart: vi.fn(), restartPaused: false };
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

	test('rtc.state === connecting → __ensureRtc 走 rebuild（与 null/closed 对称）', async () => {
		const store = useClawsStore();
		const fakeRtc = { state: 'connecting', triggerRestart: vi.fn(), restartPaused: false };
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

	test('rtc.state === closed → __ensureRtc 走 rebuild + 预定 force refresh（与 null/failed 对称）', async () => {
		// __resumeOnline 的 dcContinuous 只识别 connected/restarting；closed/idle/connecting 都归为 rebuild 分支，
		// 走 _pendingForceRefreshOnRebuild.add + __ensureRtc；本 test 锁定 closed 也落在安全 fallback
		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(useSessionsStore(), 'loadSessionsForClaw').mockResolvedValue();
		vi.spyOn(useTopicsStore(), 'loadTopicsForClaw').mockResolvedValue();
		vi.spyOn(useDashboardStore(), 'loadDashboard').mockResolvedValue();

		const fakeRtc = { state: 'closed', triggerRestart: vi.fn(), restartPaused: false };
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;
		store.byId['1'].dcReady = false;

		// 让 __ensureRtc 内 initRtc 成功，以便通过 consume 间接验证 add 标记
		mockInitRtc.mockReset().mockImplementation(async (_id, conn) => {
			conn.rtc = __fakeRtc;
			return 'rtc';
		});

		store.__resumeOnline('1');

		await vi.waitFor(() => {
			expect(mockInitRtc).toHaveBeenCalled();
		});
		// closed → rebuild 分支，不 triggerRestart
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
		// _pendingForceRefreshOnRebuild 被 add + consume → force refresh 触发 agents.loadAgents
		await vi.waitFor(() => {
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('1');
		});
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

	test('集成：offline → resume (restarting+paused) → 不刷 + triggerRestart（DC 延续）', async () => {
		// round 7 简化：DC 延续场景（restarting+paused）不刷——SCTP 跨 ICE restart 存活，
		// plugin 侧缓冲的 rpc msg 会随 ICE 恢复自然送达。只有 rebuild 才 refresh
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

		// Step 2: resume online → triggerRestart('online_resume')，不发 refresh
		store.__resumeOnline('1');
		expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('online_resume');

		// DC 延续：4 个下游 loader 不被调（rpc msg 会随 ICE 恢复自然送达）
		await new Promise((r) => setTimeout(r, 20));
		expect(agentsStore.loadAgents).not.toHaveBeenCalled();
		expect(sessionsStore.loadSessionsForClaw).not.toHaveBeenCalled();
		expect(topicsStore.loadTopicsForClaw).not.toHaveBeenCalled();
		expect(dashboardStore.loadDashboard).not.toHaveBeenCalled();

		// Step 3: 模拟 WebRtcConnection 内部 restart 成功 → onRtcStateChange('connected')
		// 因 dcReady 整段为 true，wasDisconnected=false → 不走 __refreshIfStale
		store.__rtcCallbacks('1').onRtcStateChange('connected');
		expect(store.byId['1'].dcReady).toBe(true);
		expect(store.byId['1'].rtcPhase).toBe('ready');
		// connected 分支兜底清 disconnectedAt（修 pre-existing 累积 stamp 漏洞）
		expect(store.byId['1'].disconnectedAt).toBe(0);
		// 短窗再等一下——不应触发 refresh
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

	test('集成：connected-throughout-offline → 不刷（DC 延续，plugin rpc msg 自然送达）', async () => {
		// round 7 简化：DC 延续场景不刷——PC 整段保持 connected，SCTP 从未断，
		// plugin 侧缓冲的 rpc msg 会在 resume 后随 DC 自然送达 UI
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

		// Step 2: online → __resumeOnline（connected 路径：DC 延续，所有 4 个 loader 对称不刷）
		store.__resumeOnline('1');

		// DC 延续场景：4 个 loader 全部对称不刷（dashboard 也不单独加载）
		await new Promise((r) => setTimeout(r, 20));
		expect(agentsStore.loadAgents).not.toHaveBeenCalled();
		expect(sessionsStore.loadSessionsForClaw).not.toHaveBeenCalled();
		expect(topicsStore.loadTopicsForClaw).not.toHaveBeenCalled();
		expect(dashboardStore.loadDashboard).not.toHaveBeenCalled();

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

	test('connected 分支：DC 延续场景不刷（plugin 侧 rpc msg 会随 ICE 恢复自然送达）', () => {
		// round 7 简化：只有 rebuild 才刷——PC 没换，SCTP 延续，plugin 侧缓冲的 rpc msg
		// 会随 ICE 恢复自然送达 UI；主动 refresh 是冗余流量
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

		// connected 路径：4 个 loader 对称不刷
		expect(agentsStore.loadAgents).not.toHaveBeenCalled();
		expect(useSessionsStore().loadSessionsForClaw).not.toHaveBeenCalled();
		expect(useTopicsStore().loadTopicsForClaw).not.toHaveBeenCalled();
		expect(useDashboardStore().loadDashboard).not.toHaveBeenCalled();
	});

	test('restarting+paused 分支：DC 延续场景不刷（SCTP 跨 ICE restart 存活）', () => {
		// round 7 简化：同上，PC 没 rebuild、SCTP 延续，不需要主动刷
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

		// restarting 路径：4 个 loader 对称不刷；但仍 triggerRestart('online_resume') 穿透 paused gate
		expect(agentsStore.loadAgents).not.toHaveBeenCalled();
		expect(useSessionsStore().loadSessionsForClaw).not.toHaveBeenCalled();
		expect(useTopicsStore().loadTopicsForClaw).not.toHaveBeenCalled();
		expect(useDashboardStore().loadDashboard).not.toHaveBeenCalled();
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
		expect(useTopicsStore().loadTopicsForClaw).toHaveBeenCalledWith('1');
		// dashboard 也由 refreshClawResources 统一刷（P1.1/1.2 修法后唯一触发点）
		expect(useDashboardStore().loadDashboard).toHaveBeenCalledWith('1');
	});

	test('forceRestartOnConnected + connected+paused：走 triggerRestart 不刷（DC 延续）', async () => {
		// round 7 简化：DC 延续（connected / restarting）一律不刷，不再区分 forceRestart。
		// forceRestart + connected+paused 走 triggerRestart('online_resume')，SCTP 跨 ICE restart
		// 延续，plugin 侧缓冲的 rpc msg 会随 ICE 恢复自然送达。此测试验证：
		// (1) 不发 immediate refresh；(2) 不打 pending 标记；(3) 走 triggerRestart('online_resume')。
		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		const dashboardStore = useDashboardStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadSessionsForClaw').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadTopicsForClaw').mockResolvedValue();
		vi.spyOn(dashboardStore, 'loadDashboard').mockResolvedValue();

		const fakeRtc = {
			state: 'connected',
			restartPaused: true,
			isReady: true,
			pauseRestart: vi.fn(),
			triggerRestart: vi.fn(),
			resumeRecovery: vi.fn(),
		};
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;
		store.byId['1'].dcReady = true;
		store.byId['1'].rtcPhase = 'ready';

		// 关键：forceRestartOnConnected=true 触发 round 5 修复的分支
		store.__resumeOnline('1', { forceRestartOnConnected: true });

		// 断言 1：立即 refresh 没发——下游 4 个 loader 全部未被调
		expect(agentsStore.loadAgents).not.toHaveBeenCalled();
		expect(sessionsStore.loadSessionsForClaw).not.toHaveBeenCalled();
		expect(topicsStore.loadTopicsForClaw).not.toHaveBeenCalled();
		expect(dashboardStore.loadDashboard).not.toHaveBeenCalled();

		// 断言 2：走 triggerRestart('online_resume')（paused gate 唯一穿透 reason）
		expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('online_resume');
		expect(fakeRtc.resumeRecovery).not.toHaveBeenCalled();

		// 断言 3：ICE restart 成功后（SCTP 无缝延续）也不补 refresh
		store.__rtcCallbacks('1').onRtcStateChange('connected');
		await new Promise((r) => setTimeout(r, 20));
		expect(agentsStore.loadAgents).not.toHaveBeenCalled();
	});

	test('forceRestartOnConnected 命中后不污染 _pendingForceRefreshOnRebuild', async () => {
		// 契约保护：forceRestart 分支**不得** `.add(id)` 到 pendingForceRefreshOnRebuild
		// —— 否则后续任何 rebuild 都会误触发 force refresh（覆盖 gap gate 的保护）。
		// 验证方式：forceRestart 走完后切 rebuild（清 rtc→null）+ __ensureRtc 成功，
		// 若 Set 被误污染 loader 会被调；正确实现下 disconnectedAt=0 被 gap gate skip。
		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(useSessionsStore(), 'loadSessionsForClaw').mockResolvedValue();
		vi.spyOn(useTopicsStore(), 'loadTopicsForClaw').mockResolvedValue();
		vi.spyOn(useDashboardStore(), 'loadDashboard').mockResolvedValue();

		const fakeRtc = {
			state: 'connected',
			restartPaused: true,
			isReady: true,
			pauseRestart: vi.fn(),
			triggerRestart: vi.fn(),
			resumeRecovery: vi.fn(),
		};
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;
		store.byId['1'].dcReady = true;

		store.__resumeOnline('1', { forceRestartOnConnected: true });
		expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('online_resume');
		agentsStore.loadAgents.mockClear();

		// 切 rebuild 路径：模拟 restart 失败后 claw 走 __ensureRtc 重建
		fakeConn.rtc = null;
		store.byId['1'].dcReady = false;
		mockInitRtc.mockClear();
		mockInitRtc.mockResolvedValue('rtc');

		await store.__ensureRtc('1');

		// __ensureRtc 成功路径 consume _pendingForceRefreshOnRebuild：若 forceRestart 分支
		// 误 add 了 id，这里 force=true 会触发 loader。正确实现下标记未被 add → force=false
		// → disconnectedAt=0 被 __refreshIfStale 的 gap gate skip
		await new Promise((r) => setTimeout(r, 10));
		expect(agentsStore.loadAgents).not.toHaveBeenCalled();
	});

	test('forceRestartOnConnected + rebuild 路径：pending 标记触发 rebuild 成功后 force refresh', async () => {
		// round 7 简化：refresh 规则只看"是否 rebuild"——rebuild 建全新 PC + 全新 SCTP，
		// plugin 侧旧 DC 发送 buffer 的 rpc msg 会丢，且 plugin 可能换端，必须主动刷。
		// 此测试验证 forceRestart + rtc=null 的 rebuild 子场景：进入 pending 标记路径，
		// __ensureRtc 成功时 consume 并 force refresh。
		const store = useClawsStore();
		const agentsStore = useAgentsStore();
		const sessionsStore = useSessionsStore();
		const topicsStore = useTopicsStore();
		const dashboardStore = useDashboardStore();
		vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
		vi.spyOn(sessionsStore, 'loadSessionsForClaw').mockResolvedValue();
		vi.spyOn(topicsStore, 'loadTopicsForClaw').mockResolvedValue();
		vi.spyOn(dashboardStore, 'loadDashboard').mockResolvedValue();

		// PC 需要 rebuild 的状态：rtc=null
		const fakeConn = { rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;
		store.byId['1'].dcReady = false;
		store.byId['1'].rtcPhase = 'failed';

		mockInitRtc.mockClear();
		mockInitRtc.mockResolvedValue('rtc');

		// forceRestart + rtc=null → 不跳过 refresh，改走 pending 标记
		store.__resumeOnline('1', { forceRestartOnConnected: true });

		// rebuild 成功路径 consume pending → __refreshIfStale({force:true}) 触发所有 loader
		await vi.waitFor(() => {
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('1');
		});
		expect(sessionsStore.loadSessionsForClaw).toHaveBeenCalledWith('1');
		expect(topicsStore.loadTopicsForClaw).toHaveBeenCalledWith('1');
		expect(dashboardStore.loadDashboard).toHaveBeenCalledWith('1');
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

	test('__ensureRtc post-await recheck：initRtc 期间 claw 翻 offline → 回收 RTC + rtcPhase=failed', async () => {
		// round 6 #2：pre-existing race——循环头检查 gate 后、await initRtc 期间 gate 可能翻转。
		// offline handler 此时只能调 conn.rtc?.pauseRestart()，但 initRtc 未 resolve 时 conn.rtc=null
		// 空转；initRtc resolve 成功后的成功分支若不再次 recheck，新建的 RTC 就越过关着的门。
		// 此 test 验证修法：post-await 检测到 offline 时 closeRtcForClaw + clearRtc + 走 bail 分支。
		//
		// 关键：mockCloseRtcForBot 模拟生产真实副作用——同步触发 onStateChange('closed')，
		// 让 store `__rtcCallbacks` 写 rtcPhase='failed'，与 bail 分支的 `if (bailReason==='offline')`
		// 形成重复写入但一致的语义。若 fix 错漏，此 mock 能帮助捕获副作用偏差。
		const store = useClawsStore();
		const fakeConn = {
			rtc: null,
			on: vi.fn(), off: vi.fn(),
			clearRtc: vi.fn(() => { fakeConn.rtc = null; }),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;

		// 捕获 initRtc 传入的 callbacks 供 closeRtc mock 回放 onStateChange('closed')
		let capturedCallbacks;
		let resolveInit;
		mockInitRtc.mockImplementation((id, conn, callbacks) => {
			capturedCallbacks = callbacks;
			return new Promise((r) => { resolveInit = r; });
		});
		mockCloseRtcForBot.mockImplementation(() => {
			capturedCallbacks?.onRtcStateChange?.('closed');
		});

		const pending = store.__ensureRtc('1');
		await Promise.resolve();
		await Promise.resolve();

		// 翻 offline（模拟 SSE 推 claw.status=false）
		store.byId['1'].online = false;

		// initRtc 成功 resolve 返回 'rtc'
		resolveInit('rtc');
		await pending;

		// 验证 post-await bail 效果：
		expect(store.byId['1'].dcReady).toBe(false);
		expect(store.byId['1'].rtcPhase).toBe('failed');
		expect(fakeConn.clearRtc).toHaveBeenCalled();
		expect(mockCloseRtcForBot).toHaveBeenCalledWith('1');
	});

	test('__ensureRtc post-await recheck：initRtc 期间 sig 掉线 → 回收 RTC + rtcPhase 不变', async () => {
		// round 6 #2 对照：sig_offline bail 不改 rtcPhase（sig 是环境故障，sig 回来时走 resume 路径，
		// 不应被标成 unreachable 触发 UI banner）。
		//
		// 关键：mock 真实触发 onStateChange('closed') 副作用——若只靠 bail 分支的 `if (bailReason==='offline')`
		// 保护 rtcPhase 不被写，callback 会抢先写成 'failed'，违反设计意图。修法需 snapshot + restore rtcPhase。
		const store = useClawsStore();
		const fakeConn = {
			rtc: null,
			on: vi.fn(), off: vi.fn(),
			clearRtc: vi.fn(() => { fakeConn.rtc = null; }),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;
		store.byId['1'].rtcPhase = 'building'; // 预设，确认 sig_offline 不覆写
		store.__bridgeLifecycle();

		let capturedCallbacks;
		let resolveInit;
		mockInitRtc.mockImplementation((id, conn, callbacks) => {
			capturedCallbacks = callbacks;
			return new Promise((r) => { resolveInit = r; });
		});
		mockCloseRtcForBot.mockImplementation(() => {
			capturedCallbacks?.onRtcStateChange?.('closed');
		});

		const pending = store.__ensureRtc('1');
		await Promise.resolve();
		await Promise.resolve();

		// sig 掉线
		__emitSigState('disconnected');

		resolveInit('rtc');
		await pending;

		expect(store.byId['1'].dcReady).toBe(false);
		// sig_offline bail：closeRtcForClaw 的 onStateChange('closed') 副作用会尝试写 rtcPhase='failed'，
		// 但修法 snapshot + restore 保留原值 'building'
		expect(store.byId['1'].rtcPhase).toBe('building');
		expect(fakeConn.clearRtc).toHaveBeenCalled();
	});

	test('__ensureRtc post-await recheck：sig 掉线 → disconnectedAt 不被 closeRtcForClaw 副作用污染', async () => {
		// 配套 rtcPhase snapshot 的 disconnectedAt 同步修法：sig_offline bail 时 closeRtcForClaw
		// 触发 onRtcStateChange('closed') 会写 disconnectedAt=Date.now()。若不 snapshot+restore，
		// sig 恢复后 gap-aware refresh 看到虚假的 disconnectedAt（几毫秒 gap）误判短断跳过刷新，
		// 破坏"sig 是环境故障不污染 DC 生命周期"原则。
		const store = useClawsStore();
		const fakeConn = {
			rtc: null,
			on: vi.fn(), off: vi.fn(),
			clearRtc: vi.fn(() => { fakeConn.rtc = null; }),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;
		store.byId['1'].rtcPhase = 'building';
		store.byId['1'].disconnectedAt = 0; // 预设 healthy 值
		store.__bridgeLifecycle();

		let capturedCallbacks;
		let resolveInit;
		mockInitRtc.mockImplementation((id, conn, callbacks) => {
			capturedCallbacks = callbacks;
			return new Promise((r) => { resolveInit = r; });
		});
		mockCloseRtcForBot.mockImplementation(() => {
			capturedCallbacks?.onRtcStateChange?.('closed');
		});

		const pending = store.__ensureRtc('1');
		await Promise.resolve();
		await Promise.resolve();

		__emitSigState('disconnected');

		resolveInit('rtc');
		await pending;

		// sig_offline bail + snapshot+restore：disconnectedAt 保持 0（不被 closeRtc 副作用污染）
		expect(store.byId['1'].disconnectedAt).toBe(0);
		// rtcPhase 同理保持 snapshot 值（round 6 既有断言）
		expect(store.byId['1'].rtcPhase).toBe('building');
	});

	test('__ensureRtc post-await recheck：initRtc 期间 claw 被 removed → 回收 RTC + 无 claw 对象残留', async () => {
		// post-await 三连的 removed 分支补测：initRtc 成功 resolve 前 `delete store.byId[id]`，
		// bail 走 'removed' 分支——必须同样调 closeRtcForClaw + conn.clearRtc 回收资源，
		// 且 _rtcInitInProgress 锁清掉，避免后续 claw 重新出现时被锁卡死。
		const store = useClawsStore();
		const fakeConn = {
			rtc: null,
			on: vi.fn(), off: vi.fn(),
			clearRtc: vi.fn(() => { fakeConn.rtc = null; }),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;

		let resolveInit;
		mockInitRtc.mockImplementation(() => {
			return new Promise((r) => { resolveInit = r; });
		});

		const pending = store.__ensureRtc('1');
		await Promise.resolve();
		await Promise.resolve();

		// 模拟 removeClawById 效果的核心：claw 对象消失
		delete store.byId['1'];

		resolveInit('rtc');
		await pending;

		// removed bail：回收资源
		expect(mockCloseRtcForBot).toHaveBeenCalledWith('1');
		expect(fakeConn.clearRtc).toHaveBeenCalled();
		expect(store.byId['1']).toBeUndefined();
		// 测锁是否清干净：重新添加 claw 后 __ensureRtc 能再次 fire initRtc
		// 若 finally 未清 _rtcInitInProgress，入口早退，mockInitRtc 不会被再次调
		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;
		mockInitRtc.mockClear();
		mockInitRtc.mockResolvedValue('failed');
		await store.__ensureRtc('1');
		expect(mockInitRtc).toHaveBeenCalled();
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

	// P1-2: dashboard 双锁——sig offline 期间，claw online 翻 false→true 不应同步 dashboard online；
	// 直到 sig 回来才由 __resumeAllClawsForSigOnline 真正补上
	test('claw offline + sig offline → dashboard.online=false；sig 仍 offline 时翻 online=true 不同步 dashboard；sig 回来再补', () => {
		const store = useClawsStore();
		const dashboardStore = useDashboardStore();

		// 预置 dashboard 缓存（含 instance.online=true）
		setupClaw(store, { id: '1', online: true });
		dashboardStore.byClaw['1'] = {
			loading: false, error: null,
			instance: { name: 'Bot', online: true }, agents: [],
		};

		store.__bridgeLifecycle();

		// 1) claw 离线 → __handleClawGoOffline 调 syncDashboardOffline，instance.online=false
		store.updateClawOnline('1', false);
		expect(dashboardStore.byClaw['1'].instance.online).toBe(false);

		// 2) sig 掉线（freeze 不动 dashboard）
		__emitSigState('disconnected');
		expect(dashboardStore.byClaw['1'].instance.online).toBe(false);

		// 3) sig 仍 offline 时 claw 翻 online=true：__resumeOnline 入口 _sigOffline gate 早退，
		//    syncDashboardOnline 不被调用，dashboard 保持 false
		store.updateClawOnline('1', true);
		expect(dashboardStore.byClaw['1'].instance.online).toBe(false);

		// 4) sig 恢复：__resumeAllClawsForSigOnline 遍历，对 online=true 的 claw 调 __resumeOnline
		//    → syncDashboardOnline 写回 true
		__emitSigState('connected');
		expect(dashboardStore.byClaw['1'].instance.online).toBe(true);
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

	test('#1 对称补：!initialized + conn 未 bridge → 跳过不 fire __fullInit，initialized 保持 false', () => {
		// 镜像 applySnapshot Phase 3 补救的 conn-missing 分支（见 applySnapshot 测试 conn 未 bridge）。
		// 源码：__resumeAllClawsForSigOnline 遍历到 online=true + !initialized + conn missing
		// 时 continue（claws.store.js:631），等下一次 __bridgeConn 接手；不抛、不改
		// initialized、不触发 fullInit。
		__mockSigState = 'disconnected';
		const store = useClawsStore();
		store.byId['1'] = { ...createTestClaw('1'), online: true, initialized: false };
		store.fetched = true;
		mockManager.get.mockReturnValue(null); // conn 尚未 bridge
		store.__bridgeLifecycle();
		const fullInitSpy = vi.spyOn(store, '__fullInit').mockResolvedValue();
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		expect(() => __emitSigState('connected')).not.toThrow();

		expect(fullInitSpy).not.toHaveBeenCalled();
		expect(store.byId['1'].initialized).toBe(false);
		expect(store.byId['1'].__initAttempt).toBeUndefined();
		// 不应走 fullInit catch 分支
		expect(warnSpy).not.toHaveBeenCalledWith(
			expect.stringContaining('fullInit (sig resume) failed'),
			expect.anything(),
			expect.anything(),
		);
		warnSpy.mockRestore();
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

	test('#2 round4: 主循环 connected+paused + typeChanged 不发 triggerRestart，Set 保留给 resume 消费', () => {
		// 背景：WebRtcConnection.__attemptRestart 的 paused gate 只接受 reason='online_resume'，
		// 其他 reason（包括 'network_type_changed'）会被 drop（webrtc-connection.js:969-973）。
		// 若 connected+paused+typeChanged 时直接发 'network_type_changed' triggerRestart 且
		// 同时 delete Set → restart 没发 + 记账丢失 = 信号永久丢失。
		// 正确行为：paused 分支不发 triggerRestart，保留 Set 给后续 __resumeOnline 消费升级。
		const store = useClawsStore();
		const { fakeRtc } = setupClaw(store, { rtcState: 'connected', restartPaused: true });
		store.__bridgeLifecycle();

		store.__handleNetworkOnline(true);
		// paused 态 + typeChanged：主循环识别到 paused，不发 triggerRestart，不清 Set
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();

		// 后续 sig down/up → __resumeAllClawsForSigOnline → __resumeOnline 消费保留的 Set 条目
		// → connected+paused + forceRestartOnConnected → triggerRestart('online_resume')
		// （online_resume 是 paused gate 唯一穿透 reason，restart 能真正生效）
		__emitSigState('disconnected');
		__emitSigState('connected');

		expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('online_resume');
		expect(fakeRtc.resumeRecovery).not.toHaveBeenCalled();
	});

	test('#2 round4 对照组: 主循环 connected+!paused + typeChanged 直接发 network_type_changed 并清 Set', () => {
		// 对照：非 paused 态下 triggerRestart('network_type_changed') 正常生效，Set 清除，
		// 下次 __resumeOnline 走 resumeRecovery 不虚发。
		const store = useClawsStore();
		const { fakeRtc } = setupClaw(store, { rtcState: 'connected', restartPaused: false });
		store.__bridgeLifecycle();

		store.__handleNetworkOnline(true);
		// willHandleNow=true 的 claw 预循环本来就不进 Set，主循环正常发 network_type_changed
		expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('network_type_changed');
		fakeRtc.triggerRestart.mockClear();

		// Set 为空 → 后续 sig resume → 走 resumeRecovery（restartPaused 需模拟被 freeze 置为 true）
		fakeRtc.restartPaused = true; // 模拟 __freezeAllClawsForSigOffline 效果
		__emitSigState('disconnected');
		__emitSigState('connected');

		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
		expect(fakeRtc.resumeRecovery).toHaveBeenCalledTimes(1);
	});

	test('#2 round9: 主循环 restarting+paused + typeChanged 不发 nudgeRestart，Set 保留给 resume 消费', () => {
		// 背景：与 connected+paused 分支对称。__attemptRestart 的 paused gate 只接受 'online_resume'
		// （webrtc-connection.js:975）；nudgeRestart → __attemptRestart('nudge') 在 paused 态被 drop。
		// 若此时 delete Set → restart 没发 + 记账丢失 = 信号永久丢失。
		// 正确行为：paused 分支不发 nudgeRestart，保留 Set 给后续 __resumeOnline 消费升级。
		const store = useClawsStore();
		const { fakeRtc } = setupClaw(store, { rtcState: 'restarting', restartPaused: true });
		store.__bridgeLifecycle();

		store.__handleNetworkOnline(true);
		// paused+restarting：主循环识别到 paused，不发 nudgeRestart、不清 Set
		expect(fakeRtc.nudgeRestart).not.toHaveBeenCalled();
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();

		// 后续 sig down/up → __resumeAllClawsForSigOnline → __resumeOnline 消费保留的 Set 条目
		// → restarting+paused 分支发 triggerRestart('online_resume')（paused gate 唯一穿透 reason）
		__emitSigState('disconnected');
		__emitSigState('connected');

		expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('online_resume');
		expect(fakeRtc.nudgeRestart).not.toHaveBeenCalled();
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

	// -------- multi-claw integration scenarios：试图暴露 module-level Map/Set 串扰 --------

	/**
	 * 多 claw setup helper：批量构造 fakeRtc/fakeConn，mockManager.get 按 id 分派。
	 * 返回 { [id]: { fakeRtc, fakeConn } } 供断言使用。
	 * @param {object} store - pinia store 实例
	 * @param {Array<{id: string, online?: boolean, rtcState?: string, restartPaused?: boolean, initialized?: boolean, dcReady?: boolean, hasConn?: boolean}>} specs
	 */
	function setupClaws(store, specs) {
		/** @type {Record<string, {fakeRtc: object, fakeConn: object|null}>} */
		const map = {};
		for (const s of specs) {
			const rtcState = s.rtcState ?? 'connected';
			const fakeRtc = {
				state: rtcState,
				isReady: rtcState === 'connected',
				restartPaused: s.restartPaused ?? false,
				pauseRestart: vi.fn(),
				resumeRecovery: vi.fn(),
				triggerRestart: vi.fn(),
				nudgeRestart: vi.fn(),
				probe: vi.fn().mockResolvedValue(true),
			};
			const fakeConn = s.hasConn === false
				? null
				: { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
			map[s.id] = { fakeRtc, fakeConn };
			store.byId[s.id] = {
				...createTestClaw(s.id),
				online: s.online ?? true,
				initialized: s.initialized ?? true,
				dcReady: s.dcReady ?? (rtcState === 'connected'),
			};
		}
		mockManager.get.mockImplementation((x) => map[String(x)]?.fakeConn ?? null);
		store.fetched = true;
		return map;
	}

	test('multi-claw: typeChanged 记账 per-claw 隔离 — A 消费后 B 记账仍保留到 sig resume', () => {
		// 场景 A：2 claw 都 paused → `__handleNetworkOnline(true)` 同时记账进 Set；
		// 随后仅 A 走 offline→online，只消费 A 的记账，B 的记账必须保留；
		// 下一轮 sig down/up 周期里 A 已无记账（走 resumeRecovery），B 仍有记账（升级 triggerRestart）。
		// 暴露意图：Set 的 delete 是否按 id 精确、不误删其它 claw 的条目。
		const store = useClawsStore();
		const claws = setupClaws(store, [
			{ id: 'A', rtcState: 'connected', restartPaused: true },
			{ id: 'B', rtcState: 'restarting', restartPaused: true },
		]);
		store.__bridgeLifecycle();

		// 1) sig 在线时 typeChanged=true：两个都 paused → willHandleNow=false → 都进 Set
		store.__handleNetworkOnline(true);
		// paused 分支不会立即 trigger/nudge（defer_to_resume）
		expect(claws.A.fakeRtc.triggerRestart).not.toHaveBeenCalled();
		expect(claws.B.fakeRtc.nudgeRestart).not.toHaveBeenCalled();
		expect(claws.B.fakeRtc.triggerRestart).not.toHaveBeenCalled();

		// 2) A 走 offline→online：updateClawOnline 分派 __resumeOnline('A') → 消费 Set['A']
		//    connected+paused + forceRestart=true → triggerRestart('online_resume')
		store.updateClawOnline('A', false);
		claws.A.fakeRtc.pauseRestart.mockClear();
		store.updateClawOnline('A', true);
		expect(claws.A.fakeRtc.triggerRestart).toHaveBeenCalledWith('online_resume');
		expect(claws.A.fakeRtc.triggerRestart).toHaveBeenCalledTimes(1);
		// B 在这个过程中完全不应被触碰
		expect(claws.B.fakeRtc.triggerRestart).not.toHaveBeenCalled();
		expect(claws.B.fakeRtc.resumeRecovery).not.toHaveBeenCalled();

		// 3) sig down → sig up：__resumeAllClawsForSigOnline 遍历
		//    A: Set 空 → connected+paused 无 force → resumeRecovery
		//    B: Set['B'] 仍在 → restarting+paused+restartPaused=true → triggerRestart('online_resume')
		claws.A.fakeRtc.triggerRestart.mockClear();
		__emitSigState('disconnected');
		__emitSigState('connected');

		expect(claws.A.fakeRtc.resumeRecovery).toHaveBeenCalledTimes(1);
		expect(claws.A.fakeRtc.triggerRestart).not.toHaveBeenCalled();
		expect(claws.B.fakeRtc.triggerRestart).toHaveBeenCalledWith('online_resume');
		expect(claws.B.fakeRtc.triggerRestart).toHaveBeenCalledTimes(1);
	});

	test('multi-claw: sig cycle 对三态 claw 的分派（initialized / !initialized / offline）', () => {
		// 场景 B：3 claw 各自不同状态，验证 __freezeAllClawsForSigOffline 全员 pause +
		// __resumeAllClawsForSigOnline 分派到正确的恢复分支。
		// 暴露意图：遍历到任一 claw 时若 helper 选错分支（如把 !initialized 当 initialized
		// 处理、或把 offline claw 也 resume），会被断言捕获。
		const store = useClawsStore();
		const claws = setupClaws(store, [
			{ id: 'A', online: true, initialized: true, rtcState: 'connected', restartPaused: true },
			{ id: 'B', online: true, initialized: false, rtcState: 'idle', dcReady: false },
			{ id: 'C', online: false, initialized: true, rtcState: 'failed', dcReady: false },
		]);
		store.__bridgeLifecycle();
		const fullInitSpy = vi.spyOn(store, '__fullInit').mockResolvedValue();
		const resumeSpy = vi.spyOn(store, '__resumeOnline');

		// sig down：遍历全员 pauseRestart（不区分 online/initialized，幂等安全）
		__emitSigState('disconnected');
		expect(claws.A.fakeRtc.pauseRestart).toHaveBeenCalledTimes(1);
		expect(claws.B.fakeRtc.pauseRestart).toHaveBeenCalledTimes(1);
		expect(claws.C.fakeRtc.pauseRestart).toHaveBeenCalledTimes(1);

		// sig up：A 走 __resumeOnline；B 走 __fullInit；C 完全跳过
		__emitSigState('connected');

		// A: initialized=true → __resumeOnline('A')
		expect(resumeSpy).toHaveBeenCalledWith('A');
		expect(resumeSpy).not.toHaveBeenCalledWith('B');
		expect(resumeSpy).not.toHaveBeenCalledWith('C');
		expect(claws.A.fakeRtc.resumeRecovery).toHaveBeenCalledTimes(1);

		// B: !initialized + conn 存在 → __fullInit
		expect(fullInitSpy).toHaveBeenCalledTimes(1);
		expect(fullInitSpy).toHaveBeenCalledWith('B', claws.B.fakeConn);
		expect(store.byId['B'].initialized).toBe(true);
		expect(store.byId['B'].__initAttempt).toBe(1);

		// C: offline → 既不 resume 也不 fullInit
		expect(store.byId['C'].initialized).toBe(true); // 未被改动
		expect(claws.C.fakeRtc.resumeRecovery).not.toHaveBeenCalled();
		expect(claws.C.fakeRtc.triggerRestart).not.toHaveBeenCalled();
	});

	test('multi-claw: 混合 offline/online 的 sig 冻结/解冻（B offline 不被误 resume）', () => {
		// 场景 C：A online+connected，B offline+failed。
		// 冻结阶段两者都 pauseRestart（幂等安全），解冻阶段仅 A 被 __resumeOnline，
		// B 保持 offline 态不被动（等 SSE 推 online 时由 updateClawOnline 接手）。
		// 暴露意图：sig resume 遍历是否正确跳过 `!claw.online` 的 claw。
		const store = useClawsStore();
		const claws = setupClaws(store, [
			{ id: 'A', online: true, initialized: true, rtcState: 'connected', restartPaused: false },
			{ id: 'B', online: false, initialized: true, rtcState: 'failed', dcReady: false },
		]);
		// B 的 rtcPhase 置为 failed（offline+failed 的典型状态）
		store.byId['B'].rtcPhase = 'failed';
		store.__bridgeLifecycle();
		const resumeSpy = vi.spyOn(store, '__resumeOnline');

		// sig down：两者都 pause（幂等，B offline 也 pause 无副作用）
		__emitSigState('disconnected');
		expect(claws.A.fakeRtc.pauseRestart).toHaveBeenCalledTimes(1);
		expect(claws.B.fakeRtc.pauseRestart).toHaveBeenCalledTimes(1);

		// sig up：A → __resumeOnline；B offline → 跳过
		// 注意 A 此时 connected+restartPaused=true（__freezeAllClawsForSigOffline 并不会
		// 真的改 fakeRtc.restartPaused；但 __bridgeLifecycle 里 sig=connected 初态 → freeze
		// 未触发。手动把 A 置 paused 模拟 freeze 效果）
		claws.A.fakeRtc.restartPaused = true;
		__emitSigState('connected');

		// A：online 分支走 __resumeOnline → connected+paused 无 Set 记账 → resumeRecovery
		expect(resumeSpy).toHaveBeenCalledWith('A');
		expect(resumeSpy).not.toHaveBeenCalledWith('B');
		expect(claws.A.fakeRtc.resumeRecovery).toHaveBeenCalledTimes(1);
		expect(claws.A.fakeRtc.triggerRestart).not.toHaveBeenCalled();

		// B：offline → 既不 resume 也不 triggerRestart；rtcPhase 保持 failed
		expect(claws.B.fakeRtc.resumeRecovery).not.toHaveBeenCalled();
		expect(claws.B.fakeRtc.triggerRestart).not.toHaveBeenCalled();
		expect(store.byId['B'].rtcPhase).toBe('failed');
	});

	// -------- SSE ordering scenarios：事件到达顺序交织下的分派一致性 --------

	test('SSE ordering: snapshot(online=false) → status(online=true) 走 !initialized 分支 fullInit', () => {
		// 场景 A：snapshot 先到（Phase 1 create、online=false → __bridgeConn 不 fire fullInit、
		// initialized 保持 false），随后 status=online 到 → updateClawOnline 的
		// `!claw.initialized` 分支优先于 `prev === false` 分支，只 fire 一次 fullInit，
		// 不走 __resumeOnline。
		// 暴露意图：updateClawOnline 分支顺序（!initialized 放在 prev=false 之前）是否正确，
		// 避免新建 claw 翻 online 后既 fullInit 又 resume。
		const store = useClawsStore();
		const fakeRtc = {
			state: 'connected', isReady: true, restartPaused: false,
			pauseRestart: vi.fn(), resumeRecovery: vi.fn(), triggerRestart: vi.fn(),
			nudgeRestart: vi.fn(), probe: vi.fn().mockResolvedValue(true),
		};
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockImplementation((x) => (String(x) === '1' ? fakeConn : null));

		// 1) snapshot 先到：online=false、新建 claw、__bridgeConn fire 但 !online 不 fullInit
		store.applySnapshot([{ id: '1', name: 'A', online: false }]);
		expect(store.byId['1']).toBeDefined();
		expect(store.byId['1'].online).toBe(false);
		expect(store.byId['1'].initialized).toBe(false);

		// 给 __fullInit 打 spy（要在 applySnapshot 之后，避免被 snapshot 路径的 fullInit 污染）
		const fullInitSpy = vi.spyOn(store, '__fullInit').mockResolvedValue();
		const resumeSpy = vi.spyOn(store, '__resumeOnline');

		// 2) status 到：updateClawOnline 翻 online=true
		store.updateClawOnline('1', true);

		// !initialized 分支 fire fullInit 一次；prev=false 分支不重复 fire __resumeOnline
		expect(fullInitSpy).toHaveBeenCalledTimes(1);
		expect(fullInitSpy).toHaveBeenCalledWith('1', fakeConn);
		expect(store.byId['1'].initialized).toBe(true);
		expect(store.byId['1'].__initAttempt).toBe(1);
		expect(resumeSpy).not.toHaveBeenCalled();
	});

	test('SSE ordering: status(online=true) before claw exists → no-op + snapshot 后补 fullInit', () => {
		// 场景 B：status 先到（claw 不存在）→ updateClawOnline 应 early return 不崩。
		// 随后 snapshot 到 → Phase 1 create new claw、__bridgeConn 依 online+!initialized
		// fire fullInit 一次；Phase 3 rescue 看到 initialized=true（刚被 __bridgeConn 置）
		// 不重复 fire。
		// 暴露意图：claw 不存在时 updateClawOnline 的健壮性，以及 snapshot 新建路径与
		// Phase 3 rescue 的不重叠。
		const store = useClawsStore();
		const fakeRtc = {
			state: 'connected', isReady: true, restartPaused: false,
			pauseRestart: vi.fn(), resumeRecovery: vi.fn(), triggerRestart: vi.fn(),
			nudgeRestart: vi.fn(), probe: vi.fn().mockResolvedValue(true),
		};
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockImplementation((x) => (String(x) === '1' ? fakeConn : null));
		const fullInitSpy = vi.spyOn(store, '__fullInit').mockResolvedValue();
		const resumeSpy = vi.spyOn(store, '__resumeOnline');

		// 1) status 先到：claw 不存在 → 静默 return（无异常、无副作用）
		expect(() => store.updateClawOnline('1', true)).not.toThrow();
		expect(store.byId['1']).toBeUndefined();
		expect(fullInitSpy).not.toHaveBeenCalled();

		// 2) snapshot 到：Phase 1 创建 + __bridgeConn fire fullInit
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);

		// __bridgeConn 的 online+!initialized 分支 fire fullInit 一次（Phase 3 rescue 因 initialized=true 跳过）
		expect(fullInitSpy).toHaveBeenCalledTimes(1);
		expect(fullInitSpy).toHaveBeenCalledWith('1', fakeConn);
		expect(store.byId['1'].initialized).toBe(true);
		expect(store.byId['1'].__initAttempt).toBe(1);
		expect(resumeSpy).not.toHaveBeenCalled();
	});

	test('SSE ordering: sig=connecting + applySnapshot(no online change) + sig=connected → resume 只走一次', () => {
		// 场景 C：sig 掉线期间 snapshot 到达但 online 值未变、initialized=true。
		// Phase 3 rescue 不应误触发 fullInit（因 initialized=true 跳过 !initialized 补救），
		// 也不应重复添加到 toResume（prev===next 不命中 true→false/false→true 分支，
		// rtcPhase 非 'failed' 不命中兜底）。sig 回来时由 __resumeAllClawsForSigOnline
		// 统一处理，__resumeOnline 只被调 1 次。
		// 暴露意图：sig offline 期间 snapshot 到达是否被 Phase 3 逻辑干净忽略、
		// 不会在 sig resume 时与 resumeAll 形成双调用。
		const store = useClawsStore();
		const { fakeRtc } = setupClaw(store, { id: '1', rtcState: 'connected', restartPaused: false });
		store.__bridgeLifecycle();
		const fullInitSpy = vi.spyOn(store, '__fullInit').mockResolvedValue();
		const resumeSpy = vi.spyOn(store, '__resumeOnline');

		// 1) sig down：__freezeAllClawsForSigOffline → pauseRestart 1 次
		__emitSigState('disconnected');
		expect(fakeRtc.pauseRestart).toHaveBeenCalledTimes(1);
		fakeRtc.pauseRestart.mockClear();

		// 2) sig 仍 down 时 snapshot 到：online 未变、initialized=true、rtcPhase 非 failed
		//    → Phase 3 三条分派路径全不命中（!initialized 补救也被 initialized=true 跳过）
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);
		expect(resumeSpy).not.toHaveBeenCalled();
		expect(fullInitSpy).not.toHaveBeenCalled();
		// Phase 3 的 `prev === true && online === false` 也不命中 → __handleClawGoOffline 不被触发
		// （间接断言：pauseRestart 不再被额外调用）
		expect(fakeRtc.pauseRestart).not.toHaveBeenCalled();

		// 3) sig up：__resumeAllClawsForSigOnline → claw online+initialized → __resumeOnline 1 次
		//    （restartPaused=false、rtc.state=connected → 会走 __ensureRtc，但主路径 spy 能证明只触发 1 次）
		__emitSigState('connected');
		expect(resumeSpy).toHaveBeenCalledTimes(1);
		expect(resumeSpy).toHaveBeenCalledWith('1');
		expect(fullInitSpy).not.toHaveBeenCalled();
	});

	test('SSE ordering: addOrUpdateClaw + sig=disconnected + sig=connected → 经由 __bridgeConn 注册的 sig listener 正确分派', () => {
		// 场景 D：addOrUpdateClaw 路径也能借 __bridgeConn 触发 __bridgeLifecycle 注册 sig listener，
		// 与 applySnapshot 路径等价（无论入口 claw 都被 sig gate 覆盖）。
		// 暴露意图：addOrUpdateClaw 加入的 claw 在 sig 翻转时同样被 freeze/resume，
		// 不会因跳过 applySnapshot 而漏注册。
		const store = useClawsStore();
		const fakeRtc = {
			state: 'connected', isReady: true, restartPaused: false,
			pauseRestart: vi.fn(), resumeRecovery: vi.fn(), triggerRestart: vi.fn(),
			nudgeRestart: vi.fn(), probe: vi.fn().mockResolvedValue(true),
		};
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockImplementation((x) => (String(x) === '1' ? fakeConn : null));
		const fullInitSpy = vi.spyOn(store, '__fullInit').mockResolvedValue();

		// 1) addOrUpdateClaw：manager.connect → __bridgeConn → __bridgeLifecycle 注册 sig listener
		store.addOrUpdateClaw({ id: '1', name: 'A', online: true });
		// __bridgeConn online+!initialized 分支 fire fullInit 1 次
		expect(fullInitSpy).toHaveBeenCalledTimes(1);
		// 为让 sig resume 走 !initialized 补救分支，人为回滚 initialized（模拟 __fullInit 被 sig gate 拒绝）
		store.byId['1'].initialized = false;
		store.fetched = true; // __freeze/__resumeAllClawsForSigOnline 的 fetched gate；addOrUpdateClaw 不置此位
		fullInitSpy.mockClear();

		// 2) sig down：__freezeAllClawsForSigOffline 遍历 byId、对 '1' 调 pauseRestart
		__emitSigState('disconnected');
		expect(fakeRtc.pauseRestart).toHaveBeenCalledTimes(1);

		// 3) sig up：__resumeAllClawsForSigOnline 遍历 byId、online+!initialized 分支补跑 fullInit
		__emitSigState('connected');
		expect(fullInitSpy).toHaveBeenCalledTimes(1);
		expect(fullInitSpy).toHaveBeenCalledWith('1', fakeConn);
		expect(store.byId['1'].initialized).toBe(true);
		expect(store.byId['1'].__initAttempt).toBe(2); // 首次 addOrUpdateClaw 1 + sig resume 1
	});

	test('SSE ordering: rtcPhase=failed no-op snapshot during sig offline → resume 被 sig gate 拦截', () => {
		// 场景 E：claw online+initialized+rtcPhase='failed'，sig 掉线期间 snapshot 到达（online 未变）。
		// Phase 3 末尾的兜底分支（`claw.online && rtcPhase === 'failed'`）会把 id 加入 toResume
		// 并调 __resumeOnline；但 __resumeOnline 入口 sig gate 应立即 return 不动作，
		// 不会误发 triggerRestart 或 resumeRecovery。
		// 暴露意图：Phase 3 rescue 的 failed 兜底分支**没有**显式 sig gate（只由下游 __resumeOnline 拦），
		// 这里验证下游 gate 切实生效；同时 sig 回来时 __resumeAllClawsForSigOnline 才是真正触发点。
		const store = useClawsStore();
		const { fakeRtc } = setupClaw(store, { id: '1', rtcState: 'connected', restartPaused: false });
		store.byId['1'].rtcPhase = 'failed'; // 模拟 server 重启导致 RTC 内部重试耗尽
		store.__bridgeLifecycle();
		const resumeSpy = vi.spyOn(store, '__resumeOnline');

		// 1) sig down：pauseRestart 1 次
		__emitSigState('disconnected');
		fakeRtc.pauseRestart.mockClear();

		// 2) snapshot 到（sig 仍 down）：Phase 3 `failed` 兜底分支 → toResume → __resumeOnline
		//    __resumeOnline 入口 `_sigOffline=true` 早退，triggerRestart/resumeRecovery 不应被调
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);
		expect(resumeSpy).toHaveBeenCalledWith('1');
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
		expect(fakeRtc.resumeRecovery).not.toHaveBeenCalled();
		// 入口 gate 早退前 syncDashboardOnline 也不应被调（gate 在首行）
		expect(fakeRtc.pauseRestart).not.toHaveBeenCalled();
		resumeSpy.mockClear();

		// 3) sig up：__resumeAllClawsForSigOnline 才是真正触发 resume 的入口，resumeOnline 再调一次
		__emitSigState('connected');
		expect(resumeSpy).toHaveBeenCalledTimes(1);
		expect(resumeSpy).toHaveBeenCalledWith('1');
	});

	// -------- typeChanged cross-gate integration：从 UI 层 network:online 事件一路打到 triggerRestart --------
	describe('typeChanged cross-gate integration', () => {
		test('typeChanged cross-gate: sig up + non-paused → 主循环立即处理，不走 Set', () => {
			// 场景 A（典型链路）：sig 在线 + 两 claw 都非 paused → `__handleNetworkOnline(true)` 预循环
			// willHandleNow 规则：A connected+!paused → true 不入 Set；B restarting+!paused → false 入 Set。
			// 主循环：A `network_type_changed` 立即 triggerRestart 且主动 delete Set（no-op）；
			// B restarting 非 paused 走 nudgeRestart 并主动 delete Set 条目。
			// 暴露意图：主循环"处理 + 主动清 Set"语义，避免处理完后 Set 残留条目被下次 resume 虚发。
			const store = useClawsStore();
			const claws = setupClaws(store, [
				{ id: 'A', rtcState: 'connected', restartPaused: false },
				{ id: 'B', rtcState: 'restarting', restartPaused: false },
			]);
			store.__bridgeLifecycle();

			// 走 window 事件路径（更真实的 UI→store 路径）
			window.dispatchEvent(new CustomEvent('network:online', { detail: { typeChanged: true } }));

			// A 非 paused → 主循环触发 'network_type_changed'
			expect(claws.A.fakeRtc.triggerRestart).toHaveBeenCalledWith('network_type_changed');
			expect(claws.A.fakeRtc.triggerRestart).toHaveBeenCalledTimes(1);
			// B restarting + 非 paused → 主循环 nudgeRestart，非 triggerRestart
			expect(claws.B.fakeRtc.nudgeRestart).toHaveBeenCalledTimes(1);
			expect(claws.B.fakeRtc.triggerRestart).not.toHaveBeenCalled();

			// 下一轮 sig cycle：Set 应为空，两个 claw 都无 forceRestart → connected+paused 走 resumeRecovery
			// （间接证明 Set 为空：把两个 claw 置 connected+paused 后 sig up 走 resumeRecovery 而非 triggerRestart）
			claws.A.fakeRtc.restartPaused = true;
			claws.B.fakeRtc.state = 'connected';
			claws.B.fakeRtc.restartPaused = true;
			claws.A.fakeRtc.triggerRestart.mockClear();
			claws.B.fakeRtc.triggerRestart.mockClear();
			__emitSigState('disconnected');
			__emitSigState('connected');
			expect(claws.A.fakeRtc.resumeRecovery).toHaveBeenCalledTimes(1);
			expect(claws.A.fakeRtc.triggerRestart).not.toHaveBeenCalled();
			expect(claws.B.fakeRtc.resumeRecovery).toHaveBeenCalledTimes(1);
			expect(claws.B.fakeRtc.triggerRestart).not.toHaveBeenCalled();
		});

		test('typeChanged cross-gate: sig offline 记账 + sig up 消费 → triggerRestart(online_resume)', () => {
			// 场景 B（主路径，见 dump 裁决矩阵）：1 claw connected+paused、sig 在线初态
			// → sig 掉线（paused 状态保留）→ network:online(typeChanged=true)，sig gate 拦在 __handleNetworkOnline
			//   sig gate return 前，但 Set 已在预循环记账完毕 → Set=['1']
			// → sig up，__resumeAllClawsForSigOnline 遍历 → __resumeOnline('1') 消费 Set → forceRestartOnConnected=true
			//   → connected+paused 分支升级为 triggerRestart('online_resume')。
			// 暴露意图：全链路（UI event → store → service）上 resumeRecovery 不被误调、triggerRestart 恰好调一次、
			// Set 被消费清空。
			const store = useClawsStore();
			const { fakeRtc } = setupClaw(store, { rtcState: 'connected', restartPaused: true });
			store.__bridgeLifecycle();

			__emitSigState('disconnected');
			window.dispatchEvent(new CustomEvent('network:online', { detail: { typeChanged: true } }));
			// sig offline 状态下不会立刻触发 RTC 动作（sig gate return + pre-loop 仅记账）
			expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
			expect(fakeRtc.resumeRecovery).not.toHaveBeenCalled();

			__emitSigState('connected');

			expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('online_resume');
			expect(fakeRtc.triggerRestart).toHaveBeenCalledTimes(1);
			// 升级为 triggerRestart 的分支早退，resumeRecovery 不应被调
			expect(fakeRtc.resumeRecovery).not.toHaveBeenCalled();

			// 下一轮 sig cycle（无 typeChanged）：Set 已清空 → 走默认 resumeRecovery
			fakeRtc.triggerRestart.mockClear();
			__emitSigState('disconnected');
			__emitSigState('connected');
			expect(fakeRtc.resumeRecovery).toHaveBeenCalledTimes(1);
			expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
		});

		test('typeChanged cross-gate: sig offline 期间多次 typeChanged 幂等（per-claw Set 去重）', () => {
			// 场景 C：sig 掉线时连续 dispatch 3 次 network:online(typeChanged=true)。
			// `_pendingTypeChangedRestartClaws` 是 Set，id 'A' 只能存一份 → sig up 时 __resumeOnline 消费一次、
			// triggerRestart 只发一次。
			// 暴露意图：Set.delete() 首次命中返回 true、后续命中返回 false → forceRestartOnConnected 只被升级一次；
			// 若误用 Array.push 或其它结构可能重复消费 → 单次 sig resume 发多次 triggerRestart。
			const store = useClawsStore();
			const { fakeRtc } = setupClaw(store, { rtcState: 'connected', restartPaused: true });
			store.__bridgeLifecycle();

			__emitSigState('disconnected');
			for (let i = 0; i < 3; i++) {
				window.dispatchEvent(new CustomEvent('network:online', { detail: { typeChanged: true } }));
			}
			expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();

			__emitSigState('connected');
			// 仅一次 triggerRestart，尽管 typeChanged 事件重复了 3 次
			expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('online_resume');
			expect(fakeRtc.triggerRestart).toHaveBeenCalledTimes(1);
		});

		test('typeChanged cross-gate: rtcPhase=failed claw 记账消费后走 rebuild 分支（不误升级 triggerRestart）', () => {
			// 场景 D：sig 掉线 + 1 claw rtc.state='failed' + rtcPhase='failed'（PC 本身已死，不 paused）。
			// network:online(typeChanged=true) → Set 记账（因 rtc.state!='connected' willHandleNow=false）。
			// sig up → __resumeAllClawsForSigOnline 遍历 → claw initialized → __resumeOnline('1')：
			//   - 入口 `_pendingTypeChangedRestartClaws.delete('1')` 命中 → forceRestartOnConnected=true
			//   - rtc.state='failed'：不匹配 'restarting' 分支、不匹配 'connected+paused' 分支
			//   - fall through 到 `__ensureRtc(id)` → rebuild（closeRtcForClaw + initRtc 循环）
			// 暴露意图：failed claw 的 Set 条目被"正确消费但不误升级为 triggerRestart"——升级只对
			// connected+paused 有意义，failed 必须走 rebuild；若分派写错，可能在 failed rtc 上误发
			// triggerRestart → 对已死的 PC 发 offer → 永久 stuck。
			const store = useClawsStore();
			const { fakeRtc, fakeConn } = setupClaw(store, { rtcState: 'failed', restartPaused: false });
			store.byId['1'].rtcPhase = 'failed';
			store.byId['1'].dcReady = false;
			store.__bridgeLifecycle();

			__emitSigState('disconnected');
			window.dispatchEvent(new CustomEvent('network:online', { detail: { typeChanged: true } }));
			// sig 掉线：不会触发 RTC 动作
			expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();

			mockInitRtc.mockClear();
			__emitSigState('connected');

			// failed rtc：不误升级 triggerRestart，也不走 resumeRecovery
			expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
			expect(fakeRtc.resumeRecovery).not.toHaveBeenCalled();
			// 走 __ensureRtc rebuild：initRtc 被调、closeRtcForClaw 做过一次
			expect(mockInitRtc).toHaveBeenCalledTimes(1);
			expect(mockInitRtc).toHaveBeenCalledWith('1', fakeConn, expect.any(Object));

			// 下一轮 sig cycle：Set 已被消费 → 再来一次 sig cycle 不粘着（无 typeChanged）
			fakeRtc.triggerRestart.mockClear();
			mockInitRtc.mockClear();
			// 模拟 rebuild 成功：rtc.state 置为 connected（matches mockInitRtc 默认行为）
			fakeRtc.state = 'connected';
			fakeRtc.isReady = true;
			fakeConn.rtc = fakeRtc;
			store.byId['1'].rtcPhase = 'ready';
			store.byId['1'].dcReady = true;
			__emitSigState('disconnected');
			__emitSigState('connected');
			// Set 已空：connected+!paused 不走 triggerRestart，也不走 resumeRecovery（无 pause 需解冻）
			expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
			expect(fakeRtc.resumeRecovery).not.toHaveBeenCalled();
		});

		test('typeChanged cross-gate: logout 清 Set 后再次登录不粘着（__resetClawStoreInternals 清理）', () => {
			// 场景 E：sig 掉线 + typeChanged 记账 → 未消费前 __resetClawStoreInternals（logout 模拟）
			// → 重建同 id claw → sig up → Set 已清，不升级 triggerRestart，走 resumeRecovery。
			// 暴露意图：模块级 Set 必须由 __resetClawStoreInternals 清理，否则下次登录的用户会继承前一用户的
			// typeChanged 记账并在首次 sig resume 时错误 triggerRestart（串用户污染）。
			const store = useClawsStore();
			const { fakeRtc } = setupClaw(store, { rtcState: 'connected', restartPaused: true });
			store.__bridgeLifecycle();

			__emitSigState('disconnected');
			window.dispatchEvent(new CustomEvent('network:online', { detail: { typeChanged: true } }));
			// 记账入 Set，但 sig 仍 offline 未消费

			// 模拟 logout：清模块级状态 + 解绑 listener
			__resetAwaitingConnIds();
			// logout 后 pinia store 也会被 $reset，手动模拟
			store.$reset();

			// 重建同 id claw，再挂 lifecycle（新 listener + 新 _pendingTypeChangedRestartClaws 为空）
			const { fakeRtc: rtc2 } = setupClaw(store, { rtcState: 'connected', restartPaused: true });
			store.__bridgeLifecycle();

			// sig cycle：未经 typeChanged → resumeRecovery 路径（非 triggerRestart）
			__emitSigState('disconnected');
			__emitSigState('connected');

			// 原 fakeRtc 不应被再次触碰（已由旧 store 丢弃）
			expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
			expect(fakeRtc.resumeRecovery).not.toHaveBeenCalled();
			// 新 claw 走 resumeRecovery 分支：connected+paused 无 forceRestart → resumeRecovery
			expect(rtc2.resumeRecovery).toHaveBeenCalledTimes(1);
			expect(rtc2.triggerRestart).not.toHaveBeenCalled();
		});

		test('typeChanged cross-gate: !initialized claw 在 sig offline 期间被打标 → sig up 走 __fullInit + Set 自动消费', async () => {
			// 场景 F：claw `online=true, initialized=false`（首启竞态：snapshot 已到，__fullInit
			// 因 sig 未通早退过，initialized 仍为 false）。sig 掉线 → typeChanged → sig up
			// 期间预循环 `willHandleNow=false`（!initialized 命中条件）→ Set 记账。
			// sig up 时 `__resumeAllClawsForSigOnline` 的 !initialized 分支主动
			// `_pendingTypeChangedRestartClaws.delete(id)` 后跑 __fullInit；此条目消费完毕
			// 后再来一轮 sig cycle 应走 resumeRecovery（说明 Set 没有残留）。
			//
			// 锁定 `__resumeAllClawsForSigOnline` 的 !initialized 分支主动 delete 行为；
			// 若未来误删 delete，第二轮 sig cycle 的 resumeRecovery 断言会失败。
			const store = useClawsStore();
			const { fakeRtc } = setupClaw(store, { rtcState: 'connected', restartPaused: false });
			// 改回 !initialized：模拟 sig 未通时 __fullInit 早退后的状态
			store.byId['1'].initialized = false;
			store.byId['1'].dcReady = false;
			store.__bridgeLifecycle();

			// spy __fullInit 与 __resumeOnline：!initialized 分支只走 __fullInit，不走 __resumeOnline
			const fullInitSpy = vi.spyOn(store, '__fullInit').mockResolvedValue(undefined);
			const resumeOnlineSpy = vi.spyOn(store, '__resumeOnline').mockImplementation(() => {});

			// 阶段 1：sig 掉线 + typeChanged → 预循环 !initialized 命中 willHandleNow=false → Set 记账
			__emitSigState('disconnected');
			window.dispatchEvent(new CustomEvent('network:online', { detail: { typeChanged: true } }));
			expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();

			// 阶段 2：sig up → __resumeAllClawsForSigOnline → !initialized 分支：
			//   - 主动 delete Set 条目
			//   - 跑 __fullInit（不经 __resumeOnline）
			__emitSigState('connected');
			await new Promise((r) => setTimeout(r, 10));

			expect(fullInitSpy).toHaveBeenCalledTimes(1);
			expect(fullInitSpy).toHaveBeenCalledWith('1', expect.any(Object));
			expect(resumeOnlineSpy).not.toHaveBeenCalled();
			// claw.initialized 翻 true（__fullInit 调度前主动置）
			expect(store.byId['1'].initialized).toBe(true);

			// 阶段 3 反证：再 sig cycle（无 typeChanged，且 claw 已 initialized + connected+paused 模拟）
			//   - 若上次 sig up 的 !initialized 分支没 delete Set，本次 __resumeOnline 会消费陈旧条目
			//     → forceRestartOnConnected=true → 升级 triggerRestart('online_resume')
			//   - delete 行为正常 → __resumeOnline 走 resumeRecovery（连同 paused）
			fullInitSpy.mockClear();
			resumeOnlineSpy.mockRestore();
			fakeRtc.state = 'connected';
			fakeRtc.restartPaused = true;
			fakeRtc.triggerRestart.mockClear();
			fakeRtc.resumeRecovery.mockClear();

			__emitSigState('disconnected');
			__emitSigState('connected');
			await new Promise((r) => setTimeout(r, 10));

			// connected+paused 无 forceRestart → resumeRecovery；若 Set 有残留则会升级 triggerRestart
			expect(fakeRtc.resumeRecovery).toHaveBeenCalledTimes(1);
			expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
		});
	});

	// -------- long background → foreground integration：app:background/app:foreground × sig 状态组合 --------
	describe('long background → foreground integration', () => {
		// 通过 spy Date.now 模拟后台时长（_backgroundAt 读 Date.now）。
		// 比 vi.useFakeTimers 更精确：不干扰 setTimeout/Promise microtask 调度。
		function withMockedNow(fn) {
			const nowSpy = vi.spyOn(Date, 'now');
			try { return fn(nowSpy); }
			finally { nowSpy.mockRestore(); }
		}

		test('background→foreground: 长后台 + sig 先回 + foreground 后 → resumeRecovery 调一次，foreground 幂等不重复打断', async () => {
			// 场景 A：1 claw connected+paused（sig 掉线冻结）；后台 30s；
			// sig 回来先触发 __resumeAllClawsForSigOnline → __resumeOnline → resumeRecovery（清 paused）；
			// app:foreground 紧随（模拟 OS 恢复事件次序），__checkAndRecover 走 probe 路径。
			// 暴露意图：sig resume 已搞定 paused → foreground 的 __checkAndRecover 必须幂等
			// （probe 成功即 return），不再 triggerRestart 或重复 resumeRecovery 打断刚恢复的 DC。
			await withMockedNow(async (nowSpy) => {
				__mockSigState = 'disconnected';
				const store = useClawsStore();
				const { fakeRtc } = setupClaw(store, { rtcState: 'connected', restartPaused: true });
				// __bridgeLifecycle 初始 sig=disconnected → _sigOffline=true + 冻结（pauseRestart 已被调）
				store.__bridgeLifecycle();
				fakeRtc.pauseRestart.mockClear();

				// T0：进入后台
				nowSpy.mockReturnValue(1_000_000);
				window.dispatchEvent(new Event('app:background'));

				// T0+30s：sig 先回（模拟长后台恢复后 WS 先到）
				nowSpy.mockReturnValue(1_030_000);
				__emitSigState('connected');
				// connected+paused → resumeRecovery（无 forceRestart）
				expect(fakeRtc.resumeRecovery).toHaveBeenCalledTimes(1);
				expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();

				// foreground 随后到（同一时刻），__checkAndRecover 对所有 claw 跑一遍。
				// probe 默认返回 true → alive → return，不触发任何恢复动作。
				window.dispatchEvent(new Event('app:foreground'));
				// 等 __checkAndRecover 的 async probe 链走完
				await vi.waitFor(() => {
					expect(fakeRtc.probe).toHaveBeenCalledTimes(1);
				});

				// 幂等断言：resumeRecovery 仍 1 次、triggerRestart 0 次、无 rebuild
				expect(fakeRtc.resumeRecovery).toHaveBeenCalledTimes(1);
				expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
				expect(fakeRtc.nudgeRestart).not.toHaveBeenCalled();
			});
		});

		test('background→foreground: 长后台 + foreground 先 + sig 后回 → foreground 被 sig gate 拦、sig up 正确接管', async () => {
			// 场景 B（反序）：sig 仍 down 时 foreground 先到 → __checkAndRecover 入口
			// `_sigOffline` 早退，不 probe、不 restart；sig 后回，__resumeAllClawsForSigOnline
			// 走 resumeRecovery。暴露意图：foreground 在 sig 未通时不会绕过 gate 做无意义 probe。
			await withMockedNow(async (nowSpy) => {
				__mockSigState = 'disconnected';
				const store = useClawsStore();
				const { fakeRtc } = setupClaw(store, { rtcState: 'connected', restartPaused: true });
				store.__bridgeLifecycle();
				fakeRtc.pauseRestart.mockClear();

				nowSpy.mockReturnValue(2_000_000);
				window.dispatchEvent(new Event('app:background'));

				// T0+30s：foreground 先到（sig 仍 down）
				nowSpy.mockReturnValue(2_030_000);
				window.dispatchEvent(new Event('app:foreground'));
				// 让 checkAndRecover 的可能 async 路径跑完
				await new Promise((r) => setTimeout(r, 20));

				// sig gate 早退：不 probe、不 triggerRestart / resumeRecovery
				expect(fakeRtc.probe).not.toHaveBeenCalled();
				expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
				expect(fakeRtc.resumeRecovery).not.toHaveBeenCalled();

				// sig 后回：__resumeAllClawsForSigOnline 走 resumeRecovery（connected+paused）
				__emitSigState('connected');
				expect(fakeRtc.resumeRecovery).toHaveBeenCalledTimes(1);
				expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
			});
		});

		test('background→foreground: 短后台 (<25s) → remoteLog claw.skipProbe，不 probe', async () => {
			// 场景 C：sig 保持 connected，后台 10s<25s → foreground 入口短后台守卫早退 + remoteLog。
			// 暴露意图：SHORT_BACKGROUND_MS 阈值与 skipProbe 日志契约不被未来改动破坏。
			await withMockedNow(async (nowSpy) => {
				const store = useClawsStore();
				const { fakeRtc } = setupClaw(store, { rtcState: 'connected', restartPaused: false });
				store.__bridgeLifecycle();

				nowSpy.mockReturnValue(3_000_000);
				window.dispatchEvent(new Event('app:background'));

				nowSpy.mockReturnValue(3_010_000); // +10s，远小于 25s
				mockRemoteLog.mockClear();
				window.dispatchEvent(new Event('app:foreground'));
				await new Promise((r) => setTimeout(r, 20));

				expect(fakeRtc.probe).not.toHaveBeenCalled();
				expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
				expect(fakeRtc.resumeRecovery).not.toHaveBeenCalled();
				expect(fakeRtc.nudgeRestart).not.toHaveBeenCalled();
				expect(mockRemoteLog).toHaveBeenCalledWith(expect.stringMatching(/^claw\.skipProbe bgDuration=10000ms/));
			});
		});

		test('background→foreground: 长后台 + network:online(typeChanged=true) + foreground 组合事件 → typeChanged 立即 triggerRestart、foreground 接续 nudge、无冲突', async () => {
			// 场景 D：sig 保持 connected、claw connected+!paused+online；后台 30s，
			// 恢复时 network:online(typeChanged=true) 和 app:foreground 前后脚派发。
			// typeChanged 主循环：connected+!paused → triggerRestart('network_type_changed')。
			// 测试手动切 rtc.state='restarting'（mock triggerRestart 不会自动改）
			// → 紧接 foreground 遍历 __checkAndRecover → restarting 分支 nudgeRestart。
			// 暴露意图：两事件同窗口到达时两条恢复路径互不误踩——typeChanged 恰一次 triggerRestart、
			// foreground 恰一次 nudge、Set 已被主循环清（下次 sig cycle 不粘着升级 online_resume）。
			await withMockedNow(async (nowSpy) => {
				const store = useClawsStore();
				const { fakeRtc } = setupClaw(store, { rtcState: 'connected', restartPaused: false });
				store.__bridgeLifecycle();

				nowSpy.mockReturnValue(4_000_000);
				window.dispatchEvent(new Event('app:background'));

				// 让 triggerRestart 真的把 state 切到 restarting，便于 foreground 的 checkAndRecover 走对分支
				fakeRtc.triggerRestart.mockImplementation(() => { fakeRtc.state = 'restarting'; });

				// T0+30s：先 network:online(typeChanged=true)
				nowSpy.mockReturnValue(4_030_000);
				window.dispatchEvent(new CustomEvent('network:online', { detail: { typeChanged: true } }));
				expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('network_type_changed');
				expect(fakeRtc.triggerRestart).toHaveBeenCalledTimes(1);

				// 紧接 foreground：__checkAndRecover 对 state='restarting' 走 nudgeRestart 分支
				window.dispatchEvent(new Event('app:foreground'));
				await vi.waitFor(() => {
					expect(fakeRtc.nudgeRestart).toHaveBeenCalledTimes(1);
				});

				// 无重复 triggerRestart / resumeRecovery
				expect(fakeRtc.triggerRestart).toHaveBeenCalledTimes(1);
				expect(fakeRtc.resumeRecovery).not.toHaveBeenCalled();
				// probe 不应被调（restarting 分支在 probe 之前早退）
				expect(fakeRtc.probe).not.toHaveBeenCalled();

				// 下一轮 sig cycle：typeChanged Set 已被主循环清 → 无升级 online_resume
				// 把 rtc 置回 connected+paused 模拟 restart 完成后被 sig offline 冻结
				fakeRtc.state = 'connected';
				fakeRtc.restartPaused = true;
				fakeRtc.triggerRestart.mockReset();
				fakeRtc.resumeRecovery.mockClear();
				__emitSigState('disconnected');
				__emitSigState('connected');
				// Set 已空 → connected+paused 走 resumeRecovery（非 triggerRestart）
				expect(fakeRtc.resumeRecovery).toHaveBeenCalledTimes(1);
				expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
			});
		});
	});

	// -------- G-01: _pendingForceRefreshOnRebuild sig_offline bail --------
	// 推测 bug：__resumeOnline 的 rebuild 分支把 id 加入 _pendingForceRefreshOnRebuild；
	// 紧接着 __ensureRtc 在 post-await 发现 _sigOffline=true 时 bail 'sig_offline'——
	// rtcPhase/disconnectedAt 被 snapshot+restore，但 Set 条目**没有**被清理。
	// 若后续某条路径不再经 __resumeOnline 而直接调 __ensureRtc 并 rebuild 成功，
	// 泄漏的 Set 条目会被 consume，触发一次**虚假** force refresh（disconnectedAt=0
	// 本该被 gap gate 跳过的短断场景被强制刷新，浪费流量/抖动 UI）。
	describe('G-01: _pendingForceRefreshOnRebuild bail 残留清理', () => {
		// 独立造 setup：不复用外层 setupClaw，因为需要 rtc=null 的初态走 rebuild 分支
		function setupRebuildClaw(store, id = '1') {
			const fakeConn = {
				rtc: null,
				on: vi.fn(), off: vi.fn(),
				clearRtc: vi.fn(() => { fakeConn.rtc = null; }),
			};
			mockManager.get.mockImplementation((x) => (String(x) === id ? fakeConn : null));
			store.setClaws([{ id, online: true }]);
			store.byId[id].initialized = true;
			store.byId[id].dcReady = false;
			store.byId[id].rtcPhase = 'idle';
			store.byId[id].disconnectedAt = 0;
			store.fetched = true;
			return { fakeConn };
		}

		// G-01 修复：__ensureRtc 的 bail 分支（L~941 附近）现统一清 _pendingForceRefreshOnRebuild，
		// 与成功路径 L933 对称，避免 bail 后被其他非 __resumeOnline 的触发源 consume 残留条目虚假 force_refresh
		test('sig_offline bail 后 Set 条目应清理：后续独立 rebuild 不应虚假 force refresh', async () => {
			const store = useClawsStore();
			const agentsStore = useAgentsStore();
			const sessionsStore = useSessionsStore();
			const topicsStore = useTopicsStore();
			const dashboardStore = useDashboardStore();
			vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
			vi.spyOn(sessionsStore, 'loadSessionsForClaw').mockResolvedValue();
			vi.spyOn(topicsStore, 'loadTopicsForClaw').mockResolvedValue();
			vi.spyOn(dashboardStore, 'loadDashboard').mockResolvedValue();

			const { fakeConn } = setupRebuildClaw(store);
			store.__bridgeLifecycle();

			// 阶段 1：__resumeOnline 走 rebuild 分支 → Set.add('1') → __ensureRtc 启动
			// initRtc deferred：手动控制 resolve 时机，构造 "await 期间 sig 翻 disconnected"
			let capturedCallbacks;
			let resolveInit;
			mockInitRtc.mockReset();
			mockInitRtc.mockImplementation((id, conn, callbacks) => {
				capturedCallbacks = callbacks;
				return new Promise((r) => { resolveInit = r; });
			});
			// closeRtcForClaw 需触发 onRtcStateChange('closed') 副作用（模拟真实行为），
			// 这样可同时验证 rtcPhase/disconnectedAt 的 snapshot+restore 仍起作用
			mockCloseRtcForBot.mockImplementation(() => {
				capturedCallbacks?.onRtcStateChange?.('closed');
			});

			store.__resumeOnline('1'); // 内部异步调 __ensureRtc
			// 让 __ensureRtc 跑到 await initRtc
			await Promise.resolve();
			await Promise.resolve();

			// 阶段 2：sig 掉线 → _sigOffline=true；resolve initRtc 成功 → post-await bail
			__emitSigState('disconnected');
			resolveInit('rtc');
			// 等 __ensureRtc 走完 bail 分支（finally 清 _rtcInitInProgress）
			await new Promise((r) => setTimeout(r, 10));

			// 阶段 2 验证：bail 生效 —— rtcPhase 保持进入前的 'building'（__ensureRtc 把 'idle' → 'building'），
			// disconnectedAt 保持 0（snapshot+restore 工作）
			expect(mockRemoteLog).toHaveBeenCalledWith(expect.stringContaining('reason=sig_offline'));
			expect(store.byId['1'].rtcPhase).toBe('building');
			expect(store.byId['1'].disconnectedAt).toBe(0);
			expect(fakeConn.rtc).toBeNull(); // closeRtcForClaw + clearRtc 已跑

			// 阶段 3：sig 恢复但屏蔽 __resumeAllClawsForSigOnline 的 __resumeOnline 再入，
			// 模拟"其他触发源直接驱动 __ensureRtc"（如 conn.__onTriggerReconnect / 退避重试落地）
			const resumeSpy = vi.spyOn(store, '__resumeOnline').mockImplementation(() => {});
			__emitSigState('connected');
			resumeSpy.mockRestore();

			// 阶段 4：独立触发 __ensureRtc 成功 rebuild（模拟非 __resumeOnline 驱动的重建）
			mockInitRtc.mockReset();
			mockInitRtc.mockImplementation(async (id, conn) => {
				conn.rtc = { ...__fakeRtc };
				return 'rtc';
			});
			mockCloseRtcForBot.mockReset();

			mockRemoteLog.mockClear();
			agentsStore.loadAgents.mockClear();
			sessionsStore.loadSessionsForClaw.mockClear();
			topicsStore.loadTopicsForClaw.mockClear();
			dashboardStore.loadDashboard.mockClear();

			await store.__ensureRtc('1');
			await new Promise((r) => setTimeout(r, 10));

			// 核心断言：Set 应在 bail 时被清 → 本次 rebuild consume 得 force=false →
			//   __refreshIfStale 因 disconnectedAt=0 早退 → loaders 不被调。
			// 当前实现 Set 未清 → force=true → loaders 被调，以下断言失败（红）。
			expect(agentsStore.loadAgents).not.toHaveBeenCalled();
			expect(sessionsStore.loadSessionsForClaw).not.toHaveBeenCalled();
			expect(topicsStore.loadTopicsForClaw).not.toHaveBeenCalled();
			expect(dashboardStore.loadDashboard).not.toHaveBeenCalled();
			// 日志侧证：rtcReady 不应带 force_refresh=1
			expect(mockRemoteLog).not.toHaveBeenCalledWith(expect.stringContaining('force_refresh=1'));
		});

		test('sig_offline bail → sig 恢复 → __resumeAllClawsForSigOnline 再入：force refresh 是合法的（sanity check）', async () => {
			// 对照用例（始终绿）：验证"sig resume 路径下，__resumeOnline 会重新 add Set → 合法 force refresh"
			// 的现行行为不受 G-01 修法影响。无论 Set 是否在 bail 时清，sig-resume 分支都会 re-add，
			// 因此 loaders 应被调、日志应含 force_refresh=1。
			const store = useClawsStore();
			const agentsStore = useAgentsStore();
			vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
			vi.spyOn(useSessionsStore(), 'loadSessionsForClaw').mockResolvedValue();
			vi.spyOn(useTopicsStore(), 'loadTopicsForClaw').mockResolvedValue();
			vi.spyOn(useDashboardStore(), 'loadDashboard').mockResolvedValue();

			const { fakeConn } = setupRebuildClaw(store);
			// 预置 disconnectedAt>0 模拟之前曾有 restarting 阶段 stamp；bail 的 snapshot+restore 会保留该值，
			// 让 force=true 路径下 gap gate 也放行（避免受 disconnectedAt=0 早退干扰，聚焦于 Set 路径）
			store.byId['1'].disconnectedAt = 1;
			store.__bridgeLifecycle();

			// 阶段 1：__resumeOnline → __ensureRtc 挂起在 await initRtc
			let capturedCallbacks;
			let resolveInit;
			mockInitRtc.mockReset();
			mockInitRtc.mockImplementation((id, conn, callbacks) => {
				capturedCallbacks = callbacks;
				return new Promise((r) => { resolveInit = r; });
			});
			mockCloseRtcForBot.mockImplementation(() => {
				capturedCallbacks?.onRtcStateChange?.('closed');
			});

			store.__resumeOnline('1');
			await Promise.resolve();
			await Promise.resolve();

			// 阶段 2：sig 翻 disconnected → resolve initRtc → bail sig_offline
			__emitSigState('disconnected');
			resolveInit('rtc');
			await new Promise((r) => setTimeout(r, 10));

			expect(mockRemoteLog).toHaveBeenCalledWith(expect.stringContaining('reason=sig_offline'));
			expect(fakeConn.rtc).toBeNull();

			// 阶段 3：sig 恢复 → __resumeAllClawsForSigOnline → __resumeOnline('1') re-add Set →
			//   内部 __ensureRtc rebuild 成功 → consume → force refresh
			mockInitRtc.mockReset();
			mockInitRtc.mockImplementation(async (id, conn) => {
				conn.rtc = { ...__fakeRtc };
				return 'rtc';
			});
			mockCloseRtcForBot.mockReset();
			mockRemoteLog.mockClear();
			agentsStore.loadAgents.mockClear();

			__emitSigState('connected');
			await new Promise((r) => setTimeout(r, 20));

			// sig-resume 路径 __resumeOnline re-add → consume → force_refresh=1，loaders 被调
			expect(agentsStore.loadAgents).toHaveBeenCalledWith('1');
			expect(mockRemoteLog).toHaveBeenCalledWith(expect.stringContaining('force_refresh=1'));
		});

		test('offline bail → 后续独立 rebuild 不应虚假 force refresh + 第二轮重建独立 add/consume', async () => {
			// 与 sig_offline bail 用例对称的 offline bail 场景：rebuild 中途 claw.online 翻 false →
			// __ensureRtc post-await bail 'offline'。bail 分支同样 _pendingForceRefreshOnRebuild.delete，
			// 后续若有非 __resumeOnline 路径直接驱动 __ensureRtc 成功，不应 force_refresh。
			// 第二轮 online 时再次 __resumeOnline 走独立 add+consume 周期，loaders 被合法调一次。
			const store = useClawsStore();
			const agentsStore = useAgentsStore();
			const sessionsStore = useSessionsStore();
			const topicsStore = useTopicsStore();
			const dashboardStore = useDashboardStore();
			vi.spyOn(agentsStore, 'loadAgents').mockResolvedValue();
			vi.spyOn(sessionsStore, 'loadSessionsForClaw').mockResolvedValue();
			vi.spyOn(topicsStore, 'loadTopicsForClaw').mockResolvedValue();
			vi.spyOn(dashboardStore, 'loadDashboard').mockResolvedValue();

			const { fakeConn } = setupRebuildClaw(store);
			store.__bridgeLifecycle();

			// 阶段 1：__resumeOnline → __ensureRtc 走 rebuild 分支 → Set.add('1') →
			//   initRtc 挂起在 await
			let capturedCallbacks;
			let resolveInit;
			mockInitRtc.mockReset();
			mockInitRtc.mockImplementation((id, conn, callbacks) => {
				capturedCallbacks = callbacks;
				return new Promise((r) => { resolveInit = r; });
			});
			mockCloseRtcForBot.mockImplementation(() => {
				capturedCallbacks?.onRtcStateChange?.('closed');
			});

			store.__resumeOnline('1');
			await Promise.resolve();
			await Promise.resolve();

			// 阶段 2：claw.online 翻 false → resolve initRtc 成功 → post-await bail 'offline'
			//   （L943 入口分支已过，这里走 L965 post-await 的 cur.online 分支）
			store.byId['1'].online = false;
			resolveInit('rtc');
			await new Promise((r) => setTimeout(r, 10));

			// bail 'offline' 分支：rtcPhase='failed'（与 sig_offline 不同——offline 是 presence 故障）。
			// 注意：offline bail **不**像 sig_offline 那样 restore 旧 disconnectedAt——所以
			// closeRtcForBot → onRtcStateChange('closed') 写入的 Date.now() 仍保留为非零。
			// 阶段 3 的"无 force_refresh"断言依赖 force=false + gap<BRIEF_DISCONNECT_MS 早退
			// （同 microtask 内 gap≈0），不是 disconnectedAt=0 早退
			expect(mockRemoteLog).toHaveBeenCalledWith(expect.stringContaining('reason=offline'));
			expect(store.byId['1'].rtcPhase).toBe('failed');
			expect(fakeConn.rtc).toBeNull();
			expect(store.byId['1'].disconnectedAt).toBeGreaterThan(0);

			// 阶段 3：模拟非 __resumeOnline 驱动的独立 rebuild。先把 online 翻回 true，但屏蔽
			// __resumeOnline（避免它再次 add Set）；__ensureRtc 直接调，验证 bail 已清残留。
			store.byId['1'].online = true;
			const resumeSpy = vi.spyOn(store, '__resumeOnline').mockImplementation(() => {});
			mockInitRtc.mockReset();
			mockInitRtc.mockImplementation(async (id, conn) => {
				conn.rtc = { ...__fakeRtc };
				return 'rtc';
			});
			mockCloseRtcForBot.mockReset();
			mockRemoteLog.mockClear();
			agentsStore.loadAgents.mockClear();
			sessionsStore.loadSessionsForClaw.mockClear();
			topicsStore.loadTopicsForClaw.mockClear();
			dashboardStore.loadDashboard.mockClear();

			await store.__ensureRtc('1');
			await new Promise((r) => setTimeout(r, 10));

			// 核心断言：bail 时 Set 已清 → 此独立 rebuild consume force=false →
			//   __refreshIfStale 因 gap<BRIEF_DISCONNECT_MS 早退（同 microtask gap≈0）
			//   → loaders 不被调；日志无 force_refresh=1
			expect(agentsStore.loadAgents).not.toHaveBeenCalled();
			expect(sessionsStore.loadSessionsForClaw).not.toHaveBeenCalled();
			expect(topicsStore.loadTopicsForClaw).not.toHaveBeenCalled();
			expect(dashboardStore.loadDashboard).not.toHaveBeenCalled();
			expect(mockRemoteLog).not.toHaveBeenCalledWith(expect.stringContaining('force_refresh=1'));

			// 阶段 4 反证：恢复 __resumeOnline，再走一轮（PC 当前已 connected 走早退路径，
			// 不会 re-add 标记；这里通过 mock 反证：让独立 __ensureRtc 再次成功 → 仍无 force）
			resumeSpy.mockRestore();
		});
	});

	// G-02（原推测 bug，经 audit 核实非 bug）：
	// rtc.state='connecting' 只在 WebRtcConnection.__buildPeerConnection 内由 connect()→initRtc 产出，
	// 始终与 `_rtcInitInProgress=true` 的 __ensureRtc 流水线并存；其 post-await 成功分支已在 L930
	// 主动清 _pendingTypeChangedRestartClaws。孤立的 onRtcStateChange('connected') 回调迁移不可达。
	// 原 skip 测试与生产链路无对应，已删除。

	test('addOrUpdateClaw 在 fetched=false 时建 RTC，随后 sig disconnect 不 pause RTC（设计意图：snapshot 未到则 freeze 整轮跳过）', () => {
		// 设计意图：__freezeAllClawsForSigOffline 入口 `!fetched` 早退（claws.store.js L617），
		// 过滤 logout / 首启 snapshot 未到的 sig 状态噪音事件。
		// 防回归：若有人去掉 fetched gate，会把首启竞态期间提前建的 RTC 误 pause。
		// 注：不要求改源——本测试仅锁定现有设计意图。
		const store = useClawsStore();
		// 不调 setClaws，不设 fetched=true
		const fakeRtc = {
			state: 'connected',
			isReady: true,
			restartPaused: false,
			pauseRestart: vi.fn(),
			resumeRecovery: vi.fn(),
			triggerRestart: vi.fn(),
			nudgeRestart: vi.fn(),
			probe: vi.fn().mockResolvedValue(true),
		};
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.addOrUpdateClaw({ id: 'X', name: 'EarlyBot', online: true });
		store.__bridgeLifecycle();

		// sig disconnect 触发 __freezeAllClawsForSigOffline
		__emitSigState('disconnected');

		// pauseRestart 不应被调（fetched=false → freeze 整轮跳过）
		expect(fakeRtc.pauseRestart).not.toHaveBeenCalled();
	});
});

// -------- G-03: _bridgedConns 同 clawId remove→re-add 时新旧 conn 实例切换 --------
// 风险点：__bridgeConn 依靠 `_bridgedConns.get(clawId) === conn` 短路防重复注册。
// 流程：removeClawById / applySnapshot Phase 1 会 `_bridgedConns.delete(id)` + manager.disconnect(id)；
// 随后 re-add 时 manager.connect(id) 产出**全新** ClawConnection 实例。新 conn ≠ 旧 conn，
// 短路失效 → 正常注册路径 → 新 conn 被 on(...) 注册三类事件。
//
// 本组验证：remove→re-add 场景下 __bridgeConn 能正确切换到新 conn，
// 不会被 _bridgedConns 残留短路、不会把新事件发到旧 conn 上。
describe('G-03: _bridgedConns remove→re-add conn identity switch', () => {
	function createFakeConn() {
		return {
			on: vi.fn(),
			off: vi.fn(),
			rtc: null,
			clearRtc: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
		};
	}

	/** 统计某个 conn 被 __bridgeConn 注册的 DC 事件数（应为 3：event:agent + info.updated + peerTransport） */
	function countBridgeOnCalls(conn) {
		return conn.on.mock.calls.filter(([ev]) =>
			ev === 'event:agent' || ev === 'event:coclaw.info.updated' || ev === 'event:coclaw.rtc.peerTransport',
		).length;
	}

	test('场景 A: applySnapshot 删→回，新 conn 实例替换旧 conn，事件注册切换到新实例', async () => {
		const store = useClawsStore();
		const connA = createFakeConn();
		const connB = createFakeConn();

		// 第 1 次 snapshot：'1' online → manager.get 返回 connA，__bridgeConn 注册到 connA
		mockManager.get.mockImplementation((id) => (String(id) === '1' ? connA : undefined));
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);

		expect(countBridgeOnCalls(connA)).toBe(3);
		expect(countBridgeOnCalls(connB)).toBe(0);

		// 第 2 次 snapshot：删 '1' → Phase 1 清 _bridgedConns + syncConnections 断开 conn
		// （mock 下 manager.disconnect 不真的调 conn.disconnect，但 _bridgedConns.delete('1') 必然发生）
		mockManager.get.mockImplementation(() => undefined);
		store.applySnapshot([]);
		// snapshot 后 claw '1' 从 byId 中清掉
		expect(store.byId['1']).toBeUndefined();

		// 第 3 次 snapshot：'1' 回归 → manager.get 返回**全新** connB
		mockManager.get.mockImplementation((id) => (String(id) === '1' ? connB : undefined));
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);

		// 关键断言：connB 被注册 3 次（新 conn 正确 bridge）；connA 的 on 没有再被调用
		expect(countBridgeOnCalls(connB)).toBe(3);
		// connA 的 on 调用数保持第 1 次的 3 次（没有回流到旧 conn）
		expect(countBridgeOnCalls(connA)).toBe(3);
	});

	test('场景 B: removeClawById + addOrUpdateClaw，新 conn 实例正确 bridge', () => {
		const store = useClawsStore();
		const connA = createFakeConn();
		const connB = createFakeConn();

		// 初态：通过 applySnapshot 建立 '1' + bridge 到 connA
		mockManager.get.mockImplementation((id) => (String(id) === '1' ? connA : undefined));
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);
		expect(countBridgeOnCalls(connA)).toBe(3);

		// removeClawById：显式 manager.disconnect(id) + _bridgedConns.delete(id) + delete byId[id]
		store.removeClawById('1');
		expect(store.byId['1']).toBeUndefined();
		expect(mockManager.disconnect).toHaveBeenCalledWith('1');

		// addOrUpdateClaw：manager.get 返回**全新** connB（模拟 manager 内部刚 connect 出新实例）
		mockManager.get.mockImplementation((id) => (String(id) === '1' ? connB : undefined));
		store.addOrUpdateClaw({ id: '1', name: 'A', online: true });

		// 关键断言：connB 被注册 3 次；connA 的 on 没有再被调用
		expect(countBridgeOnCalls(connB)).toBe(3);
		expect(countBridgeOnCalls(connA)).toBe(3);
	});

	test('场景 C: 新 conn bridge 后各 handler 是新闭包实例；旧 conn 的 listener 本身不被 store 主动 off（依赖 manager.disconnect）', () => {
		const store = useClawsStore();
		const connA = createFakeConn();
		const connB = createFakeConn();

		// 1) bridge 到 connA，拿到 connA 上挂的 event:coclaw.info.updated handler
		mockManager.get.mockImplementation((id) => (String(id) === '1' ? connA : undefined));
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);
		const connAInfoCalls = connA.on.mock.calls.filter(([ev]) => ev === 'event:coclaw.info.updated');
		expect(connAInfoCalls).toHaveLength(1);
		const connAInfoHandler = connAInfoCalls[0][1];

		// 2) remove（snapshot 删 '1'）→ manager.syncConnections 接手 disconnect，store 不直接 off
		const offCallsBefore = connA.off.mock.calls.length;
		mockManager.get.mockImplementation(() => undefined);
		store.applySnapshot([]);
		// 契约：store 不主动 conn.off（依赖 manager.disconnect → conn.disconnect → __listeners.clear）
		expect(connA.off.mock.calls.length).toBe(offCallsBefore);
		// 契约：snapshot 删 id 后 syncConnections 被调（即便 mock 下是 vi.fn no-op，调用本身是存在的）
		expect(mockManager.syncConnections).toHaveBeenCalledWith([]);

		// 3) re-add：新 connB 接管
		mockManager.get.mockImplementation((id) => (String(id) === '1' ? connB : undefined));
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);

		const connBInfoCalls = connB.on.mock.calls.filter(([ev]) => ev === 'event:coclaw.info.updated');
		expect(connBInfoCalls).toHaveLength(1);
		const connBInfoHandler = connBInfoCalls[0][1];
		// 关键：connA 和 connB 的 handler 是独立的闭包实例（`__bridgeConn` 每次 fire 新的箭头函数）
		expect(connAInfoHandler).not.toBe(connBInfoHandler);

		// 4) 触发"新 conn 上的事件" → 更新落到当前 claw state
		store.byId['1'].pluginInfo = { name: null, hostName: null };
		connBInfoHandler({ name: 'NewName', hostName: 'new-host' });
		expect(store.byId['1'].pluginInfo.name).toBe('NewName');

		// 5) snapshot 重建会为新 id 调 syncConnections(['1'])
		expect(mockManager.syncConnections).toHaveBeenCalledWith(['1']);
	});
});

// -------- G-05: __scheduleRetry timer 与 sig flip 的竞态 --------
// 审计结论：**未发现 bug**。
//
// 初始怀疑：timer fire 已置 `state.timer=null`（entry 保留）→ callback 调 `__ensureRtc`，
//   若期间 sig 掉线走 sig_offline bail 分支（claws.store.js:877 / :893）；bail 分支既
//   不 scheduleRetry 也不 clearRetry，怀疑 retry read-outs（retryCount / retryNextAt）残留
//   欺骗 getter `isConnectingRtc`（claws.store.js:206）。
// 审计发现：
//   - `__emitSigState('disconnected')` 是**同步**调 sigState handler →
//     `__freezeAllClawsForSigOffline` → 遍历 byId 对每个 claw 调 `__clearRetry`（:595）。
//     该路径**先于** `__ensureRtc` 的 post-await 或 for-loop sig_offline bail 跑，
//     retryCount / retryNextAt / entry 都已清零。
//   - 真实 `closeRtcForClaw` 调 `rtc.close()` 内部 `__setState('closed')` 同步触发
//     `__rtcCallbacks.onRtcStateChange('closed')`，把 rtcPhase 设为 'failed'、disconnectedAt=now。
//     post-await bail 的 snapshot/restore 读到的 prev 值就是 'failed' + now，**restore 后仍 failed**。
//   - 最终 UI 侧：`rtcPhase='failed' && retryNextAt=0` → isConnectingRtc=false；
//     sig 恢复时 `__resumeAllClawsForSigOnline` → `__resumeOnline` → `__ensureRtc` 兜底 rebuild。
// 两条 bug-hunting 测试跑出来"红"是 mock 缺陷——测试里的 fakeRtc.close()/mockCloseRtcForBot
//   不触发 onRtcStateChange('closed')，rtcPhase 卡在 L849 设的 'building' 假象。
//   真实 WebRtcConnection.close() (webrtc-connection.js:283-299) 会 fire callback，
//   产品无此残留。为避免"修 mock 以验证伪 bug"的噪音，两条测试保持 skip。
// 场景 A 留作设计意图的正面回归：sig 先掉线 → freeze 清 retry → sig 回来走 resume 路径 rebuild。
describe('G-05: retry timer vs sig flip race', () => {
	function setupRetryClaw(store, id = '1') {
		const fakeRtc = {
			state: 'failed', isReady: false, restartPaused: false,
			pauseRestart: vi.fn(), resumeRecovery: vi.fn(),
			triggerRestart: vi.fn(), nudgeRestart: vi.fn(),
			probe: vi.fn().mockResolvedValue(true),
			close: vi.fn(),
		};
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockImplementation((x) => (String(x) === id ? fakeConn : null));
		store.byId[id] = { ...createTestClaw(id), online: true, initialized: true, rtcPhase: 'failed', dcReady: false };
		store.fetched = true;
		return { fakeConn, fakeRtc };
	}

	// 场景 A：timer fire 前 sig 掉线 → freeze 同步清 retry state；recovery 由 sig-resume 路径接手
	// 这是 baseline 路径（已由 L5192 覆盖），此处作为 G-05 的对照：验证 sig 在 timer fire 前翻转
	// 时不存在竞态问题。
	test('场景 A（对照）：timer fire 前 sig 掉线 → freeze 清 retry → sig 恢复走 resume 路径重建', async () => {
		vi.useFakeTimers();
		try {
			const store = useClawsStore();
			setupRetryClaw(store);
			store.__bridgeLifecycle();

			store.__scheduleRetry('1');
			expect(store.byId['1'].retryCount).toBe(1);
			expect(store.byId['1'].retryNextAt).toBeGreaterThan(0);

			// timer fire 前 sig 掉线：freeze 同步调 __clearRetry
			__emitSigState('disconnected');
			expect(store.byId['1'].retryCount).toBe(0);
			expect(store.byId['1'].retryNextAt).toBe(0);

			// timer 本应在 3s fire，但已被 clear → 推进时间不触发 __ensureRtc
			mockInitRtc.mockClear();
			vi.advanceTimersByTime(60_000);
			expect(mockInitRtc).not.toHaveBeenCalled();

			// sig 恢复 → __resumeAllClawsForSigOnline 对 online+initialized+failed 走 __resumeOnline
			// → __resumeOnline 内部：rtc.state='failed' 不命中 restarting/connected 分支 → __ensureRtc 兜底 rebuild
			mockInitRtc.mockImplementation(async (_id, conn) => { conn.rtc = __fakeRtc; return 'rtc'; });
			__emitSigState('connected');
			// 推进 microtask，让 __ensureRtc 内部的 await initRtc 完成
			await Promise.resolve();
			await Promise.resolve();
			expect(mockInitRtc).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	// G-05 场景 B/C（原推测 bug，经 audit 核实非 bug）：
	// __emitSigState('disconnected') 同步触发 __freezeAllClawsForSigOffline 先于 bail 路径跑
	// __clearRetry，retry read-outs 已清；真实 WebRtcConnection.close() 同步触发 onRtcStateChange
	// 把 rtcPhase 写回 'failed'。故产品中 isConnectingRtc 正确返回 false。原 skip 测试依赖
	// fakeRtc.close() no-op 的 mock 缺陷才能挂红，与生产链路不符，已删除。
});

// -------- G-04: forceRestartCount vs Set.consume discrepancy --------
// 推测 bug：__resumeAllClawsForSigOnline 遍历 online+initialized claw：
//   L639 先据 `_pendingTypeChangedRestartClaws.has(id)` 记 forceRestartCount++，
//   L641 再调 __resumeOnline(id)。__resumeOnline 入口 L687
//   `if (_pendingTypeChangedRestartClaws.delete(id)) forceRestartOnConnected=true`
//   **无条件**消费 Set 条目；随后 L688-689 读 `manager.get(id)`，若 conn=null 立即 return。
// 矛盾：当 conn 在 sig 恢复的瞬间恰好缺失（manager.disconnect 竞态 / rebridge 未完）时，
//   Set 条目已被消费但没真 restart；诊断日志 `force_restart=N` 撒谎，且后续 conn 回来
//   再走 __resumeOnline 时 Set 已空 → forceRestartOnConnected=false → 走
//   resumeRecovery 而非 triggerRestart('online_resume')，typeChanged 信号永久丢失。
//
// 语义上：Set 代表"下次 __resumeOnline 命中时应升级为 force restart"的 pending 信号；
//   消费必须与真正的动作配对——conn 缺失导致 __resumeOnline 早退时，条目本应保留供后续消费。
describe('G-04: forceRestartCount vs Set.consume discrepancy', () => {
	function setupClaw(store, { id = '1', rtcState = 'connected', restartPaused = true } = {}) {
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
		store.byId[id] = { ...createTestClaw(id), online: true, initialized: true, dcReady: rtcState === 'connected' };
		store.fetched = true;
		return { fakeConn, fakeRtc };
	}

	// G-04 修复：__resumeOnline 把 Set.delete 延后到 conn 非空分支之后。
	// conn 缺失早退时 Set 条目保留，留给下次 resume（conn 回来后）消费——不丢 typeChanged 信号。
	// 注：__resumeAllClawsForSigOnline 的 forceRestartCount 仍按 Set.has 预计数（潜在数，非实发数），
	//   本轮不修改——按 audit 建议"需返回值改动面大"暂不推进
	test('sig resume 时 conn 缺失 → Set 条目保留、下次 conn 回来时信号被正确消费', () => {
		const store = useClawsStore();
		const { fakeConn, fakeRtc } = setupClaw(store);
		store.__bridgeLifecycle();

		// 阶段 1：sig 掉线 → __freezeAllClawsForSigOffline 调 pauseRestart
		__emitSigState('disconnected');
		expect(fakeRtc.pauseRestart).toHaveBeenCalledTimes(1);

		// 阶段 2：sig offline 期间 network:online(typeChanged=true)
		// 预循环 willHandleNow=false（_sigOffline=true）→ Set.add('1')；sig gate return 不进主循环
		window.dispatchEvent(new CustomEvent('network:online', { detail: { typeChanged: true } }));
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();

		// 阶段 3：构造 conn 竞态丢失——sig 恢复瞬间 manager.get 返回 null
		// 真实场景：用户短暂 logout/login、applySnapshot 删 claw 与重建的窗口期、
		// 或 syncConnections 对该 id 的短暂 drop-then-readd
		mockManager.get.mockImplementation(() => null);
		mockRemoteLog.mockClear();

		// 阶段 4：sig 恢复 → __resumeAllClawsForSigOnline 遍历 → '1' online+initialized
		// __resumeOnline: syncDashboardOnline → conn=null → return（Set 未被消费）
		const resumeSpy = vi.spyOn(store, '__resumeOnline');
		__emitSigState('connected');
		expect(resumeSpy).toHaveBeenCalledWith('1');
		expect(resumeSpy).toHaveBeenCalledTimes(1);

		// 核心断言：conn 缺失时没真 restart
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
		expect(fakeRtc.resumeRecovery).not.toHaveBeenCalled();
		// fakeConn 完全未被 __resumeOnline 触及（get 返回 null）
		expect(fakeConn.rtc).toBe(fakeRtc); // 未被 clearRtc

		// 信号未丢：Set 条目保留，供后续 conn 回来时消费
		mockManager.get.mockImplementation((x) => (String(x) === '1' ? fakeConn : null));
		resumeSpy.mockRestore();
		store.__resumeOnline('1');
		// 修复后行为：Set 条目在 conn=null 阶段保留，此次消费后走 triggerRestart('online_resume')
		expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('online_resume');
	});

	test('场景 B（对照）：sig resume 时 conn 存在 → Set 正确消费 + triggerRestart 发出 + log force_restart=1 一致', () => {
		const store = useClawsStore();
		const { fakeRtc } = setupClaw(store);
		store.__bridgeLifecycle();

		__emitSigState('disconnected');
		window.dispatchEvent(new CustomEvent('network:online', { detail: { typeChanged: true } }));
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();

		mockRemoteLog.mockClear();
		// conn 保持存在（setupClaw 注册的 mockImplementation 不动）
		__emitSigState('connected');

		// 对照组：正常路径 force_restart=1 名实相符
		expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('online_resume');
		expect(fakeRtc.triggerRestart).toHaveBeenCalledTimes(1);
		expect(mockRemoteLog).toHaveBeenCalledWith(expect.stringContaining('claw.sigOnline resumed count=1'));
		expect(mockRemoteLog).toHaveBeenCalledWith(expect.stringContaining('force_restart=1'));
	});
});

describe('G-07: repeated snapshot during sig offline (log-storm regression — 由 P1-2 覆盖)', () => {
	// round 12 观察到的 P2 log storm 已由 round 13 P1-2 修复（Phase 3 rescue 入口
	// `if (_sigOffline) continue;`）。修后行为（sig offline 期间 rescue 不 fire、sig
	// 恢复由 __resumeAllClawsForSigOnline 补跑）由 "P1-2: sig offline 重复 snapshot 防回归"
	// 覆盖。此处仅保留 sig online 对照作为"baseline 不污染"的快速 regression 断言

	test('场景 B（对照）：sig online 下连推 3 次 snapshot → 首次 fullInit 成功后 initialized=true，后续不再 fire', async () => {
		// 对照组：sig 正常时第一次 snapshot 的 fullInit 走到底 → initialized 保持 true
		// → 后续 snapshot 走 `initialized=true` 分支，不再进 rescue；无日志风暴
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
		// sig.state 默认 connected；__bridgeLifecycle 不置 _sigOffline
		store.__bridgeLifecycle();

		const fullInitSpy = vi.spyOn(store, '__fullInit');

		for (let i = 0; i < 3; i++) {
			store.applySnapshot([{ id: '1', name: 'A', online: true }]);
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		}

		// sig 正常：仅第一次 snapshot 的 __bridgeConn 路径 fire fullInit 一次
		// 后续 snapshot 因 claw.initialized=true 跳过 Phase 3 rescue 分支
		expect(fullInitSpy).toHaveBeenCalledTimes(1);
		expect(store.byId['1'].initialized).toBe(true);
	});
});

describe('P0-1: resumeRecovery 升级 vs __ensureRtc', () => {
	// 本题观测：__resumeOnline 的 connected+paused 分支调 rtc.resumeRecovery() 后，
	// 若 resumeRecovery 内部因 pc.connectionState=failed/disconnected 升级为
	// triggerRestart('online_resume') → rtc.__state 同步置 'restarting'（__setState 先于 await）
	// → 但 __resumeOnline L710-724 fall through 到 __ensureRtc(id)
	// → __ensureRtc early-return 条件是 rtc.state==='connected'（L839），'restarting' 不命中
	// → 继续跑到 L858 closeRtcForClaw(id)、L859 conn.clearRtc()，把刚 restart 的 PC 关掉 rebuild。
	//
	// 影响：多烧一轮 ICE/TURN 预算 + DC 不延续（新 SCTP 会丢 plugin 侧 buffer），恢复延迟数秒到十几秒。
	// 本组测试：暴露该行为，并与 "PC 健康不升级" / "forceRestart 早退" 两条正常路径形成对照。

	/** 构造带 PC 状态的 fakeRtc；resumeRecovery 模拟真实升级语义 */
	function makeRtcWithPc(pcState) {
		const rtc = {
			state: 'connected',
			isReady: true,
			restartPaused: true,
			__pcConnectionState: pcState,
			// 模拟 webrtc-connection.js L1195-1215：connected+paused 且 pc=failed/disconnected
			// 时升级为 triggerRestart('online_resume')，否则仅清 paused
			resumeRecovery: vi.fn().mockImplementation(function upgrade() {
				if (!rtc.restartPaused) return;
				if (rtc.state === 'connected'
					&& (rtc.__pcConnectionState === 'failed'
						|| rtc.__pcConnectionState === 'disconnected')) {
					rtc.triggerRestart('online_resume');
					return;
				}
				rtc.restartPaused = false;
			}),
			// 模拟 __attemptRestart L1034-1036：同步 __setState('restarting')（__stopKeepalive
			// 也同步），不 await
			triggerRestart: vi.fn().mockImplementation(function setRestart() {
				rtc.restartPaused = false;
				rtc.state = 'restarting';
			}),
			nudgeRestart: vi.fn(),
			pauseRestart: vi.fn(),
			probe: vi.fn().mockResolvedValue(true),
		};
		return rtc;
	}

	test('pc.connectionState=failed + connected+paused → resumeRecovery 升级 triggerRestart，__ensureRtc 不应关刚 restart 的 PC', async () => {
		// 修复：__resumeOnline 在 rtc.resumeRecovery() 后判断 rtc.state==='restarting'
		// 即 early return，不 fall through 到 __ensureRtc；避免刚升级的 restart PC
		// 被 __ensureRtc early-return (只认 connected) 当作"非连接态"走 rebuild 分支关掉。
		const store = useClawsStore();
		const fakeRtc = makeRtcWithPc('failed');
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;

		mockInitRtc.mockClear();
		mockCloseRtcForBot.mockClear();

		store.__resumeOnline('1');
		// 等 fall through 的 __ensureRtc microtask 跑完
		await new Promise((r) => setTimeout(r, 10));

		// 1) resumeRecovery 被调 1 次（升级入口）
		expect(fakeRtc.resumeRecovery).toHaveBeenCalledTimes(1);
		// 2) 内部升级为 triggerRestart('online_resume') 1 次
		expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('online_resume');
		expect(fakeRtc.triggerRestart).toHaveBeenCalledTimes(1);
		// 3) 刚 restart 的 PC 不应被 closeRtc（期望；当前实际会被关）
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
		// 4) 不应走 rebuild（期望；当前实际会 initRtc）
		expect(mockInitRtc).not.toHaveBeenCalled();
		// 5) conn.rtc 仍是同一实例（未被 clearRtc 置 null）
		expect(fakeConn.rtc).toBe(fakeRtc);
		// 6) rtc.state 停在 'restarting'（triggerRestart 升级后的状态）
		expect(fakeRtc.state).toBe('restarting');
	});

	test('pc.connectionState=disconnected + connected+paused → 同上路径（对称分支）', async () => {
		// resumeRecovery 对 disconnected 同样升级（webrtc-connection.js L1202 的 OR 条件）；
		// 预期与 failed 分支相同：closeRtc 不调、不 rebuild、rtc 实例保留
		const store = useClawsStore();
		const fakeRtc = makeRtcWithPc('disconnected');
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;

		mockInitRtc.mockClear();
		mockCloseRtcForBot.mockClear();

		store.__resumeOnline('1');
		await new Promise((r) => setTimeout(r, 10));

		expect(fakeRtc.resumeRecovery).toHaveBeenCalledTimes(1);
		expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('online_resume');
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
		expect(mockInitRtc).not.toHaveBeenCalled();
		expect(fakeConn.rtc).toBe(fakeRtc);
	});

	test('对照：pc.connectionState=connected + connected+paused → resumeRecovery 不升级，__ensureRtc early-return', async () => {
		// 对照组：PC 健康 → resumeRecovery 仅清 paused，不升级 triggerRestart
		// → rtc.state 仍 'connected' → __ensureRtc L839 early-return 命中
		// → 不 closeRtc、不 rebuild、dcReady 校正为 true
		const store = useClawsStore();
		const fakeRtc = makeRtcWithPc('connected');
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;
		store.byId['1'].dcReady = false; // 预置 false，验证 __ensureRtc early-return 分支会校正为 true

		mockInitRtc.mockClear();
		mockCloseRtcForBot.mockClear();

		store.__resumeOnline('1');
		await new Promise((r) => setTimeout(r, 10));

		// 1) resumeRecovery 被调，但不升级
		expect(fakeRtc.resumeRecovery).toHaveBeenCalledTimes(1);
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
		// 2) rtc.state 未翻转
		expect(fakeRtc.state).toBe('connected');
		// 3) paused 被 resumeRecovery 清
		expect(fakeRtc.restartPaused).toBe(false);
		// 4) __ensureRtc early-return：不 close、不 rebuild
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
		expect(mockInitRtc).not.toHaveBeenCalled();
		// 5) dcReady / rtcPhase 被 early-return 分支校正
		expect(store.byId['1'].dcReady).toBe(true);
		expect(store.byId['1'].rtcPhase).toBe('ready');
	});

	test('对照：forceRestartOnConnected=true + connected+paused → 走 triggerRestart + return，resumeRecovery 不调、__ensureRtc 不调', async () => {
		// 对照组：connected+paused 分支若 forceRestartOnConnected=true（typeChanged 记账命中）
		// → 直接 triggerRestart('online_resume') + return（claws.store.js L714-715）
		// → 完全绕过 resumeRecovery 和 fall through 的 __ensureRtc
		// 这是本 bug 无法触发的路径，用来证明"只有 resumeRecovery 升级+fall through"组合才炸
		const store = useClawsStore();
		const fakeRtc = makeRtcWithPc('failed'); // PC 即使 failed，此路径也不走 resumeRecovery
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockReturnValue(fakeConn);

		store.setClaws([{ id: '1', online: true }]);
		store.byId['1'].initialized = true;

		mockInitRtc.mockClear();
		mockCloseRtcForBot.mockClear();

		store.__resumeOnline('1', { forceRestartOnConnected: true });
		await new Promise((r) => setTimeout(r, 10));

		// 1) triggerRestart 被直调 1 次（非 resumeRecovery 内部升级）
		expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('online_resume');
		expect(fakeRtc.triggerRestart).toHaveBeenCalledTimes(1);
		// 2) resumeRecovery 根本不调（早退分支 return 前）
		expect(fakeRtc.resumeRecovery).not.toHaveBeenCalled();
		// 3) __ensureRtc 不调（L714 return 阻断 fall through）
		expect(mockCloseRtcForBot).not.toHaveBeenCalled();
		expect(mockInitRtc).not.toHaveBeenCalled();
		// 4) rtc 实例保留
		expect(fakeConn.rtc).toBe(fakeRtc);
	});
});

describe('P0-4: network:online 跨 gate 多 listener 顺序', () => {
	// 背景：WiFi↔蜂窝切换时，浏览器派发的同一 `network:online` 事件会被多个模块监听：
	//   - SignalingConnection（signaling-connection.js L111-114，在 `sigConn.connect()` 里注册）
	//     → `__handleForegroundResume` → typeChanged=true 时 `forceReconnect()`
	//       → 同步 `__setState('disconnected')` → state listener fire
	//   - claws.store（claws.store.js L463，`__bridgeLifecycle` 里注册）
	//     → `__handleNetworkOnline(typeChanged)` → sig gate 分派
	//
	// 真实启动顺序（AuthedLayout.vue L70）：登录 watcher 触发 `sigConn.connect()` 先发生，
	// 首个 claw 的 `__bridgeConn` 稍后跑 `__bridgeLifecycle`。所以 **sig handler 先注册、先执行**。
	//
	// 时序分析（WiFi→蜂窝 typeChanged=true，pre-sig=connected）：
	//   1) sig handler 先跑 → forceReconnect → `__setState('disconnected')` 同步
	//      → sig.on('state') listener 同步 fire → claws.store sigState handler 把
	//      `_sigOffline` 翻成 true + `__freezeAllClawsForSigOffline()` 冻结所有 claw
	//   2) 同一 tick 内 claws.store 的 net handler 接着跑 `__handleNetworkOnline(true)`
	//      → 预循环遍历记账 typeChanged（`_pendingTypeChangedRestartClaws.add(id)`，
	//        见 claws.store.js L1085-1102；willHandleNow=false 因为 `_sigOffline=true`）
	//      → sig gate 早退（L1104）—— **不走主循环、不发任何 offer 到旧 WS**
	//   3) sig 新 WS 回来 → sigState handler 翻 `_sigOffline=false`
	//      → `__resumeAllClawsForSigOnline` 遍历 → `__resumeOnline` 消费 Set
	//      → connected+paused 分支升级为 `triggerRestart('online_resume')`
	//
	// 结论（bug=no）：即使两个 handler 同一 tick 同步跑，sig handler 先翻 `_sigOffline`，
	//   claws.store 的 net handler 后跑时已经走 sig gate 记账分支，旧 WS 不会被污染。
	//
	// 本组测试主要用途：回归保护——防止将来调整注册顺序、sig state 翻转时机、
	//   或 `__handleNetworkOnline` 预循环顺序时破坏此协调不变量。
	//
	// 锚点：
	//   - signaling-connection.js L111-114（sig net handler register）/ L454-515 / L543-558
	//   - claws.store.js L407-464（__bridgeLifecycle 注册 sigState + net）
	//   - claws.store.js L1080-1172（__handleNetworkOnline：预循环记账 + sig gate return）
	//   - claws.store.js L611-648（__resumeAllClawsForSigOnline 消费 Set）

	function setupClaw(store, { id = '1', rtcState = 'connected', restartPaused = false, online = true } = {}) {
		const fakeRtc = {
			state: rtcState,
			isReady: true,
			restartPaused,
			pauseRestart: vi.fn().mockImplementation(() => { fakeRtc.restartPaused = true; }),
			resumeRecovery: vi.fn(),
			triggerRestart: vi.fn(),
			nudgeRestart: vi.fn(),
			probe: vi.fn().mockResolvedValue(true),
		};
		const fakeConn = { rtc: fakeRtc, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn() };
		mockManager.get.mockImplementation((x) => (String(x) === id ? fakeConn : null));
		store.byId[id] = { ...createTestClaw(id), online, initialized: true, dcReady: rtcState === 'connected' };
		store.fetched = true;
		return { fakeConn, fakeRtc };
	}

	test('listener 注册顺序：__bridgeLifecycle 后 sig listener 已挂，claws.store 的 net handler 亦挂', () => {
		// 验证 __bridgeLifecycle 确实在 `network:online` 上挂了 handler，且在 sig 上订 'state'。
		// 真实启动中 sig handler 在 claws.store 之前挂（`sigConn.connect()` 先于首个 __bridgeConn），
		// 这里不直接验证相对顺序（需跑 SignalingConnection 真实实例），但验证 claws.store
		// 这一侧的挂载不变——这是时序分析的基础断言。
		const addSpy = vi.spyOn(window, 'addEventListener');
		const store = useClawsStore();
		setupClaw(store);
		store.__bridgeLifecycle();

		// claws.store 至少注册了 network:online + app:background + app:foreground
		const netCalls = addSpy.mock.calls.filter((c) => c[0] === 'network:online');
		const sigOnCalls = __mockSig.on.mock.calls.filter((c) => c[0] === 'state');
		expect(netCalls.length).toBeGreaterThanOrEqual(1);
		expect(sigOnCalls.length).toBe(1);
		// sigState handler 与 net handler 均已登记（handler 身份为 function）
		expect(typeof netCalls[0][1]).toBe('function');
		expect(typeof sigOnCalls[0][1]).toBe('function');
		addSpy.mockRestore();
	});

	test('sig offline + 单 tick network:online(typeChanged=true)：早退 + 记账 + sig 恢复后升级 triggerRestart', () => {
		// 模拟真实 WiFi→蜂窝切换的同一 tick 多 listener 顺序：
		//   step 1：sig 的 forceReconnect 同步翻 state=disconnected（由本测试手动 __emitSigState 代劳）
		//   step 2：同 tick claws.store 的 net handler 跑 __handleNetworkOnline(true)
		//   → 此时 `_sigOffline=true` 已经被 step 1 的 sigState handler 翻过
		//   → 走预循环记账 + sig gate return（不发 triggerRestart 不调 nudgeRestart）
		const store = useClawsStore();
		const { fakeRtc } = setupClaw(store, { rtcState: 'connected', restartPaused: false });
		store.__bridgeLifecycle();

		// step 1：模拟 sig forceReconnect 的状态同步 —— disconnected 翻转冻结所有 claw
		__emitSigState('disconnected');
		expect(fakeRtc.pauseRestart).toHaveBeenCalledTimes(1);
		expect(fakeRtc.restartPaused).toBe(true); // freeze 生效

		// step 2：同 tick 内 window 派发 network:online(typeChanged=true)
		// claws.store 的 net handler 观察到 _sigOffline=true，只记账不动作
		window.dispatchEvent(new CustomEvent('network:online', { detail: { typeChanged: true } }));
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
		expect(fakeRtc.nudgeRestart).not.toHaveBeenCalled();
		expect(fakeRtc.resumeRecovery).not.toHaveBeenCalled();

		// step 3：新 WS 回来（sig state → connected）→ resume 遍历消费 Set
		// → connected+paused+forceRestart → triggerRestart('online_resume')（paused 唯一穿透 reason）
		__emitSigState('connected');
		expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('online_resume');
		expect(fakeRtc.triggerRestart).toHaveBeenCalledTimes(1);
		expect(fakeRtc.resumeRecovery).not.toHaveBeenCalled();
	});

	test('sig=connecting（forceReconnect 过渡态）+ network:online(typeChanged=true)：sig gate 仍生效', () => {
		// 更精确对齐真实 forceReconnect 行为：__setState('disconnected') 后立即 __doConnect()
		// 会再同步翻到 'connecting'（signaling-connection.js L544-558 + __doConnect 内部 setState）。
		// 对 claws.store 而言 `_sigOffline` 只认 'connected' 为 false（L443-444：shouldBeOffline = newState !== 'connected'），
		// 所以 connecting 依然被视为 offline，sig gate 生效。
		const store = useClawsStore();
		const { fakeRtc } = setupClaw(store, { rtcState: 'connected', restartPaused: false });
		store.__bridgeLifecycle();

		// 模拟 forceReconnect 的 disconnected→connecting 两次状态切换（同步）
		__emitSigState('disconnected');
		__emitSigState('connecting');
		// connecting 仍算 sig offline → freeze 依旧（幂等去重后 pauseRestart 只发 1 次）
		expect(fakeRtc.pauseRestart).toHaveBeenCalledTimes(1);

		// 同 tick 派发 network:online(typeChanged=true)
		window.dispatchEvent(new CustomEvent('network:online', { detail: { typeChanged: true } }));
		// 断言：sig=connecting 时主循环依然被 sig gate 拦住，不发 offer
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
		expect(fakeRtc.nudgeRestart).not.toHaveBeenCalled();

		// sig 新 WS 终于 connected → 消费 Set 升级 triggerRestart
		__emitSigState('connected');
		expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('online_resume');
	});

	test('sig=connected（假想 sig handler 没来得及翻转）+ typeChanged=true：非 paused claw 走 triggerRestart(network_type_changed)', () => {
		// 反向对照场景：如果 sig 的 state 翻转被延迟（不在同 tick），claws.store 的 net handler
		// 先跑到主循环时 `_sigOffline` 仍为 false → 走 connected+非 paused 分支直发
		// triggerRestart('network_type_changed')。此场景描述"顺序反过来"的情形——此时
		// 主循环会真的把 offer 发去当时的 WS 实例（由底层 sendSignaling 处理），但这不属于
		// "旧 WS 陈尸"情境——只要 sig state 未翻，WS 就仍被视为可用。
		// 本 test 验证：非 paused + connected + sig 仍在线场景下的动作是 triggerRestart
		// 而非 resumeRecovery / nudge，且不走 Set 记账（预循环 willHandleNow=true 不 add）。
		const store = useClawsStore();
		const { fakeRtc } = setupClaw(store, { rtcState: 'connected', restartPaused: false });
		store.__bridgeLifecycle();
		// sig 保持 connected（不触发任何翻转）

		window.dispatchEvent(new CustomEvent('network:online', { detail: { typeChanged: true } }));

		// 主循环匹配 connected+非 paused+typeChanged → triggerRestart('network_type_changed')
		expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('network_type_changed');
		expect(fakeRtc.triggerRestart).toHaveBeenCalledTimes(1);
		// 后续即使再走一轮 sig down/up，Set 已在主循环末尾被 delete（L1159）→ 不再虚发 online_resume
		fakeRtc.triggerRestart.mockClear();
		// 模拟 sig 抖动：restartPaused 被 freeze 置 true
		__emitSigState('disconnected');
		__emitSigState('connected');
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
		expect(fakeRtc.resumeRecovery).toHaveBeenCalledTimes(1);
	});

	test('完整序列：sig freeze → network:online(typeChanged=true) 记账 → sig resume 消费 triggerRestart，中间旧 WS 未收到任何 RTC 信令', () => {
		// 端到端回归：验证完整 WiFi→蜂窝协调路径的动作序列与调用次数，防止将来回归
		// （如：有人删掉 sig gate return、或把 Set 消费时机提前到预循环）
		const store = useClawsStore();
		const { fakeRtc } = setupClaw(store, { rtcState: 'connected', restartPaused: false });
		store.__bridgeLifecycle();

		// Phase A：sig 翻 disconnected（模拟 forceReconnect 关旧 WS）
		__emitSigState('disconnected');
		expect(fakeRtc.pauseRestart).toHaveBeenCalledTimes(1);

		// Phase B：同 tick network:online(typeChanged=true) 记账
		window.dispatchEvent(new CustomEvent('network:online', { detail: { typeChanged: true } }));
		// 确认 Phase B 期间完全没有 RTC 动作外发（若有任何 offer 发去旧 WS，这里会见到）
		expect(fakeRtc.triggerRestart).not.toHaveBeenCalled();
		expect(fakeRtc.nudgeRestart).not.toHaveBeenCalled();
		expect(fakeRtc.resumeRecovery).not.toHaveBeenCalled();

		// Phase C：sig 新 WS 建好 → __resumeAllClawsForSigOnline 消费 Set
		__emitSigState('connected');

		// 最终断言：triggerRestart 被调 1 次、理由 online_resume、无多余 resume/nudge
		expect(fakeRtc.triggerRestart).toHaveBeenCalledTimes(1);
		expect(fakeRtc.triggerRestart).toHaveBeenCalledWith('online_resume');
		expect(fakeRtc.nudgeRestart).not.toHaveBeenCalled();
		expect(fakeRtc.resumeRecovery).not.toHaveBeenCalled();
	});
});

describe('P1-3: sig offline 重复 updateClawOnline 防回归', () => {
	// 对称 P1-2 的 SSE 增量版本：sig offline 期间 server SSE 反复推 `claw.status online=true`
	// （或 reconnect 时连续回放）→ updateClawOnline 多次。
	// 修法的内置防御：第一次调用同步 set claw.initialized=true → 后续调用 `else if (!initialized)`
	// 短路退出。`__ensureRtc` 内部 sig gate 进一步保证 mockInitRtc 在 sig offline 下 0 调用。
	// 回归目标：同步多次 updateClawOnline 不产生 mockInitRtc 风暴 + fullInit 日志仅 1 条。
	test('sig offline + 同步连续 3 次 updateClawOnline(id, true) → fullInit 仅 fire 1 次、mockInitRtc 0 调用', async () => {
		const store = useClawsStore();
		const fakeConn = {
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		// 准备初态：fetched 已翻、_sigOffline=true、byId 含一条 online=false + initialized=false 的 claw
		store.fetched = true;
		store.setClaws([{ id: '1', name: 'A' }]);
		store.byId['1'].online = false;
		store.byId['1'].initialized = false;

		store.__bridgeLifecycle();
		__emitSigState('disconnected');
		// __bridgeConn 之前已注册，__bridgeLifecycle 不重复注册；setClaws 不调 __bridgeConn

		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		for (let i = 0; i < 3; i++) {
			store.updateClawOnline('1', true);
		}

		// 微任务 flush：让 __fullInit 内部 await + catch 回滚跑完
		await vi.waitFor(() => expect(store.byId['1'].initialized).toBe(false));

		// 断言 1：sig 离线下 __ensureRtc 入口 sig gate 拦住，initRtc 0 调用
		expect(mockInitRtc).not.toHaveBeenCalled();

		// 断言 2：__fullInit 仅 fire 1 次（initialized=true sync set 让后续 2 次调用短路）
		const fullInitLogs = mockRemoteLog.mock.calls.filter(([msg]) =>
			typeof msg === 'string' && msg.startsWith('claw.fullInit '),
		);
		expect(fullInitLogs.length).toBe(1);

		warnSpy.mockRestore();
	});
});

describe('P1-2: sig offline 重复 snapshot 防回归', () => {
	// 修法：Phase 3 rescue 入口加 `if (_sigOffline) continue;`（与 __ensureRtc 入口
	// sig gate 对称）。sig offline 期间 SSE 连推同一 snapshot 不再每次 fire __fullInit；
	// sig 恢复时由 __resumeAllClawsForSigOnline 统一补跑 !initialized 分支。
	// 回归目标：rescue 在 sig offline 下只有首次 bridge 时的一次 __fullInit 调用，
	// 不再产生 2N 条诊断日志（`claw.fullInit` remoteLog + `snapshot rescue` warn）。
	test('场景 A：sig offline + 连推 3 次 snapshot → rescue 被 sig gate 拦，__fullInit 只在首次 bridge 时 fire 一次', async () => {
		// 修法：Phase 3 rescue 入口 `if (_sigOffline) continue;`（对称 __ensureRtc sig gate）
		// 首次 __bridgeConn 路径仍 fire 一次（__ensureRtc 内部 sig gate 会拦住，不烧 TURN），
		// 后续重复 snapshot 不再触发 rescue；sig 恢复由 __resumeAllClawsForSigOnline 补跑
		const store = useClawsStore();
		const fakeConn = {
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		store.__bridgeLifecycle();
		__emitSigState('disconnected');

		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		for (let i = 0; i < 3; i++) {
			store.applySnapshot([{ id: '1', name: 'A', online: true }]);
			await vi.waitFor(() => expect(store.byId['1'].initialized).toBe(false));
		}

		// 预期：rescue 分支被 sig gate 挡住，fullInit 只来自首次 __bridgeConn
		const fullInitLogs = mockRemoteLog.mock.calls.filter(([msg]) =>
			typeof msg === 'string' && msg.startsWith('claw.fullInit '),
		);
		expect(fullInitLogs.length).toBe(1);

		const rescueWarnCount = warnSpy.mock.calls.filter(([msg]) =>
			typeof msg === 'string' && msg.includes('fullInit (snapshot rescue) failed'),
		).length;
		expect(rescueWarnCount).toBe(0);

		expect(mockInitRtc).not.toHaveBeenCalled();

		warnSpy.mockRestore();
	});

	test('场景 B（对照）：sig online + 连推 3 次 snapshot → __fullInit 仅 fire 一次', async () => {
		// 对照组：sig 正常时首次 __fullInit 走到底 → initialized 保持 true →
		// 后续 snapshot 走 `initialized=true` 分支，Phase 3 rescue 不进。这是 sig offline
		// 路径不会造成功能回归的 baseline。
		// 显式重置 checkPluginVersion（前面 test leak 了 rejected mock 会导致 fullInit 误失败）
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
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);
		// __mockSigState 默认 connected；__bridgeLifecycle 不置 _sigOffline
		store.__bridgeLifecycle();

		const fullInitSpy = vi.spyOn(store, '__fullInit');

		for (let i = 0; i < 3; i++) {
			store.applySnapshot([{ id: '1', name: 'A', online: true }]);
			// 让 fullInit 的 microtask 链完整跑完
			await vi.waitFor(() => expect(store.byId['1'].initialized).toBe(true));
		}

		// 断言 1：__fullInit 只调 1 次（首次 __bridgeConn 路径，后续 snapshot 因 initialized=true
		// 跳过 rescue）
		expect(fullInitSpy).toHaveBeenCalledTimes(1);

		// 断言 2：initialized 稳定为 true（fullInit 成功）
		expect(store.byId['1'].initialized).toBe(true);

		// 断言 3：`claw.fullInit` remoteLog 也只有 1 条——sig online 下绝不能出现 N 条风暴
		const fullInitLogs = mockRemoteLog.mock.calls.filter(([msg]) =>
			typeof msg === 'string' && msg.startsWith('claw.fullInit '),
		);
		expect(fullInitLogs.length).toBe(1);
	});

	test('场景 C：sig online → offline → 重复 snapshot → online：sig 恢复后 fullInit 补跑一次且 initialized 稳定', async () => {
		// 全链路断言：sig offline 期间 rescue 被 sig gate 拦（仅首次 bridge 的 __fullInit
		// 尝试会触发），sig 恢复后 __resumeAllClawsForSigOnline 为 !initialized 的 online
		// claw 补跑一次 __fullInit，initialized 稳定为 true
		// 显式重置 checkPluginVersion（前面 test leak 了 rejected mock 会导致 fullInit 误失败）
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
			rtc: null, on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);
		store.__bridgeLifecycle();

		// Phase A：sig 先翻 disconnected（设 _sigOffline=true），再推 snapshot。
		// 此时 __bridgeConn 首触 __fullInit 会被 sig gate 拦 → initialized 回滚 false
		__emitSigState('disconnected');

		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		for (let i = 0; i < 3; i++) {
			store.applySnapshot([{ id: '1', name: 'A', online: true }]);
			await vi.waitFor(() => expect(store.byId['1'].initialized).toBe(false));
		}

		// 断言 1：sig offline 期间 initRtc 从未被调（sig gate 挡住），initialized=false
		expect(mockInitRtc).not.toHaveBeenCalled();
		expect(store.byId['1'].initialized).toBe(false);

		// 记录 sig offline 期间的 fullInit 日志数（作为后续增量比对基线）
		const sigOfflineFullInitCount = mockRemoteLog.mock.calls.filter(([msg]) =>
			typeof msg === 'string' && msg.startsWith('claw.fullInit '),
		).length;
		// 修法后：Phase 3 rescue 被 sig gate 拦，rescue 不 fire；仅首次 __bridgeConn 一次
		expect(sigOfflineFullInitCount).toBe(1);

		// Phase B：sig 恢复 → __resumeAllClawsForSigOnline 遍历 online + !initialized 补跑 fullInit
		__emitSigState('connected');

		// __resumeAllClawsForSigOnline 调 __fullInit，awaits __ensureRtc → initRtc 成功 → isReady
		// → checkPluginVersion → initClawResources。等 initialized 翻 true
		await vi.waitFor(() => expect(store.byId['1'].initialized).toBe(true));

		// 断言 2：sig 恢复后 initRtc 被调（RTC 真建起来）
		expect(mockInitRtc).toHaveBeenCalled();

		// 断言 3：sig 恢复补跑仅 1 次 fullInit（resumedCount=1 的对应日志也应出现）
		const totalFullInitCount = mockRemoteLog.mock.calls.filter(([msg]) =>
			typeof msg === 'string' && msg.startsWith('claw.fullInit '),
		).length;
		expect(totalFullInitCount).toBe(sigOfflineFullInitCount + 1);

		// 断言 4：sig resume 路径打出 claw.sigOnline 诊断日志（count=1）
		expect(mockRemoteLog).toHaveBeenCalledWith(
			expect.stringMatching(/^claw\.sigOnline resumed count=1/),
		);

		// Phase C：再来一次 snapshot（sig 已 online，initialized 已 true）
		// → Phase 3 rescue 不再进，fullInit 计数不再增长
		store.applySnapshot([{ id: '1', name: 'A', online: true }]);
		await Promise.resolve();
		await Promise.resolve();

		const finalFullInitCount = mockRemoteLog.mock.calls.filter(([msg]) =>
			typeof msg === 'string' && msg.startsWith('claw.fullInit '),
		).length;
		expect(finalFullInitCount).toBe(totalFullInitCount);
		expect(store.byId['1'].initialized).toBe(true);

		warnSpy.mockRestore();
	});
});

describe('P2-3: malformed snapshot 防御', () => {
	// 背景：applySnapshot 在 Phase 1 用 `String(b.id ?? '')` + `if (!id) continue` 过滤
	// null/undefined/missing/"" 四种"空"型 id；但 Phase 2 紧跟的
	//   `const clawIds = arr.map((b) => String(b.id));`
	// 并不过滤（见 claws.store.js:342），直接把 malformed id 转成字符串传给
	// manager.syncConnections。后果：server 快照若带异常 id，会在 ClawConnectionManager
	// 里注册出 "null" / "undefined" / "[object Object]" / "" 等 ghost 连接实例。
	//
	// 下面分两组测试：
	// 1) 当前 byId 层面的防御（已存在，针对 null/undefined/missing/""）—— active
	// 2) 暴露 bug 的断言（syncConnections 仍收到 malformed；string "null"/"undefined"
	//    未被过滤会进 byId）—— test.skip + TODO(bug)

	test('byId 跳过 null/undefined/missing/空字符串 id 项（Phase 1 防御，已存在）', () => {
		const store = useClawsStore();
		mockManager.get.mockReturnValue(null);

		store.applySnapshot([
			{ id: null, name: 'bad-null' },
			{ id: undefined, name: 'bad-undef' },
			{ name: 'bad-missing' }, // id 缺失
			{ id: '', name: 'bad-empty' },
			{ id: '1', name: 'good' },
		]);

		// 断言 1：byId 只含正常 claw
		expect(Object.keys(store.byId)).toEqual(['1']);
		// 断言 2：正常 claw 内容正确
		expect(store.byId['1'].name).toBe('good');
		// 断言 3：fetched 标记正常翻转
		expect(store.fetched).toBe(true);
	});

	test('byId 跳过 string "null" / "undefined" / "[object Object]" 等 malformed id', () => {
		// applySnapshot 入口的 filter 对非空 string / number 放行；拒绝 null/undefined/
		// {}/空串/boolean/Symbol，以及 String() 产物为 ghost 字面量的 string 字面量
		const store = useClawsStore();
		mockManager.get.mockReturnValue(null);

		store.applySnapshot([
			{ id: 'null', name: 'bad-str-null' },
			{ id: 'undefined', name: 'bad-str-undef' },
			{ id: {}, name: 'bad-obj' }, // String({}) → "[object Object]"
			{ id: '1', name: 'good' },
		]);

		// 期望：byId 只有 '1'
		expect(Object.keys(store.byId)).toEqual(['1']);
		expect(store.byId['null']).toBeUndefined();
		expect(store.byId['undefined']).toBeUndefined();
		expect(store.byId['[object Object]']).toBeUndefined();
	});

	test('syncConnections 只收到有效 id（Phase 2 map 走 validArr，不再产 ghost id）', () => {
		// Phase 2 `validArr.map(String)` 仅对已过滤的有效条目转字符串，不会把
		// null/undefined/{} 以 "null"/"undefined"/"[object Object]" 身份送进 manager
		const store = useClawsStore();
		mockManager.get.mockReturnValue(null);

		store.applySnapshot([
			{ id: null, name: 'bad-null' },
			{ id: undefined, name: 'bad-undef' },
			{ id: '', name: 'bad-empty' },
			{ id: 'null', name: 'bad-str-null' },
			{ id: 'undefined', name: 'bad-str-undef' },
			{ id: {}, name: 'bad-obj' },
			{ id: '1', name: 'good' },
		]);

		// 期望：syncConnections 只收到正常 claw 的 id
		expect(mockManager.syncConnections).toHaveBeenCalledTimes(1);
		const passedIds = mockManager.syncConnections.mock.calls[0][0];
		expect(passedIds).toEqual(['1']);

		// 显式反向断言——任一 malformed 字面量都不该出现在参数里
		const forbidden = ['null', 'undefined', '', '[object Object]'];
		for (const bad of forbidden) {
			expect(passedIds).not.toContain(bad);
		}
	});

	test('纯 malformed snapshot（null/undefined/missing/空）：applySnapshot 不崩、byId 空、fetched=true', () => {
		const store = useClawsStore();
		mockManager.get.mockReturnValue(null);

		// 场景：server 快照异常（或被 proxy 篡改），整批 item 都 malformed
		// 契约：store 必须稳健降级——不抛异常、byId 空、fetched 仍翻转以放行后续 SSE
		expect(() => {
			store.applySnapshot([
				{ id: null, name: 'a' },
				{ id: undefined, name: 'b' },
				{ name: 'c' }, // id 缺失
				{ id: '', name: 'd' },
			]);
		}).not.toThrow();

		// 断言 1：无 claw 进 byId
		expect(Object.keys(store.byId)).toEqual([]);
		// 断言 2：fetched 翻转（防止上游 fetched gate 永远卡死）
		expect(store.fetched).toBe(true);
		// 断言 3：没有 claw 被桥接 → initRtc 不被触发
		expect(mockInitRtc).not.toHaveBeenCalled();
	});

	test('纯 malformed snapshot 下 syncConnections 收空列表', () => {
		// 全部被 filter 拦掉后，Phase 2 map 输出空列表；manager 不建 ghost 连接
		const store = useClawsStore();
		mockManager.get.mockReturnValue(null);

		store.applySnapshot([
			{ id: null, name: 'a' },
			{ id: undefined, name: 'b' },
			{ name: 'c' },
			{ id: '', name: 'd' },
		]);

		// 期望：整批 item 都 malformed → desired 同步列表应为空
		expect(mockManager.syncConnections).toHaveBeenCalledWith([]);
	});

	test('snapshot 含数字型 id（边缘容忍）：正常进 byId 并参与 syncConnections', () => {
		// 数字 id 不属于明确 malformed（`String(123)='123'` 对 Map key 安全），
		// 但 server 合约通常是字符串——这里固化当前行为，防未来收紧过滤时误伤
		const store = useClawsStore();
		mockManager.get.mockReturnValue(null);

		store.applySnapshot([
			{ id: 123, name: 'num-id' },
			{ id: '1', name: 'str-id' },
		]);

		// 断言 1：数字 id 会被 String() 规范化进 byId
		expect(Object.keys(store.byId).sort()).toEqual(['1', '123']);
		// 断言 2：syncConnections 收到规范化后的两个字符串 id
		expect(mockManager.syncConnections).toHaveBeenCalledWith(['123', '1']);
		// 断言 3：存取一致（byId key 与 syncConnections 参数同 key）
		expect(store.byId['123'].name).toBe('num-id');
		expect(store.byId['1'].name).toBe('str-id');
	});

	test('applySnapshot duplicate id → last-write-wins、byId 单条', () => {
		// 同一 snapshot 内出现两条 id 相同的 item：byId 用对象键唯一性去重（last-write-wins），
		// 传给 manager.syncConnections 的 ids 数组保持原顺序（含 dup），由 manager 内部 Set 去重。
		// 锁住 store 这一层"byId 单条 + 单次 batched 调用 manager"语义即可。
		const store = useClawsStore();
		mockManager.get.mockReturnValue(null);
		mockManager.syncConnections.mockClear();

		store.applySnapshot([
			{ id: 'd1', name: 'First' },
			{ id: 'd1', name: 'Second' },
		]);

		// 断言 1：byId 只剩一条，且为后写入的 'Second'
		expect(Object.keys(store.byId)).toEqual(['d1']);
		expect(store.byId['d1'].name).toBe('Second');
		// 断言 2：syncConnections 单次 batched 调用（不会因为 dup id 退化成 N 次）
		expect(mockManager.syncConnections).toHaveBeenCalledTimes(1);
	});

	test('applySnapshot dup-id online 冲突 → 最终 online 取 last-wins、不触发 __handleClawGoOffline', async () => {
		// 同一 snapshot 内重复 id + 中间 online 翻转：byId 终态 = 最后一条；
		// Phase 1 prevOnlineMap 在第二轮被第一轮的 post-assign 值覆盖 → Phase 3 看到的 prev 是
		// 中间态而非真正的 prev=true。结果：原本 prev=true→true（no-op）变成 prev=false→true，
		// 走 __resumeOnline 一次；__handleClawGoOffline 始终不被调（因为 final online=true）。
		// 锁定 dedupe 在 Phase 3 toResume Set 里完成，transition 仅一次的当前语义。
		const store = useClawsStore();
		const fakeRtc = { state: 'connected', isReady: true, restartPaused: false, probe: vi.fn(), nudgeRestart: vi.fn() };
		const fakeConn = {
			on: vi.fn(), off: vi.fn(), clearRtc: vi.fn(),
			rtc: fakeRtc, request: vi.fn().mockResolvedValue({}),
		};
		mockManager.get.mockReturnValue(fakeConn);

		// 初态：byId 含 d1，online=true、initialized=true（用 setClaws + 手动改字段建立）
		store.setClaws([{ id: 'd1', name: 'init' }]);
		store.byId['d1'].online = true;
		store.byId['d1'].initialized = true;
		store.byId['d1'].dcReady = true;

		const handleOfflineSpy = vi.spyOn(store, '__handleClawGoOffline');
		const resumeOnlineSpy = vi.spyOn(store, '__resumeOnline');

		store.applySnapshot([
			{ id: 'd1', name: 'mid', online: false },
			{ id: 'd1', name: 'final', online: true },
		]);

		// 断言 1：byId 终态 last-wins
		expect(Object.keys(store.byId)).toEqual(['d1']);
		expect(store.byId['d1'].online).toBe(true);
		expect(store.byId['d1'].name).toBe('final');

		// 断言 2：__handleClawGoOffline 不被调（final online=true，Phase 3 不进 true→false 分支）
		expect(handleOfflineSpy).not.toHaveBeenCalled();

		// 断言 3：__resumeOnline 仅 1 次（Phase 3 toResume Set 去重 dup-id 的两次 add）
		expect(resumeOnlineSpy).toHaveBeenCalledTimes(1);
		expect(resumeOnlineSpy).toHaveBeenCalledWith('d1');
	});

	test('防御性锁定：非空旧态 + 全 malformed snapshot → byId 清空、closeRtc 调每个旧 id 一次', () => {
		// 锁定当前"全 malformed = 等价空快照"语义：旧 claw 被 Phase 2 清理 + manager.syncConnections([])。
		// 未来若改为"保留旧态"必须显式拍板（修法时同步更新本测试）。
		const store = useClawsStore();
		mockManager.get.mockReturnValue(null);
		mockManager.syncConnections.mockClear();
		mockCloseRtcForBot.mockClear();

		// 初态：两个真实 claw（已建过 RTC）
		store.setClaws([
			{ id: 'real-1', name: 'A' },
			{ id: 'real-2', name: 'B' },
		]);
		store.byId['real-1'].online = true;
		store.byId['real-1'].initialized = true;
		store.byId['real-1'].dcReady = true;
		store.byId['real-2'].online = true;
		store.byId['real-2'].initialized = true;
		store.byId['real-2'].dcReady = true;

		// 全 malformed snapshot：所有 item 被 filter 拦下
		store.applySnapshot([
			{ id: null, name: 'x' },
			{ id: '[object Object]', name: 'y' },
		]);

		// 断言 1：byId 全空（旧 claw 被 Phase 2 清理）
		expect(Object.keys(store.byId)).toEqual([]);
		// 断言 2：closeRtcForClaw 对每个旧 id 调一次
		expect(mockCloseRtcForBot).toHaveBeenCalledTimes(2);
		expect(mockCloseRtcForBot).toHaveBeenCalledWith('real-1');
		expect(mockCloseRtcForBot).toHaveBeenCalledWith('real-2');
		// 断言 3：syncConnections 收空列表（manager 不建 ghost 连接）
		expect(mockManager.syncConnections).toHaveBeenCalledTimes(1);
		expect(mockManager.syncConnections).toHaveBeenCalledWith([]);
	});
});

describe('P2-4: malformed addOrUpdateClaw id 防御', () => {
	// 背景：旧 `if (!claw?.id) return;` 真值检查通过 `{id: {}}` / `{id: []}` /
	// `{id: 'null'}` / `{id: '[object Object]'}` 等 truthy 但 String() 后会产生 ghost 字面量
	// 的输入；`String({})='[object Object]'` 等被写进 byId + manager.connect 创建 ghost 连接。
	// 修法：复用 `__validateClawId` 与 applySnapshot 入口保持一致的过滤规则。

	test('字面量 / 容器型 malformed id：不写入 byId、不调 manager.connect', () => {
		const store = useClawsStore();
		mockManager.connect.mockClear();
		mockManager.get.mockReturnValue(null);

		const malformed = [
			{ id: {}, name: 'obj' },                  // String({}) → '[object Object]'
			{ id: [], name: 'arr' },                  // String([]) → ''（旧 `!claw?.id` 已拦，新加固保持）
			{ id: ['x'], name: 'arr-1' },              // String(['x']) → 'x'（旧逻辑会建 ghost）
			{ id: null, name: 'null' },
			{ id: undefined, name: 'undef' },
			{ id: '[object Object]', name: 'ghost-str' },
			{ id: '   ', name: 'whitespace' },
			{ id: 'null', name: 'str-null' },
			{ id: 'undefined', name: 'str-undef' },
			{ id: '', name: 'empty' },
			{ id: NaN, name: 'nan' },                  // Number 但非 finite
			{ id: true, name: 'bool' },                // boolean，typeof !== 'string'/'number'
		];
		for (const m of malformed) store.addOrUpdateClaw(m);

		expect(Object.keys(store.byId)).toEqual([]);
		expect(mockManager.connect).not.toHaveBeenCalled();
	});

	test('反向 sanity：合法 string / number id 正常进入 byId', () => {
		const store = useClawsStore();
		mockManager.connect.mockClear();
		mockManager.get.mockReturnValue({
			on: vi.fn(), off: vi.fn(), rtc: null, clearRtc: vi.fn(),
			request: vi.fn().mockResolvedValue({}),
		});

		store.addOrUpdateClaw({ id: 'real-claw-1', name: 'A' });
		store.addOrUpdateClaw({ id: 12345, name: 'B' });

		expect(Object.keys(store.byId).sort()).toEqual(['12345', 'real-claw-1']);
		expect(store.byId['real-claw-1'].name).toBe('A');
		expect(store.byId['12345'].name).toBe('B');
		expect(mockManager.connect).toHaveBeenCalledWith('real-claw-1');
		expect(mockManager.connect).toHaveBeenCalledWith('12345');
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
