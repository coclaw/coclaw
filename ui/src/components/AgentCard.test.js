import { createPinia, setActivePinia } from 'pinia';
import { mount, flushPromises } from '@vue/test-utils';
import { describe, test, expect, vi, beforeEach } from 'vitest';

import AgentCard from './AgentCard.vue';

// ---- mocks ----

const mockNotify = {
	success: vi.fn(),
	error: vi.fn(),
	info: vi.fn(),
	warning: vi.fn(),
};
vi.mock('../composables/use-notify.js', () => ({
	useNotify: () => mockNotify,
}));

const mockEnsureRtc = vi.fn().mockResolvedValue(undefined);

vi.mock('../stores/bots.store.js', () => ({
	useBotsStore: () => ({
		__ensureRtc: mockEnsureRtc,
	}),
}));

let mockIsRunning = vi.fn().mockReturnValue(false);
let mockGetActiveRun = vi.fn().mockReturnValue(null);

vi.mock('../stores/agent-runs.store.js', () => ({
	useAgentRunsStore: () => ({
		get isRunning() { return mockIsRunning; },
		get getActiveRun() { return mockGetActiveRun; },
	}),
}));

const mockGetDashboard = vi.fn().mockReturnValue(null);

vi.mock('../stores/dashboard.store.js', () => ({
	useDashboardStore: () => ({
		getDashboard: mockGetDashboard,
	}),
}));

let mockTopicItems = [];

vi.mock('../stores/topics.store.js', () => ({
	useTopicsStore: () => ({
		get items() { return mockTopicItems; },
	}),
}));

// ---- stubs ----

const UButtonStub = {
	props: ['color', 'variant', 'size', 'loading', 'disabled'],
	emits: ['click'],
	template: '<button v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>',
};

const UIconStub = {
	props: ['name'],
	template: '<i :class="name" />',
};

const UBadgeStub = {
	props: ['color', 'variant', 'size'],
	template: '<span><slot /></span>',
};

// ---- helpers ----

/**
 * 构造标准 bot prop
 * @param {object} overrides
 */
function makeBot(overrides = {}) {
	return {
		id: 'bot1',
		agentId: 'main',
		name: 'TestAgent',
		online: true,
		rtcPhase: 'ready',
		lastAliveAt: 0,
		...overrides,
	};
}

function createWrapper(bot) {
	return mount(AgentCard, {
		props: { bot },
		global: {
			plugins: [createPinia()],
			stubs: {
				UButton: UButtonStub,
				UIcon: UIconStub,
				UBadge: UBadgeStub,
			},
			mocks: {
				$t: (key, params) => {
					const map = {
						'agentCard.rtcPhase': 'RTC Phase',
						'agentCard.lastAlive': 'Last Alive',
						'agentCard.reconnect': 'Reconnect',
						'agentCard.working': 'Working',
						'agentCard.mainTopic': 'Main Topic',
						'agentCard.sessions': 'Sessions',
						'agentCard.topics': 'Topics',
						'agentCard.cached': 'Cached',
						'agentCard.reconnectFailed': 'Reconnect failed',
						'chat.connBuilding': 'Building connection…',
						'chat.connRecovering': 'Recovering connection…',
						'agents.chat': 'Chat',
						'agents.files': 'Files',
						'dashboard.justNow': 'Just now',
					};
					if (key === 'agentCard.viewMore') return `View More(${params?.n ?? ''})`;
					if (key === 'dashboard.minutesAgo') return `${params?.n ?? ''} mins ago`;
					if (key === 'dashboard.hoursAgo') return `${params?.n ?? ''} hrs ago`;
					if (key === 'dashboard.daysAgo') return `${params?.n ?? ''} days ago`;
					return map[key] ?? key;
				},
			},
		},
	});
}

// ---- tests ----

