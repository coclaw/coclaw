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
	hideWebAgent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/web-agents.api.js', () => __webAgentsApiMock);

// webAgentsStore.recordClick / hide 现在依赖登录态；MainList 测试关心列表行为，统一 mock 成已登录
const __mockAuth = vi.hoisted(() => ({ user: { id: 1n, loginName: 'tester' } }));
vi.mock('../stores/auth.store.js', () => ({
	useAuthStore: () => __mockAuth,
}));

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
	// auth.store 间接拉 capacitor-app.js → platform.isMobileOs（jsdom 下默认 false 即可）
	isMobileOs: false,
	isNativeShell: false,
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

vi.mock('./WebAgentItemActions.vue', () => ({
	default: { name: 'WebAgentItemActions', template: '<div class="web-agent-actions-stub" />', props: ['webAgentId'] },
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

// UPopover stub：永远渲染 trigger 与 content（默认折叠状态由父组件 v-model 决定，
// 测试关心的是 content 内菜单项是否点击有效，因此都暴露在 DOM 中以便点击）
const UPopoverStub = {
	props: ['open', 'content'],
	emits: ['update:open'],
	template: `
		<div class="u-popover-stub">
			<div class="u-popover-trigger"><slot /></div>
			<div class="u-popover-content"><slot name="content" /></div>
		</div>
	`,
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
				UPopover: UPopoverStub,
				TopicItemActions: { template: '<div class="topic-actions-stub" />' },
				AgentItemActions: { template: '<div class="agent-actions-stub" />' },
				WebAgentItemActions: { template: '<div class="web-agent-actions-stub" />' },
			},
			mocks: {
				$t: (key) => {
					const map = {
						'layout.addClaw': '添加 Claw',
						'layout.addWebAgent': '添加 Web Agent',
						'layout.addEntry': '添加',
						'layout.manageClaws': '我的 Claw',
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

// --- 顶部 / 底部 actions 组 ---

test('topActionItems 仅在 scrollable=true（桌面侧边栏）下显示"我的 Claw"', async () => {
	const wrapper = createWrapper({ scrollable: true });
	await vi.dynamicImportSettled();

	expect(wrapper.vm.topActionItems.length).toBe(1);
	expect(wrapper.vm.topActionItems[0].id).toBe('manage-claws');
	expect(wrapper.text()).toContain('我的 Claw');
});

test('topActionItems 在非 scrollable 下为空（窄屏 / Capacitor）', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	expect(wrapper.vm.topActionItems).toEqual([]);
});

test('bottomActionItems 始终渲染添加 Claw + 添加 Web Agent 两项（非 scrollable）', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const ids = wrapper.findAll('[data-testid^="bottom-action-"]').map((b) => b.attributes('data-testid'));
	expect(ids).toEqual(['bottom-action-add-claw', 'bottom-action-add-web-agent']);
	expect(wrapper.text()).toContain('添加 Claw');
	expect(wrapper.text()).toContain('添加 Web Agent');
});

test('bottomActionItems 在 scrollable=true（桌面侧边栏）下也渲染', async () => {
	const wrapper = createWrapper({ scrollable: true });
	await vi.dynamicImportSettled();

	const ids = wrapper.findAll('[data-testid^="bottom-action-"]').map((b) => b.attributes('data-testid'));
	expect(ids).toEqual(['bottom-action-add-claw', 'bottom-action-add-web-agent']);
});

test('点击底部"添加 Claw" → router.push("/claws/add")', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	await wrapper.find('[data-testid="bottom-action-add-claw"]').trigger('click');
	expect(wrapper.vm.$router.push).toHaveBeenCalledWith('/claws/add');
});

test('点击底部"添加 Web Agent" → openPickerDialog 被调用', async () => {
	__openPickerDialogMock.mockClear();
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	await wrapper.find('[data-testid="bottom-action-add-web-agent"]').trigger('click');
	expect(__openPickerDialogMock).toHaveBeenCalledTimes(1);
});

// --- Capacitor header & 下拉菜单 ---

test('non-Capacitor 环境不显示 cap header', async () => {
	__mockIsCapacitorApp = false;
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	expect(wrapper.vm.showCapHeader).toBeFalsy();
	expect(wrapper.text()).not.toContain('CoClaw');
});

test('Capacitor + ltMd 显示 cap header（含 + 按钮触发器）', async () => {
	__mockIsCapacitorApp = true;
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	wrapper.vm.envStore = { screen: { ltMd: ref(true) } };
	await wrapper.vm.$nextTick();

	expect(wrapper.vm.showCapHeader).toBe(true);
	expect(wrapper.text()).toContain('CoClaw');
	expect(wrapper.find('[data-testid="cap-header-add-trigger"]').exists()).toBe(true);
});

test('Capacitor + 横屏（geMd）不显示 cap header', async () => {
	__mockIsCapacitorApp = true;
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	wrapper.vm.envStore = { screen: { ltMd: ref(false) } };
	await wrapper.vm.$nextTick();

	expect(wrapper.vm.showCapHeader).toBe(false);
});

test('cap header 下拉菜单：点击"添加 Claw" → router.push("/claws/add")', async () => {
	__mockIsCapacitorApp = true;
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	wrapper.vm.envStore = { screen: { ltMd: ref(true) } };
	await wrapper.vm.$nextTick();

	await wrapper.find('[data-testid="cap-header-add-add-claw"]').trigger('click');
	expect(wrapper.vm.$router.push).toHaveBeenCalledWith('/claws/add');
});

test('cap header 下拉菜单：点击"添加 Web Agent" → openPickerDialog', async () => {
	__openPickerDialogMock.mockClear();
	__mockIsCapacitorApp = true;
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	wrapper.vm.envStore = { screen: { ltMd: ref(true) } };
	await wrapper.vm.$nextTick();

	await wrapper.find('[data-testid="cap-header-add-add-web-agent"]').trigger('click');
	expect(__openPickerDialogMock).toHaveBeenCalledTimes(1);
});

test('cap header + 按钮 a11y：aria-haspopup=menu，aria-expanded 跟随 capAddMenuOpen', async () => {
	__mockIsCapacitorApp = true;
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();
	wrapper.vm.envStore = { screen: { ltMd: ref(true) } };
	await wrapper.vm.$nextTick();

	const trigger = wrapper.find('[data-testid="cap-header-add-trigger"]');
	expect(trigger.attributes('aria-haspopup')).toBe('menu');
	expect(trigger.attributes('aria-label')).toBe('添加');
	expect(trigger.attributes('aria-expanded')).toBe('false');

	wrapper.vm.capAddMenuOpen = true;
	await wrapper.vm.$nextTick();
	expect(wrapper.find('[data-testid="cap-header-add-trigger"]').attributes('aria-expanded')).toBe('true');
});

test('cap header 下拉菜单：点击菜单项后 capAddMenuOpen 自动复位为 false', async () => {
	__mockIsCapacitorApp = true;
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();
	wrapper.vm.envStore = { screen: { ltMd: ref(true) } };
	await wrapper.vm.$nextTick();

	wrapper.vm.capAddMenuOpen = true;
	await wrapper.vm.$nextTick();
	await wrapper.find('[data-testid="cap-header-add-add-claw"]').trigger('click');
	expect(wrapper.vm.capAddMenuOpen).toBe(false);
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

// --- Topic 列表 ---

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

test('topic icon should show agent initial when no avatar', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const topicsStore = useTopicsStore();
	topicsStore.byId = toById([
		{ topicId: 't1', agentId: 'main', title: 'Test', createdAt: 100, clawId: 'b1' },
	]);
	await wrapper.vm.$nextTick();

	// 找 topic 列表的 nav（顺序：mixedAgents → topics → bottomActions；
	// scrollable=false 下无 topActions 组）
	const topicNav = wrapper.findAll('nav').filter((n) => n.find('.topic-actions-stub').exists())[0];
	expect(topicNav).toBeTruthy();
	const icon = topicNav.find('.rounded-full');
	expect(icon.text()).toBe('M');
});

// --- Mixed agent list（claw + web agent 混排，按 last used 倒排）---

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

	const items = wrapper.vm.mixedAgentItems.filter((i) => i.type === 'claw');
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

	const items = wrapper.vm.mixedAgentItems.filter((i) => i.type === 'claw');
	expect(items).toHaveLength(2);
	const it1 = items.find((i) => i.id === 'claw:b1:main');
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
	seedAgents('b1', ['main']);
	seedAgents('b2', ['main']);
	await wrapper.vm.$nextTick();

	const items = wrapper.vm.mixedAgentItems.filter((i) => i.type === 'claw');
	const it1 = items.find((i) => i.id === 'claw:b1:main');
	expect(it1.agentName).toBe('Alpha');
	expect(it1.clawName).toBeNull();
});

test('claw agent 跨 claw 平面混排（不再按 claw 分组）', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	useClawsStore().setClaws([
		{ id: 'b1', name: 'Alpha', online: true },
		{ id: 'b2', name: 'Beta', online: true },
	]);
	seedAgents('b1', ['main']);
	seedAgents('b2', ['main']);
	const sessionsStore = useSessionsStore();
	sessionsStore.setSessions([
		{ sessionId: 'sa', sessionKey: 'agent:main:main', clawId: 'b1', agentId: 'main', updatedAt: 100, bumpedAt: null },
		{ sessionId: 'sb', sessionKey: 'agent:main:main', clawId: 'b2', agentId: 'main', updatedAt: 999, bumpedAt: null },
	]);
	await wrapper.vm.$nextTick();

	const items = wrapper.vm.mixedAgentItems;
	expect(items.map((i) => i.id)).toEqual(['claw:b2:main', 'claw:b1:main']);
});

test('mixedAgentItems：claw + web 按 last used 倒排混排', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	useClawsStore().setClaws([{ id: 'b1', name: 'Alpha', online: true }]);
	seedAgents('b1', ['main']);
	useSessionsStore().setSessions([
		// claw agent 活动时间 2026-05-02 10:00 UTC
		{ sessionId: 's1', sessionKey: 'agent:main:main', clawId: 'b1', agentId: 'main', updatedAt: new Date('2026-05-02T10:00:00Z').getTime(), bumpedAt: null },
	]);
	const webStore = useWebAgentsStore();
	webStore.items = [
		// web agent 1 比 claw 新（2026-05-04），应排第一
		{ id: 11, slug: 'doubao', name: '豆包', url: 'u1', sort: 1, lastClickedAt: '2026-05-04T10:00:00Z', hiddenAt: null },
		// web agent 2 比 claw 旧（2026-05-01），应排末尾
		{ id: 12, slug: 'kimi', name: 'Kimi', url: 'u2', sort: 2, lastClickedAt: '2026-05-01T10:00:00Z', hiddenAt: null },
	];
	await wrapper.vm.$nextTick();

	const ids = wrapper.vm.mixedAgentItems.map((i) => i.id);
	expect(ids).toEqual(['web:11', 'claw:b1:main', 'web:12']);
});

