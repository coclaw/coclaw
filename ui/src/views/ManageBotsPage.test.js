import { createPinia } from 'pinia';
import { mount, flushPromises } from '@vue/test-utils';
import { describe, test, expect, vi, beforeEach } from 'vitest';

import ManageBotsPage from './ManageBotsPage.vue';

// ---- mocks ----

vi.mock('../services/bots.api.js', () => ({
	listBots: vi.fn().mockResolvedValue([]),
	unbindBotByUser: vi.fn().mockResolvedValue({}),
}));

import { unbindBotByUser } from '../services/bots.api.js';

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

vi.mock('../stores/bots.store.js', () => ({
	MAX_BACKOFF_RETRIES: 8,
	getReadyConn: (...args) => mockGetReadyConn(...args),
	useBotsStore: () => ({
		get items() { return mockBots; },
		get byId() {
			const map = {};
			for (const b of mockBots) map[String(b.id)] = { ...b, pluginVersionOk: null, rtcPhase: b.rtcPhase ?? 'idle', rtcTransportInfo: b.rtcTransportInfo ?? null, retryCount: b.retryCount ?? 0, retryNextAt: b.retryNextAt ?? 0 };
			return map;
		},
		fetched: true, // SSE 快照已到达
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
	props: ['agent', 'bot'],
	emits: ['chat', 'files'],
	template: '<div data-testid="agent-card">{{ agent.name }}</div>',
};

let mockBots = [];

function createWrapper() {
	return mount(ManageBotsPage, {
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
						'bots.pageTitle': 'My Claws',
						'bots.addBot': 'Add Bot',
						'bots.noBot': 'No Claw bound.',
						'bots.remove': 'Remove',
						'bots.preparing': 'Preparing...',
						'dashboard.offline': 'Offline',
						'bots.conn.disconnected': 'Disconnected',
						'bots.conn.rtcConnecting': 'WebRTC connecting…',
						'bots.conn.rtcRetrying': `Connection failed, retry ${params?.n}/${params?.max}…`,
						'bots.conn.rtcRetryExhausted': 'Connection failed, retries exhausted',
						'bots.conn.rtcLan': 'WebRTC · LAN',
						'bots.conn.rtcLanProto': `WebRTC · LAN · ${params?.protocol}`,
						'bots.conn.rtcP2P': 'WebRTC · P2P',
						'bots.conn.rtcP2PProto': `WebRTC · P2P · ${params?.protocol}`,
						'bots.conn.rtcRelay': 'WebRTC · Relay',
						'bots.conn.rtcRelayProto': `WebRTC · Relay · ${params?.protocol}`,
						'bots.renameFailed': 'Rename failed',
						'bots.summary.claws': `${params?.n} Claws`,
						'bots.summary.running': `${params?.n} 工作中`,
						'bots.summary.failed': `${params?.n} 异常`,
					};
					return map[key] ?? key;
				},
				$router: { push: vi.fn() },
			},
		},
	});
}

