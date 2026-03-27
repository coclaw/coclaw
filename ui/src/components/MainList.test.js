import { ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { vi } from 'vitest';

import MainList from './MainList.vue';
import { useBotsStore } from '../stores/bots.store.js';
import { useTopicsStore } from '../stores/topics.store.js';

let __mockIsCapacitorApp = false;
vi.mock('../utils/platform.js', () => ({
	get isCapacitorApp() { return __mockIsCapacitorApp; },
}));

vi.mock('../services/bots.api.js', () => ({
	listBots: vi.fn().mockResolvedValue([]),
}));

vi.mock('./TopicItemActions.vue', () => ({
	default: { name: 'TopicItemActions', template: '<div class="topic-actions-stub" />', props: ['topicId', 'botId', 'title'] },
}));

vi.mock('../services/bot-connection-manager.js', () => ({
	useBotConnections: () => ({
		get: vi.fn(),
		connect: vi.fn(),
		disconnect: vi.fn(),
		syncConnections: vi.fn(),
		disconnectAll: vi.fn(),
	}),
	__resetBotConnections: vi.fn(),
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
			},
			mocks: {
				$t: (key) => {
					const map = {
						'layout.addBot': '添加机器人',
						'layout.manageBots': '管理机器人',
						'layout.productName': 'CoClaw',
						'layout.unnamedSession': '未命名会话',
						'layout.notIndexed': '未索引',
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
								: `/chat/${to.params?.botId ?? ''}/${to.params?.agentId ?? ''}`,
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

test('should show only add-bot in Group 1 on narrow screen (default)', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	expect(wrapper.text()).toContain('添加机器人');
	expect(wrapper.text()).not.toContain('管理机器人');
	// Group 1 nav 在窄屏下有 mt-3
	const group1Nav = wrapper.findAll('nav').at(0);
	expect(group1Nav.classes()).toContain('mt-3');
});

test('should show add-bot and manage-bots in Group 1 when scrollable (sidebar)', async () => {
	const wrapper = createWrapper({ scrollable: true });
	await vi.dynamicImportSettled();

	expect(wrapper.text()).toContain('添加机器人');
	expect(wrapper.text()).toContain('管理机器人');
	// Group 1 nav 在侧边栏下无 mt-3
	const group1Nav = wrapper.findAll('nav').at(0);
	expect(group1Nav.classes()).not.toContain('mt-3');
});

test('should not show label text or empty state text when lists are empty', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	// 不应显示分组标签和空状态提示
	expect(wrapper.text()).not.toContain('layout.commonBots');
	expect(wrapper.text()).not.toContain('layout.sessions');
	expect(wrapper.text()).not.toContain('layout.noBots');
	expect(wrapper.text()).not.toContain('layout.emptySession');
});

test('should render topic items from topics store', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const topicsStore = useTopicsStore();
	topicsStore.items = [
		{ topicId: 't1', agentId: 'main', title: '话题一', createdAt: 2000, botId: 'b1' },
		{ topicId: 't2', agentId: 'main', title: null, createdAt: 1000, botId: 'b1' },
	];
	await wrapper.vm.$nextTick();

	expect(wrapper.text()).toContain('话题一');
	// title 为 null 的 topic 显示"新话题"
	expect(wrapper.text()).toContain('新话题');
});

test('should sort topics by createdAt desc', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const topicsStore = useTopicsStore();
	topicsStore.items = [
		{ topicId: 't-old', agentId: 'main', title: 'Old', createdAt: 100, botId: 'b1' },
		{ topicId: 't-new', agentId: 'main', title: 'New', createdAt: 200, botId: 'b1' },
	];
	await wrapper.vm.$nextTick();

	const items = wrapper.vm.topicItems;
	expect(items[0].id).toBe('t-new');
	expect(items[1].id).toBe('t-old');
});

test('topic items should navigate to topics-chat route', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const topicsStore = useTopicsStore();
	topicsStore.items = [
		{ topicId: 't1', agentId: 'main', title: 'Topic', createdAt: 100, botId: 'b1' },
	];
	await wrapper.vm.$nextTick();

	const items = wrapper.vm.topicItems;
	expect(items[0].to).toEqual({ name: 'topics-chat', params: { sessionId: 't1' } });
});

test('bot item should navigate to chat with botId/agentId params', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const botsStore = useBotsStore();
	botsStore.setBots([{ id: 'b1', name: 'MyBot', online: true }]);
	await wrapper.vm.$nextTick();

	const agentItem = wrapper.vm.agentItems[0];
	expect(agentItem.to).toEqual({ name: 'chat', params: { botId: 'b1', agentId: 'main' } });
});