test('mixedAgentItems：claw agent 按 max(updatedAt, bumpedAt) 降序排', async () => {
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

	const items = wrapper.vm.mixedAgentItems;
	expect(items.map((i) => i.id)).toEqual(['claw:b1:beta', 'claw:b1:alpha', 'claw:b1:gamma']);
});

test('无活动的 claw agent 落底部，按声明顺序兜底', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	useClawsStore().setClaws([{ id: 'b1', name: 'B1', online: true }]);
	seedAgents('b1', ['first', 'second', 'third']);
	useSessionsStore().setSessions([
		{ sessionId: 's', sessionKey: 'agent:second:main', clawId: 'b1', agentId: 'second', updatedAt: 1, bumpedAt: null },
	]);
	await wrapper.vm.$nextTick();

	const items = wrapper.vm.mixedAgentItems;
	expect(items.map((i) => i.id)).toEqual(['claw:b1:second', 'claw:b1:first', 'claw:b1:third']);
});

test('fallback：claw 未连/未加载 agents 时仍显示一个条目（label 单段、无 @）', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	useClawsStore().setClaws([
		{ id: 'b1', name: 'Alpha', online: true },
		{ id: 'b2', name: 'Beta', online: false },
	]);
	seedAgents('b1', ['main']);
	await wrapper.vm.$nextTick();

	const fallback = wrapper.vm.mixedAgentItems.find((i) => i.id === 'claw:b2:main');
	expect(fallback).toBeTruthy();
	expect(fallback.agentName).toBe('Beta');
	expect(fallback.clawName).toBeNull();
});

