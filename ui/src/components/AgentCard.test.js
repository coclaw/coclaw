import { nextTick } from 'vue';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, flushPromises } from '@vue/test-utils';
import AgentCard from './AgentCard.vue';

// ---- store mocks ----

let mockIsRunning = vi.fn().mockReturnValue(false);
let mockRunKeyIndex = {};
let mockRuns = {};
let mockEnsureRtc = vi.fn().mockResolvedValue(undefined);

vi.mock('../stores/bots.store.js', () => ({
	useBotsStore: () => ({
		__ensureRtc: mockEnsureRtc,
	}),
}));

vi.mock('../stores/agent-runs.store.js', () => ({
	useAgentRunsStore: () => ({
		get isRunning() { return mockIsRunning; },
		get runKeyIndex() { return mockRunKeyIndex; },
		get runs() { return mockRuns; },
	}),
}));

let mockGetDashboard = vi.fn().mockReturnValue(null);
vi.mock('../stores/dashboard.store.js', () => ({
	useDashboardStore: () => ({
		getDashboard: mockGetDashboard,
	}),
}));

let mockTopicsItems = [];
vi.mock('../stores/topics.store.js', () => ({
	useTopicsStore: () => ({
		get items() { return mockTopicsItems; },
	}),
}));

const mockNotify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../composables/use-notify.js', () => ({
	useNotify: () => mockNotify,
}));

// ---- stubs ----

// UButton stub：只声明 props，不单独 emit click，让原生 DOM click 事件通过 inheritAttrs 传给父组件的 @click.stop
const UButtonStub = {
	props: ['loading', 'disabled', 'color', 'variant', 'size'],
	template: '<button v-bind="$attrs"><slot /></button>',
};
const UIconStub = {
	props: ['name'],
	template: '<i :data-icon="name" />',
};

// ---- helpers ----

const mockT = (key, params) => {
	if (params?.n !== undefined) return `${key}(${params.n})`;
	return key;
};

function makeBot(overrides = {}) {
	return {
		id: 'bot1',
		name: 'TestBot',
		online: true,
		rtcPhase: 'ready',
		lastAliveAt: 0,
		...overrides,
	};
}

function mountCard(botOverrides = {}, { isRunning = false } = {}) {
	mockIsRunning = vi.fn().mockReturnValue(isRunning);
	return mount(AgentCard, {
		props: { bot: makeBot(botOverrides) },
		global: {
			plugins: [createPinia()],
			stubs: { UButton: UButtonStub, UIcon: UIconStub },
			mocks: { $t: mockT },
		},
	});
}

