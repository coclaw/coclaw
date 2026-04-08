import { createPinia } from 'pinia';
import { mount, flushPromises } from '@vue/test-utils';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

import AgentCard from './AgentCard.vue';

// ---- mocks ----

let mockIsRunning = vi.fn().mockReturnValue(false);
let mockGetActiveRun = vi.fn().mockReturnValue(null);

vi.mock('../stores/agent-runs.store.js', () => ({
	useAgentRunsStore: () => ({
		get isRunning() { return mockIsRunning; },
		get getActiveRun() { return mockGetActiveRun; },
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
	template: '<span class="badge"><slot /></span>',
};

// ---- helpers ----

function makeAgent(overrides = {}) {
	return {
		id: 'main',
		name: 'Main Agent',
		modelTags: [],
		capabilities: [],
		totalTokens: 0,
		activeSessions: 0,
		lastActivity: null,
		...overrides,
	};
}

function makeBot(overrides = {}) {
	return {
		id: 'bot1',
		name: 'TestBot',
		online: true,
		rtcPhase: 'ready',
		lastAliveAt: 0,
		retryCount: 0,
		retryNextAt: 0,
		...overrides,
	};
}

const $tMap = {
	'agentCard.lastAlive': 'Last Alive',
	'topic.newTopic': 'New topic',
	'chat.connBuilding': 'Building connection…',
	'chat.connRecovering': 'Recovering connection…',
	'bots.conn.rtcRetryExhausted': 'Connection failed, retries exhausted',
	'agents.chat': 'Chat',
	'agents.files': 'Files',
	'dashboard.justNow': 'Just now',
	'dashboard.tokens': 'Tokens',
	'dashboard.sessions': 'Sessions',
	'dashboard.lastActive': 'Last Active',
};

function $t(key, params) {
	if (key === 'agentCard.viewMore') return `View More(${params?.n ?? ''})`;
	if (key === 'dashboard.minutesAgo') return `${params?.n ?? ''} mins ago`;
	if (key === 'dashboard.hoursAgo') return `${params?.n ?? ''} hrs ago`;
	if (key === 'dashboard.daysAgo') return `${params?.n ?? ''} days ago`;
	if (key === 'bots.conn.rtcRetrying') return `Connection failed, retry ${params?.n}/${params?.max}…`;
	return $tMap[key] ?? key;
}

function createWrapper(agent = makeAgent(), claw = makeBot()) {
	return mount(AgentCard, {
		props: { agent, claw },
		global: {
			plugins: [createPinia()],
			stubs: { UButton: UButtonStub, UIcon: UIconStub, UBadge: UBadgeStub },
			mocks: { $t },
		},
	});
}

// ---- tests ----

describe('AgentCard', () => {
	beforeEach(() => {
		mockIsRunning = vi.fn().mockReturnValue(false);
		mockGetActiveRun = vi.fn().mockReturnValue(null);
		mockTopicItems = [];
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// ---- statusKey ----

	test('offline claw → statusKey=offline', async () => {
		const w = createWrapper(makeAgent(), makeBot({ online: false }));
		await flushPromises();
		expect(w.vm.statusKey).toBe('offline');
	});

	test('rtcPhase=failed（claw 级）不影响 agent statusKey，仍为 idle', async () => {
		const w = createWrapper(makeAgent(), makeBot({ rtcPhase: 'failed' }));
		await flushPromises();
		expect(w.vm.statusKey).toBe('idle');
	});

	test('isRunning=true → statusKey=running', async () => {
		mockIsRunning = vi.fn().mockReturnValue(true);
		const w = createWrapper(makeAgent(), makeBot());
		await flushPromises();
		expect(w.vm.statusKey).toBe('running');
	});

	test('rtcPhase=building（claw 级）不影响 agent statusKey，仍为 idle', async () => {
		const w = createWrapper(makeAgent(), makeBot({ rtcPhase: 'building' }));
		await flushPromises();
		expect(w.vm.statusKey).toBe('idle');
	});

	test('rtcPhase=recovering（claw 级）不影响 agent statusKey，仍为 idle', async () => {
		const w = createWrapper(makeAgent(), makeBot({ rtcPhase: 'recovering' }));
		await flushPromises();
		expect(w.vm.statusKey).toBe('idle');
	});

	test('online + ready + 非 running → statusKey=idle', async () => {
		const w = createWrapper(makeAgent(), makeBot());
		await flushPromises();
		expect(w.vm.statusKey).toBe('idle');
	});

	test('rtcPhase=failed 时 isRunning=true → statusKey=running', async () => {
		mockIsRunning = vi.fn().mockReturnValue(true);
		const w = createWrapper(makeAgent(), makeBot({ rtcPhase: 'failed' }));
		await flushPromises();
		expect(w.vm.statusKey).toBe('running');
	});

	// ---- runKey 使用 agent.id ----

	test('isRunning 使用正确的 runKey（agent.id）', async () => {
		mockIsRunning = vi.fn().mockReturnValue(false);
		createWrapper(makeAgent({ id: 'ops' }), makeBot());
		await flushPromises();
		expect(mockIsRunning).toHaveBeenCalledWith('agent:ops:main');
	});

	// ---- dotClass ----

	test('各状态对应正确的 dot class', async () => {
		const cases = [
			[{ online: false }, 'bg-gray-400'],  // offline
			[{}, 'bg-green-400'],                 // idle
		];
		for (const [botOverrides, expected] of cases) {
			const w = createWrapper(makeAgent(), makeBot(botOverrides));
			await flushPromises();
			expect(w.find('.rounded-full').classes()).toContain(expected);
			w.unmount();
		}
	});

	test('running → blue dot with pulse', async () => {
		mockIsRunning = vi.fn().mockReturnValue(true);
		mockGetActiveRun = vi.fn().mockReturnValue({ startTime: Date.now() });
		const w = createWrapper(makeAgent(), makeBot());
		await flushPromises();
		const dot = w.find('.rounded-full');
		expect(dot.classes()).toContain('bg-blue-400');
		expect(dot.classes()).toContain('animate-pulse');
	});

	// ---- 初始展开状态 ----

	test('所有状态默认折叠', async () => {
		for (const claw of [makeBot(), makeBot({ online: false }), makeBot({ rtcPhase: 'building' })]) {
			const w = createWrapper(makeAgent(), claw);
			await flushPromises();
			expect(w.vm.expanded).toBe(false);
			w.unmount();
		}
		// running 也默认折叠
		mockIsRunning = vi.fn().mockReturnValue(true);
		mockGetActiveRun = vi.fn().mockReturnValue({ startTime: Date.now() });
		const w = createWrapper(makeAgent(), makeBot());
		await flushPromises();
		expect(w.vm.expanded).toBe(false);
	});

	// ---- 详情按钮 ----

	test('有 capabilities → 显示详情按钮，点击展开/折叠', async () => {
		const w = createWrapper(
			makeAgent({ capabilities: [{ id: 'web', labelKey: 'cap.web', icon: '🌐' }] }),
			makeBot(),
		);
		await flushPromises();
		const btn = w.find('[data-testid="btn-details"]');
		expect(btn.exists()).toBe(true);

		await btn.trigger('click');
		expect(w.vm.expanded).toBe(true);

		await btn.trigger('click');
		expect(w.vm.expanded).toBe(false);
	});

	test('无 capabilities 且无 topics → 不显示详情按钮', async () => {
		const w = createWrapper(makeAgent({ capabilities: [] }), makeBot());
		await flushPromises();
		expect(w.find('[data-testid="btn-details"]').exists()).toBe(false);
	});

	// ---- 按钮可见性 ----

	test('claw 在线 → 显示 Chat/Files 按钮', async () => {
		const w = createWrapper(makeAgent(), makeBot({ online: true }));
		await flushPromises();
		expect(w.find('[data-testid="btn-chat"]').exists()).toBe(true);
		expect(w.find('[data-testid="btn-files"]').exists()).toBe(true);
	});

	test('claw 离线 → 不显示按钮', async () => {
		const w = createWrapper(makeAgent(), makeBot({ online: false }));
		await flushPromises();
		expect(w.find('[data-testid="btn-chat"]').exists()).toBe(false);
		expect(w.find('[data-testid="btn-files"]').exists()).toBe(false);
	});

	// ---- emit 事件使用 agent.id ----

	test('点击 Chat → emit chat 携带 agent.id', async () => {
		const w = createWrapper(makeAgent({ id: 'ops' }), makeBot());
		await flushPromises();
		await w.find('[data-testid="btn-chat"]').trigger('click');
		expect(w.emitted('chat')).toEqual([['ops']]);
	});

	test('点击 Files → emit files 携带 agent.id', async () => {
		const w = createWrapper(makeAgent({ id: 'dev' }), makeBot());
		await flushPromises();
		await w.find('[data-testid="btn-files"]').trigger('click');
		expect(w.emitted('files')).toEqual([['dev']]);
	});

	// ---- 信息展示 ----

	test('idle 显示 model badge + stats 三列（tokens/sessions/lastActive）', async () => {
		const w = createWrapper(
			makeAgent({ modelTags: [{ label: 'GPT-4' }], totalTokens: 2500, activeSessions: 3, lastActivity: new Date(Date.now() - 60_000).toISOString() }),
			makeBot(),
		);
		await flushPromises();
		expect(w.text()).toContain('GPT-4');
		expect(w.text()).toContain('2.5K');
		expect(w.text()).toContain('Tokens');
		expect(w.text()).toContain('3');
		expect(w.text()).toContain('Sessions');
		expect(w.text()).toContain('Last Active');
	});

	test('idle 无 model → 不渲染 model badge', async () => {
		const w = createWrapper(makeAgent(), makeBot());
		await flushPromises();
		expect(w.vm.modelLabel).toBeNull();
	});

	test('offline 状态仍显示缓存的 stats 数据', async () => {
		const w = createWrapper(makeAgent({ totalTokens: 500, activeSessions: 1 }), makeBot({ online: false }));
		await flushPromises();
		expect(w.text()).toContain('Tokens');
		expect(w.text()).toContain('500');
		expect(w.text()).toContain('Sessions');
	});

	test('agent 卡片不显示 claw 级连接重试信息', async () => {
		const w = createWrapper(
			makeAgent(),
			makeBot({ rtcPhase: 'failed', retryCount: 3, lastAliveAt: Date.now() - 60_000 }),
		);
		await flushPromises();
		expect(w.text()).not.toContain('retries exhausted');
		expect(w.text()).not.toContain('retry');
		expect(w.text()).not.toContain('Building connection');
		expect(w.text()).not.toContain('Recovering connection');
	});

	test('offline 显示 lastAlive', async () => {
		const w = createWrapper(
			makeAgent(),
			makeBot({ online: false, lastAliveAt: Date.now() - 7200_000 }),
		);
		await flushPromises();
		expect(w.text()).toContain('Last Alive');
		expect(w.text()).toContain('2 hrs ago');
	});

	test('offline 卡片带 opacity', async () => {
		const w = createWrapper(makeAgent(), makeBot({ online: false }));
		await flushPromises();
		expect(w.find('[data-testid="agent-card-main"]').classes()).toContain('opacity-60');
	});

	// ---- running timer ----

	test('running 显示计时 + 递增', async () => {
		mockIsRunning = vi.fn().mockReturnValue(true);
		mockGetActiveRun = vi.fn().mockReturnValue({ startTime: Date.now() - 5000 });
		const w = createWrapper(makeAgent(), makeBot());
		await flushPromises();
		expect(w.vm.elapsedSecs).toBe(5);
		vi.advanceTimersByTime(3000);
		expect(w.vm.elapsedSecs).toBe(8);
	});

	test('running → idle 停止计时', async () => {
		mockIsRunning = vi.fn().mockReturnValue(true);
		mockGetActiveRun = vi.fn().mockReturnValue({ startTime: Date.now() });
		const w = createWrapper(makeAgent(), makeBot());
		await flushPromises();
		mockIsRunning = vi.fn().mockReturnValue(false);
		await w.setProps({ claw: makeBot() });
		await flushPromises();
		const secs = w.vm.elapsedSecs;
		vi.advanceTimersByTime(5000);
		expect(w.vm.elapsedSecs).toBe(secs);
	});

	test('unmount 清理 timer', async () => {
		mockIsRunning = vi.fn().mockReturnValue(true);
		mockGetActiveRun = vi.fn().mockReturnValue({ startTime: Date.now() });
		const w = createWrapper(makeAgent(), makeBot());
		await flushPromises();
		w.unmount();
		vi.advanceTimersByTime(5000);
	});

	test('elapsedText 纯秒', async () => {
		mockIsRunning = vi.fn().mockReturnValue(true);
		mockGetActiveRun = vi.fn().mockReturnValue({ startTime: Date.now() - 45_000 });
		const w = createWrapper(makeAgent(), makeBot());
		await flushPromises();
		expect(w.vm.elapsedText).toBe('45s');
	});

	test('elapsedText 分+秒', async () => {
		mockIsRunning = vi.fn().mockReturnValue(true);
		mockGetActiveRun = vi.fn().mockReturnValue({ startTime: Date.now() - 125_000 });
		const w = createWrapper(makeAgent(), makeBot());
		await flushPromises();
		expect(w.vm.elapsedText).toBe('2m 5s');
	});

	test('run 无 startTime → 从 0 计', async () => {
		mockIsRunning = vi.fn().mockReturnValue(true);
		mockGetActiveRun = vi.fn().mockReturnValue({ startTime: null });
		const w = createWrapper(makeAgent(), makeBot());
		await flushPromises();
		expect(w.vm.elapsedSecs).toBe(0);
	});

	// ---- topics ----

	test('topics 按 clawId + agentId 过滤', async () => {
		mockTopicItems = [
			{ topicId: 't1', clawId: 'bot1', agentId: 'main', title: 'Mine', createdAt: 1 },
			{ topicId: 't2', clawId: 'other', agentId: 'main', title: 'NotMine', createdAt: 2 },
			{ topicId: 't3', clawId: 'bot1', agentId: 'ops', title: 'WrongAgent', createdAt: 3 },
		];
		const w = createWrapper(makeAgent({ id: 'main' }), makeBot({ id: 'bot1' }));
		await flushPromises();
		expect(w.vm.agentTopics).toHaveLength(1);
		expect(w.vm.agentTopics[0].title).toBe('Mine');
	});

	test('topics > 3 → 前3条 + 查看更多', async () => {
		mockTopicItems = [
			{ topicId: 't1', clawId: 'bot1', agentId: 'main', title: 'T1', createdAt: 1 },
			{ topicId: 't2', clawId: 'bot1', agentId: 'main', title: 'T2', createdAt: 2 },
			{ topicId: 't3', clawId: 'bot1', agentId: 'main', title: 'T3', createdAt: 3 },
			{ topicId: 't4', clawId: 'bot1', agentId: 'main', title: 'T4', createdAt: 4 },
		];
		const w = createWrapper(makeAgent(), makeBot());
		await flushPromises();
		// 需先展开
		await w.find('[data-testid="btn-details"]').trigger('click');
		expect(w.text()).toContain('T1');
		expect(w.text()).toContain('T3');
		expect(w.text()).not.toContain('T4');
		expect(w.text()).toContain('View More(1)');
	});

	test('点击查看更多 → 展示全部', async () => {
		mockTopicItems = [
			{ topicId: 't1', clawId: 'bot1', agentId: 'main', title: 'T1', createdAt: 1 },
			{ topicId: 't2', clawId: 'bot1', agentId: 'main', title: 'T2', createdAt: 2 },
			{ topicId: 't3', clawId: 'bot1', agentId: 'main', title: 'T3', createdAt: 3 },
			{ topicId: 't4', clawId: 'bot1', agentId: 'main', title: 'T4', createdAt: 4 },
		];
		const w = createWrapper(makeAgent(), makeBot());
		await flushPromises();
		await w.find('[data-testid="btn-details"]').trigger('click');
		await w.find('.text-primary.underline').trigger('click');
		expect(w.text()).toContain('T4');
	});

	test('topic 无 title → 显示 Main Topic', async () => {
		mockTopicItems = [
			{ topicId: 't1', clawId: 'bot1', agentId: 'main', title: '', createdAt: 1 },
		];
		const w = createWrapper(makeAgent(), makeBot());
		await flushPromises();
		await w.find('[data-testid="btn-details"]').trigger('click');
		expect(w.text()).toContain('New topic');
	});

	// ---- capabilities ----

	test('展开后显示 capabilities（在 topics 前）', async () => {
		mockTopicItems = [
			{ topicId: 't1', clawId: 'bot1', agentId: 'main', title: 'MyTopic', createdAt: 1 },
		];
		const w = createWrapper(
			makeAgent({ capabilities: [{ id: 'web', labelKey: 'cap.web', icon: '🌐' }] }),
			makeBot(),
		);
		await flushPromises();
		await w.find('[data-testid="btn-details"]').trigger('click');
		expect(w.text()).toContain('🌐');
		expect(w.text()).toContain('cap.web');
		// capabilities 在 topics 前面
		const html = w.html();
		const capIdx = html.indexOf('cap.web');
		const topicIdx = html.indexOf('MyTopic');
		expect(capIdx).toBeLessThan(topicIdx);
	});

	test('无 capabilities 且无 topics → 详情按钮不存在，badges 不渲染', async () => {
		const w = createWrapper(makeAgent({ capabilities: [] }), makeBot());
		await flushPromises();
		expect(w.find('[data-testid="btn-details"]').exists()).toBe(false);
		expect(w.findAll('.badge')).toHaveLength(0);
	});

	// ---- formatRelativeTime 边界 ----

	test('formatRelativeTime ts=0 → —', async () => {
		const w = createWrapper(makeAgent(), makeBot());
		await flushPromises();
		expect(w.vm.formatRelativeTime(0)).toBe('—');
	});

	test('formatRelativeTime ts=null → —', async () => {
		const w = createWrapper(makeAgent(), makeBot());
		await flushPromises();
		expect(w.vm.formatRelativeTime(null)).toBe('—');
	});

	test('formatRelativeTime <60s → Just now', async () => {
		const w = createWrapper(makeAgent(), makeBot());
		await flushPromises();
		expect(w.vm.formatRelativeTime(Date.now() - 30_000)).toBe('Just now');
	});

	test('formatRelativeTime 2天（number） → days', async () => {
		const w = createWrapper(makeAgent(), makeBot());
		await flushPromises();
		expect(w.vm.formatRelativeTime(Date.now() - 172800_000)).toBe('2 days ago');
	});

	test('formatRelativeTime 有效 ISO → 相对时间', async () => {
		const w = createWrapper(makeAgent(), makeBot());
		await flushPromises();
		const iso = new Date(Date.now() - 7200_000).toISOString();
		expect(w.vm.formatRelativeTime(iso)).toBe('2 hrs ago');
	});

	test('formatRelativeTime 无效字符串 → —', async () => {
		const w = createWrapper(makeAgent(), makeBot());
		await flushPromises();
		expect(w.vm.formatRelativeTime('not-a-date')).toBe('—');
	});

	// ---- formatTokens 边界 ----

	test('formatTokens 边界值', async () => {
		const w = createWrapper(makeAgent(), makeBot());
		await flushPromises();
		expect(w.vm.formatTokens(0)).toBe('0');
		expect(w.vm.formatTokens(-5)).toBe('0');
		expect(w.vm.formatTokens('abc')).toBe('0');
		expect(w.vm.formatTokens(999)).toBe('999');
		expect(w.vm.formatTokens(1000)).toBe('1.0K');
		expect(w.vm.formatTokens(1000000)).toBe('1.0M');
	});

	// ---- statusKey watch 自动展开 ----

	test('状态变为 running 时启动计时', async () => {
		const w = createWrapper(makeAgent(), makeBot());
		await flushPromises();

		mockIsRunning = vi.fn().mockReturnValue(true);
		mockGetActiveRun = vi.fn().mockReturnValue({ startTime: Date.now() - 10_000 });
		await w.setProps({ claw: makeBot() });
		await flushPromises();
		expect(w.vm.elapsedSecs).toBe(10);
	});

	// ---- data-testid ----

	test('data-testid 使用 agent.id', async () => {
		const w = createWrapper(makeAgent({ id: 'ops' }), makeBot());
		await flushPromises();
		expect(w.find('[data-testid="agent-card-ops"]').exists()).toBe(true);
	});
});
