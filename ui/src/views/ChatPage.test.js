import { mount, flushPromises } from '@vue/test-utils';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

// --- mock 子组件 ---
vi.mock('../components/MobilePageHeader.vue', () => ({
	default: {
		name: 'MobilePageHeader',
		props: ['title'],
		template: '<div class="mph-stub">{{ title }}<slot name="actions" /></div>',
	},
}));
vi.mock('../components/ChatMsgItem.vue', () => ({
	default: {
		name: 'ChatMsgItem',
		props: ['item'],
		template: '<div class="msg-stub">{{ item.id }}</div>',
	},
}));
const mockRestoreFiles = vi.fn();
vi.mock('../components/ChatInput.vue', () => ({
	default: {
		name: 'ChatInput',
		props: ['modelValue', 'sending', 'disabled'],
		emits: ['update:modelValue', 'send', 'cancel'],
		template: '<div class="input-stub" />',
		methods: {
			restoreFiles: (...args) => mockRestoreFiles(...args),
		},
	},
}));

// --- mock 服务/stores ---
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

vi.mock('../services/bots.api.js', () => ({
	listBots: vi.fn().mockResolvedValue([]),
}));

vi.mock('../utils/file-helper.js', () => ({
	fileToBase64: vi.fn(() => Promise.resolve('bW9ja2VkX2Jhc2U2NA==')),
}));

const mockNotify = {
	success: vi.fn(),
	info: vi.fn(),
	warning: vi.fn(),
	error: vi.fn(),
};
vi.mock('../composables/use-notify.js', () => ({
	useNotify: () => mockNotify,
}));

vi.mock('../utils/platform.js', () => ({
	isCapacitorApp: false,
	isTauriApp: false,
	isNativeShell: false,
	isDesktop: true,
}));

import ChatPage from './ChatPage.vue';
import { chatStoreManager } from '../stores/chat-store-manager.js';
import { useBotsStore } from '../stores/bots.store.js';
import { useAgentsStore } from '../stores/agents.store.js';

/** 获取 ChatPage 内部使用的 store 实例（与组件使用同一个 manager） */
function getChatStore(botId = 'bot-1', agentId = 'main') {
	return chatStoreManager.get(`session:${botId}:${agentId}`, { botId, agentId });
}

const i18nMap = {
	'chat.loading': 'Loading...',
	'chat.empty': 'No messages',
	'chat.orphanSendFailed': 'Orphan send failed',
	'chat.newChatFailed': 'New chat failed',
	'chat.botOffline': 'Bot is offline',
	'chat.botUnbound': 'Bot has been unbound',
	'chat.sessionNotFound': 'Session no longer exists',
	'topic.newTopic': 'New topic',
	'topic.createFailed': 'Failed to create topic',
};

const mockRouter = { push: vi.fn(), replace: vi.fn() };

/** 设置 agentsStore 使 agentVerified 返回 true */
function setupAgents(botId = 'bot-1', agentId = 'main') {
	const agentsStore = useAgentsStore();
	agentsStore.byBot[botId] = {
		agents: [{ id: agentId }],
		defaultId: agentId,
		loading: false,
		fetched: true,
	};
}

function createWrapper(opts = {}) {
	const { botId = 'bot-1', agentId = 'main', routeName = 'chat', sessionId } = typeof opts === 'string'
		? { botId: opts } // 兼容旧调用
		: opts;
	const pinia = createPinia();
	setActivePinia(pinia);
	const params = routeName === 'topics-chat'
		? { sessionId: sessionId || 'new' }
		: { botId, agentId };
	const prefix = routeName === 'topics-chat' ? '/topics' : '/chat';
	const path = routeName === 'topics-chat'
		? `${prefix}/${params.sessionId}`
		: `${prefix}/${botId}/${agentId}`;
	return mount(ChatPage, {
		global: {
			plugins: [pinia],
			mocks: {
				$t: (key, p) => {
					if (key === 'chat.sessionTitle' && p?.id) return `Session ${p.id}`;
					return i18nMap[key] ?? key;
				},
				$route: {
					name: routeName,
					params,
					path,
					query: {},
				},
				$router: mockRouter,
			},
		},
	});
}

