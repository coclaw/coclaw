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

vi.mock('../utils/capacitor-app.js', () => ({
	isNative: false,
}));

import ChatPage from './ChatPage.vue';
import { useChatStore } from '../stores/chat.store.js';
import { useBotsStore } from '../stores/bots.store.js';
import { useSessionsStore } from '../stores/sessions.store.js';

const i18nMap = {
	'chat.loading': 'Loading...',
	'chat.empty': 'No messages',
	'chat.orphanSendFailed': 'Orphan send failed',
	'chat.newChatFailed': 'New chat failed',
	'chat.botOffline': 'Bot is offline',
	'chat.botUnbound': 'Bot has been unbound',
};

const mockRouter = { push: vi.fn(), replace: vi.fn() };

function createWrapper(sessionId = 'sess-1') {
	const pinia = createPinia();
	setActivePinia(pinia);
	return mount(ChatPage, {
		global: {
			plugins: [pinia],
			mocks: {
				$t: (key, params) => {
					if (key === 'chat.sessionTitle' && params?.id) return `Session ${params.id}`;
					return i18nMap[key] ?? key;
				},
				$route: {
					params: { sessionId },
					path: `/chat/${sessionId}`,
				},
				$router: mockRouter,
			},
		},
	});
}

describe('ChatPage', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('mounted 时调用 chatStore.activateSession', async () => {
		createWrapper('sess-1');
		await flushPromises();

		const chatStore = useChatStore();
		// activateSession 在 mounted 中被调用
		expect(chatStore.sessionId).toBe('sess-1');
	});

	test('显示 loading 状态', async () => {
		const wrapper = createWrapper('sess-1');
		const chatStore = useChatStore();
		chatStore.loading = true;
		await wrapper.vm.$nextTick();

		expect(wrapper.text()).toContain('Loading...');
	});

	test('显示错误状态', async () => {
		const wrapper = createWrapper('sess-1');
		const chatStore = useChatStore();
		chatStore.loading = false;
		chatStore.errorText = 'Something went wrong';
		await wrapper.vm.$nextTick();

		expect(wrapper.text()).toContain('Something went wrong');
	});

	test('显示空消息状态', async () => {
		const wrapper = createWrapper('sess-1');
		const chatStore = useChatStore();
		chatStore.loading = false;
		chatStore.errorText = '';
		chatStore.messages = [];
		await wrapper.vm.$nextTick();

		expect(wrapper.text()).toContain('No messages');
	});

	test('渲染消息列表', async () => {
		const wrapper = createWrapper('sess-1');
		const chatStore = useChatStore();
		chatStore.loading = false;
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

	test('chatTitle 从 sessions store 中解析', async () => {
		const wrapper = createWrapper('sess-1');
		const sessionsStore = useSessionsStore();
		sessionsStore.setSessions([
			{ sessionId: 'sess-1', title: 'My Chat', indexed: true, botId: 'b1' },
		]);
		await wrapper.vm.$nextTick();

		expect(wrapper.text()).toContain('My Chat');
	});

	test('chatTitle 回退到 sessionTitle 模板', async () => {
		const wrapper = createWrapper('sess-1');
		await flushPromises();

		// 无 session 匹配时使用 sessionTitle 模板
		expect(wrapper.text()).toContain('Session sess-1');
	});

	test('显示 bot 离线提示', async () => {
		const wrapper = createWrapper('sess-1');
		const chatStore = useChatStore();
		chatStore.botId = 'bot-1';

		const botsStore = useBotsStore();
		botsStore.setBots([{ id: 'bot-1', name: 'MyBot', online: false }]);
		await wrapper.vm.$nextTick();

		expect(wrapper.text()).toContain('Bot is offline');
	});

	test('ChatInput disabled 当无 sessionId 时', async () => {
		const wrapper = createWrapper('');
		await flushPromises();

		const input = wrapper.findComponent({ name: 'ChatInput' });
		expect(input.props('disabled')).toBe(true);
	});

	test('ChatInput 绑定 sending 状态', async () => {
		const wrapper = createWrapper('sess-1');
		const chatStore = useChatStore();
		chatStore.sending = true;
		await wrapper.vm.$nextTick();

		const input = wrapper.findComponent({ name: 'ChatInput' });
		expect(input.props('sending')).toBe(true);
	});
});

describe('ChatPage send message', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('onSendMessage 调用 chatStore.sendMessage 并清空输入框', async () => {
		const wrapper = createWrapper('sess-1');
		const chatStore = useChatStore();
		chatStore.sessionId = 'sess-1';
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
		const wrapper = createWrapper('sess-1');
		const chatStore = useChatStore();
		chatStore.sessionId = 'sess-1';
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
		const wrapper = createWrapper('sess-1');
		const chatStore = useChatStore();
		chatStore.sessionId = 'sess-1';
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
		const wrapper = createWrapper('sess-1');
		const chatStore = useChatStore();
		chatStore.sessionId = 'sess-1';
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
		const wrapper = createWrapper('sess-1');
		const chatStore = useChatStore();
		chatStore.sessionId = 'sess-1';
		const sendSpy = vi.spyOn(chatStore, 'sendMessage');
		await flushPromises();

		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: '', files: [] });
		await flushPromises();

		expect(sendSpy).not.toHaveBeenCalled();
	});

	test('sending 中不重复发送', async () => {
		const wrapper = createWrapper('sess-1');
		const chatStore = useChatStore();
		chatStore.sessionId = 'sess-1';
		chatStore.sending = true;
		const sendSpy = vi.spyOn(chatStore, 'sendMessage');
		await flushPromises();

		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'hello', files: [] });
		await flushPromises();

		expect(sendSpy).not.toHaveBeenCalled();
	});
});