test('claw item 暴露 clawId/agentId 字段供 actions 组件使用：在线分支用真实 agent.id', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	useClawsStore().setClaws([{ id: 'b1', name: 'Alpha', online: true }]);
	seedAgents('b1', [{ id: 'helper-2', resolvedIdentity: { name: 'H2' } }]);
	await wrapper.vm.$nextTick();

	const item = wrapper.vm.mixedAgentItems.find((i) => i.id === 'claw:b1:helper-2');
	expect(item.clawId).toBe('b1');
	expect(item.agentId).toBe('helper-2');
});

test('claw item 暴露 clawId/agentId 字段供 actions 组件使用：fallback 分支硬编码 main', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	useClawsStore().setClaws([{ id: 'b1', name: 'Offline', online: false }]);
	await wrapper.vm.$nextTick();

	const item = wrapper.vm.mixedAgentItems[0];
	expect(item.id).toBe('claw:b1:main');
	expect(item.clawId).toBe('b1');
	expect(item.agentId).toBe('main');
});

test('三处 actions 容器 class 含 group-focus-within:opacity-100（键盘 Tab 焦点可见）', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	useClawsStore().setClaws([{ id: 'b1', name: 'Solo', online: true }]);
	seedAgents('b1', ['main']);
	const topicsStore = useTopicsStore();
	topicsStore.byId = toById([
		{ topicId: 't1', agentId: 'main', title: 'Test', createdAt: 100, clawId: 'b1' },
	]);
	useWebAgentsStore().items = [{ id: 11, slug: 'w1', name: 'W', url: 'https://x', sort: 1, lastClickedAt: '2026-05-04T10:00:00Z', hiddenAt: null }];
	await wrapper.vm.$nextTick();

	// stub 模式下子组件外层 class 不直接落地为 `.web-agent-actions` 等选择器，
	// 直接断言模板渲染的 class fragment 出现 3 次（每条与 group-hover 配对），
	// 比 selector-based 查询更稳。
	const html = wrapper.html();
	const matches = html.match(/group-focus-within:opacity-100/g) ?? [];
	expect(matches.length).toBe(3);
	// 三处都应与 group-hover:opacity-100 紧邻（同一 actions 容器）
	const pairedMatches = html.match(/group-hover:opacity-100 group-focus-within:opacity-100/g) ?? [];
	expect(pairedMatches.length).toBe(3);
});

test('AgentItemActions 渲染为 RouterLink 的 sibling，不能嵌套在 RouterLink 内', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	useClawsStore().setClaws([{ id: 'b1', name: 'Solo', online: true }]);
	seedAgents('b1', ['main']);
	await wrapper.vm.$nextTick();

	const agentNav = wrapper.findAll('nav').filter((n) => n.find('.agent-actions-stub').exists())[0];
	const link = agentNav.find('a');
	const stub = agentNav.find('.agent-actions-stub');
	expect(link.exists()).toBe(true);
	expect(stub.exists()).toBe(true);
	expect(link.find('.agent-actions-stub').exists()).toBe(false);
});

