import { mount, flushPromises } from '@vue/test-utils';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPinia } from 'pinia';

// --- mock 子组件，避免 Nuxt UI #imports 解析问题 ---
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

// --- mock 服务 ---
const mockRpc = {
	request: vi.fn(),
	on: vi.fn(),
	off: vi.fn(),
	close: vi.fn(),
};

/**
 * 模拟 agent 两阶段响应：先调用 onAccepted，再 resolve final。
 * @param {string} [runId] - 默认 'run-1'
 * @param {object} [finalPayload] - 终态 payload，默认 { runId, status: 'ok' }
 */
function mockAgentTwoPhase(runId = 'run-1', finalPayload) {
	return (method, params, options) => {
		if (method === 'agent') {
			options?.onAccepted?.({ runId, status: 'accepted', acceptedAt: Date.now() });
			return Promise.resolve(finalPayload ?? { runId, status: 'ok' });
		}
		return null; // 未处理，由外层 fallback
	};
}

/**
 * 模拟 agent ack 后挂起（不 resolve final），用于测试 streaming 中间态。
 * @param {string} [runId]
 * @returns {{ handler, resolve, reject }} - handler 作为 mock，resolve/reject 手动控制终态
 */
function mockAgentTwoPhaseHang(runId = 'run-1') {
	let _resolve, _reject;
	const promise = new Promise((res, rej) => { _resolve = res; _reject = rej; });
	const handler = (method, params, options) => {
		if (method === 'agent') {
			options?.onAccepted?.({ runId, status: 'accepted', acceptedAt: Date.now() });
			return promise;
		}
		return null;
	};
	return {
		handler,
		resolve: (payload) => _resolve(payload ?? { runId, status: 'ok' }),
		reject: (err) => _reject(err),
	};
}

vi.mock('../services/gateway.ws.js', () => ({
	createGatewayRpcClient: vi.fn(() => Promise.resolve(mockRpc)),
}));

const mockBotsItems = [{ id: 'bot-1', online: true }];
vi.mock('../stores/bots.store.js', () => ({
	useBotsStore: () => ({
		get items() { return mockBotsItems; },
		loadBots: vi.fn(() => [{ id: 'bot-1', online: true }]),
	}),
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

vi.mock('../utils/file-helper.js', () => ({
	fileToBase64: vi.fn(() => Promise.resolve('bW9ja2VkX2Jhc2U2NA==')),
}));

const mockLoadAllSessions = vi.fn();
const mockSessionsItems = [];
vi.mock('../stores/sessions.store.js', () => ({
	useSessionsStore: () => ({
		loadAllSessions: mockLoadAllSessions,
		get items() { return mockSessionsItems; },
	}),
}));

import ChatPage from './ChatPage.vue';

// 在 messages 中查找 _local 用户条目
function findLocalUserEntry(messages) {
	return messages.find((e) => e._local && e.message?.role === 'user');
}

// 在 messages 中查找 _streaming 的 assistant 条目（从后往前）
function findStreamingBotEntry(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]._streaming && messages[i].message?.role === 'assistant') return messages[i];
	}
	return null;
}

const i18nMap = {
	'chat.loading': 'Loading...',
	'chat.empty': 'No messages',
	'chat.continueNotSupported': 'Continue not supported',
	'chat.sendFailed': 'Send failed',
	'chat.sessionRotated': 'Session rotated',
	'chat.orphanSendFailed': 'Orphan send failed',
	'chat.orphanSendTimeout': 'Timeout',
	'chat.noActiveBot': 'No bot',
	'chat.loadFailed': 'Load failed',
	'chat.botThinking': 'Thinking',
	'chat.newChatFailed': 'New chat failed',
	'chat.botOffline': 'Bot is offline',
	'chat.botUnbound': 'Bot has been unbound',
};

const mockRouter = { push: vi.fn(), replace: vi.fn() };