describe('AgentCard', () => {
	beforeEach(() => {
		mockIsRunning = vi.fn().mockReturnValue(false);
		mockGetActiveRun = vi.fn().mockReturnValue(null);
		mockGetDashboard.mockReturnValue(null);
		mockTopicItems = [];
		mockEnsureRtc.mockResolvedValue(undefined);
		vi.clearAllMocks();
	});

	test('offline → 灰色边框', async () => {
		const wrapper = createWrapper(makeBot({ online: false }));
		await flushPromises();

		const card = wrapper.find('[data-testid="agent-card-bot1"]');
		expect(card.exists()).toBe(true);
		expect(card.classes()).toContain('border-gray-300');
	});

	test('failed → 红色边框 + 自动展开 + 重连按钮', async () => {
		const wrapper = createWrapper(makeBot({ online: true, rtcPhase: 'failed' }));
		await flushPromises();

		const card = wrapper.find('[data-testid="agent-card-bot1"]');
		expect(card.classes()).toContain('border-red-400');
		// 展开后应有重连按钮
		expect(wrapper.find('[data-testid="btn-reconnect"]').exists()).toBe(true);
	});

	test('failed 重连按钮 → 调用 botsStore.__ensureRtc', async () => {
		const wrapper = createWrapper(makeBot({ online: true, rtcPhase: 'failed' }));
		await flushPromises();

		await wrapper.find('[data-testid="btn-reconnect"]').trigger('click');
		await flushPromises();

		expect(mockEnsureRtc).toHaveBeenCalledWith('bot1');
	});

	test('running → 蓝色边框 + 自动展开 + 计时文字', async () => {
		mockIsRunning = vi.fn().mockReturnValue(true);
		mockGetActiveRun = vi.fn().mockReturnValue({ startTime: Date.now() - 5000, runId: 'r1', runKey: 'agent:main:main' });

		const wrapper = createWrapper(makeBot({ online: true, rtcPhase: 'ready' }));
		await flushPromises();

		const card = wrapper.find('[data-testid="agent-card-bot1"]');
		expect(card.classes()).toContain('border-blue-400');
		// 计时文字在头部或展开内容中
		expect(wrapper.text()).toMatch(/\d+s|working/i);
		// 展开区域应有 chat 按钮
		expect(wrapper.find('[data-testid="btn-chat"]').exists()).toBe(true);
	});

	test('running topic > 3 → 折叠 + 查看更多', async () => {
		mockIsRunning = vi.fn().mockReturnValue(true);
		mockGetActiveRun = vi.fn().mockReturnValue({ startTime: Date.now(), runId: 'r1', runKey: 'agent:main:main' });
		mockTopicItems = [
			{ topicId: 't1', botId: 'bot1', agentId: 'main', title: 'Topic 1', createdAt: 1 },
			{ topicId: 't2', botId: 'bot1', agentId: 'main', title: 'Topic 2', createdAt: 2 },
			{ topicId: 't3', botId: 'bot1', agentId: 'main', title: 'Topic 3', createdAt: 3 },
			{ topicId: 't4', botId: 'bot1', agentId: 'main', title: 'Topic 4', createdAt: 4 },
		];

		const wrapper = createWrapper(makeBot({ online: true, rtcPhase: 'ready' }));
		await flushPromises();

		// 只显示前3条
		expect(wrapper.text()).toContain('Topic 1');
		expect(wrapper.text()).toContain('Topic 3');
		expect(wrapper.text()).not.toContain('Topic 4');
		// 「查看更多」按钮存在
		expect(wrapper.text()).toMatch(/View More\(1\)/);
	});

	test('idle → 绿色边框 + 进入对话按钮', async () => {
		const wrapper = createWrapper(makeBot({ online: true, rtcPhase: 'ready' }));
		await flushPromises();

		const card = wrapper.find('[data-testid="agent-card-bot1"]');
		expect(card.classes()).toContain('border-green-400');
		expect(wrapper.find('[data-testid="btn-chat"]').exists()).toBe(true);
	});

	test('connecting → 黄色边框', async () => {
		const wrapper = createWrapper(makeBot({ online: true, rtcPhase: 'building' }));
		await flushPromises();

		const card = wrapper.find('[data-testid="agent-card-bot1"]');
		expect(card.classes()).toContain('border-yellow-400');
	});
});
