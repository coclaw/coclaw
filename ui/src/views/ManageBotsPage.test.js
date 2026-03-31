import { createPinia, setActivePinia } from 'pinia';
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

vi.mock('../stores/bots.store.js', () => ({
	useBotsStore: () => ({
		get items() { return mockBots; },
		get byId() {
			const map = {};
			for (const b of mockBots) map[String(b.id)] = { ...b, pluginVersionOk: null, rtcPhase: b.rtcPhase ?? 'idle', rtcTransportInfo: null };
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

// agentRunsStore mock：isRunning 可由测试控制
let mockIsRunning = vi.fn().mockReturnValue(false);
vi.mock('../stores/agent-runs.store.js', () => ({
	useAgentRunsStore: () => ({
		isRunning: (runKey) => mockIsRunning(runKey),
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

const InstanceOverviewStub = {
	name: 'InstanceOverview',
	props: ['instance', 'agentCount'],
	template: '<div data-testid="instance-overview">{{ instance.name }}</div>',
};

const AgentCardStub = {
	name: 'AgentCard',
	props: ['agent', 'online'],
	emits: ['chat'],
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
				InstanceOverview: InstanceOverviewStub,
				AgentCard: AgentCardStub,
			},
			mocks: {
				$t: (key, params) => {
					const map = {
						'bots.pageTitle': 'My Claws',
						'bots.addBot': 'Add Bot',
						'bots.noBot': 'No Claw bound.',
						'bots.unbind': 'Unbind',
						'bots.preparing': 'Preparing...',
						'dashboard.offline': 'Offline',
						'bots.conn.ws': 'WebSocket',
						'bots.conn.rtcConnecting': 'WebRTC connecting…',
						'bots.conn.rtcFailed': 'Degraded to WebSocket',
						'bots.summary.agents': `${params?.n} agents`,
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
		vi.clearAllMocks();
	});

	test('无 bot 时显示空态提示', async () => {
		mockBots = [];
		const wrapper = createWrapper();
		await flushPromises();

		expect(wrapper.text()).toContain('No Claw bound.');
	});

	test('在线 bot → 渲染 InstanceOverview + AgentCard', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		mockGetDashboard.mockReturnValue({
			instance: { name: 'Bot1', online: true, channels: [] },
			agents: [{ id: 'a1', name: 'Agent1', modelTags: [], capabilities: [], totalTokens: 0, activeSessions: 0, lastActivity: null }],
			loading: false,
		});
		const wrapper = createWrapper();
		await flushPromises();

		expect(wrapper.find('[data-testid="instance-overview"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="instance-overview"]').text()).toContain('Bot1');
		expect(wrapper.find('[data-testid="agent-card"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="agent-card"]').text()).toContain('Agent1');
	});

	test('离线 bot → 渲染 fallback header + Offline badge', async () => {
		mockBots = [{ id: '2', name: 'OfflineBot', online: false }];
		mockGetDashboard.mockReturnValue(null);
		const wrapper = createWrapper();
		await flushPromises();

		expect(wrapper.find('[data-testid="instance-overview"]').exists()).toBe(false);
		expect(wrapper.text()).toContain('OfflineBot');
		expect(wrapper.text()).toContain('Offline');
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

	test('dashboard 加载中显示 loading', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		mockGetDashboard.mockReturnValue({ loading: true, instance: null, agents: [] });
		const wrapper = createWrapper();
		await flushPromises();

		expect(wrapper.text()).toContain('Preparing...');
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
		const wrapper = createWrapper();
		await flushPromises();

		expect(warnSpy).toHaveBeenCalledWith('[ManageBotsPage] loadData failed:', err);
		expect(mockNotify.error).toHaveBeenCalledWith('dashboard boom');
		warnSpy.mockRestore();
	});

	test('onUnbindByUser 异常时 log warning 并 notify error', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		mockGetDashboard.mockReturnValue(null);
		const err = new Error('unbind boom');
		unbindBotByUser.mockRejectedValueOnce(err);
		const wrapper = createWrapper();
		await flushPromises();

		await wrapper.vm.onUnbindByUser('1');

		expect(warnSpy).toHaveBeenCalledWith('[ManageBotsPage] onUnbindByUser failed:', err);
		expect(mockNotify.error).toHaveBeenCalled();
		expect(wrapper.vm.unbindingId).toBe('');
		warnSpy.mockRestore();
	});

	// ---- 状态摘要栏 ----

	test('全部正常（无 running / failed）→ 摘要栏仅显示 N agents', async () => {
		mockBots = [
			{ id: '1', name: 'Bot1', online: true, rtcPhase: 'ready' },
			{ id: '2', name: 'Bot2', online: true, rtcPhase: 'ready' },
		];
		mockIsRunning = vi.fn().mockReturnValue(false);
		const wrapper = createWrapper();
		await flushPromises();

		const bar = wrapper.find('[data-testid="status-summary"]');
		expect(bar.exists()).toBe(true);
		expect(bar.text()).toContain('2 agents');
		expect(bar.text()).not.toContain('工作中');
		expect(bar.text()).not.toContain('异常');
	});

	test('有 running bot → 摘要栏包含工作中文字', async () => {
		mockBots = [
			{ id: '1', name: 'Bot1', online: true, rtcPhase: 'ready' },
		];
		mockIsRunning = vi.fn().mockReturnValue(true);
		const wrapper = createWrapper();
		await flushPromises();

		const bar = wrapper.find('[data-testid="status-summary"]');
		expect(bar.exists()).toBe(true);
		expect(bar.text()).toContain('工作中');
	});

	test('有 failed bot → 摘要栏包含异常文字', async () => {
		mockBots = [
			{ id: '1', name: 'Bot1', online: true, rtcPhase: 'failed' },
		];
		mockIsRunning = vi.fn().mockReturnValue(false);
		const wrapper = createWrapper();
		await flushPromises();

		const bar = wrapper.find('[data-testid="status-summary"]');
		expect(bar.exists()).toBe(true);
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
		mockIsRunning = vi.fn().mockReturnValue(false);
		const wrapper = createWrapper();
		await flushPromises();

		const sorted = wrapper.vm.sortedBots;
		expect(sorted[0].name).toBe('FailedBot');
	});

	test('sortedBots：offline bot 排在最后', async () => {
		mockBots = [
			{ id: '1', name: 'OfflineBot', online: false, lastAliveAt: 9999 },
			{ id: '2', name: 'IdleBot', online: true, rtcPhase: 'ready', lastAliveAt: 100 },
		];
		mockIsRunning = vi.fn().mockReturnValue(false);
		const wrapper = createWrapper();
		await flushPromises();

		const sorted = wrapper.vm.sortedBots;
		expect(sorted[sorted.length - 1].name).toBe('OfflineBot');
	});
});