function createWrapper(sessionId = 'sess-1') {
	return mount(ChatPage, {
		global: {
			plugins: [createPinia()],
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

describe('ChatPage orphan send', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		// agent 请求保持挂起，模拟 streaming 中间态
		const { handler: agentHang } = mockAgentTwoPhaseHang();
		mockRpc.request.mockImplementation((method, params, options) => {
			if (method === 'nativeui.sessions.listAll') {
				return Promise.resolve({ items: [] });
			}
			if (method === 'nativeui.sessions.get') {
				return Promise.resolve({ messages: [] });
			}
			const agentRes = agentHang(method, params, options);
			if (agentRes) return agentRes;
			return Promise.resolve({});
		});
		vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid' });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test('orphan session 调用 sendViaAgent 而非 chat.send', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'hello', files: [] });
		await flushPromises();

		const agentCall = mockRpc.request.mock.calls.find((c) => c[0] === 'agent');
		expect(agentCall).toBeTruthy();
		expect(agentCall[1].sessionId).toBe('orphan-sess');
		expect(agentCall[1].message).toBe('hello');
		expect(agentCall[1].deliver).toBe(false);

		const chatSendCall = mockRpc.request.mock.calls.find((c) => c[0] === 'chat.send');
		expect(chatSendCall).toBeUndefined();
	});

	test('发送带图片文件时 agent 请求包含 attachments', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		const imgFile = new File(['fake-png-data'], 'photo.png', { type: 'image/png' });
		const files = [{
			id: 'f1',
			isImg: true,
			isVoice: false,
			name: 'photo.png',
			file: imgFile,
		}];
		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: 'look at this', files });
		await flushPromises();

		const agentCall = mockRpc.request.mock.calls.find((c) => c[0] === 'agent');
		expect(agentCall).toBeTruthy();
		expect(agentCall[1].message).toBe('look at this');
		expect(agentCall[1].attachments).toHaveLength(1);
		expect(agentCall[1].attachments[0].type).toBe('image');
		expect(agentCall[1].attachments[0].mimeType).toBe('image/png');
		expect(agentCall[1].attachments[0].fileName).toBe('photo.png');
		expect(typeof agentCall[1].attachments[0].content).toBe('string');
		expect(agentCall[1].attachments[0].content.length).toBeGreaterThan(0);
	});

	test('发送语音文件时 attachment type 为 audio', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		const voiceFile = new File(['fake-audio-data'], 'voice.webm', { type: 'audio/webm' });
		const files = [{
			id: 'v1',
			isImg: false,
			isVoice: true,
			name: 'voice.webm',
			file: voiceFile,
		}];
		const input = wrapper.findComponent({ name: 'ChatInput' });
		input.vm.$emit('send', { text: '请听语音', files });
		await flushPromises();

		const agentCall = mockRpc.request.mock.calls.find((c) => c[0] === 'agent');
		expect(agentCall).toBeTruthy();
		expect(agentCall[1].attachments).toHaveLength(1);
		expect(agentCall[1].attachments[0].type).toBe('audio');
		expect(agentCall[1].attachments[0].mimeType).toBe('audio/webm');
		expect(agentCall[1].attachments[0].fileName).toBe('voice.webm');
	});

	test('无文件时 agent 请求不含 attachments 字段', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'hello', files: [] });
		await flushPromises();

		const agentCall = mockRpc.request.mock.calls.find((c) => c[0] === 'agent');
		expect(agentCall).toBeTruthy();
		expect(agentCall[1].attachments).toBeUndefined();
	});

	test('sendViaAgent 注册 agent 事件监听', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		expect(mockRpc.on).toHaveBeenCalledWith('agent', expect.any(Function));
	});

	test('onAgentEvent 更新 streaming assistant 条目的 content', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		wrapper.vm.onAgentEvent({ runId: 'run-1', stream: 'assistant', data: { text: 'partial reply' } });
		const entry = findStreamingBotEntry(wrapper.vm.messages);
		expect(entry).toBeTruthy();
		// content 应为数组，包含 text block
		const textBlock = entry.message.content.find((b) => b.type === 'text');
		expect(textBlock.text).toBe('partial reply');
	});

	test('onAgentEvent 忽略不匹配的 runId', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		wrapper.vm.onAgentEvent({ runId: 'other-run', stream: 'assistant', data: { text: 'wrong' } });
		const entry = findStreamingBotEntry(wrapper.vm.messages);
		expect(entry).toBeTruthy();
		// content 应仍为空字符串（未被修改）
		expect(entry.message.content).toBe('');
	});

	test('lifecycle end 清理 streaming 标记并 reconcile', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		// 模拟收到部分文本
		wrapper.vm.onAgentEvent({ runId: 'run-1', stream: 'assistant', data: { text: 'partial' } });

		// onAgentEvent 是 async，需要 await
		const endPromise = wrapper.vm.onAgentEvent({ runId: 'run-1', stream: 'lifecycle', data: { phase: 'end' } });
		// sending 应立即清除
		expect(wrapper.vm.sending).toBe(false);
		expect(wrapper.vm.streamingRunId).toBeNull();

		await endPromise;
		await flushPromises();

		// reconcile 完成后，messages 中不应有 _streaming 条目
		expect(wrapper.vm.messages.some((e) => e._streaming)).toBe(false);
		// _local 条目保留（reconcile 不替换 messages，避免 DOM 重建抖动）
		expect(wrapper.vm.messages.some((e) => e._local)).toBe(true);
	});

	test('lifecycle error 通过 notify 提示而非替换消息区域', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		wrapper.vm.onAgentEvent({ runId: 'run-1', stream: 'lifecycle', data: { phase: 'error', message: 'boom' } });
		expect(mockNotify.error).toHaveBeenCalledWith('boom');
		expect(wrapper.vm.errorText).toBe('');
		// _local 条目应被移除
		expect(wrapper.vm.messages.some((e) => e._local)).toBe(false);
		expect(wrapper.vm.sending).toBe(false);
	});

	test('streaming assistant 条目出现在 chatMessages 中', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		// 手动追加 streaming assistant 条目
		wrapper.vm.messages = [...wrapper.vm.messages, {
			type: 'message',
			id: '__local_bot_1',
			_local: true,
			_streaming: true,
			_startTime: Date.now(),
			message: { role: 'assistant', content: [{ type: 'text', text: 'streaming reply' }], stopReason: 'stop' },
		}];
		await wrapper.vm.$nextTick();

		const streaming = wrapper.vm.chatMessages.find((m) => m.isStreaming);
		expect(streaming).toBeTruthy();
		expect(streaming.type).toBe('botTask');
		expect(streaming.resultText).toBe('streaming reply');
		expect(streaming.isStreaming).toBe(true);
	});

	test('超时后通过 notify 提示而非替换消息区域', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		vi.advanceTimersByTime(120_000);

		expect(wrapper.vm.sending).toBe(false);
		expect(mockNotify.error).toHaveBeenCalledWith('Timeout');
		expect(wrapper.vm.errorText).toBe('');
		// _local 条目应被移除
		expect(wrapper.vm.messages.some((e) => e._local)).toBe(false);
		expect(wrapper.vm.streamingRunId).toBeNull();
	});

	test('cancel 清理流式状态', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('cancel');

		// _local 条目应被移除
		expect(wrapper.vm.messages.some((e) => e._local)).toBe(false);
		expect(wrapper.vm.sending).toBe(false);
		expect(mockRpc.off).toHaveBeenCalledWith('agent', expect.any(Function));
	});

	test('indexed + 有 sessionKey 时走 agent 路径并传 sessionKey', async () => {
		mockRpc.request.mockImplementation((method, params, options) => {
			if (method === 'nativeui.sessions.listAll') {
				return Promise.resolve({ items: [{ sessionId: 'keyed-sess', sessionKey: 'sk-1', indexed: true }] });
			}
			if (method === 'nativeui.sessions.get') {
				return Promise.resolve({ messages: [] });
			}
			const agentRes = mockAgentTwoPhase()(method, params, options);
			if (agentRes) return agentRes;
			return Promise.resolve({});
		});

		const wrapper = createWrapper('keyed-sess');
		await flushPromises();

		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'yo', files: [] });
		await flushPromises();

		const agentCall = mockRpc.request.mock.calls.find((c) => c[0] === 'agent');
		expect(agentCall).toBeTruthy();
		expect(agentCall[1].sessionKey).toBe('sk-1');
		expect(agentCall[1].sessionId).toBeUndefined();
		expect(agentCall[1].idempotencyKey).toBe('test-uuid');
		expect(agentCall[1].deliver).toBe(false);

		const chatSendCall = mockRpc.request.mock.calls.find((c) => c[0] === 'chat.send');
		expect(chatSendCall).toBeUndefined();
	});

	test('有 sessionKey 但 indexed=false 时走 agent 路径', async () => {
		mockRpc.request.mockImplementation((method, params, options) => {
			if (method === 'nativeui.sessions.listAll') {
				return Promise.resolve({ items: [{ sessionId: 'not-indexed', sessionKey: 'sk-stale', indexed: false }] });
			}
			if (method === 'nativeui.sessions.get') {
				return Promise.resolve({ messages: [] });
			}
			const agentRes = mockAgentTwoPhase()(method, params, options);
			if (agentRes) return agentRes;
			return Promise.resolve({});
		});

		const wrapper = createWrapper('not-indexed');
		await flushPromises();

		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		const agentCall = mockRpc.request.mock.calls.find((c) => c[0] === 'agent');
		expect(agentCall).toBeTruthy();
		expect(agentCall[1].sessionId).toBe('not-indexed');

		const chatSendCall = mockRpc.request.mock.calls.find((c) => c[0] === 'chat.send');
		expect(chatSendCall).toBeUndefined();
	});

	test('发送时立即清除 inputText', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		wrapper.vm.inputText = 'will be cleared';
		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'will be cleared', files: [] });
		// 同步断言：inputText 应在 sendViaAgent 入口即被清除
		await wrapper.vm.$nextTick();
		expect(wrapper.vm.inputText).toBe('');
	});

	test('未 accepted 即失败时恢复 inputText 和文件', async () => {
		// agent 请求直接 reject，不调用 onAccepted
		mockRpc.request.mockImplementation((method) => {
			if (method === 'nativeui.sessions.listAll') return Promise.resolve({ items: [] });
			if (method === 'nativeui.sessions.get') return Promise.resolve({ messages: [] });
			if (method === 'agent') return Promise.reject(new Error('bot offline'));
			return Promise.resolve({});
		});

		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		wrapper.vm.inputText = 'my important text';
		const files = [{ id: 'f1', isImg: true, isVoice: false, name: 'pic.png', file: new File(['x'], 'pic.png', { type: 'image/png' }) }];
		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'my important text', files });
		await flushPromises();

		// inputText 应恢复
		expect(wrapper.vm.inputText).toBe('my important text');
		// _local 条目应被移除（撤回乐观消息）
		expect(wrapper.vm.messages.some((e) => e._local)).toBe(false);
		// restoreFiles 应被调用
		expect(mockRestoreFiles).toHaveBeenCalledWith(files);
		// sending 应恢复
		expect(wrapper.vm.sending).toBe(false);
	});

	test('未 accepted 即失败时无文件也能正常恢复 inputText', async () => {
		mockRpc.request.mockImplementation((method) => {
			if (method === 'nativeui.sessions.listAll') return Promise.resolve({ items: [] });
			if (method === 'nativeui.sessions.get') return Promise.resolve({ messages: [] });
			if (method === 'agent') return Promise.reject(new Error('network error'));
			return Promise.resolve({});
		});

		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		wrapper.vm.inputText = 'text only';
		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'text only', files: [] });
		await flushPromises();

		expect(wrapper.vm.inputText).toBe('text only');
		// 空文件列表，restoreFiles 仍被调用但内部不操作
		expect(mockRestoreFiles).toHaveBeenCalledWith([]);
	});

	test('accepted 后失败不恢复 inputText', async () => {
		// agent 先 accepted 再 reject
		mockRpc.request.mockImplementation((method, params, options) => {
			if (method === 'nativeui.sessions.listAll') return Promise.resolve({ items: [] });
			if (method === 'nativeui.sessions.get') return Promise.resolve({ messages: [] });
			if (method === 'agent') {
				options?.onAccepted?.({ runId: 'run-1', status: 'accepted' });
				return Promise.reject(new Error('agent run crashed'));
			}
			return Promise.resolve({});
		});

		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		wrapper.vm.inputText = 'sent text';
		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'sent text', files: [] });
		await flushPromises();

		// accepted 后失败，inputText 不应恢复（消息已被服务端接收）
		expect(wrapper.vm.inputText).toBe('');
		expect(mockRestoreFiles).not.toHaveBeenCalled();
	});

	test('未 accepted 但终态 ok 时不恢复 inputText', async () => {
		// 模拟 gateway 跳过 accepted 直接返回 ok 终态
		mockRpc.request.mockImplementation((method, params, options) => {
			if (method === 'nativeui.sessions.listAll') return Promise.resolve({ items: [] });
			if (method === 'nativeui.sessions.get') return Promise.resolve({ messages: [] });
			if (method === 'agent') {
				// 不调用 onAccepted，直接返回 ok
				return Promise.resolve({ runId: 'run-1', status: 'ok' });
			}
			return Promise.resolve({});
		});

		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		wrapper.vm.inputText = 'sent text';
		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'sent text', files: [] });
		await flushPromises();

		expect(wrapper.vm.inputText).toBe('');
		expect(mockRestoreFiles).not.toHaveBeenCalled();
	});

	test('未 accepted 且终态非 ok 时恢复 inputText', async () => {
		// 模拟 gateway 跳过 accepted 直接返回 error 终态
		mockRpc.request.mockImplementation((method, params, options) => {
			if (method === 'nativeui.sessions.listAll') return Promise.resolve({ items: [] });
			if (method === 'nativeui.sessions.get') return Promise.resolve({ messages: [] });
			if (method === 'agent') {
				return Promise.resolve({ runId: 'run-1', status: 'error', error: 'model unavailable' });
			}
			return Promise.resolve({});
		});

		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		wrapper.vm.inputText = 'my text';
		const files = [{ id: 'f1', isImg: true, isVoice: false, name: 'img.png', file: new File(['x'], 'img.png', { type: 'image/png' }) }];
		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'my text', files });
		await flushPromises();

		expect(wrapper.vm.inputText).toBe('my text');
		// _local 条目应被移除
		expect(wrapper.vm.messages.some((e) => e._local)).toBe(false);
		expect(mockRestoreFiles).toHaveBeenCalledWith(files);
	});
});

