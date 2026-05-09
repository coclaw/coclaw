import { ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { vi, afterEach } from 'vitest';

// MainList 现在通过 useWebAgentDialogs 间接依赖 @nuxt/ui 的 useOverlay；测试环境内没有
// UApp 上下文，必须 mock 掉，否则 mount 时抛错。同时 mock 掉外部跳转工具，避免污染。
const __openPickerDialogMock = vi.hoisted(() => vi.fn());
vi.mock('../composables/use-web-agent-dialogs.js', () => ({
	useWebAgentDialogs: () => ({ openPickerDialog: __openPickerDialogMock }),
}));
const __openExternalUrlMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../utils/external-url.js', () => ({
	openExternalUrl: __openExternalUrlMock,
}));

// MainList mounted 时调用 webAgentsStore.loadAll()。它走 axios，环境里没有真实 server，
// 不 mock 会让所有 MainList 测试输出 "GET /api/v1/web-agents → 401" 噪音；mock 掉让 store
// 静默拿到空列表即可
const __webAgentsApiMock = vi.hoisted(() => ({
	listWebAgents: vi.fn().mockResolvedValue([]),
	recordWebAgentClick: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/web-agents.api.js', () => __webAgentsApiMock);

import MainList from './MainList.vue';
import { useAgentsStore } from '../stores/agents.store.js';
import { useClawsStore } from '../stores/claws.store.js';
import { useSessionsStore } from '../stores/sessions.store.js';
import { useTopicsStore } from '../stores/topics.store.js';
import { useWebAgentsStore } from '../stores/web-agents.store.js';

function toById(items) {
	const byId = {};
	for (const t of items) byId[t.topicId] = t;
	return byId;
}

let __mockIsCapacitorApp = false;
vi.mock('../utils/platform.js', () => ({
	get isCapacitorApp() { return __mockIsCapacitorApp; },
	detectWebPlatform: () => 'unknown',
}));

// 用例尾部若因断言失败提前抛错，手动复位不会执行；此处兜底，避免下一用例继承 true 状态
afterEach(() => {
	__mockIsCapacitorApp = false;
});

vi.mock('../services/claws.api.js', () => ({
	listClaws: vi.fn().mockResolvedValue([]),
}));

vi.mock('./TopicItemActions.vue', () => ({
	default: { name: 'TopicItemActions', template: '<div class="topic-actions-stub" />', props: ['topicId', 'clawId', 'title'] },
}));

vi.mock('./AgentItemActions.vue', () => ({
	default: { name: 'AgentItemActions', template: '<div class="agent-actions-stub" />', props: ['clawId', 'agentId'] },
}));

vi.mock('../services/claw-connection-manager.js', () => ({
	useClawConnections: () => ({
		get: vi.fn(),
		connect: vi.fn(),
		disconnect: vi.fn(),
		syncConnections: vi.fn(),
		disconnectAll: vi.fn(),
	}),
	__resetClawConnections: vi.fn(),
}));

const RouterLinkStub = {
	props: {
		to: {
			type: [String, Object],
			required: true,
		},
	},
	template: '<a :href="typeof to === \'string\' ? to : to.path"><slot /></a>',
};

const UIconStub = {
	props: ['name'],
	template: '<span class="icon" :name="name"></span>',
};

const UButtonStub = {
	props: ['icon', 'color', 'variant', 'size'],
	template: '<button class="u-button-stub" @click="$emit(\'click\')"><slot /></button>',
	emits: ['click'],
};

function createWrapper(props = {}) {
	const pinia = createPinia();
	setActivePinia(pinia);
	return mount(MainList, {
		props: {
			currentPath: '/topics',
			...props,
		},
		global: {
			plugins: [pinia],
			stubs: {
				RouterLink: RouterLinkStub,
				UIcon: UIconStub,
				UButton: UButtonStub,
				TopicItemActions: { template: '<div class="topic-actions-stub" />' },
				AgentItemActions: { template: '<div class="agent-actions-stub" />' },
			},
			mocks: {
				$t: (key) => {
					const map = {
						'layout.addClaw': '添加机器人',
						'layout.manageClaws': '管理机器人',
						'layout.productName': 'CoClaw',
						'layout.rtcConnecting': '正在连接',
						'layout.rtcUnreachable': '部分无法连接',
						'topic.newTopic': '新话题',
					};
					return map[key] ?? key;
				},
				$route: { name: 'topics', params: {}, query: {} },
				$router: {
					push: vi.fn(),
					resolve: (to) => ({
						path: typeof to === 'string'
							? to
							: to.name === 'topics-chat'
								? `/topics/${to.params?.sessionId ?? ''}`
								: `/chat/${to.params?.clawId ?? ''}/${to.params?.agentId ?? ''}`,
					}),
				},
			},
		},
	});
}

test('should not apply scroll classes by default', () => {
	const wrapper = createWrapper();
	const root = wrapper.find('div');
	expect(root.classes()).not.toContain('overflow-auto');
	expect(root.classes()).not.toContain('overscroll-contain');
});

test('should apply scroll classes when scrollable prop is true', () => {
	const wrapper = createWrapper({ scrollable: true });
	const root = wrapper.find('div');
	expect(root.classes()).toContain('overflow-auto');
	expect(root.classes()).toContain('overscroll-contain');
});

test('should show only add-claw in Group 1 on narrow screen (default)', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	expect(wrapper.text()).toContain('添加机器人');
	expect(wrapper.text()).not.toContain('管理机器人');
	// Group 0 = Web Agent 入口；Group 1 = clawActionItems。Group 1 现在永远在 Group 0 之下，
	// 始终保留 mt-3 间距
	const group1Nav = wrapper.findAll('nav').at(1);
	expect(group1Nav.classes()).toContain('mt-3');
});

test('should show add-claw and manage-bots in Group 1 when scrollable (sidebar)', async () => {
	const wrapper = createWrapper({ scrollable: true });
	await vi.dynamicImportSettled();

	expect(wrapper.text()).toContain('添加机器人');
	expect(wrapper.text()).toContain('管理机器人');
	// 侧边栏下 Group 0 hug 顶部（无 mt-3），Group 1 仍带 mt-3 与 Group 0 留出间距
	const group0Nav = wrapper.findAll('nav').at(0);
	expect(group0Nav.classes()).not.toContain('mt-3');
	const group1Nav = wrapper.findAll('nav').at(1);
	expect(group1Nav.classes()).toContain('mt-3');
});

test('should not show label text or empty state text when lists are empty', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	// 不应显示分组标签和空状态提示
	expect(wrapper.text()).not.toContain('layout.commonClaws');
	expect(wrapper.text()).not.toContain('layout.sessions');
	expect(wrapper.text()).not.toContain('layout.noClaws');
	expect(wrapper.text()).not.toContain('layout.emptySession');
});

test('should render topic items from topics store', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const topicsStore = useTopicsStore();
	topicsStore.byId = toById([
		{ topicId: 't1', agentId: 'main', title: '话题一', createdAt: 2000, clawId: 'b1' },
		{ topicId: 't2', agentId: 'main', title: null, createdAt: 1000, clawId: 'b1' },
	]);
	await wrapper.vm.$nextTick();

	expect(wrapper.text()).toContain('话题一');
	// title 为 null 的 topic 显示"新话题"
	expect(wrapper.text()).toContain('新话题');
});

