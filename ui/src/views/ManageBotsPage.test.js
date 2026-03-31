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

let mockBots = [];

vi.mock('../stores/bots.store.js', () => ({
	useBotsStore: () => ({
		get items() { return mockBots; },
		get byId() {
			const map = {};
			for (const b of mockBots) map[String(b.id)] = {
				...b,
				pluginVersionOk: null,
				rtcPhase: b.rtcPhase ?? 'idle',
				rtcTransportInfo: null,
			};
			return map;
		},
		fetched: true,
	}),
}));

vi.mock('../stores/dashboard.store.js', () => ({
	useDashboardStore: () => ({
		loadDashboard: mockLoadDashboard,
		getDashboard: mockGetDashboard,
		clearDashboard: mockClearDashboard,
	}),
}));

let mockIsRunning = vi.fn().mockReturnValue(false);

vi.mock('../stores/agent-runs.store.js', () => ({
	useAgentRunsStore: () => ({
		get isRunning() { return mockIsRunning; },
		runKeyIndex: {},
		runs: {},
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
	props: ['bot'],
	emits: ['chat', 'files'],
	template: '<div data-testid="agent-card">{{ bot.name }}</div>',
};

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
						'bots.statusNormal': `${params?.n ?? ''} agents`,
						'bots.statusAgents': `${params?.n ?? ''} agents`,
						'bots.statusRunning': `${params?.n ?? ''} working`,
						'bots.statusFailed': `${params?.n ?? ''} error`,
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
		createWrapper();
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

	// ---- 新增：状态条汇总 ----

	test('在线 bot 全部正常 → 状态条显示 N agents', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: true, rtcPhase: 'ready' }];
		mockGetDashboard.mockReturnValue({
			instance: { name: 'Bot1', online: true, channels: [] },
			agents: [{ id: 'a1', name: 'Agent1', modelTags: [], capabilities: [], totalTokens: 0, activeSessions: 0, lastActivity: null }],
			loading: false,
		});
		const wrapper = createWrapper();
		await flushPromises();

		const bar = wrapper.find('[data-testid="status-bar"]');
		expect(bar.exists()).toBe(true);
		expect(bar.text()).toContain('agents');
	});

	test('有 running agent → 状态条包含 working', async () => {
		mockIsRunning = vi.fn().mockReturnValue(true);
		mockBots = [{ id: '1', name: 'Bot1', online: true, rtcPhase: 'ready' }];
		mockGetDashboard.mockReturnValue({
			instance: { name: 'Bot1', online: true, channels: [] },
			agents: [{ id: 'main', name: 'Main', modelTags: [], capabilities: [], totalTokens: 0, activeSessions: 0, lastActivity: null }],
			loading: false,
		});
		const wrapper = createWrapper();
		await flushPromises();

		const bar = wrapper.find('[data-testid="status-bar"]');
		expect(bar.text()).toContain('working');
	});

	test('rtcPhase failed → 状态条包含 error', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: true, rtcPhase: 'failed' }];
		mockGetDashboard.mockReturnValue({
			instance: { name: 'Bot1', online: true, channels: [] },
			agents: [],
			loading: false,
		});
		const wrapper = createWrapper();
		await flushPromises();

		const bar = wrapper.find('[data-testid="status-bar"]');
		expect(bar.text()).toContain('error');
	});

	test('离线 bot → 无状态条', async () => {
		mockBots = [{ id: '2', name: 'OfflineBot', online: false }];
		const wrapper = createWrapper();
		await flushPromises();

		expect(wrapper.find('[data-testid="status-bar"]').exists()).toBe(false);
	});

	// ---- sortedAgentBots ----

	test('sortedAgentBots 返回 bot 自身', async () => {
		mockBots = [{ id: '3', name: 'Bot3', online: true, rtcPhase: 'ready' }];
		const wrapper = createWrapper();
		await flushPromises();

		const sorted = wrapper.vm.sortedAgentBots('3');
		expect(sorted).toHaveLength(1);
		expect(sorted[0].id).toBe('3');
	});

	test('sortedAgentBots 不存在 bot 返回空数组', async () => {
		mockBots = [];
		const wrapper = createWrapper();
		await flushPromises();

		expect(wrapper.vm.sortedAgentBots('non-exist')).toEqual([]);
	});
});