describe('ChatPage 轮转检测', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid' });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test('sessionId 未变时正常走 sessionKey 路径', async () => {
		mockRpc.request.mockImplementation((method, params, options) => {
			if (method === 'nativeui.sessions.listAll') {
				return Promise.resolve({ items: [{ sessionId: 'keyed-sess', sessionKey: 'agent:main:main', indexed: true }] });
			}
			if (method === 'nativeui.sessions.get') {
				return Promise.resolve({ messages: [] });
			}
			if (method === 'chat.history') {
				return Promise.resolve({ sessionId: 'keyed-sess', messages: [] });
			}
			const agentRes = mockAgentTwoPhase()(method, params, options);
			if (agentRes) return agentRes;
			return Promise.resolve({});
		});

		const wrapper = createWrapper('keyed-sess');
		await flushPromises();

		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		const agentCall = mockRpc.request.mock.calls.find((c) => c[0] === 'agent');
		expect(agentCall).toBeTruthy();
		expect(agentCall[1].sessionKey).toBe('agent:main:main');
		expect(agentCall[1].sessionId).toBeUndefined();
		expect(mockNotify.warning).not.toHaveBeenCalled();
	});

	test('检测到轮转时回退 orphan 路径 + notify + 刷新 store', async () => {
		const { handler: agentHang } = mockAgentTwoPhaseHang();
		mockRpc.request.mockImplementation((method, params, options) => {
			if (method === 'nativeui.sessions.listAll') {
				return Promise.resolve({ items: [{ sessionId: 'old-sess', sessionKey: 'agent:main:main', indexed: true }] });
			}
			if (method === 'nativeui.sessions.get') {
				return Promise.resolve({ messages: [] });
			}
			if (method === 'chat.history') {
				// 服务端已轮转到新 sessionId
				return Promise.resolve({ sessionId: 'new-sess', messages: [] });
			}
			const agentRes = agentHang(method, params, options);
			if (agentRes) return agentRes;
			return Promise.resolve({});
		});

		const wrapper = createWrapper('old-sess');
		await flushPromises();

		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		// 应回退为 orphan（sessionId）
		const agentCall = mockRpc.request.mock.calls.find((c) => c[0] === 'agent');
		expect(agentCall).toBeTruthy();
		expect(agentCall[1].sessionId).toBe('old-sess');
		expect(agentCall[1].sessionKey).toBeUndefined();

		// 通知用户
		expect(mockNotify.warning).toHaveBeenCalledWith('Session rotated');

		// 刷新 sessions 列表
		expect(mockLoadAllSessions).toHaveBeenCalled();

		// sessionKeyById 中已移除映射
		expect(wrapper.vm.sessionKeyById['old-sess']).toBeUndefined();
	});

	test('chat.history 调用失败时不阻塞发送', async () => {
		mockRpc.request.mockImplementation((method, params, options) => {
			if (method === 'nativeui.sessions.listAll') {
				return Promise.resolve({ items: [{ sessionId: 'keyed-sess', sessionKey: 'agent:main:main', indexed: true }] });
			}
			if (method === 'nativeui.sessions.get') {
				return Promise.resolve({ messages: [] });
			}
			if (method === 'chat.history') {
				return Promise.reject(new Error('network error'));
			}
			const agentRes = mockAgentTwoPhase()(method, params, options);
			if (agentRes) return agentRes;
			return Promise.resolve({});
		});

		const wrapper = createWrapper('keyed-sess');
		await flushPromises();

		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		// 即使 chat.history 失败，仍按原 sessionKey 路径发送
		const agentCall = mockRpc.request.mock.calls.find((c) => c[0] === 'agent');
		expect(agentCall).toBeTruthy();
		expect(agentCall[1].sessionKey).toBe('agent:main:main');
		expect(mockNotify.warning).not.toHaveBeenCalled();
	});
});