beforeEach(() => {
	setActivePinia(createPinia());
	mockIsRunning = vi.fn().mockReturnValue(false);
	mockRunKeyIndex = {};
	mockRuns = {};
	mockGetDashboard.mockReturnValue(null);
	mockTopicsItems = [];
	mockEnsureRtc.mockResolvedValue(undefined);
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('AgentCard', () => {

	// ---- 五种状态渲染 ----

	test('offline 状态 - 显示灰色点、不自动展开', () => {
		const wrapper = mountCard({ online: false });
		expect(wrapper.find('.bg-gray-400').exists()).toBe(true);
		// 默认折叠，不显示内容区
		expect(wrapper.find('[data-testid="agent-card-bot1"]').exists()).toBe(true);
		// 展开内容需点击后才出现
		const innerContent = wrapper.find('.border-t');
		expect(innerContent.exists()).toBe(false);
	});

	test('failed 状态 - 显示红色边框、自动展开、显示重连按钮', () => {
		const wrapper = mountCard({ online: true, rtcPhase: 'failed' });
		// 红色边框
		expect(wrapper.find('.border-red-400').exists()).toBe(true);
		// 自动展开 → 有展开内容
		expect(wrapper.find('.border-t').exists()).toBe(true);
		// 包含重连按钮文字
		expect(wrapper.text()).toContain('agentCard.reconnectAndChat');
	});

	test('running 状态 - 显示蓝色边框、自动展开、显示计时', async () => {
		mockIsRunning = vi.fn().mockReturnValue(true);
		const startTime = Date.now() - 90_000; // 1分30秒前
		mockRunKeyIndex = { 'agent:main:main': 'run1' };
		mockRuns = { run1: { startTime, settled: false } };

		const wrapper = mountCard({ online: true, rtcPhase: 'ready' }, { isRunning: true });
		// 等待 mounted 后 agentRunsStore 赋值 → statusKey 重算 → DOM 更新
		await nextTick();
		// 蓝色边框
		expect(wrapper.find('.border-blue-400').exists()).toBe(true);
		// 自动展开
		expect(wrapper.find('.border-t').exists()).toBe(true);
		// 计时文字存在（包含 agentCard.running）
		expect(wrapper.text()).toContain('agentCard.running');
		wrapper.unmount();
	});

	test('connecting 状态 - 显示黄色边框、显示连接中文字', () => {
		const wrapper = mountCard({ online: true, rtcPhase: 'building' });
		expect(wrapper.find('.border-yellow-400').exists()).toBe(true);
		expect(wrapper.text()).toContain('chat.connBuilding');
	});

	test('recovering 状态 - 显示 connRecovering 文字', () => {
		const wrapper = mountCard({ online: true, rtcPhase: 'recovering' });
		expect(wrapper.text()).toContain('chat.connRecovering');
	});

	test('idle 状态 - 显示绿色边框', () => {
		const wrapper = mountCard({ online: true, rtcPhase: 'ready' });
		expect(wrapper.find('.border-green-400').exists()).toBe(true);
	});

	// ---- failed 态按钮 ----

	test('failed 态 - 点击重连按钮调用 botsStore.__ensureRtc 并 emit chat', async () => {
		const wrapper = mountCard({ online: true, rtcPhase: 'failed' });
		// 展开区中有 w-full 按钮（重连按钮）
		const btn = wrapper.find('.w-full');
		await btn.trigger('click');
		await flushPromises();

		expect(mockEnsureRtc).toHaveBeenCalledWith('bot1');
		expect(wrapper.emitted('chat')).toBeTruthy();
		expect(wrapper.emitted('chat')[0]).toEqual(['bot1']);
	});

	test('failed 态 - __ensureRtc 失败时 notify.error', async () => {
		const err = new Error('rtc boom');
		mockEnsureRtc.mockRejectedValueOnce(err);
		const wrapper = mountCard({ online: true, rtcPhase: 'failed' });
		const btn = wrapper.find('.w-full');
		await btn.trigger('click');
		await flushPromises();

		expect(mockNotify.error).toHaveBeenCalled();
		expect(wrapper.emitted('chat')).toBeFalsy();
	});

	// ---- 工作中计时 ----

	test('running 状态 - mounted 时启动计时器', async () => {
		const fakeNow = 1_000_000;
		vi.spyOn(Date, 'now').mockReturnValue(fakeNow);
		const startTime = fakeNow - 154_000; // 2m34s
		mockIsRunning = vi.fn().mockReturnValue(true);
		mockRunKeyIndex = { 'agent:main:main': 'run2' };
		mockRuns = { run2: { startTime, settled: false } };

		const wrapper = mountCard({ online: true, rtcPhase: 'ready' }, { isRunning: true });
		await flushPromises();

		// 计时文字应为 2m34s
		expect(wrapper.vm.elapsedText).toBe('2m34s');
		wrapper.unmount(); // 清理计时器
	});

	test('beforeUnmount 时清理计时器', async () => {
		const clearSpy = vi.spyOn(global, 'clearInterval');
		mockIsRunning = vi.fn().mockReturnValue(true);
		mockRunKeyIndex = { 'agent:main:main': 'run3' };
		mockRuns = { run3: { startTime: Date.now(), settled: false } };

		const wrapper = mountCard({ online: true, rtcPhase: 'ready' }, { isRunning: true });
		expect(wrapper.vm._elapsedTimer).not.toBeNull();

		wrapper.unmount();
		expect(clearSpy).toHaveBeenCalled();
	});

	// ---- 话题列表 ----

	test('话题超3条 → 显示折叠按钮', async () => {
		mockTopicsItems = [
			{ topicId: 't1', agentId: 'main', botId: 'bot1', title: 'Topic 1' },
			{ topicId: 't2', agentId: 'main', botId: 'bot1', title: 'Topic 2' },
			{ topicId: 't3', agentId: 'main', botId: 'bot1', title: 'Topic 3' },
			{ topicId: 't4', agentId: 'main', botId: 'bot1', title: 'Topic 4' },
		];
		// offline 状态可见话题列表（展开后显示）
		const wrapper = mountCard({ online: false });
		// 点击展开
		await wrapper.find('[data-testid="agent-card-bot1"]').find('.flex').trigger('click');
		await flushPromises();

		const showMore = wrapper.find('[data-testid="topics-show-more"]');
		expect(showMore.exists()).toBe(true);
		expect(showMore.text()).toContain('agentCard.showMoreTopics(1)');
	});

	test('话题不超3条 → 无折叠按钮', async () => {
		mockTopicsItems = [
			{ topicId: 't1', agentId: 'main', botId: 'bot1', title: 'Topic 1' },
			{ topicId: 't2', agentId: 'main', botId: 'bot1', title: 'Topic 2' },
		];
		const wrapper = mountCard({ online: false });
		await wrapper.find('[data-testid="agent-card-bot1"]').find('.flex').trigger('click');
		await flushPromises();

		expect(wrapper.find('[data-testid="topics-show-more"]').exists()).toBe(false);
	});

	// ---- idle 态 emit ----

	test('idle 态 - chat 按钮 emit chat', async () => {
		const wrapper = mountCard({ online: true, rtcPhase: 'ready' });
		// 直接调用 vm 方法，绕开 @click.stop 的 event 系统
		wrapper.vm.onChat();
		await nextTick();
		expect(wrapper.emitted('chat')).toBeTruthy();
		expect(wrapper.emitted('chat')[0]).toEqual(['bot1']);
	});

	test('idle 态 - files 按钮 emit files', async () => {
		const wrapper = mountCard({ online: true, rtcPhase: 'ready' });
		wrapper.vm.onFiles();
		await nextTick();
		expect(wrapper.emitted('files')).toBeTruthy();
		expect(wrapper.emitted('files')[0]).toEqual(['bot1']);
	});

	// ---- data-testid ----

	test('根元素包含 data-testid', () => {
		const wrapper = mountCard({ id: 'xyz' });
		expect(wrapper.find('[data-testid="agent-card-xyz"]').exists()).toBe(true);
	});

});
