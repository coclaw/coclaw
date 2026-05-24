import { createPinia } from 'pinia';
import { mount, flushPromises } from '@vue/test-utils';
import { describe, test, expect, vi, beforeEach } from 'vitest';

import ManageClawsPage from './ManageClawsPage.vue';

// ---- mocks ----

vi.mock('../services/claws.api.js', () => ({
	listClaws: vi.fn().mockResolvedValue([]),
	unbindClawByUser: vi.fn().mockResolvedValue({}),
}));

import { unbindClawByUser } from '../services/claws.api.js';

const mockNotify = {
	success: vi.fn(),
	error: vi.fn(),
	info: vi.fn(),
	warning: vi.fn(),
};
vi.mock('../composables/use-notify.js', () => ({
	useNotify: () => mockNotify,
}));

const mockLoadDashboard = vi.fn().mockResolvedValue(undefined);
const mockGetDashboard = vi.fn().mockReturnValue(null);
const mockClearDashboard = vi.fn();

let mockGetReadyConn = vi.fn().mockReturnValue(null);

vi.mock('../stores/get-ready-conn.js', () => ({
	getReadyConn: (...args) => mockGetReadyConn(...args),
}));

const mockRemoveClawById = vi.fn();

vi.mock('../stores/claws.store.js', () => ({
	useClawsStore: () => ({
		get items() { return mockBots; },
		get byId() {
			const map = {};
			for (const b of mockBots) map[String(b.id)] = { ...b, rtcPhase: b.rtcPhase ?? 'idle', rtcTransportInfo: b.rtcTransportInfo ?? null, rtcPeerTransportInfo: b.rtcPeerTransportInfo ?? null, retryCount: b.retryCount ?? 0, retryNextAt: b.retryNextAt ?? 0 };
			return map;
		},
		fetched: true, // SSE 快照已到达
		removeClawById: mockRemoveClawById,
	}),
}));

vi.mock('../stores/dashboard.store.js', () => ({
	useDashboardStore: () => ({
		loadDashboard: mockLoadDashboard,
		getDashboard: mockGetDashboard,
		clearDashboard: mockClearDashboard,
	}),
}));

// agentRunsStore mock：isRunning / getActiveRun 可由测试控制
let mockIsRunning = vi.fn().mockReturnValue(false);
let mockGetActiveRun = vi.fn().mockReturnValue(null);
vi.mock('../stores/agent-runs.store.js', () => ({
	useAgentRunsStore: () => ({
		isRunning: (runKey) => mockIsRunning(runKey),
		getActiveRun: (runKey) => mockGetActiveRun(runKey),
	}),
}));

// ---- stubs ----

const UButtonStub = {
	props: ['icon', 'loading', 'disabled', 'color', 'variant', 'size'],
	emits: ['click'],
	template: '<button v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>',
};

const UBadgeStub = {
	props: ['color', 'variant', 'size'],
	template: '<span><slot /></span>',
};

const AgentCardStub = {
	name: 'AgentCard',
	props: ['agent', 'claw'],
	emits: ['chat', 'files'],
	template: '<div data-testid="agent-card">{{ agent.name }}</div>',
};

let mockBots = [];

function createWrapper() {
	return mount(ManageClawsPage, {
		global: {
			plugins: [createPinia()],
			stubs: {
				UButton: UButtonStub,
				UBadge: UBadgeStub,
				UIcon: { props: ['name'], template: '<i />' },
				AgentCard: AgentCardStub,
			},
			mocks: {
				$t: (key, params) => {
					const map = {
						'claws.pageTitle': 'My Claws',
						'claws.addClaw': 'Add Bot',
						'claws.noClaw': 'No Claw bound.',
						'claws.remove': 'Remove',
						'claws.preparing': 'Preparing...',
						'dashboard.offline': 'Offline',
						'claws.conn.rtcIdle': 'WebRTC: idle',
						'claws.conn.rtcBuilding': 'WebRTC: connecting…',
						'claws.conn.rtcRecovering': 'WebRTC: recovering…',
						'claws.conn.rtcRestarting': 'WebRTC: ICE restarting…',
						'claws.conn.rtcRetrying': 'WebRTC: connection failed, retrying…',
						'claws.conn.rtcRetryExhausted': 'WebRTC: connection failed (retries exhausted)',
						'claws.conn.rtcLan': 'WebRTC: LAN',
						'claws.conn.rtcLanProto': `WebRTC: LAN · ${params?.protocol}`,
						'claws.conn.rtcP2P': 'WebRTC: P2P',
						'claws.conn.rtcP2PProto': `WebRTC: P2P · ${params?.protocol}`,
						'claws.conn.rtcRelay': 'WebRTC: Relay',
						'claws.conn.rtcRelayProto': `WebRTC: Relay · ${params?.protocol}`,
						'claws.conn.rtcRelayBothSides': `WebRTC: ${params?.browser} ↔ Relay ↔ ${params?.peer}`,
						'claws.renameFailed': 'Rename failed',
						'claws.summary.claws': `${params?.n} Claws`,
						'claws.summary.running': `${params?.n} 工作中`,
						'claws.summary.failed': `${params?.n} 异常`,
						'dashboard.monthlyCost': 'Monthly cost',
					};
					return map[key] ?? key;
				},
				$router: { push: vi.fn() },
			},
		},
	});
}