describe('ChatPage 乐观消息与思考指示器', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		// agent 请求保持挂起，模拟 streaming 中间态
		const { handler: agentHang } = mockAgentTwoPhaseHang();
		mockRpc.request.mockImplementation((method, params, options) => {
			if (method === 'nativeui.sessions.listAll') {
				return Promise.resolve({ items: [] });
			}
			if (method === 'nativeui.sessions.get') {
				return Promise.resolve({ messages: [] });
			}
			const agentRes = agentHang(method, params, options);
			if (agentRes) return agentRes;
			return Promise.resolve({});
		});
		vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid' });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test('发送后立即出现乐观用户消息', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'hello world', files: [] });
		await flushPromises();

		// messages 中应有 _local user 条目
		const localUser = findLocalUserEntry(wrapper.vm.messages);
		expect(localUser).toBeTruthy();
		expect(localUser.message.content).toBe('hello world');
		// chatMessages 中应有对应的 user item
		const userItem = wrapper.vm.chatMessages.find((m) => m.type === 'user' && m.textContent === 'hello world');
		expect(userItem).toBeTruthy();
	});

	test('发送带图片时乐观用户消息包含 image blocks', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		const imgFile = new File(['fake-png'], 'photo.png', { type: 'image/png' });
		const files = [{ id: 'f1', isImg: true, isVoice: false, name: 'photo.png', file: imgFile }];
		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'look', files });
		await flushPromises();

		const localUser = findLocalUserEntry(wrapper.vm.messages);
		expect(localUser).toBeTruthy();
		// content 应为数组，包含 text 和 image blocks
		expect(Array.isArray(localUser.message.content)).toBe(true);
		const textBlock = localUser.message.content.find((b) => b.type === 'text');
		expect(textBlock.text).toBe('look');
		const imgBlock = localUser.message.content.find((b) => b.type === 'image');
		expect(imgBlock).toBeTruthy();
		expect(imgBlock.mimeType).toBe('image/png');
		expect(typeof imgBlock.data).toBe('string');
		// chatMessages 中 user item 应有 images
		const userItem = wrapper.vm.chatMessages.find((m) => m.type === 'user');
		expect(userItem.images).toHaveLength(1);
	});

	test('loadSessionMessages silent 模式不设 loading 状态', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		// 先正常加载完成
		expect(wrapper.vm.loading).toBe(false);

		// 模拟已有消息
		wrapper.vm.messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];

		// silent 模式
		const loadPromise = wrapper.vm.loadSessionMessages({ silent: true });
		// loading 在 silent 模式下不应变为 true
		expect(wrapper.vm.loading).toBe(false);

		await loadPromise;
		expect(wrapper.vm.loading).toBe(false);
	});

	test('loadSessionMessages silent 模式加载失败不清空已有消息', async () => {
		mockRpc.request.mockImplementation((method) => {
			if (method === 'nativeui.sessions.listAll') {
				return Promise.reject(new Error('network error'));
			}
			return Promise.resolve({});
		});

		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		// 设置已有消息
		wrapper.vm.messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
		wrapper.vm.errorText = '';

		await wrapper.vm.loadSessionMessages({ silent: true });

		// silent 模式失败不应清空消息
		expect(wrapper.vm.messages).toHaveLength(1);
		expect(wrapper.vm.errorText).toBe('');
	});

	test('loadSessionMessages 成功后 messages 由 server 数据替换', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		// 手动添加一个 _local 条目
		wrapper.vm.messages = [{
			type: 'message', id: '__local_user_1', _local: true,
			message: { role: 'user', content: 'temp msg', timestamp: Date.now() },
		}];

		const ok = await wrapper.vm.loadSessionMessages();

		// loadSessionMessages 用 server 数据替换 messages（mock 返回空数组）
		expect(ok).toBe(true);
		expect(wrapper.vm.messages).toEqual([]);
	});

	test('loadSessionMessages 失败时返回 false', async () => {
		mockRpc.request.mockImplementation((method) => {
			if (method === 'nativeui.sessions.listAll') {
				return Promise.reject(new Error('network error'));
			}
			return Promise.resolve({});
		});

		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		const ok = await wrapper.vm.loadSessionMessages();
		expect(ok).toBe(false);
	});

	test('sendViaAgent 后 messages 中有 _streaming 空 assistant 条目（思考中）', async () => {
		// agent 保持挂起，验证 streaming 中间态
		const { handler: agentHang } = mockAgentTwoPhaseHang();
		mockRpc.request.mockImplementation((method, params, options) => {
			if (method === 'nativeui.sessions.listAll') return Promise.resolve({ items: [] });
			if (method === 'nativeui.sessions.get') return Promise.resolve({ messages: [] });
			const r = agentHang(method, params, options);
			if (r) return r;
			return Promise.resolve({});
		});

		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		// 应有 _streaming assistant 条目且 content 为空
		const entry = findStreamingBotEntry(wrapper.vm.messages);
		expect(entry).toBeTruthy();
		expect(entry.message.content).toBe('');
	});

	test('streaming 空 assistant 在 chatMessages 中显示为 isStreaming botTask', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		// 手动追加 streaming 空 assistant 条目
		wrapper.vm.messages = [...wrapper.vm.messages, {
			type: 'message',
			id: '__local_bot_1',
			_local: true,
			_streaming: true,
			_startTime: Date.now(),
			message: { role: 'assistant', content: '', stopReason: null },
		}];
		await wrapper.vm.$nextTick();

		const streaming = wrapper.vm.chatMessages.find((m) => m.isStreaming);
		expect(streaming).toBeTruthy();
		expect(streaming.isStreaming).toBe(true);
		expect(streaming.resultText).toBeNull();
	});

	test('收到首条 assistant 文本后 streaming 条目 content 不再为空', async () => {
		const { handler: agentHang } = mockAgentTwoPhaseHang();
		mockRpc.request.mockImplementation((method, params, options) => {
			if (method === 'nativeui.sessions.listAll') return Promise.resolve({ items: [] });
			if (method === 'nativeui.sessions.get') return Promise.resolve({ messages: [] });
			const r = agentHang(method, params, options);
			if (r) return r;
			return Promise.resolve({});
		});

		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();
		// 初始为空 content
		expect(findStreamingBotEntry(wrapper.vm.messages).message.content).toBe('');

		wrapper.vm.onAgentEvent({ runId: 'run-1', stream: 'assistant', data: { text: 'hello' } });
		const entry = findStreamingBotEntry(wrapper.vm.messages);
		// content 应为数组，包含 text block
		const textBlock = entry.message.content.find((b) => b.type === 'text');
		expect(textBlock.text).toBe('hello');
	});

	test('clearStreamingState 移除 _local 条目', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		// 手动添加 _local 条目
		wrapper.vm.messages = [
			{ type: 'message', id: 'server-1', message: { role: 'user', content: 'hi' } },
			{ type: 'message', id: '__local_bot_1', _local: true, _streaming: true, message: { role: 'assistant', content: '' } },
		];
		wrapper.vm.clearStreamingState();

		expect(wrapper.vm.messages.some((e) => e._local)).toBe(false);
		// server 条目应保留
		expect(wrapper.vm.messages).toHaveLength(1);
		expect(wrapper.vm.messages[0].id).toBe('server-1');
	});

	test('indexed session 发送也设置乐观消息', async () => {
		const { handler: agentHang } = mockAgentTwoPhaseHang();
		mockRpc.request.mockImplementation((method, params, options) => {
			if (method === 'nativeui.sessions.listAll') {
				return Promise.resolve({ items: [{ sessionId: 'keyed-sess', sessionKey: 'sk-1', indexed: true }] });
			}
			if (method === 'nativeui.sessions.get') {
				return Promise.resolve({ messages: [] });
			}
			const agentRes = agentHang(method, params, options);
			if (agentRes) return agentRes;
			return Promise.resolve({});
		});

		const wrapper = createWrapper('keyed-sess');
		await flushPromises();

		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'indexed msg', files: [] });
		await wrapper.vm.$nextTick();
		// messages 中应有 _local user 条目
		const localUser = findLocalUserEntry(wrapper.vm.messages);
		expect(localUser).toBeTruthy();
		expect(localUser.message.content).toBe('indexed msg');
	});
});