describe('ManageBotsPage', () => {
	beforeEach(() => {
		mockBots = [];
		mockGetDashboard.mockReturnValue(null);
		mockLoadDashboard.mockResolvedValue(undefined);
		mockIsRunning = vi.fn().mockReturnValue(false);
		mockGetActiveRun = vi.fn().mockReturnValue(null);
		mockGetReadyConn = vi.fn().mockReturnValue(null);
		vi.clearAllMocks();
	});

	test('无 bot 时显示空态提示', async () => {
		mockBots = [];
		const wrapper = createWrapper();
		await flushPromises();

		expect(wrapper.text()).toContain('No Claw bound.');
	});

	test('在线 bot → 渲染 Claw card（含名称）+ AgentCard', async () => {
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

	test('离线 bot → 渲染 fallback header + Offline badge + 解绑按钮', async () => {
		mockBots = [{ id: '2', name: 'OfflineBot', online: false }];
		mockGetDashboard.mockReturnValue(null);
		const wrapper = createWrapper();
		await flushPromises();

		expect(wrapper.text()).toContain('OfflineBot');
		expect(wrapper.text()).toContain('Offline');
		expect(wrapper.text()).toContain('Remove');
	});

	test('离线 bot 有缓存 rtcTransportInfo → 连接信息行显示 Disconnected，无 detail 按钮', async () => {
		mockBots = [{ id: '1', name: 'A', online: false, rtcTransportInfo: { localType: 'srflx', localProtocol: 'udp' } }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.text()).toContain('Disconnected');
		expect(wrapper.text()).not.toContain('bots.conn.detailTitle');
	});

	test('离线 bot 无缓存 rtcTransportInfo → 连接信息行不显示', async () => {
		mockBots = [{ id: '1', name: 'A', online: false }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.text()).not.toContain('Disconnected');
	});

	test('bot 容器包含 data-testid', async () => {
		mockBots = [{ id: '99', name: 'TestBot', online: true }];
		mockGetDashboard.mockReturnValue(null);
		const wrapper = createWrapper();
		await flushPromises();

		expect(wrapper.find('[data-testid="bot-99"]').exists()).toBe(true);
	});

	test('mounted 时加载 dashboard', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		createWrapper();
		await flushPromises();

		expect(mockLoadDashboard).toHaveBeenCalledWith('1');
	});

	test('app:foreground 时重新加载 dashboard', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		const wrapper = createWrapper();
		await flushPromises();

		mockLoadDashboard.mockClear();
		window.dispatchEvent(new CustomEvent('app:foreground'));
		await flushPromises();

		expect(mockLoadDashboard).toHaveBeenCalled();
		wrapper.unmount();
	});

	test('visibilitychange → visible 时重新加载 dashboard', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		const wrapper = createWrapper();
		await flushPromises();

		mockLoadDashboard.mockClear();
		Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
		document.dispatchEvent(new Event('visibilitychange'));
		await flushPromises();

		expect(mockLoadDashboard).toHaveBeenCalled();
		wrapper.unmount();
	});

	test('2s 内重复前台恢复应节流', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		const wrapper = createWrapper();
		await flushPromises();

		mockLoadDashboard.mockClear();
		window.dispatchEvent(new CustomEvent('app:foreground'));
		window.dispatchEvent(new CustomEvent('app:foreground'));
		await flushPromises();

		expect(mockLoadDashboard).toHaveBeenCalledTimes(1);
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

		expect(warnSpy).toHaveBeenCalledWith('[ManageBotsPage] loadData failed:', err);
		expect(mockNotify.error).toHaveBeenCalledWith('dashboard boom');
		warnSpy.mockRestore();
	});

	test('onConfirmRemove 异常时 log warning 并 notify error', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		mockGetDashboard.mockReturnValue(null);
		const err = new Error('remove boom');
		unbindBotByUser.mockRejectedValueOnce(err);
		const wrapper = createWrapper();
		await flushPromises();

		wrapper.vm.removeTargetId = '1';
		await wrapper.vm.onConfirmRemove();

		expect(warnSpy).toHaveBeenCalledWith('[ManageBotsPage] onConfirmRemove failed:', err);
		expect(mockNotify.error).toHaveBeenCalled();
		expect(wrapper.vm.unbindingId).toBe('');
		warnSpy.mockRestore();
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
		mockGetDashboard.mockImplementation((botId) => {
			if (botId === '1') return { agents: [{ id: 'main' }], instance: null, loading: false };
			return null;
		});
		mockIsRunning = vi.fn().mockImplementation((k) => k === 'agent:main:main');
		const wrapper = createWrapper();
		await flushPromises();

		const bar = wrapper.find('[data-testid="status-summary"]');
		expect(bar.text()).toContain('工作中');
	});

	test('有 failed bot → 摘要栏包含异常文字', async () => {
		mockBots = [
			{ id: '1', name: 'Bot1', online: true, rtcPhase: 'failed' },
		];
		const wrapper = createWrapper();
		await flushPromises();

		const bar = wrapper.find('[data-testid="status-summary"]');
		expect(bar.text()).toContain('异常');
	});

	test('无 bot 时不显示摘要栏', async () => {
		mockBots = [];
		const wrapper = createWrapper();
		await flushPromises();

		expect(wrapper.find('[data-testid="status-summary"]').exists()).toBe(false);
	});

	// ---- sortedBots 排序 ----

	test('sortedBots：failed bot 排在最前', async () => {
		mockBots = [
			{ id: '1', name: 'IdleBot', online: true, rtcPhase: 'ready', lastAliveAt: 1000 },
			{ id: '2', name: 'FailedBot', online: true, rtcPhase: 'failed', lastAliveAt: 500 },
			{ id: '3', name: 'OfflineBot', online: false, lastAliveAt: 800 },
		];
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.sortedBots[0].name).toBe('FailedBot');
	});

	test('sortedBots：offline bot 排在最后', async () => {
		mockBots = [
			{ id: '1', name: 'OfflineBot', online: false, lastAliveAt: 9999 },
			{ id: '2', name: 'IdleBot', online: true, rtcPhase: 'ready', lastAliveAt: 100 },
		];
		const wrapper = createWrapper();
		await flushPromises();
		const sorted = wrapper.vm.sortedBots;
		expect(sorted[sorted.length - 1].name).toBe('OfflineBot');
	});

	test('sortedBots：running bot（有 agent 在工作）排在 connecting 前', async () => {
		mockBots = [
			{ id: '1', name: 'ConnBot', online: true, rtcPhase: 'building', lastAliveAt: 300 },
			{ id: '2', name: 'RunBot', online: true, rtcPhase: 'ready', lastAliveAt: 200 },
		];
		mockGetDashboard.mockImplementation((botId) => {
			if (botId === '2') return { agents: [{ id: 'main' }], instance: null, loading: false };
			return null;
		});
		mockIsRunning = vi.fn().mockImplementation((k) => k === 'agent:main:main');
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.sortedBots[0].name).toBe('RunBot');
	});

	test('sortedBots：idle 同级按 lastAliveAt 降序', async () => {
		mockBots = [
			{ id: '1', name: 'OldIdle', online: true, rtcPhase: 'ready', lastAliveAt: 1000 },
			{ id: '2', name: 'NewIdle', online: true, rtcPhase: 'ready', lastAliveAt: 5000 },
		];
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.sortedBots[0].name).toBe('NewIdle');
	});

	test('sortedBots：空列表 → 空数组', async () => {
		mockBots = [];
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.sortedBots).toEqual([]);
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
		mockGetDashboard.mockImplementation((botId) => {
			if (botId === '1') return { agents: [{ id: 'main' }, { id: 'ops' }], instance: null, loading: false };
			if (botId === '3') return { agents: [{ id: 'main' }], instance: null, loading: false };
			return null;
		});
		mockIsRunning = vi.fn().mockImplementation((k) => k === 'agent:main:main');
		const wrapper = createWrapper();
		await flushPromises();
		// bot1 has running agent, bot2 failed, bot3 main is running too
		expect(wrapper.vm.statusSummary).toEqual({ running: 2, failed: 1 });
	});
});