test('bot item always navigates to chat route (no fallback needed)', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const botsStore = useBotsStore();
	botsStore.setBots([{ id: 'b1', name: 'MyBot', online: true }]);
	await wrapper.vm.$nextTick();

	const agentItem = wrapper.vm.agentItems[0];
	expect(agentItem.to).toEqual({ name: 'chat', params: { botId: 'b1', agentId: 'main' } });
});

test('topic with title should display the title', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const topicsStore = useTopicsStore();
	topicsStore.items = [
		{ topicId: 't1', agentId: 'main', title: '自定义标题', createdAt: 100, botId: 'b1' },
	];
	await wrapper.vm.$nextTick();

	expect(wrapper.text()).toContain('自定义标题');
});

test('topic without title should show untitled', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const topicsStore = useTopicsStore();
	topicsStore.items = [
		{ topicId: 't1', agentId: 'main', title: null, createdAt: 100, botId: 'b1' },
	];
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
			stubs: { RouterLink: RouterLinkStub, UIcon: UIconStub, UButton: UButtonStub, TopicItemActions: { template: '<div />' } },
			mocks: {
				$t: (key) => ({ 'layout.addBot': '添加机器人', 'topic.newTopic': '新话题' }[key] ?? key),
				$route: { name: 'topics-chat', params: { sessionId: 't-uuid' }, query: {} },
				$router: { resolve: (to) => ({ path: typeof to === 'string' ? to : `/topics/${to.params?.sessionId ?? ''}` }) },
			},
		},
	});
	await vi.dynamicImportSettled();

	const botsStore = useBotsStore();
	botsStore.setBots([{ id: 'b1', name: 'Bot', online: true }]);
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
			stubs: { RouterLink: RouterLinkStub, UIcon: UIconStub, UButton: UButtonStub, TopicItemActions: { template: '<div />' } },
			mocks: {
				$t: (key) => ({ 'layout.addBot': '添加机器人', 'topic.newTopic': '新话题' }[key] ?? key),
				$route: { name: 'chat', params: { botId: 'b1', agentId: 'main' }, query: {} },
				$router: { resolve: (to) => ({ path: typeof to === 'string' ? to : `/chat/${to.params?.botId ?? ''}/${to.params?.agentId ?? ''}` }) },
			},
		},
	});
	await vi.dynamicImportSettled();

	const botsStore = useBotsStore();
	botsStore.setBots([{ id: 'b1', name: 'Bot', online: true }]);
	await wrapper.vm.$nextTick();

	// 在 main session 路由下，agent item 应被高亮
	const agentItem = wrapper.vm.agentItems[0];
	expect(agentItem.active).toBe(true);
});

test('topic icon should show agent initial when no avatar', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const topicsStore = useTopicsStore();
	topicsStore.items = [
		{ topicId: 't1', agentId: 'main', title: 'Test', createdAt: 100, botId: 'b1' },
	];
	await wrapper.vm.$nextTick();

	const topicNav = wrapper.findAll('nav').at(2); // Group 3
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
	expect(wrapper.vm.$router.push).toHaveBeenCalledWith('/bots/add');

	__mockIsCapacitorApp = false;
});

test('should hide Group 1 add-bot item when capHeader active and bots exist', async () => {
	__mockIsCapacitorApp = true;
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	wrapper.vm.envStore = { screen: { ltMd: ref(true) } };

	const botsStore = useBotsStore();
	botsStore.fetched = true;
	botsStore.setBots([{ id: 'b1', name: 'Bot', online: true }]);
	await wrapper.vm.$nextTick();

	expect(wrapper.vm.showCapHeader).toBe(true);
	expect(wrapper.vm.botActionItems).toEqual([]);

	__mockIsCapacitorApp = false;
});

test('should show Group 1 add-bot item when capHeader active and no bots', async () => {
	__mockIsCapacitorApp = true;
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	wrapper.vm.envStore = { screen: { ltMd: ref(true) } };

	const botsStore = useBotsStore();
	botsStore.fetched = true;
	botsStore.setBots([]);
	await wrapper.vm.$nextTick();

	expect(wrapper.vm.showCapHeader).toBe(true);
	expect(wrapper.vm.botActionItems.length).toBe(1);
	expect(wrapper.vm.botActionItems[0].id).toBe('add-bot');

	__mockIsCapacitorApp = false;
});

test('should hide Group 1 add-bot item when capHeader active and bots not yet fetched', async () => {
	__mockIsCapacitorApp = true;
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	wrapper.vm.envStore = { screen: { ltMd: ref(true) } };

	const botsStore = useBotsStore();
	botsStore.fetched = false;
	botsStore.setBots([]);
	await wrapper.vm.$nextTick();

	expect(wrapper.vm.showCapHeader).toBe(true);
	// 未 fetch 完成前不显示引导项
	expect(wrapper.vm.botActionItems).toEqual([]);

	__mockIsCapacitorApp = false;
});