describe('ChatPage 流式 tool/thinking 事件', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		// agent 请求保持挂起，模拟 streaming 中间态
		const { handler: agentHang } = mockAgentTwoPhaseHang();
		mockRpc.request.mockImplementation((method, params, options) => {
			if (method === 'nativeui.sessions.listAll') {
				return Promise.resolve({ items: [] });
			}
			if (method === 'nativeui.sessions.get') {
				return Promise.resolve({ messages: [] });
			}
			const agentRes = agentHang(method, params, options);
			if (agentRes) return agentRes;
			return Promise.resolve({});
		});
		vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid' });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test('tool start 事件追加 toolCall block 到 streaming 条目', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		wrapper.vm.onAgentEvent({ runId: 'run-1', stream: 'tool', data: { phase: 'start', name: 'web_search' } });
		const entry = findStreamingBotEntry(wrapper.vm.messages);
		expect(entry).toBeTruthy();
		const content = entry.message.content;
		expect(Array.isArray(content)).toBe(true);
		const toolBlock = content.find((b) => b.type === 'toolCall');
		expect(toolBlock).toEqual({ type: 'toolCall', name: 'web_search' });
		expect(entry.message.stopReason).toBe('toolUse');
	});

	test('tool result 事件追加 toolResult 条目和新 assistant 条目', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		wrapper.vm.onAgentEvent({ runId: 'run-1', stream: 'tool', data: { phase: 'start', name: 'calc' } });
		wrapper.vm.onAgentEvent({ runId: 'run-1', stream: 'tool', data: { phase: 'result', name: 'calc', result: '42' } });
		// 应有 toolResult 条目
		const trEntry = wrapper.vm.messages.find((e) => e.message?.role === 'toolResult');
		expect(trEntry).toBeTruthy();
		expect(trEntry.message.content).toBe('42');
		// 应有新的 streaming assistant 条目（在 toolResult 后）
		const lastBot = findStreamingBotEntry(wrapper.vm.messages);
		expect(lastBot).toBeTruthy();
		expect(lastBot.message.content).toBe('');
	});

	test('tool result 为对象时序列化为 JSON', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		wrapper.vm.onAgentEvent({ runId: 'run-1', stream: 'tool', data: { phase: 'result', name: 'api', result: { ok: true } } });
		const trEntry = wrapper.vm.messages.find((e) => e.message?.role === 'toolResult');
		expect(trEntry.message.content).toBe('{"ok":true}');
	});

	test('thinking 事件追加/替换 thinking block 到 streaming 条目', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		// 第一条 thinking
		wrapper.vm.onAgentEvent({ runId: 'run-1', stream: 'thinking', data: { text: 'Let me think...' } });
		let entry = findStreamingBotEntry(wrapper.vm.messages);
		let content = entry.message.content;
		expect(Array.isArray(content)).toBe(true);
		let thinkBlock = content.find((b) => b.type === 'thinking');
		expect(thinkBlock).toEqual({ type: 'thinking', thinking: 'Let me think...' });

		// 同类 thinking 替换（流式增量）
		wrapper.vm.onAgentEvent({ runId: 'run-1', stream: 'thinking', data: { text: 'Let me think... about this problem' } });
		entry = findStreamingBotEntry(wrapper.vm.messages);
		content = entry.message.content;
		const thinkBlocks = content.filter((b) => b.type === 'thinking');
		expect(thinkBlocks).toHaveLength(1);
		expect(thinkBlocks[0].thinking).toBe('Let me think... about this problem');
	});

	test('thinking 后跟 tool，新 thinking 追加而非替换', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		wrapper.vm.onAgentEvent({ runId: 'run-1', stream: 'thinking', data: { text: 'hmm' } });
		wrapper.vm.onAgentEvent({ runId: 'run-1', stream: 'tool', data: { phase: 'start', name: 'search' } });
		// tool result 后会产生新的 streaming assistant 条目
		wrapper.vm.onAgentEvent({ runId: 'run-1', stream: 'tool', data: { phase: 'result', name: 'search', result: 'found' } });
		// 在新 assistant 条目上追加 thinking
		wrapper.vm.onAgentEvent({ runId: 'run-1', stream: 'thinking', data: { text: 'ok' } });

		// 最后一个 streaming assistant 应有 thinking block
		const lastEntry = findStreamingBotEntry(wrapper.vm.messages);
		const content = lastEntry.message.content;
		expect(Array.isArray(content)).toBe(true);
		const thinkBlock = content.find((b) => b.type === 'thinking');
		expect(thinkBlock.thinking).toBe('ok');
	});

	test('tool 事件在 chatMessages 中体现为 steps', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		wrapper.vm.onAgentEvent({ runId: 'run-1', stream: 'tool', data: { phase: 'start', name: 'grep' } });
		await wrapper.vm.$nextTick();

		const streaming = wrapper.vm.chatMessages.find((m) => m.isStreaming);
		expect(streaming).toBeTruthy();
		expect(streaming.steps).toHaveLength(1);
		expect(streaming.steps[0].name).toBe('grep');
	});

	test('sendViaAgent 在 messages 条目中记录 _startTime', async () => {
		const now = Date.now();
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		const entry = findStreamingBotEntry(wrapper.vm.messages);
		expect(entry._startTime).toBeGreaterThanOrEqual(now);

		// chatMessages 中的 botTask 应有 startTime
		const streaming = wrapper.vm.chatMessages.find((m) => m.isStreaming);
		expect(streaming.startTime).toBe(entry._startTime);
	});

	test('clearStreamingState 清除 _local 条目', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		// 模拟有 _local 条目
		wrapper.vm.messages = [
			{ type: 'message', id: 'server-1', message: { role: 'user', content: 'hi' } },
			{ type: 'message', id: '__local_bot_1', _local: true, _streaming: true, _startTime: Date.now(), message: { role: 'assistant', content: '' } },
		];
		wrapper.vm.streamingRunId = 'run-1';
		wrapper.vm.clearStreamingState();

		expect(wrapper.vm.messages.some((e) => e._local)).toBe(false);
		expect(wrapper.vm.messages).toHaveLength(1);
		expect(wrapper.vm.streamingRunId).toBeNull();
	});

	test('多次 assistant 事件渐进更新文本并保留 thinking blocks', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		// thinking 先到
		wrapper.vm.onAgentEvent({ runId: 'run-1', stream: 'thinking', data: { text: 'Let me think...' } });
		// 第一段文本
		wrapper.vm.onAgentEvent({ runId: 'run-1', stream: 'assistant', data: { text: 'partial' } });
		let entry = findStreamingBotEntry(wrapper.vm.messages);
		let thinkBlocks = entry.message.content.filter((b) => b.type === 'thinking');
		let textBlocks = entry.message.content.filter((b) => b.type === 'text');
		expect(thinkBlocks).toHaveLength(1);
		expect(thinkBlocks[0].thinking).toBe('Let me think...');
		expect(textBlocks).toHaveLength(1);
		expect(textBlocks[0].text).toBe('partial');

		// 文本更新（渐进式），thinking 应保留
		wrapper.vm.onAgentEvent({ runId: 'run-1', stream: 'assistant', data: { text: 'partial reply complete' } });
		entry = findStreamingBotEntry(wrapper.vm.messages);
		thinkBlocks = entry.message.content.filter((b) => b.type === 'thinking');
		textBlocks = entry.message.content.filter((b) => b.type === 'text');
		expect(thinkBlocks).toHaveLength(1);
		expect(thinkBlocks[0].thinking).toBe('Let me think...');
		expect(textBlocks).toHaveLength(1);
		expect(textBlocks[0].text).toBe('partial reply complete');
	});

	test('__clearStreamingFlags 调用两次是幂等的', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		wrapper.vm.messages = [
			{ type: 'message', id: 's1', message: { role: 'user', content: 'hi' } },
			{ type: 'message', id: 'b1', _streaming: true, message: { role: 'assistant', content: 'reply' } },
		];
		wrapper.vm.__clearStreamingFlags();
		expect(wrapper.vm.messages.some((e) => e._streaming)).toBe(false);
		const msgRef = wrapper.vm.messages;
		// 第二次调用不应触发数组替换（无 _streaming 需要清除）
		wrapper.vm.__clearStreamingFlags();
		expect(wrapper.vm.messages).toBe(msgRef);
	});

	test('tool result 事件传递 _startTime 到新 assistant 条目', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'hi', files: [] });
		await flushPromises();

		const origEntry = findStreamingBotEntry(wrapper.vm.messages);
		const origStartTime = origEntry._startTime;
		expect(origStartTime).toBeGreaterThan(0);

		// tool result 创建新 assistant 条目
		wrapper.vm.onAgentEvent({ runId: 'run-1', stream: 'tool', data: { phase: 'result', name: 'x', result: 'ok' } });
		const newEntry = findStreamingBotEntry(wrapper.vm.messages);
		// 新条目应继承原始 _startTime
		expect(newEntry._startTime).toBe(origStartTime);
		expect(newEntry.id).not.toBe(origEntry.id);
	});

	test('__ensureContentArray 处理空字符串 content', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		const entry = { message: { content: '' } };
		const result = wrapper.vm.__ensureContentArray(entry);
		expect(result).toEqual([]);
		expect(entry.message.content).toEqual([]);
	});

	test('__ensureContentArray 处理非字符串 falsy content', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		const entry = { message: { content: null } };
		const result = wrapper.vm.__ensureContentArray(entry);
		expect(result).toEqual([]);
		expect(entry.message.content).toEqual([]);
	});

	test('__ensureContentArray 保留已有数组 content', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		const existing = [{ type: 'text', text: 'hi' }];
		const entry = { message: { content: existing } };
		const result = wrapper.vm.__ensureContentArray(entry);
		expect(result).toBe(existing);
	});
});

