import { createPinia, setActivePinia } from 'pinia';
import { mount, flushPromises } from '@vue/test-utils';
import { describe, test, expect, vi, beforeEach } from 'vitest';

import ManageBotsPage from './ManageBotsPage.vue';

// ---- mocks ----

vi.mock('../services/bots.api.js', () => ({
	listBots: vi.fn().mockResolvedValue([]),
	unbindBotByUser: vi.fn().mockResolvedValue({}),
}));

vi.mock('../composables/use-notify.js', () => ({
	useNotify: () => ({
		success: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warning: vi.fn(),
	}),
}));

const mockLoadBots = vi.fn().mockResolvedValue(undefined);
const mockLoadDashboard = vi.fn().mockResolvedValue(undefined);
const mockGetDashboard = vi.fn().mockReturnValue(null);
const mockClearDashboard = vi.fn();

vi.mock('../stores/bots.store.js', () => ({
	useBotsStore: () => ({
		items: mockBots,
		loadBots: mockLoadBots,
		pluginVersionOk: {},
	}),
}));

vi.mock('../stores/dashboard.store.js', () => ({
	useDashboardStore: () => ({
		loadDashboard: mockLoadDashboard,
		getDashboard: mockGetDashboard,
		clearDashboard: mockClearDashboard,
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
		mockLoadBots.mockResolvedValue(undefined);
		mockLoadDashboard.mockResolvedValue(undefined);
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

	test('mounted 时调用 loadBots 和 loadDashboard', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		createWrapper();
		await flushPromises();

		expect(mockLoadBots).toHaveBeenCalledTimes(1);
		expect(mockLoadDashboard).toHaveBeenCalledWith('1');
	});

	test('dashboard 加载中显示 loading', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		mockGetDashboard.mockReturnValue({ loading: true, instance: null, agents: [] });
		const wrapper = createWrapper();
		await flushPromises();

		expect(wrapper.text()).toContain('Preparing...');
	});
});
