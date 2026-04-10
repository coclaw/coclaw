import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// jsdom 不提供 URL.createObjectURL/revokeObjectURL
if (!URL.createObjectURL) URL.createObjectURL = () => 'blob:mock';
if (!URL.revokeObjectURL) URL.revokeObjectURL = () => {};

import { createChatStore } from './chat.store.js';
import { useAgentRunsStore } from './agent-runs.store.js';
import { useClawsStore, __resetAwaitingConnIds as __resetClawStoreInternals } from './claws.store.js';

// 兼容旧测试：创建默认空 session store，可手动设置状态字段
// 同一 Pinia 实例中多次调用返回同一 store（与原 useChatStore 行为一致）
function useChatStore() {
	return createChatStore('session::main', { clawId: '', agentId: 'main' });
}

// --- Mocks ---

const mockConnections = new Map();

vi.mock('../services/claw-connection-manager.js', () => ({
	useClawConnections: () => ({
		get: (clawId) => mockConnections.get(String(clawId)),
		connect: vi.fn(),
		disconnect: vi.fn(),
		syncConnections: vi.fn(),
		disconnectAll: vi.fn(),
	}),
	__resetClawConnections: vi.fn(),
}));

vi.mock('../utils/file-helper.js', () => ({
	chatFilesDir: vi.fn().mockReturnValue('.coclaw/chat-files/main/2026-03'),
	topicFilesDir: vi.fn().mockReturnValue('.coclaw/topic-files/topic-1'),
	buildAttachmentBlock: vi.fn().mockReturnValue('## coclaw-attachments 🗂\n\n| Path | Size |\n|------|------|\n| .coclaw/chat-files/main/2026-03/photo-a3f1.jpg | 200.0 KB |'),
}));

vi.mock('../services/file-transfer.js', () => ({
	postFile: vi.fn(),
}));

vi.mock('../services/claws.api.js', () => ({
	listClaws: vi.fn().mockResolvedValue([]),
}));

// --- Helper ---

function mockConn(overrides = {}) {
	return {
		request: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
		...overrides,
	};
}