describe('ManageClawsPage', () => {
	beforeEach(() => {
		mockBots = [];
		mockGetDashboard.mockReturnValue(null);
		mockLoadDashboard.mockResolvedValue(undefined);
		mockIsRunning = vi.fn().mockReturnValue(false);
		mockGetActiveRun = vi.fn().mockReturnValue(null);
		mockGetReadyConn = vi.fn().mockReturnValue(null);
		vi.clearAllMocks();
	});

	test('无 claw 时显示空态提示', async () => {
		mockBots = [];
		const wrapper = createWrapper();
		await flushPromises();

		expect(wrapper.text()).toContain('No Claw bound.');
	});

	test('在线 claw → 渲染 Claw card（含名称）+ AgentCard', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		mockGetDashboard.mockReturnValue({
			instance: { name: 'Bot1', online: true, channels: [] },
			agents: [{ id: 'a1', name: 'Agent1', modelTags: [], capabilities: [], totalTokens: 0, activeSessions: 0, lastActivity: null }],
			loading: false,
		});
		const wrapper = createWrapper();
		await flushPromises();

		expect(wrapper.text()).toContain('Bot1');
		expect(wrapper.find('[data-testid="agent-card"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="agent-card"]').text()).toContain('Agent1');
	});

	test('claw 名容器 + h2 带 truncate/min-w-0，防长名 + 成本块挤压窄屏溢出', async () => {
		// 在线 claw：truncate 在 dashboard.instance 分支
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		mockGetDashboard.mockReturnValue({
			instance: { name: 'Bot1', online: true, channels: [] },
			agents: [],
			loading: false,
		});
		const wrapper = createWrapper();
		await flushPromises();

		const nameH2Online = wrapper.find('[data-testid="claw-1"] h2');
		expect(nameH2Online.exists()).toBe(true);
		const onlineCls = nameH2Online.classes();
		expect(onlineCls).toContain('truncate');
		expect(onlineCls).toContain('min-w-0');

		// 离线 claw：truncate 也得在 fallback 分支（用同一规则，避免窄屏挤压）
		mockGetDashboard.mockReturnValue({ instance: null, agents: [], loading: false });
		const wrapper2 = createWrapper();
		await flushPromises();
		const nameH2Offline = wrapper2.find('[data-testid="claw-1"] h2');
		expect(nameH2Offline.exists()).toBe(true);
		const offlineCls = nameH2Offline.classes();
		expect(offlineCls).toContain('truncate');
		expect(offlineCls).toContain('min-w-0');
	});

	test('在线 claw + dashboard 有 monthlyCost → 渲染本月花费', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		mockGetDashboard.mockReturnValue({
			instance: { name: 'Bot1', online: true, channels: [], monthlyCost: { total: 12.34, currency: 'USD' } },
			agents: [],
			loading: false,
		});
		const wrapper = createWrapper();
		await flushPromises();

		const costEl = wrapper.find('[data-testid="monthly-cost"]');
		expect(costEl.exists()).toBe(true);
		expect(costEl.text()).toContain('Monthly cost');
		// 必须带 currency 前缀（$）——源码若退化成 String(total) 会丢符号 + 本地化
		expect(costEl.text()).toMatch(/\$12\.34/);
	});

	test('在线 claw + dashboard 无 monthlyCost → 不渲染花费块', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		mockGetDashboard.mockReturnValue({
			instance: { name: 'Bot1', online: true, channels: [] },
			agents: [],
			loading: false,
		});
		const wrapper = createWrapper();
		await flushPromises();

		expect(wrapper.find('[data-testid="monthly-cost"]').exists()).toBe(false);
	});

	test('离线 claw → 渲染 fallback header + Offline badge + 解绑按钮', async () => {
		mockBots = [{ id: '2', name: 'OfflineBot', online: false }];
		mockGetDashboard.mockReturnValue(null);
		const wrapper = createWrapper();
		await flushPromises();

		expect(wrapper.text()).toContain('OfflineBot');
		expect(wrapper.text()).toContain('Offline');
		expect(wrapper.text()).toContain('Remove');
	});

	test('离线 claw + 缓存 rtcTransportInfo → 连接行显示 idle 文案（与 online 解耦，detail 按钮仍可展开）', async () => {
		mockBots = [{ id: '1', name: 'A', online: false, rtcTransportInfo: { localType: 'srflx', localProtocol: 'udp' } }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		// rtcPhase 默认 idle；connDetail 非空 → 外层 v-if 成立
		expect(wrapper.text()).toContain('WebRTC: idle');
	});

	test('离线 claw 无缓存 rtcTransportInfo → 连接信息行不显示', async () => {
		mockBots = [{ id: '1', name: 'A', online: false }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		// connDetail=null + rtcPhase=idle → 外层 v-if 假，整行隐藏
		expect(wrapper.text()).not.toContain('WebRTC');
	});

	test('claw 容器包含 data-testid', async () => {
		mockBots = [{ id: '99', name: 'TestBot', online: true }];
		mockGetDashboard.mockReturnValue(null);
		const wrapper = createWrapper();
		await flushPromises();

		expect(wrapper.find('[data-testid="claw-99"]').exists()).toBe(true);
	});

	test('mounted 时加载 dashboard（force=true：外层 60s 节流放行后，意图就是拉最新数据）', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		createWrapper();
		await flushPromises();

		expect(mockLoadDashboard).toHaveBeenCalledWith('1', { force: true });
	});

	test('app:foreground 时重新加载 dashboard', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		const wrapper = createWrapper();
		await flushPromises();

		mockLoadDashboard.mockClear();
		// 首次 mount 已写 __lastLoadedAt = now，需清零以绕开 freshness gate
		wrapper.vm.__lastLoadedAt = 0;
		window.dispatchEvent(new CustomEvent('app:foreground'));
		await flushPromises();

		expect(mockLoadDashboard).toHaveBeenCalled();
		wrapper.unmount();
	});

	test('60s freshness gate 内 app:foreground 跳过 reload', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		const wrapper = createWrapper();
		await flushPromises();

		mockLoadDashboard.mockClear();
		// 不清 __lastLoadedAt：mount 已写入 now，gate 命中
		window.dispatchEvent(new CustomEvent('app:foreground'));
		await flushPromises();

		expect(mockLoadDashboard).not.toHaveBeenCalled();
		wrapper.unmount();
	});

	test('freshness gate 过期后 app:foreground 重新加载', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		const wrapper = createWrapper();
		await flushPromises();

		mockLoadDashboard.mockClear();
		wrapper.vm.__lastLoadedAt = Date.now() - 61_000;
		window.dispatchEvent(new CustomEvent('app:foreground'));
		await flushPromises();

		expect(mockLoadDashboard).toHaveBeenCalled();
		wrapper.unmount();
	});

	test('unmount 后前台恢复不再触发加载', async () => {
		mockBots = [];
		const wrapper = createWrapper();
		await flushPromises();

		wrapper.unmount();
		mockLoadDashboard.mockClear();

		window.dispatchEvent(new CustomEvent('app:foreground'));
		await flushPromises();

		expect(mockLoadDashboard).not.toHaveBeenCalled();
	});

	test('loadData 异常时 log warning 并 notify error', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		const err = new Error('dashboard boom');
		mockLoadDashboard.mockImplementation(() => { throw err; });
		createWrapper();
		await flushPromises();

		expect(warnSpy).toHaveBeenCalledWith('[ManageClawsPage] loadData failed:', err);
		expect(mockNotify.error).toHaveBeenCalledWith('dashboard boom');
		warnSpy.mockRestore();
	});

	test('onConfirmRemove 异常时 log warning 并 notify error；弹窗始终关闭；非 404 不剔本地', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		mockGetDashboard.mockReturnValue(null);
		const err = new Error('remove boom');
		unbindClawByUser.mockRejectedValueOnce(err);
		const wrapper = createWrapper();
		await flushPromises();

		wrapper.vm.removeTargetId = '1';
		wrapper.vm.removeConfirmOpen = true;
		await wrapper.vm.onConfirmRemove();

		expect(warnSpy).toHaveBeenCalledWith('[ManageClawsPage] onConfirmRemove failed:', err);
		expect(mockNotify.error).toHaveBeenCalled();
		expect(wrapper.vm.unbindingMap).toEqual({});
		// 弹窗即便出错也必须关，避免 modal 卡住
		expect(wrapper.vm.removeConfirmOpen).toBe(false);
		// 非 404 错误不应主动剔本地 claw / 清 dashboard
		expect(mockRemoveClawById).not.toHaveBeenCalled();
		expect(mockClearDashboard).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	test('onConfirmRemove server 返回 404（CLAW_NOT_FOUND）→ 视为成功：关弹窗 + 本地剔除 + 清 dashboard', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		mockGetDashboard.mockReturnValue(null);
		const err = Object.assign(new Error('Request failed with status code 404'), {
			response: { status: 404, data: { code: 'CLAW_NOT_FOUND', message: 'claw not found' } },
		});
		unbindClawByUser.mockRejectedValueOnce(err);
		const wrapper = createWrapper();
		await flushPromises();

		wrapper.vm.removeTargetId = '1';
		wrapper.vm.removeConfirmOpen = true;
		await wrapper.vm.onConfirmRemove();

		expect(mockNotify.error).toHaveBeenCalled();
		expect(wrapper.vm.removeConfirmOpen).toBe(false);
		expect(wrapper.vm.unbindingMap).toEqual({});
		// 404 路径：主动剔本地 + 清 dashboard，避免僵尸卡片
		expect(mockRemoveClawById).toHaveBeenCalledWith('1');
		expect(mockClearDashboard).toHaveBeenCalledWith('1');
		warnSpy.mockRestore();
	});

	test('onConfirmRemove 点确认后先关弹窗再调 API（用户体验：modal 立刻消失）', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		mockGetDashboard.mockReturnValue(null);
		let resolveUnbind;
		let modalStateAtApiCall;
		unbindClawByUser.mockImplementationOnce((id) => {
			// API 被调用时弹窗应当已经关闭
			modalStateAtApiCall = wrapper.vm.removeConfirmOpen;
			return new Promise((r) => { resolveUnbind = () => r({ clawId: id, status: 'unbound' }); });
		});
		const wrapper = createWrapper();
		await flushPromises();

		wrapper.vm.removeTargetId = '1';
		wrapper.vm.removeConfirmOpen = true;
		const pending = wrapper.vm.onConfirmRemove();
		// 同步路径走完时，弹窗已被关闭、API 已被调用
		expect(wrapper.vm.removeConfirmOpen).toBe(false);
		expect(unbindClawByUser).toHaveBeenCalledWith('1');
		expect(modalStateAtApiCall).toBe(false);

		resolveUnbind();
		await pending;
	});

	test('卡片 Remove 按钮在 unbind in-flight 期间同时反映 loading + disabled（钉住 :disabled 不被误砍）', async () => {
		mockBots = [
			{ id: '1', name: 'Bot1', online: true },
			{ id: '2', name: 'Bot2', online: true },
		];
		mockGetDashboard.mockReturnValue({
			instance: { name: 'Bot1', online: true, channels: [] },
			agents: [],
			loading: false,
		});
		let resolveA;
		unbindClawByUser.mockImplementationOnce(() => new Promise((r) => { resolveA = () => r({ clawId: '1', status: 'unbound' }); }));

		const wrapper = createWrapper();
		await flushPromises();

		// 触发 claw 1 的 unbind 让它 in-flight；不 await，让 unbindClawByUser 卡住
		wrapper.vm.removeTargetId = '1';
		wrapper.vm.removeConfirmOpen = true;
		const pending = wrapper.vm.onConfirmRemove();
		await wrapper.vm.$nextTick();

		// 在所有 UButton stub 实例里过滤出 Remove 按钮（按 text 锁定）
		// 不依赖渲染顺序——sortedClaws 同优先级按 lastAliveAt 排序，位置不可控
		const allBtns = wrapper.findAllComponents(UButtonStub);
		const removeBtns = allBtns.filter(b => b.text() === 'Remove');
		expect(removeBtns.length).toBe(2);

		// in-flight 那个 Remove 按钮：loading + disabled 同时为 true（双保险都要在）
		const blocked = removeBtns.filter(b => b.props('loading') === true);
		expect(blocked.length).toBe(1);
		expect(blocked[0].props('disabled')).toBe(true);

		// 另一个 Remove 按钮：loading + disabled 同时为 false（不受 claw 1 影响）
		const open = removeBtns.filter(b => b.props('loading') === false);
		expect(open.length).toBe(1);
		expect(open[0].props('disabled')).toBe(false);

		// 收尾
		resolveA();
		await pending;
	});

	test('onConfirmRemove 不同 claw 可并发 unbind（per-claw map 不互相阻塞）', async () => {
		mockBots = [
			{ id: '1', name: 'Bot1', online: true },
			{ id: '2', name: 'Bot2', online: true },
		];
		mockGetDashboard.mockReturnValue(null);

		// claw 1 的 unbind 卡住不返回；claw 2 的 unbind 直接成功
		let resolveA;
		unbindClawByUser.mockImplementationOnce(() => new Promise((r) => { resolveA = () => r({ clawId: '1', status: 'unbound' }); }));
		unbindClawByUser.mockResolvedValueOnce({ clawId: '2', status: 'unbound' });

		const wrapper = createWrapper();
		await flushPromises();

		// 触发 A 的 unbind（不 await，模拟 in-flight）
		wrapper.vm.removeTargetId = '1';
		wrapper.vm.removeConfirmOpen = true;
		const pendingA = wrapper.vm.onConfirmRemove();
		// A 的 in-flight 标记建立、A 卡片按钮 :loading + :disabled 都会反映这一点
		expect(wrapper.vm.unbindingMap['1']).toBe(true);
		expect(wrapper.vm.unbindingMap['2']).toBeUndefined();
		expect(wrapper.vm.removeConfirmOpen).toBe(false);

		// A 还没回执时，对 B 走同一流程：必须能进，不被 A 的 in-flight 阻塞
		wrapper.vm.removeTargetId = '2';
		wrapper.vm.removeConfirmOpen = true;
		await wrapper.vm.onConfirmRemove();

		// B 已完成：弹窗关闭、B 不再在 map 里；A 仍在 map 里（pending）
		expect(wrapper.vm.removeConfirmOpen).toBe(false);
		expect(wrapper.vm.unbindingMap['2']).toBeUndefined();
		expect(wrapper.vm.unbindingMap['1']).toBe(true);
		expect(mockClearDashboard).toHaveBeenCalledWith('2');

		// 收尾 A
		resolveA();
		await pendingA;
		expect(wrapper.vm.unbindingMap['1']).toBeUndefined();
		expect(mockClearDashboard).toHaveBeenCalledWith('1');
	});

	test('onConfirmRemove 同 claw 重入被守卫挡掉（不重复发 API、弹窗状态不被破坏）', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		mockGetDashboard.mockReturnValue(null);
		let resolveA;
		unbindClawByUser.mockImplementationOnce(() => new Promise((r) => { resolveA = () => r({ clawId: '1', status: 'unbound' }); }));
		const wrapper = createWrapper();
		await flushPromises();

		wrapper.vm.removeTargetId = '1';
		wrapper.vm.removeConfirmOpen = true;
		const pendingA = wrapper.vm.onConfirmRemove();

		expect(unbindClawByUser).toHaveBeenCalledTimes(1);
		expect(wrapper.vm.unbindingMap['1']).toBe(true);

		// 同 claw 再次触发：guard 早返回，API 不被重复调用
		wrapper.vm.removeTargetId = '1';
		await wrapper.vm.onConfirmRemove();
		expect(unbindClawByUser).toHaveBeenCalledTimes(1);

		resolveA();
		await pendingA;
	});

	test('onConfirmRemove 成功路径不主动 removeClawById（让 SSE claw.unbound 接管），但清 dashboard 并 reload', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		mockGetDashboard.mockReturnValue(null);
		unbindClawByUser.mockResolvedValueOnce({ clawId: '1', status: 'unbound' });
		const wrapper = createWrapper();
		await flushPromises();

		wrapper.vm.removeTargetId = '1';
		wrapper.vm.removeConfirmOpen = true;
		await wrapper.vm.onConfirmRemove();

		expect(wrapper.vm.removeConfirmOpen).toBe(false);
		expect(wrapper.vm.unbindingMap).toEqual({});
		expect(mockClearDashboard).toHaveBeenCalledWith('1');
		// 成功路径下不自己剔，等 SSE 推 claw.unbound 触发 removeClawById
		expect(mockRemoveClawById).not.toHaveBeenCalled();
	});

	// ---- 状态摘要栏 ----

	test('全部正常（无 running / failed）→ 摘要栏仅显示 N Claws', async () => {
		mockBots = [
			{ id: '1', name: 'Bot1', online: true, rtcPhase: 'ready' },
			{ id: '2', name: 'Bot2', online: true, rtcPhase: 'ready' },
		];
		const wrapper = createWrapper();
		await flushPromises();

		const bar = wrapper.find('[data-testid="status-summary"]');
		expect(bar.exists()).toBe(true);
		expect(bar.text()).toContain('2 Claws');
		expect(bar.text()).not.toContain('工作中');
		expect(bar.text()).not.toContain('异常');
	});

	test('有 running agent → 摘要栏包含工作中文字', async () => {
		mockBots = [
			{ id: '1', name: 'Bot1', online: true, rtcPhase: 'ready' },
		];
		// __hasRunningAgent 通过 dashboardStore 获取 agents
		mockGetDashboard.mockImplementation((clawId) => {
			if (clawId === '1') return { agents: [{ id: 'main' }], instance: null, loading: false };
			return null;
		});
		mockIsRunning = vi.fn().mockImplementation((k) => k.endsWith('::agent:main:main'));
		const wrapper = createWrapper();
		await flushPromises();

		const bar = wrapper.find('[data-testid="status-summary"]');
		expect(bar.text()).toContain('工作中');
	});

	test('有 failed claw → 摘要栏包含异常文字', async () => {
		mockBots = [
			{ id: '1', name: 'Bot1', online: true, rtcPhase: 'failed' },
		];
		const wrapper = createWrapper();
		await flushPromises();

		const bar = wrapper.find('[data-testid="status-summary"]');
		expect(bar.text()).toContain('异常');
	});

	test('无 claw 时不显示摘要栏', async () => {
		mockBots = [];
		const wrapper = createWrapper();
		await flushPromises();

		expect(wrapper.find('[data-testid="status-summary"]').exists()).toBe(false);
	});

	// ---- sortedClaws 排序 ----

	test('sortedClaws：failed claw 排在最前', async () => {
		mockBots = [
			{ id: '1', name: 'IdleBot', online: true, rtcPhase: 'ready', lastAliveAt: 1000 },
			{ id: '2', name: 'FailedBot', online: true, rtcPhase: 'failed', lastAliveAt: 500 },
			{ id: '3', name: 'OfflineBot', online: false, lastAliveAt: 800 },
		];
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.sortedClaws[0].name).toBe('FailedBot');
	});

	test('sortedClaws：offline claw 排在最后', async () => {
		mockBots = [
			{ id: '1', name: 'OfflineBot', online: false, lastAliveAt: 9999 },
			{ id: '2', name: 'IdleBot', online: true, rtcPhase: 'ready', lastAliveAt: 100 },
		];
		const wrapper = createWrapper();
		await flushPromises();
		const sorted = wrapper.vm.sortedClaws;
		expect(sorted[sorted.length - 1].name).toBe('OfflineBot');
	});

	test('sortedClaws：running bot（有 agent 在工作）排在 connecting 前', async () => {
		mockBots = [
			{ id: '1', name: 'ConnBot', online: true, rtcPhase: 'building', lastAliveAt: 300 },
			{ id: '2', name: 'RunBot', online: true, rtcPhase: 'ready', lastAliveAt: 200 },
		];
		mockGetDashboard.mockImplementation((clawId) => {
			if (clawId === '2') return { agents: [{ id: 'main' }], instance: null, loading: false };
			return null;
		});
		mockIsRunning = vi.fn().mockImplementation((k) => k.endsWith('::agent:main:main'));
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.sortedClaws[0].name).toBe('RunBot');
	});

	test('sortedClaws：restarting claw 归入 connecting 组', async () => {
		mockBots = [
			{ id: '1', name: 'IdleBot', online: true, rtcPhase: 'ready', lastAliveAt: 1000 },
			{ id: '2', name: 'RestartBot', online: true, rtcPhase: 'restarting', lastAliveAt: 500 },
		];
		const wrapper = createWrapper();
		await flushPromises();
		// restarting (connecting=2) 排在 idle (3) 前
		expect(wrapper.vm.sortedClaws[0].name).toBe('RestartBot');
	});

	test('sortedClaws：idle 同级按 lastAliveAt 降序', async () => {
		mockBots = [
			{ id: '1', name: 'OldIdle', online: true, rtcPhase: 'ready', lastAliveAt: 1000 },
			{ id: '2', name: 'NewIdle', online: true, rtcPhase: 'ready', lastAliveAt: 5000 },
		];
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.sortedClaws[0].name).toBe('NewIdle');
	});

	test('sortedClaws：空列表 → 空数组', async () => {
		mockBots = [];
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.sortedClaws).toEqual([]);
	});

	// ---- statusSummary 边界 ----

	test('statusSummary：全部 offline → running=0 failed=0', async () => {
		mockBots = [
			{ id: '1', name: 'Off1', online: false },
			{ id: '2', name: 'Off2', online: false },
		];
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.statusSummary).toEqual({ running: 0, failed: 0 });
	});

	test('statusSummary：mixed 状态统计正确', async () => {
		mockBots = [
			{ id: '1', name: 'Running1', online: true, rtcPhase: 'ready' },
			{ id: '2', name: 'Failed1', online: true, rtcPhase: 'failed' },
			{ id: '3', name: 'Idle1', online: true, rtcPhase: 'ready' },
			{ id: '4', name: 'Offline1', online: false },
		];
		mockGetDashboard.mockImplementation((clawId) => {
			if (clawId === '1') return { agents: [{ id: 'main' }, { id: 'ops' }], instance: null, loading: false };
			if (clawId === '3') return { agents: [{ id: 'main' }], instance: null, loading: false };
			return null;
		});
		mockIsRunning = vi.fn().mockImplementation((k) => k.endsWith('::agent:main:main'));
		const wrapper = createWrapper();
		await flushPromises();
		// bot1 has running agent, bot2 failed, bot3 main is running too
		expect(wrapper.vm.statusSummary).toEqual({ running: 2, failed: 1 });
	});
});

