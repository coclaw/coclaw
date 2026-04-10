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
const mockClearInputFiles = vi.fn();
const mockRemoveFileById = vi.fn();
const mockAddFiles = vi.fn();
vi.mock('../components/ChatInput.vue', () => ({
	default: {
		name: 'ChatInput',
		props: ['modelValue', 'sending', 'disabled'],
		emits: ['update:modelValue', 'send', 'cancel'],
		template: '<div class="input-stub" />',
		methods: {
			restoreFiles: (...args) => mockRestoreFiles(...args),
			clearInputFiles: (...args) => mockClearInputFiles(...args),
			removeFileById: (...args) => mockRemoveFileById(...args),
			addFiles: (...args) => mockAddFiles(...args),
		},
	},
}));

// --- mock 服务/stores ---
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

vi.mock('../services/claws.api.js', () => ({
	listClaws: vi.fn().mockResolvedValue([]),
}));

vi.mock('../utils/file-helper.js', async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual };
});

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
import { useClawsStore } from '../stores/claws.store.js';
import { useAgentsStore } from '../stores/agents.store.js';

/** 获取 ChatPage 内部使用的 store 实例（与组件使用同一个 manager） */
function getChatStore(clawId = 'bot-1', agentId = 'main') {
	return chatStoreManager.get(`session:${clawId}:${agentId}`, { clawId, agentId });
}

const i18nMap = {
	'chat.loading': 'Loading...',
	'chat.empty': 'No messages',
	'chat.clawOffline': 'Claw is offline',
	'chat.clawUnbound': 'Bot has been unbound',
	'topic.newTopic': 'New topic',
	'topic.createFailed': 'Failed to create topic',
	'chat.errRpcTimeout': 'Message timed out',
	'chat.errPreAcceptTimeout': 'Agent response timed out',
	'chat.errWsClosed': 'Connection lost',
	'chat.errWsSendFailed': 'Send failed (ws)',
	'chat.errRtcSendFailed': 'Send failed (rtc)',
	'chat.errUnknown': 'Something went wrong',
};

const mockRouter = { push: vi.fn(), replace: vi.fn() };

/** 设置 agentsStore 使 agentVerified 返回 true */
function setupAgents(clawId = 'bot-1', agentId = 'main') {
	const agentsStore = useAgentsStore();
	agentsStore.byClaw[clawId] = {
		agents: [{ id: agentId }],
		defaultId: agentId,
		loading: false,
		fetched: true,
	};
}