test('agent item 在 topic 路由下不被高亮', async () => {
	const pinia = createPinia();
	setActivePinia(pinia);
	const wrapper = mount(MainList, {
		props: { currentPath: '/topics/t-uuid' },
		global: {
			plugins: [pinia],
			stubs: { RouterLink: RouterLinkStub, UIcon: UIconStub, UButton: UButtonStub, UPopover: UPopoverStub, TopicItemActions: { template: '<div />' }, AgentItemActions: { template: '<div />' }, WebAgentItemActions: { template: '<div />' } },
			mocks: {
				$t: (key) => ({ 'layout.addClaw': '添加 Claw', 'layout.addWebAgent': '添加 Web Agent', 'topic.newTopic': '新话题' }[key] ?? key),
				$route: { name: 'topics-chat', params: { sessionId: 't-uuid' }, query: {} },
				$router: { resolve: (to) => ({ path: typeof to === 'string' ? to : `/topics/${to.params?.sessionId ?? ''}` }) },
			},
		},
	});
	await vi.dynamicImportSettled();

	const clawsStore = useClawsStore();
	clawsStore.setClaws([{ id: 'b1', name: 'Bot', online: true }]);
	await wrapper.vm.$nextTick();

	const item = wrapper.vm.mixedAgentItems.find((i) => i.type === 'claw');
	expect(item.active).toBe(false);
});

test('agent item 在 main session 路由下被高亮', async () => {
	const pinia = createPinia();
	setActivePinia(pinia);
	const wrapper = mount(MainList, {
		props: { currentPath: '/chat/b1/main' },
		global: {
			plugins: [pinia],
			stubs: { RouterLink: RouterLinkStub, UIcon: UIconStub, UButton: UButtonStub, UPopover: UPopoverStub, TopicItemActions: { template: '<div />' }, AgentItemActions: { template: '<div />' }, WebAgentItemActions: { template: '<div />' } },
			mocks: {
				$t: (key) => ({ 'layout.addClaw': '添加 Claw', 'layout.addWebAgent': '添加 Web Agent', 'topic.newTopic': '新话题' }[key] ?? key),
				$route: { name: 'chat', params: { clawId: 'b1', agentId: 'main' }, query: {} },
				$router: { resolve: (to) => ({ path: typeof to === 'string' ? to : `/chat/${to.params?.clawId ?? ''}/${to.params?.agentId ?? ''}` }) },
			},
		},
	});
	await vi.dynamicImportSettled();

	const clawsStore = useClawsStore();
	clawsStore.setClaws([{ id: 'b1', name: 'Bot', online: true }]);
	await wrapper.vm.$nextTick();

	const item = wrapper.vm.mixedAgentItems.find((i) => i.type === 'claw');
	expect(item.active).toBe(true);
});

// --- Web agent 项（在混排中）---

test('web agent: lastClickedAt=null 不渲染', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const store = useWebAgentsStore();
	store.items = [
		{ id: 1, slug: 'deepseek', name: 'DeepSeek', url: 'u', sort: 1, lastClickedAt: null, hiddenAt: null },
	];
	await wrapper.vm.$nextTick();

	expect(wrapper.findAll('[data-testid^="web-agent-recent-"]').length).toBe(0);
});

test('web agent: hiddenAt!=null 不渲染', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const store = useWebAgentsStore();
	store.items = [
		{ id: 1, slug: 'deepseek', name: 'DeepSeek', url: 'u', sort: 1, lastClickedAt: '2026-05-01T10:00:00Z', hiddenAt: null },
		{ id: 2, slug: 'doubao', name: '豆包', url: 'u', sort: 2, lastClickedAt: '2026-05-03T10:00:00Z', hiddenAt: '2026-05-03T11:00:00Z' },
	];
	await wrapper.vm.$nextTick();

	const ids = wrapper.findAll('[data-testid^="web-agent-recent-"]').map((b) => b.attributes('data-testid'));
	expect(ids).toEqual(['web-agent-recent-deepseek']);
});

test('web agent: 点击触发 recordClick + openExternalUrl', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const store = useWebAgentsStore();
	store.items = [
		{ id: 7, slug: 'kimi', name: 'Kimi', url: 'https://www.kimi.com/', sort: 4, lastClickedAt: '2026-05-05T10:00:00Z', hiddenAt: null },
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

test('web agent: 点击后乐观更新使该项立刻置顶（不依赖网络）', async () => {
	__webAgentsApiMock.recordWebAgentClick.mockClear();
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const store = useWebAgentsStore();
	store.items = [
		{ id: 1, slug: 'deepseek', name: 'DeepSeek', url: 'u1', sort: 1, lastClickedAt: '2026-05-01T10:00:00Z', hiddenAt: null },
		{ id: 2, slug: 'doubao', name: '豆包', url: 'u2', sort: 2, lastClickedAt: '2026-05-03T10:00:00Z', hiddenAt: null },
	];
	await wrapper.vm.$nextTick();

	let order = wrapper.findAll('[data-testid^="web-agent-recent-"]').map((b) => b.attributes('data-testid'));
	expect(order).toEqual(['web-agent-recent-doubao', 'web-agent-recent-deepseek']);

	await wrapper.find('[data-testid="web-agent-recent-deepseek"]').trigger('click');
	await wrapper.vm.$nextTick();

	order = wrapper.findAll('[data-testid^="web-agent-recent-"]').map((b) => b.attributes('data-testid'));
	expect(order[0]).toBe('web-agent-recent-deepseek');
	expect(__webAgentsApiMock.recordWebAgentClick).toHaveBeenCalledWith(1);
});

test('web agent: 每条 recent 项渲染尾部 WebAgentItemActions 占位', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const store = useWebAgentsStore();
	store.items = [
		{ id: 1, slug: 'deepseek', name: 'DeepSeek', url: 'u', sort: 1, lastClickedAt: '2026-05-01T10:00:00Z', hiddenAt: null },
		{ id: 2, slug: 'doubao', name: '豆包', url: 'u', sort: 2, lastClickedAt: '2026-05-03T10:00:00Z', hiddenAt: null },
	];
	await wrapper.vm.$nextTick();

	const actionStubs = wrapper.findAll('.web-agent-actions-stub');
	expect(actionStubs.length).toBe(2);
});

test('web agent: 用户自建（slug=null）项 fallback 走 web-agent-recent-custom-${id} 与 globe icon', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const store = useWebAgentsStore();
	store.items = [
		{ id: 42, slug: null, name: 'My Agent', url: 'https://example.test/', sort: null, lastClickedAt: '2026-05-05T10:00:00Z', hiddenAt: null },
	];
	await wrapper.vm.$nextTick();

	const item = wrapper.find('[data-testid="web-agent-recent-custom-42"]');
	expect(item.exists()).toBe(true);
	expect(item.find('img').exists()).toBe(false);
	const fallbackIcon = item.find('[name="i-lucide-globe"]');
	expect(fallbackIcon.exists()).toBe(true);
});