describe('ChatPage', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		chatStoreManager.__reset();
	});

	test('mounted 时通过 chatStore computed 自动激活', async () => {
		createWrapper();
		await flushPromises();

		const chatStore = getChatStore();
		expect(chatStore.botId).toBe('bot-1');
		expect(chatStore.chatSessionKey).toBe('agent:main:main');
		expect(chatStore.__initialized).toBe(true);
	});

	test('显示 loading 状态', async () => {
		const wrapper = createWrapper();
		const botsStore = useBotsStore();
		botsStore.setBots([{ id: 'bot-1', name: 'Bot', online: true }]);
		setupAgents();
		const chatStore = getChatStore();
		// __initialized=true（activate 已设置）, __messagesLoaded=false, messages=[]
		expect(chatStore.__initialized).toBe(true);
		await wrapper.vm.$nextTick();

		expect(wrapper.vm.isLoadingChat).toBe(true);
		expect(wrapper.text()).toContain('Loading...');
	});

	test('显示错误状态', async () => {
		const wrapper = createWrapper();
		const botsStore = useBotsStore();
		botsStore.setBots([{ id: 'bot-1', name: 'Bot', online: true }]);
		setupAgents();
		const chatStore = getChatStore();
		chatStore.errorText = 'Something went wrong';
		await wrapper.vm.$nextTick();

		expect(wrapper.vm.isLoadingChat).toBe(false);
		expect(wrapper.text()).toContain('Something went wrong');
	});

	test('显示空消息状态', async () => {
		const wrapper = createWrapper();
		const botsStore = useBotsStore();
		botsStore.setBots([{ id: 'bot-1', name: 'Bot', online: true }]);
		setupAgents();
		const chatStore = getChatStore();
		chatStore.errorText = '';
		chatStore.messages = [];
		chatStore.__messagesLoaded = true;
		await wrapper.vm.$nextTick();

		expect(wrapper.vm.isLoadingChat).toBe(false);
		expect(wrapper.text()).toContain('No messages');
	});

	test('渲染消息列表', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		chatStore.errorText = '';
		chatStore.messages = [
			{ type: 'message', id: 'msg-1', message: { role: 'user', content: 'hi' } },
			{ type: 'message', id: 'msg-2', message: { role: 'assistant', content: 'hello' } },
		];
		await wrapper.vm.$nextTick();

		const msgStubs = wrapper.findAll('.msg-stub');
		expect(msgStubs).toHaveLength(2);
		expect(msgStubs[0].text()).toContain('msg-1');
		expect(msgStubs[1].text()).toContain('msg-2');
	});

	test('isLoadingChat 在 messagesLoaded 后变为 false（即使 loading 标志卡住）', async () => {
		const wrapper = createWrapper();
		const botsStore = useBotsStore();
		botsStore.setBots([{ id: 'bot-1', name: 'Bot', online: true }]);
		setupAgents();
		const chatStore = getChatStore();
		// 模拟 loading 标志卡住的场景
		chatStore.loading = true;
		chatStore.__messagesLoaded = false;
		await wrapper.vm.$nextTick();
		expect(wrapper.vm.isLoadingChat).toBe(true);

		// 消息加载成功后 __messagesLoaded = true
		chatStore.__messagesLoaded = true;
		chatStore.messages = [];
		await wrapper.vm.$nextTick();
		expect(wrapper.vm.isLoadingChat).toBe(false);
		expect(wrapper.text()).toContain('No messages');
	});

	test('chatTitle 在 session 模式下显示 agent 名称', async () => {
		const wrapper = createWrapper();
		await wrapper.vm.$nextTick();

		// session 模式下 chatTitle 返回 agentDisplay.name || 'Agent'
		// agentsStore 无 agent 定义时 getAgentDisplay 返回 agentId 作为 name
		expect(wrapper.vm.chatTitle).toBeTruthy();
	});

	test('chatTitle routeBotId 为空时返回空字符串', async () => {
		const wrapper = createWrapper({ botId: '' });
		await flushPromises();

		expect(wrapper.vm.chatTitle).toBe('');
	});

	test('显示 bot 离线提示', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		chatStore.botId = 'bot-1';

		const botsStore = useBotsStore();
		botsStore.setBots([{ id: 'bot-1', name: 'MyBot', online: false }]);
		await wrapper.vm.$nextTick();

		expect(wrapper.text()).toContain('Bot is offline');
	});

	test('ChatInput 在无 botId 时不渲染', async () => {
		const wrapper = createWrapper({ botId: '' });
		await flushPromises();

		const input = wrapper.findComponent({ name: 'ChatInput' });
		expect(input.exists()).toBe(false);
	});

	test('ChatInput 绑定 sending 状态', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		chatStore.sending = true;
		await wrapper.vm.$nextTick();

		const input = wrapper.findComponent({ name: 'ChatInput' });
		expect(input.props('sending')).toBe(true);
	});
});