describe('connLabel', () => {
	test('bot 不存在时返回空字符串', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'ready' }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('999')).toBe('');
	});

	test('bot 离线（rtcPhase=idle）→ 按 rtcPhase 反映 idle（与 online 解耦）', async () => {
		mockBots = [{ id: '1', name: 'A', online: false, rtcPhase: 'idle' }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: idle');
	});

	test('bot 离线但 rtcPhase=ready（解耦后可能出现）→ 仍显示 ready 文案', async () => {
		mockBots = [{ id: '1', name: 'A', online: false, rtcPhase: 'ready', rtcTransportInfo: { localType: 'srflx', localProtocol: 'udp' } }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: P2P');
	});

	test('rtcPhase=failed + retryNextAt>0 显示重试中', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'failed', retryNextAt: Date.now() + 10_000 }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: connection failed, retrying…');
	});

	test('rtcPhase=failed + retryNextAt=0 显示窗口耗尽', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'failed', retryNextAt: 0 }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: connection failed (retries exhausted)');
	});

	test('rtcPhase=building → WebRTC connecting', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'building' }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: connecting…');
	});

	test('rtcPhase=recovering → WebRTC recovering', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'recovering' }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: recovering…');
	});

	test('rtcPhase=restarting → 始终显示 ICE restarting（不看 transportInfo）', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'restarting', rtcTransportInfo: { localType: 'srflx', localProtocol: 'udp' } }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: ICE restarting…');
	});

	test('rtcPhase=restarting 无 transportInfo → ICE restarting', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'restarting' }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: ICE restarting…');
	});

	test('rtcPhase=ready 无 transportInfo → 过渡态 fallback 到 building 文案', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'ready' }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: connecting…');
	});

	test('rtcPhase=ready + relay UDP → Relay', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'ready', rtcTransportInfo: { localType: 'relay', relayProtocol: 'udp' } }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: Relay');
	});

	test('rtcPhase=ready + relay TCP → Relay + protocol', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'ready', rtcTransportInfo: { localType: 'relay', relayProtocol: 'tcp' } }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: Relay · TCP');
	});

	test('rtcPhase=ready + host UDP → LAN', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'ready', rtcTransportInfo: { localType: 'host', localProtocol: 'udp' } }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: LAN');
	});

	test('rtcPhase=ready + srflx UDP → P2P', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'ready', rtcTransportInfo: { localType: 'srflx', localProtocol: 'udp' } }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: P2P');
	});

	test('rtcPhase=ready + host TCP → LAN + protocol', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'ready', rtcTransportInfo: { localType: 'host', localProtocol: 'tcp' } }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: LAN · TCP');
	});

	test('rtcPhase=ready + srflx TCP → P2P + protocol', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'ready', rtcTransportInfo: { localType: 'srflx', localProtocol: 'tcp' } }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: P2P · TCP');
	});

	// --- relay 双端协议展示 ---

	test('relay + plugin 侧信息未到（browser UDP）→ 老 rtcRelay 兜底', async () => {
		mockBots = [{
			id: '1', name: 'A', online: true, rtcPhase: 'ready',
			rtcTransportInfo: { localType: 'relay', relayProtocol: 'udp' },
			// rtcPeerTransportInfo 缺失
		}];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: Relay');
	});

	test('relay + plugin 侧信息未到（browser TCP）→ 老 rtcRelayProto 兜底', async () => {
		mockBots = [{
			id: '1', name: 'A', online: true, rtcPhase: 'ready',
			rtcTransportInfo: { localType: 'relay', relayProtocol: 'tcp' },
			// rtcPeerTransportInfo 缺失
		}];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: Relay · TCP');
	});

	test('relay + 双端协议一致（UDP ↔ UDP）→ 简化为单段', async () => {
		mockBots = [{
			id: '1', name: 'A', online: true, rtcPhase: 'ready',
			rtcTransportInfo: { localType: 'relay', relayProtocol: 'udp' },
			rtcPeerTransportInfo: { candidateType: 'relay', protocol: 'udp', relayProtocol: 'udp' },
		}];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: Relay');
	});

	test('relay + 双端协议不同（UDP ↔ TCP）→ 展示链路', async () => {
		mockBots = [{
			id: '1', name: 'A', online: true, rtcPhase: 'ready',
			rtcTransportInfo: { localType: 'relay', relayProtocol: 'udp' },
			rtcPeerTransportInfo: { candidateType: 'relay', protocol: 'udp', relayProtocol: 'tcp' },
		}];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: UDP ↔ Relay ↔ TCP');
	});

	test('relay + 双端协议不同（TCP ↔ TLS）→ 展示链路', async () => {
		mockBots = [{
			id: '1', name: 'A', online: true, rtcPhase: 'ready',
			rtcTransportInfo: { localType: 'relay', relayProtocol: 'tcp' },
			rtcPeerTransportInfo: { candidateType: 'relay', protocol: 'udp', relayProtocol: 'tls' },
		}];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: TCP ↔ Relay ↔ TLS');
	});

	test('relay（浏览器）+ plugin 侧 host/UDP（直连）→ 双段都 UDP 落入简化分支', async () => {
		mockBots = [{
			id: '1', name: 'A', online: true, rtcPhase: 'ready',
			rtcTransportInfo: { localType: 'relay', relayProtocol: 'udp' },
			rtcPeerTransportInfo: { candidateType: 'host', protocol: 'udp', relayProtocol: null },
		}];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: Relay');
	});

	test('relay（浏览器 UDP）+ plugin 侧 host/TCP（直连 TCP）→ 展示双段链路', async () => {
		mockBots = [{
			id: '1', name: 'A', online: true, rtcPhase: 'ready',
			rtcTransportInfo: { localType: 'relay', relayProtocol: 'udp' },
			rtcPeerTransportInfo: { candidateType: 'host', protocol: 'tcp', relayProtocol: null },
		}];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: UDP ↔ Relay ↔ TCP');
	});
});

