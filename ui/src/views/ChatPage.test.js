import { mount, flushPromises } from '@vue/test-utils';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

// --- mock 子组件 ---
vi.mock('../components/MobilePageHeader.vue', () => ({
	default: {
		name: 'MobilePageHeader',
		props: ['title'],
		template: '<div class="mph-stub"><div class="mph-title"><slot>{{ title }}</slot></div><slot name="actions" /></div>',
	},
}));
vi.mock('../components/ChatMsgItem.vue', () => ({
	default: {
		name: 'ChatMsgItem',
		props: ['item'],
		template: '<div class="msg-stub">{{ item.id }}</div>',
	},
}));
const mockAddFiles = vi.fn();
vi.mock('../components/ChatInput.vue', () => ({
	default: {
		name: 'ChatInput',
		props: ['modelValue', 'chatStore', 'sending', 'fileUploadState', 'disabled', 'cancelDisabled', 'cancelling'],
		emits: ['update:modelValue', 'send', 'cancel'],
		template: '<div class="input-stub"><slot name="prepend" /></div>',
		methods: {
			// drop 仍走 chatInput.addFiles 入口（ChatInput 内部再调 chatStore.addFiles）
			addFiles: (...args) => mockAddFiles(...args),
		},
	},
}));
vi.mock('../components/chat/SlashCommandMenu.vue', () => ({
	default: {
		name: 'SlashCommandMenu',
		props: ['disabled'],
		emits: ['command'],
		template: '<div class="slash-menu-stub" />',
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
import { useAgentRunsStore } from '../stores/agent-runs.store.js';

/** 获取 ChatPage 内部使用的 store 实例（与组件使用同一个 manager） */
function getChatStore(clawId = 'bot-1', agentId = 'main') {
	return chatStoreManager.get(`session:${clawId}:${agentId}`, { clawId, agentId });
}

const i18nMap = {
	'chat.loading': 'Loading...',
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
	'chat.errRunFailed': 'Agent run failed',
	'chat.cancelNotSupported': 'Cancel not supported',
	'chat.upgradeOpenClawHint': 'Upgrade OpenClaw',
	'chat.historyUnavailable': 'This conversation is no longer available',
	'chat.historyCorrupt': 'This conversation appears to be corrupted',
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
				$t: (key) => {
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

	test('空消息状态下不再渲染占位文案', async () => {
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
		expect(wrapper.text()).not.toContain('No messages');
		expect(wrapper.text()).not.toContain('chat.empty');
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
		expect(wrapper.text()).not.toContain('Loading...');
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

	test('headerLabel 单 claw 时不带 @clawName 后缀', async () => {
		const wrapper = createWrapper();
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'OnlyClaw', online: true }]);
		setupAgents('bot-1', 'main');
		await flushPromises();

		expect(wrapper.vm.headerLabel).toEqual({ agent: expect.any(String), claw: null });
		expect(wrapper.vm.headerLabel.claw).toBeNull();
	});

	test('headerLabel 多 claw 时带 @clawName 后缀', async () => {
		const wrapper = createWrapper();
		const clawsStore = useClawsStore();
		clawsStore.setClaws([
			{ id: 'bot-1', name: 'Alpha', online: true },
			{ id: 'bot-2', name: 'Beta', online: true },
		]);
		const agentsStore = useAgentsStore();
		agentsStore.byClaw['bot-1'] = {
			agents: [{ id: 'main', identity: { name: 'Helper' } }],
			defaultId: 'main',
			loading: false,
			fetched: true,
		};
		await flushPromises();

		expect(wrapper.vm.headerLabel).toEqual({ agent: 'Helper', claw: 'Alpha' });
	});

	test('headerLabel 多 claw 但 agent 名与 claw 名相同时丢掉后缀', async () => {
		const wrapper = createWrapper();
		const clawsStore = useClawsStore();
		clawsStore.setClaws([
			{ id: 'bot-1', name: 'Alpha', online: true },
			{ id: 'bot-2', name: 'Beta', online: true },
		]);
		// 默认 agent 无 identity 时，agentDisplay 把 name fallback 到 claw 名
		setupAgents('bot-1', 'main');
		await flushPromises();

		expect(wrapper.vm.headerLabel.claw).toBeNull();
	});

	test('headerLabel topic 路由下返回 null', async () => {
		const wrapper = createWrapper({ routeName: 'topics-chat', sessionId: 'new' });
		await flushPromises();

		expect(wrapper.vm.headerLabel).toBeNull();
	});

	test('header 多 claw 渲染 agent 与 dim @clawName', async () => {
		const wrapper = createWrapper();
		const clawsStore = useClawsStore();
		clawsStore.setClaws([
			{ id: 'bot-1', name: 'Alpha', online: true },
			{ id: 'bot-2', name: 'Beta', online: true },
		]);
		const agentsStore = useAgentsStore();
		agentsStore.byClaw['bot-1'] = {
			agents: [{ id: 'main', identity: { name: 'Helper' } }],
			defaultId: 'main',
			loading: false,
			fetched: true,
		};
		await flushPromises();

		// 桌面 header：truncate 容器内含主名 + dim 后缀
		const desktopH1 = wrapper.find('header h1');
		expect(desktopH1.exists()).toBe(true);
		expect(desktopH1.classes()).toContain('truncate');
		expect(desktopH1.text()).toContain('Helper');
		expect(desktopH1.text()).toContain('@Alpha');
		const dim = desktopH1.find('span.text-dimmed');
		expect(dim.exists()).toBe(true);
		expect(dim.text()).toBe('@Alpha');
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

	test('ChatInput 在 /compact 进行中时 cancelDisabled=true', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		chatStore.__slashCommandType = '/compact';
		await wrapper.vm.$nextTick();

		const input = wrapper.findComponent({ name: 'ChatInput' });
		expect(input.props('cancelDisabled')).toBe(true);
	});

	// 所有斜杠命令无服务端取消通道，STOP 一律禁用避免"按了没用"的错觉
	test('ChatInput 在非 /compact 斜杠命令进行中时 cancelDisabled=true', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		chatStore.__slashCommandType = '/new';
		await wrapper.vm.$nextTick();

		const input = wrapper.findComponent({ name: 'ChatInput' });
		expect(input.props('cancelDisabled')).toBe(true);
	});

	test('ChatInput 无斜杠命令进行中时 cancelDisabled=false', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		chatStore.__slashCommandType = null;
		await wrapper.vm.$nextTick();

		const input = wrapper.findComponent({ name: 'ChatInput' });
		expect(input.props('cancelDisabled')).toBe(false);
	});

	test('ChatInput cancelDisabled=true 当 isCancelling=true（用户已点 STOP，等 run 结束）', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		chatStore.__slashCommandType = null;
		// 注入 __cancelling 模拟协调进行中（isCancelling getter 返回 true）
		chatStore.__cancelling = { sid: 'sess-x', promise: new Promise(() => {}), resolve: () => {}, tickTimer: null, tickSeq: 0 };
		await wrapper.vm.$nextTick();

		const input = wrapper.findComponent({ name: 'ChatInput' });
		expect(input.props('cancelDisabled')).toBe(true);
		// cancelling=true 让按钮显示 spinner + "正在取消…" tooltip（移动端可见反馈）
		expect(input.props('cancelling')).toBe(true);
	});

	test('ChatInput cancelling=false 当 isCancelling=false（默认状态，按钮显示停止图标）', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		chatStore.__slashCommandType = null;
		chatStore.__cancelling = null;
		await wrapper.vm.$nextTick();

		const input = wrapper.findComponent({ name: 'ChatInput' });
		expect(input.props('cancelling')).toBe(false);
	});

	// SlashCommandMenu disabled 应只反映"避并发 / 等加载"，
	// 不应把 claw.online 作为 gating —— 业务层 sendSlashCommand 已用 wait-mode
	// 排队（与 sendMessage 对齐），离线点击会被 conn.waitReady() 排队等连接恢复。
	test('SlashCommandMenu 在 claw 离线时不 disabled（只渲染，不拦启动）', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: false }]);
		await wrapper.vm.$nextTick();

		const slashMenu = wrapper.findComponent({ name: 'SlashCommandMenu' });
		expect(slashMenu.exists()).toBe(true);
		expect(slashMenu.props('disabled')).toBe(false);
	});

	test('SlashCommandMenu 在发送中时 disabled', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		chatStore.sending = true;
		await wrapper.vm.$nextTick();

		const slashMenu = wrapper.findComponent({ name: 'SlashCommandMenu' });
		expect(slashMenu.exists()).toBe(true);
		expect(slashMenu.props('disabled')).toBe(true);
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

	test('onSendMessage 清空 farFromBottom 与 userScrolledUp（防按钮残留闪烁）', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		vi.spyOn(chatStore, 'sendMessage').mockResolvedValue({ accepted: true });
		await flushPromises();

		// 模拟用户已上滚 + 按钮已显示
		wrapper.vm.userScrolledUp = true;
		wrapper.vm.farFromBottom = true;

		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		expect(wrapper.vm.userScrolledUp).toBe(false);
		expect(wrapper.vm.farFromBottom).toBe(false);
	});

	test('onFileUploaded 回调走 chatStore.removeFileById（targetStore 锁定）', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		const removeSpy = vi.spyOn(chatStore, 'removeFileById');
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

		expect(removeSpy).toHaveBeenCalledTimes(2);
		expect(removeSpy).toHaveBeenCalledWith('f1');
		expect(removeSpy).toHaveBeenCalledWith('f2');
	});

	test('发送失败时通过 targetStore 恢复输入框文本和文件', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		const clearSpy = vi.spyOn(chatStore, 'clearInputFiles');
		const restoreSpy = vi.spyOn(chatStore, 'restoreFiles');
		vi.spyOn(chatStore, 'sendMessage').mockResolvedValue({ accepted: false });
		await flushPromises();

		const files = [{ name: 'pic.png', isImg: true }];
		wrapper.vm.inputText = 'hello';
		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'hello', files });
		await flushPromises();

		expect(wrapper.vm.inputText).toBe('hello');
		expect(clearSpy).toHaveBeenCalled();
		expect(restoreSpy).toHaveBeenCalledWith(files);
	});

	test('发送异常时通过 targetStore 恢复输入框和文件并显示友好 notify（未知错误）', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		chatStore.__accepted = false;
		const clearSpy = vi.spyOn(chatStore, 'clearInputFiles');
		const restoreSpy = vi.spyOn(chatStore, 'restoreFiles');
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
		expect(clearSpy).toHaveBeenCalled();
		expect(restoreSpy).toHaveBeenCalledWith(files);
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

	test('accepted 后失败 (endReason=failed)：notify error 含原始错误信息（OpenClaw 报模型不可用场景）', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		vi.spyOn(chatStore, 'sendMessage').mockResolvedValue({
			accepted: true,
			endReason: 'failed',
			errorMessage: 'FailoverError: No API key found for provider "openai"',
		});
		await flushPromises();

		wrapper.vm.inputText = 'hello';
		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'hello', files: [] });
		await flushPromises();

		expect(mockNotify.error).toHaveBeenCalledWith({
			title: 'Agent run failed',
			description: 'FailoverError: No API key found for provider "openai"',
		});
		// 失败但已 accepted 不恢复输入框（与方案约定一致）
		expect(wrapper.vm.inputText).toBe('');
	});

	test('accepted 后业务级 timeout (endReason=rpc-timeout)：notify error 含 errorMessage', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		vi.spyOn(chatStore, 'sendMessage').mockResolvedValue({
			accepted: true,
			endReason: 'rpc-timeout',
			errorMessage: 'wait timed out',
		});
		await flushPromises();

		wrapper.vm.inputText = 'hi';
		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		expect(mockNotify.error).toHaveBeenCalledWith({
			title: 'Agent run failed',
			description: 'wait timed out',
		});
	});

	test('accepted 后正常成功 (endReason=rpc)：不 notify', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		vi.spyOn(chatStore, 'sendMessage').mockResolvedValue({
			accepted: true,
			endReason: 'rpc',
			errorMessage: null,
		});
		await flushPromises();

		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		expect(mockNotify.error).not.toHaveBeenCalled();
	});

	test('错误信息长度截断 + 取首行：取首行去 stack，超 200 字符截断为 197 + "..."', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		const longMsg = 'FailoverError: model unavailable\n    at provider.js:123\n    at runAgent.js:456';
		vi.spyOn(chatStore, 'sendMessage').mockResolvedValue({
			accepted: true,
			endReason: 'failed',
			errorMessage: longMsg,
		});
		await flushPromises();

		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'x', files: [] });
		await flushPromises();

		const callArg = mockNotify.error.mock.calls.at(-1)[0];
		expect(callArg.description).toBe('FailoverError: model unavailable');
		expect(callArg.description).not.toMatch(/\n/);
	});

	test('错误信息超 200 字符时截断为 197 + "..."（不在边界 120）', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		const longLine = 'X'.repeat(250);
		vi.spyOn(chatStore, 'sendMessage').mockResolvedValue({
			accepted: true,
			endReason: 'failed',
			errorMessage: longLine,
		});
		await flushPromises();

		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'x', files: [] });
		await flushPromises();

		const callArg = mockNotify.error.mock.calls.at(-1)[0];
		expect(callArg.description.length).toBe(200);
		expect(callArg.description.endsWith('...')).toBe(true);
		expect(callArg.description.slice(0, 197)).toBe('X'.repeat(197));
	});

	test('__formatRunErrorMessage 边界值：199/200 原样、201 截断、首行全空白返回 undefined', async () => {
		// C1：off-by-one 边界 + blank-only 首行
		const wrapper = createWrapper();
		await flushPromises();
		const fn = wrapper.vm.__formatRunErrorMessage;
		// 199 字符：原样
		expect(fn('A'.repeat(199))).toBe('A'.repeat(199));
		// 200 字符：原样（边界等号不截）
		expect(fn('B'.repeat(200))).toBe('B'.repeat(200));
		// 201 字符：截断
		const r201 = fn('C'.repeat(201));
		expect(r201.length).toBe(200);
		expect(r201).toBe('C'.repeat(197) + '...');
		// 首行只有空白：trim 后空 → undefined
		expect(fn('   \t  ')).toBeUndefined();
		// 整段只有换行/空白
		expect(fn('\n\n   \n')).toBeUndefined();
		// 空字符串 / null / undefined / 非字符串
		expect(fn('')).toBeUndefined();
		expect(fn(null)).toBeUndefined();
		expect(fn(undefined)).toBeUndefined();
		expect(fn(123)).toBeUndefined();
	});

	test('errorMessage 缺失时仍弹 notify，但不带 description', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		vi.spyOn(chatStore, 'sendMessage').mockResolvedValue({
			accepted: true,
			endReason: 'failed',
			errorMessage: null,
		});
		await flushPromises();

		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'x', files: [] });
		await flushPromises();

		expect(mockNotify.error).toHaveBeenCalledWith({
			title: 'Agent run failed',
			description: undefined,
		});
	});

	/**
	 * 共用 setup：模拟 accepted run 期间 RTC 真断的终态。
	 *   1. accepted 瞬间 register 一条 run，带流式占位（_streaming=true）
	 *   2. RPC reject 触发 __onRpcFailed → __endError='rtc failed' → __endRun('failed')
	 *   3. dropRun **不被调用**（成因：__awaitPersistAndDrop 的 silent loadMessages 在 DC 刚断时
	 *      拿不到东西，兜底没调 dropRun → streamingMsgs 永久 orphan，见 chat.store.js:1626-1631）
	 *   4. sendMessage promise resolve `{accepted:true, endReason:'failed', errorMessage:'rtc failed'}`
	 */
	function setupRtcBrokenAcceptedRun() {
		const wrapper = createWrapper();
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
		setupAgents();
		const chatStore = getChatStore();
		const agentRunsStore = useAgentRunsStore();

		vi.spyOn(chatStore, 'sendMessage').mockImplementation(async () => {
			const runId = 'red-run-1';
			const optimisticClaw = {
				type: 'message',
				id: '__local_claw_red',
				_local: true,
				_pending: true,
				_streaming: true,
				_startTime: Date.now(),
				message: { role: 'assistant', content: '', stopReason: null },
			};
			agentRunsStore.register(runId, {
				clawId: 'bot-1',
				runKey: chatStore.runKey,
				topicMode: false,
				conn: { request: vi.fn() },
				streamingMsgs: [optimisticClaw],
				anchorMsgId: null,
			});
			agentRunsStore.runs[runId].__endError = 'rtc failed';
			agentRunsStore.__endRun(runId, 'failed');
			return { accepted: true, endReason: 'failed', errorMessage: 'rtc failed' };
		});
		return { wrapper, chatStore, agentRunsStore };
	}

	// 健康现状 lock：accepted run RTC 真断后，失败 toast 必须弹 + "终止"按钮必须消失。
	// 这两条当前已成立（toast 由 bc13c96 暴露的设计意图，sending=false 由 run.ended=true 推出）。
	// 单独 lock 是为了不被下面 [red] 测试的 `.fails` 包络吞掉。
	test('accepted run RTC 真断：失败 toast 弹出 + 终止按钮消失（健康现状）', async () => {
		const { wrapper } = setupRtcBrokenAcceptedRun();
		await flushPromises();

		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		expect(mockNotify.error).toHaveBeenCalledWith({
			title: 'Agent run failed',
			description: 'rtc failed',
		});
		// isSending 翻 false → ChatInput 收到 sending=false → 终止按钮消失
		expect(input.props('sending')).toBe(false);
	});

	// [red] sendMessage 直接 mock 路径下，"思考中"占位赖着不走的现象。
	// 此红测**不会**被 X1 修法变绿——因为它 mock sendMessage 后根本没走 loadMessages
	// 链路（X1 兜底点在 loadMessages 成功路径里）。它锁的是 streamingMsgs 当前作为
	// "前台显示载体"的根本设计——在 plugin 未及时持久化的极端场景下 partial reply
	// 让位失败 → 占位丢内容。这正是 TODO.md "X4 课题" 处理的方向。
	// X4 落地后此测试应变绿，届时摘掉 .fails 升级为常规 test。
	test.fails('[red] accepted run RTC 真断后 streamingMsgs 占位应被释放（X4 课题，X1 不修复）', async () => {
		const { wrapper, chatStore } = setupRtcBrokenAcceptedRun();
		await flushPromises();

		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		const orphan = chatStore.allMessages.find((m) => m._streaming === true);
		expect(orphan).toBeUndefined();
	});

	// 钉死 stripLocalUserMsgs 自身行为：对 ended run 早返回，既不动 streaming claw 占位
	// 也不调 dropRun。**X1 修法不动这条函数语义**——X1 加的是 loadMessages 成功路径上
	// 的兜底，与 stripLocalUserMsgs 互不影响。本测试是对 stripLocalUserMsgs 函数行为的约束
	// （防止未来误改），不是对"自然恢复机制"的论断（X1 落地后自然恢复机制已存在）。
	test('stripLocalUserMsgs 对 ended run 早返回：既不清 streaming claw 占位也不调 dropRun', async () => {
		const { wrapper, chatStore, agentRunsStore } = setupRtcBrokenAcceptedRun();
		await flushPromises();

		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		const before = chatStore.allMessages.find((m) => m._streaming === true);
		expect(before).toBeDefined();

		const dropSpy = vi.spyOn(agentRunsStore, 'dropRun');

		const fakeServerMsgs = [
			{ type: 'message', id: 'srv-1', message: { role: 'user', content: 'hi', timestamp: Date.now() } },
			{ type: 'message', id: 'srv-2', message: { role: 'assistant', content: 'partial reply', timestamp: Date.now() } },
		];
		agentRunsStore.stripLocalUserMsgs(chatStore.runKey, fakeServerMsgs);

		const after = chatStore.allMessages.find((m) => m._streaming === true);
		expect(after).toBeDefined();
		expect(dropSpy).not.toHaveBeenCalled();
	});

	// X1 修法路径覆盖：ended 但未 drop 的孤儿 run，下次成功 loadMessages 时被释放。
	// 模拟"sendMessage 那一刻 fast-fail（DC 刚断）→ PC 重建后 connReady watcher
	// 触发 silent reload 成功"的事实链：connReady 翻 true 让 ChatPage 触发 loadMessages，
	// 内部走 sessions.get 成功 → reconcile → X1 兜底 dropRun → 占位释放。
	test('X1 兜底：ended orphan run 在下次 loadMessages 成功后被释放', async () => {
		const { wrapper, chatStore, agentRunsStore } = setupRtcBrokenAcceptedRun();
		await flushPromises();

		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		// 前置：占位此刻仍在（X1 还没机会跑）
		const before = chatStore.allMessages.find((m) => m._streaming === true);
		expect(before).toBeDefined();
		const runKey = chatStore.runKey;
		expect(agentRunsStore.getActiveRun(runKey)).toBeTruthy();

		// 模拟 PC 重建后 silent reload 成功路径：直接调 loadMessages，
		// stub 内部 sessions.get / chat.history 让 doLoad 走通。runKey 与 chatSessionKey
		// 在测试 setup 下分别是 'bot-1::agent:main:main' 与 'agent:main:main'。
		const sessionsGetResult = {
			messages: [
				{ id: 'srv-u-1', role: 'user', content: 'hi', timestamp: Date.now() },
				{ id: 'srv-a-1', role: 'assistant', content: 'partial reply', timestamp: Date.now() },
			],
		};
		const chatHistoryResult = { sessionId: 'sess-1' };
		const fakeConn = {
			request: vi.fn().mockImplementation((method) => {
				if (method === 'sessions.get') return Promise.resolve(sessionsGetResult);
				if (method === 'chat.history') return Promise.resolve(chatHistoryResult);
				return Promise.reject(new Error(`unexpected RPC ${method}`));
			}),
		};
		const getReadyConnMod = await import('../stores/get-ready-conn.js');
		vi.spyOn(getReadyConnMod, 'getReadyConn').mockReturnValue(fakeConn);

		const ok = await chatStore.loadMessages({ silent: true, force: true });
		expect(ok).toBe(true);

		// 钉死：X1 触发 dropRun → entry 已删 → 占位释放
		expect(agentRunsStore.getActiveRun(runKey)).toBeNull();
		const after = chatStore.allMessages.find((m) => m._streaming === true);
		expect(after).toBeUndefined();
	});

	// 锁住全局 toast 设计 contract：用户切走 / unmount 后 sendMessage 落地仍弹失败 toast，
	// 不 crash。失败感知不应因用户离开页面而丢失。如果未来要改为 unmount 后 suppress，
	// 必须有意识地推翻这个测试，避免无声变更。
	test('unmount 后 sendMessage resolve：仍弹失败 toast，不 crash（全局 toast contract）', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		let resolveSend;
		vi.spyOn(chatStore, 'sendMessage').mockImplementation(
			() => new Promise((resolve) => { resolveSend = resolve; }),
		);
		await flushPromises();

		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		// send 已发出，promise 仍 pending；立即 unmount 模拟用户切走
		wrapper.unmount();

		// unmount 后才 resolve 失败结果
		resolveSend({
			accepted: true,
			endReason: 'failed',
			errorMessage: 'FailoverError: late resolve',
		});
		await flushPromises();

		expect(mockNotify.error).toHaveBeenCalledWith({
			title: 'Agent run failed',
			description: 'FailoverError: late resolve',
		});
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

	// =====================================================================
	// new-topic 路由：chatStore computed 返回 new-topic store + promote 流程
	// =====================================================================

	test('isNewTopic 路由 + 有 newTopicClawId 时 chatStore 返回 new-topic store（非 null）', async () => {
		const wrapper = createWrapper({
			routeName: 'topics-chat', sessionId: 'new',
			query: { claw: 'bot-1', agent: 'main' },
		});
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
		await flushPromises();
		expect(wrapper.vm.chatStore).not.toBeNull();
		expect(wrapper.vm.chatStore.newTopicMode).toBe(true);
	});

	test('isNewTopic 路由 + 缺 claw query 时 chatStore 返回 null', async () => {
		const wrapper = createWrapper({
			routeName: 'topics-chat', sessionId: 'new',
			query: { agent: 'main' }, // 没有 claw
		});
		await flushPromises();
		expect(wrapper.vm.chatStore).toBeNull();
	});

	test('new-topic 上选附件 → __handleNewTopicSend 走 promote：router.replace 后 commit + sendMessage 在 newStore', async () => {
		const { useTopicsStore } = await import('../stores/topics.store.js');
		const wrapper = createWrapper({
			routeName: 'topics-chat', sessionId: 'new',
			query: { claw: 'bot-1', agent: 'main' },
		});
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
		const topicsStore = useTopicsStore();
		// createTopic resolve 一个 topicId
		vi.spyOn(topicsStore, 'createTopic').mockResolvedValue('new-topic-uuid');
		await flushPromises();

		// 老 new-topic store + 一个图片附件
		const oldStore = wrapper.vm.chatStore;
		oldStore.inputFiles.push({ id: 'a', isImg: true, url: 'blob:a', file: new Blob(['x']), name: 'a.png' });

		// 记录调用顺序，断言 router.replace 在 dispose 之前
		mockRouter.replace.mockImplementation(() => Promise.resolve());
		const promoteSpy = vi.spyOn(chatStoreManager, 'promoteToTopic');
		const disposeSpy = vi.spyOn(chatStoreManager, 'dispose');

		// 准备 sendMessage 在新 topic store 上的 spy。
		// 由于 promoteToTopic 内部会创建新 store，spy 必须先在 chat-store-manager 的 get 上挂钩
		const origGet = chatStoreManager.get.bind(chatStoreManager);
		let newStoreSendSpy;
		vi.spyOn(chatStoreManager, 'get').mockImplementation((key, opts) => {
			const s = origGet(key, opts);
			if (key === 'topic:new-topic-uuid' && !newStoreSendSpy) {
				newStoreSendSpy = vi.spyOn(s, 'sendMessage').mockResolvedValue({ accepted: true });
			}
			return s;
		});

		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'hello', files: [...oldStore.inputFiles] });
		await flushPromises();

		// promote 被调用
		expect(promoteSpy).toHaveBeenCalledWith(
			'new-topic:bot-1:main', 'new-topic-uuid', { clawId: 'bot-1', agentId: 'main' },
		);
		// router.replace 被调用
		expect(mockRouter.replace).toHaveBeenCalled();
		// dispose 被调用（commit() 内部）
		expect(disposeSpy).toHaveBeenCalledWith('new-topic:bot-1:main');
		// sendMessage 在 newStore 上发起（不在老 store）
		expect(newStoreSendSpy).toHaveBeenCalled();
		// router.replace 调用顺序在 dispose 之前
		const replaceIdx = mockRouter.replace.mock.invocationCallOrder[0];
		const disposeIdx = disposeSpy.mock.invocationCallOrder[0];
		expect(replaceIdx).toBeLessThan(disposeIdx);
	});

	test('new-topic 重入防护：__creatingTopic=true 时再次触发 onSendMessage 直接 no-op（防双击双发）', async () => {
		const { useTopicsStore } = await import('../stores/topics.store.js');
		const wrapper = createWrapper({
			routeName: 'topics-chat', sessionId: 'new',
			query: { claw: 'bot-1', agent: 'main' },
		});
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
		const topicsStore = useTopicsStore();
		// createTopic 永远 pending，模拟 await 期间用户再次点发送
		const createSpy = vi.spyOn(topicsStore, 'createTopic')
			.mockImplementation(() => new Promise(() => {}));
		await flushPromises();

		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();
		expect(createSpy).toHaveBeenCalledTimes(1);

		// 第二次触发应被入口的 __creatingTopic 守卫拦截：createTopic 不应再发起一次
		input.vm.$emit('send', { text: 'second', files: [] });
		await flushPromises();
		expect(createSpy).toHaveBeenCalledTimes(1);
	});

	test('new-topic 发送失败：失败回退走 newStore（targetStore 锁定，不走 ChatInput $refs）', async () => {
		const { useTopicsStore } = await import('../stores/topics.store.js');
		const wrapper = createWrapper({
			routeName: 'topics-chat', sessionId: 'new',
			query: { claw: 'bot-1', agent: 'main' },
		});
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
		const topicsStore = useTopicsStore();
		vi.spyOn(topicsStore, 'createTopic').mockResolvedValue('new-topic-uuid');
		await flushPromises();

		// 让新 topic store 的 sendMessage 返回 accepted=false
		const origGet = chatStoreManager.get.bind(chatStoreManager);
		let newStoreClearSpy, newStoreRestoreSpy;
		vi.spyOn(chatStoreManager, 'get').mockImplementation((key, opts) => {
			const s = origGet(key, opts);
			if (key === 'topic:new-topic-uuid') {
				vi.spyOn(s, 'sendMessage').mockResolvedValue({ accepted: false });
				newStoreClearSpy = vi.spyOn(s, 'clearInputFiles');
				newStoreRestoreSpy = vi.spyOn(s, 'restoreFiles');
			}
			return s;
		});

		const files = [{ id: 'a', isImg: false, url: null }];
		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'hi', files });
		await flushPromises();

		// 失败回退在 newStore 上（不在 ChatInput 上）
		expect(newStoreClearSpy).toHaveBeenCalled();
		expect(newStoreRestoreSpy).toHaveBeenCalledWith(files);
	});

	// createTopic 在 await 期间 claw 被解绑 → topics.store 抛 CLAW_DISCONNECTED。上层必须：
	//   1) 不 promote、不进话题路由——否则用户卡在 byId 没写入的空白 topic 路由
	//   2) 跳默认首页 /，避免用户停留在 /topics/new?claw=<已解绑> 死胡同（再点发送重抛同错）
	//   3) 用 chat.errWsClosed 文案提示用户连接已断
	//   4) __creatingTopic 归零，让用户能再次重试
	test('new-topic createTopic 抛 CLAW_DISCONNECTED → 不 promote、跳默认首页、提示连接断开、允许重试', async () => {
		const { useTopicsStore } = await import('../stores/topics.store.js');
		const wrapper = createWrapper({
			routeName: 'topics-chat', sessionId: 'new',
			query: { claw: 'bot-1', agent: 'main' },
		});
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
		const topicsStore = useTopicsStore();
		const disconnectedErr = new Error('Claw disconnected during topic creation');
		disconnectedErr.code = 'CLAW_DISCONNECTED';
		const createSpy = vi.spyOn(topicsStore, 'createTopic').mockRejectedValueOnce(disconnectedErr);
		await flushPromises();

		const promoteSpy = vi.spyOn(chatStoreManager, 'promoteToTopic');
		mockRouter.replace.mockImplementation(() => Promise.resolve());

		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		// 不 promote —— 用户没有跳到陷阱话题路由
		expect(promoteSpy).not.toHaveBeenCalled();
		// 跳默认首页 / 让用户重新选择入口（F4 防 UX 死胡同）
		expect(mockRouter.replace).toHaveBeenCalledWith('/');
		// 提示用"连接断开"文案
		expect(mockNotify.error).toHaveBeenCalledWith('Connection lost');

		// __creatingTopic 归零：第二次发送能再次发起 createTopic（守卫已恢复）
		createSpy.mockResolvedValueOnce('new-topic-uuid');
		input.vm.$emit('send', { text: 'retry', files: [] });
		await flushPromises();
		expect(createSpy).toHaveBeenCalledTimes(2);
	});

	// B5：topic 创建后 accepted-then-failed 的 toast 路径——
	// 与普通 sendMessage 路径走同一个 __notifyRunFailed，但 __handleNewTopicSend 是独立分支，
	// 加 protect-against-regression 测试避免后续重构把 toast 调用从 topic 分支漏掉
	test('new-topic accepted 后失败 (endReason=failed)：notify error 含 errorMessage', async () => {
		const { useTopicsStore } = await import('../stores/topics.store.js');
		const wrapper = createWrapper({
			routeName: 'topics-chat', sessionId: 'new',
			query: { claw: 'bot-1', agent: 'main' },
		});
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
		const topicsStore = useTopicsStore();
		vi.spyOn(topicsStore, 'createTopic').mockResolvedValue('new-topic-uuid');
		await flushPromises();

		const origGet = chatStoreManager.get.bind(chatStoreManager);
		vi.spyOn(chatStoreManager, 'get').mockImplementation((key, opts) => {
			const s = origGet(key, opts);
			if (key === 'topic:new-topic-uuid') {
				vi.spyOn(s, 'sendMessage').mockResolvedValue({
					accepted: true,
					endReason: 'failed',
					errorMessage: 'FailoverError: model unavailable',
				});
			}
			return s;
		});

		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		expect(mockNotify.error).toHaveBeenCalledWith({
			title: 'Agent run failed',
			description: 'FailoverError: model unavailable',
		});
	});

	// =====================================================================
	// targetStore 锁定：用户在 await 期间切走，回退仍打回入口 store
	// =====================================================================

	test('targetStore 锁定：sendMessage 失败时回退路径只触达入口 store，不污染同期存在的其它 store', async () => {
		const wrapper = createWrapper();
		setupAgents();
		const entryStore = getChatStore('bot-1', 'main');
		const otherStore = chatStoreManager.get(
			'session:bot-2:main', { clawId: 'bot-2', agentId: 'main' },
		);
		const entryClearSpy = vi.spyOn(entryStore, 'clearInputFiles');
		const entryRestoreSpy = vi.spyOn(entryStore, 'restoreFiles');
		const otherClearSpy = vi.spyOn(otherStore, 'clearInputFiles');
		const otherRestoreSpy = vi.spyOn(otherStore, 'restoreFiles');

		vi.spyOn(entryStore, 'sendMessage').mockResolvedValue({ accepted: false });
		await flushPromises();

		const input = wrapper.findComponent({ name: 'ChatInput' });
		const files = [{ id: 'a', isImg: false, url: null }];
		input.vm.$emit('send', { text: 'hi', files });
		await flushPromises();

		// 入口 store 收到回退；otherStore 完全未被触达 —— 即使源码改坏写成 $refs.chatInput.xxx
		// 之类拿当前 chatStore 的写法，回退也会路由错误，本测试能拦下来
		expect(entryClearSpy).toHaveBeenCalled();
		expect(entryRestoreSpy).toHaveBeenCalledWith(files);
		expect(otherClearSpy).not.toHaveBeenCalled();
		expect(otherRestoreSpy).not.toHaveBeenCalled();
	});

	test('sendMessage 在 commit() 之后才发起（new-topic 流程的步骤顺序）', async () => {
		const { useTopicsStore } = await import('../stores/topics.store.js');
		const wrapper = createWrapper({
			routeName: 'topics-chat', sessionId: 'new',
			query: { claw: 'bot-1', agent: 'main' },
		});
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
		const topicsStore = useTopicsStore();
		vi.spyOn(topicsStore, 'createTopic').mockResolvedValue('new-topic-uuid');
		await flushPromises();

		mockRouter.replace.mockImplementation(() => Promise.resolve());
		const disposeSpy = vi.spyOn(chatStoreManager, 'dispose');

		const origGet = chatStoreManager.get.bind(chatStoreManager);
		let newStoreSendSpy;
		vi.spyOn(chatStoreManager, 'get').mockImplementation((key, opts) => {
			const s = origGet(key, opts);
			if (key === 'topic:new-topic-uuid' && !newStoreSendSpy) {
				newStoreSendSpy = vi.spyOn(s, 'sendMessage').mockResolvedValue({ accepted: true });
			}
			return s;
		});

		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'hello', files: [] });
		await flushPromises();

		// 关键：sendMessage 必须在 commit（即 dispose 老 new-topic store）之后调用，
		// 否则旧 store 仍持引用、ChatInput 视觉一致性等假设全废
		const disposeIdx = disposeSpy.mock.invocationCallOrder[0];
		const sendIdx = newStoreSendSpy.mock.invocationCallOrder[0];
		expect(disposeIdx).toBeLessThan(sendIdx);
	});

	test('__creatingTopic 守卫：promote 完成 + send 失败回退后用户立即再次发送应能进入', async () => {
		const { useTopicsStore } = await import('../stores/topics.store.js');
		const wrapper = createWrapper({
			routeName: 'topics-chat', sessionId: 'new',
			query: { claw: 'bot-1', agent: 'main' },
		});
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
		const topicsStore = useTopicsStore();
		vi.spyOn(topicsStore, 'createTopic').mockResolvedValue('new-topic-uuid');
		mockRouter.replace.mockImplementation(() => Promise.resolve());
		await flushPromises();

		// 第一次发送：promote 成功 + sendMessage 返回 accepted=false
		const origGet = chatStoreManager.get.bind(chatStoreManager);
		let newStoreSendSpy;
		vi.spyOn(chatStoreManager, 'get').mockImplementation((key, opts) => {
			const s = origGet(key, opts);
			if (key === 'topic:new-topic-uuid' && !newStoreSendSpy) {
				newStoreSendSpy = vi.spyOn(s, 'sendMessage').mockResolvedValue({ accepted: false });
			}
			return s;
		});

		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'first', files: [] });
		await flushPromises();

		// 第一次发送已完整结束（createTopic + send 都跑过）
		expect(topicsStore.createTopic).toHaveBeenCalledTimes(1);
		expect(newStoreSendSpy).toHaveBeenCalledTimes(1);

		// 用户再点一次发送 —— 守卫应放行（不被 __creatingTopic=true 永久卡住）。
		// 本测试 mock 不切换 $route，所以仍走 new-topic 分支并再走一次 promote；
		// 关键断言是 createTopic 第二次能被调用 → 守卫已恢复
		input.vm.$emit('send', { text: 'second', files: [] });
		await flushPromises();
		expect(topicsStore.createTopic).toHaveBeenCalledTimes(2);
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

	// onCancelSend 已不看 cancelSend 返回值（toast 全部移到 chat.store 内部 getSharedNotifier，
	// 见 chat.store.test.js 的 gone/not-supported 用例）。这里只用一个守卫覆盖所有返回形态：
	// null（pre-accept 各种返 null 路径）/ {ok:true}（immediate）/ {ok:false, reason:...}（任何 reason）
	// → ChatPage 都不应主动 notify。
	test.each([
		[null, 'pre-accept null'],
		[Promise.resolve({ ok: true }), 'immediate'],
		[Promise.resolve({ ok: false, reason: 'gone' }), 'gone (toast in store)'],
		[Promise.resolve({ ok: false, reason: 'not-supported' }), 'not-supported (toast in store)'],
		[Promise.resolve({ ok: false, reason: 'run-ended' }), 'run-ended silent'],
		[Promise.resolve({ ok: false, reason: 'superseded' }), 'superseded silent'],
	])('onCancelSend: ChatPage 不主动 notify（cancelSend → %s）', async (returnValue, _desc) => {
		const wrapper = createWrapper();
		setupAgents();
		const chatStore = getChatStore();
		vi.spyOn(chatStore, 'cancelSend').mockReturnValue(returnValue);
		await flushPromises();

		wrapper.vm.onCancelSend();
		await flushPromises();

		expect(mockNotify.success).not.toHaveBeenCalled();
		expect(mockNotify.info).not.toHaveBeenCalled();
		expect(mockNotify.warning).not.toHaveBeenCalled();
		expect(mockNotify.error).not.toHaveBeenCalled();
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

	// claw.online 是 server 侧观测到的存活信号（rendering signal），
	// 与 RTC DC / RPC 生命周期解耦——不应在 online→offline 转换时主动
	// cancel 正在跑的 agent run（否则会触发 settling(cancel) 僵尸，详见
	// docs/architecture/communication-model.md §3）。
	test('claw 下线时不应触发 cancelSend（presence 与 RPC 生命周期解耦）', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		chatStore.clawId = 'bot-1';
		const cancelSpy = vi.spyOn(chatStore, 'cancelSend');

		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
		await wrapper.vm.$nextTick();

		// claw 下线
		clawsStore.updateClawOnline('bot-1', false);
		await wrapper.vm.$nextTick();

		expect(cancelSpy).not.toHaveBeenCalled();
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

	test('connReady 只看 dcReady：online=false + dcReady=true 也触发加载（presence 不 gate 通信）', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		chatStore.clawId = 'bot-1';
		chatStore.__messagesLoaded = false;
		const loadSpy = vi.spyOn(chatStore, 'loadMessages').mockResolvedValue(true);

		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: false }]);
		setupAgents();
		await wrapper.vm.$nextTick();

		// SSE 推 online=false，但本地 DC 仍健在 → connReady 应为 true
		clawsStore.byId['bot-1'].dcReady = true;
		await wrapper.vm.$nextTick();

		expect(loadSpy).toHaveBeenCalled();
	});

	/**
	 * 契约锁：claw.online=false + dcReady=true 时
	 * - connStatusText 显示 "离线" banner（视觉提示）
	 * - ChatInput 的 :disabled 不因 offline 升起（仍允许输入和发送）
	 *
	 * 这是 "presence 单独显示 / DC 单独 gate 通信" 设计的产品契约：banner 是用户感知，
	 * 真正的发送闸是 dcReady。改动这两条断言里的任何一条都意味着改了产品契约。
	 */
	test('contract: online=false + dcReady=true → 显示离线 banner 但 ChatInput 仍允许输入', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		chatStore.clawId = 'bot-1';

		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: false }]);
		clawsStore.byId['bot-1'].dcReady = true;
		setupAgents();
		await wrapper.vm.$nextTick();

		// banner 文案显示 offline 字符串（i18n key 'chat.clawOffline'）
		expect(wrapper.vm.connStatusText).toBe(i18nMap['chat.clawOffline']);
		expect(wrapper.text()).toContain('Claw is offline');

		// ChatInput :disabled 应为 false（chat 路由 + routeClawId 已有 + 非 isLoading + 非 inputLocked）
		const input = wrapper.findComponent({ name: 'ChatInput' });
		expect(input.exists()).toBe(true);
		expect(input.props('disabled')).toBe(false);
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

	test('chatStore watcher 重置 userScrolledUp / farFromBottom / __scrollReady', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		chatStore.clawId = 'bot-1';

		// 模拟用户已滚动和 scroll 就绪
		wrapper.vm.userScrolledUp = true;
		wrapper.vm.farFromBottom = true;
		wrapper.vm.__scrollReady = true;

		// 直接调用 chatStore watcher handler 测试重置行为
		const newStore = chatStoreManager.get('session:bot-1:alt', { clawId: 'bot-1', agentId: 'alt' });
		vi.spyOn(newStore, 'activate').mockImplementation(() => {});
		wrapper.vm.$options.watch.chatStore.handler.call(wrapper.vm, newStore, chatStore);

		expect(wrapper.vm.userScrolledUp).toBe(false);
		expect(wrapper.vm.farFromBottom).toBe(false);
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

	test('connReady 稳态下切 chatStore：新 store 的 loadMessages 被调（旧 pending 不阻塞）', async () => {
		// 场景：dcReady=true 稳态下，先让 __connReadyStore 指向 A；然后切到 B（vm.chatStore 变成 B）。
		// __onConnReady 里的 `__connReadyStore === chatStore` 去重看的是"当前 chatStore 与上次标记的是否同一实例"——
		// 切到 B 后 vm.chatStore=B ≠ __connReadyStore(=A)，去重不拦；B.loadMessages 正常触发。
		// 即使 A 的 loadMessages 返回永不 resolve 的 promise（被旧请求占住），也不阻塞 B 的流程。
		const pinia = createPinia();
		setActivePinia(pinia);

		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
		clawsStore.byId['bot-1'].dcReady = true;
		// agent 'main'（A）与 'alt'（B）都注册
		const agentsStore = useAgentsStore();
		agentsStore.byClaw['bot-1'] = {
			agents: [{ id: 'main' }, { id: 'alt' }],
			defaultId: 'main',
			loading: false,
			fetched: true,
		};

		// 预建 A store 并用"永不 resolve"的 loadMessages 占坑
		const chatStoreA = chatStoreManager.get('session:bot-1:main', { clawId: 'bot-1', agentId: 'main' });
		chatStoreA.__messagesLoaded = false;
		const pendingA = new Promise(() => {});
		vi.spyOn(chatStoreA, 'loadMessages').mockReturnValue(pendingA);

		// 预建 B store 并挂 spy
		const chatStoreB = chatStoreManager.get('session:bot-1:alt', { clawId: 'bot-1', agentId: 'alt' });
		chatStoreB.__messagesLoaded = false;
		const loadB = vi.spyOn(chatStoreB, 'loadMessages').mockResolvedValue(true);

		// 以 B 的路由挂载（vm.chatStore=B）
		const wrapper = mount(ChatPage, {
			global: {
				plugins: [pinia],
				mocks: {
					$t: (key) => i18nMap[key] ?? key,
					$route: {
						name: 'chat',
						params: { clawId: 'bot-1', agentId: 'alt' },
						path: '/chat/bot-1/alt',
						query: {},
					},
					$router: mockRouter,
				},
			},
		});
		await flushPromises();

		// 预设 __connReadyStore=A（模拟"之前 A 已 fire 过 __onConnReady"的稳态）
		wrapper.vm.__connReadyStore = chatStoreA;
		loadB.mockClear();

		// 手动触发 __onConnReady：验证去重不误拦，B.loadMessages 被调
		await wrapper.vm.__onConnReady();
		expect(loadB).toHaveBeenCalledTimes(1);
	});

	test('topic mode: DC rebuild → 单次 silent reload + 不调 __loadChatHistory', async () => {
		// topic 路由下，chatStore.topicMode=true → __onConnReady 走 silent reload 分支，
		// 不应触发 __loadChatHistory（topic 不走首次历史加载路径）。
		const { useTopicsStore } = await import('../stores/topics.store.js');
		const pinia = createPinia();
		setActivePinia(pinia);
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-2', name: 'Bot', online: true }]);
		clawsStore.byId['bot-2'].dcReady = true;
		clawsStore.byId['bot-2'].rtcPhase = 'ready';
		setupAgents('bot-2', 'main');

		const topicsStore = useTopicsStore();
		topicsStore.byId = {
			'sess-1': { topicId: 'sess-1', agentId: 'main', title: null, createdAt: 100, clawId: 'bot-2' },
		};

		// topic store —— key 以 `topic:` 前缀创建 → topicMode=true
		const chatStore = chatStoreManager.get('topic:sess-1', { clawId: 'bot-2', agentId: 'main' });
		chatStore.__initialized = true;
		chatStore.__messagesLoaded = true;
		chatStore.sending = false;
		expect(chatStore.topicMode).toBe(true);
		const loadSpy = vi.spyOn(chatStore, 'loadMessages').mockResolvedValue(true);
		const histSpy = vi.spyOn(chatStore, '__loadChatHistory').mockResolvedValue(undefined);

		const wrapper = mount(ChatPage, {
			global: {
				plugins: [pinia],
				mocks: {
					$t: (key) => i18nMap[key] ?? key,
					$route: {
						name: 'topics-chat',
						params: { sessionId: 'sess-1' },
						path: '/topics/sess-1',
						query: {},
					},
					$router: mockRouter,
				},
			},
		});
		await flushPromises();
		// 挂载初始：immediate watcher 触发首轮 silent reload
		expect(loadSpy).toHaveBeenCalled();
		loadSpy.mockClear();

		// DC rebuild 模拟：dcReady false → true
		clawsStore.byId['bot-2'].dcReady = false;
		await wrapper.vm.$nextTick();
		expect(wrapper.vm.connReady).toBe(false);
		clawsStore.byId['bot-2'].dcReady = true;
		await wrapper.vm.$nextTick();
		await flushPromises();

		// rebuild 后恰好 1 次 silent reload
		expect(loadSpy).toHaveBeenCalledTimes(1);
		expect(loadSpy).toHaveBeenCalledWith({ silent: true });
		// topic 模式不走首次历史加载
		expect(histSpy).not.toHaveBeenCalled();
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

	test('farFromBottom 仅在距底 > 1 屏（clientHeight）时为 true', async () => {
		const wrapper = createWrapper();
		await flushPromises();

		const scrollContainer = wrapper.vm.$refs.scrollContainer;
		if (!scrollContainer) return;

		// 距底 = 1000 - 200 - 500 = 300 < clientHeight(500) → false
		Object.defineProperties(scrollContainer, {
			scrollHeight: { value: 1000, configurable: true },
			scrollTop: { value: 200, configurable: true, writable: true },
			clientHeight: { value: 500, configurable: true },
		});
		wrapper.vm.onScroll();
		expect(wrapper.vm.farFromBottom).toBe(false);

		// 边界：距底 = 1000 - 0 - 500 = 500 == clientHeight → 仍为 false（用 `>` 不是 `>=`）
		Object.defineProperties(scrollContainer, {
			scrollHeight: { value: 1000, configurable: true },
			scrollTop: { value: 0, configurable: true, writable: true },
			clientHeight: { value: 500, configurable: true },
		});
		wrapper.vm.onScroll();
		expect(wrapper.vm.farFromBottom).toBe(false);

		// 距底 = 1500 - 0 - 500 = 1000 > clientHeight(500) → true
		Object.defineProperties(scrollContainer, {
			scrollHeight: { value: 1500, configurable: true },
			scrollTop: { value: 0, configurable: true, writable: true },
			clientHeight: { value: 500, configurable: true },
		});
		wrapper.vm.onScroll();
		expect(wrapper.vm.farFromBottom).toBe(true);
	});

	test('ResizeObserver 路径（非 scroll 事件）也更新 farFromBottom', async () => {
		const wrapper = createWrapper();
		await flushPromises();

		const scrollContainer = wrapper.vm.$refs.scrollContainer;
		if (!scrollContainer) return;

		// 模拟流式输出：scrollHeight 长高跨过 1 屏阈值，但用户没滚（无 scroll 事件）
		Object.defineProperties(scrollContainer, {
			scrollHeight: { value: 2000, configurable: true },
			scrollTop: { value: 0, configurable: true, writable: true },
			clientHeight: { value: 500, configurable: true },
		});
		// 直接调 helper（ResizeObserver 回调内部就是调这个）
		const proxy = wrapper.vm.$.proxy;
		proxy.__refreshFarFromBottom();
		expect(wrapper.vm.farFromBottom).toBe(true);
	});

	test('onClickBackToBottom 同步重置两个滚动 flag 并强制滚到底', async () => {
		const wrapper = createWrapper();
		await flushPromises();

		const scrollContainer = wrapper.vm.$refs.scrollContainer;
		if (!scrollContainer) return;

		const scrollToSpy = vi.fn();
		scrollContainer.scrollTo = scrollToSpy;
		Object.defineProperties(scrollContainer, {
			scrollHeight: { value: 1500, configurable: true },
			scrollTop: { value: 0, configurable: true, writable: true },
			clientHeight: { value: 500, configurable: true },
		});

		wrapper.vm.userScrolledUp = true;
		wrapper.vm.farFromBottom = true;

		wrapper.vm.onClickBackToBottom();

		// 两个 flag 同步置 false，避免按钮闪烁
		expect(wrapper.vm.userScrolledUp).toBe(false);
		expect(wrapper.vm.farFromBottom).toBe(false);

		await wrapper.vm.$nextTick();
		await new Promise(r => requestAnimationFrame(r));
		// force=true 路径触发 scrollTo，且滚到 scrollHeight、瞬时滚动
		expect(scrollToSpy).toHaveBeenCalledWith({ top: 1500, behavior: 'auto' });
		// force 循环用真实 rAF 会空转到 2.5s deadline，unmount 强停防泄漏
		wrapper.unmount();
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
		// 距底 500 > 1：force 循环只在"未到底"时才发 scrollTo（已到底直接判稳，不再像旧实现无脑单发）
		Object.defineProperties(scrollContainer, {
			scrollHeight: { value: 1000, configurable: true },
			scrollTop: { value: 0, configurable: true, writable: true },
			clientHeight: { value: 500, configurable: true },
		});

		wrapper.vm.userScrolledUp = true;

		wrapper.vm.scrollToBottom(true);

		await wrapper.vm.$nextTick();
		await new Promise(r => requestAnimationFrame(r));

		// force=true 时应忽略 userScrolledUp，执行 scrollTo
		expect(scrollToSpy).toHaveBeenCalled();
		// force 循环用真实 rAF 会空转到 2.5s deadline，unmount 强停防泄漏
		wrapper.unmount();
	});

	// 锁住"首屏 visibility 解锁与历史加载锁解耦"的契约：
	// 之前 scrollToBottom 在 __loadingHistory=true 时直接早退，连 __scrollReady 都不点亮——
	// 一旦 __onConnReady 的强制 scroll 撞上 chatMessages watcher 触发的 __autoFillHistory（视口未满 → 立刻
	// loadOlderMessages → __loadingHistory=true）这条 race，整面板会永久 visibility:hidden，
	// 只能切走再回来重挂 ChatPage 才恢复。
	// 语义升级（force 滚动循环）：force 撞锁从"被吞"变为"改等"——仍立即解锁 __scrollReady，
	// 同时启动循环；循环在锁释放前不发 scrollTo（不干扰位置恢复）。
	test('contract: force 路径在 __loadingHistory 占锁时仍解锁 __scrollReady，且循环改等不吞', async () => {
		const wrapper = createWrapper();
		await flushPromises();
		// 双下划线开头的 data 字段在 reserved-prefix runtime-core 里不上 ctx，
		// 需要从 $data 走读。手动赋值则继续用 $data 走以保证写在同一处。
		expect(wrapper.vm.$data.__scrollReady).toBe(false);

		const scrollContainer = wrapper.vm.$refs.scrollContainer;
		if (!scrollContainer) return;
		const scrollToSpy = vi.fn();
		scrollContainer.scrollTo = scrollToSpy;
		Object.defineProperties(scrollContainer, {
			scrollHeight: { value: 1000, configurable: true },
			scrollTop: { value: 0, configurable: true, writable: true },
			clientHeight: { value: 500, configurable: true },
		});

		// 模拟 race：chatMessages watcher 已经把 __autoFillHistory 跑起来 → __loadingHistory=true，
		// __onConnReady 的 $nextTick 这时才轮到调 scrollToBottom(true)。
		wrapper.vm.$data.__loadingHistory = true;
		wrapper.vm.scrollToBottom(true);

		// 即便 scroll 被 history-load 路径接管而跳过，首屏 visibility 也必须解锁，
		// 否则整面板会一直 visibility:hidden 直到用户主动切走重挂。
		expect(wrapper.vm.$data.__scrollReady).toBe(true);
		// force 不再被吞：循环已启动、等锁释放后补滚
		expect(wrapper.vm.$.proxy.__forceScrollActive).toBe(true);

		await wrapper.vm.$nextTick();
		await new Promise(r => requestAnimationFrame(r));
		// 锁未释放期间循环不发 scrollTo（不干扰位置恢复）
		expect(scrollToSpy).not.toHaveBeenCalled();

		// force 循环用真实 rAF 会空转到 2.5s deadline，unmount 强停防泄漏
		wrapper.unmount();
		expect(wrapper.vm.$.proxy.__forceScrollActive).toBe(false);
	});

	// --- force 滚动重试循环（iOS<16 WebKit 惯性吞 scrollTo 的根治路径） ---
	describe('force 滚动重试循环', () => {
		// jsdom 假绿陷阱：Element.prototype.scrollTo 不存在、scrollHeight/clientHeight 默认全 0
		// （3 帧即"判稳"）——每个循环用例必须显式 stub scrollTo + defineProperties 撑出非零距底，
		// 并前置断言循环真发射/排帧过，否则整组假绿。
		// rAF 手动驱动：stub 必须在 mount 之前装好（beforeEach），避免 createWrapper 触发的
		// 非 force rAF 兜底污染逐帧计数。
		let rafQueue;
		let rafSeq;

		/** 步进一帧：执行当前已排队的全部 rAF 回调 */
		function runFrame() {
			const cbs = [...rafQueue.values()];
			rafQueue.clear();
			for (const cb of cbs) cb();
		}

		beforeEach(() => {
			rafQueue = new Map();
			rafSeq = 0;
			vi.stubGlobal('requestAnimationFrame', (cb) => {
				rafQueue.set(++rafSeq, cb);
				return rafSeq;
			});
			vi.stubGlobal('cancelAnimationFrame', (id) => {
				rafQueue.delete(id);
			});
			// Date 走 fake timers（vi.spyOn(Date,'now') 在关 restoreMocks 的 config 下忘 restore 即泄漏）；
			// setup.js 的 afterEach useRealTimers 自动兜底
			vi.useFakeTimers({ toFake: ['Date'] });
		});

		// config 不开 unstubGlobals，本 describe 自清 rAF stub
		afterEach(() => {
			vi.unstubAllGlobals();
		});

		/**
		 * 挂载并撑出非零距底（1500/0/500，距底 1000）。
		 * applyScroll=false 模拟"被吞"（scrollTo 不动 scrollTop）；true 模拟生效（写入并 clamp）。
		 */
		async function setupLoopWrapper({ applyScroll = false } = {}) {
			const wrapper = createWrapper();
			await flushPromises();
			const el = wrapper.vm.$refs.scrollContainer;
			const scrollToSpy = applyScroll
				? vi.fn(function ({ top }) { this.scrollTop = Math.min(top, this.scrollHeight - this.clientHeight); })
				: vi.fn();
			el.scrollTo = scrollToSpy;
			Object.defineProperties(el, {
				scrollHeight: { value: 1500, configurable: true },
				scrollTop: { value: 0, configurable: true, writable: true },
				clientHeight: { value: 500, configurable: true },
			});
			return { wrapper, el, scrollToSpy };
		}

		test('被吞期间每帧重发，生效后 3 帧稳定停止且不再排帧', async () => {
			const { wrapper, el, scrollToSpy } = await setupLoopWrapper();
			const proxy = wrapper.vm.$.proxy;

			proxy.scrollToBottom(true);
			await wrapper.vm.$nextTick();
			// 前置断言：循环已启动且同步首发已发出
			expect(proxy.__forceScrollActive).toBe(true);
			expect(scrollToSpy).toHaveBeenCalledTimes(1);

			// 被吞：scrollTo 不动 scrollTop → 每帧重发
			runFrame();
			runFrame();
			expect(scrollToSpy).toHaveBeenCalledTimes(3);

			// 惯性结束：scrollTo 开始生效
			scrollToSpy.mockImplementation(function ({ top }) {
				el.scrollTop = Math.min(top, el.scrollHeight - el.clientHeight);
			});
			runFrame(); // 本帧距底仍 >1 → 发射且生效（落底）
			const callsAfterLanding = scrollToSpy.mock.calls.length;
			runFrame(); // stable=1
			runFrame(); // stable=2
			runFrame(); // stable=3 → 停止
			expect(proxy.__forceScrollActive).toBe(false);
			// 稳定帧不再发射，判稳退出后也不再排帧
			expect(scrollToSpy.mock.calls.length).toBe(callsAfterLanding);
			expect(rafQueue.size).toBe(0);
			wrapper.unmount();
		});

		test('永远被吞 → 超时停止并按真实落点回置 flag', async () => {
			const { wrapper, scrollToSpy } = await setupLoopWrapper();
			const proxy = wrapper.vm.$.proxy;

			proxy.scrollToBottom(true);
			await wrapper.vm.$nextTick();
			expect(proxy.__forceScrollActive).toBe(true);
			expect(scrollToSpy).toHaveBeenCalledTimes(1); // 前置：循环真发射过
			runFrame();

			vi.advanceTimersByTime(2501); // 仅伪造 Date：推过 FORCE_SCROLL_TIMEOUT_MS
			runFrame(); // 本帧检测超时 → 停止 + resync
			expect(proxy.__forceScrollActive).toBe(false);
			// 距底 1000：≥60 → userScrolledUp=true；>clientHeight → farFromBottom=true（按钮重现）
			expect(wrapper.vm.userScrolledUp).toBe(true);
			expect(wrapper.vm.farFromBottom).toBe(true);
			wrapper.unmount();
		});

		test('循环期间 onScroll 被抑制：flag 不变、scrollTop<50 不触发翻页', async () => {
			const { wrapper, scrollToSpy } = await setupLoopWrapper();
			const proxy = wrapper.vm.$.proxy;
			const loadSpy = vi.spyOn(proxy, '__loadMoreHistory').mockImplementation(() => {});

			proxy.scrollToBottom(true);
			await wrapper.vm.$nextTick();
			expect(proxy.__forceScrollActive).toBe(true);
			expect(scrollToSpy).toHaveBeenCalled(); // 前置：循环真发射过

			// 惯性停点 scroll 事件：scrollTop=0（<50 翻页阈值）、距底 1000（≥60）
			proxy.onScroll();
			// 未抑制时 userScrolledUp 会被打回 true（放大器），翻页会被误触发
			expect(wrapper.vm.userScrolledUp).toBe(false);
			expect(wrapper.vm.farFromBottom).toBe(false);
			expect(loadSpy).not.toHaveBeenCalled();
			wrapper.unmount();
		});

		for (const evtType of ['touchstart', 'wheel', 'pointerdown', 'mousedown']) {
			test(`用户介入（${evtType}）立即让权停止并按落点回置 flag`, async () => {
				const { wrapper, el, scrollToSpy } = await setupLoopWrapper();
				const proxy = wrapper.vm.$.proxy;
				// 隔离：wheel 会同时进 onWheel 的翻页路径，touchstart 进下拉跟踪，与本用例无关
				vi.spyOn(proxy, '__loadMoreHistory').mockImplementation(() => {});

				proxy.scrollToBottom(true);
				await wrapper.vm.$nextTick();
				expect(proxy.__forceScrollActive).toBe(true);
				expect(scrollToSpy).toHaveBeenCalled(); // 前置：循环真发射过
				const calls = scrollToSpy.mock.calls.length;

				// jsdom 对 PointerEvent/TouchEvent 构造器支持不全，用裸 Event 构造
				el.dispatchEvent(new Event(evtType));
				expect(proxy.__forceScrollActive).toBe(false);
				// 按真实落点（距底 1000）回置
				expect(wrapper.vm.userScrolledUp).toBe(true);
				expect(wrapper.vm.farFromBottom).toBe(true);
				// 残帧灭活：不再发射
				runFrame();
				expect(scrollToSpy.mock.calls.length).toBe(calls);
				wrapper.unmount();
			});
		}

		test('#2: __loadingHistory 占锁不发射，锁释放后看到恢复位置并继续逼近到底', async () => {
			const { wrapper, el, scrollToSpy } = await setupLoopWrapper({ applyScroll: true });
			const proxy = wrapper.vm.$.proxy;
			wrapper.vm.$data.__loadingHistory = true;

			proxy.scrollToBottom(true); // 锁占用：同步分支直接启动循环
			expect(proxy.__forceScrollActive).toBe(true);
			expect(rafQueue.size).toBeGreaterThan(0); // 前置：循环真在排帧（占锁时只跳过发射）
			runFrame();
			runFrame();
			expect(scrollToSpy).not.toHaveBeenCalled();

			// 锁释放 + 同一 turn 内模拟 __loadMoreHistory 的 $nextTick 位置恢复赋值。
			// 钉前提 18：恢复是微任务、循环帧必在微任务排空后执行，首个解锁帧看到的就是恢复后位置
			wrapper.vm.$data.__loadingHistory = false;
			el.scrollTop = 300;
			runFrame(); // 解锁后第一帧：从恢复位置继续逼近 → 发射
			expect(scrollToSpy).toHaveBeenCalledTimes(1);
			expect(el.scrollTop).toBe(1000); // 生效 → 到底（1500-500）
			runFrame(); // stable=1
			runFrame(); // stable=2
			runFrame(); // stable=3 → 停止
			expect(proxy.__forceScrollActive).toBe(false);
			wrapper.unmount();
		});

		test('unmount 强停循环并摘除 4 个介入监听', async () => {
			const { wrapper, el, scrollToSpy } = await setupLoopWrapper();
			const proxy = wrapper.vm.$.proxy;
			const removeSpy = vi.spyOn(el, 'removeEventListener');

			proxy.scrollToBottom(true);
			await wrapper.vm.$nextTick();
			expect(proxy.__forceScrollActive).toBe(true);
			expect(scrollToSpy).toHaveBeenCalled(); // 前置：循环真发射过
			const calls = scrollToSpy.mock.calls.length;

			wrapper.unmount();
			expect(proxy.__forceScrollActive).toBe(false);
			// 按 handler 引用过滤：beforeUnmount 还会摘下拉手势的 touchstart 等监听
			const intervene = proxy.__onForceScrollUserIntervene;
			const removed = removeSpy.mock.calls.filter((c) => c[1] === intervene).map((c) => c[0]).sort();
			expect(removed).toEqual(['mousedown', 'pointerdown', 'touchstart', 'wheel']);
			// 残帧灭活
			runFrame();
			expect(scrollToSpy.mock.calls.length).toBe(calls);
		});

		test('切 chatStore 强停循环（旧循环不得滚到新 chat）', async () => {
			const { wrapper, scrollToSpy } = await setupLoopWrapper();
			const proxy = wrapper.vm.$.proxy;

			proxy.scrollToBottom(true);
			await wrapper.vm.$nextTick();
			expect(proxy.__forceScrollActive).toBe(true);
			expect(scrollToSpy).toHaveBeenCalled(); // 前置：循环真发射过
			const calls = scrollToSpy.mock.calls.length;

			// 模拟 chatStore watcher 的 store 切换清理块（handler this 须用 $.proxy 才读得到 __ 字段）；
			// storeB 用最小桩，仅满足 watcher body 内 store.activate() 调用
			const watcher = wrapper.vm.$options.watch.chatStore;
			const storeA = wrapper.vm.chatStore;
			const storeB = { activate: vi.fn() };
			watcher.handler.call(wrapper.vm.$.proxy, storeB, storeA);

			expect(proxy.__forceScrollActive).toBe(false);
			// 旧循环残帧不再发射（不得滚到新 chat）
			runFrame();
			expect(scrollToSpy.mock.calls.length).toBe(calls);
			wrapper.unmount();
		});

		test('非 force 路径不启动循环：多帧最多 2 次 scrollTo', async () => {
			const { wrapper, scrollToSpy } = await setupLoopWrapper();
			const proxy = wrapper.vm.$.proxy;

			proxy.scrollToBottom(); // watcher / ResizeObserver / 发送路径的非 force 语义
			await wrapper.vm.$nextTick(); // nextTick 内单发第 1 次
			runFrame(); // rAF 兜底：距底仍 >10 → 第 2 次
			runFrame();
			runFrame();
			expect(scrollToSpy).toHaveBeenCalled();
			expect(scrollToSpy.mock.calls.length).toBeLessThanOrEqual(2);
			expect(proxy.__forceScrollActive).toBeFalsy();
			wrapper.unmount();
		});

		test('循环期间 __refreshFarFromBottom 被抑制：farFromBottom 不变（按钮不中途闪现）', async () => {
			const { wrapper, scrollToSpy } = await setupLoopWrapper();
			const proxy = wrapper.vm.$.proxy;

			proxy.scrollToBottom(true);
			await wrapper.vm.$nextTick();
			expect(proxy.__forceScrollActive).toBe(true);
			expect(scrollToSpy).toHaveBeenCalled(); // 前置：循环真发射过

			expect(wrapper.vm.farFromBottom).toBe(false);
			proxy.__refreshFarFromBottom(); // 距底 1000 > clientHeight，未抑制时会翻 true
			expect(wrapper.vm.farFromBottom).toBe(false);
			wrapper.unmount();
		});

		test('循环重入（连点按钮）：监听不重复挂、旧世代残帧灭活、单 rAF 链', async () => {
			const { wrapper, el, scrollToSpy } = await setupLoopWrapper();
			const proxy = wrapper.vm.$.proxy;
			const addSpy = vi.spyOn(el, 'addEventListener');
			const removeSpy = vi.spyOn(el, 'removeEventListener');

			proxy.onClickBackToBottom();
			await wrapper.vm.$nextTick();
			expect(proxy.__forceScrollActive).toBe(true);
			expect(scrollToSpy).toHaveBeenCalledTimes(1); // 前置：首循环已发射
			const gen1 = proxy.__forceScrollGen;
			// 捕获旧世代已排队的帧（模拟 cancelRAF 漏网的残帧）
			const staleCbs = [...rafQueue.values()];

			proxy.onClickBackToBottom(); // active 中再次 force → 重启
			await wrapper.vm.$nextTick();
			expect(proxy.__forceScrollActive).toBe(true);
			expect(proxy.__forceScrollGen).toBeGreaterThan(gen1);

			// 监听不重复挂：重启先摘旧 4 个再挂新 4 个，净挂载恒为 4
			const intervene = proxy.__onForceScrollUserIntervene;
			const added = addSpy.mock.calls.filter((c) => c[1] === intervene).length;
			const removed = removeSpy.mock.calls.filter((c) => c[1] === intervene).length;
			expect(added).toBe(8);
			expect(added - removed).toBe(4);

			// 旧世代残帧手动补刀：世代令牌应使其既不发射也不再排帧（不独赖 cancelRAF）
			scrollToSpy.mockClear();
			const pending = rafQueue.size;
			for (const cb of staleCbs) cb();
			expect(scrollToSpy).not.toHaveBeenCalled();
			expect(rafQueue.size).toBe(pending);

			// 新循环单 rAF 链：步进一帧恰好发射一次
			runFrame();
			expect(scrollToSpy).toHaveBeenCalledTimes(1);
			wrapper.unmount();
		});
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

	// --- __loadMoreHistory ---
	describe('__loadMoreHistory', () => {
		test('完成后不再从 finally 主动 scrollToBottom（用户上翻读历史）', async () => {
			const wrapper = createWrapper();
			await flushPromises();

			const chatStore = wrapper.vm.chatStore;
			if (!chatStore) return;

			// hasMoreMessages 路径走通：loadOlderMessages 直接返回 true，跳过 conn
			chatStore.hasMoreMessages = true;
			chatStore.loadOlderMessages = vi.fn().mockResolvedValue(true);

			const scrollContainer = wrapper.vm.$refs.scrollContainer;
			if (!scrollContainer) return;
			Object.defineProperties(scrollContainer, {
				scrollHeight: { value: 2000, configurable: true, writable: true },
				scrollTop: { value: 0, configurable: true, writable: true },
				clientHeight: { value: 500, configurable: true },
			});

			// 用户上翻读历史的状态
			wrapper.vm.userScrolledUp = true;

			const scrollSpy = vi.spyOn(wrapper.vm, 'scrollToBottom');

			await wrapper.vm.__loadMoreHistory();
			await flushPromises();
			await new Promise(r => requestAnimationFrame(r));

			expect(chatStore.loadOlderMessages).toHaveBeenCalled();
			// finally 不应再触发 scrollToBottom，否则刚翻出来的历史会被推走
			expect(scrollSpy).not.toHaveBeenCalled();
		});

		test('位置恢复用绝对赋值，盖住浏览器锚定带来的双倍位移', async () => {
			const wrapper = createWrapper();
			await flushPromises();

			const chatStore = wrapper.vm.chatStore;
			if (!chatStore) return;

			const scrollContainer = wrapper.vm.$refs.scrollContainer;
			if (!scrollContainer) return;

			// 入口快照状态：scrollTop=100, scrollHeight=1000
			Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1000, configurable: true, writable: true });
			Object.defineProperty(scrollContainer, 'scrollTop', { value: 100, configurable: true, writable: true });
			Object.defineProperty(scrollContainer, 'clientHeight', { value: 500, configurable: true });

			chatStore.hasMoreMessages = true;
			// 模拟浏览器 overflow-anchor:auto 的行为：await 期间把 scrollTop 调到 500（即 prepend 后的"自动锚定"值）
			// 同时把 scrollHeight 增大到 2000（模拟新历史已 prepend）
			chatStore.loadOlderMessages = vi.fn().mockImplementation(async () => {
				Object.defineProperty(scrollContainer, 'scrollHeight', { value: 2000, configurable: true, writable: true });
				scrollContainer.scrollTop = 500;
				return true;
			});

			wrapper.vm.userScrolledUp = true;

			await wrapper.vm.__loadMoreHistory();
			await flushPromises();

			// 期望：用入口快照 prevScrollTop(100) + diff(2000-1000) = 1100
			// 而不是 += 写法下被锚定后的 500 + 1000 = 1500（双倍过头）
			expect(scrollContainer.scrollTop).toBe(1100);
		});

		test('await loadOlderMessages 期间 chatStore 切走 → 不基于旧测量值改 scrollTop', async () => {
			const wrapper = createWrapper();
			await flushPromises();

			const storeA = wrapper.vm.chatStore;
			if (!storeA) return;

			const scrollContainer = wrapper.vm.$refs.scrollContainer;
			if (!scrollContainer) return;
			Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1000, configurable: true, writable: true });
			Object.defineProperty(scrollContainer, 'scrollTop', { value: 100, configurable: true, writable: true });
			Object.defineProperty(scrollContainer, 'clientHeight', { value: 500, configurable: true });

			storeA.hasMoreMessages = true;
			let resolveLoad;
			storeA.loadOlderMessages = vi.fn().mockReturnValue(new Promise((r) => { resolveLoad = r; }));

			const p = wrapper.vm.__loadMoreHistory();
			// 推进到 await loadOlderMessages（targetStore 已捕获为 A）
			await Promise.resolve();

			// 切到 storeB：mock chatStore getter
			const storeB = { hasMoreMessages: false, messagesLoading: false, historyExhausted: true, historyLoading: false };
			const getSpy = vi.spyOn(wrapper.vm, 'chatStore', 'get').mockReturnValue(storeB);

			// 模拟 prepend 后高度变化
			Object.defineProperty(scrollContainer, 'scrollHeight', { value: 2000, configurable: true, writable: true });
			resolveLoad(true);
			await p;
			await flushPromises();
			await new Promise((r) => requestAnimationFrame(r));

			// 切走后，旧 await 醒来不应基于旧测量值（prev 100 + diff 1000 = 1100）改新视图的 scrollTop
			expect(scrollContainer.scrollTop).toBe(100);

			getSpy.mockRestore();
		});

		test('A 加载中切到 B → B 也加载 → A 醒来 finally 不应清掉 B 的锁', async () => {
			const wrapper = createWrapper();
			await flushPromises();

			const storeA = wrapper.vm.chatStore;
			if (!storeA) return;

			storeA.hasMoreMessages = true;
			let resolveA;
			storeA.loadOlderMessages = vi.fn().mockReturnValue(new Promise((r) => { resolveA = r; }));

			// A 触发加载，await 飞行中，锁 = true
			const pA = wrapper.vm.__loadMoreHistory();
			await Promise.resolve();
			expect(wrapper.vm.$data.__loadingHistory).toBe(true);

			// 切到 B：watcher 提前清锁，再用 mock getter 把 chatStore 替换为 B
			const storeB = {
				hasMoreMessages: true,
				messagesLoading: false,
				historyExhausted: false,
				historyLoading: false,
				activate: vi.fn(),
			};
			const watcher = wrapper.vm.$options.watch.chatStore;
			watcher.handler.call(wrapper.vm, storeB, storeA);
			const getSpy = vi.spyOn(wrapper.vm, 'chatStore', 'get').mockReturnValue(storeB);
			expect(wrapper.vm.$data.__loadingHistory).toBe(false);

			// B 发起新加载，锁回到 true（这是修法要保护的状态）
			let resolveB;
			storeB.loadOlderMessages = vi.fn().mockReturnValue(new Promise((r) => { resolveB = r; }));
			const pB = wrapper.vm.__loadMoreHistory();
			await Promise.resolve();
			expect(wrapper.vm.$data.__loadingHistory).toBe(true);

			// A 醒来：race guard 早退，finally 看 store 不一致 → 不应清 B 的锁
			resolveA(true);
			await pA;
			await flushPromises();
			expect(wrapper.vm.$data.__loadingHistory).toBe(true);

			// B 完成时正常清锁
			resolveB(true);
			await pB;
			await flushPromises();
			expect(wrapper.vm.$data.__loadingHistory).toBe(false);

			getSpy.mockRestore();
		});

		test('await loadOlderMessages 期间组件已卸载 → 不动 DOM', async () => {
			const wrapper = createWrapper();
			await flushPromises();

			const storeA = wrapper.vm.chatStore;
			if (!storeA) return;

			const sc = wrapper.vm.$refs.scrollContainer;
			if (!sc) return;
			Object.defineProperty(sc, 'scrollHeight', { value: 1000, configurable: true, writable: true });
			Object.defineProperty(sc, 'scrollTop', { value: 100, configurable: true, writable: true });
			Object.defineProperty(sc, 'clientHeight', { value: 500, configurable: true });

			storeA.hasMoreMessages = true;
			let resolveLoad;
			storeA.loadOlderMessages = vi.fn().mockReturnValue(new Promise((r) => { resolveLoad = r; }));

			const p = wrapper.vm.__loadMoreHistory();
			await Promise.resolve();

			// 模拟组件已卸载
			wrapper.vm.__unmounted = true;

			Object.defineProperty(sc, 'scrollHeight', { value: 2000, configurable: true, writable: true });
			resolveLoad(true);
			await p;
			await flushPromises();
			await new Promise((r) => requestAnimationFrame(r));

			// unmount 后不应改 scrollTop
			expect(sc.scrollTop).toBe(100);
		});

		test('await loadNextHistorySession 期间 chatStore 切走 → 不基于旧测量值改 scrollTop', async () => {
			const wrapper = createWrapper();
			await flushPromises();

			const storeA = wrapper.vm.chatStore;
			if (!storeA) return;

			const sc = wrapper.vm.$refs.scrollContainer;
			if (!sc) return;
			Object.defineProperty(sc, 'scrollHeight', { value: 1000, configurable: true, writable: true });
			Object.defineProperty(sc, 'scrollTop', { value: 100, configurable: true, writable: true });
			Object.defineProperty(sc, 'clientHeight', { value: 500, configurable: true });

			// 走第二条分支：当前 session 内无更多消息，跨 session 拉历史
			storeA.hasMoreMessages = false;
			storeA.messagesLoading = false;
			// historyExhausted 现在是 getter，由 rawHistorySessionIds + counter 推导；
			// 设置 raw 为有内容且 counter=0 → exhausted=false
			storeA.rawHistorySessionIds = [{ sessionId: 'h1', archivedAt: 100 }];
			storeA.__historyLoadedCount = 0;
			storeA.historyLoading = false;
			let resolveLoad;
			storeA.loadNextHistorySession = vi.fn().mockReturnValue(new Promise((r) => { resolveLoad = r; }));

			const p = wrapper.vm.__loadMoreHistory();
			await Promise.resolve();

			const storeB = { hasMoreMessages: false, messagesLoading: false, historyExhausted: true, historyLoading: false };
			const getSpy = vi.spyOn(wrapper.vm, 'chatStore', 'get').mockReturnValue(storeB);

			Object.defineProperty(sc, 'scrollHeight', { value: 2000, configurable: true, writable: true });
			resolveLoad(true);
			await p;
			await flushPromises();
			await new Promise((r) => requestAnimationFrame(r));

			expect(sc.scrollTop).toBe(100);

			getSpy.mockRestore();
		});

		test('chatStore 切换时清 __loadingHistory（避免阻塞新 chat scrollToBottom）', async () => {
			const wrapper = createWrapper();
			await flushPromises();

			const storeA = wrapper.vm.chatStore;
			expect(storeA).toBeTruthy();

			// __loadingHistory 在 data() 中以 `__` 前缀声明，Vue 3 把首次访问的 access
			// type 缓存为 OTHER，导致代理上读取返回 undefined（写仍能落到 $data）。
			// 因此外部观察必须经 $data 看真值。详见 Vue 源 isReservedPrefix 警告。
			// 模拟旧 chat 历史加载仍在飞行（__loadingHistory 还没回到 false）
			wrapper.vm.$data.__loadingHistory = true;
			expect(wrapper.vm.$data.__loadingHistory).toBe(true);

			// 直接调用 chatStore watcher 的 handler 模拟切换到另一 store。
			// storeB 用最小桩，仅满足 watcher body 内 store.activate() 调用；
			// connReady=false 时不会进入 __onConnReady。
			const storeB = { activate: vi.fn() };
			const watcher = wrapper.vm.$options.watch.chatStore;
			watcher.handler.call(wrapper.vm, storeB, storeA);

			// 切走那一刻，旧加载逻辑上跟当前页面无关；标志要清零，否则新 chat 的
			// scrollToBottom 会被这个残留 true 拦下来。
			expect(wrapper.vm.$data.__loadingHistory).toBe(false);
		});

		test('__creatingTopic 期间 watcher 早退 → 仍要清 __loadingHistory（避免锁卡 true）', async () => {
			const wrapper = createWrapper();
			await flushPromises();

			const storeA = wrapper.vm.chatStore;
			expect(storeA).toBeTruthy();

			// 模拟旧 chat 一次历史加载在飞行
			wrapper.vm.$data.__loadingHistory = true;
			// 模拟同时手指还按着 mid-touch（已过阈值但未释放），前置清块应一并清掉
			wrapper.vm.__pullStartY = 100;
			wrapper.vm.pullDistance = 200;
			// 模拟新建 topic 流程进行中（__handleNewTopicSend 期间）
			wrapper.vm.$data.__creatingTopic = true;

			// 触发 chatStore watcher 模拟 promote 后 router.replace 引发的 store 切换。
			// 注意 `this` 必须用 wrapper.vm.$.proxy（Vue 3 内部 publicInstance 代理），
			// 不能用 wrapper.vm（test-utils 包装层的代理把 __ 前缀 data 读为 undefined：
			// runtime-core 在 ctx 上对 reserved prefix 不 defineProperty，test-utils 的
			// vm proxy 又只走 ctx 通道）——否则 watcher 内 this.__creatingTopic 永远是
			// undefined，早退分支根本走不到。
			const storeB = { activate: vi.fn() };
			const watcher = wrapper.vm.$options.watch.chatStore;
			watcher.handler.call(wrapper.vm.$.proxy, storeB, storeA);

			// 即便 watcher 因 __creatingTopic 早退跳过 store.activate()，
			// __loadingHistory 也应被清掉，否则旧 await 醒来 finally 因 store 不等
			// 也不清锁，锁永远卡 true，新页面再下拉永远进不去。
			expect(wrapper.vm.$data.__loadingHistory).toBe(false);
			// 前置清块承诺三变量都清——__creatingTopic 早退路径下 pull 状态也不能漏
			expect(wrapper.vm.__pullStartY).toBeNull();
			expect(wrapper.vm.pullDistance).toBe(0);
			expect(storeB.activate).not.toHaveBeenCalled();

			wrapper.vm.$data.__creatingTopic = false;
		});

		test('chatStore 切换时清 __pullStartY/pullDistance（mid-touch 切 chat 不让旧手势误触发加载）', async () => {
			const wrapper = createWrapper();
			await flushPromises();

			const storeA = wrapper.vm.chatStore;
			expect(storeA).toBeTruthy();

			// 模拟用户在 chat A 上 mid-touch：起点已记录、已 pull 过阈值，但还没释放
			wrapper.vm.__pullStartY = 100;
			wrapper.vm.pullDistance = 200;

			// 触发 chatStore watcher 模拟程序化切到 chat B（实例不重建）
			const storeB = { activate: vi.fn() };
			const watcher = wrapper.vm.$options.watch.chatStore;
			watcher.handler.call(wrapper.vm, storeB, storeA);

			// 切走后旧手势状态应被清掉，否则若用户随后在新 chat 上释放手指，
			// __onPullEnd 会用旧 dist=200 触发新 chat 的 __loadMoreHistory
			expect(wrapper.vm.__pullStartY).toBeNull();
			expect(wrapper.vm.pullDistance).toBe(0);
		});
	});

	// --- 触屏下拉加载历史 ---
	describe('touch-pull load history', () => {
		function makeTouchEvent(type, clientY) {
			const e = new Event(type, { bubbles: true, cancelable: true });
			Object.defineProperty(e, 'touches', { value: [{ clientY }] });
			Object.defineProperty(e, 'targetTouches', { value: [{ clientY }] });
			return e;
		}

		test('内容未溢出时下拉超过阈值触发 __loadMoreHistory', async () => {
			const wrapper = createWrapper();
			await flushPromises();

			const scrollContainer = wrapper.vm.$refs.scrollContainer;
			if (!scrollContainer) return;
			// 内容刚好等于容器（无溢出）→ 现有 onScroll/onWheel 路径在触屏上发不出
			Object.defineProperties(scrollContainer, {
				scrollHeight: { value: 500, configurable: true, writable: true },
				scrollTop: { value: 0, configurable: true, writable: true },
				clientHeight: { value: 500, configurable: true },
			});

			const loadMoreSpy = vi.spyOn(wrapper.vm, '__loadMoreHistory').mockResolvedValue(undefined);

			scrollContainer.dispatchEvent(makeTouchEvent('touchstart', 100));
			scrollContainer.dispatchEvent(makeTouchEvent('touchmove', 200)); // 下拉 100px
			scrollContainer.dispatchEvent(makeTouchEvent('touchend', 200));

			expect(loadMoreSpy).toHaveBeenCalled();
		});

		test('按下时不在最顶（scrollTop>0）→ 让浏览器照常处理，不触发加载', async () => {
			const wrapper = createWrapper();
			await flushPromises();

			const scrollContainer = wrapper.vm.$refs.scrollContainer;
			if (!scrollContainer) return;
			Object.defineProperties(scrollContainer, {
				scrollHeight: { value: 2000, configurable: true, writable: true },
				scrollTop: { value: 500, configurable: true, writable: true },
				clientHeight: { value: 500, configurable: true },
			});

			const loadMoreSpy = vi.spyOn(wrapper.vm, '__loadMoreHistory').mockResolvedValue(undefined);

			scrollContainer.dispatchEvent(makeTouchEvent('touchstart', 100));
			scrollContainer.dispatchEvent(makeTouchEvent('touchmove', 200));
			scrollContainer.dispatchEvent(makeTouchEvent('touchend', 200));

			expect(loadMoreSpy).not.toHaveBeenCalled();
		});

		test('在最顶但下拉未过阈值 → 不触发加载', async () => {
			const wrapper = createWrapper();
			await flushPromises();

			const scrollContainer = wrapper.vm.$refs.scrollContainer;
			if (!scrollContainer) return;
			Object.defineProperties(scrollContainer, {
				scrollHeight: { value: 500, configurable: true, writable: true },
				scrollTop: { value: 0, configurable: true, writable: true },
				clientHeight: { value: 500, configurable: true },
			});

			const loadMoreSpy = vi.spyOn(wrapper.vm, '__loadMoreHistory').mockResolvedValue(undefined);

			scrollContainer.dispatchEvent(makeTouchEvent('touchstart', 100));
			scrollContainer.dispatchEvent(makeTouchEvent('touchmove', 130)); // 仅下拉 30px，未过阈值
			scrollContainer.dispatchEvent(makeTouchEvent('touchend', 130));

			expect(loadMoreSpy).not.toHaveBeenCalled();
		});

		test('topic 路由下不触发（与现有 __loadMoreHistory 入口约束一致）', async () => {
			const wrapper = createWrapper({ routeName: 'topics-chat', sessionId: 'topic-1' });
			await flushPromises();

			const scrollContainer = wrapper.vm.$refs.scrollContainer;
			if (!scrollContainer) return;
			Object.defineProperties(scrollContainer, {
				scrollHeight: { value: 500, configurable: true, writable: true },
				scrollTop: { value: 0, configurable: true, writable: true },
				clientHeight: { value: 500, configurable: true },
			});

			const loadMoreSpy = vi.spyOn(wrapper.vm, '__loadMoreHistory').mockResolvedValue(undefined);

			scrollContainer.dispatchEvent(makeTouchEvent('touchstart', 100));
			scrollContainer.dispatchEvent(makeTouchEvent('touchmove', 200));
			scrollContainer.dispatchEvent(makeTouchEvent('touchend', 200));

			expect(loadMoreSpy).not.toHaveBeenCalled();
		});

		test('下拉刚好等于 60px 阈值 → 触发加载（边界）', async () => {
			const wrapper = createWrapper();
			await flushPromises();

			const scrollContainer = wrapper.vm.$refs.scrollContainer;
			if (!scrollContainer) return;
			Object.defineProperties(scrollContainer, {
				scrollHeight: { value: 500, configurable: true, writable: true },
				scrollTop: { value: 0, configurable: true, writable: true },
				clientHeight: { value: 500, configurable: true },
			});

			const loadMoreSpy = vi.spyOn(wrapper.vm, '__loadMoreHistory').mockResolvedValue(undefined);

			scrollContainer.dispatchEvent(makeTouchEvent('touchstart', 100));
			scrollContainer.dispatchEvent(makeTouchEvent('touchmove', 160)); // 刚好 60px
			scrollContainer.dispatchEvent(makeTouchEvent('touchend', 160));

			expect(loadMoreSpy).toHaveBeenCalled();
		});

		test('touchcancel 即使下拉超过阈值也不触发加载（手势被中断当作 abort）', async () => {
			const wrapper = createWrapper();
			await flushPromises();

			const scrollContainer = wrapper.vm.$refs.scrollContainer;
			if (!scrollContainer) return;
			Object.defineProperties(scrollContainer, {
				scrollHeight: { value: 500, configurable: true, writable: true },
				scrollTop: { value: 0, configurable: true, writable: true },
				clientHeight: { value: 500, configurable: true },
			});

			const loadMoreSpy = vi.spyOn(wrapper.vm, '__loadMoreHistory').mockResolvedValue(undefined);

			scrollContainer.dispatchEvent(makeTouchEvent('touchstart', 100));
			scrollContainer.dispatchEvent(makeTouchEvent('touchmove', 200)); // 远超 60px 阈值
			scrollContainer.dispatchEvent(makeTouchEvent('touchcancel', 200));

			expect(loadMoreSpy).not.toHaveBeenCalled();
		});
	});

	// --- 触屏下拉指示器视觉 ---
	describe('touch-pull indicator visual', () => {
		test('未拉动且未加载时指示器隐藏（v-show 实际生效），图标默认为 arrow-down', async () => {
			const wrapper = createWrapper();
			await flushPromises();
			expect(wrapper.vm.pullIndicatorVisible).toBe(false);
			// v-show 真的把节点 display:none 了，否则承诺没接到模板
			const indicator = wrapper.find('[data-testid="pull-indicator"]');
			expect(indicator.exists()).toBe(true);
			expect(indicator.element.style.display).toBe('none');
			// 默认图标是 arrow-down（未过阈值形态）
			expect(indicator.html()).toContain('i-lucide-arrow-down');
			expect(indicator.html()).not.toContain('i-lucide-refresh-cw');
		});

		test('拉动中指示器显示且 opacity 随距离线性增长', async () => {
			const wrapper = createWrapper();
			await flushPromises();
			wrapper.vm.pullDistance = 30;
			await wrapper.vm.$nextTick();
			expect(wrapper.vm.pullIndicatorVisible).toBe(true);
			// v-show 已让节点可见
			const indicator = wrapper.find('[data-testid="pull-indicator"]');
			expect(indicator.element.style.display).not.toBe('none');
			// 30/60 = 0.5
			expect(wrapper.vm.pullIndicatorStyle.opacity).toBeCloseTo(0.5, 5);
			// 未过阈值
			expect(wrapper.vm.pullIndicatorPastThreshold).toBe(false);
		});

		test('过阈值切换为 past-threshold 形态（图标切到 refresh-cw，但未旋转）', async () => {
			const wrapper = createWrapper();
			await flushPromises();
			wrapper.vm.pullDistance = 60;
			await wrapper.vm.$nextTick();
			expect(wrapper.vm.pullIndicatorPastThreshold).toBe(true);
			// 已饱和到 1
			expect(wrapper.vm.pullIndicatorStyle.opacity).toBe(1);
			// 仅过阈值（手指还在屏幕上），不该旋转——避免误导"已在加载"
			expect(wrapper.vm.pullIndicatorSpinning).toBe(false);
			const indicator = wrapper.find('[data-testid="pull-indicator"]');
			// DOM 上图标 name 真切到了 refresh-cw（验证模板 :name 绑定接线）
			expect(indicator.html()).toContain('i-lucide-refresh-cw');
			expect(indicator.html()).not.toContain('i-lucide-arrow-down');
			// DOM 上 animate-spin class 不该挂上
			expect(indicator.html()).not.toContain('animate-spin');
		});

		test('手势加载中：pullDistance=0 + __pullGestureLoading=true → 指示器仍显示、定位到阈值并旋转', async () => {
			const wrapper = createWrapper();
			await flushPromises();
			wrapper.vm.pullDistance = 0;
			wrapper.vm.$data.__pullGestureLoading = true;
			await wrapper.vm.$nextTick();

			expect(wrapper.vm.pullIndicatorVisible).toBe(true);
			expect(wrapper.vm.pullIndicatorPastThreshold).toBe(true);
			expect(wrapper.vm.pullIndicatorSpinning).toBe(true);
			// 加载中定在阈值位置 (60-8=52)
			expect(wrapper.vm.pullIndicatorStyle.top).toContain('52px');
			expect(wrapper.vm.pullIndicatorStyle.opacity).toBe(1);
			// 释放回弹用 transition，加载中 pullDistance=0 也算 releasing
			expect(wrapper.vm.pullIndicatorStyle.transition).toContain('0.2s');
			const indicator = wrapper.find('[data-testid="pull-indicator"]');
			// DOM 上 animate-spin class 必须挂上
			expect(indicator.html()).toContain('animate-spin');
			// 验证模板 :style 真把 computed 接到了 element.style（top/opacity/transition）
			// jsdom 不解析 calc()，element.style.top 仍以原始字符串保留
			expect(indicator.element.style.top).toContain('52px');
			expect(indicator.element.style.opacity).toBe('1');
			expect(indicator.element.style.transition).toContain('0.2s');
		});

		test('拉动过程中无 transition（避免跟手卡顿）', async () => {
			const wrapper = createWrapper();
			await flushPromises();
			wrapper.vm.pullDistance = 40;
			expect(wrapper.vm.pullIndicatorStyle.transition).toBe('none');
		});

		test('负距离（用户向上滑）→ 指示器隐藏，opacity 不为负', async () => {
			const wrapper = createWrapper();
			await flushPromises();
			wrapper.vm.pullDistance = -20;
			expect(wrapper.vm.pullIndicatorVisible).toBe(false);
			expect(wrapper.vm.pullIndicatorStyle.opacity).toBe(0);

			// 但 __pullGestureLoading 一旦为真，即便此时 pullDistance 仍是负数
			// 也应保持显示（loading 分支独立维持可见性）
			wrapper.vm.$data.__pullGestureLoading = true;
			expect(wrapper.vm.pullIndicatorVisible).toBe(true);
		});

		test('视觉位置 clamp 到 100px：拉到 200px 也不会飞到屏幕中部', async () => {
			const wrapper = createWrapper();
			await flushPromises();
			wrapper.vm.pullDistance = 200;
			// top 应是 safe + (100 - 8) = safe + 92px，而不是 safe + 192px
			expect(wrapper.vm.pullIndicatorStyle.top).toContain('92px');
			expect(wrapper.vm.pullIndicatorStyle.top).not.toContain('192px');
			// opacity 仍饱和 1（200/60 ≥ 1，clamp 后等价）
			expect(wrapper.vm.pullIndicatorStyle.opacity).toBe(1);
			// 触发判定看 raw 值（>=60）—— 由 __onPullEnd 验证，此处只查视觉
		});

		test('非手势触发的加载（__loadingHistory=true 但 __pullGestureLoading=false）不亮指示器', async () => {
			// 模拟 onScroll/onWheel/__autoFillHistory 路径触发的加载：
			// 通用加载锁置 true，但手势标志保持 false
			const wrapper = createWrapper();
			await flushPromises();
			wrapper.vm.$data.__loadingHistory = true;
			wrapper.vm.$data.__pullGestureLoading = false;
			await wrapper.vm.$nextTick();

			expect(wrapper.vm.pullIndicatorVisible).toBe(false);
			expect(wrapper.find('[data-testid="pull-indicator"]').element.style.display).toBe('none');
		});

		test('手势触发的加载完成后自动清 __pullGestureLoading（指示器隐藏，loadOlderMessages 真被调用）', async () => {
			const wrapper = createWrapper();
			await flushPromises();

			const store = wrapper.vm.chatStore;
			// 桩出 hasMoreMessages + loadOlderMessages，让 __loadMoreHistory 走"当前 session 内"分支
			Object.defineProperty(store, 'hasMoreMessages', { value: true, configurable: true });
			Object.defineProperty(store, 'messagesLoading', { value: false, configurable: true });
			store.loadOlderMessages = vi.fn().mockResolvedValue(true);

			// 模拟手势触发：dist>=60 → __onPullEnd 调 __loadMoreHistory(true)
			wrapper.vm.pullDistance = 80;
			wrapper.vm.__onPullEnd();
			// 入口同步置 true
			expect(wrapper.vm.$data.__pullGestureLoading).toBe(true);

			// 等加载 promise + finally 运行
			await flushPromises();
			await wrapper.vm.$nextTick();

			// 加载结束后标志被回收
			expect(wrapper.vm.$data.__pullGestureLoading).toBe(false);
			expect(wrapper.vm.$data.__loadingHistory).toBe(false);
			// 加载真的发生了，而非空跑（避免"flag 来回切但什么都没做"的退化实现也通过）
			expect(store.loadOlderMessages).toHaveBeenCalled();
			// 终态：DOM 上指示器隐藏（v-show display:none）
			expect(wrapper.find('[data-testid="pull-indicator"]').element.style.display).toBe('none');
		});

		test('非手势调 __loadMoreHistory()（不传参数）→ __pullGestureLoading 始终不被置 true', async () => {
			// 因果链验证：onScroll/onWheel/__autoFillHistory 共用 __loadMoreHistory()，
			// 默认参数 fromPullGesture=false 不应误开手势加载标志
			const wrapper = createWrapper();
			await flushPromises();

			const store = wrapper.vm.chatStore;
			Object.defineProperty(store, 'hasMoreMessages', { value: true, configurable: true });
			Object.defineProperty(store, 'messagesLoading', { value: false, configurable: true });
			store.loadOlderMessages = vi.fn().mockResolvedValue(true);

			// 不传参数（模拟 onScroll/onWheel/__autoFillHistory 路径）
			const promise = wrapper.vm.__loadMoreHistory();
			// 入口同步阶段——通用锁会被置 true，但手势锁绝不能被置 true
			expect(wrapper.vm.$data.__loadingHistory).toBe(true);
			expect(wrapper.vm.$data.__pullGestureLoading).toBe(false);

			await promise;
			await wrapper.vm.$nextTick();

			// 加载真的发生且通用锁回收，手势锁全程为 false
			expect(store.loadOlderMessages).toHaveBeenCalled();
			expect(wrapper.vm.$data.__loadingHistory).toBe(false);
			expect(wrapper.vm.$data.__pullGestureLoading).toBe(false);
			// 整段过程中指示器从未显示
			expect(wrapper.find('[data-testid="pull-indicator"]').element.style.display).toBe('none');
		});

		test('chatStore 切换时清 __pullGestureLoading（避免切走后指示器残留）', async () => {
			const wrapper = createWrapper();
			await flushPromises();

			const storeA = wrapper.vm.chatStore;
			wrapper.vm.$data.__pullGestureLoading = true;
			expect(wrapper.vm.$data.__pullGestureLoading).toBe(true);

			const storeB = { activate: vi.fn() };
			const watcher = wrapper.vm.$options.watch.chatStore;
			watcher.handler.call(wrapper.vm, storeB, storeA);

			expect(wrapper.vm.$data.__pullGestureLoading).toBe(false);
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

	test('pre-accepted 期间 dragover 被拒绝（不 preventDefault、不开蒙层）', async () => {
		const wrapper = createWrapper();
		await flushPromises();
		const chatStore = getChatStore();
		chatStore.sending = true;
		chatStore.__accepted = false;
		await flushPromises();

		const root = wrapper.find('[data-testid="chat-root"]');
		const evt = new Event('dragover', { bubbles: true });
		evt.preventDefault = vi.fn();
		Object.defineProperty(evt, 'dataTransfer', { value: { types: ['Files'] } });
		root.element.dispatchEvent(evt);

		expect(wrapper.vm.dragging).toBe(false);
		expect(evt.preventDefault).not.toHaveBeenCalled();
	});

	test('pre-accepted 期间 drop 丢弃拖入文件', async () => {
		mockAddFiles.mockClear();
		const wrapper = createWrapper();
		await flushPromises();
		const chatStore = getChatStore();
		chatStore.sending = true;
		chatStore.__accepted = false;
		await flushPromises();

		const root = wrapper.find('[data-testid="chat-root"]');
		const file = new File(['hi'], 'a.txt', { type: 'text/plain' });
		const evt = new Event('drop', { bubbles: true });
		evt.preventDefault = vi.fn();
		Object.defineProperty(evt, 'dataTransfer', { value: { files: [file] } });
		root.element.dispatchEvent(evt);

		expect(evt.preventDefault).not.toHaveBeenCalled();
		expect(mockAddFiles).not.toHaveBeenCalled();
	});

	test('accepted 后 drop 允许添加文件（sending=true 但 __accepted=true）', async () => {
		mockAddFiles.mockClear();
		const wrapper = createWrapper();
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
		setupAgents();
		await flushPromises();
		const chatStore = getChatStore();
		chatStore.sending = true;
		chatStore.__accepted = true;
		await flushPromises();

		const root = wrapper.find('[data-testid="chat-root"]');
		const file = new File(['hi'], 'b.txt', { type: 'text/plain' });
		const evt = new Event('drop', { bubbles: true });
		evt.preventDefault = vi.fn();
		Object.defineProperty(evt, 'dataTransfer', { value: { files: [file] } });
		root.element.dispatchEvent(evt);

		expect(evt.preventDefault).toHaveBeenCalled();
		expect(mockAddFiles).toHaveBeenCalledWith([file]);
	});
});

// --- 刷新按钮 ---

describe('ChatPage refresh button', () => {
	const wrappers = [];
	beforeEach(() => {
		vi.clearAllMocks();
		chatStoreManager.__reset();
	});
	afterEach(() => {
		// 清 mounted 注册的 window/document 监听器，避免跨测试累积
		while (wrappers.length) wrappers.pop().unmount();
	});

	/** 创建一个 connReady=true 的 wrapper + chatStore，并 mock loadMessages */
	async function setupReady() {
		const pinia = createPinia();
		setActivePinia(pinia);
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
		clawsStore.byId['bot-1'].dcReady = true;
		setupAgents();
		const chatStore = chatStoreManager.get('session:bot-1:main', { clawId: 'bot-1', agentId: 'main' });
		chatStore.__initialized = true;
		chatStore.__messagesLoaded = true;
		const loadSpy = vi.spyOn(chatStore, 'loadMessages').mockResolvedValue(true);
		const wrapper = mount(ChatPage, {
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
		// 清掉 connReady watcher 触发的初始 load，关注按钮点击路径
		loadSpy.mockClear();
		wrappers.push(wrapper);
		return { wrapper, chatStore, loadSpy };
	}

	test('点击触发 silent loadMessages', async () => {
		const { wrapper, loadSpy } = await setupReady();
		await wrapper.vm.onRefresh();
		expect(loadSpy).toHaveBeenCalledWith({ silent: true });
	});

	test('refreshing 期间拦截重入（快速双击只发一次 RPC）', async () => {
		const { wrapper, chatStore, loadSpy } = await setupReady();
		let resolveLoad;
		chatStore.loadMessages.mockImplementation(() => new Promise((r) => { resolveLoad = r; }));
		const p1 = wrapper.vm.onRefresh();
		// 让 p1 的同步前缀跑完，refreshing guard 就位再试第二次点击
		await Promise.resolve();
		expect(wrapper.vm.refreshing).toBe(true);
		const p2 = wrapper.vm.onRefresh();
		expect(loadSpy).toHaveBeenCalledTimes(1);
		resolveLoad(true);
		await Promise.all([p1, p2]);
		expect(wrapper.vm.refreshing).toBe(false);
	});

	test('成功后清空 errorText 残留（initial load 失败后的恢复路径）', async () => {
		const { wrapper, chatStore } = await setupReady();
		chatStore.errorText = 'prior error';
		await wrapper.vm.onRefresh();
		expect(chatStore.errorText).toBe('');
	});

	test('silent load 返回 false 时不清 errorText（避免误清真实错误）', async () => {
		const { wrapper, chatStore } = await setupReady();
		chatStore.loadMessages.mockResolvedValue(false);
		chatStore.errorText = 'prior error';
		await wrapper.vm.onRefresh();
		expect(chatStore.errorText).toBe('prior error');
	});

	test('finally 分支：loadMessages 抛错时 refreshing 也会复位', async () => {
		const { wrapper, chatStore } = await setupReady();
		chatStore.loadMessages.mockRejectedValue(new Error('boom'));
		await expect(wrapper.vm.onRefresh()).rejects.toThrow('boom');
		expect(wrapper.vm.refreshing).toBe(false);
	});

	test('refreshDisabled：connReady=false 时禁用', async () => {
		const { wrapper } = await setupReady();
		const clawsStore = useClawsStore();
		clawsStore.byId['bot-1'].dcReady = false;
		await wrapper.vm.$nextTick();
		expect(wrapper.vm.refreshDisabled).toBe(true);
	});

	test('refreshDisabled：chatStore.isLoadingMessages=true 时禁用', async () => {
		const { wrapper, chatStore } = await setupReady();
		chatStore.__silentLoadPromise = Promise.resolve(true);
		await wrapper.vm.$nextTick();
		expect(wrapper.vm.refreshDisabled).toBe(true);
		expect(wrapper.vm.refreshLoading).toBe(true);
	});

	test('refreshDisabled：refreshing=true 时禁用', async () => {
		const { wrapper } = await setupReady();
		wrapper.vm.refreshing = true;
		await wrapper.vm.$nextTick();
		expect(wrapper.vm.refreshDisabled).toBe(true);
		expect(wrapper.vm.refreshLoading).toBe(true);
	});

	test('按钮 DOM 在 connReady=true、非 loading 时可点', async () => {
		const { wrapper } = await setupReady();
		const btn = wrapper.find('[data-testid="btn-refresh-mobile"]');
		expect(btn.exists()).toBe(true);
		expect(wrapper.vm.refreshDisabled).toBe(false);
	});

	test('DOM 层：disabled 状态下点击不触发 loadMessages', async () => {
		const { wrapper, loadSpy } = await setupReady();
		const clawsStore = useClawsStore();
		clawsStore.byId['bot-1'].dcReady = false; // 让 connReady=false → refreshDisabled=true
		await wrapper.vm.$nextTick();
		const btn = wrapper.find('[data-testid="btn-refresh-mobile"]');
		await btn.trigger('click');
		await flushPromises();
		expect(loadSpy).not.toHaveBeenCalled();
	});

	test('移动端和桌面端两份按钮各自独立存在（通过 -mobile / -desktop testid 区分）', async () => {
		const { wrapper } = await setupReady();
		// Tailwind md:hidden / md:flex 只控制可见性，DOM 节点都会挂载，testid 分离避免 e2e strict-mode 冲突
		expect(wrapper.find('[data-testid="btn-refresh-mobile"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="btn-refresh-desktop"]').exists()).toBe(true);
	});
});

// --- 恢复路径 watcher 契约（claw offline / sig offline / ICE restart） ---

describe('ChatPage recovery watchers', () => {
	/**
	 * 通用 setup：挂载一个 connReady=true 的 wrapper 并 mock loadMessages。
	 * 挂载后立即 mockClear，使后续断言只关注恢复路径引发的调用次数。
	 */
	async function setupConnReadyWrapper() {
		const pinia = createPinia();
		setActivePinia(pinia);
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
		clawsStore.byId['bot-1'].dcReady = true;
		clawsStore.byId['bot-1'].rtcPhase = 'ready';
		setupAgents();

		const chatStore = chatStoreManager.get('session:bot-1:main', { clawId: 'bot-1', agentId: 'main' });
		chatStore.__initialized = true;
		chatStore.__messagesLoaded = true;
		chatStore.sending = false;
		const loadSpy = vi.spyOn(chatStore, 'loadMessages').mockResolvedValue(true);

		const wrapper = mount(ChatPage, {
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
		// immediate watcher 已触发一次 silent load；清记录，聚焦后续恢复路径
		expect(loadSpy).toHaveBeenCalled();
		loadSpy.mockClear();
		return { wrapper, chatStore, clawsStore, loadSpy };
	}

	beforeEach(() => {
		vi.clearAllMocks();
		chatStoreManager.__reset();
	});

	// T1：presence 与 DC 正交 —— online→false 不动 dcReady，connReady 持稳
	test('claw 下线不改 dcReady 且不重复触发 silent reload（presence 与 DC 正交）', async () => {
		const { wrapper, clawsStore, loadSpy } = await setupConnReadyWrapper();

		clawsStore.updateClawOnline('bot-1', false);
		await wrapper.vm.$nextTick();

		const claw = clawsStore.byId['bot-1'];
		expect(claw.online).toBe(false);
		// __handleClawGoOffline 不碰 dcReady（presence 与 DC 生命周期两把锁正交）
		expect(claw.dcReady).toBe(true);
		// connReady 只看 dcReady（+ agentVerified），dcReady 未变 → watcher 不该再跑
		expect(loadSpy).not.toHaveBeenCalled();
	});

	// T2：claw offline 且 DC 随后断 → rebuild 完成后触发 silent reload
	test('claw 下线后 DC 关闭令 connReady 翻 false，rebuild 完成再翻 true 恰好触发 1 次 silent reload', async () => {
		const { wrapper, clawsStore, loadSpy } = await setupConnReadyWrapper();

		clawsStore.updateClawOnline('bot-1', false);
		await wrapper.vm.$nextTick();

		// DC 关闭：webrtc-connection 的 state='closed'|'failed' 分支会翻 dcReady=false
		clawsStore.byId['bot-1'].dcReady = false;
		clawsStore.byId['bot-1'].rtcPhase = 'failed';
		await wrapper.vm.$nextTick();
		expect(wrapper.vm.connReady).toBe(false);

		// online 回来且 rebuild 完成
		clawsStore.byId['bot-1'].online = true;
		clawsStore.byId['bot-1'].dcReady = true;
		clawsStore.byId['bot-1'].rtcPhase = 'ready';
		await wrapper.vm.$nextTick();
		expect(wrapper.vm.connReady).toBe(true);

		// __messagesLoaded=true → 走 silent 分支；connReady 翻 true 恰好 1 次 load
		expect(loadSpy).toHaveBeenCalledTimes(1);
		expect(loadSpy).toHaveBeenCalledWith({ silent: true });
	});

	// T3：ICE restart 全程 DC 不断，connReady 不翻转 → 无额外 load
	test('ICE restart 期间 DC 延续（dcReady 始终 true）不触发任何 reload', async () => {
		const { wrapper, clawsStore, loadSpy } = await setupConnReadyWrapper();

		// ICE restart 开始：rtcPhase 翻 restarting，但 DC 保留
		clawsStore.byId['bot-1'].rtcPhase = 'restarting';
		await wrapper.vm.$nextTick();
		// dcReady 没动 → connReady 必须仍为 true
		expect(wrapper.vm.connReady).toBe(true);

		// restart 成功：回到 ready，全程 dcReady 未被翻
		clawsStore.byId['bot-1'].rtcPhase = 'ready';
		await wrapper.vm.$nextTick();

		expect(clawsStore.byId['bot-1'].dcReady).toBe(true);
		// connReady 全程保持 true，watcher 不该再触发
		expect(loadSpy).not.toHaveBeenCalled();
	});

	// T4：ICE restart 导致 DC 重建 —— 掉线→重建 → 恰好 1 次 silent reload
	test('ICE restart 导致 DC 重建：connReady false→true 恰好触发 1 次 silent reload', async () => {
		const { wrapper, clawsStore, loadSpy } = await setupConnReadyWrapper();

		clawsStore.byId['bot-1'].rtcPhase = 'restarting';
		await wrapper.vm.$nextTick();

		// DC 掉（restart 过程中旧 DC 真的断了）
		clawsStore.byId['bot-1'].dcReady = false;
		clawsStore.byId['bot-1'].rtcPhase = 'failed';
		await wrapper.vm.$nextTick();
		expect(wrapper.vm.connReady).toBe(false);

		// 新 DC 就绪
		clawsStore.byId['bot-1'].dcReady = true;
		clawsStore.byId['bot-1'].rtcPhase = 'ready';
		await wrapper.vm.$nextTick();
		expect(wrapper.vm.connReady).toBe(true);

		expect(loadSpy).toHaveBeenCalledTimes(1);
		expect(loadSpy).toHaveBeenCalledWith({ silent: true });
	});

	// T5：sig offline 冻结 —— 契约保证不动 dcReady，connReady 持稳
	test('sig offline 冻结不改 dcReady，connReady 持稳且不触发 reload', async () => {
		const { wrapper, clawsStore, loadSpy } = await setupConnReadyWrapper();

		// __freezeAllClawsForSigOffline 在 !fetched 时早退；setClaws 不设 fetched，
		// 必须显式打开才能真实执行 freeze body（遍历 + pauseRestart + clearRetry）
		clawsStore.fetched = true;
		// __freezeAllClawsForSigOffline 的可观察副作用：只调 pauseRestart + clearRetry，
		// 不动 online/dcReady/rtcPhase（claws.store.js L604-605）
		clawsStore.__freezeAllClawsForSigOffline();
		await wrapper.vm.$nextTick();

		const claw = clawsStore.byId['bot-1'];
		expect(claw.dcReady).toBe(true);
		expect(wrapper.vm.connReady).toBe(true);
		// dcReady / agentVerified 均未变，connReady watcher 不该再跑
		expect(loadSpy).not.toHaveBeenCalled();
	});

	// T6：首启在 sig offline 期间挂载 —— immediate 不触发；dcReady 翻 true 才首次加载
	test('首启 sig offline 挂载时 connReady=false immediate 不触发；dcReady 翻 true 首次触发 loadMessages（无 silent）', async () => {
		const pinia = createPinia();
		setActivePinia(pinia);

		// 模拟 fullInit 被 sig gate 拦过：online=true 但 dcReady=false
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
		clawsStore.byId['bot-1'].dcReady = false;
		clawsStore.byId['bot-1'].rtcPhase = 'idle';
		setupAgents();

		const chatStore = chatStoreManager.get('session:bot-1:main', { clawId: 'bot-1', agentId: 'main' });
		chatStore.__initialized = true;
		chatStore.__messagesLoaded = false; // 首次加载：走非 silent 分支
		chatStore.sending = false;
		const loadSpy = vi.spyOn(chatStore, 'loadMessages').mockResolvedValue(true);

		const wrapper = mount(ChatPage, {
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

		// 挂载直后：connReady=false（dcReady 被 sig gate 拦住），connReady watcher handler early return
		expect(wrapper.vm.connReady).toBe(false);
		// activate() 在 re-entry 分支会自发 silent reload，与本测试关注点无关；清掉再看 connReady 驱动路径
		loadSpy.mockClear();
		// 让 activate() 里刚发出的 silent reload 走完，避免 __silentLoadPromise guard 影响后续断言
		chatStore.__silentLoadPromise = null;
		// __messagesLoaded 仍为 false（mock loadMessages 不会真的把它翻 true）→ 保持首次加载语义

		// sig 恢复 + fullInit 完成 → DC 就绪
		clawsStore.byId['bot-1'].dcReady = true;
		clawsStore.byId['bot-1'].rtcPhase = 'ready';
		await flushPromises();

		expect(wrapper.vm.connReady).toBe(true);
		// __messagesLoaded=false → __onConnReady 走首次加载分支（不带 silent）
		expect(loadSpy).toHaveBeenCalledTimes(1);
		expect(loadSpy).toHaveBeenCalledWith();
	});

	// P1-8: __onConnReady reject 时回滚 __connReadyStore guard，
	// 否则 reject 后切到其他 chat 再切回同一 chatStore 时 dedup 拦死、永不再触发首次加载
	test('loadMessages reject 时回滚 __connReadyStore guard，再次触发可重新加载', async () => {
		const { wrapper, chatStore, loadSpy } = await setupConnReadyWrapper();
		// setup 内已 mockClear 过；__messagesLoaded=true → 后续 __onConnReady 走 silent 分支（fire-and-forget）
		// 让 silent 分支返回 reject promise（finally 触发 guard 回滚）
		// 注：silent 分支不 await，但 __onConnReady 入口判断 isFirstLoad；此处用 __messagesLoaded=false
		// 反向构造首次加载（await）路径
		chatStore.__messagesLoaded = false;
		// 清掉 guard，让 __onConnReady 重新执行
		wrapper.vm.__connReadyStore = null;
		loadSpy.mockReset();
		loadSpy.mockRejectedValueOnce(new Error('boom'));

		// 显式触发 __onConnReady（连接已就绪）
		const reject1 = wrapper.vm.__onConnReady();
		await reject1.catch(() => {});
		await flushPromises();

		expect(loadSpy).toHaveBeenCalledTimes(1);
		// finally 回滚 guard（reject 时 succeeded 仍为 false）
		expect(wrapper.vm.__connReadyStore).toBeNull();

		// 再次触发：dedup 不应拦住，loadMessages 又被调
		loadSpy.mockResolvedValueOnce(true);
		await wrapper.vm.__onConnReady();
		await flushPromises();
		expect(loadSpy).toHaveBeenCalledTimes(2);
		// 成功路径：guard 保留指向 chatStore
		expect(wrapper.vm.__connReadyStore).toBe(chatStore);
	});

	test('loadMessages resolve 正常路径：__connReadyStore guard 保留（下次同 store 不会重复加载）', async () => {
		const { wrapper, chatStore, loadSpy } = await setupConnReadyWrapper();
		chatStore.__messagesLoaded = false;
		wrapper.vm.__connReadyStore = null;
		loadSpy.mockReset();
		loadSpy.mockResolvedValue(true);

		await wrapper.vm.__onConnReady();
		await flushPromises();
		expect(loadSpy).toHaveBeenCalledTimes(1);
		expect(wrapper.vm.__connReadyStore).toBe(chatStore);

		// 同一 store 再次调 __onConnReady 被 dedup 拦
		await wrapper.vm.__onConnReady();
		await flushPromises();
		expect(loadSpy).toHaveBeenCalledTimes(1);
	});

	// P1-6: dcReady=true 但 agents 未 fetched → connReady=false；agents fetched 翻 true 触发首次加载
	test('dcReady=true + agents !fetched → connReady=false；agents fetched=true 翻 true 触发 loadMessages', async () => {
		const pinia = createPinia();
		setActivePinia(pinia);
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
		clawsStore.byId['bot-1'].dcReady = true;
		clawsStore.byId['bot-1'].rtcPhase = 'ready';

		const agentsStore = useAgentsStore();
		// 只有 fetched=false 时 agentVerified=false → connReady=false
		agentsStore.byClaw['bot-1'] = { agents: [], defaultId: null, loading: false, fetched: false };

		const chatStore = chatStoreManager.get('session:bot-1:main', { clawId: 'bot-1', agentId: 'main' });
		chatStore.__initialized = true;
		chatStore.__messagesLoaded = true; // 避免 activate re-entry 的 silent reload 干扰首测
		chatStore.sending = false;
		const loadSpy = vi.spyOn(chatStore, 'loadMessages').mockResolvedValue(true);

		const wrapper = mount(ChatPage, {
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

		// activate() re-entry 走 silent reload（一条），但 __onConnReady 因 connReady=false 早退；
		// 清掉 setup 阶段的 spy 记录，关注 agents fetched 翻转后的真实触发
		loadSpy.mockClear();

		// agentVerified=false → connReady=false
		expect(wrapper.vm.connReady).toBe(false);

		// agents fetched=true + 非空 → agentVerified 翻 true → connReady false→true
		agentsStore.byClaw['bot-1'] = { agents: [{ id: 'main' }], defaultId: 'main', loading: false, fetched: true };
		await flushPromises();

		expect(wrapper.vm.connReady).toBe(true);
		// connReady 翻转触发 __onConnReady → __messagesLoaded=true 走 silent 分支
		expect(loadSpy).toHaveBeenCalledTimes(1);
		expect(loadSpy).toHaveBeenCalledWith({ silent: true });
	});

	// P2-9: __onConnReady 在 await loadMessages 完成后再次 guard：
	//   - 组件已 unmount → 跳过 __loadChatHistory（避免对已卸载组件再操作）
	//   - chatStore 已切走 → 不对旧 store 加历史，且 dedup guard 回滚（切回时可重入）
	test('__onConnReady: loadMessages resolve 后但组件 unmount → 跳过 __loadChatHistory', async () => {
		const { wrapper, chatStore, loadSpy } = await setupConnReadyWrapper();
		// __messagesLoaded=false → 走 await 首次加载分支（会进入 __loadChatHistory）
		chatStore.__messagesLoaded = false;
		wrapper.vm.__connReadyStore = null;

		// loadMessages 改成手控 promise
		let resolveLoad;
		loadSpy.mockReset();
		loadSpy.mockImplementationOnce(() => new Promise((r) => { resolveLoad = r; }));

		const histSpy = vi.spyOn(chatStore, '__loadChatHistory').mockResolvedValue(undefined);

		const p = wrapper.vm.__onConnReady();
		// 推进到 await loadMessages
		await Promise.resolve();
		expect(loadSpy).toHaveBeenCalledTimes(1);
		expect(histSpy).not.toHaveBeenCalled();

		// 关键：await 期间 unmount → __unmounted=true
		wrapper.unmount();

		// 解开 loadMessages → 守卫命中 __unmounted → 早退，跳过 __loadChatHistory
		resolveLoad(true);
		await p;
		await flushPromises();

		expect(histSpy).not.toHaveBeenCalled();
		// succeeded 仍为 false（早退在 succeeded 赋值前）→ guard 回滚
		expect(wrapper.vm.__connReadyStore).toBeNull();
	});

	test('__onConnReady: loadMessages resolve 后但 chatStore 已切走 → 不对旧 store 加载历史 + guard 可恢复', async () => {
		const { wrapper, chatStore: storeA, loadSpy } = await setupConnReadyWrapper();
		storeA.__messagesLoaded = false;
		wrapper.vm.__connReadyStore = null;

		// 用 spy getter 模拟 chatStore 切走（避免改路由的复杂联动）
		let resolveLoadA;
		loadSpy.mockReset();
		loadSpy.mockImplementationOnce(() => new Promise((r) => { resolveLoadA = r; }));
		const histA = vi.spyOn(storeA, '__loadChatHistory').mockResolvedValue(undefined);

		const pA = wrapper.vm.__onConnReady();
		// 进入 await loadMessages（targetStore 已捕获为 A）
		await Promise.resolve();
		expect(loadSpy).toHaveBeenCalledTimes(1);

		// 切到 storeB：让 wrapper.vm.chatStore 返回另一个 store 实例。
		// __onConnReady await 后做 `this.chatStore !== targetStore` 检查，应早退。
		const storeB = { __messagesLoaded: true, sending: false };
		const getSpy = vi.spyOn(wrapper.vm, 'chatStore', 'get').mockReturnValue(storeB);

		// resolve A 的 loadMessages → 守卫看到 chatStore!=targetStore → 早退
		resolveLoadA(true);
		await pA;
		await flushPromises();

		// 旧 store 的 __loadChatHistory 不应被调
		expect(histA).not.toHaveBeenCalled();
		// guard 回滚（succeeded=false）
		expect(wrapper.vm.__connReadyStore).toBeNull();

		// 切回 storeA：dedup guard 已被回滚 → 再次 __onConnReady 能正常进入加载分支
		getSpy.mockRestore();
		loadSpy.mockReset();
		loadSpy.mockResolvedValueOnce(true);
		histA.mockClear();
		await wrapper.vm.__onConnReady();
		await flushPromises();

		expect(loadSpy).toHaveBeenCalledTimes(1);
		expect(histA).toHaveBeenCalledTimes(1);
		// 成功路径 → guard 标记 storeA
		expect(wrapper.vm.__connReadyStore).toBe(storeA);
	});
});

// chatMessages getter 在组装 separator 时给 archivedAt 加 fallback——plugin 已经把 archivedAt
// 写进 chat-history.json，但 UI 缓存的 rawHistorySessionIds 是发消息之前的旧快照（daily-reset
// 自动换 sid 等场景），用下一段（紧邻 separator 之后）首个有效 timestamp 兜底，确保用户看到日期
// 而不是光秃秃的横线。
describe('ChatPage chatMessages separator archivedAt fallback', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		chatStoreManager.__reset();
	});

	function makeUserMsg(id, text, ts) {
		return { type: 'message', id, message: { role: 'user', content: text, timestamp: ts } };
	}

	test('seg.archivedAt 存在时 separator 直接用真实值（非 fallback 路径）', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		await wrapper.vm.$nextTick();
		chatStore.historySegments = [
			{ sessionId: 'seg-old', archivedAt: 1700000000000, messages: [makeUserMsg('o1', 'old', 1699999990000)] },
			{ sessionId: 'seg-new', archivedAt: 1700000005000, messages: [makeUserMsg('n1', 'new', 1700000004000)] },
		];
		chatStore.messages = [];
		await wrapper.vm.$nextTick();
		const items = wrapper.vm.chatMessages;
		const sep = items.find((it) => it.id === 'sep-seg-new');
		expect(sep).toBeDefined();
		expect(sep.archivedAt).toBe(1700000005000);
	});

	test('seg.archivedAt 缺失时 separator fallback 到下一段首个有效 timestamp', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		await wrapper.vm.$nextTick();
		chatStore.historySegments = [
			{ sessionId: 'seg-old', archivedAt: 1700000000000, messages: [makeUserMsg('o1', 'old', 1699999990000)] },
			// 模拟 UI 缓存滞后：plugin 已在 chat-history.json 写了 archivedAt，但 UI raw 仍是旧快照（无 archivedAt）
			{ sessionId: 'seg-new', archivedAt: undefined, messages: [makeUserMsg('n1', 'new', 1700000004000)] },
		];
		chatStore.messages = [];
		await wrapper.vm.$nextTick();
		const sep = wrapper.vm.chatMessages.find((it) => it.id === 'sep-seg-new');
		expect(sep.archivedAt).toBe(1700000004000);
		// formatSeparatorLabel 也应该能渲染成文字（非空）
		expect(wrapper.vm.formatSeparatorLabel(sep)).not.toBe('');
	});

	test('sep-current 在 historySessionIds[0].archivedAt 存在时直接用真实值', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		await wrapper.vm.$nextTick();
		chatStore.historySegments = [
			{ sessionId: 'seg-old', archivedAt: 1700000000000, messages: [makeUserMsg('o1', 'old', 1699999990000)] },
		];
		// historySessionIds getter 走"raw 头条 archivedAt 非空 → 全保留"分支
		chatStore.rawHistorySessionIds = [{ sessionId: 'seg-old', archivedAt: 1700000000000 }];
		chatStore.currentSessionId = 'curr';
		chatStore.messages = [makeUserMsg('c1', 'curr-msg', 1700000010000)];
		await wrapper.vm.$nextTick();
		const sep = wrapper.vm.chatMessages.find((it) => it.id === 'sep-current');
		expect(sep.archivedAt).toBe(1700000000000);
	});

	test('sep-current 在 historySessionIds[0].archivedAt 缺失时 fallback 到 current 首条 timestamp', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		await wrapper.vm.$nextTick();
		chatStore.historySegments = [
			{ sessionId: 'seg-old', archivedAt: 1700000000000, messages: [makeUserMsg('o1', 'old', 1699999990000)] },
		];
		// raw 是 daily-reset 之前的旧快照：当时 seg-old 还是 head 没 archivedAt
		chatStore.rawHistorySessionIds = [{ sessionId: 'seg-old' }];
		// loadMessages 已经发现 currentSessionId 与 head 不匹配 → historySessionIds 保留含 seg-old 的整 raw
		chatStore.currentSessionId = 'curr';
		chatStore.messages = [makeUserMsg('c1', 'curr-first', 1700000010000)];
		await wrapper.vm.$nextTick();
		const sep = wrapper.vm.chatMessages.find((it) => it.id === 'sep-current');
		expect(sep).toBeDefined();
		expect(sep.archivedAt).toBe(1700000010000);
		expect(wrapper.vm.formatSeparatorLabel(sep)).not.toBe('');
	});

	test('fallback 也找不到 valid timestamp 时 separator archivedAt=null，formatSeparatorLabel 返回空', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		await wrapper.vm.$nextTick();
		chatStore.historySegments = [
			{ sessionId: 'seg-old', archivedAt: 1700000000000, messages: [makeUserMsg('o1', 'old', 1699999990000)] },
			// 既没 archivedAt，又没有任何 valid timestamp 的 message
			{ sessionId: 'seg-new', archivedAt: undefined, messages: [makeUserMsg('n1', 'noTs', null)] },
		];
		chatStore.messages = [];
		await wrapper.vm.$nextTick();
		const sep = wrapper.vm.chatMessages.find((it) => it.id === 'sep-seg-new');
		expect(sep.archivedAt).toBeNull();
		expect(wrapper.vm.formatSeparatorLabel(sep)).toBe('');
	});

	test('__firstValidTimestamp 跳过前面无效 timestamp 找后续有效条目（钉死循环行为，防退化为 items[0]）', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		await wrapper.vm.$nextTick();
		chatStore.historySegments = [
			{ sessionId: 'seg-old', archivedAt: 1700000000000, messages: [makeUserMsg('o1', 'old', 1699999990000)] },
			// seg-new 第一条 timestamp=null（如 streaming botTask 未 finalize），第二条才有有效 ts
			{ sessionId: 'seg-new', archivedAt: undefined, messages: [
				makeUserMsg('n0', 'no-ts', null),
				makeUserMsg('n1', 'has-ts', 1700000004000),
			] },
		];
		chatStore.messages = [];
		await wrapper.vm.$nextTick();
		const sep = wrapper.vm.chatMessages.find((it) => it.id === 'sep-seg-new');
		expect(sep.archivedAt).toBe(1700000004000);
	});
});

// 正文已丢的归档段占位：chat-history 还留着指针（带 archivedAt），但 OpenClaw 正文文件
// 已不存在 → plugin getById 返回空消息 → 段以 messages=[] 入列。不应整段隐藏，而要留占位
// 条目让用户知道"这段曾经存在、现已不可用"。
describe('ChatPage chatMessages 空归档段占位', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		chatStoreManager.__reset();
	});

	function makeUserMsg(id, text, ts) {
		return { type: 'message', id, message: { role: 'user', content: text, timestamp: ts } };
	}

	test('正文为空的归档段产出 emptySession 占位项 + 前置 separator', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		await wrapper.vm.$nextTick();
		chatStore.historySegments = [
			{ sessionId: 'seg-old', archivedAt: 1700000000000, messages: [makeUserMsg('o1', 'old', 1699999990000)] },
			// 正文已丢：getById 返回空消息数组
			{ sessionId: 'seg-gone', archivedAt: 1700000005000, messages: [] },
		];
		chatStore.messages = [];
		await wrapper.vm.$nextTick();
		const items = wrapper.vm.chatMessages;
		const placeholder = items.find((it) => it.id === 'empty-seg-gone');
		expect(placeholder).toBeDefined();
		expect(placeholder.type).toBe('emptySession');
		expect(placeholder.archivedAt).toBe(1700000005000);
		// 前面有内容 → 占位前应有一条 separator 标注归档时间
		const sep = items.find((it) => it.id === 'sep-seg-gone');
		expect(sep).toBeDefined();
		expect(sep.archivedAt).toBe(1700000005000);
	});

	test('空归档段是首段（前面无内容）时只产出占位项、无前置 separator', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		await wrapper.vm.$nextTick();
		chatStore.historySegments = [
			{ sessionId: 'seg-gone', archivedAt: 1700000005000, messages: [] },
		];
		chatStore.messages = [];
		await wrapper.vm.$nextTick();
		const items = wrapper.vm.chatMessages;
		expect(items.find((it) => it.id === 'empty-seg-gone')).toBeDefined();
		expect(items.find((it) => it.id === 'sep-seg-gone')).toBeUndefined();
	});

	test('有正文但分组为空的退化段维持隐藏（不误标为不可用）', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		await wrapper.vm.$nextTick();
		chatStore.historySegments = [
			{ sessionId: 'seg-old', archivedAt: 1700000000000, messages: [makeUserMsg('o1', 'old', 1699999990000)] },
			// 非空原始消息但全是 type!=='message' 行 → groupSessionMessages 返回 []，应继续隐藏
			{ sessionId: 'seg-degenerate', archivedAt: 1700000005000, messages: [{ type: 'event', id: 'e1' }] },
		];
		chatStore.messages = [];
		await wrapper.vm.$nextTick();
		const items = wrapper.vm.chatMessages;
		expect(items.find((it) => it.id === 'empty-seg-degenerate')).toBeUndefined();
		expect(items.find((it) => it.id === 'sep-seg-degenerate')).toBeUndefined();
	});

	test('占位项在 DOM 渲染出友好提示文案', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		chatStore.errorText = '';
		chatStore.__messagesLoaded = true;
		chatStore.messages = [];
		chatStore.historySegments = [
			{ sessionId: 'seg-gone', archivedAt: 1700000005000, messages: [] },
		];
		await wrapper.vm.$nextTick();
		const el = wrapper.find('[data-testid="empty-session"]');
		expect(el.exists()).toBe(true);
		expect(el.text()).toContain('This conversation is no longer available');
	});

	test('占位项透传段的 reason（missing / corrupt / 无）', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		await wrapper.vm.$nextTick();
		chatStore.historySegments = [
			{ sessionId: 'seg-missing', archivedAt: 1700000001000, messages: [], reason: 'missing' },
			{ sessionId: 'seg-corrupt', archivedAt: 1700000002000, messages: [], reason: 'corrupt' },
			// 旧插件空返回 / 良性空：无 reason
			{ sessionId: 'seg-plain', archivedAt: 1700000003000, messages: [] },
		];
		chatStore.messages = [];
		await wrapper.vm.$nextTick();
		const items = wrapper.vm.chatMessages;
		expect(items.find((it) => it.id === 'empty-seg-missing').reason).toBe('missing');
		expect(items.find((it) => it.id === 'empty-seg-corrupt').reason).toBe('corrupt');
		expect(items.find((it) => it.id === 'empty-seg-plain').reason).toBeUndefined();
	});

	test('reason=corrupt 的占位渲染损坏文案，其余渲染中性文案', async () => {
		const wrapper = createWrapper();
		const chatStore = getChatStore();
		chatStore.errorText = '';
		chatStore.__messagesLoaded = true;
		chatStore.messages = [];
		chatStore.historySegments = [
			{ sessionId: 'seg-corrupt', archivedAt: 1700000005000, messages: [], reason: 'corrupt' },
		];
		await wrapper.vm.$nextTick();
		const el = wrapper.find('[data-testid="empty-session"]');
		expect(el.exists()).toBe(true);
		expect(el.text()).toContain('This conversation appears to be corrupted');
		expect(el.text()).not.toContain('no longer available');
	});
});