test('web agent: openExternalUrl 拒绝时被 catch，无 unhandled rejection', async () => {
	__openExternalUrlMock.mockClear();
	__openExternalUrlMock.mockRejectedValueOnce(new Error('popup blocked'));
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const store = useWebAgentsStore();
	store.items = [
		{ id: 1, slug: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/', sort: 1, lastClickedAt: '2026-05-05T10:00:00Z', hiddenAt: null },
	];
	await wrapper.vm.$nextTick();

	await wrapper.find('[data-testid="web-agent-recent-deepseek"]').trigger('click');
	await new Promise((r) => setTimeout(r, 0));

	expect(__openExternalUrlMock).toHaveBeenCalled();
	expect(warnSpy).toHaveBeenCalled();
	warnSpy.mockRestore();
});

// --- 分组顺序 ---

test('MainList 分组顺序：mixedAgents → topics → bottomActions（DOM 顺序写死）', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	useClawsStore().setClaws([{ id: 'b1', name: 'Solo', online: true }]);
	seedAgents('b1', ['main']);
	useTopicsStore().byId = toById([
		{ topicId: 't1', agentId: 'main', title: 'Topic A', createdAt: 100, clawId: 'b1' },
	]);
	const webAgentsStore = useWebAgentsStore();
	webAgentsStore.items = [
		{ id: 1, slug: 'deepseek', name: 'DeepSeek', url: 'u', sort: 1, lastClickedAt: '2026-05-05T10:00:00Z', hiddenAt: null },
	];
	await wrapper.vm.$nextTick();

	const html = wrapper.html();
	const idxAgent = html.indexOf('agent-actions-stub');
	const idxWebAgent = html.indexOf('web-agent-recent-deepseek');
	const idxTopic = html.indexOf('topic-actions-stub');
	const idxBottomAdd = html.indexOf('bottom-action-add-claw');
	expect(idxAgent).toBeGreaterThan(-1);
	expect(idxWebAgent).toBeGreaterThan(-1);
	expect(idxTopic).toBeGreaterThan(-1);
	expect(idxBottomAdd).toBeGreaterThan(-1);
	// claw 与 web 在同一组内，按 last used 倒排，与本用例时序无关
	// 关键：mixedAgents 段（包含 agent-actions-stub 与 web-agent-recent）位于 topics 之前；topics 在 bottom 之前
	expect(Math.max(idxAgent, idxWebAgent)).toBeLessThan(idxTopic);
	expect(idxTopic).toBeLessThan(idxBottomAdd);
});

test('MainList scrollable 模式分组顺序：topActions → mixedAgents → topics → bottomActions', async () => {
	const wrapper = createWrapper({ scrollable: true });
	await vi.dynamicImportSettled();

	useClawsStore().setClaws([{ id: 'b1', name: 'Solo', online: true }]);
	seedAgents('b1', ['main']);
	useTopicsStore().byId = toById([
		{ topicId: 't1', agentId: 'main', title: 'Topic A', createdAt: 100, clawId: 'b1' },
	]);
	await wrapper.vm.$nextTick();

	const html = wrapper.html();
	const idxManage = html.indexOf('我的 Claw');
	const idxAgent = html.indexOf('agent-actions-stub');
	const idxTopic = html.indexOf('topic-actions-stub');
	const idxBottomAdd = html.indexOf('bottom-action-add-claw');
	expect(idxManage).toBeGreaterThan(-1);
	expect(idxAgent).toBeGreaterThan(-1);
	expect(idxTopic).toBeGreaterThan(-1);
	expect(idxBottomAdd).toBeGreaterThan(-1);
	expect(idxManage).toBeLessThan(idxAgent);
	expect(idxAgent).toBeLessThan(idxTopic);
	expect(idxTopic).toBeLessThan(idxBottomAdd);
});

// --- 真实使用场景：reactive 更新 / 空首屏 / 调用顺序 ---

test('全空首屏：0 claw / 0 web agent / 0 topic 时只剩两个底部添加入口', async () => {
	// 新用户首屏：列表里不应"漏出"任何来历不明的条目，只剩两个 add 按钮。
	const wrapper = createWrapper({ scrollable: true });
	await vi.dynamicImportSettled();

	expect(wrapper.vm.mixedAgentItems).toEqual([]);
	expect(wrapper.vm.topicItems).toEqual([]);
	expect(wrapper.findAll('.web-agent-actions-stub')).toHaveLength(0);
	expect(wrapper.findAll('.agent-actions-stub')).toHaveLength(0);
	expect(wrapper.findAll('.topic-actions-stub')).toHaveLength(0);

	const bottomIds = wrapper.findAll('[data-testid^="bottom-action-"]').map((b) => b.attributes('data-testid'));
	expect(bottomIds).toEqual(['bottom-action-add-claw', 'bottom-action-add-web-agent']);
});