describe('clawDotClass', () => {
	test('offline → 灰色', async () => {
		mockBots = [{ id: '1', name: 'A', online: false }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.clawDotClass(mockBots[0])).toBe('bg-gray-500');
	});

	test('online + ready → 绿色脉冲', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'ready' }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		const cls = wrapper.vm.clawDotClass(mockBots[0]);
		expect(cls).toContain('bg-green-400');
		expect(cls).toContain('animate-pulse');
	});

	test('online + failed → 红色', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'failed' }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		const cls = wrapper.vm.clawDotClass(mockBots[0]);
		expect(cls).toContain('bg-red-400');
		expect(cls).not.toContain('animate-pulse');
	});

	test('online + building → 黄色脉冲', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'building' }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		const cls = wrapper.vm.clawDotClass(mockBots[0]);
		expect(cls).toContain('bg-yellow-400');
		expect(cls).toContain('animate-pulse');
	});

	test('online + recovering → 黄色脉冲', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'recovering' }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		const cls = wrapper.vm.clawDotClass(mockBots[0]);
		expect(cls).toContain('bg-yellow-400');
		expect(cls).toContain('animate-pulse');
	});

	test('online + restarting → 黄色脉冲', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'restarting' }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		const cls = wrapper.vm.clawDotClass(mockBots[0]);
		expect(cls).toContain('bg-yellow-400');
		expect(cls).toContain('animate-pulse');
	});

	test('online + idle → 黄色脉冲（RTC 尚未就绪）', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'idle' }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		const cls = wrapper.vm.clawDotClass(mockBots[0]);
		expect(cls).toContain('bg-yellow-400');
		expect(cls).toContain('animate-pulse');
	});
});