describe('ChatPage __reconcileMessages', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		const { handler: agentHang } = mockAgentTwoPhaseHang();
		mockRpc.request.mockImplementation((method, params, options) => {
			if (method === 'nativeui.sessions.listAll') {
				return Promise.resolve({ items: [] });
			}
			if (method === 'nativeui.sessions.get') {
				return Promise.resolve({ messages: [] });
			}
			const agentRes = agentHang(method, params, options);
			if (agentRes) return agentRes;
			return Promise.resolve({});
		});
		vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid' });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test('reconcile 失败时保留本地 messages 内容', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		// 模拟本地有内容
		const localMessages = [
			{ type: 'message', id: 'u1', message: { role: 'user', content: 'hi' } },
			{ type: 'message', id: 'b1', message: { role: 'assistant', content: 'reply', stopReason: 'stop' } },
		];
		wrapper.vm.messages = [...localMessages];

		// 让 reconcile 的 ensureRpcClient 返回的 rpc 在 listAll 时失败
		mockRpc.request.mockImplementation((method) => {
			if (method === 'nativeui.sessions.listAll') {
				return Promise.reject(new Error('network down'));
			}
			return Promise.resolve({});
		});

		const result = await wrapper.vm.__reconcileMessages();
		expect(result).toBe(false);
		// messages 应保留原内容
		expect(wrapper.vm.messages).toHaveLength(2);
		expect(wrapper.vm.messages[0].id).toBe('u1');
		expect(wrapper.vm.messages[1].id).toBe('b1');
	});

	test('reconcile 成功时更新 sessionKeyById 但不替换 messages', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		// 模拟本地有 _local 内容
		const localMessages = [
			{ type: 'message', id: '__local_user_1', _local: true, message: { role: 'user', content: 'hi' } },
			{ type: 'message', id: '__local_bot_1', _local: true, message: { role: 'assistant', content: 'reply' } },
		];
		wrapper.vm.messages = [...localMessages];

		mockRpc.request.mockImplementation((method) => {
			if (method === 'nativeui.sessions.listAll') {
				return Promise.resolve({ items: [{ sessionId: 'orphan-sess', sessionKey: 'agent:main:main', indexed: true }] });
			}
			return Promise.resolve({});
		});

		const result = await wrapper.vm.__reconcileMessages();
		expect(result).toBe(true);
		// messages 不被替换（避免 v-for key 变化导致 DOM 重建）
		expect(wrapper.vm.messages).toHaveLength(2);
		expect(wrapper.vm.messages[0].id).toBe('__local_user_1');
		// sessionKeyById 已更新
		expect(wrapper.vm.sessionKeyById['orphan-sess']).toBe('agent:main:main');
		// sessions store 刷新
		expect(mockLoadAllSessions).toHaveBeenCalled();
	});
});