test('hide 后 mixedAgentItems 立刻不再包含该项（reactive 更新）', async () => {
	// 用户在三点菜单里 hide 一个 web agent，行应立刻消失，无需重新加载。
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const store = useWebAgentsStore();
	store.items = [
		{ id: 1, slug: 'deepseek', name: 'DeepSeek', url: 'u', sort: 1, lastClickedAt: '2026-05-05T10:00:00Z', hiddenAt: null },
		{ id: 2, slug: 'doubao', name: '豆包', url: 'u', sort: 2, lastClickedAt: '2026-05-04T10:00:00Z', hiddenAt: null },
	];
	await wrapper.vm.$nextTick();
	expect(wrapper.vm.mixedAgentItems.map((i) => i.id)).toEqual(['web:1', 'web:2']);

	store.items[0].hiddenAt = '2026-05-05T11:00:00Z';
	await wrapper.vm.$nextTick();
	expect(wrapper.vm.mixedAgentItems.map((i) => i.id)).toEqual(['web:2']);

	// 取消隐藏后应重新出现（cross-device unhide 推到本地 store 等价场景）
	store.items[0].hiddenAt = null;
	await wrapper.vm.$nextTick();
	expect(wrapper.vm.mixedAgentItems.map((i) => i.id)).toEqual(['web:1', 'web:2']);
});

test('cross-device sync：另一台设备点击的新 lastClickedAt 同步到本地后列表立刻重排', async () => {
	// device A 点击某 agent → server 推送给 device B → store.items 被更新 → MainList 立即重排。
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const store = useWebAgentsStore();
	store.items = [
		{ id: 1, slug: 'deepseek', name: 'DeepSeek', url: 'u', sort: 1, lastClickedAt: '2026-05-01T10:00:00Z', hiddenAt: null },
		{ id: 2, slug: 'doubao', name: '豆包', url: 'u', sort: 2, lastClickedAt: '2026-05-03T10:00:00Z', hiddenAt: null },
	];
	await wrapper.vm.$nextTick();
	expect(wrapper.vm.mixedAgentItems.map((i) => i.id)).toEqual(['web:2', 'web:1']);

	// 模拟 server 推过来的更新：deepseek 在另一台设备被点过，时间戳更新成最新
	store.items[0].lastClickedAt = '2026-05-09T10:00:00Z';
	await wrapper.vm.$nextTick();
	expect(wrapper.vm.mixedAgentItems.map((i) => i.id)).toEqual(['web:1', 'web:2']);
});

test('点击 web agent：recordClick 在 openExternalUrl 之前；外链失败也保留 record（业务规则）', async () => {
	// 业务决策：用户点了就算"最近使用"，即使外链打开失败（弹窗被拦/链接坏）也照样置顶，
	// 否则用户下次回来找不到刚点过的 agent 会困惑。钉死调用顺序防止将来被改成 open 成功才 record。
	__openExternalUrlMock.mockReset();
	const callOrder = [];
	__openExternalUrlMock.mockImplementation(() => { callOrder.push('open'); return Promise.reject(new Error('popup blocked')); });
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const store = useWebAgentsStore();
	store.items = [
		{ id: 7, slug: 'kimi', name: 'Kimi', url: 'https://www.kimi.com/', sort: 4, lastClickedAt: '2026-05-05T10:00:00Z', hiddenAt: null },
	];
	const recordSpy = vi.spyOn(store, 'recordClick').mockImplementation(() => callOrder.push('record'));
	await wrapper.vm.$nextTick();

	await wrapper.find('[data-testid="web-agent-recent-kimi"]').trigger('click');
	await new Promise((r) => setTimeout(r, 0));

	expect(callOrder).toEqual(['record', 'open']);
	expect(recordSpy).toHaveBeenCalledWith(7);
	expect(warnSpy).toHaveBeenCalled();
	warnSpy.mockRestore();
});

test('cap header 下拉菜单：点击 add-web-agent 后 capAddMenuOpen 也复位（与 add-claw 一致）', async () => {
	// add-claw 关闭分支已有专项测试，此用例补 add-web-agent 分支，避免将来 onAddAction
	// 内部分支被改成"先 if return 才 close"时漏关菜单。
	__mockIsCapacitorApp = true;
	__openPickerDialogMock.mockClear();
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();
	wrapper.vm.envStore = { screen: { ltMd: ref(true) } };
	await wrapper.vm.$nextTick();

	wrapper.vm.capAddMenuOpen = true;
	await wrapper.vm.$nextTick();
	await wrapper.find('[data-testid="cap-header-add-add-web-agent"]').trigger('click');
	expect(wrapper.vm.capAddMenuOpen).toBe(false);
	expect(__openPickerDialogMock).toHaveBeenCalledTimes(1);
});

// --- mounted lifecycle ---