test('should sort topics by createdAt desc', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const topicsStore = useTopicsStore();
	topicsStore.byId = toById([
		{ topicId: 't-old', agentId: 'main', title: 'Old', createdAt: 100, clawId: 'b1' },
		{ topicId: 't-new', agentId: 'main', title: 'New', createdAt: 200, clawId: 'b1' },
	]);
	await wrapper.vm.$nextTick();

	const items = wrapper.vm.topicItems;
	expect(items[0].id).toBe('t-new');
	expect(items[1].id).toBe('t-old');
});

test('topic items should navigate to topics-chat route', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const topicsStore = useTopicsStore();
	topicsStore.byId = toById([
		{ topicId: 't1', agentId: 'main', title: 'Topic', createdAt: 100, clawId: 'b1' },
	]);
	await wrapper.vm.$nextTick();

	const items = wrapper.vm.topicItems;
	expect(items[0].to).toEqual({ name: 'topics-chat', params: { sessionId: 't1' } });
});

test('bot item should navigate to chat with clawId/agentId params', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const clawsStore = useClawsStore();
	clawsStore.setClaws([{ id: 'b1', name: 'MyBot', online: true }]);
	await wrapper.vm.$nextTick();

	const agentItem = wrapper.vm.agentItems[0];
	expect(agentItem.to).toEqual({ name: 'chat', params: { clawId: 'b1', agentId: 'main' } });
});

test('bot item always navigates to chat route (no fallback needed)', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const clawsStore = useClawsStore();
	clawsStore.setClaws([{ id: 'b1', name: 'MyBot', online: true }]);
	await wrapper.vm.$nextTick();

	const agentItem = wrapper.vm.agentItems[0];
	expect(agentItem.to).toEqual({ name: 'chat', params: { clawId: 'b1', agentId: 'main' } });
});

