import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

import { useChatStore } from './chat.store.js';
import { useSessionsStore } from './sessions.store.js';
import { useBotsStore } from './bots.store.js';

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
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// =====================================================================
	// activateSession
	// =====================================================================

	describe('activateSession', () => {
		test('设置 sessionId 并加载消息', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);
			const sessionsStore = useSessionsStore();
			sessionsStore.setSessions([{ sessionId: 'sess-1', botId: '1' }]);

			const conn = mockConn();
			setupConnForLoad(conn, {
				flatMessages: [{ role: 'user', content: 'hi' }],
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			await store.activateSession('sess-1', { sessionKey: 'agent:main:main' });

			expect(store.sessionId).toBe('sess-1');
			expect(store.botId).toBe('1');
			expect(store.chatSessionKey).toBe('agent:main:main');
			expect(store.messages).toHaveLength(1);
			// wrapOcMessages 包装后的格式
			expect(store.messages[0]).toMatchObject({
				type: 'message',
				id: 'oc-0',
				message: { role: 'user', content: 'hi' },
			});
		});

		test('同一 sessionId 重复调用时跳过（不重新加载）', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);
			const sessionsStore = useSessionsStore();
			sessionsStore.setSessions([{ sessionId: 'sess-1', botId: '1' }]);

			const conn = mockConn();
			setupConnForLoad(conn);
			mockConnections.set('1', conn);

			const store = useChatStore();
			await store.activateSession('sess-1', { sessionKey: 'agent:main:main' });
			const callCount = conn.request.mock.calls.length;

			await store.activateSession('sess-1');
			expect(conn.request.mock.calls.length).toBe(callCount); // 未新增调用
		});

		test('切换 session 时清理前一 session 的 streaming 本地消息', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);
			const sessionsStore = useSessionsStore();
			sessionsStore.setSessions([
				{ sessionId: 'sess-1', botId: '1' },
				{ sessionId: 'sess-2', botId: '1' },
			]);

			const conn = mockConn();
			setupConnForLoad(conn);
			mockConnections.set('1', conn);

			const store = useChatStore();
			await store.activateSession('sess-1', { sessionKey: 'agent:main:main' });
			// 手动注入一条本地消息模拟 streaming
			store.messages = [{ id: '__local_bot_123', _local: true, _streaming: true, message: { role: 'assistant', content: '' } }];

			await store.activateSession('sess-2', { sessionKey: 'agent:main:main' });
			// 本地消息应已被清理
			expect(store.messages.some((m) => m._local)).toBe(false);
		});

		test('botId 无法解析时保持 loading 状态，不设 errorText', async () => {
			// bots 和 sessions 均为空 → 模拟页面刷新时数据未就绪
			const store = useChatStore();
			await store.activateSession('sess-1');

			expect(store.sessionId).toBe('sess-1');
			expect(store.botId).toBe('');
			expect(store.loading).toBe(true);
			expect(store.errorText).toBe('');
		});

		test('从已有 session 切换到空字符串时清空消息但不加载', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);
			const sessionsStore = useSessionsStore();
			sessionsStore.setSessions([{ sessionId: 'sess-1', botId: '1' }]);

			const conn = mockConn();
			setupConnForLoad(conn);
			mockConnections.set('1', conn);

			const store = useChatStore();
			// 先激活一个有效 session
			await store.activateSession('sess-1', { sessionKey: 'agent:main:main' });
			store.messages = [{ id: 'm1' }];

			// 切换到空字符串
			await store.activateSession('');
			expect(store.sessionId).toBe('');
			expect(store.messages).toHaveLength(0);
		});

		test('activateSession 设置 chatSessionKey 为传入的 sessionKey', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);
			const sessionsStore = useSessionsStore();
			sessionsStore.setSessions([{ sessionId: 'sess-1', botId: '1' }]);

			const conn = mockConn();
			setupConnForLoad(conn);
			mockConnections.set('1', conn);

			const store = useChatStore();
			await store.activateSession('sess-1', { sessionKey: 'agent:ops:main' });

			expect(store.chatSessionKey).toBe('agent:ops:main');
		});

		test('activateSession 不传 sessionKey 时 chatSessionKey 为空字符串', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);
			const sessionsStore = useSessionsStore();
			sessionsStore.setSessions([{ sessionId: 'sess-1', botId: '1' }]);

			const conn = mockConn();
			setupConnForLoad(conn);
			mockConnections.set('1', conn);

			const store = useChatStore();
			await store.activateSession('sess-1');

			expect(store.chatSessionKey).toBe('');
		});

		test('activateSession 重置历史状态', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);
			const sessionsStore = useSessionsStore();
			sessionsStore.setSessions([{ sessionId: 'sess-1', botId: '1' }]);

			const conn = mockConn();
			// 返回非空历史，这样 fire-and-forget 不会把 historyExhausted 设为 true
			setupConnForLoad(conn, { history: [{ sessionId: 'new-hist', archivedAt: 999 }] });
			mockConnections.set('1', conn);

			const store = useChatStore();
			// 预设历史状态
			store.historySessionIds = [{ sessionId: 'old', archivedAt: 1 }];
			store.historySegments = [{ sessionId: 'old', archivedAt: 1, messages: [] }];
			store.historyExhausted = true;
			store.__historyLoadedCount = 3;

			await store.activateSession('sess-1', { sessionKey: 'agent:main:main' });

			// activateSession 同步重置历史字段；fire-and-forget 加载新历史
			// 等 fire-and-forget 完成后 historySessionIds 为新值
			await vi.waitFor(() => {
				expect(store.historySessionIds).toHaveLength(1);
			});
			expect(store.historySessionIds[0].sessionId).toBe('new-hist');
			expect(store.historySegments).toEqual([]);
			expect(store.historyExhausted).toBe(false);
			expect(store.__historyLoadedCount).toBe(0);
		});

		test('activateSession 完成后 fire-and-forget 调用 __loadChatHistory', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);
			const sessionsStore = useSessionsStore();
			sessionsStore.setSessions([{ sessionId: 'sess-1', botId: '1' }]);

			const conn = mockConn();
			const historyItems = [
				{ sessionId: 'hist-1', archivedAt: 100 },
				{ sessionId: 'hist-2', archivedAt: 200 },
			];
			setupConnForLoad(conn, { history: historyItems });
			mockConnections.set('1', conn);

			const store = useChatStore();
			await store.activateSession('sess-1', { sessionKey: 'agent:main:main' });

			// 等待 fire-and-forget 完成
			await vi.waitFor(() => {
				expect(store.historySessionIds).toHaveLength(2);
			});
			expect(store.historyExhausted).toBe(false);
		});

		test('force 参数强制重新激活同一 session', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);
			const sessionsStore = useSessionsStore();
			sessionsStore.setSessions([{ sessionId: 'sess-1', botId: '1' }]);

			const conn = mockConn();
			setupConnForLoad(conn);
			mockConnections.set('1', conn);

			const store = useChatStore();
			await store.activateSession('sess-1', { sessionKey: 'agent:main:main' });
			const callCount = conn.request.mock.calls.length;

			await store.activateSession('sess-1', { force: true, sessionKey: 'agent:main:main' });
			expect(conn.request.mock.calls.length).toBeGreaterThan(callCount);
		});

		test('明确指定 botId 参数时使用该值', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }, { id: '2', online: true }]);
			const sessionsStore = useSessionsStore();
			sessionsStore.setSessions([{ sessionId: 'sess-1', botId: '1' }]);

			const conn = mockConn();
			setupConnForLoad(conn);
			mockConnections.set('2', conn);

			const store = useChatStore();
			await store.activateSession('sess-1', { botId: '2', sessionKey: 'agent:main:main' });

			expect(store.botId).toBe('2');
		});
	});

	// =====================================================================
	// activateTopic
	// =====================================================================

	describe('activateTopic', () => {
		test('设置 topicMode 和相关状态', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method) => {
				if (method === 'coclaw.sessions.getById') {
					return Promise.resolve({ messages: [{ id: 't1', type: 'message', message: { role: 'user', content: 'topic msg' } }] });
				}
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			await store.activateTopic('topic-1', { botId: '1', agentId: 'research' });

			expect(store.topicMode).toBe(true);
			expect(store.topicAgentId).toBe('research');
			expect(store.sessionId).toBe('topic-1');
			expect(store.chatSessionKey).toBe('');
			expect(store.historyExhausted).toBe(true);
		});

		test('同一 topic 重复调用时跳过', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockResolvedValue({ messages: [] });
			mockConnections.set('1', conn);

			const store = useChatStore();
			await store.activateTopic('topic-1', { botId: '1', agentId: 'main' });
			const callCount = conn.request.mock.calls.length;

			await store.activateTopic('topic-1', { botId: '1', agentId: 'main' });
			expect(conn.request.mock.calls.length).toBe(callCount);
		});

		test('skipLoad 为 true 时不加载消息', async () => {
			const conn = mockConn();
			mockConnections.set('1', conn);

			const store = useChatStore();
			await store.activateTopic('topic-1', { botId: '1', agentId: 'main', skipLoad: true });

			expect(store.topicMode).toBe(true);
			expect(store.loading).toBe(false);
			expect(conn.request).not.toHaveBeenCalled();
		});
	});

	// =====================================================================
	// loadMessages
	// =====================================================================

	describe('loadMessages', () => {
		test('调用 sessions.get 和 chat.history，设置 messages 和 currentSessionId', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);
			const sessionsStore = useSessionsStore();
			sessionsStore.setSessions([{ sessionId: 'sess-1', botId: '1' }]);

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

		test('sessionId 为空时返回 false 且清空消息', async () => {
			const store = useChatStore();
			store.messages = [{ id: 'old' }];

			const ok = await store.loadMessages();
			expect(ok).toBe(false);
			expect(store.messages).toHaveLength(0);
			expect(store.loading).toBe(false);
		});

		test('chatSessionKey 为空时返回 false 且清空消息', async () => {
			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.chatSessionKey = '';

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
			const sessionsStore = useSessionsStore();
			sessionsStore.setSessions([{ sessionId: 'sess-1', botId: '1' }]);

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
			const sessionsStore = useSessionsStore();
			sessionsStore.setSessions([{ sessionId: 'sess-1', botId: '1' }]);

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
			store.sessionId = 'sess-1';
			store.botId = '999'; // 无连接

			await expect(store.sendMessage('hello')).rejects.toThrow('Bot not connected');
		});

		test('连接未就绪（非 connected 状态）时抛出错误', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn({ state: 'connecting' });
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';

			await expect(store.sendMessage('hello')).rejects.toThrow('Bot not connected');
		});

		test('sessionId 为空时返回 { accepted: false }', async () => {
			const store = useChatStore();
			// sessionId 默认为空字符串
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

		test('带图片文件时内容变为 blocks 数组', async () => {
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

		test('pre-acceptance 30s 超时：sending 置 false，__agentSettled 为 true，抛出 PRE_ACCEPTANCE_TIMEOUT', async () => {
			vi.useFakeTimers();
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			// 永不 resolve，也不调用 onAccepted
			conn.request.mockImplementation((method) => {
				if (method === 'agent') return new Promise(() => {});
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';

			const [, result] = await Promise.allSettled([
				vi.advanceTimersByTimeAsync(30_000),
				store.sendMessage('hello'),
			]);

			expect(result.status).toBe('rejected');
			expect(result.reason).toMatchObject({ code: 'PRE_ACCEPTANCE_TIMEOUT' });
			expect(store.sending).toBe(false);
			expect(store.__agentSettled).toBe(true);
		});

		test('post-acceptance 30min 超时：sending 置 false，抛出 POST_ACCEPTANCE_TIMEOUT', async () => {
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
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';

			const [, result] = await Promise.allSettled([
				vi.advanceTimersByTimeAsync(30 * 60_000),
				store.sendMessage('hello'),
			]);

			expect(result.status).toBe('rejected');
			expect(result.reason).toMatchObject({ code: 'POST_ACCEPTANCE_TIMEOUT' });
			expect(store.sending).toBe(false);
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

			expect(result.status).toBe('rejected');
			expect(result.reason.code).toBe('WS_CLOSED');
		});

		test('WS_CLOSED 重试本身再次失败时不二次重试，直接抛出', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

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

		test('conn.on 和 conn.off 以相同函数引用调用 "event:agent"', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-ref' });
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

			await store.sendMessage('hello');

			const onCalls = conn.on.mock.calls.filter((c) => c[0] === 'event:agent');
			const offCalls = conn.off.mock.calls.filter((c) => c[0] === 'event:agent');
			expect(onCalls).toHaveLength(1);
			expect(offCalls).toHaveLength(1);
			// 验证传入的函数引用相同
			expect(onCalls[0][1]).toBe(offCalls[0][1]);
		});
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
		test('清理 streaming 状态并将 sending 置为 false', () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);
			mockConnections.set('1', mockConn());

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.sending = true;
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

		test('accepted 之后取消：sendMessage 返回 { accepted: true }，不恢复输入', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-cancel' });
					return new Promise(() => {});
				}
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

			store.cancelSend();

			const result = await sendPromise;
			expect(result).toEqual({ accepted: true });
		});
	});

	// =====================================================================
	// cleanup
	// =====================================================================

	describe('cleanup', () => {
		test('重置全部状态', () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);
			mockConnections.set('1', mockConn());

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.messages = [{ id: 'm1' }];
			store.chatSessionKey = 'agent:main:main';
			store.currentSessionId = 'cur-1';
			store.errorText = 'some error';
			store.sending = true;
			store.resetting = true;
			store.historySessionIds = [{ sessionId: 'h1', archivedAt: 1 }];
			store.historySegments = [{ sessionId: 'h1', archivedAt: 1, messages: [] }];
			store.historyLoading = true;
			store.historyExhausted = true;
			store.__historyLoadedCount = 5;

			store.cleanup();

			expect(store.sessionId).toBe('');
			expect(store.botId).toBe('');
			expect(store.messages).toHaveLength(0);
			expect(store.chatSessionKey).toBe('');
			expect(store.currentSessionId).toBeNull();
			expect(store.errorText).toBe('');
			expect(store.sending).toBe(false);
			expect(store.resetting).toBe(false);
			expect(store.topicMode).toBe(false);
			expect(store.topicAgentId).toBe('');
			expect(store.historySessionIds).toEqual([]);
			expect(store.historySegments).toEqual([]);
			expect(store.historyLoading).toBe(false);
			expect(store.historyExhausted).toBe(false);
			expect(store.__historyLoadedCount).toBe(0);
		});
	});

	// =====================================================================
	// __onAgentEvent
	// =====================================================================

	describe('__onAgentEvent', () => {
		function setupStreamingStore() {
			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.streamingRunId = 'run-1';
			store.sending = true;
			store.chatSessionKey = 'agent:main:main';
			// 注入一条 streaming bot 条目
			store.messages = [
				{
					id: '__local_bot_1',
					_local: true,
					_streaming: true,
					_startTime: Date.now(),
					message: { role: 'assistant', content: '', stopReason: null },
				},
			];
			return store;
		}

		test('runId 不匹配时忽略事件', () => {
			const store = setupStreamingStore();

			store.__onAgentEvent({ runId: 'other-run', stream: 'assistant', data: { text: 'hello' } });
			expect(store.messages[0].message.content).toBe('');
		});

		test('assistant stream：更新 streaming bot 条目的文本内容', () => {
			const store = setupStreamingStore();

			store.__onAgentEvent({ runId: 'run-1', stream: 'assistant', data: { text: 'hello world' } });

			const entry = store.messages.find((m) => m._streaming && m.message.role === 'assistant');
			const textBlock = Array.isArray(entry.message.content)
				? entry.message.content.find((b) => b.type === 'text')
				: null;
			expect(textBlock?.text).toBe('hello world');
			expect(entry.message.stopReason).toBe('stop');
		});

		test('tool stream start：向 streaming bot 条目追加 toolCall', () => {
			const store = setupStreamingStore();

			store.__onAgentEvent({ runId: 'run-1', stream: 'tool', data: { phase: 'start', name: 'search' } });

			const entry = store.messages.find((m) => m._streaming && m.message.role === 'assistant');
			const content = entry.message.content;
			expect(Array.isArray(content)).toBe(true);
			expect(content.some((b) => b.type === 'toolCall' && b.name === 'search')).toBe(true);
			expect(entry.message.stopReason).toBe('toolUse');
		});

		test('tool stream result：追加 toolResult 和新 streaming bot 条目', () => {
			const store = setupStreamingStore();

			store.__onAgentEvent({
				runId: 'run-1',
				stream: 'tool',
				data: { phase: 'result', result: 'search result text' },
			});

			const toolResultEntry = store.messages.find((m) => m.message?.role === 'toolResult');
			expect(toolResultEntry).toBeTruthy();
			expect(toolResultEntry.message.content).toBe('search result text');

			// 新的 assistant streaming 条目
			const newBotEntry = store.messages[store.messages.length - 1];
			expect(newBotEntry._streaming).toBe(true);
			expect(newBotEntry.message.role).toBe('assistant');
		});

		test('tool stream result：result 为对象时序列化为 JSON', () => {
			const store = setupStreamingStore();

			store.__onAgentEvent({
				runId: 'run-1',
				stream: 'tool',
				data: { phase: 'result', result: { key: 'val' } },
			});

			const toolResultEntry = store.messages.find((m) => m.message?.role === 'toolResult');
			expect(toolResultEntry.message.content).toBe('{"key":"val"}');
		});

		test('tool stream result：data.result 被网关剥离时兜底为空字符串', () => {
			const store = setupStreamingStore();

			store.__onAgentEvent({
				runId: 'run-1',
				stream: 'tool',
				data: { phase: 'result' }, // 无 result 字段（verbose !== full）
			});

			const toolResultEntry = store.messages.find((m) => m.message?.role === 'toolResult');
			expect(toolResultEntry).toBeTruthy();
			expect(toolResultEntry.message.content).toBe('');

			const newBotEntry = store.messages[store.messages.length - 1];
			expect(newBotEntry._streaming).toBe(true);
			expect(newBotEntry.message.role).toBe('assistant');
		});

		test('thinking stream：追加 thinking block', () => {
			const store = setupStreamingStore();

			store.__onAgentEvent({ runId: 'run-1', stream: 'thinking', data: { text: '思考中...' } });

			const entry = store.messages.find((m) => m._streaming && m.message.role === 'assistant');
			const content = entry.message.content;
			expect(Array.isArray(content)).toBe(true);
			expect(content.some((b) => b.type === 'thinking' && b.thinking === '思考中...')).toBe(true);
		});

		test('thinking stream：更新已有 thinking block（不重复追加）', () => {
			const store = setupStreamingStore();
			// 先触发一次 thinking
			store.__onAgentEvent({ runId: 'run-1', stream: 'thinking', data: { text: '初始思考' } });
			// 再触发一次 thinking，应覆盖而非追加
			store.__onAgentEvent({ runId: 'run-1', stream: 'thinking', data: { text: '更新思考' } });

			const entry = store.messages.find((m) => m._streaming && m.message.role === 'assistant');
			const thinkingBlocks = entry.message.content.filter((b) => b.type === 'thinking');
			expect(thinkingBlocks).toHaveLength(1);
			expect(thinkingBlocks[0].thinking).toBe('更新思考');
		});

		test('lifecycle end：结算 agent，清理 streaming，sending 置 false', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);
			const conn = mockConn();
			conn.request.mockImplementation((method) => {
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'cur' });
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.streamingRunId = 'run-1';
			store.sending = true;
			store.chatSessionKey = 'agent:main:main';
			store.messages = [
				{ id: '__local_bot_1', _local: true, _streaming: true, message: { role: 'assistant', content: 'hi' } },
			];

			store.__onAgentEvent({ runId: 'run-1', stream: 'lifecycle', data: { phase: 'end' } });

			expect(store.__agentSettled).toBe(true);
			expect(store.sending).toBe(false);
			expect(store.streamingRunId).toBeNull();
		});

		test('lifecycle error：结算 agent，清理 streaming，sending 置 false', () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);
			const conn = mockConn();
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.streamingRunId = 'run-1';
			store.sending = true;
			store.chatSessionKey = 'agent:main:main';
			store.messages = [
				{ id: '__local_bot_1', _local: true, _streaming: true, message: { role: 'assistant', content: '' } },
			];

			store.__onAgentEvent({ runId: 'run-1', stream: 'lifecycle', data: { phase: 'error' } });

			expect(store.__agentSettled).toBe(true);
			expect(store.sending).toBe(false);
			// 本地 streaming 条目被清理
			expect(store.messages.some((m) => m._local)).toBe(false);
		});

		test('__reconcileMessages 连接不存在时返回 false', async () => {
			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '999'; // 无连接
			store.chatSessionKey = 'agent:main:main';
			store.streamingRunId = 'run-1';

			const result = await store.__reconcileMessages();
			expect(result).toBe(false);
		});

		test('__ensureContentArray：非空字符串 content 被转换为 text block 数组', () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);
			mockConnections.set('1', mockConn());

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.streamingRunId = 'run-1';
			store.sending = true;
			store.chatSessionKey = 'agent:main:main';
			// content 设为非空字符串
			store.messages = [
				{
					id: '__local_bot_1',
					_local: true,
					_streaming: true,
					_startTime: Date.now(),
					message: { role: 'assistant', content: 'initial', stopReason: null },
				},
			];

			// 触发 assistant stream 事件，__ensureContentArray 应把字符串转为数组
			store.__onAgentEvent({ runId: 'run-1', stream: 'assistant', data: { text: 'new text' } });

			const entry = store.messages.find((m) => m._streaming && m.message.role === 'assistant');
			expect(Array.isArray(entry.message.content)).toBe(true);
			const textBlock = entry.message.content.find((b) => b.type === 'text');
			expect(textBlock?.text).toBe('new text');
		});
	});

	// =====================================================================
	// __resolveBotId
	// =====================================================================

	describe('__resolveBotId', () => {
		test('从 sessions store 解析 botId', () => {
			const sessionsStore = useSessionsStore();
			sessionsStore.setSessions([{ sessionId: 'sess-1', botId: '42' }]);

			const store = useChatStore();
			const botId = store.__resolveBotId('sess-1');
			expect(botId).toBe('42');
		});

		test('session 无 botId 时回退到第一个 online bot', () => {
			const sessionsStore = useSessionsStore();
			sessionsStore.setSessions([{ sessionId: 'sess-1' }]); // 无 botId

			const botsStore = useBotsStore();
			botsStore.setBots([
				{ id: '10', online: false },
				{ id: '20', online: true },
			]);

			const store = useChatStore();
			const botId = store.__resolveBotId('sess-1');
			expect(botId).toBe('20');
		});

		test('无 online bot 时回退到第一个 bot', () => {
			const sessionsStore = useSessionsStore();
			sessionsStore.setSessions([{ sessionId: 'sess-1' }]);

			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '5', online: false }]);

			const store = useChatStore();
			const botId = store.__resolveBotId('sess-1');
			expect(botId).toBe('5');
		});

		test('sessionId 为空时返回空字符串', () => {
			const store = useChatStore();
			expect(store.__resolveBotId('')).toBe('');
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

		test('无更多 session 时设置 historyExhausted', async () => {
			const store = useChatStore();
			store.historySessionIds = [];

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
	});

	// =====================================================================
	// __reconcileMessages
	// =====================================================================

	describe('__reconcileMessages', () => {
		test('session 模式下调用 loadMessages + loadAllSessions', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method) => {
				if (method === 'sessions.get') return Promise.resolve({ messages: [{ role: 'user', content: 'reconciled' }] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'cur' });
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const sessionsStore = useSessionsStore();
			const loadAllSpy = vi.spyOn(sessionsStore, 'loadAllSessions').mockResolvedValue();

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.chatSessionKey = 'agent:main:main';

			const result = await store.__reconcileMessages();
			expect(result).toBe(true);
			expect(loadAllSpy).toHaveBeenCalled();
			// messages 应被 loadMessages 更新（wrapOcMessages 包装后）
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

		test('event:chat error reject 并清理状态', async () => {
			const p = store.sendSlashCommand('/compact');
			const handler = conn.on.mock.calls.find((c) => c[0] === 'event:chat')[1];
			handler({ runId: store.__slashCommandRunId, state: 'error', errorMessage: 'fail' });

			await expect(p).rejects.toThrow('fail');
			expect(store.sending).toBe(false);
			expect(store.__slashCommandRunId).toBeNull();
		});

		test('RPC 异常时清理并抛出', async () => {
			conn.request.mockRejectedValue(new Error('network error'));
			await expect(store.sendSlashCommand('/help')).rejects.toThrow('network error');
			expect(store.sending).toBe(false);
			expect(store.__slashCommandRunId).toBeNull();
		});

		test('超时 reject 并清理状态', async () => {
			vi.useFakeTimers();
			const p = store.sendSlashCommand('/help');
			expect(store.sending).toBe(true);

			vi.advanceTimersByTime(30_000);
			expect(store.sending).toBe(false);
			expect(store.__slashCommandRunId).toBeNull();

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
	});
});
