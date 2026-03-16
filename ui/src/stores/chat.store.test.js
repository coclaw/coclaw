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

// 构建一个标准的 listAll + get 响应
function setupConnForLoad(conn, { sessions = [], messages = [] } = {}) {
	conn.request.mockImplementation((method) => {
		if (method === 'nativeui.sessions.listAll') {
			return Promise.resolve({ items: sessions });
		}
		if (method === 'nativeui.sessions.get') {
			return Promise.resolve({ messages });
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
				sessions: [{ sessionId: 'sess-1', sessionKey: 'agent:main:main', indexed: true }],
				messages: [{ id: 'm1', type: 'message' }],
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			await store.activateSession('sess-1');

			expect(store.sessionId).toBe('sess-1');
			expect(store.botId).toBe('1');
			expect(store.messages).toHaveLength(1);
			expect(store.messages[0].id).toBe('m1');
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
			await store.activateSession('sess-1');
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
			await store.activateSession('sess-1');
			// 手动注入一条本地消息模拟 streaming
			store.messages = [{ id: '__local_bot_123', _local: true, _streaming: true, message: { role: 'assistant', content: '' } }];

			await store.activateSession('sess-2');
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
			await store.activateSession('sess-1');
			store.messages = [{ id: 'm1' }];

			// 切换到空字符串
			await store.activateSession('');
			expect(store.sessionId).toBe('');
			expect(store.messages).toHaveLength(0);
		});
	});

	// =====================================================================
	// loadMessages
	// =====================================================================

	describe('loadMessages', () => {
		test('调用 listAll 和 get，设置 messages 与 sessionKeyById', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);
			const sessionsStore = useSessionsStore();
			sessionsStore.setSessions([{ sessionId: 'sess-1', botId: '1' }]);

			const conn = mockConn();
			const sessionItems = [
				{ sessionId: 'sess-1', sessionKey: 'agent:main:main', indexed: true },
				{ sessionId: 'sess-2', sessionKey: 'agent:main:thread1', indexed: true },
			];
			const msgs = [{ id: 'msg1', type: 'message' }];
			setupConnForLoad(conn, { sessions: sessionItems, messages: msgs });
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';

			const ok = await store.loadMessages();
			expect(ok).toBe(true);
			expect(store.messages).toEqual(msgs);
			expect(store.sessionKeyById['sess-1']).toBe('agent:main:main');
			expect(store.sessionKeyById['sess-2']).toBe('agent:main:thread1');
		});

		test('sessionId 为空时返回 false 且清空消息', async () => {
			const store = useChatStore();
			store.messages = [{ id: 'old' }];

			const ok = await store.loadMessages();
			expect(ok).toBe(false);
			expect(store.messages).toHaveLength(0);
			expect(store.loading).toBe(false);
		});

		test('连接缺失时返回 false 并设置 errorText', async () => {
			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '999'; // 无对应连接

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
			setupConnForLoad(conn);
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';

			// 监视 loading 赋值
			let loadingWasTrue = false;
			// 使用间接观察方式：在 request 内检查 loading
			conn.request.mockImplementation((method) => {
				if (store.loading) loadingWasTrue = true;
				if (method === 'nativeui.sessions.listAll') return Promise.resolve({ items: [] });
				if (method === 'nativeui.sessions.get') return Promise.resolve({ messages: [] });
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

			const ok = await store.loadMessages();
			expect(ok).toBe(false);
			expect(store.errorText).toBe('network error');
			expect(store.loading).toBe(false);
		});

		test('silent 模式下连接缺失时不设置 errorText', async () => {
			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '999'; // 无对应连接
			store.errorText = '';

			const ok = await store.loadMessages({ silent: true });
			expect(ok).toBe(false);
			expect(store.errorText).toBe('');
		});

		test('indexed 为 false 的 session 不纳入 sessionKeyById', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);
			const sessionsStore = useSessionsStore();
			sessionsStore.setSessions([{ sessionId: 'sess-1', botId: '1' }]);

			const conn = mockConn();
			const sessionItems = [
				{ sessionId: 'sess-1', sessionKey: 'agent:main:main', indexed: true },
				{ sessionId: 'sess-hidden', sessionKey: 'agent:main:hidden', indexed: false },
			];
			setupConnForLoad(conn, { sessions: sessionItems });
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';

			await store.loadMessages();
			expect(store.sessionKeyById['sess-hidden']).toBeUndefined();
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
					// reconcile 时的 listAll
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'nativeui.sessions.listAll') return Promise.resolve({ items: [] });
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';

			const result = await store.sendMessage('hello world');
			expect(result.accepted).toBe(true);

			const agentCall = conn.request.mock.calls.find((c) => c[0] === 'agent');
			expect(agentCall).toBeTruthy();
			expect(agentCall[1].message).toBe('hello world');
			expect(agentCall[1].sessionId).toBe('sess-1');
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
				if (method === 'nativeui.sessions.listAll') return Promise.resolve({ items: [] });
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';

			await store.sendMessage('test');
			// onAccepted 调用期间 __accepted 和 streamingRunId 被设置
			// 发送完成后 streamingRunId 被清理（__cleanupTimersAndListeners 在 finally 中）
			expect(store.__accepted).toBe(true);
		});

		test('sessionKey 存在时 agentParams 使用 sessionKey 而非 sessionId', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'chat.history') {
					// 模拟无轮转（remoteId === sessionId）
					return Promise.resolve({ sessionId: 'sess-1' });
				}
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-1' });
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'nativeui.sessions.listAll') return Promise.resolve({ items: [] });
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.sessionKeyById = { 'sess-1': 'agent:main:main' };

			await store.sendMessage('hi');

			const agentCall = conn.request.mock.calls.find((c) => c[0] === 'agent');
			expect(agentCall[1].sessionKey).toBe('agent:main:main');
			expect(agentCall[1].sessionId).toBeUndefined();
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
				if (method === 'nativeui.sessions.listAll') return Promise.resolve({ items: [] });
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';

			const fakeFile = { type: 'image/png' };
			const files = [{ isImg: true, file: fakeFile, name: 'pic.png' }];
			await store.sendMessage('look at this', files);

			// 乐观 user 消息的 content 应该是数组
			// （消息在 reconcile 后被清理，但 reconcile 前检查 — 由于 reconcile 只更新 sessionKeyById，消息保持）
			// 检查 agent 请求中的 attachments
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

			// 同时推进时间并等待 promise，避免超时 rejection 在 await 前成为 unhandled
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

			// 同时推进时间并等待 promise，避免超时 rejection 在 await 前成为 unhandled
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
			// 模拟已在 catch 前由 lifecycle:end 事件置为 settled
			// 通过让 __agentSettled 在 onAccepted 后立即为 true 来触发该分支：
			// 实际上 onAccepted 设置 __accepted=true，而 WS_CLOSED 被 catch 捕获时
			// __agentSettled 需已为 true。我们在 request mock 里手动设置
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-ws' });
					// 模拟 lifecycle:end 事件提前处理：直接设置 settled
					const store2 = useChatStore();
					store2.__agentSettled = true;
					const err = new Error('ws closed');
					err.code = 'WS_CLOSED';
					return Promise.reject(err);
				}
				return Promise.resolve(null);
			});

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
						// 第一次：WS_CLOSED
						const err = new Error('connection closed');
						err.code = 'WS_CLOSED';
						return Promise.reject(err);
					}
					// 第二次（重试）：成功
					options?.onAccepted?.({ runId: 'run-retry' });
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'nativeui.sessions.listAll') return Promise.resolve({ items: [] });
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';

			// conn.state 已为 connected，重试逻辑会立即重发
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
			// 第一次调用时 state 为 connected，让 request 可以发出
			// 但 catch 中检查重连时 state 为 disconnected
			const connForSend = mockConn();
			connForSend.request = conn.request;
			connForSend.on = vi.fn();
			connForSend.off = vi.fn();

			// 模拟：发送时 connected，catch 中 getConnection 返回 disconnected 的 conn
			let firstGet = true;
			mockConnections.set('1', connForSend);
			const origGet = mockConnections.get.bind(mockConnections);
			mockConnections.get = (id) => {
				if (id === '1' && callCount > 0 && firstGet) {
					firstGet = false;
					// 切换为 disconnected conn，让重连等待逻辑生效
					conn.on = vi.fn();
					conn.off = vi.fn();
					return conn;
				}
				return origGet(id);
			};

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';

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
				if (method === 'nativeui.sessions.listAll') return Promise.resolve({ items: [] });
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';

			// conn.state 已为 connected，第一次重试会立即发起
			// 第二次因 __retried=true 不再重试，直接抛出
			await expect(store.sendMessage('hello')).rejects.toMatchObject({ code: 'WS_CLOSED' });
			expect(callCount).toBe(2); // 原始 + 重试各一次
		});

		test('WS_CLOSED 且已 accepted 时不抛出，等重连后 reconcile', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			// conn.state 已为 connected，等待重连时会立即 resolve
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					// 先 accepted，然后 WS 断连
					options?.onAccepted?.({ runId: 'run-acc' });
					const err = new Error('connection closed');
					err.code = 'WS_CLOSED';
					return Promise.reject(err);
				}
				// reconcile 请求
				if (method === 'nativeui.sessions.listAll') return Promise.resolve({ items: [] });
				if (method === 'nativeui.sessions.get') return Promise.resolve({ messages: [] });
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';

			// accepted 后 WS_CLOSED → 不抛出，优雅返回
			const result = await store.sendMessage('hello');
			expect(result).toEqual({ accepted: true });
			expect(store.sending).toBe(false);
		});

		test('!__accepted 且 status !== "ok" 时返回 { accepted: false } 并移除本地条目', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			// 不调用 onAccepted，直接 resolve 非 ok 状态
			conn.request.mockImplementation((method) => {
				if (method === 'agent') return Promise.resolve({ status: 'rejected' });
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';

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
				if (method === 'nativeui.sessions.listAll') return Promise.resolve({ items: [] });
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';

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
	// __detectRotation
	// =====================================================================

	describe('__detectRotation', () => {
		test('检测到轮转：清除 sessionKey，调用 loadAllSessions，agentParams 使用 sessionId', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'chat.history') {
					// 返回不同的 sessionId，触发轮转检测
					return Promise.resolve({ sessionId: 'sess-rotated' });
				}
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-1' });
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'nativeui.sessions.listAll') return Promise.resolve({ items: [] });
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const sessionsStore = useSessionsStore();
			const loadAllSpy = vi.spyOn(sessionsStore, 'loadAllSessions').mockResolvedValue();

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.sessionKeyById = { 'sess-1': 'agent:main:main' };

			await store.sendMessage('hello');

			// sessionKey 应已被清除
			expect(store.sessionKeyById['sess-1']).toBeUndefined();
			// loadAllSessions 应已被调用
			expect(loadAllSpy).toHaveBeenCalled();
			// agent 请求应使用 sessionId 而非 sessionKey
			const agentCall = conn.request.mock.calls.find((c) => c[0] === 'agent');
			expect(agentCall[1].sessionId).toBe('sess-1');
			expect(agentCall[1].sessionKey).toBeUndefined();
		});

		test('chat.history 请求失败时返回 false，不抛出，sendMessage 继续执行', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'chat.history') {
					return Promise.reject(new Error('history fetch failed'));
				}
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-1' });
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'nativeui.sessions.listAll') return Promise.resolve({ items: [] });
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.sessionKeyById = { 'sess-1': 'agent:main:main' };

			// 不应抛出，sendMessage 应正常完成
			const result = await store.sendMessage('hello');
			expect(result.accepted).toBe(true);
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

			await store.resetChat();
			expect(resettingDuring).toBe(true);
			expect(store.resetting).toBe(false);
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
			// agent 请求永不 resolve，也不调用 onAccepted
			conn.request.mockImplementation((method) => {
				if (method === 'agent') return new Promise(() => {});
				return Promise.resolve(null);
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';

			// 启动发送，不 await
			const sendPromise = store.sendMessage('hello');
			// 等一个 microtask，让 sendMessage 进入 await Promise.race
			await Promise.resolve();

			expect(store.sending).toBe(true);
			expect(store.__accepted).toBe(false);

			// 用户取消
			store.cancelSend();

			// sendMessage 应立即 resolve 为 { accepted: false }
			const result = await sendPromise;
			expect(result).toEqual({ accepted: false });
			expect(store.sending).toBe(false);
			expect(store.messages.some((m) => m._local)).toBe(false);
		});

		test('accepted 之后取消：sendMessage 返回 { accepted: true }，不恢复输入', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);

			const conn = mockConn();
			// 调用 onAccepted 但永不 resolve 终态
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

			const sendPromise = store.sendMessage('hello');
			await Promise.resolve();

			expect(store.__accepted).toBe(true);

			store.cancelSend();

			const result = await sendPromise;
			// accepted 后取消视为 OpenClaw 已持久化，不应恢复输入
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
			store.sessionKeyById = { 'sess-1': 'agent:main:main' };
			store.errorText = 'some error';
			store.sending = true;
			store.resetting = true;

			store.cleanup();

			expect(store.sessionId).toBe('');
			expect(store.botId).toBe('');
			expect(store.messages).toHaveLength(0);
			expect(store.sessionKeyById).toEqual({});
			expect(store.errorText).toBe('');
			expect(store.sending).toBe(false);
			expect(store.resetting).toBe(false);
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
			conn.request.mockResolvedValue({ items: [] }); // reconcile
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.streamingRunId = 'run-1';
			store.sending = true;
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
			store.messages = [
				{ id: '__local_bot_1', _local: true, _streaming: true, message: { role: 'assistant', content: '' } },
			];

			store.__onAgentEvent({ runId: 'run-1', stream: 'lifecycle', data: { phase: 'error' } });

			expect(store.__agentSettled).toBe(true);
			expect(store.sending).toBe(false);
			// 本地 streaming 条目被清理
			expect(store.messages.some((m) => m._local)).toBe(false);
		});

		test('__reconcileMessages 请求失败时不抛出，返回 false', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);
			const conn = mockConn();
			// nativeui.sessions.listAll 抛出错误
			conn.request.mockRejectedValue(new Error('listAll failed'));
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.streamingRunId = 'run-1';

			// __reconcileMessages 是内部方法，直接调用验证
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
		test('currentSessionKey 返回当前 session 的 key', () => {
			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.sessionKeyById = { 'sess-1': 'agent:main:main' };

			expect(store.currentSessionKey).toBe('agent:main:main');
		});

		test('currentSessionKey 在 sessionId 不在 map 中时返回空字符串', () => {
			const store = useChatStore();
			store.sessionId = 'sess-unknown';
			store.sessionKeyById = {};

			expect(store.currentSessionKey).toBe('');
		});

		test('isMainSession 在 currentSessionKey 为 "agent:main:main" 时为 true', () => {
			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.sessionKeyById = { 'sess-1': 'agent:main:main' };

			expect(store.isMainSession).toBe(true);
		});

		test('isMainSession 在 currentSessionKey 非 main 时为 false', () => {
			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.sessionKeyById = { 'sess-1': 'agent:main:thread1' };

			expect(store.isMainSession).toBe(false);
		});

		test('isMainSession 在无 sessionKey 时为 false', () => {
			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.sessionKeyById = {};

			expect(store.isMainSession).toBe(false);
		});

		test('loadMessages 对非 main agent 传递正确的 agentId', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);
			const sessionsStore = useSessionsStore();
			sessionsStore.setSessions([{ sessionId: 'sess-ops', sessionKey: 'agent:ops:main', botId: '1' }]);

			const conn = mockConn();
			setupConnForLoad(conn, {
				sessions: [{ sessionId: 'sess-ops', sessionKey: 'agent:ops:main', indexed: true }],
				messages: [{ id: 'msg1', type: 'message' }],
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-ops';
			store.botId = '1';

			await store.loadMessages();
			// 验证 listAll 和 get 都传了 agentId: 'ops'
			expect(conn.request).toHaveBeenCalledWith('nativeui.sessions.listAll', expect.objectContaining({ agentId: 'ops' }));
			expect(conn.request).toHaveBeenCalledWith('nativeui.sessions.get', expect.objectContaining({ agentId: 'ops' }));
		});

		test('__reconcileMessages 对非 main agent 传递正确的 agentId', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);
			const sessionsStore = useSessionsStore();
			sessionsStore.setSessions([{ sessionId: 'sess-research', sessionKey: 'agent:research:main', botId: '1' }]);

			const conn = mockConn();
			conn.request.mockResolvedValue({ items: [] });
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-research';
			store.botId = '1';
			store.sessionKeyById = {};

			const result = await store.__reconcileMessages();
			expect(result).toBe(true);
			expect(conn.request).toHaveBeenCalledWith('nativeui.sessions.listAll', expect.objectContaining({ agentId: 'research' }));
		});

		test('isMainSession 对非 main agent 的 main session 也返回 true', () => {
			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.sessionKeyById = { 'sess-1': 'agent:ops:main' };

			expect(store.isMainSession).toBe(true);
		});
	});

	// =====================================================================
	// __resolveAgentId
	// =====================================================================

	describe('__resolveAgentId', () => {
		test('从 sessionKey 解析 agentId', () => {
			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.sessionKeyById = { 'sess-1': 'agent:ops:main' };

			expect(store.__resolveAgentId()).toBe('ops');
		});

		test('sessionKey 为 agent:main:main 时返回 main', () => {
			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.sessionKeyById = { 'sess-1': 'agent:main:main' };

			expect(store.__resolveAgentId()).toBe('main');
		});

		test('无 sessionId 时返回 main', () => {
			const store = useChatStore();
			expect(store.__resolveAgentId()).toBe('main');
		});

		test('无 sessionKey 时返回 main', () => {
			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.sessionKeyById = {};

			expect(store.__resolveAgentId()).toBe('main');
		});

		test('复杂 sessionKey 格式正确解析', () => {
			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.sessionKeyById = { 'sess-1': 'agent:research:session-research-abc' };

			expect(store.__resolveAgentId()).toBe('research');
		});

		test('sessionKeyById 为空时从 sessionsStore 查找 sessionKey', () => {
			const sessionsStore = useSessionsStore();
			sessionsStore.setSessions([
				{ sessionId: 'sess-tester', sessionKey: 'agent:tester:main', botId: '1' },
			]);

			const store = useChatStore();
			store.sessionId = 'sess-tester';
			store.sessionKeyById = {}; // 模拟 activateSession 清空后的状态

			expect(store.__resolveAgentId()).toBe('tester');
		});

		test('sessionKeyById 和 sessionsStore 都无匹配时 fallback 到 main', () => {
			const store = useChatStore();
			store.sessionId = 'unknown-sess';
			store.sessionKeyById = {};

			expect(store.__resolveAgentId()).toBe('main');
		});

		test('传入 sessionId 参数时使用指定值而非 this.sessionId', () => {
			const sessionsStore = useSessionsStore();
			sessionsStore.setSessions([
				{ sessionId: 'sess-a', sessionKey: 'agent:alpha:main', botId: '1' },
				{ sessionId: 'sess-b', sessionKey: 'agent:beta:main', botId: '1' },
			]);

			const store = useChatStore();
			store.sessionId = 'sess-a';
			store.sessionKeyById = {};

			// 不传参时用 this.sessionId
			expect(store.__resolveAgentId()).toBe('alpha');
			// 传参时用指定值
			expect(store.__resolveAgentId('sess-b')).toBe('beta');
		});
	});

	// =====================================================================
	// resetChat 动态 agentId
	// =====================================================================

	describe('resetChat with dynamic agentId', () => {
		test('resetChat 在 sessionKeyById 为空时从 sessionsStore 解析 agentId', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);
			const sessionsStore = useSessionsStore();
			sessionsStore.setSessions([
				{ sessionId: 'sess-ops', sessionKey: 'agent:ops:main', botId: '1' },
			]);

			const conn = mockConn();
			conn.request.mockResolvedValue({ entry: { sessionId: 'new-sess' } });
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-ops';
			store.botId = '1';
			store.sessionKeyById = {}; // 模拟 activateSession 清空后

			const newId = await store.resetChat();
			expect(newId).toBe('new-sess');
			// 应正确解析为 ops 而非 fallback 到 main
			expect(conn.request).toHaveBeenCalledWith('sessions.reset', {
				key: 'agent:ops:main',
				reason: 'new',
			});
		});

		test('resetChat 使用当前 session 的 agentId 构建 key', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: '1', online: true }]);
			const sessionsStore = useSessionsStore();
			sessionsStore.setSessions([{ sessionId: 'sess-1', botId: '1' }]);

			const conn = mockConn();
			conn.request.mockResolvedValue({
				entry: { sessionId: 'new-sess' },
			});
			mockConnections.set('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.botId = '1';
			store.sessionKeyById = { 'sess-1': 'agent:ops:main' };

			const newId = await store.resetChat();
			expect(newId).toBe('new-sess');
			expect(conn.request).toHaveBeenCalledWith('sessions.reset', {
				key: 'agent:ops:main',
				reason: 'new',
			});
		});
	});
});