describe('ChatPage 自动滚动', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		mockRpc.request.mockImplementation((method, params, options) => {
			if (method === 'nativeui.sessions.listAll') {
				return Promise.resolve({ items: [] });
			}
			if (method === 'nativeui.sessions.get') {
				return Promise.resolve({ messages: [] });
			}
			const agentRes = mockAgentTwoPhase()(method, params, options);
			if (agentRes) return agentRes;
			return Promise.resolve({});
		});
		vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid' });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test('scrollToBottom 调用 scrollTo', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		const el = wrapper.vm.$refs.scrollContainer;
		if (el) {
			el.scrollTo = vi.fn();
			Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
		}

		wrapper.vm.userScrolledUp = false;
		wrapper.vm.scrollToBottom();
		await wrapper.vm.$nextTick();

		if (el) {
			expect(el.scrollTo).toHaveBeenCalled();
		}
	});

	test('userScrolledUp 为 true 时不自动滚动', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		const el = wrapper.vm.$refs.scrollContainer;
		if (el) {
			el.scrollTo = vi.fn();
		}

		wrapper.vm.userScrolledUp = true;
		wrapper.vm.scrollToBottom();
		await wrapper.vm.$nextTick();

		if (el) {
			expect(el.scrollTo).not.toHaveBeenCalled();
		}
	});

	test('发送消息时重置 userScrolledUp', async () => {
		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		wrapper.vm.userScrolledUp = true;
		wrapper.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'hi', files: [] });
		await wrapper.vm.$nextTick();

		expect(wrapper.vm.userScrolledUp).toBe(false);
	});
});

describe('ChatPage 新建对话', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid' });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test('isMainSession 在 sessionKey 为 agent:main:main 时为 true', async () => {
		mockRpc.request.mockImplementation((method) => {
			if (method === 'nativeui.sessions.listAll') {
				return Promise.resolve({ items: [{ sessionId: 'main-sess', sessionKey: 'agent:main:main', indexed: true }] });
			}
			if (method === 'nativeui.sessions.get') {
				return Promise.resolve({ messages: [] });
			}
			return Promise.resolve({});
		});

		const wrapper = createWrapper('main-sess');
		await flushPromises();

		expect(wrapper.vm.isMainSession).toBe(true);
	});

	test('isMainSession 在非 agent:main:main session 时为 false', async () => {
		mockRpc.request.mockImplementation((method) => {
			if (method === 'nativeui.sessions.listAll') {
				return Promise.resolve({ items: [{ sessionId: 'other-sess', sessionKey: 'agent:cron:daily', indexed: true }] });
			}
			if (method === 'nativeui.sessions.get') {
				return Promise.resolve({ messages: [] });
			}
			return Promise.resolve({});
		});

		const wrapper = createWrapper('other-sess');
		await flushPromises();

		expect(wrapper.vm.isMainSession).toBe(false);
	});

	test('isMainSession 在 orphan session（无 sessionKey）时为 false', async () => {
		mockRpc.request.mockImplementation((method) => {
			if (method === 'nativeui.sessions.listAll') {
				return Promise.resolve({ items: [] });
			}
			if (method === 'nativeui.sessions.get') {
				return Promise.resolve({ messages: [] });
			}
			return Promise.resolve({});
		});

		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		expect(wrapper.vm.isMainSession).toBe(false);
	});

	test('onNewChat 调用 sessions.reset 并从其响应获取 sessionId 后导航', async () => {
		mockRpc.request.mockImplementation((method) => {
			if (method === 'nativeui.sessions.listAll') {
				return Promise.resolve({ items: [{ sessionId: 'main-sess', sessionKey: 'agent:main:main', indexed: true }] });
			}
			if (method === 'nativeui.sessions.get') {
				return Promise.resolve({ messages: [] });
			}
			if (method === 'sessions.reset') {
				return Promise.resolve({ ok: true, entry: { sessionId: 'new-sess-123' } });
			}
			return Promise.resolve({});
		});

		const wrapper = createWrapper('main-sess');
		await flushPromises();

		await wrapper.vm.onNewChat();
		await flushPromises();

		// 验证 sessions.reset 调用
		const resetCall = mockRpc.request.mock.calls.find((c) => c[0] === 'sessions.reset');
		expect(resetCall).toBeTruthy();
		expect(resetCall[1]).toEqual({ key: 'agent:main:main', reason: 'new' });

		// 不再调用 sessions.resolve
		const resolveCall = mockRpc.request.mock.calls.find((c) => c[0] === 'sessions.resolve');
		expect(resolveCall).toBeFalsy();

		// 验证刷新 sessions store
		expect(mockLoadAllSessions).toHaveBeenCalled();

		// 验证导航到新 sessionId
		expect(mockRouter.push).toHaveBeenCalledWith({ name: 'chat', params: { sessionId: 'new-sess-123' } });

		// resetting 已恢复
		expect(wrapper.vm.resetting).toBe(false);
	});

	test('onNewChat 失败时 notify.error 且 resetting 恢复 false', async () => {
		mockRpc.request.mockImplementation((method) => {
			if (method === 'nativeui.sessions.listAll') {
				return Promise.resolve({ items: [{ sessionId: 'main-sess', sessionKey: 'agent:main:main', indexed: true }] });
			}
			if (method === 'nativeui.sessions.get') {
				return Promise.resolve({ messages: [] });
			}
			if (method === 'sessions.reset') {
				return Promise.reject(new Error('network error'));
			}
			return Promise.resolve({});
		});

		const wrapper = createWrapper('main-sess');
		await flushPromises();

		await wrapper.vm.onNewChat();
		await flushPromises();

		expect(mockNotify.error).toHaveBeenCalledWith('New chat failed');
		expect(wrapper.vm.resetting).toBe(false);
		expect(mockRouter.push).not.toHaveBeenCalled();
	});

	test('sessions.reset 返回无 entry.sessionId 时 notify.error', async () => {
		mockRpc.request.mockImplementation((method) => {
			if (method === 'nativeui.sessions.listAll') {
				return Promise.resolve({ items: [{ sessionId: 'main-sess', sessionKey: 'agent:main:main', indexed: true }] });
			}
			if (method === 'nativeui.sessions.get') {
				return Promise.resolve({ messages: [] });
			}
			if (method === 'sessions.reset') {
				return Promise.resolve({ ok: true });
			}
			return Promise.resolve({});
		});

		const wrapper = createWrapper('main-sess');
		await flushPromises();

		await wrapper.vm.onNewChat();
		await flushPromises();

		expect(mockNotify.error).toHaveBeenCalledWith('New chat failed');
		expect(wrapper.vm.resetting).toBe(false);
		expect(mockRouter.push).not.toHaveBeenCalled();
	});

	test('非 agent:main:main session 不渲染新建按钮', async () => {
		mockRpc.request.mockImplementation((method) => {
			if (method === 'nativeui.sessions.listAll') {
				return Promise.resolve({ items: [] });
			}
			if (method === 'nativeui.sessions.get') {
				return Promise.resolve({ messages: [] });
			}
			return Promise.resolve({});
		});

		const wrapper = createWrapper('orphan-sess');
		await flushPromises();

		// 桌面端 header 中不应有 new-chat 按钮（v-if="isMainSession"）
		const header = wrapper.find('header');
		const buttons = header.findAll('button');
		// 没有按钮（因为 isMainSession 为 false）
		expect(buttons.length).toBe(0);
	});
});