test('topic with title should display the title', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const topicsStore = useTopicsStore();
	topicsStore.byId = toById([
		{ topicId: 't1', agentId: 'main', title: '自定义标题', createdAt: 100, clawId: 'b1' },
	]);
	await wrapper.vm.$nextTick();

	expect(wrapper.text()).toContain('自定义标题');
});

test('topic without title should show untitled', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const topicsStore = useTopicsStore();
	topicsStore.byId = toById([
		{ topicId: 't1', agentId: 'main', title: null, createdAt: 100, clawId: 'b1' },
	]);
	await wrapper.vm.$nextTick();

	expect(wrapper.text()).toContain('新话题');
});

test('agent item should NOT be active on topic route', async () => {
	const pinia = createPinia();
	setActivePinia(pinia);
	const wrapper = mount(MainList, {
		props: { currentPath: '/topics/t-uuid' },
		global: {
			plugins: [pinia],
			stubs: { RouterLink: RouterLinkStub, UIcon: UIconStub, UButton: UButtonStub, TopicItemActions: { template: '<div />' }, AgentItemActions: { template: '<div />' } },
			mocks: {
				$t: (key) => ({ 'layout.addClaw': '添加机器人', 'topic.newTopic': '新话题' }[key] ?? key),
				$route: { name: 'topics-chat', params: { sessionId: 't-uuid' }, query: {} },
				$router: { resolve: (to) => ({ path: typeof to === 'string' ? to : `/topics/${to.params?.sessionId ?? ''}` }) },
			},
		},
	});
	await vi.dynamicImportSettled();

	const clawsStore = useClawsStore();
	clawsStore.setClaws([{ id: 'b1', name: 'Bot', online: true }]);
	await wrapper.vm.$nextTick();

	// 在 topic 路由下，agent item 不应被高亮
	const agentItem = wrapper.vm.agentItems[0];
	expect(agentItem.active).toBe(false);
});

test('agent item should be active on main session route', async () => {
	const pinia = createPinia();
	setActivePinia(pinia);
	const wrapper = mount(MainList, {
		props: { currentPath: '/chat/b1/main' },
		global: {
			plugins: [pinia],
			stubs: { RouterLink: RouterLinkStub, UIcon: UIconStub, UButton: UButtonStub, TopicItemActions: { template: '<div />' }, AgentItemActions: { template: '<div />' } },
			mocks: {
				$t: (key) => ({ 'layout.addClaw': '添加机器人', 'topic.newTopic': '新话题' }[key] ?? key),
				$route: { name: 'chat', params: { clawId: 'b1', agentId: 'main' }, query: {} },
				$router: { resolve: (to) => ({ path: typeof to === 'string' ? to : `/chat/${to.params?.clawId ?? ''}/${to.params?.agentId ?? ''}` }) },
			},
		},
	});
	await vi.dynamicImportSettled();

	const clawsStore = useClawsStore();
	clawsStore.setClaws([{ id: 'b1', name: 'Bot', online: true }]);
	await wrapper.vm.$nextTick();

	// 在 main session 路由下，agent item 应被高亮
	const agentItem = wrapper.vm.agentItems[0];
	expect(agentItem.active).toBe(true);
});

test('topic icon should show agent initial when no avatar', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const topicsStore = useTopicsStore();
	topicsStore.byId = toById([
		{ topicId: 't1', agentId: 'main', title: 'Test', createdAt: 100, clawId: 'b1' },
	]);
	await wrapper.vm.$nextTick();

	// Group 0=Web Agent 入口, 1=clawActions, 2=agents, 3=topics（无最近 Web Agent 时）
	const topicNav = wrapper.findAll('nav').at(3); // Group 3
	const icon = topicNav.find('.rounded-full');
	// agent display name defaults to agentId 'main' → initial 'M'
	expect(icon.text()).toBe('M');
});

// --- showCapHeader 相关测试 ---

test('should NOT show cap header when not in Capacitor', async () => {
	__mockIsCapacitorApp = false;
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	expect(wrapper.vm.showCapHeader).toBeFalsy();
	expect(wrapper.text()).not.toContain('CoClaw');
});

test('should show cap header when Capacitor + ltMd', async () => {
	__mockIsCapacitorApp = true;
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	// 模拟 envStore.screen.ltMd 为 true
	wrapper.vm.envStore = { screen: { ltMd: ref(true) } };
	await wrapper.vm.$nextTick();

	expect(wrapper.vm.showCapHeader).toBe(true);
	expect(wrapper.text()).toContain('CoClaw');
	// 应有"+"按钮
	expect(wrapper.find('.u-button-stub').exists()).toBe(true);

	__mockIsCapacitorApp = false;
});