function createWrapper(opts = {}) {
	const { clawId = 'bot-1', agentId = 'main', routeName = 'chat', sessionId, query } = typeof opts === 'string'
		? { clawId: opts } // 兼容旧调用
		: opts;
	const pinia = createPinia();
	setActivePinia(pinia);
	const params = routeName === 'topics-chat'
		? { sessionId: sessionId || 'new' }
		: { clawId, agentId };
	const prefix = routeName === 'topics-chat' ? '/topics' : '/chat';
	const path = routeName === 'topics-chat'
		? `${prefix}/${params.sessionId}`
		: `${prefix}/${clawId}/${agentId}`;
	return mount(ChatPage, {
		global: {
			plugins: [pinia],
			mocks: {
				$t: (key, p) => {
					return i18nMap[key] ?? key;
				},
				$route: {
					name: routeName,
					params,
					path,
					query: query || {},
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
		expect(chatStore.clawId).toBe('bot-1');
		expect(chatStore.chatSessionKey).toBe('agent:main:main');
		expect(chatStore.__initialized).toBe(true);
	});

	test('显示 loading 状态', async () => {
		const wrapper = createWrapper();
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
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
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
		setupAgents();
		const chatStore = getChatStore();
		chatStore.errorText = 'Something went wrong';
		await wrapper.vm.$nextTick();

		expect(wrapper.vm.isLoadingChat).toBe(false);
		expect(wrapper.text()).toContain('Something went wrong');
	});

	test('显示空消息状态', async () => {
		const wrapper = createWrapper();
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
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
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
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

	test('chatTitle routeClawId 为空时返回空字符串', async () => {
		const wrapper = createWrapper({ clawId: '' });
		await flushPromises();

		expect(wrapper.vm.chatTitle).toBe('');
	});

	test('显示 bot 离线提示', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		chatStore.clawId = 'bot-1';

		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'MyBot', online: false }]);
		await wrapper.vm.$nextTick();

		expect(wrapper.text()).toContain('Claw is offline');
	});

	test('ChatInput 在无 clawId 时不渲染', async () => {
		const wrapper = createWrapper({ clawId: '' });
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

		expect(sendSpy).toHaveBeenCalledWith('hello', [], expect.objectContaining({ onFileUploaded: expect.any(Function) }));
		expect(wrapper.vm.inputText).toBe('');
	});

	test('onFileUploaded 回调调用 chatInput.removeFileById', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		// sendMessage 在执行过程中调用 onFileUploaded
		vi.spyOn(chatStore, 'sendMessage').mockImplementation(async (_text, _files, opts) => {
			opts?.onFileUploaded?.({ id: 'f1' });
			opts?.onFileUploaded?.({ id: 'f2' });
			return { accepted: true };
		});
		await flushPromises();

		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'hi', files: [{ id: 'f1' }, { id: 'f2' }] });
		await flushPromises();

		expect(mockRemoveFileById).toHaveBeenCalledTimes(2);
		expect(mockRemoveFileById).toHaveBeenCalledWith('f1');
		expect(mockRemoveFileById).toHaveBeenCalledWith('f2');
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
		expect(mockClearInputFiles).toHaveBeenCalled();
		expect(mockRestoreFiles).toHaveBeenCalledWith(files);
	});

	test('发送异常时恢复输入框和文件并显示友好 notify（未知错误）', async () => {
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
		// 未知错误码 → 通用友好文案
		expect(mockNotify.error).toHaveBeenCalledWith('Something went wrong');
		expect(mockClearInputFiles).toHaveBeenCalled();
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

	test('RPC_TIMEOUT 错误显示友好文案并回填输入框', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		chatStore.__accepted = false;
		const err = new Error('rpc timeout');
		err.code = 'RPC_TIMEOUT';
		vi.spyOn(chatStore, 'sendMessage').mockRejectedValue(err);
		await flushPromises();

		wrapper.vm.inputText = 'my message';
		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'my message', files: [] });
		await flushPromises();

		expect(mockNotify.error).toHaveBeenCalledWith('Message timed out');
		expect(wrapper.vm.inputText).toBe('my message');
	});

	test('PRE_ACCEPTANCE_TIMEOUT 错误显示友好文案并回填输入框', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		chatStore.__accepted = false;
		const err = new Error('pre-acceptance timeout');
		err.code = 'PRE_ACCEPTANCE_TIMEOUT';
		vi.spyOn(chatStore, 'sendMessage').mockRejectedValue(err);
		await flushPromises();

		wrapper.vm.inputText = 'my message';
		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'my message', files: [] });
		await flushPromises();

		expect(mockNotify.error).toHaveBeenCalledWith('Agent response timed out');
		expect(wrapper.vm.inputText).toBe('my message');
	});

	test('WS_CLOSED 错误显示友好文案并回填输入框', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		chatStore.__accepted = false;
		const err = new Error('not connected');
		err.code = 'WS_CLOSED';
		vi.spyOn(chatStore, 'sendMessage').mockRejectedValue(err);
		await flushPromises();

		wrapper.vm.inputText = 'my message';
		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'my message', files: [] });
		await flushPromises();

		expect(mockNotify.error).toHaveBeenCalledWith('Connection lost');
		expect(wrapper.vm.inputText).toBe('my message');
	});

	test('WS_SEND_FAILED 错误显示友好文案', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		chatStore.__accepted = false;
		const err = new Error('ws send failed');
		err.code = 'WS_SEND_FAILED';
		vi.spyOn(chatStore, 'sendMessage').mockRejectedValue(err);
		await flushPromises();

		wrapper.vm.inputText = 'my message';
		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'my message', files: [] });
		await flushPromises();

		expect(mockNotify.error).toHaveBeenCalledWith('Send failed (ws)');
	});

	test('RTC_SEND_FAILED 错误显示友好文案', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		chatStore.__accepted = false;
		const err = new Error('rtc send failed');
		err.code = 'RTC_SEND_FAILED';
		vi.spyOn(chatStore, 'sendMessage').mockRejectedValue(err);
		await flushPromises();

		wrapper.vm.inputText = 'my message';
		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'my message', files: [] });
		await flushPromises();

		expect(mockNotify.error).toHaveBeenCalledWith('Send failed (rtc)');
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
		chatStore.clawId = 'bot-1';
		chatStore.chatSessionKey = 'agent:main:main';
		await flushPromises();

		wrapper.vm.onNewTopic();

		expect(mockRouter.push).toHaveBeenCalledWith({
			name: 'topics-chat',
			params: { sessionId: 'new' },
			query: { agent: 'main', claw: 'bot-1' },
		});
	});

	test('onNewTopic 从 topic 页面用 replace 导航（避免话题栈堆积）', async () => {
		// 先设置 topicsStore 使 chatStore computed 能解析 topic
		const { useTopicsStore } = await import('../stores/topics.store.js');
		const wrapper = createWrapper({ routeName: 'topics-chat', sessionId: 'sess-1' });
		const topicsStore = useTopicsStore();
		topicsStore.byId = { 'sess-1': { topicId: 'sess-1', agentId: 'main', title: null, createdAt: 100, clawId: 'bot-2' } };
		await flushPromises();

		wrapper.vm.onNewTopic();

		expect(mockRouter.replace).toHaveBeenCalledWith({
			name: 'topics-chat',
			params: { sessionId: 'new' },
			query: { agent: 'main', claw: 'bot-2' },
		});
		expect(mockRouter.push).not.toHaveBeenCalled();
	});

	test('newTopicReady 在 claw 存在时为 true，不依赖 dcReady', async () => {
		const wrapper = createWrapper({
			routeName: 'topics-chat', sessionId: 'new',
			query: { claw: 'bot-1', agent: 'main' },
		});
		// createWrapper 内部创建 pinia，之后再获取 store
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
		// dcReady 默认为 falsy，不影响 newTopicReady
		await flushPromises();
		expect(wrapper.vm.newTopicReady).toBe(true);
	});

	test('newTopicReady 在 claw 不存在时为 false', async () => {
		const wrapper = createWrapper({
			routeName: 'topics-chat', sessionId: 'new',
			query: { claw: 'non-existent', agent: 'main' },
		});
		await flushPromises();
		expect(wrapper.vm.newTopicReady).toBe(false);
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

	test('onSlashCommand 异常时 log warning 并 notify error', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		const err = new Error('slash fail');
		vi.spyOn(chatStore, 'sendSlashCommand').mockRejectedValue(err);
		await flushPromises();

		await wrapper.vm.onSlashCommand('/reset');

		expect(warnSpy).toHaveBeenCalledWith('[ChatPage] onSlashCommand failed:', err);
		expect(mockNotify.error).toHaveBeenCalledWith('slash fail');
		warnSpy.mockRestore();
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
		chatStore.clawId = 'bot-1';
		const cancelSpy = vi.spyOn(chatStore, 'cancelSend');

		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
		await wrapper.vm.$nextTick();

		// bot 下线
		clawsStore.updateClawOnline('bot-1', false);
		await wrapper.vm.$nextTick();

		expect(cancelSpy).toHaveBeenCalled();
	});

	test('bot 重新上线且连接就绪时 connReady 驱动加载消息', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		chatStore.clawId = 'bot-1';
		chatStore.__messagesLoaded = false;
		const loadSpy = vi.spyOn(chatStore, 'loadMessages').mockResolvedValue(true);

		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: false }]);
		setupAgents();
		await wrapper.vm.$nextTick();

		// bot 上线 + 连接就绪 → connReady 变为 true
		clawsStore.byId['bot-1'].online = true;
		clawsStore.byId['bot-1'].dcReady = true;
		await wrapper.vm.$nextTick();

		expect(loadSpy).toHaveBeenCalled();
	});

	test('connReady immediate: 挂载时 bot 已连接则立即加载消息', async () => {
		// 预创建 pinia 并填充 bot 状态，模拟"返回列表后再进入会话"
		const pinia = createPinia();
		setActivePinia(pinia);

		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
		clawsStore.byId['bot-1'].dcReady = true;
		setupAgents();

		// 预创建 chatStore 并挂 spy（组件 computed 会复用同一实例）
		const chatStore = chatStoreManager.get('session:bot-1:main', { clawId: 'bot-1', agentId: 'main' });
		chatStore.__initialized = true; // 模拟已初始化过（非首次进入）
		chatStore.__messagesLoaded = true;
		const loadSpy = vi.spyOn(chatStore, 'loadMessages').mockResolvedValue(true);

		mount(ChatPage, {
			global: {
				plugins: [pinia],
				mocks: {
					$t: (key) => i18nMap[key] ?? key,
					$route: {
						name: 'chat',
						params: { clawId: 'bot-1', agentId: 'main' },
						path: '/chat/bot-1/main',
						query: {},
					},
					$router: mockRouter,
				},
			},
		});
		await flushPromises();

		// connReady 在挂载时即为 true，immediate watcher 应触发 loadMessages
		expect(loadSpy).toHaveBeenCalled();
	});

	test('connReady immediate: sending=true 时跳过静默刷新 (#235)', async () => {
		// 防止 isSending → sending 的修改被回退（即使有僵尸 run，sending 真的发送中也不应触发 reload）
		const pinia = createPinia();
		setActivePinia(pinia);

		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
		clawsStore.byId['bot-1'].dcReady = true;
		setupAgents();

		const chatStore = chatStoreManager.get('session:bot-1:main', { clawId: 'bot-1', agentId: 'main' });
		chatStore.__initialized = true;
		chatStore.__messagesLoaded = true;
		chatStore.sending = true; // 真实发送中
		const loadSpy = vi.spyOn(chatStore, 'loadMessages').mockResolvedValue(true);

		mount(ChatPage, {
			global: {
				plugins: [pinia],
				mocks: {
					$t: (key) => i18nMap[key] ?? key,
					$route: {
						name: 'chat',
						params: { clawId: 'bot-1', agentId: 'main' },
						path: '/chat/bot-1/main',
						query: {},
					},
					$router: mockRouter,
				},
			},
		});
		await flushPromises();

		// sending=true 时 __onConnReady 不应触发静默刷新
		expect(loadSpy).not.toHaveBeenCalled();
	});

	test('chatStore watcher 重置 userScrolledUp 和 __scrollReady', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		chatStore.clawId = 'bot-1';

		// 模拟用户已滚动和 scroll 就绪
		wrapper.vm.userScrolledUp = true;
		wrapper.vm.__scrollReady = true;

		// 直接调用 chatStore watcher handler 测试重置行为
		const newStore = chatStoreManager.get('session:bot-1:alt', { clawId: 'bot-1', agentId: 'alt' });
		vi.spyOn(newStore, 'activate').mockImplementation(() => {});
		wrapper.vm.$options.watch.chatStore.handler.call(wrapper.vm, newStore, chatStore);

		expect(wrapper.vm.userScrolledUp).toBe(false);
	});

	test('chatStore watcher 在 connReady 为 true 时调用 __onConnReady', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		chatStore.clawId = 'bot-1';

		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
		clawsStore.byId['bot-1'].dcReady = true;
		setupAgents();
		await wrapper.vm.$nextTick();

		// spy __onConnReady
		const onConnReadySpy = vi.spyOn(wrapper.vm, '__onConnReady').mockImplementation(() => {});
		const newStore = chatStoreManager.get('session:bot-1:alt2', { clawId: 'bot-1', agentId: 'main' });
		vi.spyOn(newStore, 'activate').mockImplementation(() => {});

		// 直接触发 watcher（绕过路由）
		wrapper.vm.$options.watch.chatStore.handler.call(wrapper.vm, newStore, chatStore);

		// connReady 为 true → __onConnReady 应被调用
		expect(onConnReadySpy).toHaveBeenCalled();
	});

	test('bot 解绑后跳转', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		chatStore.clawId = 'bot-1';
		const cleanupSpy = vi.spyOn(chatStore, 'cleanup');

		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
		clawsStore.fetched = true;
		await wrapper.vm.$nextTick();

		// bot 从列表移除（模拟解绑）→ __retryActivation 检测到 bot 不存在 → __exitChat
		clawsStore.setClaws([]);
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

describe('ChatPage foreground resume', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		chatStoreManager.__reset();
	});

	test('app:foreground 触发静默刷新（connReady 为 true 时）', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		chatStore.clawId = 'bot-1';
		chatStore.__messagesLoaded = true;
		const loadSpy = vi.spyOn(chatStore, 'loadMessages').mockResolvedValue(true);

		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
		clawsStore.byId['bot-1'].dcReady = true;
		setupAgents();
		await wrapper.vm.$nextTick();

		// 清除 connReady watcher 触发的调用
		loadSpy.mockClear();

		// 重置去重时间戳
		wrapper.vm.__lastResumeAt = 0;

		window.dispatchEvent(new CustomEvent('app:foreground'));
		await wrapper.vm.$nextTick();

		expect(loadSpy).toHaveBeenCalledWith({ silent: true });
	});

	test('connReady 为 false 时 app:foreground 不触发刷新', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		chatStore.clawId = 'bot-1';
		const loadSpy = vi.spyOn(chatStore, 'loadMessages').mockResolvedValue(true);

		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: false }]);
		await wrapper.vm.$nextTick();
		loadSpy.mockClear();

		window.dispatchEvent(new CustomEvent('app:foreground'));
		await wrapper.vm.$nextTick();

		expect(loadSpy).not.toHaveBeenCalled();
	});

	test('2s 内不重复触发前台恢复', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		chatStore.clawId = 'bot-1';
		chatStore.__messagesLoaded = true;
		const loadSpy = vi.spyOn(chatStore, 'loadMessages').mockResolvedValue(true);

		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
		clawsStore.byId['bot-1'].dcReady = true;
		setupAgents();
		await wrapper.vm.$nextTick();
		loadSpy.mockClear();
		wrapper.vm.__lastResumeAt = 0;

		window.dispatchEvent(new CustomEvent('app:foreground'));
		window.dispatchEvent(new CustomEvent('app:foreground'));
		await wrapper.vm.$nextTick();

		// 只触发一次
		expect(loadSpy).toHaveBeenCalledTimes(1);
	});

	test('connReady watcher 与 foreground 去重', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		chatStore.clawId = 'bot-1';
		chatStore.__messagesLoaded = true;
		const loadSpy = vi.spyOn(chatStore, 'loadMessages').mockResolvedValue(true);

		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
		clawsStore.byId['bot-1'].dcReady = true;
		setupAgents();
		await wrapper.vm.$nextTick();

		// connReady watcher 已触发 loadMessages
		expect(loadSpy).toHaveBeenCalled();
		loadSpy.mockClear();

		// 紧接着触发 app:foreground，应被去重跳过
		window.dispatchEvent(new CustomEvent('app:foreground'));
		await wrapper.vm.$nextTick();

		expect(loadSpy).not.toHaveBeenCalled();
	});

	test('app:foreground 僵尸 run（idle）时强制静默刷新 (#235)', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		chatStore.clawId = 'bot-1';
		chatStore.__messagesLoaded = true;
		const loadSpy = vi.spyOn(chatStore, 'loadMessages').mockResolvedValue(true);
		const reconcileSpy = vi.spyOn(chatStore, '__reconcileSlashCommand').mockImplementation(() => {});

		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
		clawsStore.byId['bot-1'].dcReady = true;
		setupAgents();
		await wrapper.vm.$nextTick();
		loadSpy.mockClear();
		reconcileSpy.mockClear();

		// 模拟僵尸 run（isSending=true, sending=false, isRunIdle=true）
		const { useAgentRunsStore } = await import('../stores/agent-runs.store.js');
		const runsStore = useAgentRunsStore();
		runsStore.runs['run-z'] = {
			runId: 'run-z', clawId: 'bot-1', runKey: chatStore.runKey,
			settled: false, settling: false, lastEventAt: Date.now() - 15_000,
			streamingMsgs: [], __timer: null,
		};
		runsStore.runKeyIndex[chatStore.runKey] = 'run-z';

		wrapper.vm.__lastResumeAt = 0;
		window.dispatchEvent(new CustomEvent('app:foreground'));
		await wrapper.vm.$nextTick();

		expect(loadSpy).toHaveBeenCalledWith({ silent: true });
		expect(reconcileSpy).toHaveBeenCalled();
	});

	test('app:foreground 活跃 run（非 idle）时不触发刷新', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		chatStore.clawId = 'bot-1';
		chatStore.__messagesLoaded = true;
		const loadSpy = vi.spyOn(chatStore, 'loadMessages').mockResolvedValue(true);

		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
		clawsStore.byId['bot-1'].dcReady = true;
		setupAgents();
		await wrapper.vm.$nextTick();
		loadSpy.mockClear();

		// 模拟活跃 run（lastEventAt 很近）
		const { useAgentRunsStore } = await import('../stores/agent-runs.store.js');
		const runsStore = useAgentRunsStore();
		runsStore.runs['run-a'] = {
			runId: 'run-a', clawId: 'bot-1', runKey: chatStore.runKey,
			settled: false, settling: false, lastEventAt: Date.now(),
			streamingMsgs: [], __timer: null,
		};
		runsStore.runKeyIndex[chatStore.runKey] = 'run-a';

		wrapper.vm.__lastResumeAt = 0;
		window.dispatchEvent(new CustomEvent('app:foreground'));
		await wrapper.vm.$nextTick();

		expect(loadSpy).not.toHaveBeenCalled();
	});

	test('unmount 后移除 app:foreground 监听器', async () => {
		const removeSpy = vi.spyOn(window, 'removeEventListener');
		const wrapper = createWrapper();
		await flushPromises();

		wrapper.unmount();

		expect(removeSpy).toHaveBeenCalledWith('app:foreground', expect.any(Function));
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

	test('scrollToBottom $nextTick 内二次检查 userScrolledUp（竞态防护）', async () => {
		const wrapper = createWrapper();
		await flushPromises();

		const scrollContainer = wrapper.vm.$refs.scrollContainer;
		if (!scrollContainer) return;

		const scrollToSpy = vi.fn();
		scrollContainer.scrollTo = scrollToSpy;
		Object.defineProperties(scrollContainer, {
			scrollHeight: { value: 1000, configurable: true },
			scrollTop: { value: 940, configurable: true, writable: true },
			clientHeight: { value: 500, configurable: true },
		});

		// 初始状态：用户在底部
		wrapper.vm.userScrolledUp = false;

		// 调用 scrollToBottom，同步检查通过，$nextTick 入队
		wrapper.vm.scrollToBottom();

		// 模拟竞态：$nextTick 排队期间用户上划
		wrapper.vm.userScrolledUp = true;

		// 等待 $nextTick 和 rAF 执行
		await wrapper.vm.$nextTick();
		await new Promise(r => requestAnimationFrame(r));

		// 二次检查应阻止 scrollTo 调用
		expect(scrollToSpy).not.toHaveBeenCalled();
	});

	test('scrollToBottom force=true 即使 userScrolledUp 也执行滚动', async () => {
		const wrapper = createWrapper();
		await flushPromises();

		const scrollContainer = wrapper.vm.$refs.scrollContainer;
		if (!scrollContainer) return;

		const scrollToSpy = vi.fn();
		scrollContainer.scrollTo = scrollToSpy;
		Object.defineProperties(scrollContainer, {
			scrollHeight: { value: 1000, configurable: true },
			scrollTop: { value: 940, configurable: true, writable: true },
			clientHeight: { value: 500, configurable: true },
		});

		wrapper.vm.userScrolledUp = true;

		wrapper.vm.scrollToBottom(true);

		await wrapper.vm.$nextTick();
		await new Promise(r => requestAnimationFrame(r));

		// force=true 时应忽略 userScrolledUp，执行 scrollTo
		expect(scrollToSpy).toHaveBeenCalled();
	});

	// --- ResizeObserver ---
	describe('ResizeObserver', () => {
		let savedRO;
		beforeEach(() => { savedRO = globalThis.ResizeObserver; });
		afterEach(() => { globalThis.ResizeObserver = savedRO; });

		test('mounted 时对 scrollContainer 和 scrollContent 注册，unmount 时 disconnect', async () => {
			const observedEls = [];
			const disconnectSpy = vi.fn();
			globalThis.ResizeObserver = class {
				constructor(cb) { this.cb = cb; }
				observe(el) { observedEls.push(el); }
				unobserve() {}
				disconnect() { disconnectSpy(); }
			};

			const wrapper = createWrapper();
			await flushPromises();

			const sc = wrapper.vm.$refs.scrollContainer;
			const content = wrapper.vm.$refs.scrollContent;
			expect(observedEls).toContain(sc);
			expect(observedEls).toContain(content);

			wrapper.unmount();
			expect(disconnectSpy).toHaveBeenCalled();
		});

		test('回调触发 scrollToBottom', async () => {
			let resizeCb;
			globalThis.ResizeObserver = class {
				constructor(cb) { resizeCb = cb; }
				observe() {}
				unobserve() {}
				disconnect() {}
			};

			const wrapper = createWrapper();
			await flushPromises();

			const scrollSpy = vi.spyOn(wrapper.vm, 'scrollToBottom');
			resizeCb();
			expect(scrollSpy).toHaveBeenCalled();
		});

		test('userScrolledUp 时回调不实际滚动', async () => {
			let resizeCb;
			globalThis.ResizeObserver = class {
				constructor(cb) { resizeCb = cb; }
				observe() {}
				unobserve() {}
				disconnect() {}
			};

			const wrapper = createWrapper();
			await flushPromises();

			const scrollContainer = wrapper.vm.$refs.scrollContainer;
			if (!scrollContainer) return;
			const scrollToSpy = vi.fn();
			scrollContainer.scrollTo = scrollToSpy;
			Object.defineProperties(scrollContainer, {
				scrollHeight: { value: 1000, configurable: true },
				scrollTop: { value: 0, configurable: true, writable: true },
				clientHeight: { value: 500, configurable: true },
			});

			wrapper.vm.userScrolledUp = true;
			resizeCb();

			await wrapper.vm.$nextTick();
			await new Promise(r => requestAnimationFrame(r));

			expect(scrollToSpy).not.toHaveBeenCalled();
		});

		test('__loadingHistory 时回调不实际滚动', async () => {
			let resizeCb;
			globalThis.ResizeObserver = class {
				constructor(cb) { resizeCb = cb; }
				observe() {}
				unobserve() {}
				disconnect() {}
			};

			const wrapper = createWrapper();
			await flushPromises();

			const scrollContainer = wrapper.vm.$refs.scrollContainer;
			if (!scrollContainer) return;
			const scrollToSpy = vi.fn();
			scrollContainer.scrollTo = scrollToSpy;

			wrapper.vm.__loadingHistory = true;
			resizeCb();

			await wrapper.vm.$nextTick();
			await new Promise(r => requestAnimationFrame(r));

			expect(scrollToSpy).not.toHaveBeenCalled();
		});
	});

	// --- 拖拽上传 ---
	test('dragover 设置 dragging=true', async () => {
		const wrapper = createWrapper();
		await flushPromises();
		const root = wrapper.find('[data-testid="chat-root"]');
		expect(wrapper.vm.dragging).toBe(false);

		const evt = new Event('dragover', { bubbles: true });
		evt.preventDefault = vi.fn();
		Object.defineProperty(evt, 'dataTransfer', { value: { types: ['Files'] } });
		root.element.dispatchEvent(evt);

		expect(wrapper.vm.dragging).toBe(true);
		expect(evt.preventDefault).toHaveBeenCalled();
	});

	test('dragleave 离开根元素时设置 dragging=false', async () => {
		const wrapper = createWrapper();
		await flushPromises();
		const root = wrapper.find('[data-testid="chat-root"]');
		wrapper.vm.dragging = true;

		// relatedTarget 不在根元素内 → 离开
		const evt = new Event('dragleave', { bubbles: true });
		Object.defineProperty(evt, 'relatedTarget', { value: document.body });
		root.element.dispatchEvent(evt);

		expect(wrapper.vm.dragging).toBe(false);
	});

	test('dragleave 在子元素间移动时不关闭蒙层', async () => {
		const wrapper = createWrapper();
		await flushPromises();
		const root = wrapper.find('[data-testid="chat-root"]');
		wrapper.vm.dragging = true;

		// relatedTarget 在根元素内 → 不关闭
		const child = root.element.querySelector('.input-stub') || root.element.firstElementChild;
		const evt = new Event('dragleave', { bubbles: true });
		Object.defineProperty(evt, 'relatedTarget', { value: child });
		root.element.dispatchEvent(evt);

		expect(wrapper.vm.dragging).toBe(true);
	});

	test('drop 将文件传递给 chatInput.addFiles', async () => {
		const wrapper = createWrapper();
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
		setupAgents();
		await flushPromises();

		const root = wrapper.find('[data-testid="chat-root"]');
		wrapper.vm.dragging = true;

		const file = new File(['hello'], 'test.txt', { type: 'text/plain' });
		const evt = new Event('drop', { bubbles: true });
		evt.preventDefault = vi.fn();
		Object.defineProperty(evt, 'dataTransfer', { value: { files: [file] } });
		root.element.dispatchEvent(evt);

		expect(evt.preventDefault).toHaveBeenCalled();
		expect(wrapper.vm.dragging).toBe(false);
		expect(mockAddFiles).toHaveBeenCalledWith([file]);
	});

	test('drop 无文件时不调用 addFiles', async () => {
		mockAddFiles.mockClear();
		const wrapper = createWrapper();
		await flushPromises();
		const root = wrapper.find('[data-testid="chat-root"]');

		const evt = new Event('drop', { bubbles: true });
		evt.preventDefault = vi.fn();
		Object.defineProperty(evt, 'dataTransfer', { value: { files: [] } });
		root.element.dispatchEvent(evt);

		expect(wrapper.vm.dragging).toBe(false);
		expect(mockAddFiles).not.toHaveBeenCalled();
	});

	test('拖拽蒙层在 dragging=true 时显示', async () => {
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.text()).not.toContain('files.dropHint');

		await wrapper.setData({ dragging: true });
		expect(wrapper.text()).toContain('files.dropHint');
	});

	test('dragleave relatedTarget=null（离开浏览器窗口）关闭蒙层', async () => {
		const wrapper = createWrapper();
		await flushPromises();
		const root = wrapper.find('[data-testid="chat-root"]');
		wrapper.vm.dragging = true;

		const evt = new Event('dragleave', { bubbles: true });
		Object.defineProperty(evt, 'relatedTarget', { value: null });
		root.element.dispatchEvent(evt);

		expect(wrapper.vm.dragging).toBe(false);
	});

	test('dragover 非文件拖拽不显示蒙层', async () => {
		const wrapper = createWrapper();
		await flushPromises();
		const root = wrapper.find('[data-testid="chat-root"]');

		const evt = new Event('dragover', { bubbles: true });
		evt.preventDefault = vi.fn();
		// 模拟拖拽文本（types 中无 Files）
		Object.defineProperty(evt, 'dataTransfer', { value: { types: ['text/plain'] } });
		root.element.dispatchEvent(evt);

		expect(wrapper.vm.dragging).toBe(false);
		expect(evt.preventDefault).not.toHaveBeenCalled();
	});
});