describe('ChatPage ensureRpcClient botId 切换', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		mockSessionsItems.length = 0;
		mockRpc.request.mockImplementation((method) => {
			if (method === 'nativeui.sessions.listAll') return Promise.resolve({ items: [] });
			if (method === 'nativeui.sessions.get') return Promise.resolve({ messages: [] });
			return Promise.resolve({});
		});
		vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid' });
	});

	afterEach(() => {
		vi.useRealTimers();
		mockSessionsItems.length = 0;
	});

	test('botId 变化时关闭旧连接并重建', async () => {
		const { createGatewayRpcClient } = await import('../services/gateway.ws.js');
		mockSessionsItems.push({ sessionId: 'sess-a', botId: 'bot-1' });

		const wrapper = createWrapper('sess-a');
		await flushPromises();

		// 首次加载建立了 rpcClient
		expect(wrapper.vm.rpcClient).toBeTruthy();

		// 模拟已有连接指向 bot-1，现在 currentBotId 变为 bot-2
		wrapper.vm.__rpcBotId = 'bot-1';
		mockSessionsItems.push({ sessionId: 'sess-b', botId: 'bot-2' });

		// 直接 patch currentBotId 以绕过 $route mock 响应性
		const origComputed = wrapper.vm.currentBotId;
		Object.defineProperty(wrapper.vm, 'currentBotId', { get: () => 'bot-2', configurable: true });

		createGatewayRpcClient.mockClear();
		mockRpc.close.mockClear();
		await wrapper.vm.ensureRpcClient();

		expect(mockRpc.close).toHaveBeenCalled();
		expect(createGatewayRpcClient).toHaveBeenCalledWith({ botId: 'bot-2' });
		expect(wrapper.vm.__rpcBotId).toBe('bot-2');

		// 恢复
		Object.defineProperty(wrapper.vm, 'currentBotId', { get: () => origComputed, configurable: true });
	});

	test('同一 botId 时复用连接', async () => {
		const { createGatewayRpcClient } = await import('../services/gateway.ws.js');
		mockSessionsItems.push({ sessionId: 'sess-a', botId: 'bot-1' });

		const wrapper = createWrapper('sess-a');
		await flushPromises();

		const clientRef = wrapper.vm.rpcClient;
		wrapper.vm.__rpcBotId = 'bot-1';

		// currentBotId 仍为 bot-1
		Object.defineProperty(wrapper.vm, 'currentBotId', { get: () => 'bot-1', configurable: true });

		createGatewayRpcClient.mockClear();
		mockRpc.close.mockClear();
		await wrapper.vm.ensureRpcClient();

		expect(mockRpc.close).not.toHaveBeenCalled();
		expect(createGatewayRpcClient).not.toHaveBeenCalled();
		expect(wrapper.vm.rpcClient).toBe(clientRef);
	});
});

describe('ChatPage chatTitle', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		mockSessionsItems.length = 0;
		mockRpc.request.mockImplementation((method) => {
			if (method === 'nativeui.sessions.listAll') {
				return Promise.resolve({ items: [] });
			}
			if (method === 'nativeui.sessions.get') {
				return Promise.resolve({ messages: [] });
			}
			return Promise.resolve({});
		});
		vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid' });
	});

	afterEach(() => {
		vi.useRealTimers();
		mockSessionsItems.length = 0;
	});

	test('优先显示 session title', async () => {
		mockSessionsItems.push({ sessionId: 'sess-1', title: '自定义标题', derivedTitle: '派生标题' });
		const wrapper = createWrapper('sess-1');
		await flushPromises();
		expect(wrapper.vm.chatTitle).toBe('自定义标题');
	});

	test('title 为空时回退到 cleanDerivedTitle', async () => {
		mockSessionsItems.push({ sessionId: 'sess-1', title: '', derivedTitle: '[Mon 2026-03-02 16:16 GMT+8] 你好世界' });
		const wrapper = createWrapper('sess-1');
		await flushPromises();
		expect(wrapper.vm.chatTitle).toBe('你好世界');
	});

	test('title 和 derivedTitle 都为空时回退到 sessionId', async () => {
		mockSessionsItems.push({ sessionId: 'sess-1', title: '', derivedTitle: '' });
		const wrapper = createWrapper('sess-1');
		await flushPromises();
		expect(wrapper.vm.chatTitle).toBe('Session sess-1');
	});

	test('sessions store 中无匹配时回退到 sessionId', async () => {
		const wrapper = createWrapper('unknown-sess');
		await flushPromises();
		expect(wrapper.vm.chatTitle).toBe('Session unknown-sess');
	});

	test('无 sessionId 时返回空标题', async () => {
		const wrapper = createWrapper('');
		await flushPromises();
		expect(wrapper.vm.chatTitle).toBe('');
	});
});

describe('ChatPage currentBotId watcher', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		mockSessionsItems.length = 0;
		mockBotsItems.length = 0;
		mockBotsItems.push({ id: 'bot-1', online: true });
		mockRpc.request.mockImplementation((method) => {
			if (method === 'nativeui.sessions.listAll') {
				return Promise.resolve({ items: [] });
			}
			if (method === 'nativeui.sessions.get') {
				return Promise.resolve({ messages: [] });
			}
			return Promise.resolve({});
		});
		vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid' });
	});

	afterEach(() => {
		vi.useRealTimers();
		mockSessionsItems.length = 0;
		mockBotsItems.length = 0;
		mockBotsItems.push({ id: 'bot-1', online: true });
	});

	test('bot 离线导致 sessions 清空时不应提示"已解绑"', async () => {
		mockSessionsItems.push({ sessionId: 'sess-1', botId: 'bot-1' });
		const wrapper = createWrapper('sess-1');
		await flushPromises();

		// bot 仍在 store 中但离线 — 直接触发 watcher handler
		mockBotsItems[0] = { id: 'bot-1', online: false };
		wrapper.vm.$options.watch.currentBotId.call(wrapper.vm, null, 'bot-1');

		expect(mockNotify.warning).not.toHaveBeenCalled();
		expect(mockRouter.replace).not.toHaveBeenCalled();
	});

	test('bot 真正解绑时应提示"已解绑"并跳转', async () => {
		mockSessionsItems.push({ sessionId: 'sess-1', botId: 'bot-1' });
		const wrapper = createWrapper('sess-1');
		await flushPromises();

		// bot 从 store 中移除（真正解绑）
		mockBotsItems.length = 0;
		wrapper.vm.$options.watch.currentBotId.call(wrapper.vm, null, 'bot-1');

		expect(mockNotify.warning).toHaveBeenCalledWith('Bot has been unbound');
		expect(mockRouter.replace).toHaveBeenCalled();
	});
});