test('should NOT show cap header when Capacitor + geMd (landscape/tablet)', async () => {
	__mockIsCapacitorApp = true;
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	// 模拟 envStore.screen.ltMd 为 false（横屏/平板）
	wrapper.vm.envStore = { screen: { ltMd: ref(false) } };
	await wrapper.vm.$nextTick();

	expect(wrapper.vm.showCapHeader).toBe(false);

	__mockIsCapacitorApp = false;
});

test('cap header "+" button should navigate to /bots/add', async () => {
	__mockIsCapacitorApp = true;
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	wrapper.vm.envStore = { screen: { ltMd: ref(true) } };
	await wrapper.vm.$nextTick();

	await wrapper.find('.u-button-stub').trigger('click');
	expect(wrapper.vm.$router.push).toHaveBeenCalledWith('/claws/add');

	__mockIsCapacitorApp = false;
});

test('should hide Group 1 add-claw item when capHeader active and bots exist', async () => {
	__mockIsCapacitorApp = true;
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	wrapper.vm.envStore = { screen: { ltMd: ref(true) } };

	const clawsStore = useClawsStore();
	clawsStore.fetched = true;
	clawsStore.setClaws([{ id: 'b1', name: 'Bot', online: true }]);
	await wrapper.vm.$nextTick();

	expect(wrapper.vm.showCapHeader).toBe(true);
	expect(wrapper.vm.clawActionItems).toEqual([]);

	__mockIsCapacitorApp = false;
});

test('should show Group 1 add-claw item when capHeader active and no bots', async () => {
	__mockIsCapacitorApp = true;
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	wrapper.vm.envStore = { screen: { ltMd: ref(true) } };

	const clawsStore = useClawsStore();
	clawsStore.fetched = true;
	clawsStore.setClaws([]);
	await wrapper.vm.$nextTick();

	expect(wrapper.vm.showCapHeader).toBe(true);
	expect(wrapper.vm.clawActionItems.length).toBe(1);
	expect(wrapper.vm.clawActionItems[0].id).toBe('add-claw');

	__mockIsCapacitorApp = false;
});

test('should hide Group 1 add-claw item when capHeader active and bots not yet fetched', async () => {
	__mockIsCapacitorApp = true;
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	wrapper.vm.envStore = { screen: { ltMd: ref(true) } };

	const clawsStore = useClawsStore();
	clawsStore.fetched = false;
	clawsStore.setClaws([]);
	await wrapper.vm.$nextTick();

	expect(wrapper.vm.showCapHeader).toBe(true);
	// 未 fetch 完成前不显示引导项
	expect(wrapper.vm.clawActionItems).toEqual([]);

	__mockIsCapacitorApp = false;
});

// --- RTC 连接状态图标 ---

async function mountCapHeader() {
	__mockIsCapacitorApp = true;
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();
	wrapper.vm.envStore = { screen: { ltMd: ref(true) } };
	await wrapper.vm.$nextTick();
	return wrapper;
}

function findSpinner(wrapper) {
	return wrapper.find('[data-testid="rtc-connecting"]');
}

function findWarnBtn(wrapper) {
	return wrapper.find('[data-testid="rtc-unreachable"]');
}

test('cap header 初始状态无 spinner / warning（无 claw）', async () => {
	const wrapper = await mountCapHeader();
	expect(findSpinner(wrapper).exists()).toBe(false);
	expect(findWarnBtn(wrapper).exists()).toBe(false);
});

test('任一 online claw 处于 building → DOM 出现 spinner，无 warning', async () => {
	const wrapper = await mountCapHeader();
	const clawsStore = useClawsStore();
	clawsStore.setClaws([{ id: 'b1', name: 'Bot', online: true }]);
	clawsStore.byId['b1'].rtcPhase = 'building';
	await wrapper.vm.$nextTick();

	expect(findSpinner(wrapper).exists()).toBe(true);
	expect(findWarnBtn(wrapper).exists()).toBe(false);
});

test('failed + retryNextAt>0 → DOM 出现 spinner（系统还在排退避）', async () => {
	const wrapper = await mountCapHeader();
	const clawsStore = useClawsStore();
	clawsStore.setClaws([{ id: 'b1', name: 'Bot', online: true }]);
	clawsStore.byId['b1'].rtcPhase = 'failed';
	clawsStore.byId['b1'].retryNextAt = Date.now() + 5000;
	await wrapper.vm.$nextTick();

	expect(findSpinner(wrapper).exists()).toBe(true);
	expect(findWarnBtn(wrapper).exists()).toBe(false);
});