describe('ChatPage send message', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		chatStoreManager.__reset();
	});

	test('onSendMessage 调用 chatStore.sendMessage 并清空输入框', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		// mock sendMessage 为成功
		const sendSpy = vi.spyOn(chatStore, 'sendMessage').mockResolvedValue({ accepted: true });
		await flushPromises();

		wrapper.vm.inputText = 'hello';
		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'hello', files: [] });
		await flushPromises();

		expect(sendSpy).toHaveBeenCalledWith('hello', []);
		expect(wrapper.vm.inputText).toBe('');
	});

	test('发送失败时恢复输入框文本和文件', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		vi.spyOn(chatStore, 'sendMessage').mockResolvedValue({ accepted: false });
		await flushPromises();

		const files = [{ name: 'pic.png', isImg: true }];
		wrapper.vm.inputText = 'hello';
		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'hello', files });
		await flushPromises();

		expect(wrapper.vm.inputText).toBe('hello');
		expect(mockRestoreFiles).toHaveBeenCalledWith(files);
	});

	test('发送异常时恢复输入框和文件并显示 notify', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		chatStore.__accepted = false;
		vi.spyOn(chatStore, 'sendMessage').mockRejectedValue(new Error('fail'));
		await flushPromises();

		const files = [{ name: 'doc.pdf' }];
		wrapper.vm.inputText = 'hello';
		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'hello', files });
		await flushPromises();

		expect(wrapper.vm.inputText).toBe('hello');
		expect(mockNotify.error).toHaveBeenCalledWith('fail');
		expect(mockRestoreFiles).toHaveBeenCalledWith(files);
	});

	test('发送异常但 __accepted 为 true 时不恢复输入框', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		vi.spyOn(chatStore, 'sendMessage').mockImplementation(async () => {
			chatStore.__accepted = true;
			throw new Error('fail');
		});
		await flushPromises();

		wrapper.vm.inputText = 'hello';
		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'hello', files: [] });
		await flushPromises();

		// __accepted 为 true 时不恢复
		expect(wrapper.vm.inputText).toBe('');
	});

	test('空文本和空文件时不发送', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		const sendSpy = vi.spyOn(chatStore, 'sendMessage');
		await flushPromises();

		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: '', files: [] });
		await flushPromises();

		expect(sendSpy).not.toHaveBeenCalled();
	});

	test('sending 中不重复发送', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		chatStore.sending = true;
		const sendSpy = vi.spyOn(chatStore, 'sendMessage');
		await flushPromises();

		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'hello', files: [] });
		await flushPromises();

		expect(sendSpy).not.toHaveBeenCalled();
	});
});

describe('ChatPage new topic', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		chatStoreManager.__reset();
	});

	test('onNewTopic 导航到 topics/new 并携带 agent/bot query', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		chatStore.botId = 'bot-1';
		chatStore.chatSessionKey = 'agent:main:main';
		await flushPromises();

		wrapper.vm.onNewTopic();

		expect(mockRouter.push).toHaveBeenCalledWith({
			name: 'topics-chat',
			params: { sessionId: 'new' },
			query: { agent: 'main', bot: 'bot-1' },
		});
	});

	test('onNewTopic 从 topic 页面用 replace 导航（避免话题栈堆积）', async () => {
		// 先设置 topicsStore 使 chatStore computed 能解析 topic
		const { useTopicsStore } = await import('../stores/topics.store.js');
		const wrapper = createWrapper({ routeName: 'topics-chat', sessionId: 'sess-1' });
		const topicsStore = useTopicsStore();
		topicsStore.items = [{ topicId: 'sess-1', agentId: 'main', title: null, createdAt: 100, botId: 'bot-2' }];
		await flushPromises();

		wrapper.vm.onNewTopic();

		expect(mockRouter.replace).toHaveBeenCalledWith({
			name: 'topics-chat',
			params: { sessionId: 'new' },
			query: { agent: 'main', bot: 'bot-2' },
		});
		expect(mockRouter.push).not.toHaveBeenCalled();
	});

	test('showNewTopicBtn 在 topic 路由下始终为 true', async () => {
		const wrapper = createWrapper({ routeName: 'topics-chat', sessionId: 'sess-1' });
		await flushPromises();
		expect(wrapper.vm.showNewTopicBtn).toBe(true);
	});

	test('showNewTopicBtn 在非 main agent 的 session 页面为 false', async () => {
		const wrapper = createWrapper({ agentId: 'tester' });
		await flushPromises();
		expect(wrapper.vm.showNewTopicBtn).toBe(false);
	});
});