test('mounted 时调用 webAgentsStore.loadAll()', async () => {
	const pinia = createPinia();
	setActivePinia(pinia);
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
				UPopover: UPopoverStub,
				TopicItemActions: { template: '<div />' },
				AgentItemActions: { template: '<div />' },
				WebAgentItemActions: { template: '<div />' },
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

// --- clawListKey watcher：触发维度 ---

/**
 * mounted() 的 loadAllData() 会在 SSE 快照到达前阻塞，不会调用三套 loadAll；spy 在 mount 后安装
 * 不会捕获到挂载阶段的调用，因此后续断言的调用次数即 watcher 实际触发次数。
 */
async function setupWatcherWrapper() {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();
	await wrapper.vm.$nextTick();
	const agentsStore = wrapper.vm.agentsStore;
	const topicsStore = wrapper.vm.topicsStore;
	const sessionsStore = wrapper.vm.sessionsStore;
	const agentsSpy = vi.spyOn(agentsStore, 'loadAllAgents').mockResolvedValue();
	const topicsSpy = vi.spyOn(topicsStore, 'loadAllTopics').mockResolvedValue();
	const sessionsSpy = vi.spyOn(sessionsStore, 'loadAllSessions').mockResolvedValue();
	return { wrapper, agentsSpy, topicsSpy, sessionsSpy };
}

test('clawListKey watcher：claw 新增（items 长度变化）触发 agents/topics/sessions 重载', async () => {
	const { wrapper, agentsSpy, topicsSpy, sessionsSpy } = await setupWatcherWrapper();
	const clawsStore = useClawsStore();

	clawsStore.setClaws([{ id: 'b1', name: 'Bot', online: true }]);
	await wrapper.vm.$nextTick();
	await wrapper.vm.$nextTick();

	expect(agentsSpy).toHaveBeenCalledTimes(1);
	expect(topicsSpy).toHaveBeenCalledTimes(1);
	expect(sessionsSpy).toHaveBeenCalledTimes(1);
});

test('clawListKey watcher：claw online false→true 触发重载', async () => {
	const { wrapper, agentsSpy, topicsSpy, sessionsSpy } = await setupWatcherWrapper();
	const clawsStore = useClawsStore();
	clawsStore.setClaws([{ id: 'b1', name: 'Bot', online: false }]);
	await wrapper.vm.$nextTick();
	await wrapper.vm.$nextTick();
	agentsSpy.mockClear();
	topicsSpy.mockClear();
	sessionsSpy.mockClear();

	clawsStore.byId['b1'].online = true;
	await wrapper.vm.$nextTick();
	await wrapper.vm.$nextTick();

	expect(agentsSpy).toHaveBeenCalledTimes(1);
	expect(topicsSpy).toHaveBeenCalledTimes(1);
	expect(sessionsSpy).toHaveBeenCalledTimes(1);
});

test('clawListKey watcher：claw online true→false 同样触发重载（下线后清理本地视图）', async () => {
	const { wrapper, agentsSpy, topicsSpy, sessionsSpy } = await setupWatcherWrapper();
	const clawsStore = useClawsStore();
	clawsStore.setClaws([{ id: 'b1', name: 'Bot', online: true }]);
	await wrapper.vm.$nextTick();
	await wrapper.vm.$nextTick();
	agentsSpy.mockClear();
	topicsSpy.mockClear();
	sessionsSpy.mockClear();

	clawsStore.byId['b1'].online = false;
	await wrapper.vm.$nextTick();
	await wrapper.vm.$nextTick();

	expect(agentsSpy).toHaveBeenCalledTimes(1);
	expect(topicsSpy).toHaveBeenCalledTimes(1);
	expect(sessionsSpy).toHaveBeenCalledTimes(1);
});

test('clawListKey watcher：dcReady false→true 不再触发重载（首屏由 lifecycle 接管，避免重复 RPC）', async () => {
	const { wrapper, agentsSpy, topicsSpy, sessionsSpy } = await setupWatcherWrapper();
	const clawsStore = useClawsStore();
	clawsStore.setClaws([{ id: 'b1', name: 'Bot', online: true }]);
	await wrapper.vm.$nextTick();
	await wrapper.vm.$nextTick();
	agentsSpy.mockClear();
	topicsSpy.mockClear();
	sessionsSpy.mockClear();

	clawsStore.byId['b1'].dcReady = true;
	await wrapper.vm.$nextTick();
	await wrapper.vm.$nextTick();

	expect(agentsSpy).not.toHaveBeenCalled();
	expect(topicsSpy).not.toHaveBeenCalled();
	expect(sessionsSpy).not.toHaveBeenCalled();
});

test('clawListKey watcher：claw 删除（items 长度变化）触发重载', async () => {
	const { wrapper, agentsSpy, topicsSpy, sessionsSpy } = await setupWatcherWrapper();
	const clawsStore = useClawsStore();
	clawsStore.setClaws([
		{ id: 'b1', name: 'Bot1', online: true },
		{ id: 'b2', name: 'Bot2', online: true },
	]);
	await wrapper.vm.$nextTick();
	await wrapper.vm.$nextTick();
	agentsSpy.mockClear();
	topicsSpy.mockClear();
	sessionsSpy.mockClear();

	clawsStore.setClaws([{ id: 'b1', name: 'Bot1', online: true }]);
	await wrapper.vm.$nextTick();
	await wrapper.vm.$nextTick();

	expect(agentsSpy).toHaveBeenCalledTimes(1);
	expect(topicsSpy).toHaveBeenCalledTimes(1);
	expect(sessionsSpy).toHaveBeenCalledTimes(1);
});

test('clawListKey watcher：agents 必须先完成，topics/sessions 才能开跑（agents 阻塞时两者均不调用）', async () => {
	const { wrapper, agentsSpy, topicsSpy, sessionsSpy } = await setupWatcherWrapper();
	const clawsStore = useClawsStore();

	let agentsResolve;
	agentsSpy.mockImplementation(() => new Promise((resolve) => { agentsResolve = resolve; }));

	clawsStore.setClaws([{ id: 'b1', name: 'Bot', online: true }]);
	await wrapper.vm.$nextTick();
	await wrapper.vm.$nextTick();

	// agents 还未 resolve 时 topics/sessions 不应被调
	expect(agentsSpy).toHaveBeenCalledTimes(1);
	expect(topicsSpy).not.toHaveBeenCalled();
	expect(sessionsSpy).not.toHaveBeenCalled();

	agentsResolve();
	await wrapper.vm.$nextTick();
	await wrapper.vm.$nextTick();
	expect(topicsSpy).toHaveBeenCalledTimes(1);
	expect(sessionsSpy).toHaveBeenCalledTimes(1);
});

test('clawListKey watcher：topics 与 sessions 并发起跑（不是串行 await，topics 挂起时 sessions 也已被调）', async () => {
	const { wrapper, agentsSpy, topicsSpy, sessionsSpy } = await setupWatcherWrapper();
	const clawsStore = useClawsStore();

	// topics 永远挂起：若 handler 写成 `await topics; await sessions`，sessions 永远不会被调用
	topicsSpy.mockImplementation(() => new Promise(() => {}));

	clawsStore.setClaws([{ id: 'b1', name: 'Bot', online: true }]);
	await wrapper.vm.$nextTick();
	await wrapper.vm.$nextTick();
	await wrapper.vm.$nextTick();

	expect(agentsSpy).toHaveBeenCalledTimes(1);
	expect(topicsSpy).toHaveBeenCalledTimes(1);
	// 并发起跑的核心断言：topics 还挂着，sessions 也已被启动
	expect(sessionsSpy).toHaveBeenCalledTimes(1);
});

test('clawListKey watcher：loadAllAgents 抛错时 topics/sessions 仍被调（try/catch 保护）', async () => {
	const { wrapper, agentsSpy, topicsSpy, sessionsSpy } = await setupWatcherWrapper();
	const clawsStore = useClawsStore();
	agentsSpy.mockRejectedValueOnce(new Error('boom'));

	clawsStore.setClaws([{ id: 'b1', name: 'Bot', online: true }]);
	await wrapper.vm.$nextTick();
	await wrapper.vm.$nextTick();
	await wrapper.vm.$nextTick();

	expect(agentsSpy).toHaveBeenCalledTimes(1);
	expect(topicsSpy).toHaveBeenCalledTimes(1);
	expect(sessionsSpy).toHaveBeenCalledTimes(1);
});

// --- T4：顶部"我的 Claw"入口前缀匹配高亮（设计 § 3）---

describe('topActionItems 前缀匹配高亮', () => {
	function manageItem(wrapper) {
		return wrapper.vm.topActionItems[0];
	}

	test('currentPath=/claws → 高亮（精确匹配基路径）', async () => {
		const wrapper = createWrapper({ scrollable: true, currentPath: '/claws' });
		await vi.dynamicImportSettled();
		expect(wrapper.vm.isTopItemActive(manageItem(wrapper))).toBe(true);
	});

	test('currentPath=/claws/add → 高亮（子路径）', async () => {
		const wrapper = createWrapper({ scrollable: true, currentPath: '/claws/add' });
		await vi.dynamicImportSettled();
		expect(wrapper.vm.isTopItemActive(manageItem(wrapper))).toBe(true);
	});

	test('currentPath=/claws/:id/models → 高亮（模型设置子页）', async () => {
		const wrapper = createWrapper({ scrollable: true, currentPath: '/claws/b1/models' });
		await vi.dynamicImportSettled();
		expect(wrapper.vm.isTopItemActive(manageItem(wrapper))).toBe(true);
	});

	test('currentPath=/topics → 不高亮（无关路径）', async () => {
		const wrapper = createWrapper({ scrollable: true, currentPath: '/topics' });
		await vi.dynamicImportSettled();
		expect(wrapper.vm.isTopItemActive(manageItem(wrapper))).toBe(false);
	});

	test('currentPath=/clawsfoo → 不高亮（前缀边界：必须是 /claws/ 子路径或精确 /claws）', async () => {
		const wrapper = createWrapper({ scrollable: true, currentPath: '/clawsfoo' });
		await vi.dynamicImportSettled();
		expect(wrapper.vm.isTopItemActive(manageItem(wrapper))).toBe(false);
	});

	test('DOM：在 /claws/b1/models 下"我的 Claw"链接带 active class', async () => {
		const wrapper = createWrapper({ scrollable: true, currentPath: '/claws/b1/models' });
		await vi.dynamicImportSettled();
		const link = wrapper.findAll('a').find((a) => a.text().includes('我的 Claw'));
		expect(link).toBeTruthy();
		expect(link.classes()).toContain('bg-accented');
	});

	test('DOM：在 /topics 下"我的 Claw"链接无 active class', async () => {
		const wrapper = createWrapper({ scrollable: true, currentPath: '/topics' });
		await vi.dynamicImportSettled();
		const link = wrapper.findAll('a').find((a) => a.text().includes('我的 Claw'));
		expect(link).toBeTruthy();
		expect(link.classes()).not.toContain('bg-accented');
	});
});