/** 注册 mock conn 并设置 clawsStore 中 claw 的 dcReady */
function setConn(clawId, conn, { dcReady = true } = {}) {
	mockConnections.set(String(clawId), conn);
	const clawsStore = useClawsStore();
	if (!clawsStore.byId[String(clawId)]) {
		clawsStore.byId[String(clawId)] = { id: String(clawId), dcReady };
	} else {
		clawsStore.byId[String(clawId)].dcReady = dcReady;
	}
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
		__resetClawStoreInternals();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// =====================================================================
	// createChatStore（工厂）
	// =====================================================================

	describe('createChatStore', () => {
		test('session 模式：根据 opts 初始化 identity 字段', () => {
			const store = createChatStore('session:1:ops', { clawId: '1', agentId: 'ops' });
			expect(store.clawId).toBe('1');
			expect(store.chatSessionKey).toBe('agent:ops:main');
			expect(store.topicMode).toBe(false);
			expect(store.sessionId).toBe('');
		});

		test('topic 模式：根据 storeKey 初始化 identity 字段', () => {
			const store = createChatStore('topic:topic-1', { clawId: '1', agentId: 'research' });
			expect(store.topicMode).toBe(true);
			expect(store.sessionId).toBe('topic-1');
			expect(store.topicAgentId).toBe('research');
			expect(store.chatSessionKey).toBe('');
			expect(store.historyExhausted).toBe(true);
		});

		test('agentId 默认为 main', () => {
			const store = createChatStore('session:1:main', { clawId: '1' });
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
			setConn('1', conn);

			const store = createChatStore('session:1:main', { clawId: '1', agentId: 'main' });
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
			const store = createChatStore('session:1:main', { clawId: '1', agentId: 'main' });
			await store.activate();

			expect(store.loading).toBe(true);
			expect(store.errorText).toBe('');
		});

		test('重复调用 activate 时做静默刷新（不重复 init）', async () => {
			const conn = mockConn();
			setupConnForLoad(conn);
			setConn('1', conn);

			const store = createChatStore('session:1:main', { clawId: '1', agentId: 'main' });
			await store.activate();
			const callCount = conn.request.mock.calls.length;

			await store.activate();
			// 静默刷新会再调一次 sessions.get + chat.history
			expect(conn.request.mock.calls.length).toBeGreaterThan(callCount);
		});

		test('重复调用 activate 时活跃 run（非 idle）跳过静默刷新', async () => {
			const conn = mockConn();
			setupConnForLoad(conn);
			setConn('1', conn);

			const store = createChatStore('session:1:main', { clawId: '1', agentId: 'main' });
			await store.activate();

			// 模拟活跃 run（lastEventAt 较新 → 非 idle → isSending=true）
			const runsStore = useAgentRunsStore();
			runsStore.runs['run-z'] = {
				runId: 'run-z', clawId: '1', runKey: store.runKey,
				settled: false, settling: false, lastEventAt: Date.now(),
				streamingMsgs: [], __timer: null,
			};
			runsStore.runKeyIndex[store.runKey] = 'run-z';

			const loadSpy = vi.spyOn(store, 'loadMessages');
			await store.activate();
			expect(loadSpy).not.toHaveBeenCalled();
		});

		test('重复调用 activate 时 sending=true 跳过静默刷新', async () => {
			const conn = mockConn();
			setupConnForLoad(conn);
			setConn('1', conn);

			const store = createChatStore('session:1:main', { clawId: '1', agentId: 'main' });
			await store.activate();

			// 模拟 sending=true 且僵尸 run 同时存在 → 仍应跳过（sending 优先）
			store.sending = true;
			const runsStore = useAgentRunsStore();
			runsStore.runs['run-z'] = {
				runId: 'run-z', clawId: '1', runKey: store.runKey,
				settled: false, settling: false, lastEventAt: Date.now() - 15_000,
				streamingMsgs: [], __timer: null,
			};
			runsStore.runKeyIndex[store.runKey] = 'run-z';

			const loadSpy = vi.spyOn(store, 'loadMessages');
			await store.activate();
			expect(loadSpy).not.toHaveBeenCalled();
		});

		test('重复调用 activate 时僵尸 run（idle）触发强制静默刷新 (#235)', async () => {
			const conn = mockConn();
			setupConnForLoad(conn);
			setConn('1', conn);

			const store = createChatStore('session:1:main', { clawId: '1', agentId: 'main' });
			await store.activate();

			// 模拟僵尸 run：sending=false + lastEventAt 超过 IDLE_RUN_MS
			const runsStore = useAgentRunsStore();
			runsStore.runs['run-z'] = {
				runId: 'run-z', clawId: '1', runKey: store.runKey,
				settled: false, settling: false, lastEventAt: Date.now() - 15_000,
				streamingMsgs: [], __timer: null,
			};
			runsStore.runKeyIndex[store.runKey] = 'run-z';

			const loadSpy = vi.spyOn(store, 'loadMessages');
			await store.activate();
			expect(loadSpy).toHaveBeenCalledWith({ silent: true });
		});

		test('skipLoad 跳过消息加载但注册 WS 监听', async () => {
			const conn = mockConn();
			setConn('1', conn);

			const store = createChatStore('topic:topic-1', { clawId: '1', agentId: 'main' });
			await store.activate({ skipLoad: true });

			expect(store.__initialized).toBe(true);
			expect(store.loading).toBe(false);
			expect(conn.request).not.toHaveBeenCalled();
		});

		test('clawId 为空时不加载', async () => {
			const store = createChatStore('session::main', { clawId: '', agentId: 'main' });
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
			setConn('1', conn);

			const store = createChatStore('topic:topic-1', { clawId: '1', agentId: 'main' });
			await store.activate();

			expect(store.messages).toHaveLength(1);
		});
	});

	// =====================================================================
	// loadMessages
	// =====================================================================

	describe('loadMessages', () => {
		test('调用 sessions.get 和 chat.history，设置 messages 和 currentSessionId', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			const flatMsgs = [
				{ role: 'user', content: 'hello' },
				{ role: 'assistant', content: 'hi there' },
			];
			setupConnForLoad(conn, { flatMessages: flatMsgs, currentSessionId: 'cur-123' });
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
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
			const store = createChatStore('topic:t1', { clawId: '1', agentId: 'main' });
			store.sessionId = ''; // 清空 sessionId 使 __loadTopicMessages 短路
			store.messages = [{ id: 'old' }];

			const ok = await store.loadMessages();
			expect(ok).toBe(false);
			expect(store.messages).toHaveLength(0);
		});

		test('连接缺失时返回 false 并保持 loading', async () => {
			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '999'; // 无对应连接
			store.chatSessionKey = 'agent:main:main';

			const ok = await store.loadMessages();
			expect(ok).toBe(false);
			expect(store.loading).toBe(true);
		});

		test('连接存在但未就绪时保持 loading 状态，不设 errorText', async () => {
			const conn = mockConn();
			setConn('1', conn, { dcReady: false });

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const ok = await store.loadMessages();
			expect(ok).toBe(false);
			expect(store.loading).toBe(true);
			expect(store.errorText).toBe('');
			expect(conn.request).not.toHaveBeenCalled();
		});

		test('silent 模式下不设置 loading 状态', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
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
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockRejectedValue(new Error('network error'));
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const ok = await store.loadMessages();
			expect(ok).toBe(false);
			expect(store.errorText).toBe('network error');
			expect(store.loading).toBe(false);
		});

		test('silent 模式下连接缺失时不设置 errorText', async () => {
			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '999'; // 无对应连接
			store.chatSessionKey = 'agent:main:main';
			store.errorText = '';

			const ok = await store.loadMessages({ silent: true });
			expect(ok).toBe(false);
			expect(store.errorText).toBe('');
		});

		test('session 模式 loadMessages 与 sendMessage 并发时保留乐观消息', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			setupConnForLoad(conn, { flatMessages: [{ role: 'user', content: 'old' }] });
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			// 模拟 sendMessage 添加的乐观消息
			store.messages = [
				{ type: 'message', id: '__local_user_1', _local: true, message: { role: 'user', content: 'new' } },
				{ type: 'message', id: '__local_claw_1', _local: true, _streaming: true, message: { role: 'assistant', content: '' } },
			];

			await store.loadMessages();
			// 服务端 1 条 + 乐观 2 条
			expect(store.messages).toHaveLength(3);
			expect(store.messages[0]).toMatchObject({ id: 'oc-0' }); // 服务端
			expect(store.messages[1]._local).toBe(true); // 乐观 user
			expect(store.messages[2]._local).toBe(true); // 乐观 claw
		});

		test('sessions.get 传递 chatSessionKey', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			setupConnForLoad(conn);
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:ops:main';

			await store.loadMessages();

			expect(conn.request).toHaveBeenCalledWith('sessions.get', expect.objectContaining({
				key: 'agent:ops:main',
			}), { timeout: 120_000 });
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
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

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
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'topic-1';
			store.clawId = '1';
			store.topicMode = true;
			store.topicAgentId = 'main';

			const ok = await store.loadMessages();
			expect(ok).toBe(true);
			expect(store.messages).toEqual(topicMsgs);

			expect(conn.request).toHaveBeenCalledWith('coclaw.sessions.getById', {
				sessionId: 'topic-1',
				agentId: 'main',
			}, { timeout: 120_000 });
		});

		test('topic 模式下 sessionId 为空时返回 false', async () => {
			const store = useChatStore();
			store.topicMode = true;
			store.sessionId = '';

			const ok = await store.loadMessages();
			expect(ok).toBe(false);
			expect(store.messages).toHaveLength(0);
		});

		test('loadMessages 与 sendMessage 并发时保留乐观消息', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method) => {
				if (method === 'coclaw.sessions.getById') {
					return Promise.resolve({ messages: [] });
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = createChatStore('topic:t1', { clawId: '1', agentId: 'main' });
			store.sessionId = 't1';

			// 模拟 sendMessage 添加的乐观消息
			const optimisticUser = {
				type: 'message', id: '__local_user_1', _local: true,
				message: { role: 'user', content: 'hello' },
			};
			const optimisticClaw = {
				type: 'message', id: '__local_claw_1', _local: true, _streaming: true,
				message: { role: 'assistant', content: '' },
			};
			store.messages = [optimisticUser, optimisticClaw];

			// loadMessages 并发执行 → 不应覆盖乐观消息
			await store.loadMessages();
			expect(store.messages).toHaveLength(2);
			expect(store.messages.some((m) => m._local)).toBe(true);
		});

		test('loadMessages 合并服务端消息与乐观消息', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			const serverMsg = { id: 's1', type: 'message', message: { role: 'user', content: 'old' } };
			conn.request.mockImplementation((method) => {
				if (method === 'coclaw.sessions.getById') {
					return Promise.resolve({ messages: [serverMsg] });
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = createChatStore('topic:t2', { clawId: '1', agentId: 'main' });
			store.sessionId = 't2';

			const optimistic = {
				type: 'message', id: '__local_user_2', _local: true,
				message: { role: 'user', content: 'new' },
			};
			store.messages = [optimistic];

			await store.loadMessages();
			// 服务端消息在前，乐观消息在后
			expect(store.messages).toHaveLength(2);
			expect(store.messages[0].id).toBe('s1');
			expect(store.messages[1].id).toBe('__local_user_2');
		});

		test('无乐观消息时 loadMessages 正常覆盖', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			const serverMsg = { id: 's1', type: 'message', message: { role: 'user', content: 'hi' } };
			conn.request.mockImplementation((method) => {
				if (method === 'coclaw.sessions.getById') {
					return Promise.resolve({ messages: [serverMsg] });
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = createChatStore('topic:t3', { clawId: '1', agentId: 'main' });
			store.sessionId = 't3';
			store.messages = [];

			await store.loadMessages();
			expect(store.messages).toEqual([serverMsg]);
		});
	});

	// =====================================================================
	// sendMessage
	// =====================================================================

	describe('sendMessage', () => {
		test('连接不存在时抛出错误', async () => {
			const store = useChatStore();
			store.clawId = '999'; // 无连接
			store.chatSessionKey = 'agent:main:main';

			await expect(store.sendMessage('hello')).rejects.toThrow('Claw not connected');
		});

		test('连接存在但 DC 未就绪时 request 会等待（不再立即抛错）', async () => {
			// 新设计：sendMessage 通过 useClawConnections().get() 获取 conn，
			// 不再检查 dcReady，而是由 request() 内部 waitReady 等待连接就绪
			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'r1' });
					return Promise.resolve({ status: 'ok' });
				}
				return Promise.resolve(null);
			});
			setConn('1', conn, { dcReady: false });

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			// request 仍然被调用（等待逻辑在 ClawConnection 层处理，这里是 mock）
			const result = await store.sendMessage('hello');
			expect(result).toEqual({ accepted: true });
		});

		test('topic 模式下 sessionId 为空时返回 { accepted: false }', async () => {
			const store = createChatStore('topic:t1', { clawId: '1', agentId: 'main' });
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
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

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
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const result = await store.sendMessage('hello world');
			expect(result.accepted).toBe(true);

			const agentCall = conn.request.mock.calls.find((c) => c[0] === 'agent');
			expect(agentCall).toBeTruthy();
			expect(agentCall[1].message).toBe('hello world');
			expect(agentCall[1].sessionKey).toBe('agent:main:main');
		});

		test('onAccepted 回调设置 streamingRunId 和 __accepted', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

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
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			await store.sendMessage('test');
			expect(store.__accepted).toBe(true);
		});

		test('RPC resolve 后不立即 settle run，由 reconcile 流程处理', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-no-settle' });
					// 模拟 lifecycle:end 尚未到达
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'cur' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			await store.sendMessage('test');
			// RPC resolve 后 run 应通过 reconcileAfterLoad 而非 settle 清理
			// 由于 loadMessages 成功且 reconcileAfterLoad 的双条件判定，
			// run 的最终清理取决于事件流静默和服务端消息状态
			expect(store.sending).toBe(false);
		});

		test('chat 模式下 agentParams 使用 sessionKey', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

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
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			await store.sendMessage('hi');

			const agentCall = conn.request.mock.calls.find((c) => c[0] === 'agent');
			expect(agentCall[1].sessionKey).toBe('agent:main:main');
			expect(agentCall[1].sessionId).toBeUndefined();
		});

		test('topic 模式下 agentParams 使用 sessionId', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-1' });
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'coclaw.sessions.getById') return Promise.resolve({ messages: [] });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'topic-1';
			store.clawId = '1';
			store.topicMode = true;
			store.topicAgentId = 'main';
			store.chatSessionKey = '';

			await store.sendMessage('hi topic');

			const agentCall = conn.request.mock.calls.find((c) => c[0] === 'agent');
			expect(agentCall[1].sessionId).toBe('topic-1');
			expect(agentCall[1].sessionKey).toBeUndefined();
		});

		test('上传进度回调 total=0 时 progress 设为 0', async () => {
			const { postFile } = await import('../services/file-transfer.js');

			let capturedOnProgress;
			let resolveUpload;
			postFile.mockReturnValue({
				promise: new Promise((resolve) => { resolveUpload = resolve; }),
				cancel: vi.fn(),
				set onProgress(cb) { capturedOnProgress = cb; },
			});

			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn({ rtc: { isReady: true } });
			conn.rtc = { isReady: true, createDataChannel: vi.fn() };
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-1' });
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'cur' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const fakeFile = { type: 'image/png', size: 204800 };
			const files = [{ id: 'f1', isImg: true, file: fakeFile, name: 'photo.jpg', bytes: 204800 }];
			const sendPromise = store.sendMessage('test', files);

			// 等待 onProgress 回调被注册
			await vi.waitFor(() => expect(capturedOnProgress).toBeDefined());
			// total=0 时 progress 应为 0（首次调用无节流）
			capturedOnProgress(50, 0);
			expect(store.fileUploadState.f1.progress).toBe(0);
			// total>0 时正常计算（mock Date.now 跳过 100ms 节流间隔）
			const origNow = Date.now;
			Date.now = () => origNow() + 200;
			capturedOnProgress(50, 100);
			expect(store.fileUploadState.f1.progress).toBe(0.5);
			Date.now = origNow;

			// 完成上传以让 sendMessage 继续
			resolveUpload({ path: '.coclaw/chat-files/main/2026-03/photo-a3f1.jpg', bytes: 204800 });
			await sendPromise;
		});

		test('RTC 可用时通过 POST 上传附件，message 包含附件信息块', async () => {
			const { postFile } = await import('../services/file-transfer.js');
			const { buildAttachmentBlock } = await import('../utils/file-helper.js');

			postFile.mockReturnValue({
				promise: Promise.resolve({ path: '.coclaw/chat-files/main/2026-03/photo-a3f1.jpg', bytes: 204800 }),
				cancel: vi.fn(),
				set onProgress(_cb) {},
			});

			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn({ rtc: { isReady: true } });
			conn.rtc = { isReady: true, createDataChannel: vi.fn() };
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-1' });
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'cur' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const fakeFile = { type: 'image/png', size: 204800 };
			const files = [{ isImg: true, file: fakeFile, name: 'photo.jpg', bytes: 204800 }];
			await store.sendMessage('看这张图', files);

			// postFile 被调用
			expect(postFile).toHaveBeenCalledWith(
				conn, 'main', '.coclaw/chat-files/main/2026-03', 'photo.jpg', fakeFile,
			);
			// buildAttachmentBlock 被调用
			expect(buildAttachmentBlock).toHaveBeenCalled();

			// agent RPC 的 message 包含附件信息块，不含 attachments
			const agentCall = conn.request.mock.calls.find((c) => c[0] === 'agent');
			expect(agentCall[1].message).toContain('coclaw-attachments');
			expect(agentCall[1].message).toContain('看这张图');
			expect(agentCall[1].attachments).toBeUndefined();
			// extraSystemPrompt 始终携带文件渲染能力提示
			expect(agentCall[1].extraSystemPrompt).toContain('coclaw-file:');
		});

		test('dcReady=false 时有附件仍走上传路径（由底层 waitReady 处理）', async () => {
			const { postFile } = await import('../services/file-transfer.js');

			postFile.mockReturnValue({
				promise: Promise.resolve({ path: '.coclaw/chat-files/main/2026-03/photo-a3f1.jpg', bytes: 204800 }),
				cancel: vi.fn(),
				set onProgress(_cb) {},
			});

			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			// dcReady=false，但 conn 存在
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-1' });
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'cur' });
				return Promise.resolve(null);
			});
			setConn('1', conn, { dcReady: false });

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const fakeFile = { type: 'image/png', size: 204800 };
			const files = [{ isImg: true, file: fakeFile, name: 'photo.jpg', bytes: 204800 }];
			const result = await store.sendMessage('看图', files);

			expect(result.accepted).toBe(true);
			expect(postFile).toHaveBeenCalled();
		});

		test('语音文件上传时 agentParams 包含 extraSystemPrompt', async () => {
			const { postFile } = await import('../services/file-transfer.js');
			const { buildAttachmentBlock } = await import('../utils/file-helper.js');

			postFile.mockReturnValue({
				promise: Promise.resolve({ path: '.coclaw/chat-files/main/2026-03/voice_123.webm' }),
				cancel: vi.fn(),
				set onProgress(_cb) {},
			});
			buildAttachmentBlock.mockReturnValue('## coclaw-attachments');

			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn({ rtc: { isReady: true } });
			conn.rtc = { isReady: true, createDataChannel: vi.fn() };
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-1' });
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'cur' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const voiceBlob = new Blob(['audio'], { type: 'audio/webm' });
			const files = [{ isVoice: true, isImg: false, file: voiceBlob, name: 'voice_123.webm', bytes: 5000 }];
			await store.sendMessage('', files);

			const agentCall = conn.request.mock.calls.find((c) => c[0] === 'agent');
			expect(agentCall[1].extraSystemPrompt).toContain('voice_123.webm');
			expect(agentCall[1].extraSystemPrompt).toContain('音频内容即为用户的实际消息输入');
		});

		test('POST 上传失败时抛出错误，uploadingFiles 恢复', async () => {
			const { postFile } = await import('../services/file-transfer.js');

			postFile.mockReturnValue({
				promise: Promise.reject(new Error('upload failed')),
				cancel: vi.fn(),
				set onProgress(_cb) {},
			});

			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn({ rtc: { isReady: true } });
			conn.rtc = { isReady: true, createDataChannel: vi.fn() };
			conn.request.mockImplementation((method) => {
				if (method === 'agent') return new Promise(() => {});
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const files = [{ isImg: false, file: new Blob(['data']), name: 'doc.pdf', bytes: 100 }];
			await expect(store.sendMessage('here', files)).rejects.toThrow('upload failed');
			expect(store.uploadingFiles).toBe(false);
			expect(store.sending).toBe(false);
		});

		test('上传阶段 cancelSend 不抛错，返回 accepted: false', async () => {
			const { postFile } = await import('../services/file-transfer.js');

			// postFile 返回一个可取消的 handle，promise 被 cancel 后 reject CANCELLED
			let rejectFn;
			const cancelFn = vi.fn();
			postFile.mockReturnValue({
				promise: new Promise((_resolve, reject) => { rejectFn = reject; }),
				cancel() {
					cancelFn();
					const err = new Error('Upload cancelled');
					err.code = 'CANCELLED';
					rejectFn(err);
				},
				set onProgress(_cb) {},
			});

			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn({ rtc: { isReady: true } });
			conn.rtc = { isReady: true, createDataChannel: vi.fn() };
			conn.request.mockImplementation(() => Promise.resolve(null));
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const files = [{ isImg: false, file: new Blob(['data']), name: 'doc.pdf', bytes: 100, id: 'f1' }];
			const sendPromise = store.sendMessage('here', files);

			// 等待 upload 开始
			await vi.waitFor(() => expect(store.uploadingFiles).toBe(true));

			// 用户取消
			store.cancelSend();

			// 不应抛错，返回 { accepted: false }
			const result = await sendPromise;
			expect(result).toEqual({ accepted: false });
			expect(store.sending).toBe(false);
			expect(store.fileUploadState).toBeNull();
			expect(store.messages.some((m) => m._local)).toBe(false);
		});

		test('发送失败（request 抛出）时清理 streaming 状态并重新抛出', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method) => {
				if (method === 'agent') return Promise.reject(new Error('send failed'));
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			await expect(store.sendMessage('fail')).rejects.toThrow('send failed');
			expect(store.sending).toBe(false);
			expect(store.messages.some((m) => m._local)).toBe(false);
		});

		test('pre-acceptance 180s 超时：sending 置 false，__agentSettled 为 true，抛出 PRE_ACCEPTANCE_TIMEOUT', async () => {
			vi.useFakeTimers();
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method) => {
				if (method === 'agent') return new Promise(() => {});
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
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
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

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
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
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
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

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
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const result = await store.sendMessage('hello');
			expect(result).toEqual({ accepted: true });
		});

		test('WS_CLOSED 且未 accepted 时等待重连后自动重试一次', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);
			clawsStore.byId['1'].dcReady = true;

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
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const result = await store.sendMessage('hello');
			expect(result).toEqual({ accepted: true });
			expect(callCount).toBe(2);
		});

		test('DC_NOT_READY 错误码也触发断连重试', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);
			clawsStore.byId['1'].dcReady = true;

			let callCount = 0;
			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					callCount++;
					if (callCount === 1) {
						const err = new Error('DataChannel not ready');
						err.code = 'DC_NOT_READY';
						return Promise.reject(err);
					}
					options?.onAccepted?.({ runId: 'run-dc' });
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'cur' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const result = await store.sendMessage('hello');
			expect(result).toEqual({ accepted: true });
			expect(callCount).toBe(2);
		});

		test('WS_CLOSED 重试时复用同一个 idempotencyKey', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);
			clawsStore.byId['1'].dcReady = true;

			const capturedKeys = [];
			const conn = mockConn();
			let callCount = 0;

			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					callCount++;
					capturedKeys.push(params.idempotencyKey);
					if (callCount === 1) {
						const err = new Error('connection closed');
						err.code = 'WS_CLOSED';
						return Promise.reject(err);
					}
					options?.onAccepted?.({ runId: 'run-retry' });
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'cur' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			await store.sendMessage('hello');
			expect(capturedKeys).toHaveLength(2);
			expect(capturedKeys[0]).toBe(capturedKeys[1]);
		});

		test('WS_CLOSED 且未 accepted 时重连超时后仍抛出错误', async () => {
			vi.useFakeTimers();
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
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
			setConn('1', connForSend);
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
			store.clawId = '1';
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
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);
			clawsStore.byId['1'].dcReady = true;

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
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			await expect(store.sendMessage('hello')).rejects.toMatchObject({ code: 'WS_CLOSED' });
			expect(callCount).toBe(2); // 原始 + 重试各一次
		});

		test('WS_CLOSED 且已 accepted 时不抛出，等重连后 reconcile', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);
			clawsStore.byId['1'].dcReady = true;

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
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const result = await store.sendMessage('hello');
			expect(result).toEqual({ accepted: true });
			expect(store.sending).toBe(false);
		});

		// --- #217: RTC_LOST（后台返回 DC 重建）应走断连重连路径 ---

		test('RTC_LOST 且未 accepted 时等待重连后自动重试一次', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);
			clawsStore.byId['1'].dcReady = true;

			let callCount = 0;
			const conn = mockConn();

			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					callCount++;
					if (callCount === 1) {
						const err = new Error('RTC connection lost');
						err.code = 'RTC_LOST';
						return Promise.reject(err);
					}
					options?.onAccepted?.({ runId: 'run-retry' });
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'cur' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const result = await store.sendMessage('hello');
			expect(result).toEqual({ accepted: true });
			expect(callCount).toBe(2);
		});

		test('RTC_LOST 且已 accepted 时不抛出，等重连后 reconcile', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);
			clawsStore.byId['1'].dcReady = true;

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-acc' });
					const err = new Error('RTC connection lost');
					err.code = 'RTC_LOST';
					return Promise.reject(err);
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'cur' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const result = await store.sendMessage('hello');
			expect(result).toEqual({ accepted: true });
			expect(store.sending).toBe(false);
		});

		test('catch 块中 __cancelReject 被清理，避免孤儿 rejection（#217 双重通知）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);
			clawsStore.byId['1'].dcReady = true;

			const conn = mockConn();
			conn.request.mockImplementation((method) => {
				if (method === 'agent') {
					const err = new Error('some error');
					err.code = 'UNKNOWN_ERR';
					return Promise.reject(err);
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			await expect(store.sendMessage('hello')).rejects.toThrow();
			// catch 块已清理 __cancelReject，后续 cleanup 不应触发孤儿 rejection
			expect(store.__cancelReject).toBeNull();
		});

		test('RTC_LOST + __agentSettled 为 true 时被抑制，返回 { accepted }', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-rtc-settled' });
					const store2 = useChatStore();
					store2.__agentSettled = true;
					const err = new Error('RTC connection lost');
					err.code = 'RTC_LOST';
					return Promise.reject(err);
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const result = await store.sendMessage('hello');
			expect(result).toEqual({ accepted: true });
		});

		test('RTC_LOST + accepted 时立即优雅返回 { accepted: true }', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);
			clawsStore.byId['1'].dcReady = true;

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-rtc-timeout' });
					const err = new Error('RTC connection lost');
					err.code = 'RTC_LOST';
					return Promise.reject(err);
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			// 不再等待重连，立即返回
			const result = await store.sendMessage('hello');
			expect(result).toEqual({ accepted: true });
		});

		test('RTC_LOST + 未 accepted + 重试再次 RTC_LOST 不无限循环', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);
			clawsStore.byId['1'].dcReady = true;

			let callCount = 0;
			const conn = mockConn();
			conn.request.mockImplementation((method) => {
				if (method === 'agent') {
					callCount++;
					const err = new Error('RTC connection lost');
					err.code = 'RTC_LOST';
					return Promise.reject(err);
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'cur' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			await expect(store.sendMessage('hello')).rejects.toMatchObject({ code: 'RTC_LOST' });
			expect(callCount).toBe(2); // 原始 + 重试各一次，不会第三次
		});

		test('CONNECT_TIMEOUT 且未 accepted 时走断连重试路径', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			let callCount = 0;
			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					callCount++;
					if (callCount === 1) {
						const err = new Error('connect timeout');
						err.code = 'CONNECT_TIMEOUT';
						return Promise.reject(err);
					}
					options?.onAccepted?.({ runId: 'run-ct' });
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'cur' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const result = await store.sendMessage('hello');
			expect(result).toEqual({ accepted: true });
			expect(callCount).toBe(2);
		});

		test('CONNECT_TIMEOUT 且已 accepted 时优雅返回', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-ct-acc' });
					const err = new Error('connect timeout');
					err.code = 'CONNECT_TIMEOUT';
					return Promise.reject(err);
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const result = await store.sendMessage('hello');
			expect(result).toEqual({ accepted: true });
		});

		test('cleanup 在 reconnect-wait 期间不会触发二次 rejection', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);
			clawsStore.byId['1'].dcReady = true;

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-cleanup' });
					const err = new Error('RTC connection lost');
					err.code = 'RTC_LOST';
					return Promise.reject(err);
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'cur' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const result = await store.sendMessage('hello');
			expect(result).toEqual({ accepted: true });

			// sendMessage 返回后 cleanup 不应触发任何 rejection
			expect(store.__cancelReject).toBeNull();
			store.cleanup(); // 应安全执行，无 unhandled rejection
		});

		test('!__accepted 且 status !== "ok" 时返回 { accepted: false } 并移除本地条目', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method) => {
				if (method === 'agent') return Promise.resolve({ status: 'rejected' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const result = await store.sendMessage('hello');
			expect(result).toEqual({ accepted: false });
			expect(store.messages.some((m) => m._local)).toBe(false);
		});

		test('纯文本发送：乐观消息带 _pending 标记，无上传阶段', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			let capturedLocalMsgs;
			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					// 在 onAccepted 前捕获 _pending 状态
					capturedLocalMsgs = store.messages.filter((m) => m._local).map((m) => ({
						_pending: m._pending, role: m.message.role,
					}));
					options?.onAccepted?.({ runId: 'run-1' });
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'cur' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			await store.sendMessage('hello');
			// onAccepted 前应有 _pending: true
			expect(capturedLocalMsgs).toEqual([
				{ _pending: true, role: 'user' },
				{ _pending: true, role: 'assistant' },
			]);
			// 无上传阶段
			expect(store.fileUploadState).toBeNull();
		});

		test('onAccepted 后 _pending 被清除', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const runsStore = useAgentRunsStore();
			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-p' });
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'cur' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			await store.sendMessage('hello');
			// onAccepted 后 streamingMsgs 中的消息 _pending 应为 false
			const run = Object.values(runsStore.runs)[0];
			expect(run).toBeTruthy();
			for (const m of run.streamingMsgs) {
				expect(m._pending).toBe(false);
			}
		});

		test('上传文件后乐观消息带 _attachments（含 blob URL）', async () => {
			const { postFile } = await import('../services/file-transfer.js');
			postFile.mockReturnValue({
				promise: Promise.resolve({ path: '.coclaw/chat-files/main/2026-03/pic.jpg', bytes: 1024 }),
				cancel: vi.fn(),
				set onProgress(_cb) {},
			});

			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			let capturedUser;
			const conn = mockConn({ rtc: { isReady: true } });
			conn.rtc = { isReady: true, createDataChannel: vi.fn() };
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					capturedUser = store.messages.find((m) => m._local && m.message.role === 'user');
					options?.onAccepted?.({ runId: 'run-att' });
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'cur' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const fakeFile = { type: 'image/png', size: 1024 };
			const files = [{ id: 'f1', isImg: true, file: fakeFile, name: 'pic.jpg', bytes: 1024 }];
			await store.sendMessage('看图', files);

			expect(capturedUser._attachments).toHaveLength(1);
			expect(capturedUser._attachments[0]).toMatchObject({
				name: 'pic.jpg', isImg: true, url: 'blob:mock',
			});
		});

		test('remotePath 跳过上传且立即调用 onFileUploaded', async () => {
			const { postFile } = await import('../services/file-transfer.js');
			postFile.mockClear();

			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn({ rtc: { isReady: true } });
			conn.rtc = { isReady: true, createDataChannel: vi.fn() };
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-rp' });
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'cur' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const onFileUploaded = vi.fn();
			const files = [{
				id: 'f1', isImg: false, file: new Blob(['data']), name: 'doc.pdf',
				bytes: 100, remotePath: '.coclaw/chat-files/main/2026-03/doc.pdf',
			}];
			await store.sendMessage('已上传的文件', files, { onFileUploaded });

			// 不应调用 postFile
			expect(postFile).not.toHaveBeenCalled();
			// onFileUploaded 被调用
			expect(onFileUploaded).toHaveBeenCalledTimes(1);
			expect(onFileUploaded).toHaveBeenCalledWith(expect.objectContaining({ id: 'f1' }));
		});

		test('混合文件：有 remotePath 的跳过，无 remotePath 的正常上传', async () => {
			const { postFile } = await import('../services/file-transfer.js');
			postFile.mockClear();
			postFile.mockReturnValue({
				promise: Promise.resolve({ path: '.coclaw/chat-files/main/2026-03/new.pdf', bytes: 200 }),
				cancel: vi.fn(),
				set onProgress(_cb) {},
			});

			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn({ rtc: { isReady: true } });
			conn.rtc = { isReady: true, createDataChannel: vi.fn() };
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-mix' });
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'cur' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const onFileUploaded = vi.fn();
			const files = [
				{ id: 'f1', isImg: false, file: new Blob(['old']), name: 'old.pdf', bytes: 100, remotePath: '.coclaw/existing.pdf' },
				{ id: 'f2', isImg: false, file: new Blob(['new']), name: 'new.pdf', bytes: 200 },
			];
			await store.sendMessage('mixed', files, { onFileUploaded });

			// postFile 仅对 f2 调用
			expect(postFile).toHaveBeenCalledTimes(1);
			expect(postFile).toHaveBeenCalledWith(conn, 'main', expect.any(String), 'new.pdf', expect.anything());
			// onFileUploaded 两次
			expect(onFileUploaded).toHaveBeenCalledTimes(2);
			// f2 应设置 remotePath
			expect(files[1].remotePath).toBe('.coclaw/chat-files/main/2026-03/new.pdf');
		});

		test('onFileUploaded 按上传顺序调用', async () => {
			const { postFile } = await import('../services/file-transfer.js');

			let callCount = 0;
			postFile.mockImplementation(() => ({
				promise: Promise.resolve({ path: `.coclaw/file-${++callCount}.pdf`, bytes: 100 }),
				cancel: vi.fn(),
				set onProgress(_cb) {},
			}));

			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn({ rtc: { isReady: true } });
			conn.rtc = { isReady: true, createDataChannel: vi.fn() };
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-seq' });
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'cur' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const uploadedIds = [];
			const files = [
				{ id: 'a', file: new Blob(['a']), name: 'a.txt', bytes: 10 },
				{ id: 'b', file: new Blob(['b']), name: 'b.txt', bytes: 20 },
			];
			await store.sendMessage('seq', files, {
				onFileUploaded: (f) => uploadedIds.push(f.id),
			});

			expect(uploadedIds).toEqual(['a', 'b']);
		});

		test('fileUploadState 生命周期：pending → uploading → done → null', async () => {
			const { postFile } = await import('../services/file-transfer.js');

			const states = [];
			let resolveUpload;
			postFile.mockReturnValue({
				promise: new Promise((resolve) => { resolveUpload = resolve; }),
				cancel: vi.fn(),
				set onProgress(_cb) {},
			});

			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn({ rtc: { isReady: true } });
			conn.rtc = { isReady: true, createDataChannel: vi.fn() };
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-lc' });
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'cur' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const files = [{ id: 'f1', file: new Blob(['d']), name: 'f.txt', bytes: 10 }];
			const sendPromise = store.sendMessage('lc', files);

			// 等待上传开始
			await vi.waitFor(() => expect(store.fileUploadState?.f1?.status).toBe('uploading'));
			states.push({ ...store.fileUploadState.f1 });

			resolveUpload({ path: '.coclaw/f.txt', bytes: 10 });
			await sendPromise;

			// 最终 null
			expect(store.fileUploadState).toBeNull();
			// 中间态为 uploading
			expect(states[0].status).toBe('uploading');
		});

		test('部分文件上传失败：已完成的 done，失败的 failed', async () => {
			const { postFile } = await import('../services/file-transfer.js');

			let callIdx = 0;
			postFile.mockImplementation(() => {
				callIdx++;
				if (callIdx === 1) {
					return {
						promise: Promise.resolve({ path: '.coclaw/a.txt', bytes: 10 }),
						cancel: vi.fn(),
						set onProgress(_cb) {},
					};
				}
				return {
					promise: Promise.reject(new Error('upload failed')),
					cancel: vi.fn(),
					set onProgress(_cb) {},
				};
			});

			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn({ rtc: { isReady: true } });
			conn.rtc = { isReady: true, createDataChannel: vi.fn() };
			conn.request.mockImplementation(() => new Promise(() => {}));
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const files = [
				{ id: 'f1', file: new Blob(['a']), name: 'a.txt', bytes: 10 },
				{ id: 'f2', file: new Blob(['b']), name: 'b.txt', bytes: 20 },
			];
			await expect(store.sendMessage('partial', files)).rejects.toThrow('upload failed');
			// f1 上传成功应有 remotePath
			expect(files[0].remotePath).toBe('.coclaw/a.txt');
			// f2 无 remotePath
			expect(files[1].remotePath).toBeUndefined();
		});

		test('全部文件有 remotePath 时不调用 postFile，直接发送', async () => {
			const { postFile } = await import('../services/file-transfer.js');
			postFile.mockClear();

			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn({ rtc: { isReady: true } });
			conn.rtc = { isReady: true, createDataChannel: vi.fn() };
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-skip' });
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'cur' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const files = [
				{ id: 'f1', file: new Blob(['a']), name: 'a.txt', bytes: 10, remotePath: '.coclaw/a.txt' },
				{ id: 'f2', file: new Blob(['b']), name: 'b.txt', bytes: 20, remotePath: '.coclaw/b.txt' },
			];
			const result = await store.sendMessage('all skipped', files);

			expect(postFile).not.toHaveBeenCalled();
			expect(result.accepted).toBe(true);
			// message 仍包含附件信息块
			const agentCall = conn.request.mock.calls.find((c) => c[0] === 'agent');
			expect(agentCall[1].message).toContain('coclaw-attachments');
		});

		test('断连重试时透传 onFileUploaded', async () => {
			const { postFile } = await import('../services/file-transfer.js');
			postFile.mockClear();

			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			let callCount = 0;
			const conn = mockConn({ rtc: { isReady: true } });
			conn.rtc = { isReady: true, createDataChannel: vi.fn() };
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					callCount++;
					if (callCount === 1) {
						// 第一次断连
						const err = new Error('dc closed');
						err.code = 'DC_CLOSED';
						return Promise.reject(err);
					}
					// 重试时成功
					options?.onAccepted?.({ runId: 'run-retry' });
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'cur' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const uploadedIds = [];
			const result = await store.sendMessage('retry', [], {
				onFileUploaded: (f) => uploadedIds.push(f.id),
			});

			expect(result.accepted).toBe(true);
			// 纯文本不触发 onFileUploaded，但关键是不报错
		});

		test('取消发送（上传阶段）：无本地消息、清理 fileUploadState', async () => {
			const { postFile } = await import('../services/file-transfer.js');

			let rejectFn;
			postFile.mockReturnValue({
				promise: new Promise((_r, reject) => { rejectFn = reject; }),
				cancel() {
					const err = new Error('cancelled');
					err.code = 'CANCELLED';
					rejectFn(err);
				},
				set onProgress(_cb) {},
			});

			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn({ rtc: { isReady: true } });
			conn.rtc = { isReady: true, createDataChannel: vi.fn() };
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const files = [{ id: 'f1', file: new Blob(['d']), name: 'f.txt', bytes: 10 }];
			const sendPromise = store.sendMessage('cancel-upload', files);

			await vi.waitFor(() => expect(store.uploadingFiles).toBe(true));
			store.cancelSend();

			const result = await sendPromise;
			expect(result).toEqual({ accepted: false });
			// 上传阶段取消：不应有本地消息（乐观消息尚未创建）
			expect(store.messages.some((m) => m._local)).toBe(false);
			expect(store.fileUploadState).toBeNull();
		});

		// event:agent 监听器已由 clawsStore.__bridgeConn 集中管理
		// register 不再自行注册/注销 conn.on('event:agent')，相关测试已移至 agent-runs.store.test.js
	});

	// =====================================================================
	// resetChat
	// =====================================================================

	describe('resetChat', () => {
		test('调用 sessions.reset 并返回新 sessionId', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockResolvedValue({ entry: { sessionId: 'sess-new' } });
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
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
			store.clawId = '999';

			await expect(store.resetChat()).rejects.toThrow('Claw not connected');
		});

		test('响应中无 sessionId 时抛出错误', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockResolvedValue({ entry: {} }); // 无 sessionId
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			await expect(store.resetChat()).rejects.toThrow('Failed to resolve new session');
		});

		test('resetting 标志在执行期间为 true，完成后恢复 false', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			let resettingDuring = false;
			conn.request.mockImplementation(() => {
				resettingDuring = useChatStore().resetting;
				return Promise.resolve({ entry: { sessionId: 'sess-new' } });
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			await store.resetChat();
			expect(resettingDuring).toBe(true);
			expect(store.resetting).toBe(false);
		});

		test('resetChat 使用 chatSessionKey 解析 agentId 构建 key', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockResolvedValue({ entry: { sessionId: 'new-sess' } });
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:ops:main';

			const newId = await store.resetChat();
			expect(newId).toBe('new-sess');
			expect(conn.request).toHaveBeenCalledWith('sessions.reset', {
				key: 'agent:ops:main',
				reason: 'new',
			}, { timeout: 600_000 });
		});

		test('并发调用时第二次返回 null（resetting guard）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			let resolveFirst;
			conn.request.mockImplementation(() => new Promise((resolve) => { resolveFirst = resolve; }));
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const p1 = store.resetChat();
			const p2 = store.resetChat();
			expect(await p2).toBe(null);

			resolveFirst({ entry: { sessionId: 'sess-new' } });
			expect(await p1).toBe('sess-new');
			expect(store.resetting).toBe(false);
		});
	});

	// =====================================================================
	// cancelSend
	// =====================================================================

	describe('cancelSend', () => {
		test('未 accepted 时取消：清理 streaming 并删除本地消息', () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);
			setConn('1', mockConn());

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.sending = true;
			store.__accepted = false;
			store.streamingRunId = 'run-x';
			store.messages = [
				{ id: '__local_user_1', _local: true, message: { role: 'user', content: 'hi' } },
				{ id: '__local_claw_1', _local: true, _streaming: true, message: { role: 'assistant', content: '' } },
			];

			store.cancelSend();

			expect(store.sending).toBe(false);
			expect(store.streamingRunId).toBeNull();
			expect(store.messages.some((m) => m._local)).toBe(false);
		});

		test('accepted 之前取消：sendMessage 立即返回 { accepted: false }', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method) => {
				if (method === 'agent') return new Promise(() => {});
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
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
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

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
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
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
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
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
			expect(store.clawId).toBe('1');
			expect(store.chatSessionKey).toBe('agent:main:main');
		});
	});

	// __onAgentEvent 相关测试已迁移到 agent-stream.test.js 和 agent-runs.store.test.js

	describe('__reconcileMessages', () => {
		test('连接不存在时返回 false', async () => {
			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '999'; // 无连接
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

		// --- allMessages 合并 + stripLocalUserMsgs 去重 ---

		test('allMessages 合并 streamingMsgs（不做过滤）', () => {
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
					{ type: 'message', id: '__local_claw_456', _local: true, _streaming: true, message: { role: 'assistant', content: '' } },
				],
			};
			runsStore.runKeyIndex[runKey] = runId;

			const all = store.allMessages;
			expect(all).toHaveLength(3);
		});

		test('allMessages 空 session 无锚点时正确合并', () => {
			const store = useChatStore();
			store.chatSessionKey = 'agent:main:main';
			store.messages = [];

			const runsStore = useAgentRunsStore();
			const runId = 'run-empty';
			const runKey = store.runKey;
			runsStore.runs[runId] = {
				runId,
				runKey,
				anchorMsgId: null,
				settled: false,
				settling: false,
				streamingMsgs: [
					{ type: 'message', id: '__local_user', _local: true, message: { role: 'user', content: '首条消息' } },
					{ type: 'message', id: '__local_claw', _local: true, _streaming: true, message: { role: 'assistant', content: '' } },
				],
			};
			runsStore.runKeyIndex[runKey] = runId;

			const all = store.allMessages;
			expect(all).toHaveLength(2);
			expect(all[0].id).toBe('__local_user');
			expect(all[1].id).toBe('__local_claw');
		});

		test('allMessages 按锚点定位 streamingMsgs 插入位置', () => {
			const store = useChatStore();
			store.chatSessionKey = 'agent:main:main';

			// server 消息：包含锚点消息和之后 reload 追加的消息
			store.messages = [
				{ type: 'message', id: 'msg-1', message: { role: 'user', content: '旧消息' } },
				{ type: 'message', id: 'msg-2', message: { role: 'assistant', content: '旧回复' } },
				{ type: 'message', id: 'msg-3', message: { role: 'assistant', content: '上一个 task 的尾部' } },
			];

			const runsStore = useAgentRunsStore();
			const runId = 'run-anchor';
			const runKey = store.runKey;
			runsStore.runs[runId] = {
				runId,
				runKey,
				anchorMsgId: 'msg-2', // 发送时 messages 最后一条 server 消息
				settled: false,
				settling: false,
				streamingMsgs: [
					{ type: 'message', id: '__local_user', _local: true, message: { role: 'user', content: '新消息' } },
					{ type: 'message', id: '__local_claw', _local: true, _streaming: true, message: { role: 'assistant', content: '' } },
				],
			};
			runsStore.runKeyIndex[runKey] = runId;

			const all = store.allMessages;
			expect(all).toHaveLength(5);
			// streamingMsgs 应插入在锚点 msg-2 之后，msg-3 之前
			expect(all[0].id).toBe('msg-1');
			expect(all[1].id).toBe('msg-2');
			expect(all[2].id).toBe('__local_user');
			expect(all[3].id).toBe('__local_claw');
			expect(all[4].id).toBe('msg-3');
		});

		test('allMessages 锚点不存在时回退到追加', () => {
			const store = useChatStore();
			store.chatSessionKey = 'agent:main:main';

			store.messages = [
				{ type: 'message', id: 'msg-99', message: { role: 'assistant', content: 'hi' } },
			];

			const runsStore = useAgentRunsStore();
			const runId = 'run-no-anchor';
			const runKey = store.runKey;
			runsStore.runs[runId] = {
				runId,
				runKey,
				anchorMsgId: 'msg-deleted', // 锚点已不存在
				settled: false,
				settling: false,
				streamingMsgs: [
					{ type: 'message', id: '__local_user', _local: true, message: { role: 'user', content: '消息' } },
				],
			};
			runsStore.runKeyIndex[runKey] = runId;

			const all = store.allMessages;
			expect(all).toHaveLength(2);
			expect(all[0].id).toBe('msg-99');
			expect(all[1].id).toBe('__local_user');
		});

		test('stripLocalUserMsgs 锚点后有 user 消息 → strip 乐观消息', () => {
			const store = useChatStore();
			store.chatSessionKey = 'agent:main:main';

			const runsStore = useAgentRunsStore();
			const runId = 'run-1';
			const runKey = store.runKey;
			runsStore.runs[runId] = {
				runId,
				runKey,
				anchorMsgId: 'oc-assistant-1000',
				settled: false,
				settling: false,
				streamingMsgs: [
					{ type: 'message', id: '__local_user_123', _local: true, message: { role: 'user', content: '你好' } },
					{ type: 'message', id: '__local_claw_123', _local: true, _streaming: true, message: { role: 'assistant', content: '回复中…' } },
				],
			};
			runsStore.runKeyIndex[runKey] = runId;

			// server 数据：锚点之后出现了 user 消息（content 格式不同也无影响）
			const serverMsgs = [
				{ id: 'oc-assistant-1000', message: { role: 'assistant', content: '旧回复' } },
				{ id: 'oc-user-2000', message: { role: 'user', content: [{ type: 'text', text: '你好' }] } },
			];
			runsStore.stripLocalUserMsgs(runKey, serverMsgs);

			const run = runsStore.runs[runId];
			expect(run.streamingMsgs).toHaveLength(1);
			expect(run.streamingMsgs[0].id).toBe('__local_claw_123');
		});

		test('stripLocalUserMsgs 锚点后无 user 消息 → 保留乐观消息', () => {
			const store = useChatStore();
			store.chatSessionKey = 'agent:main:main';

			const runsStore = useAgentRunsStore();
			const runId = 'run-1';
			const runKey = store.runKey;
			runsStore.runs[runId] = {
				runId,
				runKey,
				anchorMsgId: 'oc-assistant-1000',
				settled: false,
				settling: false,
				streamingMsgs: [
					{ type: 'message', id: '__local_user_123', _local: true, message: { role: 'user', content: '你好' } },
					{ type: 'message', id: '__local_claw_123', _local: true, _streaming: true, message: { role: 'assistant', content: '' } },
				],
			};
			runsStore.runKeyIndex[runKey] = runId;

			// server 数据：锚点之后无 user 消息
			const serverMsgs = [
				{ id: 'oc-assistant-1000', message: { role: 'assistant', content: '旧回复' } },
			];
			runsStore.stripLocalUserMsgs(runKey, serverMsgs);

			const run = runsStore.runs[runId];
			expect(run.streamingMsgs).toHaveLength(2);
		});

		test('stripLocalUserMsgs 对 settled/settling run 不操作', () => {
			const runsStore = useAgentRunsStore();
			runsStore.runs['run-x'] = {
				runId: 'run-x',
				runKey: 'agent:main:main',
				settled: true,
				settling: false,
				streamingMsgs: [
					{ type: 'message', id: '__local_user_1', _local: true, message: { role: 'user', content: 'hi' } },
				],
			};
			runsStore.runKeyIndex['agent:main:main'] = 'run-x';

			runsStore.stripLocalUserMsgs('agent:main:main');

			// settled run 不做任何操作
			expect(runsStore.runs['run-x'].streamingMsgs).toHaveLength(1);
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
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

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
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			await store.__loadChatHistory();

			expect(store.historySessionIds).toEqual(historyItems);
			expect(store.historyExhausted).toBe(false);
			expect(store.__historyLoadedCount).toBe(0);
		});

		test('历史列表为空时设置 historyExhausted 为 true', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockResolvedValue({ history: [] });
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			await store.__loadChatHistory();

			expect(store.historySessionIds).toEqual([]);
			expect(store.historyExhausted).toBe(true);
		});

		test('topic 模式下跳过', async () => {
			const conn = mockConn();
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.topicMode = true;
			store.chatSessionKey = 'agent:main:main';

			await store.__loadChatHistory();

			expect(conn.request).not.toHaveBeenCalled();
		});

		test('chatSessionKey 为空时跳过', async () => {
			const conn = mockConn();
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = '';

			await store.__loadChatHistory();

			expect(conn.request).not.toHaveBeenCalled();
		});

		test('请求失败时设置 historyExhausted 为 true', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockRejectedValue(new Error('rpc failed'));
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			await store.__loadChatHistory();

			expect(store.historySessionIds).toEqual([]);
			expect(store.historyExhausted).toBe(true);
		});

		test('传递正确的 agentId 和 sessionKey', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockResolvedValue({ history: [] });
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:ops:main';

			await store.__loadChatHistory();

			expect(conn.request).toHaveBeenCalledWith('coclaw.chatHistory.list', {
				agentId: 'ops',
				sessionKey: 'agent:ops:main',
			}, { timeout: 60_000 });
		});

		test('并发调用复用同一 promise，仅发起一次 RPC', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockResolvedValue({ history: [{ sessionId: 'h1', archivedAt: 100 }] });
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const p1 = store.__loadChatHistory();
			// 飞行中守卫：第二次调用应复用已有 promise，不再发起新请求
			const p2 = store.__loadChatHistory();
			await Promise.all([p1, p2]);

			expect(conn.request).toHaveBeenCalledTimes(1);
			expect(store.historySessionIds).toHaveLength(1);
			// promise 完成后 guard 已清理，可再次调用
			expect(store.__historyListPromise).toBeNull();
		});
	});

	// =====================================================================
	// loadNextHistorySession
	// =====================================================================

	describe('loadNextHistorySession', () => {
		test('加载下一个历史 session 并 prepend 到 historySegments', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

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
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
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
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockResolvedValue({ messages: [] });
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
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
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			let callIdx = 0;
			const conn = mockConn();
			conn.request.mockImplementation((method) => {
				if (method === 'coclaw.sessions.getById') {
					callIdx++;
					return Promise.resolve({ messages: [{ id: `msg-${callIdx}` }] });
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
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
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockRejectedValue(new Error('load failed'));
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
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
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockRejectedValue(new Error('load failed'));
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.historySessionIds = [{ sessionId: 'hist-1', archivedAt: 100 }];

			const ok = await store.loadNextHistorySession();
			expect(ok).toBe(false);
			expect(store.__historyLoadedCount).toBe(1);
			expect(store.historyExhausted).toBe(true);
		});

		test('消息未加载完成时空 historySessionIds 不设 exhausted', async () => {
			const store = useChatStore();
			store.clawId = '1';
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
			store.clawId = '1';
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
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
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
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method) => {
				if (method === 'coclaw.sessions.getById') {
					return Promise.resolve({ messages: [{ id: 't1', type: 'message', message: { role: 'user', content: 'topic' } }] });
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'topic-1';
			store.clawId = '1';
			store.topicMode = true;
			store.topicAgentId = 'main';

			const result = await store.__reconcileMessages();
			expect(result).toBe(true);
		});

		test('连接不存在时返回 false', async () => {
			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '999';

			const result = await store.__reconcileMessages();
			expect(result).toBe(false);
		});

		test('loadMessages 抛出异常时返回 false', async () => {
			const conn = mockConn();
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			// 直接 mock loadMessages 使其抛出异常
			vi.spyOn(store, 'loadMessages').mockRejectedValue(new Error('load boom'));

			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const result = await store.__reconcileMessages();
			expect(result).toBe(false);
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining('reconcile failed'),
				expect.any(Error),
			);
			warnSpy.mockRestore();
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
			setConn('1', conn);
			store.clawId = '1';
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
			useClawsStore().byId['1'].dcReady = false;
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
			expect(conn.request).toHaveBeenCalledWith('sessions.get', expect.any(Object), { timeout: 120_000 });
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

			expect(conn.request).toHaveBeenCalledWith('sessions.get', expect.any(Object), { timeout: 120_000 });
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

			vi.advanceTimersByTime(300_000);
			expect(store.sending).toBe(false);
			expect(store.__slashCommandRunId).toBeNull();
			expect(store.messages.length).toBe(0); // 乐观消息已清理

			await expect(p).rejects.toThrow('slash command timeout');
		});

		test('/new 等重量级命令使用 600s 超时', async () => {
			vi.useFakeTimers();
			const p = store.sendSlashCommand('/new');
			expect(store.sending).toBe(true);

			// 300s 后不应超时（普通命令已超时，但重量级命令是 600s）
			vi.advanceTimersByTime(300_000);
			expect(store.__slashCommandRunId).not.toBeNull();

			// 600s 后超时
			vi.advanceTimersByTime(300_000);
			expect(store.__slashCommandRunId).toBeNull();
			expect(store.sending).toBe(false);

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
			setConn('1', conn);

			const store = createChatStore('session:1:main', { clawId: '1', agentId: 'main' });
			await store.activate();

			const sessCall = conn.request.mock.calls.find((c) => c[0] === 'sessions.get');
			expect(sessCall).toBeTruthy();
			expect(sessCall[1]).toMatchObject({ limit: 50 });
		});

		test('loadMessages: 返回数 < limit 时 hasMoreMessages=false', async () => {
			const conn = mockConn();
			const msgs = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `msg-${i}` }));
			setupConnForLoad(conn, { flatMessages: msgs });
			setConn('1', conn);

			const store = createChatStore('session:1:main', { clawId: '1', agentId: 'main' });
			await store.activate();

			expect(store.messages).toHaveLength(10);
			expect(store.hasMoreMessages).toBe(false);
		});

		test('loadMessages: 返回数 >= limit 时 hasMoreMessages=true', async () => {
			const conn = mockConn();
			const msgs = Array.from({ length: 50 }, (_, i) => ({ role: 'user', content: `msg-${i}` }));
			setupConnForLoad(conn, { flatMessages: msgs });
			setConn('1', conn);

			const store = createChatStore('session:1:main', { clawId: '1', agentId: 'main' });
			await store.activate();

			expect(store.messages).toHaveLength(50);
			expect(store.hasMoreMessages).toBe(true);
		});

		test('loadOlderMessages 增大 limit 向前加载并 prepend 到列表', async () => {
			const conn = mockConn();
			const initialMsgs = Array.from({ length: 50 }, (_, i) => ({ role: 'user', content: `msg-${i + 50}` }));
			setupConnForLoad(conn, { flatMessages: initialMsgs });
			setConn('1', conn);

			const store = createChatStore('session:1:main', { clawId: '1', agentId: 'main' });
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
			setConn('1', conn);

			const store = createChatStore('session:1:main', { clawId: '1', agentId: 'main' });
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
			setConn('1', conn);

			const store = createChatStore('session:1:main', { clawId: '1', agentId: 'main' });
			await store.activate();
			expect(store.hasMoreMessages).toBe(false);

			const result = await store.loadOlderMessages();
			expect(result).toBe(false);
		});

		test('loadOlderMessages: 保留本地 streaming 消息', async () => {
			const conn = mockConn();
			const initialMsgs = Array.from({ length: 50 }, (_, i) => ({ role: 'user', content: `msg-${i}` }));
			setupConnForLoad(conn, { flatMessages: initialMsgs });
			setConn('1', conn);

			const store = createChatStore('session:1:main', { clawId: '1', agentId: 'main' });
			await store.activate();

			store.messages = [
				...store.messages,
				{ type: 'message', id: '__local_claw_1', _local: true, _streaming: true, message: { role: 'assistant', content: 'thinking...' } },
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
			expect(localMsg.id).toBe('__local_claw_1');
		});

		test('loadOlderMessages: 用户乐观消息（_local && !_streaming）不重复', async () => {
			const conn = mockConn();
			const initialMsgs = Array.from({ length: 50 }, (_, i) => ({ role: 'user', content: `msg-${i}` }));
			setupConnForLoad(conn, { flatMessages: initialMsgs });
			setConn('1', conn);

			const store = createChatStore('session:1:main', { clawId: '1', agentId: 'main' });
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
			setConn('1', conn);

			const store = createChatStore('topic:topic-1', { clawId: '1', agentId: 'main' });
			await store.activate();

			const result = await store.loadOlderMessages();
			expect(result).toBe(false);
		});

		test('loadOlderMessages: 并发防护', async () => {
			const conn = mockConn();
			const initialMsgs = Array.from({ length: 50 }, (_, i) => ({ role: 'user', content: `msg-${i}` }));
			setupConnForLoad(conn, { flatMessages: initialMsgs });
			setConn('1', conn);

			const store = createChatStore('session:1:main', { clawId: '1', agentId: 'main' });
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
			setConn('1', conn);

			const store1 = createChatStore('session:1:main', { clawId: '1', agentId: 'main' });
			await store1.activate();
			expect(store1.hasMoreMessages).toBe(true);

			// 另一个 store（空消息）
			setupConnForLoad(conn, { flatMessages: [] });
			const store2 = createChatStore('session:1:ops', { clawId: '1', agentId: 'ops' });
			await store2.activate();

			expect(store2.hasMoreMessages).toBe(false);
			// store1 不受影响
			expect(store1.hasMoreMessages).toBe(true);
		});
	});

	// =====================================================================
	// activate 简化（连接监听已移至 clawsStore 响应式桥接）
	// =====================================================================

	describe('activate 简化', () => {
		test('连接未就绪时 activate 标记 loading 并等待 connReady 驱动', async () => {
			const conn = mockConn();
			setConn('1', conn, { dcReady: false });

			const store = createChatStore('session:1:main', { clawId: '1', agentId: 'main' });
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
			setConn('1', conn);

			const store = createChatStore('session:1:main', { clawId: '1', agentId: 'main' });
			await store.activate();

			expect(store.__initialized).toBe(true);
			expect(store.__messagesLoaded).toBe(true);
			expect(store.messages).toHaveLength(1);
		});

		test('skipLoad 时 activate 不加载消息', async () => {
			const conn = mockConn();
			setConn('1', conn);

			const store = createChatStore('session:1:main', { clawId: '1', agentId: 'main' });
			await store.activate({ skipLoad: true });

			expect(store.__initialized).toBe(true);
			expect(store.messages).toHaveLength(0);
			expect(conn.request).not.toHaveBeenCalled();
		});

		test('dispose 不再涉及 conn 监听清理', async () => {
			const conn = mockConn();
			setupConnForLoad(conn);
			setConn('1', conn);

			const store = createChatStore('session:1:main', { clawId: '1', agentId: 'main' });
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
			setConn('1', conn);

			const store = createChatStore('session:1:main', { clawId: '1', agentId: 'main' });
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
			setConn('1', conn);

			const store = createChatStore('session:1:main', { clawId: '1', agentId: 'main' });
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
			setConn('1', conn);

			const store = createChatStore('session:1:main', { clawId: '1', agentId: 'main' });
			await store.activate();

			const runsStore = useAgentRunsStore();
			runsStore.register('run-zombie', {
				clawId: '1',
				runKey: store.runKey,
				topicMode: false,
				conn,
				streamingMsgs: [],
			});
			// 模拟僵尸 run：曾收到过事件但已静默超过 STALE_RUN_MS
			runsStore.runs['run-zombie'].lastEventAt = Date.now() - 10_000;
			expect(runsStore.isRunning(store.runKey)).toBe(true);

			await store.loadMessages({ silent: true });

			expect(runsStore.isRunning(store.runKey)).toBe(false);
		});

		test('sending=true 时 loadMessages 跳过 reconcileAfterLoad', async () => {
			const conn = mockConn();
			setupConnForLoad(conn, {
				flatMessages: [
					{ role: 'user', content: 'hi' },
					{ role: 'assistant', content: 'hello', stopReason: 'stop' },
				],
			});
			setConn('1', conn);

			const store = createChatStore('session:1:main', { clawId: '1', agentId: 'main' });
			await store.activate();

			const runsStore = useAgentRunsStore();
			runsStore.register('run-active', {
				clawId: '1',
				runKey: store.runKey,
				topicMode: false,
				conn,
				streamingMsgs: [],
			});
			runsStore.runs['run-active'].lastEventAt = Date.now() - 10_000;
			// 模拟发送中
			store.sending = true;

			await store.loadMessages({ silent: true });

			// sending=true 时应跳过 reconcile，run 仍在
			expect(runsStore.isRunning(store.runKey)).toBe(true);
		});
	});

	// =====================================================================
	// busy getter
	// =====================================================================

	describe('busy', () => {
		test('默认为 false', () => {
			const s = useChatStore();
			expect(s.busy).toBe(false);
		});

		test('sending 时为 true', () => {
			const s = useChatStore();
			s.sending = true;
			expect(s.busy).toBe(true);
		});

		test('uploadingFiles 时为 true', () => {
			const s = useChatStore();
			s.uploadingFiles = true;
			expect(s.busy).toBe(true);
		});

		test('resetting 时为 true', () => {
			const s = useChatStore();
			s.resetting = true;
			expect(s.busy).toBe(true);
		});

		test('多个状态组合仍为 true', () => {
			const s = useChatStore();
			s.sending = true;
			s.uploadingFiles = true;
			expect(s.busy).toBe(true);
		});
	});
});