describe('ChatPage cancel and cleanup', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		chatStoreManager.__reset();
	});

	test('onCancelSend 调用 chatStore.cancelSend', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		const cancelSpy = vi.spyOn(chatStore, 'cancelSend');
		await flushPromises();

		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('cancel');
		await flushPromises();

		expect(cancelSpy).toHaveBeenCalled();
	});

	test('beforeUnmount 调用 chatStore.cleanup', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		const cleanupSpy = vi.spyOn(chatStore, 'cleanup');
		await flushPromises();

		wrapper.unmount();

		expect(cleanupSpy).toHaveBeenCalled();
	});
});

describe('ChatPage watchers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		chatStoreManager.__reset();
	});

	test('bot 离线时取消发送', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		chatStore.botId = 'bot-1';
		const cancelSpy = vi.spyOn(chatStore, 'cancelSend');

		const botsStore = useBotsStore();
		botsStore.setBots([{ id: 'bot-1', name: 'Bot', online: true }]);
		await wrapper.vm.$nextTick();

		// bot 下线
		botsStore.updateBotOnline('bot-1', false);
		await wrapper.vm.$nextTick();

		expect(cancelSpy).toHaveBeenCalled();
	});

	test('bot 重新上线时加载消息', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		chatStore.botId = 'bot-1';
		const loadSpy = vi.spyOn(chatStore, 'loadMessages').mockResolvedValue(true);

		const botsStore = useBotsStore();
		botsStore.setBots([{ id: 'bot-1', name: 'Bot', online: false }]);
		await wrapper.vm.$nextTick();

		// bot 上线
		botsStore.updateBotOnline('bot-1', true);
		await wrapper.vm.$nextTick();

		expect(loadSpy).toHaveBeenCalled();
	});

	test('bot 解绑后跳转', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		chatStore.botId = 'bot-1';
		const cleanupSpy = vi.spyOn(chatStore, 'cleanup');

		const botsStore = useBotsStore();
		botsStore.setBots([{ id: 'bot-1', name: 'Bot', online: true }]);
		botsStore.fetched = true;
		await wrapper.vm.$nextTick();

		// bot 从列表移除（模拟解绑）→ __retryActivation 检测到 bot 不存在 → __exitChat
		botsStore.setBots([]);
		await wrapper.vm.$nextTick();

		expect(cleanupSpy).toHaveBeenCalled();
		expect(mockNotify.warning).toHaveBeenCalledWith('Bot has been unbound');
		expect(mockRouter.replace).toHaveBeenCalledWith('/');
	});

	test('messages 变化触发滚动', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		await flushPromises();

		const scrollSpy = vi.spyOn(wrapper.vm, 'scrollToBottom');
		chatStore.messages = [{ type: 'message', id: 'msg-1', message: { role: 'user', content: 'hi' } }];
		await wrapper.vm.$nextTick();

		expect(scrollSpy).toHaveBeenCalled();
	});
});

describe('ChatPage scroll', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		chatStoreManager.__reset();
	});

	test('用户滚动到非底部时 userScrolledUp 为 true', async () => {
		const wrapper = createWrapper();
		await flushPromises();

		expect(wrapper.vm.userScrolledUp).toBe(false);

		// 模拟 scroll：设置 scrollContainer 属性
		const scrollContainer = wrapper.vm.$refs.scrollContainer;
		if (scrollContainer) {
			Object.defineProperties(scrollContainer, {
				scrollHeight: { value: 1000 },
				scrollTop: { value: 0 },
				clientHeight: { value: 500 },
			});
			wrapper.vm.onScroll();
			expect(wrapper.vm.userScrolledUp).toBe(true);
		}
	});
});