test('failed + retryNextAt=0 → DOM 出现 warning，无 spinner', async () => {
	const wrapper = await mountCapHeader();
	const clawsStore = useClawsStore();
	clawsStore.setClaws([{ id: 'b1', name: 'Bot', online: true }]);
	clawsStore.byId['b1'].rtcPhase = 'failed';
	clawsStore.byId['b1'].retryNextAt = 0;
	await wrapper.vm.$nextTick();

	expect(findSpinner(wrapper).exists()).toBe(false);
	expect(findWarnBtn(wrapper).exists()).toBe(true);
});

test('同时存在 building 与 failed-exhausted → DOM 优先渲染 spinner', async () => {
	const wrapper = await mountCapHeader();
	const clawsStore = useClawsStore();
	clawsStore.setClaws([
		{ id: 'b1', name: 'Bot1', online: true },
		{ id: 'b2', name: 'Bot2', online: true },
	]);
	clawsStore.byId['b1'].rtcPhase = 'building';
	clawsStore.byId['b2'].rtcPhase = 'failed';
	clawsStore.byId['b2'].retryNextAt = 0;
	await wrapper.vm.$nextTick();

	// v-else-if 模板层保证互斥：两个状态都为 true 时 spinner 优先渲染
	expect(findSpinner(wrapper).exists()).toBe(true);
	expect(findWarnBtn(wrapper).exists()).toBe(false);
});

test('offline 的 failed claw 不渲染任何图标', async () => {
	const wrapper = await mountCapHeader();
	const clawsStore = useClawsStore();
	clawsStore.setClaws([{ id: 'b1', name: 'Bot', online: false }]);
	clawsStore.byId['b1'].rtcPhase = 'failed';
	clawsStore.byId['b1'].retryNextAt = 0;
	await wrapper.vm.$nextTick();

	expect(findSpinner(wrapper).exists()).toBe(false);
	expect(findWarnBtn(wrapper).exists()).toBe(false);
});

test('点击告警按钮触发 manualRetryUnreachable', async () => {
	const wrapper = await mountCapHeader();
	const clawsStore = useClawsStore();
	clawsStore.setClaws([{ id: 'b1', name: 'Bot', online: true }]);
	clawsStore.byId['b1'].rtcPhase = 'failed';
	clawsStore.byId['b1'].retryNextAt = 0;
	await wrapper.vm.$nextTick();

	const spy = vi.spyOn(clawsStore, 'manualRetryUnreachable').mockImplementation(() => {});
	await findWarnBtn(wrapper).trigger('click');

	expect(spy).toHaveBeenCalledTimes(1);
});

// --- Agent items：label 拼装 / 排序 / 多 claw 行为 ---

/** 在 agentsStore 内手填 agent 列表，避开 RPC 路径 */
function seedAgents(clawId, agents, defaultId = 'main') {
	const agentsStore = useAgentsStore();
	agentsStore.byClaw[String(clawId)] = {
		agents: agents.map((a) => (typeof a === 'string' ? { id: a } : a)),
		defaultId,
		loading: false,
		fetched: true,
	};
}

test('单 claw：label 仅显示 agentName，无 @clawName 后缀', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	useClawsStore().setClaws([{ id: 'b1', name: 'MyClaw', online: true }]);
	seedAgents('b1', [{ id: 'main', resolvedIdentity: { name: 'Helper' } }]);
	await wrapper.vm.$nextTick();

	const items = wrapper.vm.agentItems;
	expect(items).toHaveLength(1);
	expect(items[0].agentName).toBe('Helper');
	expect(items[0].clawName).toBeNull();
});

test('多 claw：label 拼成 agentName + @clawName', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	useClawsStore().setClaws([
		{ id: 'b1', name: 'Alpha', online: true },
		{ id: 'b2', name: 'Beta', online: true },
	]);
	seedAgents('b1', [{ id: 'main', resolvedIdentity: { name: 'Helper' } }]);
	seedAgents('b2', [{ id: 'main', resolvedIdentity: { name: 'Helper' } }]);
	await wrapper.vm.$nextTick();

	const items = wrapper.vm.agentItems;
	expect(items).toHaveLength(2);
	const it1 = items.find((i) => i.id === 'b1:main');
	expect(it1.agentName).toBe('Helper');
	expect(it1.clawName).toBe('Alpha');
});

test('多 claw：当 agentName 与 clawName 同名时丢弃后缀，避免 "Alpha@Alpha"', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	useClawsStore().setClaws([
		{ id: 'b1', name: 'Alpha', online: true },
		{ id: 'b2', name: 'Beta', online: true },
	]);
	// 默认 agent 无 identity → agentDisplay 会让 agentName fallback 到 clawName
	seedAgents('b1', ['main']);
	seedAgents('b2', ['main']);
	await wrapper.vm.$nextTick();

	const items = wrapper.vm.agentItems;
	const it1 = items.find((i) => i.id === 'b1:main');
	expect(it1.agentName).toBe('Alpha');
	expect(it1.clawName).toBeNull();
});

