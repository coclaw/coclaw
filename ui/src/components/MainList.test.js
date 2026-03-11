import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { vi } from 'vitest';

import MainList from './MainList.vue';
import { useBotsStore } from '../stores/bots.store.js';
import { useSessionsStore } from '../stores/sessions.store.js';

vi.mock('../services/bots.api.js', () => ({
	listBots: vi.fn().mockResolvedValue([]),
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
			},
			mocks: {
				$t: (key) => {
					const map = {
						'layout.addBot': '添加机器人',
						'layout.manageBots': '管理机器人',
						'layout.unnamedSession': '未命名会话',
						'layout.notIndexed': '未索引',
					};
					return map[key] ?? key;
				},
				$router: {
					resolve: (to) => ({
						path: typeof to === 'string'
							? to
							: `/${to.name === 'topics-chat' ? 'topics' : 'chat'}/${to.params?.sessionId ?? ''}`,
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

test('should not show bot action nav items by default, but show trailing add-bot link', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	expect(wrapper.text()).not.toContain('管理机器人');
	// 移动端末尾的"添加机器人"入口
	const links = wrapper.findAll('a');
	const addBotLink = links.find((l) => l.text().includes('添加机器人'));
	expect(addBotLink).toBeTruthy();
});

test('should show bot action items and hide trailing add-bot when showBotActions is true', async () => {
	const wrapper = createWrapper({ showBotActions: true });
	await vi.dynamicImportSettled();

	expect(wrapper.text()).toContain('添加机器人');
	expect(wrapper.text()).toContain('管理机器人');
	// 桌面端不应出现末尾的额外"添加机器人"链接（只在 Group 1 中出现）
	const links = wrapper.findAll('a');
	const addBotLinks = links.filter((l) => l.text().includes('添加机器人'));
	expect(addBotLinks.length).toBe(1);
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

test('should render session items from sessions store', async () => {
	const sessionsItems = [
		{ sessionId: 's1', title: 'My Session', indexed: true, botId: 'b1' },
		{ sessionId: 's2', title: '', indexed: false, botId: 'b2' },
	];
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	// mounted 的 loadAllSessions 已完成，此时注入测试数据
	const sessionsStore = useSessionsStore();
	sessionsStore.setSessions(sessionsItems);
	await wrapper.vm.$nextTick();

	expect(wrapper.text()).toContain('My Session');
	// 无标题 session 应回退到 sessionId
	expect(wrapper.text()).toContain('s2');
	// 未索引 session 显示 unlink 图标标记
	const icons = wrapper.findAll('.icon');
	const badgeIcon = icons.filter((i) => i.attributes('name') === 'i-lucide-unlink');
	expect(badgeIcon.length).toBe(1);
});

test('should show badge icons for different session types', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const sessionsStore = useSessionsStore();
	sessionsStore.setSessions([
		{ sessionId: 's1', sessionKey: 'agent:main:main', title: 'Main', indexed: true, botId: 'b1' },
		{ sessionId: 's2', sessionKey: 'agent:main:cron:d591-abc', title: 'Cron Job', indexed: true, botId: 'b1' },
		{ sessionId: 's3', sessionKey: 'agent:main:session-research-123', title: 'Research', indexed: true, botId: 'b1' },
		{ sessionId: 's4', sessionKey: null, title: 'Orphan', indexed: false, botId: 'b1' },
		{ sessionId: 's5', sessionKey: 'agent:main:other-key', title: 'Normal', indexed: true, botId: 'b1' },
	]);
	await wrapper.vm.$nextTick();

	const items = wrapper.vm.sessionItems;
	// agent:main:main → star
	expect(items[0].badge).toEqual({ icon: 'i-lucide-star', color: 'text-primary' });
	// cron → clock
	expect(items[1].badge).toEqual({ icon: 'i-lucide-clock', color: 'text-warning' });
	// research → flask
	expect(items[2].badge).toEqual({ icon: 'i-lucide-flask-conical', color: 'text-dimmed' });
	// orphan → unlink
	expect(items[3].badge).toEqual({ icon: 'i-lucide-unlink', color: 'text-dimmed' });
	// 普通 indexed session 无标记
	expect(items[4].badge).toBeNull();
});

test('should show bot name initial in session icon', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const botsStore = useBotsStore();
	botsStore.setBots([
		{ id: 'b1', name: 'AlphaBot', online: true },
		{ id: 'b2', name: 'BetaBot', online: true },
	]);
	// 让 watcher 触发的 loadAllSessions 完成，避免后续覆盖手动设置的 sessions
	await wrapper.vm.$nextTick();

	const sessionsStore = useSessionsStore();
	sessionsStore.setSessions([
		{ sessionId: 's1', title: 'Session 1', indexed: true, botId: 'b1' },
		{ sessionId: 's2', title: 'Session 2', indexed: true, botId: 'b2' },
	]);
	await wrapper.vm.$nextTick();

	// 会话列表区域的 icon 应展示 bot name 首字符
	const sessionNav = wrapper.findAll('nav').at(1); // Group 3
	const icons = sessionNav.findAll('.rounded-full');
	expect(icons[0].text()).toBe('A');
	expect(icons[1].text()).toBe('B');
});

test('bot item should navigate to agent:main:main session when available', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const botsStore = useBotsStore();
	botsStore.setBots([{ id: 'b1', name: 'MyBot', online: true }]);
	await wrapper.vm.$nextTick();

	const sessionsStore = useSessionsStore();
	sessionsStore.setSessions([
		{ sessionId: 'sess-main', sessionKey: 'agent:main:main', title: 'Main', indexed: true, botId: 'b1' },
	]);
	await wrapper.vm.$nextTick();

	const botItem = wrapper.vm.botItems[0];
	expect(botItem.to).toEqual({ name: 'chat', params: { sessionId: 'sess-main' } });
});

test('bot item should fallback to /chat when no agent:main:main session', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const botsStore = useBotsStore();
	botsStore.setBots([{ id: 'b1', name: 'MyBot', online: true }]);
	await wrapper.vm.$nextTick();

	const sessionsStore = useSessionsStore();
	sessionsStore.setSessions([
		{ sessionId: 'sess-other', sessionKey: 'agent:main:side', title: 'Side', indexed: true, botId: 'b1' },
	]);
	await wrapper.vm.$nextTick();

	const botItem = wrapper.vm.botItems[0];
	expect(botItem.to).toBe('/home');
});

test('should display cleaned derivedTitle when title is empty', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const sessionsStore = useSessionsStore();
	sessionsStore.setSessions([
		{ sessionId: 's1', title: '', derivedTitle: '[Mon 2026-03-02 16:16 GMT+8] 你好世界', indexed: true, botId: 'b1' },
		{ sessionId: 's2', title: null, derivedTitle: '[cron:aabb-1122-3344-5566-778899aabbcc task-a] 内容', indexed: true, botId: 'b1' },
	]);
	await wrapper.vm.$nextTick();

	expect(wrapper.text()).toContain('你好世界');
	expect(wrapper.text()).toContain('task-a 内容');
	// 不应回退到 sessionId
	expect(wrapper.text()).not.toContain('s1');
	expect(wrapper.text()).not.toContain('s2');
});

test('should prefer title over derivedTitle', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const sessionsStore = useSessionsStore();
	sessionsStore.setSessions([
		{ sessionId: 's1', title: '自定义标题', derivedTitle: '派生标题', indexed: true, botId: 'b1' },
	]);
	await wrapper.vm.$nextTick();

	expect(wrapper.text()).toContain('自定义标题');
	expect(wrapper.text()).not.toContain('派生标题');
});

test('should clean title containing OC prefixes', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const sessionsStore = useSessionsStore();
	sessionsStore.setSessions([
		{
			sessionId: 's1',
			title: '[cron:d59196ed-27ee-42fc-ad60-8ad19aafd4ba workspace-backup-1300-1900]',
			indexed: true,
			botId: 'b1',
		},
	]);
	await wrapper.vm.$nextTick();

	expect(wrapper.text()).toContain('workspace-backup-1300-1900');
	expect(wrapper.text()).not.toContain('cron:');
});

test('should fallback to sessionId when derivedTitle is also empty', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const sessionsStore = useSessionsStore();
	sessionsStore.setSessions([
		{ sessionId: 's-fallback', title: '', derivedTitle: '', indexed: true, botId: 'b1' },
	]);
	await wrapper.vm.$nextTick();

	expect(wrapper.text()).toContain('s-fallback');
});

test('should fallback to O when bot not found for session icon', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const sessionsStore = useSessionsStore();
	sessionsStore.setSessions([
		{ sessionId: 's1', title: 'Orphan', indexed: true, botId: 'unknown-bot' },
	]);
	await wrapper.vm.$nextTick();

	const sessionNav = wrapper.findAll('nav').at(1);
	const icon = sessionNav.find('.rounded-full');
	expect(icon.text()).toBe('O');
});