// __tryGenerateTitle 入口快照行为：chat 切换期间 sendMessage resolve 后，
// 必须给原入口的 chat/topic 起标题，不能漂移到当前 this.chatStore（可能是另一个 chat）。
describe('ChatPage __tryGenerateTitle entry snapshot', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		chatStoreManager.__reset();
	});

	function makeFakeTopicStore({ topicMode = true, sessionId = 't1', clawId = 'bot-2', userMsgs = 1 } = {}) {
		return {
			topicMode,
			sessionId,
			clawId,
			messages: Array.from({ length: userMsgs }, (_, i) => ({
				message: { role: 'user', content: `m${i}` },
			})),
		};
	}

	test('默认无参时用 this.chatStore 起标题（旧行为不破坏）', async () => {
		const wrapper = createWrapper({ routeName: 'topics-chat', sessionId: 'sess-1' });
		const { useTopicsStore } = await import('../stores/topics.store.js');
		const topicsStore = useTopicsStore();
		topicsStore.byId = { 'sess-1': { topicId: 'sess-1', agentId: 'main', title: null, createdAt: 100, clawId: 'bot-2' } };
		const genSpy = vi.spyOn(topicsStore, 'generateTitle').mockImplementation(() => {});
		// 给 chatStore 装上 topic-mode 字段
		const cs = getChatStore('bot-2', 'main');
		cs.topicMode = true;
		cs.sessionId = 'sess-1';
		cs.clawId = 'bot-2';
		cs.messages = [{ message: { role: 'user', content: 'hi' } }];
		await wrapper.vm.$nextTick();
		// 让 ChatPage 的 chatStore computed 命中：要求路由 topics-chat 已设
		wrapper.vm.__tryGenerateTitle();
		expect(genSpy).toHaveBeenCalledWith('bot-2', 'sess-1');
	});

	test('传 targetStore 时用 targetStore.clawId/sessionId（不受 this.chatStore 影响）', async () => {
		const wrapper = createWrapper({ routeName: 'topics-chat', sessionId: 'sess-A' });
		const { useTopicsStore } = await import('../stores/topics.store.js');
		const topicsStore = useTopicsStore();
		topicsStore.byId = {
			'sess-A': { topicId: 'sess-A', agentId: 'main', title: null, createdAt: 100, clawId: 'bot-A' },
			'sess-B': { topicId: 'sess-B', agentId: 'main', title: null, createdAt: 200, clawId: 'bot-B' },
		};
		const genSpy = vi.spyOn(topicsStore, 'generateTitle').mockImplementation(() => {});
		// 当前 chatStore 是 sess-A，但 targetStore 传入 sess-B
		const csA = getChatStore('bot-A', 'main');
		csA.topicMode = true;
		csA.sessionId = 'sess-A';
		csA.clawId = 'bot-A';
		csA.messages = [{ message: { role: 'user', content: 'a' } }];
		await wrapper.vm.$nextTick();
		const targetB = makeFakeTopicStore({ topicMode: true, sessionId: 'sess-B', clawId: 'bot-B', userMsgs: 1 });
		wrapper.vm.__tryGenerateTitle(targetB);
		expect(genSpy).toHaveBeenCalledTimes(1);
		expect(genSpy).toHaveBeenCalledWith('bot-B', 'sess-B'); // 不是 bot-A/sess-A
	});

	test('targetStore.topicMode=false 时不起标题（防误打入非 topic chat）', async () => {
		const wrapper = createWrapper({ routeName: 'topics-chat', sessionId: 'sess-1' });
		const { useTopicsStore } = await import('../stores/topics.store.js');
		const topicsStore = useTopicsStore();
		topicsStore.byId = { 'sess-1': { topicId: 'sess-1', agentId: 'main', title: null, createdAt: 100, clawId: 'bot-2' } };
		const genSpy = vi.spyOn(topicsStore, 'generateTitle').mockImplementation(() => {});
		await wrapper.vm.$nextTick();
		const targetNonTopic = makeFakeTopicStore({ topicMode: false });
		wrapper.vm.__tryGenerateTitle(targetNonTopic);
		expect(genSpy).not.toHaveBeenCalled();
	});

	test('targetStore topic 已有 title 时跳过', async () => {
		const wrapper = createWrapper({ routeName: 'topics-chat', sessionId: 'sess-1' });
		const { useTopicsStore } = await import('../stores/topics.store.js');
		const topicsStore = useTopicsStore();
		topicsStore.byId = { 'sess-X': { topicId: 'sess-X', agentId: 'main', title: 'Existing title', createdAt: 100, clawId: 'bot-X' } };
		const genSpy = vi.spyOn(topicsStore, 'generateTitle').mockImplementation(() => {});
		await wrapper.vm.$nextTick();
		const target = makeFakeTopicStore({ topicMode: true, sessionId: 'sess-X', clawId: 'bot-X', userMsgs: 1 });
		wrapper.vm.__tryGenerateTitle(target);
		expect(genSpy).not.toHaveBeenCalled();
	});

	// 集成验证：__handleNewTopicSend accepted 路径必须给入口快照的 newStore 起标题，
	// 不能漂到 this.chatStore（哪怕 happy path 下两者相等）。
	// 上面 3 条函数级测试只挡 __tryGenerateTitle 自身逻辑；这条挡上层调用点把入口 targetStore
	// 透传给它的契约——若有人把 __tryGenerateTitle(targetStore) 改回 __tryGenerateTitle()，
	// 函数级测试照样绿、本测必挂。
	test('__handleNewTopicSend 把 entry-snapshot 的 newStore 透传给 __tryGenerateTitle', async () => {
		const { useTopicsStore } = await import('../stores/topics.store.js');
		const wrapper = createWrapper({
			routeName: 'topics-chat', sessionId: 'new',
			query: { claw: 'bot-1', agent: 'main' },
		});
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
		const topicsStore = useTopicsStore();
		vi.spyOn(topicsStore, 'createTopic').mockResolvedValue('new-topic-uuid');
		// 模拟 topic 已存入 byId（createTopic 真实路径下会写）
		topicsStore.byId = { 'new-topic-uuid': { topicId: 'new-topic-uuid', agentId: 'main', title: null, createdAt: 100, clawId: 'bot-1' } };
		const genTitleSpy = vi.spyOn(topicsStore, 'generateTitle').mockImplementation(() => {});
		await flushPromises();

		// 让新 topic store sendMessage 返回 accepted=true 触发 generateTitle 路径
		const origGet = chatStoreManager.get.bind(chatStoreManager);
		vi.spyOn(chatStoreManager, 'get').mockImplementation((key, opts) => {
			const s = origGet(key, opts);
			if (key === 'topic:new-topic-uuid') {
				vi.spyOn(s, 'sendMessage').mockResolvedValue({ accepted: true });
				// __tryGenerateTitle 内部读 store.messages 取 user message count；mock 一条
				s.messages = [{ message: { role: 'user', content: 'hi' } }];
			}
			return s;
		});
		mockRouter.replace.mockImplementation(() => Promise.resolve());

		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		// generateTitle 应以入口的 (clawId, topicId) 触发——证明 __tryGenerateTitle 收到了 targetStore
		expect(genTitleSpy).toHaveBeenCalledWith('bot-1', 'new-topic-uuid');
	});
});