test('agent 列表跨 claw 平面混排（不再按 claw 分组）', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	useClawsStore().setClaws([
		{ id: 'b1', name: 'Alpha', online: true },
		{ id: 'b2', name: 'Beta', online: true },
	]);
	seedAgents('b1', ['main']);
	seedAgents('b2', ['main']);
	const sessionsStore = useSessionsStore();
	// 让 b2:main 比 b1:main 更新 → 应排在 b1:main 之前
	sessionsStore.setSessions([
		{ sessionId: 'sa', sessionKey: 'agent:main:main', clawId: 'b1', agentId: 'main', updatedAt: 100, bumpedAt: null },
		{ sessionId: 'sb', sessionKey: 'agent:main:main', clawId: 'b2', agentId: 'main', updatedAt: 999, bumpedAt: null },
	]);
	await wrapper.vm.$nextTick();

	const items = wrapper.vm.agentItems;
	expect(items.map((i) => i.id)).toEqual(['b2:main', 'b1:main']);
});

test('agentItems 按 max(updatedAt, bumpedAt) 降序排', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	useClawsStore().setClaws([{ id: 'b1', name: 'B1', online: true }]);
	seedAgents('b1', ['alpha', 'beta', 'gamma']);
	useSessionsStore().setSessions([
		{ sessionId: 's1', sessionKey: 'agent:alpha:main', clawId: 'b1', agentId: 'alpha', updatedAt: 100, bumpedAt: 5000 },
		{ sessionId: 's2', sessionKey: 'agent:beta:main', clawId: 'b1', agentId: 'beta', updatedAt: 8000, bumpedAt: null },
		{ sessionId: 's3', sessionKey: 'agent:gamma:main', clawId: 'b1', agentId: 'gamma', updatedAt: null, bumpedAt: 3000 },
	]);
	await wrapper.vm.$nextTick();

	const items = wrapper.vm.agentItems;
	// 排序：beta(8000) > alpha(5000) > gamma(3000)
	expect(items.map((i) => i.id)).toEqual(['b1:beta', 'b1:alpha', 'b1:gamma']);
});

test('无活动的 agent 落底部，按 agents.list 自然顺序兜底', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	useClawsStore().setClaws([{ id: 'b1', name: 'B1', online: true }]);
	// 自然顺序：first → second → third
	seedAgents('b1', ['first', 'second', 'third']);
	// 只 second 有活动；first / third 都 0 → 应保持声明顺序在底部
	useSessionsStore().setSessions([
		{ sessionId: 's', sessionKey: 'agent:second:main', clawId: 'b1', agentId: 'second', updatedAt: 1, bumpedAt: null },
	]);
	await wrapper.vm.$nextTick();

	const items = wrapper.vm.agentItems;
	expect(items.map((i) => i.id)).toEqual(['b1:second', 'b1:first', 'b1:third']);
});

test('fallback：claw 未连/未加载 agents 时仍显示一个条目（label 单段、无 @）', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	useClawsStore().setClaws([
		{ id: 'b1', name: 'Alpha', online: true },
		{ id: 'b2', name: 'Beta', online: false }, // 离线，未 seed agents
	]);
	seedAgents('b1', ['main']);
	await wrapper.vm.$nextTick();

	const fallback = wrapper.vm.agentItems.find((i) => i.id === 'b2');
	expect(fallback).toBeTruthy();
	expect(fallback.agentName).toBe('Beta');
	expect(fallback.clawName).toBeNull();
});

