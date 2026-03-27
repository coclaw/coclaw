import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

import { createChatStore } from './chat.store.js';
import { useAgentRunsStore } from './agent-runs.store.js';
import { useBotsStore, __resetAwaitingConnIds as __resetBotStoreInternals } from './bots.store.js';

// 兼容旧测试：创建默认空 session store，可手动设置状态字段
// 同一 Pinia 实例中多次调用返回同一 store（与原 useChatStore 行为一致）
function useChatStore() {
	return createChatStore('session::main', { botId: '', agentId: 'main' });
}

// --- Mocks ---

const mockConnections = new Map();

vi.mock('../services/bot-connection-manager.js', () => ({
	useBotConnections: () => ({
		get: (botId) => mockConnections.get(String(botId)),
		connect: vi.fn(),
		disconnect: vi.fn(),
		syncConnections: vi.fn(),
		disconnectAll: vi.fn(),
	}),
	__resetBotConnections: vi.fn(),
}));

vi.mock('../utils/file-helper.js', () => ({
	fileToBase64: vi.fn().mockResolvedValue('base64data'),
}));

vi.mock('../services/bots.api.js', () => ({
	listBots: vi.fn().mockResolvedValue([]),
}));

// --- Helper ---

function mockConn(overrides = {}) {
	return {
		state: 'connected',
		request: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
		...overrides,
	};
}

/**
 * 构建标准的 sessions.get + chat.history + coclaw.chatHistory.list 响应
 * sessions.get 返回扁平消息（wrapOcMessages 由 store 内部调用，不 mock）
 */
function setupConnForLoad(conn, { flatMessages = [], currentSessionId = 'cur-sess', history = [] } = {}) {
	conn.request.mockImplementation((method) => {
		if (method === 'sessions.get') {
			return Promise.resolve({ messages: flatMessages });
		}
		if (method === 'chat.history') {
			return Promise.resolve({ sessionId: currentSessionId });
		}
		if (method === 'coclaw.chatHistory.list') {
			return Promise.resolve({ history });
		}
		return Promise.resolve(null);
	});
}

// --- Tests ---