describe('rename', () => {
	test('onConfirmRename 成功：调用 RPC + 乐观更新 pluginInfo.name + 关闭弹窗', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		mockGetDashboard.mockReturnValue({
			instance: { name: 'Bot1', online: true },
			agents: [],
			loading: false,
		});
		const mockConn = { request: vi.fn().mockResolvedValue({}) };
		mockGetReadyConn.mockReturnValue(mockConn);

		const wrapper = createWrapper();
		await flushPromises();

		wrapper.vm.openRename({ id: '1', pluginInfo: { name: 'OldName' } });
		expect(wrapper.vm.renameOpen).toBe(true);
		expect(wrapper.vm.renameValue).toBe('OldName');

		wrapper.vm.renameValue = 'NewName';
		await wrapper.vm.onConfirmRename();

		expect(mockConn.request).toHaveBeenCalledWith('coclaw.info.patch', { name: 'NewName' });
		expect(wrapper.vm.renameOpen).toBe(false);
		expect(wrapper.vm.renaming).toBe(false);
	});

	test('onConfirmRename conn 不可用 → notify error', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		mockGetDashboard.mockReturnValue({ instance: { name: 'Bot1' }, agents: [], loading: false });
		mockGetReadyConn.mockReturnValue(null);

		const wrapper = createWrapper();
		await flushPromises();

		wrapper.vm.openRename({ id: '1' });
		wrapper.vm.renameValue = 'NewName';
		await wrapper.vm.onConfirmRename();

		expect(mockNotify.error).toHaveBeenCalled();
		expect(wrapper.vm.renaming).toBe(false);
	});

	test('onConfirmRename RPC 报错 → notify error', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		mockGetDashboard.mockReturnValue({ instance: { name: 'Bot1' }, agents: [], loading: false });
		const mockConn = { request: vi.fn().mockRejectedValue(new Error('RPC timeout')) };
		mockGetReadyConn.mockReturnValue(mockConn);

		const wrapper = createWrapper();
		await flushPromises();

		wrapper.vm.openRename({ id: '1' });
		wrapper.vm.renameValue = 'NewName';
		await wrapper.vm.onConfirmRename();

		expect(mockNotify.error).toHaveBeenCalledWith('RPC timeout');
		expect(wrapper.vm.renaming).toBe(false);
		expect(wrapper.vm.renameOpen).toBe(true);
		warnSpy.mockRestore();
	});

	test('onConfirmRename 空名称 → 不发请求', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		mockGetDashboard.mockReturnValue({ instance: { name: 'Bot1' }, agents: [], loading: false });
		const mockConn = { request: vi.fn() };
		mockGetReadyConn.mockReturnValue(mockConn);

		const wrapper = createWrapper();
		await flushPromises();

		wrapper.vm.openRename({ id: '1' });
		wrapper.vm.renameValue = '   ';
		await wrapper.vm.onConfirmRename();

		expect(mockConn.request).not.toHaveBeenCalled();
	});

	test('离线 claw → openRename 后 conn 不可用，直接报错', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: false }];
		mockGetDashboard.mockReturnValue({
			instance: { name: 'Bot1', online: false },
			agents: [],
			loading: false,
		});
		mockGetReadyConn.mockReturnValue(null);
		const wrapper = createWrapper();
		await flushPromises();

		wrapper.vm.openRename({ id: '1', name: 'Bot1' });
		wrapper.vm.renameValue = 'NewName';
		await wrapper.vm.onConfirmRename();

		expect(mockNotify.error).toHaveBeenCalled();
	});
});