test('label DOM：多 claw 时渲染 agent + @ + claw 三段，"@" 用 shrink-0', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	useClawsStore().setClaws([
		{ id: 'b1', name: 'Alpha', online: true },
		{ id: 'b2', name: 'Beta', online: true },
	]);
	// 用 identity 给 agent 一个独立显示名，避免与 clawName 重复被去重
	seedAgents('b1', [{ id: 'main', resolvedIdentity: { name: 'Helper' } }]);
	seedAgents('b2', [{ id: 'main', resolvedIdentity: { name: 'Helper' } }]);
	await wrapper.vm.$nextTick();

	// nav 顺序：0=Web Agent 入口, 1=clawActions, 2=agents
	const agentNav = wrapper.findAll('nav').at(2);
	const links = agentNav.findAll('a');
	expect(links.length).toBe(2);

	// 每个 link 的 label 容器内应有：agent span + '@' span + claw span
	for (const link of links) {
		const labelHost = link.find('span.flex.flex-1');
		expect(labelHost.exists()).toBe(true);
		const segments = labelHost.findAll('span');
		// segments 包含 labelHost 自身吗？findAll 不含 root
		// 期望 3 段：agent / @ / claw
		expect(segments.length).toBe(3);
		// '@' 段拥有 shrink-0
		const atSeg = segments.find((s) => s.text() === '@');
		expect(atSeg).toBeTruthy();
		expect(atSeg.classes()).toContain('shrink-0');
		// '@' 用 text-muted 弱化
		expect(atSeg.classes()).toContain('text-muted');
		// agent / claw 段都带 truncate
		const truncated = segments.filter((s) => s.classes().includes('truncate'));
		expect(truncated.length).toBe(2);
		// clawName 段（最后一个 truncate）也带 text-muted；agentName 不带
		const agentSeg = segments[0];
		const clawSeg = segments[2];
		expect(agentSeg.classes()).not.toContain('text-muted');
		expect(clawSeg.classes()).toContain('text-muted');
	}
});

test('label DOM：单 claw 时不渲染 "@" 段', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	useClawsStore().setClaws([{ id: 'b1', name: 'Solo', online: true }]);
	seedAgents('b1', ['main']);
	await wrapper.vm.$nextTick();

	const agentNav = wrapper.findAll('nav').at(2);
	const link = agentNav.find('a');
	expect(link.text()).not.toContain('@');
});

// --- AgentItemActions 集成契约 ---

test('agentItems 暴露 clawId/agentId 字段供 actions 组件使用：在线分支用真实 agent.id', async () => {
	// 钉死：未来若有人重构 computed 但忘了带这两个字段，AgentItemActions 会拿到 undefined props
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	useClawsStore().setClaws([{ id: 'b1', name: 'Alpha', online: true }]);
	seedAgents('b1', [{ id: 'helper-2', resolvedIdentity: { name: 'H2' } }]);
	await wrapper.vm.$nextTick();

	const item = wrapper.vm.agentItems.find((i) => i.id === 'b1:helper-2');
	expect(item.clawId).toBe('b1');
	expect(item.agentId).toBe('helper-2');
});

test('agentItems 暴露 clawId/agentId 字段供 actions 组件使用：fallback 分支硬编码 main', async () => {
	// 钉死 fallback 契约：claw 未连/未加载 agents 时，actions 用 'main' 兜底（与 RouterLink 路由保持一致）
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	useClawsStore().setClaws([{ id: 'b1', name: 'Offline', online: false }]);
	// 不 seed agents → 走 fallback 分支
	await wrapper.vm.$nextTick();

	const item = wrapper.vm.agentItems[0];
	expect(item.id).toBe('b1');
	expect(item.clawId).toBe('b1');
	expect(item.agentId).toBe('main');
});

test('AgentItemActions 渲染为 RouterLink 的 sibling，不能嵌套在 RouterLink 内', async () => {
	// 钉死结构性不变量：嵌套进去会导致点 actions 触发行级导航（用户感知 = "点菜单按钮还跳转了"）
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	useClawsStore().setClaws([{ id: 'b1', name: 'Solo', online: true }]);
	seedAgents('b1', ['main']);
	await wrapper.vm.$nextTick();

	const agentNav = wrapper.findAll('nav').at(2);
	const link = agentNav.find('a');
	const stub = agentNav.find('.agent-actions-stub');
	expect(link.exists()).toBe(true);
	expect(stub.exists()).toBe(true);
	// 关键：actions stub 不在 link 子树里
	expect(link.find('.agent-actions-stub').exists()).toBe(false);
});

// --- Web Agent 顶部入口与最近使用分组 ---

test('Web Agent entry：永远渲染在顶部，点击触发 openPickerDialog', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const entry = wrapper.find('[data-testid="web-agent-entry"]');
	expect(entry.exists()).toBe(true);
	// nav[0] 即 Web Agent 入口所在的 nav
	const group0 = wrapper.findAll('nav').at(0);
	expect(group0.find('[data-testid="web-agent-entry"]').exists()).toBe(true);

	__openPickerDialogMock.mockClear();
	await entry.trigger('click');
	expect(__openPickerDialogMock).toHaveBeenCalledTimes(1);
});

test('Web Agents 最近使用分组：lastClickedAt 全为 null 时不渲染容器', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const store = useWebAgentsStore();
	store.items = [
		{ id: 1, slug: 'deepseek', name: 'DeepSeek', url: 'u', sort: 1, lastClickedAt: null },
		{ id: 2, slug: 'doubao', name: '豆包', url: 'u', sort: 2, lastClickedAt: null },
	];
	await wrapper.vm.$nextTick();

	expect(wrapper.find('[data-testid="web-agent-section-recent"]').exists()).toBe(false);
});