describe('ChatPage new chat', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('onNewChat 调用 chatStore.resetChat 并导航', async () => {
		const wrapper = createWrapper('sess-1');
		const chatStore = useChatStore();
		chatStore.sessionId = 'sess-1';
		chatStore.sessionKeyById = { 'sess-1': 'agent:main:main' };
		const resetSpy = vi.spyOn(chatStore, 'resetChat').mockResolvedValue('new-sess');
		await flushPromises();

		await wrapper.vm.onNewChat();

		expect(resetSpy).toHaveBeenCalled();
		expect(mockRouter.push).toHaveBeenCalledWith({ name: 'chat', params: { sessionId: 'new-sess' } });
	});

	test('resetChat 返回 null 时不导航', async () => {
		const wrapper = createWrapper('sess-1');
		const chatStore = useChatStore();
		vi.spyOn(chatStore, 'resetChat').mockResolvedValue(null);
		await flushPromises();

		await wrapper.vm.onNewChat();

		expect(mockRouter.push).not.toHaveBeenCalled();
	});

	test('resetChat 异常时显示通知', async () => {
		const wrapper = createWrapper('sess-1');
		const chatStore = useChatStore();
		vi.spyOn(chatStore, 'resetChat').mockRejectedValue(new Error('reset failed'));
		await flushPromises();

		await wrapper.vm.onNewChat();

		expect(mockNotify.error).toHaveBeenCalledWith('New chat failed');
	});
});

describe('ChatPage cancel and cleanup', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('onCancelSend 调用 chatStore.cancelSend', async () => {
		const wrapper = createWrapper('sess-1');
		const chatStore = useChatStore();
		const cancelSpy = vi.spyOn(chatStore, 'cancelSend');
		await flushPromises();

		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('cancel');
		await flushPromises();

		expect(cancelSpy).toHaveBeenCalled();
	});

	test('beforeUnmount 调用 chatStore.cleanup', async () => {
		const wrapper = createWrapper('sess-1');
		const chatStore = useChatStore();
		const cleanupSpy = vi.spyOn(chatStore, 'cleanup');
		await flushPromises();

		wrapper.unmount();

		expect(cleanupSpy).toHaveBeenCalled();
	});
});

describe('ChatPage watchers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('bot 离线时取消发送', async () => {
		const wrapper = createWrapper('sess-1');
		const chatStore = useChatStore();
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
		const wrapper = createWrapper('sess-1');
		const chatStore = useChatStore();
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
		const wrapper = createWrapper('sess-1');
		const chatStore = useChatStore();
		chatStore.sessionId = 'sess-1';
		chatStore.botId = 'bot-1';
		const cleanupSpy = vi.spyOn(chatStore, 'cleanup');

		const botsStore = useBotsStore();
		botsStore.setBots([{ id: 'bot-1', name: 'Bot', online: true }]);
		await wrapper.vm.$nextTick();

		// bot 从列表移除（模拟解绑）
		botsStore.removeBotById('bot-1');
		// 手动更新 chatStore.botId 为空（模拟 store 清理行为）
		chatStore.botId = '';
		await wrapper.vm.$nextTick();

		expect(cleanupSpy).toHaveBeenCalled();
		expect(mockNotify.warning).toHaveBeenCalledWith('Bot has been unbound');
		expect(mockRouter.replace).toHaveBeenCalled();
	});

	test('messages 变化触发滚动', async () => {
		const wrapper = createWrapper('sess-1');
		const chatStore = useChatStore();
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
	});

	test('用户滚动到非底部时 userScrolledUp 为 true', async () => {
		const wrapper = createWrapper('sess-1');
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