describe('connLabel', () => {
	test('bot 不存在时返回 disconnected', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'ready' }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('999')).toBe('Disconnected');
	});

	test('bot 离线时返回 disconnected', async () => {
		mockBots = [{ id: '1', name: 'A', online: false, rtcPhase: 'idle' }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('Disconnected');
	});

	test('rtcPhase=failed + retryCount>0 显示重试进度', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'failed', retryCount: 3 }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toContain('retry');
		expect(wrapper.vm.connLabel('1')).toContain('3');
	});

	test('rtcPhase=failed + retryCount=0 显示重试耗尽', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'failed', retryCount: 0 }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('Connection failed, retries exhausted');
	});

	test('rtcPhase=building 显示 connecting', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'building' }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC connecting…');
	});

	test('rtcPhase=ready 无 transportInfo 显示 connecting', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'ready' }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC connecting…');
	});

	test('rtcPhase=ready + relay UDP → Relay', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'ready', rtcTransportInfo: { localType: 'relay', relayProtocol: 'udp' } }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC · Relay');
	});

	test('rtcPhase=ready + relay TCP → Relay + protocol', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'ready', rtcTransportInfo: { localType: 'relay', relayProtocol: 'tcp' } }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC · Relay · TCP');
	});

	test('rtcPhase=ready + host UDP → LAN', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'ready', rtcTransportInfo: { localType: 'host', localProtocol: 'udp' } }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC · LAN');
	});

	test('rtcPhase=ready + srflx UDP → P2P', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'ready', rtcTransportInfo: { localType: 'srflx', localProtocol: 'udp' } }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC · P2P');
	});

	test('rtcPhase=ready + host TCP → LAN + protocol', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'ready', rtcTransportInfo: { localType: 'host', localProtocol: 'tcp' } }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC · LAN · TCP');
	});

	test('rtcPhase=ready + srflx TCP → P2P + protocol', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'ready', rtcTransportInfo: { localType: 'srflx', localProtocol: 'tcp' } }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC · P2P · TCP');
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

	test('离线 bot → openRename 后 conn 不可用，直接报错', async () => {
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