test('Web Agents 最近使用分组：按 lastClickedAt DESC 渲染并暴露 web-agent-recent-${slug}', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const store = useWebAgentsStore();
	store.items = [
		{ id: 1, slug: 'deepseek', name: 'DeepSeek', url: 'u1', sort: 1, lastClickedAt: '2026-05-01T10:00:00Z' },
		{ id: 2, slug: 'doubao', name: '豆包', url: 'u2', sort: 2, lastClickedAt: '2026-05-03T10:00:00Z' },
		{ id: 3, slug: 'qwen', name: '千问', url: 'u3', sort: 3, lastClickedAt: null },
	];
	await wrapper.vm.$nextTick();

	const section = wrapper.find('[data-testid="web-agent-section-recent"]');
	expect(section.exists()).toBe(true);
	const items = section.findAll('button');
	expect(items.length).toBe(2);
	expect(items[0].attributes('data-testid')).toBe('web-agent-recent-doubao');
	expect(items[1].attributes('data-testid')).toBe('web-agent-recent-deepseek');
});

test('Web Agents 最近使用分组：点击触发 recordClick + openExternalUrl', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const store = useWebAgentsStore();
	store.items = [
		{ id: 7, slug: 'kimi', name: 'Kimi', url: 'https://www.kimi.com/', sort: 4, lastClickedAt: '2026-05-05T10:00:00Z' },
	];
	const recordSpy = vi.spyOn(store, 'recordClick').mockImplementation(() => {});
	await wrapper.vm.$nextTick();

	__openExternalUrlMock.mockClear();
	const item = wrapper.find('[data-testid="web-agent-recent-kimi"]');
	expect(item.exists()).toBe(true);
	await item.trigger('click');

	expect(recordSpy).toHaveBeenCalledWith(7);
	expect(__openExternalUrlMock).toHaveBeenCalledWith('https://www.kimi.com/');
});

test('点击最近项 → 真实 store 乐观更新使该项立刻置顶（不依赖网络）', async () => {
	// 全链路验证：点击 → recordClick 写本地 lastClickedAt → recentlyClicked 重排 → DOM 顺序变化
	__webAgentsApiMock.recordWebAgentClick.mockClear();
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const store = useWebAgentsStore();
	store.items = [
		{ id: 1, slug: 'deepseek', name: 'DeepSeek', url: 'u1', sort: 1, lastClickedAt: '2026-05-01T10:00:00Z' },
		{ id: 2, slug: 'doubao', name: '豆包', url: 'u2', sort: 2, lastClickedAt: '2026-05-03T10:00:00Z' },
	];
	await wrapper.vm.$nextTick();

	// 初始顺序：豆包（2026-05-03）领先 DeepSeek（2026-05-01）
	let order = wrapper.findAll('[data-testid^="web-agent-recent-"]').map((b) => b.attributes('data-testid'));
	expect(order).toEqual(['web-agent-recent-doubao', 'web-agent-recent-deepseek']);

	// 点 DeepSeek → store.recordClick 走真实路径写新 lastClickedAt（值为 new Date().toISOString()，必 > 历史）
	await wrapper.find('[data-testid="web-agent-recent-deepseek"]').trigger('click');
	await wrapper.vm.$nextTick();

	order = wrapper.findAll('[data-testid^="web-agent-recent-"]').map((b) => b.attributes('data-testid'));
	expect(order[0]).toBe('web-agent-recent-deepseek');
	// fire-and-forget 也确实把 POST 委托给了 api 层
	expect(__webAgentsApiMock.recordWebAgentClick).toHaveBeenCalledWith(1);
});

test('mounted 时调用 webAgentsStore.loadAll()', async () => {
	const pinia = createPinia();
	setActivePinia(pinia);
	// 提前装好 spy，挂载时即可拦截
	const store = useWebAgentsStore();
	const spy = vi.spyOn(store, 'loadAll').mockResolvedValue();

	mount(MainList, {
		props: { currentPath: '/topics' },
		global: {
			plugins: [pinia],
			stubs: {
				RouterLink: RouterLinkStub,
				UIcon: UIconStub,
				UButton: UButtonStub,
				TopicItemActions: { template: '<div />' },
				AgentItemActions: { template: '<div />' },
			},
			mocks: {
				$t: (k) => k,
				$route: { name: 'topics', params: {}, query: {} },
				$router: { resolve: (to) => ({ path: typeof to === 'string' ? to : '/' }) },
			},
		},
	});
	await vi.dynamicImportSettled();

	expect(spy).toHaveBeenCalled();
});