describe('useChatStore', () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		mockConnections.clear();
		vi.clearAllMocks();
		__resetBotStoreInternals();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// =====================================================================
	// createChatStore（工厂）
	// =====================================================================

	describe('createChatStore', () => {
		test('session 模式：根据 opts 初始化 identity 字段', () => {
			const store = createChatStore('session:1:ops', { botId: '1', agentId: 'ops' });
			expect(store.botId).toBe('1');
			expect(store.chatSessionKey).toBe('agent:ops:main');
			expect(store.topicMode).toBe(false);
			expect(store.sessionId).toBe('');
		});

		test('topic 模式：根据 storeKey 初始化 identity 字段', () => {
			const store = createChatStore('topic:topic-1', { botId: '1', agentId: 'research' });
			expect(store.topicMode).toBe(true);
			expect(store.sessionId).toBe('topic-1');
			expect(store.topicAgentId).toBe('research');
			expect(store.chatSessionKey).toBe('');
			expect(store.historyExhausted).toBe(true);
		});

		test('agentId 默认为 main', () => {
			const store = createChatStore('session:1:main', { botId: '1' });
			expect(store.chatSessionKey).toBe('agent:main:main');
		});
	});

	// =====================================================================
	// activate
	// =====================================================================

	describe('activate', () => {
		test('首次激活：加载消息并调用 __loadChatHistory', async () => {
			const conn = mockConn();
			const historyItems = [
				{ sessionId: 'hist-1', archivedAt: 100 },
				{ sessionId: 'hist-2', archivedAt: 200 },
			];
			setupConnForLoad(conn, {
				flatMessages: [{ role: 'user', content: 'hi' }],
				history: historyItems,
			});
			mockConnections.set('1', conn);

			const store = createChatStore('session:1:main', { botId: '1', agentId: 'main' });
			await store.activate();

			expect(store.messages).toHaveLength(1);
			expect(store.messages[0]).toMatchObject({
				type: 'message',
				id: 'oc-0',
				message: { role: 'user', content: 'hi' },
			});
			await vi.waitFor(() => {
				expect(store.historySessionIds).toHaveLength(2);
			});
		});

		test('连接未就绪时保持 loading 并注册 WS 监听', async () => {
			// 无连接 → WS 未就绪
			const store = createChatStore('session:1:main', { botId: '1', agentId: 'main' });
			await store.activate();

			expect(store.loading).toBe(true);
			expect(store.errorText).toBe('');
		});

		test('重复调用 activate 时做静默刷新（不重复 init）', async () => {
			const conn = mockConn();
			setupConnForLoad(conn);
			mockConnections.set('1', conn);

			const store = createChatStore('session:1:main', { botId: '1', agentId: 'main' });
			await store.activate();
			const callCount = conn.request.mock.calls.length;

			await store.activate();
			// 静默刷新会再调一次 sessions.get + chat.history
			expect(conn.request.mock.calls.length).toBeGreaterThan(callCount);
		});

		test('skipLoad 跳过消息加载但注册 WS 监听', async () => {
			const conn = mockConn();
			mockConnections.set('1', conn);

			const store = createChatStore('topic:topic-1', { botId: '1', agentId: 'main' });
			await store.activate({ skipLoad: true });

			expect(store.__initialized).toBe(true);
			expect(store.loading).toBe(false);
			expect(conn.request).not.toHaveBeenCalled();
		});

		test('botId 为空时不加载', async () => {
			const store = createChatStore('session::main', { botId: '', agentId: 'main' });
			await store.activate();
			expect(store.__initialized).toBe(true);
			expect(store.loading).toBe(false);
		});

		test('topic 模式首次激活：加载消息', async () => {
			const conn = mockConn();
			conn.request.mockImplementation((method) => {
				if (method === 'coclaw.sessions.getById') {
					return Promise.resolve({ messages: [{ id: 't1', type: 'message', message: { role: 'user', content: 'topic msg' } }] });
				}
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = createChatStore('topic:topic-1', { botId: '1', agentId: 'main' });
			await store.activate();

			expect(store.messages).toHaveLength(1);
		});
	});

	// =====================================================================
	// loadMessages
	// =====================================================================

	describe('loadMessages', () => {
		test('调用 sessions.get 和 chat.history，设置 messages 和 currentSessionId', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			const flatMsgs = [
				{ role: 'user', content: 'hello' },
				{ role: 'assistant', content: 'hi there' },
			];
			setupConnForLoad(conn, { flatMessages: flatMsgs, currentSessionId: 'cur-123' });
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';

			const ok = await store.loadMessages();
			expect(ok).toBe(true);
			// wrapOcMessages 包装后
			expect(store.messages).toHaveLength(2);
			expect(store.messages[0]).toMatchObject({ type: 'message', id: 'oc-0', message: { role: 'user', content: 'hello' } });
			expect(store.messages[1]).toMatchObject({ type: 'message', id: 'oc-1', message: { role: 'assistant', content: 'hi there' } });
			expect(store.currentSessionId).toBe('cur-123');
		});

		test('chatSessionKey 为空时返回 false 且清空消息', async () => {
			// topic store 的 chatSessionKey 为空
			const store = createChatStore('topic:t1', { botId: '1', agentId: 'main' });
			store.sessionId = ''; // 清空 sessionId 使 __loadTopicMessages 短路
			store.messages = [{ id: 'old' }];

			const ok = await store.loadMessages();
			expect(ok).toBe(false);
			expect(store.messages).toHaveLength(0);
		});

		test('连接缺失时返回 false 并设置 errorText', async () => {
			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '999'; // 无对应连接
			store.chatSessionKey = 'agent:main:main';

			const ok = await store.loadMessages();
			expect(ok).toBe(false);
			expect(store.errorText).toBe('Bot not connected');
			expect(store.loading).toBe(false);
		});

		test('连接存在但未就绪时保持 loading 状态，不设 errorText', async () => {
			const conn = mockConn({ state: 'connecting' });
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';

			const ok = await store.loadMessages();
			expect(ok).toBe(false);
			expect(store.loading).toBe(true);
			expect(store.errorText).toBe('');
			expect(conn.request).not.toHaveBeenCalled();
		});

		test('silent 模式下不设置 loading 状态', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';

			// 监视 loading 赋值
			let loadingWasTrue = false;
			conn.request.mockImplementation((method) => {
				if (store.loading) loadingWasTrue = true;
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'cur' });
				return Promise.resolve(null);
			});

			await store.loadMessages({ silent: true });
			expect(loadingWasTrue).toBe(false);
		});

		test('请求失败时返回 false 并设置 errorText', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockRejectedValue(new Error('network error'));
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';

			const ok = await store.loadMessages();
			expect(ok).toBe(false);
			expect(store.errorText).toBe('network error');
			expect(store.loading).toBe(false);
		});

		test('silent 模式下连接缺失时不设置 errorText', async () => {
			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '999'; // 无对应连接
			store.chatSessionKey = 'agent:main:main';
			store.errorText = '';

			const ok = await store.loadMessages({ silent: true });
			expect(ok).toBe(false);
			expect(store.errorText).toBe('');
		});

		test('sessions.get 传递 chatSessionKey', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			setupConnForLoad(conn);
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.chatSessionKey = 'agent:ops:main';

			await store.loadMessages();

			expect(conn.request).toHaveBeenCalledWith('sessions.get', expect.objectContaining({
				key: 'agent:ops:main',
			}));
			expect(conn.request).toHaveBeenCalledWith('chat.history', expect.objectContaining({
				sessionKey: 'agent:ops:main',
			}));
		});
	});

	// =====================================================================
	// __loadTopicMessages
	// =====================================================================

	describe('__loadTopicMessages', () => {
		test('topic 模式下调用 coclaw.sessions.getById', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			const topicMsgs = [
				{ id: 't1', type: 'message', message: { role: 'user', content: 'topic hi' } },
			];
			conn.request.mockImplementation((method) => {
				if (method === 'coclaw.sessions.getById') {
					return Promise.resolve({ messages: topicMsgs });
				}
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'topic-1';
			store.botId = '1';
			store.topicMode = true;
			store.topicAgentId = 'main';

			const ok = await store.loadMessages();
			expect(ok).toBe(true);
			expect(store.messages).toEqual(topicMsgs);

			expect(conn.request).toHaveBeenCalledWith('coclaw.sessions.getById', {
				sessionId: 'topic-1',
				agentId: 'main',
			});
		});

		test('topic 模式下 sessionId 为空时返回 false', async () => {
			const store = useChatStore();
			store.topicMode = true;
			store.sessionId = '';

			const ok = await store.loadMessages();
			expect(ok).toBe(false);
			expect(store.messages).toHaveLength(0);
		});
	});

	// =====================================================================
	// sendMessage
	// =====================================================================

	describe('sendMessage', () => {
		test('连接不存在时抛出错误', async () => {
			const store = useChatStore();
			store.botId = '999'; // 无连接
			store.chatSessionKey = 'agent:main:main';

			await expect(store.sendMessage('hello')).rejects.toThrow('Bot not connected');
		});

		test('连接未就绪（非 connected 状态）时抛出错误', async () => {
			const conn = mockConn({ state: 'connecting' });
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';

			await expect(store.sendMessage('hello')).rejects.toThrow('Bot not connected');
		});

		test('topic 模式下 sessionId 为空时返回 { accepted: false }', async () => {
			const store = createChatStore('topic:t1', { botId: '1', agentId: 'main' });
			store.sessionId = ''; // 清空使 guard 生效
			const result = await store.sendMessage('hello');
			expect(result).toEqual({ accepted: false });
		});

		test('sending 为 true 时返回 { accepted: false }', async () => {
			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.sending = true;

			const result = await store.sendMessage('hello');
			expect(result).toEqual({ accepted: false });
		});

		test('正常发送：创建乐观消息并调用 conn.request("agent")', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					if (options?.onAccepted) options.onAccepted({ runId: 'run-42' });
					return Promise.resolve({ status: 'ok' });
				}
				// reconcile 时的 sessions.get / chat.history
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'sess-1' });
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';

			const result = await store.sendMessage('hello world');
			expect(result.accepted).toBe(true);

			const agentCall = conn.request.mock.calls.find((c) => c[0] === 'agent');
			expect(agentCall).toBeTruthy();
			expect(agentCall[1].message).toBe('hello world');
			expect(agentCall[1].sessionKey).toBe('agent:main:main');
		});

		test('onAccepted 回调设置 streamingRunId 和 __accepted', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-abc' });
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'cur' });
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';

			await store.sendMessage('test');
			expect(store.__accepted).toBe(true);
		});

		test('chat 模式下 agentParams 使用 sessionKey', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-1' });
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'sess-1' });
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';

			await store.sendMessage('hi');

			const agentCall = conn.request.mock.calls.find((c) => c[0] === 'agent');
			expect(agentCall[1].sessionKey).toBe('agent:main:main');
			expect(agentCall[1].sessionId).toBeUndefined();
		});

		test('topic 模式下 agentParams 使用 sessionId', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-1' });
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'coclaw.sessions.getById') return Promise.resolve({ messages: [] });
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'topic-1';
			store.botId = '1';
			store.topicMode = true;
			store.topicAgentId = 'main';
			store.chatSessionKey = '';

			await store.sendMessage('hi topic');

			const agentCall = conn.request.mock.calls.find((c) => c[0] === 'agent');
			expect(agentCall[1].sessionId).toBe('topic-1');
			expect(agentCall[1].sessionKey).toBeUndefined();
		});

		test('带图片文件时内容变为 blocks 数组，且 fileToBase64 只调用一次（缓存复用）', async () => {
			const { fileToBase64 } = await import('../utils/file-helper.js');
			fileToBase64.mockResolvedValue('imgbase64');

			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-1' });
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'cur' });
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';

			const fakeFile = { type: 'image/png' };
			const files = [{ isImg: true, file: fakeFile, name: 'pic.png' }];
			await store.sendMessage('look at this', files);

			const agentCall = conn.request.mock.calls.find((c) => c[0] === 'agent');
			expect(agentCall[1].attachments).toHaveLength(1);
			expect(agentCall[1].attachments[0].type).toBe('image');
			// 同一图片文件只编码一次（乐观消息缓存复用到 attachments）
			expect(fileToBase64).toHaveBeenCalledTimes(1);
		});

		test('发送失败（request 抛出）时清理 streaming 状态并重新抛出', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method) => {
				if (method === 'agent') return Promise.reject(new Error('send failed'));
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';

			await expect(store.sendMessage('fail')).rejects.toThrow('send failed');
			expect(store.sending).toBe(false);
			expect(store.messages.some((m) => m._local)).toBe(false);
		});

		test('pre-acceptance 180s 超时：sending 置 false，__agentSettled 为 true，抛出 PRE_ACCEPTANCE_TIMEOUT', async () => {
			vi.useFakeTimers();
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method) => {
				if (method === 'agent') return new Promise(() => {});
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';

			// 179s 时不应超时
			const sendPromise = store.sendMessage('hello');
			await vi.advanceTimersByTimeAsync(179_000);
			expect(store.sending).toBe(true);

			// 180s 时应超时
			const [, result] = await Promise.allSettled([
				vi.advanceTimersByTimeAsync(1_000),
				sendPromise,
			]);

			expect(result.status).toBe('rejected');
			expect(result.reason).toMatchObject({ code: 'PRE_ACCEPTANCE_TIMEOUT' });
			expect(store.sending).toBe(false);
			expect(store.__agentSettled).toBe(true);
		});

		test('post-acceptance 30min 超时：sending 置 false，保留消息并 reconcile，抛出 POST_ACCEPTANCE_TIMEOUT', async () => {
			vi.useFakeTimers();
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			// 调用 onAccepted 但永不 resolve
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-timeout' });
					return new Promise(() => {});
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'sess-1' });
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';

			const sendPromise = store.sendMessage('hello');
			await vi.advanceTimersByTimeAsync(0);
			// 确认已 accepted，乐观消息已移入 agentRunsStore（allMessages 可见）
			expect(store.__accepted).toBe(true);
			expect(store.allMessages.length).toBeGreaterThan(0);

			const reconcileSpy = vi.spyOn(store, '__reconcileMessages');

			const [, result] = await Promise.allSettled([
				vi.advanceTimersByTimeAsync(30 * 60_000),
				sendPromise,
			]);

			expect(result.status).toBe('rejected');
			expect(result.reason).toMatchObject({ code: 'POST_ACCEPTANCE_TIMEOUT' });
			expect(store.sending).toBe(false);
			// 已 accepted 后超时应 reconcile 而非 removeLocalEntries
			expect(reconcileSpy).toHaveBeenCalled();
		});

		test('__agentSettled 为 true 时，WS_CLOSED 错误被抑制，返回 { accepted: true }', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-ws' });
					// 模拟 lifecycle:end 事件提前处理
					const store2 = useChatStore();
					store2.__agentSettled = true;
					const err = new Error('ws closed');
					err.code = 'WS_CLOSED';
					return Promise.reject(err);
				}
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';

			const result = await store.sendMessage('hello');
			expect(result).toEqual({ accepted: true });
		});

		test('WS_CLOSED 且未 accepted 时等待重连后自动重试一次', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);
			// waitForConnected 读取 byId.connState
			botsStore.byId['1'].connState = 'connected';

			let callCount = 0;
			const conn = mockConn();

			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					callCount++;
					if (callCount === 1) {
						const err = new Error('connection closed');
						err.code = 'WS_CLOSED';
						return Promise.reject(err);
					}
					// 第二次（重试）：成功
					options?.onAccepted?.({ runId: 'run-retry' });
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'cur' });
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';

			const result = await store.sendMessage('hello');
			expect(result).toEqual({ accepted: true });
			expect(callCount).toBe(2);
		});

		test('WS_CLOSED 且未 accepted 时重连超时后仍抛出错误', async () => {
			vi.useFakeTimers();
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn({ state: 'disconnected' });
			let callCount = 0;
			conn.request.mockImplementation((method) => {
				if (method === 'agent') {
					callCount++;
					const err = new Error('connection closed');
					err.code = 'WS_CLOSED';
					return Promise.reject(err);
				}
				return Promise.resolve(null);
			});
			const connForSend = mockConn();
			connForSend.request = conn.request;
			connForSend.on = vi.fn();
			connForSend.off = vi.fn();

			let firstGet = true;
			mockConnections.set('1', connForSend);
			const origGet = mockConnections.get.bind(mockConnections);
			mockConnections.get = (id) => {
				if (id === '1' && callCount > 0 && firstGet) {
					firstGet = false;
					conn.on = vi.fn();
					conn.off = vi.fn();
					return conn;
				}
				return origGet(id);
			};

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';

			const [, result] = await Promise.allSettled([
				vi.advanceTimersByTimeAsync(15_000),
				store.sendMessage('hello'),
			]);

			// 恢复被覆盖的 get 方法，避免污染后续测试
			mockConnections.get = origGet;

			expect(result.status).toBe('rejected');
			expect(result.reason.code).toBe('WS_CLOSED');
		});

		test('WS_CLOSED 重试本身再次失败时不二次重试，直接抛出', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);
			botsStore.byId['1'].connState = 'connected';

			let callCount = 0;
			const conn = mockConn();
			conn.request.mockImplementation((method) => {
				if (method === 'agent') {
					callCount++;
					const err = new Error('connection closed');
					err.code = 'WS_CLOSED';
					return Promise.reject(err);
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'cur' });
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';

			await expect(store.sendMessage('hello')).rejects.toMatchObject({ code: 'WS_CLOSED' });
			expect(callCount).toBe(2); // 原始 + 重试各一次
		});

		test('WS_CLOSED 且已 accepted 时不抛出，等重连后 reconcile', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);
			botsStore.byId['1'].connState = 'connected';

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-acc' });
					const err = new Error('connection closed');
					err.code = 'WS_CLOSED';
					return Promise.reject(err);
				}
				// reconcile 请求
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'cur' });
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';

			const result = await store.sendMessage('hello');
			expect(result).toEqual({ accepted: true });
			expect(store.sending).toBe(false);
		});

		test('!__accepted 且 status !== "ok" 时返回 { accepted: false } 并移除本地条目', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method) => {
				if (method === 'agent') return Promise.resolve({ status: 'rejected' });
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';

			const result = await store.sendMessage('hello');
			expect(result).toEqual({ accepted: false });
			expect(store.messages.some((m) => m._local)).toBe(false);
		});

		// event:agent 监听器已由 botsStore.__bridgeConn 集中管理
		// register 不再自行注册/注销 conn.on('event:agent')，相关测试已移至 agent-runs.store.test.js
	});

	// =====================================================================
	// resetChat
	// =====================================================================

	describe('resetChat', () => {
		test('调用 sessions.reset 并返回新 sessionId', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockResolvedValue({ entry: { sessionId: 'sess-new' } });
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';

			const newId = await store.resetChat();
			expect(newId).toBe('sess-new');

			const resetCall = conn.request.mock.calls.find((c) => c[0] === 'sessions.reset');
			expect(resetCall).toBeTruthy();
			expect(resetCall[1].key).toBe('agent:main:main');
			expect(resetCall[1].reason).toBe('new');
		});

		test('连接不存在时抛出错误', async () => {
			const store = useChatStore();
			store.botId = '999';

			await expect(store.resetChat()).rejects.toThrow('Bot not connected');
		});

		test('响应中无 sessionId 时抛出错误', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockResolvedValue({ entry: {} }); // 无 sessionId
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';

			await expect(store.resetChat()).rejects.toThrow('Failed to resolve new session');
		});

		test('resetting 标志在执行期间为 true，完成后恢复 false', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			let resettingDuring = false;
			conn.request.mockImplementation(() => {
				resettingDuring = useChatStore().resetting;
				return Promise.resolve({ entry: { sessionId: 'sess-new' } });
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';

			await store.resetChat();
			expect(resettingDuring).toBe(true);
			expect(store.resetting).toBe(false);
		});

		test('resetChat 使用 chatSessionKey 解析 agentId 构建 key', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockResolvedValue({ entry: { sessionId: 'new-sess' } });
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.botId = '1';
			store.chatSessionKey = 'agent:ops:main';

			const newId = await store.resetChat();
			expect(newId).toBe('new-sess');
			expect(conn.request).toHaveBeenCalledWith('sessions.reset', {
				key: 'agent:ops:main',
				reason: 'new',
			});
		});
	});

	// =====================================================================
	// cancelSend
	// =====================================================================

	describe('cancelSend', () => {
		test('未 accepted 时取消：清理 streaming 并删除本地消息', () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);
			mockConnections.set('1', mockConn());

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.sending = true;
			store.__accepted = false;
			store.streamingRunId = 'run-x';
			store.messages = [
				{ id: '__local_user_1', _local: true, message: { role: 'user', content: 'hi' } },
				{ id: '__local_bot_1', _local: true, _streaming: true, message: { role: 'assistant', content: '' } },
			];

			store.cancelSend();

			expect(store.sending).toBe(false);
			expect(store.streamingRunId).toBeNull();
			expect(store.messages.some((m) => m._local)).toBe(false);
		});

		test('accepted 之前取消：sendMessage 立即返回 { accepted: false }', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method) => {
				if (method === 'agent') return new Promise(() => {});
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';

			const sendPromise = store.sendMessage('hello');
			await Promise.resolve();

			expect(store.sending).toBe(true);
			expect(store.__accepted).toBe(false);

			store.cancelSend();

			const result = await sendPromise;
			expect(result).toEqual({ accepted: false });
			expect(store.sending).toBe(false);
			expect(store.messages.some((m) => m._local)).toBe(false);
		});

		test('accepted 之后取消：sendMessage 返回 { accepted: true }，保留消息并 reconcile', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-cancel' });
					return new Promise(() => {});
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'sess-1' });
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';

			const sendPromise = store.sendMessage('hello');
			await Promise.resolve();

			expect(store.__accepted).toBe(true);

			const reconcileSpy = vi.spyOn(store, '__reconcileMessages');

			store.cancelSend();

			const result = await sendPromise;
			expect(result).toEqual({ accepted: true });
			// 已 accepted 后取消应 reconcile 而非 removeLocalEntries
			expect(reconcileSpy).toHaveBeenCalled();
		});
	});

	// =====================================================================
	// cleanup
	// =====================================================================

	describe('cleanup', () => {
		test('清理发送状态但保留数据（store 持续存活）', () => {
			const conn = mockConn();
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.botId = '1';
			store.messages = [{ id: 'm1' }];
			store.chatSessionKey = 'agent:main:main';
			store.sending = true;
			store.__streamingTimer = setTimeout(() => {}, 99999);

			store.cleanup();

			// 发送状态已清理
			expect(store.sending).toBe(false);
			expect(store.__streamingTimer).toBeNull();
			// 数据保留
			expect(store.messages).toHaveLength(1);
			expect(store.botId).toBe('1');
			expect(store.chatSessionKey).toBe('agent:main:main');
		});
	});

	// __onAgentEvent 相关测试已迁移到 agent-stream.test.js 和 agent-runs.store.test.js

	describe('__reconcileMessages', () => {
		test('连接不存在时返回 false', async () => {
			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '999'; // 无连接
			store.chatSessionKey = 'agent:main:main';
			store.streamingRunId = 'run-1';

			const result = await store.__reconcileMessages();
			expect(result).toBe(false);
		});
	});



	// =====================================================================
	// getters
	// =====================================================================

	describe('getters', () => {
		test('currentSessionKey 在 session 模式下返回 chatSessionKey', () => {
			const store = useChatStore();
			store.chatSessionKey = 'agent:main:main';

			expect(store.currentSessionKey).toBe('agent:main:main');
		});

		test('currentSessionKey 在 topic 模式下返回空字符串', () => {
			const store = useChatStore();
			store.topicMode = true;
			store.chatSessionKey = 'agent:main:main';

			expect(store.currentSessionKey).toBe('');
		});

		test('currentSessionKey 在 chatSessionKey 为空时返回空字符串', () => {
			const store = useChatStore();
			store.chatSessionKey = '';

			expect(store.currentSessionKey).toBe('');
		});

		test('isMainSession 在 chatSessionKey 为 "agent:main:main" 时为 true', () => {
			const store = useChatStore();
			store.chatSessionKey = 'agent:main:main';

			expect(store.isMainSession).toBe(true);
		});

		test('isMainSession 对非 main agent 的 main session 也返回 true', () => {
			const store = useChatStore();
			store.chatSessionKey = 'agent:ops:main';

			expect(store.isMainSession).toBe(true);
		});

		test('isMainSession 在 chatSessionKey 非 main 时为 false', () => {
			const store = useChatStore();
			store.chatSessionKey = 'agent:main:thread1';

			expect(store.isMainSession).toBe(false);
		});

		test('isMainSession 在无 chatSessionKey 时为 false', () => {
			const store = useChatStore();
			store.chatSessionKey = '';

			expect(store.isMainSession).toBe(false);
		});

		// --- allMessages 去重 ---

		test('allMessages 合并 streamingMsgs 时跳过已在 messages 中的乐观 user 消息', () => {
			const store = useChatStore();
			store.chatSessionKey = 'agent:main:main';

			// 模拟 loadOlderMessages 拉回的服务端消息（含用户发送的消息）
			store.messages = [
				{ type: 'message', id: 'oc-0', message: { role: 'assistant', content: 'hi' } },
				{ type: 'message', id: 'oc-1', message: { role: 'user', content: '你好' } },
			];

			// 模拟 agentRunsStore 中仍有乐观 user 消息 + 流式 bot 消息
			const runsStore = useAgentRunsStore();
			const runId = 'run-1';
			const runKey = store.runKey;
			runsStore.runs[runId] = {
				runId,
				runKey,
				settled: false,
				settling: false,
				streamingMsgs: [
					{ type: 'message', id: '__local_user_123', _local: true, message: { role: 'user', content: '你好' } },
					{ type: 'message', id: '__local_bot_123', _local: true, _streaming: true, message: { role: 'assistant', content: '回复中…' } },
				],
			};
			runsStore.runKeyIndex[runKey] = runId;

			const all = store.allMessages;
			// 乐观 user 消息应被去重，只保留服务端版本 + 流式 bot 消息
			const userMsgs = all.filter((m) => m.message.role === 'user');
			expect(userMsgs).toHaveLength(1);
			expect(userMsgs[0].id).toBe('oc-1');
			// 流式 bot 消息保留
			expect(all.some((m) => m.id === '__local_bot_123')).toBe(true);
		});

		test('allMessages 无重复时保留全部 streamingMsgs', () => {
			const store = useChatStore();
			store.chatSessionKey = 'agent:main:main';

			store.messages = [
				{ type: 'message', id: 'oc-0', message: { role: 'assistant', content: 'hi' } },
			];

			const runsStore = useAgentRunsStore();
			const runId = 'run-2';
			const runKey = store.runKey;
			runsStore.runs[runId] = {
				runId,
				runKey,
				settled: false,
				settling: false,
				streamingMsgs: [
					{ type: 'message', id: '__local_user_456', _local: true, message: { role: 'user', content: '新消息' } },
					{ type: 'message', id: '__local_bot_456', _local: true, _streaming: true, message: { role: 'assistant', content: '' } },
				],
			};
			runsStore.runKeyIndex[runKey] = runId;

			const all = store.allMessages;
			expect(all).toHaveLength(3);
		});

		test('allMessages 对 block 数组内容也能正确去重', () => {
			const store = useChatStore();
			store.chatSessionKey = 'agent:main:main';

			const blockContent = [{ type: 'text', text: '带图消息' }, { type: 'image', data: 'abc' }];
			store.messages = [
				{ type: 'message', id: 'oc-0', message: { role: 'user', content: blockContent } },
			];

			const runsStore = useAgentRunsStore();
			const runId = 'run-3';
			const runKey = store.runKey;
			// streamingMsgs 中有相同内容的乐观版本（不同引用但相同结构）
			runsStore.runs[runId] = {
				runId,
				runKey,
				settled: false,
				settling: false,
				streamingMsgs: [
					{ type: 'message', id: '__local_user_789', _local: true, message: { role: 'user', content: [{ type: 'text', text: '带图消息' }, { type: 'image', data: 'abc' }] } },
					{ type: 'message', id: '__local_bot_789', _local: true, _streaming: true, message: { role: 'assistant', content: '' } },
				],
			};
			runsStore.runKeyIndex[runKey] = runId;

			const all = store.allMessages;
			const userMsgs = all.filter((m) => m.message.role === 'user');
			expect(userMsgs).toHaveLength(1);
			expect(userMsgs[0].id).toBe('oc-0');
		});
	});

	// =====================================================================
	// __resolveAgentId
	// =====================================================================

	describe('__resolveAgentId', () => {
		test('从 chatSessionKey 解析 agentId', () => {
			const store = useChatStore();
			store.chatSessionKey = 'agent:ops:main';

			expect(store.__resolveAgentId()).toBe('ops');
		});

		test('chatSessionKey 为 agent:main:main 时返回 main', () => {
			const store = useChatStore();
			store.chatSessionKey = 'agent:main:main';

			expect(store.__resolveAgentId()).toBe('main');
		});

		test('chatSessionKey 为空时返回 main', () => {
			const store = useChatStore();
			store.chatSessionKey = '';

			expect(store.__resolveAgentId()).toBe('main');
		});

		test('topic 模式下返回 topicAgentId', () => {
			const store = useChatStore();
			store.topicMode = true;
			store.topicAgentId = 'research';

			expect(store.__resolveAgentId()).toBe('research');
		});

		test('topic 模式下 topicAgentId 为空时返回 main', () => {
			const store = useChatStore();
			store.topicMode = true;
			store.topicAgentId = '';

			expect(store.__resolveAgentId()).toBe('main');
		});

		test('复杂 chatSessionKey 格式正确解析', () => {
			const store = useChatStore();
			store.chatSessionKey = 'agent:research:session-research-abc';

			expect(store.__resolveAgentId()).toBe('research');
		});
	});

	// =====================================================================
	// __loadChatHistory
	// =====================================================================

	describe('__loadChatHistory', () => {
		test('加载孤儿 session 列表并设置 historySessionIds', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const historyItems = [
				{ sessionId: 'hist-1', archivedAt: 100 },
				{ sessionId: 'hist-2', archivedAt: 200 },
			];
			const conn = mockConn();
			conn.request.mockImplementation((method) => {
				if (method === 'coclaw.chatHistory.list') {
					return Promise.resolve({ history: historyItems });
				}
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';

			await store.__loadChatHistory();

			expect(store.historySessionIds).toEqual(historyItems);
			expect(store.historyExhausted).toBe(false);
			expect(store.__historyLoadedCount).toBe(0);
		});

		test('历史列表为空时设置 historyExhausted 为 true', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockResolvedValue({ history: [] });
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';

			await store.__loadChatHistory();

			expect(store.historySessionIds).toEqual([]);
			expect(store.historyExhausted).toBe(true);
		});

		test('topic 模式下跳过', async () => {
			const conn = mockConn();
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.botId = '1';
			store.topicMode = true;
			store.chatSessionKey = 'agent:main:main';

			await store.__loadChatHistory();

			expect(conn.request).not.toHaveBeenCalled();
		});

		test('chatSessionKey 为空时跳过', async () => {
			const conn = mockConn();
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.botId = '1';
			store.chatSessionKey = '';

			await store.__loadChatHistory();

			expect(conn.request).not.toHaveBeenCalled();
		});

		test('请求失败时设置 historyExhausted 为 true', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockRejectedValue(new Error('rpc failed'));
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';

			await store.__loadChatHistory();

			expect(store.historySessionIds).toEqual([]);
			expect(store.historyExhausted).toBe(true);
		});

		test('传递正确的 agentId 和 sessionKey', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockResolvedValue({ history: [] });
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.botId = '1';
			store.chatSessionKey = 'agent:ops:main';

			await store.__loadChatHistory();

			expect(conn.request).toHaveBeenCalledWith('coclaw.chatHistory.list', {
				agentId: 'ops',
				sessionKey: 'agent:ops:main',
			});
		});
	});

	// =====================================================================
	// loadNextHistorySession
	// =====================================================================

	describe('loadNextHistorySession', () => {
		test('加载下一个历史 session 并 prepend 到 historySegments', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const histMsgs = [
				{ id: 'hm1', type: 'message', message: { role: 'user', content: 'old msg' } },
			];
			const conn = mockConn();
			conn.request.mockImplementation((method) => {
				if (method === 'coclaw.sessions.getById') {
					return Promise.resolve({ messages: histMsgs });
				}
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.historySessionIds = [
				{ sessionId: 'hist-1', archivedAt: 200 },
				{ sessionId: 'hist-2', archivedAt: 100 },
			];

			const ok = await store.loadNextHistorySession();
			expect(ok).toBe(true);
			expect(store.historySegments).toHaveLength(1);
			expect(store.historySegments[0].sessionId).toBe('hist-1');
			expect(store.historySegments[0].messages).toEqual(histMsgs);
			expect(store.__historyLoadedCount).toBe(1);
			expect(store.historyExhausted).toBe(false);
		});

		test('加载全部后设置 historyExhausted 为 true', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockResolvedValue({ messages: [] });
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.historySessionIds = [
				{ sessionId: 'hist-1', archivedAt: 100 },
			];

			await store.loadNextHistorySession();
			expect(store.historyExhausted).toBe(true);
		});

		test('已 exhausted 时返回 false', async () => {
			const store = useChatStore();
			store.historyExhausted = true;

			const ok = await store.loadNextHistorySession();
			expect(ok).toBe(false);
		});

		test('historyLoading 为 true 时返回 false（防重入）', async () => {
			const store = useChatStore();
			store.historyLoading = true;

			const ok = await store.loadNextHistorySession();
			expect(ok).toBe(false);
		});

		test('topic 模式下返回 false', async () => {
			const store = useChatStore();
			store.topicMode = true;

			const ok = await store.loadNextHistorySession();
			expect(ok).toBe(false);
		});

		test('无更多 session 时设置 historyExhausted（消息已加载）', async () => {
			const store = useChatStore();
			store.historySessionIds = [];
			store.__messagesLoaded = true;

			const ok = await store.loadNextHistorySession();
			expect(ok).toBe(false);
			expect(store.historyExhausted).toBe(true);
		});

		test('多次调用按顺序 prepend', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			let callIdx = 0;
			const conn = mockConn();
			conn.request.mockImplementation((method) => {
				if (method === 'coclaw.sessions.getById') {
					callIdx++;
					return Promise.resolve({ messages: [{ id: `msg-${callIdx}` }] });
				}
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.historySessionIds = [
				{ sessionId: 'hist-1', archivedAt: 200 },
				{ sessionId: 'hist-2', archivedAt: 100 },
			];

			await store.loadNextHistorySession();
			await store.loadNextHistorySession();

			expect(store.historySegments).toHaveLength(2);
			// 第二次加载的更旧 session prepend 到前面
			expect(store.historySegments[0].sessionId).toBe('hist-2');
			expect(store.historySegments[1].sessionId).toBe('hist-1');
			expect(store.historyExhausted).toBe(true);
		});

		test('请求失败时返回 false，跳过该 session 并恢复 historyLoading', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockRejectedValue(new Error('load failed'));
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.historySessionIds = [
				{ sessionId: 'hist-1', archivedAt: 200 },
				{ sessionId: 'hist-2', archivedAt: 100 },
			];

			const ok = await store.loadNextHistorySession();
			expect(ok).toBe(false);
			expect(store.historyLoading).toBe(false);
			// 失败的 session 被跳过，下次加载 hist-2
			expect(store.__historyLoadedCount).toBe(1);
			expect(store.historyExhausted).toBe(false);
		});

		test('唯一的历史 session 请求失败时设置 historyExhausted', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockRejectedValue(new Error('load failed'));
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.historySessionIds = [{ sessionId: 'hist-1', archivedAt: 100 }];

			const ok = await store.loadNextHistorySession();
			expect(ok).toBe(false);
			expect(store.__historyLoadedCount).toBe(1);
			expect(store.historyExhausted).toBe(true);
		});

		test('消息未加载完成时空 historySessionIds 不设 exhausted', async () => {
			const store = useChatStore();
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';
			// __messagesLoaded 默认 false，historySessionIds 默认 []
			expect(store.__messagesLoaded).toBe(false);
			expect(store.historySessionIds).toEqual([]);

			const ok = await store.loadNextHistorySession();
			expect(ok).toBe(false);
			expect(store.historyExhausted).toBe(false); // 不应被置 true
		});

		test('消息已加载后空 historySessionIds 正常设 exhausted', async () => {
			const store = useChatStore();
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.__messagesLoaded = true;
			store.historySessionIds = [];

			const ok = await store.loadNextHistorySession();
			expect(ok).toBe(false);
			expect(store.historyExhausted).toBe(true);
		});
	});

	// =====================================================================
	// __reconcileMessages
	// =====================================================================

	describe('__reconcileMessages', () => {
		test('session 模式下调用 loadMessages', async () => {
			const conn = mockConn();
			conn.request.mockImplementation((method) => {
				if (method === 'sessions.get') return Promise.resolve({ messages: [{ role: 'user', content: 'reconciled' }] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'cur' });
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';

			const result = await store.__reconcileMessages();
			expect(result).toBe(true);
			expect(store.messages).toHaveLength(1);
			expect(store.messages[0]).toMatchObject({
				type: 'message',
				id: 'oc-0',
				message: { role: 'user', content: 'reconciled' },
			});
		});

		test('topic 模式下调用 loadMessages', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method) => {
				if (method === 'coclaw.sessions.getById') {
					return Promise.resolve({ messages: [{ id: 't1', type: 'message', message: { role: 'user', content: 'topic' } }] });
				}
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'topic-1';
			store.botId = '1';
			store.topicMode = true;
			store.topicAgentId = 'main';

			const result = await store.__reconcileMessages();
			expect(result).toBe(true);
		});

		test('连接不存在时返回 false', async () => {
			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '999';

			const result = await store.__reconcileMessages();
			expect(result).toBe(false);
		});
	});

	// =====================================================================
	// sendSlashCommand
	// =====================================================================

	describe('sendSlashCommand', () => {
		/** @type {ReturnType<typeof useChatStore>} */
		let store;
		let conn;

		beforeEach(() => {
			store = useChatStore();
			conn = mockConn();
			mockConnections.set('1', conn);
			store.botId = '1';
			store.sessionId = 'sess-1';
			store.chatSessionKey = 'agent:main:main';
			conn.request.mockResolvedValue({ runId: 'test-run', status: 'started' });
		});

		test('发送 chat.send RPC 并设置状态', async () => {
			const p = store.sendSlashCommand('/help');
			expect(store.sending).toBe(true);
			expect(store.__slashCommandRunId).toBeTruthy();
			expect(store.__slashCommandType).toBe('/help');

			// 乐观追加 user message
			expect(store.messages.length).toBe(1);
			expect(store.messages[0].message.role).toBe('user');
			expect(store.messages[0].message.content).toBe('/help');

			// 验证注册了 event:chat 监听
			expect(conn.on).toHaveBeenCalledWith('event:chat', expect.any(Function));

			// 验证 chat.send RPC 调用
			expect(conn.request).toHaveBeenCalledWith('chat.send', {
				sessionKey: 'agent:main:main',
				message: '/help',
				idempotencyKey: expect.any(String),
			});

			// 模拟 event:chat final
			const handler = conn.on.mock.calls.find((c) => c[0] === 'event:chat')[1];
			handler({
				runId: store.__slashCommandRunId,
				state: 'final',
				message: { role: 'assistant', content: [{ type: 'text', text: 'help text' }] },
			});

			await p;
			expect(store.sending).toBe(false);
			// user message + 追加的 assistant message
			expect(store.messages.length).toBe(2);
			expect(store.messages[1].message.content[0].text).toBe('help text');
		});

		test('sending 为 true 时不发送', async () => {
			store.sending = true;
			await store.sendSlashCommand('/help');
			expect(conn.request).not.toHaveBeenCalled();
		});

		test('连接未就绪时不发送', async () => {
			conn.state = 'connecting';
			await store.sendSlashCommand('/help');
			expect(conn.request).not.toHaveBeenCalled();
		});

		test('/compact 完成后调用 loadMessages', async () => {
			setupConnForLoad(conn, { flatMessages: [], currentSessionId: 'sess-1' });
			// 让 chat.send 返回正常
			const origImpl = conn.request.getMockImplementation();
			conn.request.mockImplementation((method, ...args) => {
				if (method === 'chat.send') return Promise.resolve({ runId: 'r', status: 'started' });
				return origImpl(method, ...args);
			});

			const p = store.sendSlashCommand('/compact');
			const handler = conn.on.mock.calls.find((c) => c[0] === 'event:chat')[1];
			handler({ runId: store.__slashCommandRunId, state: 'final' });
			await p;

			// loadMessages 被调用（通过 sessions.get 请求判断）
			expect(conn.request).toHaveBeenCalledWith('sessions.get', expect.any(Object));
		});

		test('/new 完成后调用 loadMessages 并更新 currentSessionId', async () => {
			setupConnForLoad(conn, { flatMessages: [], currentSessionId: 'new-sess' });
			const origImpl = conn.request.getMockImplementation();
			conn.request.mockImplementation((method, ...args) => {
				if (method === 'chat.send') return Promise.resolve({ runId: 'r', status: 'started' });
				return origImpl(method, ...args);
			});

			const p = store.sendSlashCommand('/new');
			const handler = conn.on.mock.calls.find((c) => c[0] === 'event:chat')[1];
			handler({ runId: store.__slashCommandRunId, state: 'final' });
			await p;

			expect(conn.request).toHaveBeenCalledWith('sessions.get', expect.any(Object));
			// loadMessages 通过 chat.history 获取新 sessionId
			expect(store.currentSessionId).toBe('new-sess');
		});

		test('/new 后旧 session 被追加为 historySegment', async () => {
			// 预置旧消息
			store.currentSessionId = 'old-sess';
			store.messages = [
				{ type: 'message', id: 'msg-1', message: { role: 'user', content: 'hello' } },
				{ type: 'message', id: 'msg-2', message: { role: 'assistant', content: 'hi' } },
			];

			setupConnForLoad(conn, { flatMessages: [], currentSessionId: 'new-sess' });
			const origImpl = conn.request.getMockImplementation();
			conn.request.mockImplementation((method, ...args) => {
				if (method === 'chat.send') return Promise.resolve({ runId: 'r', status: 'started' });
				return origImpl(method, ...args);
			});

			const p = store.sendSlashCommand('/new');
			const handler = conn.on.mock.calls.find((c) => c[0] === 'event:chat')[1];
			handler({ runId: store.__slashCommandRunId, state: 'final' });
			await p;

			expect(store.historySegments).toHaveLength(1);
			expect(store.historySegments[0].sessionId).toBe('old-sess');
			expect(store.historySegments[0].messages).toHaveLength(2);
			expect(store.historySegments[0].archivedAt).toBeGreaterThan(0);
		});

		test('/new 后 currentSessionId 未变化时不创建 segment', async () => {
			store.currentSessionId = 'same-sess';
			store.messages = [
				{ type: 'message', id: 'msg-1', message: { role: 'user', content: 'hello' } },
			];

			// loadMessages 返回相同的 sessionId
			setupConnForLoad(conn, { flatMessages: [], currentSessionId: 'same-sess' });
			const origImpl = conn.request.getMockImplementation();
			conn.request.mockImplementation((method, ...args) => {
				if (method === 'chat.send') return Promise.resolve({ runId: 'r', status: 'started' });
				return origImpl(method, ...args);
			});

			const p = store.sendSlashCommand('/new');
			const handler = conn.on.mock.calls.find((c) => c[0] === 'event:chat')[1];
			handler({ runId: store.__slashCommandRunId, state: 'final' });
			await p;

			expect(store.historySegments).toHaveLength(0);
		});

		test('/new 前 messages 为空时不创建 segment', async () => {
			store.currentSessionId = 'old-sess';
			store.messages = [];

			setupConnForLoad(conn, { flatMessages: [], currentSessionId: 'new-sess' });
			const origImpl = conn.request.getMockImplementation();
			conn.request.mockImplementation((method, ...args) => {
				if (method === 'chat.send') return Promise.resolve({ runId: 'r', status: 'started' });
				return origImpl(method, ...args);
			});

			const p = store.sendSlashCommand('/new');
			const handler = conn.on.mock.calls.find((c) => c[0] === 'event:chat')[1];
			handler({ runId: store.__slashCommandRunId, state: 'final' });
			await p;

			expect(store.historySegments).toHaveLength(0);
		});

		test('连续两次 /new 不会重复创建同一 segment', async () => {
			// 第一次 /new
			store.currentSessionId = 'sess-A';
			store.messages = [
				{ type: 'message', id: 'msg-1', message: { role: 'user', content: 'hello' } },
			];

			setupConnForLoad(conn, { flatMessages: [], currentSessionId: 'sess-B' });
			let origImpl = conn.request.getMockImplementation();
			conn.request.mockImplementation((method, ...args) => {
				if (method === 'chat.send') return Promise.resolve({ runId: 'r1', status: 'started' });
				return origImpl(method, ...args);
			});

			let p = store.sendSlashCommand('/new');
			let handler = conn.on.mock.calls.find((c) => c[0] === 'event:chat')[1];
			handler({ runId: store.__slashCommandRunId, state: 'final' });
			await p;

			expect(store.historySegments).toHaveLength(1);
			expect(store.historySegments[0].sessionId).toBe('sess-A');

			// 第二次 /new
			store.messages = [
				{ type: 'message', id: 'msg-2', message: { role: 'user', content: 'world' } },
			];
			conn.on.mockClear();
			setupConnForLoad(conn, { flatMessages: [], currentSessionId: 'sess-C' });
			origImpl = conn.request.getMockImplementation();
			conn.request.mockImplementation((method, ...args) => {
				if (method === 'chat.send') return Promise.resolve({ runId: 'r2', status: 'started' });
				return origImpl(method, ...args);
			});

			p = store.sendSlashCommand('/new');
			handler = conn.on.mock.calls.find((c) => c[0] === 'event:chat')[1];
			handler({ runId: store.__slashCommandRunId, state: 'final' });
			await p;

			expect(store.historySegments).toHaveLength(2);
			expect(store.historySegments[0].sessionId).toBe('sess-A');
			expect(store.historySegments[1].sessionId).toBe('sess-B');
		});

		test('/new 过滤 _local 消息后为空时不创建 segment', async () => {
			store.currentSessionId = 'old-sess';
			// 只有乐观消息
			store.messages = [
				{ type: 'message', id: '__local_user_1', _local: true, message: { role: 'user', content: '/new' } },
			];

			setupConnForLoad(conn, { flatMessages: [], currentSessionId: 'new-sess' });
			const origImpl = conn.request.getMockImplementation();
			conn.request.mockImplementation((method, ...args) => {
				if (method === 'chat.send') return Promise.resolve({ runId: 'r', status: 'started' });
				return origImpl(method, ...args);
			});

			const p = store.sendSlashCommand('/new');
			const handler = conn.on.mock.calls.find((c) => c[0] === 'event:chat')[1];
			handler({ runId: store.__slashCommandRunId, state: 'final' });
			await p;

			expect(store.historySegments).toHaveLength(0);
		});

		test('event:chat error reject 并清理状态和乐观消息', async () => {
			const p = store.sendSlashCommand('/compact');
			expect(store.messages.length).toBe(1); // 乐观 user message
			const handler = conn.on.mock.calls.find((c) => c[0] === 'event:chat')[1];
			handler({ runId: store.__slashCommandRunId, state: 'error', errorMessage: 'fail' });

			await expect(p).rejects.toThrow('fail');
			expect(store.sending).toBe(false);
			expect(store.__slashCommandRunId).toBeNull();
			expect(store.messages.length).toBe(0); // 乐观消息已清理
		});

		test('RPC 异常时清理并抛出', async () => {
			conn.request.mockRejectedValue(new Error('network error'));
			await expect(store.sendSlashCommand('/help')).rejects.toThrow('network error');
			expect(store.sending).toBe(false);
			expect(store.__slashCommandRunId).toBeNull();
			expect(store.messages.length).toBe(0); // 乐观消息已清理
		});

		test('超时 reject 并清理状态和乐观消息', async () => {
			vi.useFakeTimers();
			const p = store.sendSlashCommand('/help');
			expect(store.sending).toBe(true);
			expect(store.messages.length).toBe(1); // 乐观 user message

			vi.advanceTimersByTime(30_000);
			expect(store.sending).toBe(false);
			expect(store.__slashCommandRunId).toBeNull();
			expect(store.messages.length).toBe(0); // 乐观消息已清理

			await expect(p).rejects.toThrow('slash command timeout');
		});

		test('cleanup 清理斜杠命令状态', () => {
			store.__slashCommandRunId = 'run-1';
			store.__slashCommandType = '/help';
			store.__slashCommandTimer = setTimeout(() => {}, 99999);
			store.__chatEventHandler = () => {};
			store.sending = true;

			store.cleanup();

			expect(store.__slashCommandRunId).toBeNull();
			expect(store.__slashCommandType).toBeNull();
			expect(store.__chatEventHandler).toBeNull();
			expect(store.sending).toBe(false);
		});

		test('忽略不匹配的 runId 事件', async () => {
			const p = store.sendSlashCommand('/help');
			const handler = conn.on.mock.calls.find((c) => c[0] === 'event:chat')[1];

			// 不匹配的 runId → 应忽略
			handler({ runId: 'other-run', state: 'final', message: { role: 'assistant', content: 'x' } });
			expect(store.sending).toBe(true); // 仍在发送中

			// 匹配的 runId → 应处理
			handler({ runId: store.__slashCommandRunId, state: 'final' });
			await p;
			expect(store.sending).toBe(false);
		});

		test('__reconcileSlashCommand 清理挂起的 slash command 并 resolve', async () => {
			const p = store.sendSlashCommand('/compact');
			expect(store.sending).toBe(true);
			expect(store.__slashCommandRunId).toBeTruthy();
			expect(store.messages.length).toBe(1); // 乐观 user message

			// 模拟 WS 重连：reconcile 应 settle 挂起的 command
			store.__reconcileSlashCommand();

			await p; // 应 resolve，不 reject
			expect(store.sending).toBe(false);
			expect(store.__slashCommandRunId).toBeNull();
			expect(store.messages.length).toBe(0); // 乐观消息已移除
		});

		test('__reconcileSlashCommand 无挂起命令时为 no-op', () => {
			expect(store.__slashCommandRunId).toBeNull();
			store.__reconcileSlashCommand(); // 不应抛错
			expect(store.sending).toBe(false);
		});
	});

	// =====================================================================
	// 渐进式消息加载（loadMessages limit + loadOlderMessages）
	// =====================================================================

	describe('progressive message loading', () => {
		test('loadMessages 默认 limit 为 50', async () => {
			const conn = mockConn();
			setupConnForLoad(conn, { flatMessages: [] });
			mockConnections.set('1', conn);

			const store = createChatStore('session:1:main', { botId: '1', agentId: 'main' });
			await store.activate();

			const sessCall = conn.request.mock.calls.find((c) => c[0] === 'sessions.get');
			expect(sessCall).toBeTruthy();
			expect(sessCall[1]).toMatchObject({ limit: 50 });
		});

		test('loadMessages: 返回数 < limit 时 hasMoreMessages=false', async () => {
			const conn = mockConn();
			const msgs = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `msg-${i}` }));
			setupConnForLoad(conn, { flatMessages: msgs });
			mockConnections.set('1', conn);

			const store = createChatStore('session:1:main', { botId: '1', agentId: 'main' });
			await store.activate();

			expect(store.messages).toHaveLength(10);
			expect(store.hasMoreMessages).toBe(false);
		});

		test('loadMessages: 返回数 >= limit 时 hasMoreMessages=true', async () => {
			const conn = mockConn();
			const msgs = Array.from({ length: 50 }, (_, i) => ({ role: 'user', content: `msg-${i}` }));
			setupConnForLoad(conn, { flatMessages: msgs });
			mockConnections.set('1', conn);

			const store = createChatStore('session:1:main', { botId: '1', agentId: 'main' });
			await store.activate();

			expect(store.messages).toHaveLength(50);
			expect(store.hasMoreMessages).toBe(true);
		});

		test('loadOlderMessages 增大 limit 向前加载并 prepend 到列表', async () => {
			const conn = mockConn();
			const initialMsgs = Array.from({ length: 50 }, (_, i) => ({ role: 'user', content: `msg-${i + 50}` }));
			setupConnForLoad(conn, { flatMessages: initialMsgs });
			mockConnections.set('1', conn);

			const store = createChatStore('session:1:main', { botId: '1', agentId: 'main' });
			await store.activate();
			expect(store.hasMoreMessages).toBe(true);
			expect(store.messages).toHaveLength(50);

			const olderMsgs = Array.from({ length: 100 }, (_, i) => ({ role: 'user', content: `msg-${i}` }));
			conn.request.mockImplementation((method) => {
				if (method === 'sessions.get') return Promise.resolve({ messages: olderMsgs });
				return Promise.resolve(null);
			});

			const loaded = await store.loadOlderMessages();
			expect(loaded).toBe(true);
			expect(store.messages).toHaveLength(100);
			const lastSessCall = conn.request.mock.calls.filter((c) => c[0] === 'sessions.get').pop();
			expect(lastSessCall[1]).toMatchObject({ limit: 100 });
		});

		test('loadOlderMessages: 返回不足 limit 时 hasMoreMessages 设为 false', async () => {
			const conn = mockConn();
			const initialMsgs = Array.from({ length: 50 }, (_, i) => ({ role: 'user', content: `msg-${i}` }));
			setupConnForLoad(conn, { flatMessages: initialMsgs });
			mockConnections.set('1', conn);

			const store = createChatStore('session:1:main', { botId: '1', agentId: 'main' });
			await store.activate();
			expect(store.hasMoreMessages).toBe(true);

			const allMsgs = Array.from({ length: 70 }, (_, i) => ({ role: 'user', content: `msg-${i}` }));
			conn.request.mockImplementation((method) => {
				if (method === 'sessions.get') return Promise.resolve({ messages: allMsgs });
				return Promise.resolve(null);
			});

			await store.loadOlderMessages();
			expect(store.hasMoreMessages).toBe(false);
			expect(store.messages).toHaveLength(70);
		});

		test('loadOlderMessages: hasMoreMessages=false 时不触发', async () => {
			const conn = mockConn();
			const msgs = [{ role: 'user', content: 'hi' }];
			setupConnForLoad(conn, { flatMessages: msgs });
			mockConnections.set('1', conn);

			const store = createChatStore('session:1:main', { botId: '1', agentId: 'main' });
			await store.activate();
			expect(store.hasMoreMessages).toBe(false);

			const result = await store.loadOlderMessages();
			expect(result).toBe(false);
		});

		test('loadOlderMessages: 保留本地 streaming 消息', async () => {
			const conn = mockConn();
			const initialMsgs = Array.from({ length: 50 }, (_, i) => ({ role: 'user', content: `msg-${i}` }));
			setupConnForLoad(conn, { flatMessages: initialMsgs });
			mockConnections.set('1', conn);

			const store = createChatStore('session:1:main', { botId: '1', agentId: 'main' });
			await store.activate();

			store.messages = [
				...store.messages,
				{ type: 'message', id: '__local_bot_1', _local: true, _streaming: true, message: { role: 'assistant', content: 'thinking...' } },
			];

			const olderMsgs = Array.from({ length: 80 }, (_, i) => ({ role: 'user', content: `msg-${i}` }));
			conn.request.mockImplementation((method) => {
				if (method === 'sessions.get') return Promise.resolve({ messages: olderMsgs });
				return Promise.resolve(null);
			});

			await store.loadOlderMessages();
			expect(store.messages).toHaveLength(81);
			const localMsg = store.messages.find((m) => m._local);
			expect(localMsg).toBeTruthy();
			expect(localMsg.id).toBe('__local_bot_1');
		});

		test('loadOlderMessages: 用户乐观消息（_local && !_streaming）不重复', async () => {
			const conn = mockConn();
			const initialMsgs = Array.from({ length: 50 }, (_, i) => ({ role: 'user', content: `msg-${i}` }));
			setupConnForLoad(conn, { flatMessages: initialMsgs });
			mockConnections.set('1', conn);

			const store = createChatStore('session:1:main', { botId: '1', agentId: 'main' });
			await store.activate();

			// 模拟用户发送后的乐观消息（_local=true, _streaming 未设置）
			store.messages = [
				...store.messages,
				{ type: 'message', id: '__local_user_1', _local: true, message: { role: 'user', content: 'hello' } },
			];

			// 服务端返回更多消息，其中已包含用户消息
			const olderMsgs = Array.from({ length: 80 }, (_, i) => ({ role: 'user', content: `msg-${i}` }));
			conn.request.mockImplementation((method) => {
				if (method === 'sessions.get') return Promise.resolve({ messages: olderMsgs });
				return Promise.resolve(null);
			});

			await store.loadOlderMessages();
			// 用户乐观消息不应被保留，只有服务端返回的 80 条
			expect(store.messages).toHaveLength(80);
			const localMsg = store.messages.find((m) => m._local);
			expect(localMsg).toBeFalsy();
		});

		test('loadOlderMessages: topic 模式下不触发', async () => {
			const conn = mockConn();
			conn.request.mockImplementation((method) => {
				if (method === 'coclaw.sessions.getById') return Promise.resolve({ messages: [{ role: 'user', content: 'hi' }] });
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = createChatStore('topic:topic-1', { botId: '1', agentId: 'main' });
			await store.activate();

			const result = await store.loadOlderMessages();
			expect(result).toBe(false);
		});

		test('loadOlderMessages: 并发防护', async () => {
			const conn = mockConn();
			const initialMsgs = Array.from({ length: 50 }, (_, i) => ({ role: 'user', content: `msg-${i}` }));
			setupConnForLoad(conn, { flatMessages: initialMsgs });
			mockConnections.set('1', conn);

			const store = createChatStore('session:1:main', { botId: '1', agentId: 'main' });
			await store.activate();

			let resolveRequest;
			conn.request.mockImplementation((method) => {
				if (method === 'sessions.get') {
					return new Promise((resolve) => { resolveRequest = resolve; });
				}
				return Promise.resolve(null);
			});

			const p1 = store.loadOlderMessages();
			const p2 = store.loadOlderMessages();

			expect(store.messagesLoading).toBe(true);
			expect(await p2).toBe(false);

			const allMsgs = Array.from({ length: 100 }, (_, i) => ({ role: 'user', content: `msg-${i}` }));
			resolveRequest({ messages: allMsgs });
			expect(await p1).toBe(true);
			expect(store.messagesLoading).toBe(false);
		});

		test('不同 store 实例有独立的分页状态', async () => {
			const conn = mockConn();
			const msgs = Array.from({ length: 50 }, (_, i) => ({ role: 'user', content: `msg-${i}` }));
			setupConnForLoad(conn, { flatMessages: msgs });
			mockConnections.set('1', conn);

			const store1 = createChatStore('session:1:main', { botId: '1', agentId: 'main' });
			await store1.activate();
			expect(store1.hasMoreMessages).toBe(true);

			// 另一个 store（空消息）
			setupConnForLoad(conn, { flatMessages: [] });
			const store2 = createChatStore('session:1:ops', { botId: '1', agentId: 'ops' });
			await store2.activate();

			expect(store2.hasMoreMessages).toBe(false);
			// store1 不受影响
			expect(store1.hasMoreMessages).toBe(true);
		});
	});

	// =====================================================================
	// activate 简化（连接监听已移至 botsStore 响应式桥接）
	// =====================================================================

	describe('activate 简化', () => {
		test('连接未就绪时 activate 标记 loading 并等待 connReady 驱动', async () => {
			const conn = mockConn({ state: 'connecting' });
			mockConnections.set('1', conn);

			const store = createChatStore('session:1:main', { botId: '1', agentId: 'main' });
			await store.activate();

			expect(store.__initialized).toBe(true);
			expect(store.loading).toBe(true);
			expect(store.messages).toHaveLength(0);
			// chatStore 不再注册 conn.on('state')
			const stateCalls = conn.on.mock.calls.filter((c) => c[0] === 'state');
			expect(stateCalls).toHaveLength(0);
		});

		test('连接就绪时 activate 直接加载消息', async () => {
			const conn = mockConn();
			setupConnForLoad(conn, {
				flatMessages: [{ role: 'user', content: 'hello' }],
			});
			mockConnections.set('1', conn);

			const store = createChatStore('session:1:main', { botId: '1', agentId: 'main' });
			await store.activate();

			expect(store.__initialized).toBe(true);
			expect(store.__messagesLoaded).toBe(true);
			expect(store.messages).toHaveLength(1);
		});

		test('skipLoad 时 activate 不加载消息', async () => {
			const conn = mockConn();
			mockConnections.set('1', conn);

			const store = createChatStore('session:1:main', { botId: '1', agentId: 'main' });
			await store.activate({ skipLoad: true });

			expect(store.__initialized).toBe(true);
			expect(store.messages).toHaveLength(0);
			expect(conn.request).not.toHaveBeenCalled();
		});

		test('dispose 不再涉及 conn 监听清理', async () => {
			const conn = mockConn();
			setupConnForLoad(conn);
			mockConnections.set('1', conn);

			const store = createChatStore('session:1:main', { botId: '1', agentId: 'main' });
			await store.activate();
			store.dispose();

			// chatStore 不再管理 conn.on/off('state')
			const offStateCalls = conn.off.mock.calls.filter((c) => c[0] === 'state');
			expect(offStateCalls).toHaveLength(0);
		});
	});

	describe('飞行中守卫与 reconcile', () => {
		beforeEach(() => { vi.useFakeTimers(); });
		afterEach(() => { vi.useRealTimers(); });

		test('飞行中守卫：silent 模式下并发 loadMessages 不会发起多次请求', async () => {
			const conn = mockConn();
			let reqCount = 0;
			let resolveReq;
			conn.request.mockImplementation((method) => {
				if (method === 'sessions.get') {
					reqCount++;
					return new Promise((r) => { resolveReq = r; });
				}
				if (method === 'chat.history') {
					return Promise.resolve({ sessionId: 'cur' });
				}
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = createChatStore('session:1:main', { botId: '1', agentId: 'main' });
			store.__initialized = true;

			store.loadMessages({ silent: true });
			store.loadMessages({ silent: true });
			store.loadMessages({ silent: true });

			expect(reqCount).toBe(1);

			resolveReq({ messages: [] });
			await vi.advanceTimersByTimeAsync(0);

			store.loadMessages({ silent: true });
			expect(reqCount).toBe(2);
		});

		test('飞行中守卫：非 silent 模式下并发 loadMessages 不会发起多次请求', async () => {
			const conn = mockConn();
			let reqCount = 0;
			let resolveReq;
			conn.request.mockImplementation((method) => {
				if (method === 'sessions.get') {
					reqCount++;
					return new Promise((r) => { resolveReq = r; });
				}
				if (method === 'chat.history') {
					return Promise.resolve({ sessionId: 'cur' });
				}
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = createChatStore('session:1:main', { botId: '1', agentId: 'main' });
			store.__initialized = true;

			// 模拟 activate() + connReady watcher 同时触发非 silent loadMessages
			store.loadMessages();
			store.loadMessages();
			store.loadMessages();

			expect(reqCount).toBe(1);

			resolveReq({ messages: [] });
			await vi.advanceTimersByTimeAsync(0);

			// 首次 resolve 后 guard 清除，新调用应发起新请求
			store.loadMessages();
			expect(reqCount).toBe(2);
		});

		test('loadMessages 成功后调用 reconcileRunAfterLoad', async () => {
			const conn = mockConn();
			setupConnForLoad(conn, {
				flatMessages: [
					{ role: 'user', content: 'hi' },
					{ role: 'assistant', content: 'hello', stopReason: 'stop' },
				],
			});
			mockConnections.set('1', conn);

			const store = createChatStore('session:1:main', { botId: '1', agentId: 'main' });
			await store.activate();

			const runsStore = useAgentRunsStore();
			runsStore.register('run-zombie', {
				botId: '1',
				runKey: store.runKey,
				topicMode: false,
				conn,
				streamingMsgs: [],
			});
			expect(runsStore.isRunning(store.runKey)).toBe(true);

			await store.loadMessages({ silent: true });

			expect(runsStore.isRunning(store.runKey)).toBe(false);
		});
	});
});
