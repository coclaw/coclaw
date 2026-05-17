import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// jsdom 不提供 URL.createObjectURL/revokeObjectURL
if (!URL.createObjectURL) URL.createObjectURL = () => 'blob:mock';
if (!URL.revokeObjectURL) URL.revokeObjectURL = () => {};

import { createChatStore } from './chat.store.js';
import { useAgentRunsStore, POST_ACCEPT_TIMEOUT_MS } from './agent-runs.store.js';
import { useClawsStore, __resetAwaitingConnIds as __resetClawStoreInternals } from './claws.store.js';
import { useSessionsStore } from './sessions.store.js';
import { groupSessionMessages } from '../utils/session-msg-group.js';

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

vi.mock('../utils/file-helper.js', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		chatFilesDir: vi.fn().mockReturnValue('.coclaw/chat-files/main/2026-03'),
		topicFilesDir: vi.fn().mockReturnValue('.coclaw/topic-files/topic-1'),
		buildAttachmentBlock: vi.fn().mockReturnValue('## coclaw-attachments 🗂\n\n| Path | Size |\n|------|------|\n| .coclaw/chat-files/main/2026-03/photo-a3f1.jpg | 200.0 KB |'),
	};
});

vi.mock('../services/file-transfer.js', () => ({
	postFile: vi.fn(),
}));

vi.mock('../services/claws.api.js', () => ({
	listClaws: vi.fn().mockResolvedValue([]),
}));

// chat.store 导入 remoteLog 用于 cancel 关键事件上报——测试中屏蔽网络路径，只捕获调用
const remoteLogCalls = [];
vi.mock('../services/remote-log.js', () => ({
	remoteLog: (text) => { remoteLogCalls.push(text); },
}));

// chat.store 通过 getSharedNotifier 在 cancel gone / not-supported 时弹 toast——
// 测试中 stub 一个可观察的 notifier，断言调用方法 + 入参
const mockNotifier = {
	success: vi.fn(),
	info: vi.fn(),
	warning: vi.fn(),
	error: vi.fn(),
};
vi.mock('./notify-hook-bridge.js', () => ({
	getSharedNotifier: () => mockNotifier,
}));

// i18n 也在 chat.store 内被 cancel 提示分支引用——stub 成回显 key 即可，避免拉真实 vue-i18n
vi.mock('../i18n/index.js', () => ({
	i18n: { global: { t: (key) => key } },
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
		remoteLogCalls.length = 0;
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
				ended: false, cancelled: false, lastEventAt: Date.now(),
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
				ended: false, cancelled: false, lastEventAt: Date.now() - 15_000,
				streamingMsgs: [], __timer: null,
			};
			runsStore.runKeyIndex[store.runKey] = 'run-z';

			const loadSpy = vi.spyOn(store, 'loadMessages');
			await store.activate();
			expect(loadSpy).not.toHaveBeenCalled();
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
			}), { timeout: 60_000 });
		});

		// chat.history 是辅助 RPC（仅取 currentSessionId 用于历史上翻），它的失败
		// 不应反向阻挡 sessions.get 已成功拉到的消息更新。否则上游 __awaitPersistAndDrop
		// 拿到的 ok=false 会让 dropRun 跳过，streamingMsgs 永远卡死 →
		// allMessages 把 streamingMsgs 与 server 持久化消息并列渲染成两个气泡。
		test('chat.history 失败时 loadMessages 仍返回 true，sessions.get 数据已生效', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method) => {
				if (method === 'sessions.get') {
					return Promise.resolve({ messages: [{ role: 'user', content: 'persisted' }] });
				}
				if (method === 'chat.history') {
					const err = new Error('DC_CLOSED');
					err.code = 'DC_CLOSED';
					return Promise.reject(err);
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.currentSessionId = 'prev-sess';

			const ok = await store.loadMessages({ silent: true });

			expect(ok).toBe(true);
			expect(store.messages).toHaveLength(1);
			expect(store.messages[0]).toMatchObject({ message: { role: 'user', content: 'persisted' } });
			// chat.history 失败时 currentSessionId 保持旧值（不重置为 null）
			expect(store.currentSessionId).toBe('prev-sess');
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
			expect(result).toEqual({ accepted: true, endReason: 'rpc', errorMessage: null });
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
					// 模拟终态信号尚未到达，靠 RPC res 抢先收尾
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
			// runAgent 接管 run 生命周期：RPC resolve 后由 watcher endRun + dropRun 清理
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
			// extraSystemPrompt 始终携带文件渲染能力提示，且示例必须用尖括号形式
			expect(agentCall[1].extraSystemPrompt).toContain('<coclaw-file:');
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
					err.code = 'ERR_CANCELED';
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

		test('pre-acceptance 180s 超时：sending 置 false，抛出 PRE_ACCEPTANCE_TIMEOUT', async () => {
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
			// 远程日志保证可观测：未来同类异常（含 wire 层丢包导致超时）能在远端被发现
			// PRE_ACCEPTANCE_TIMEOUT 是本层 180s 看门狗触发，runAgent 的主 RPC（timeout=0）
			// 此时仍在后台，不会立刻打 agent.run.preaccept-failed；本层留 agent.run.send-failed 作兜底
			expect(remoteLogCalls.find((t) => t.startsWith('agent.run.send-failed') && t.includes('code=PRE_ACCEPTANCE_TIMEOUT'))).toBeTruthy();
		});

		test('post-acceptance 24h 兜底：accepted 后 run 由 agent-runs.store 内 24h timer 清理', async () => {
			vi.useFakeTimers();
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-timeout' });
					return new Promise(() => {});
				}
				// agent.wait 返回 timeout 无 endedAt（活跃，立即下一轮）→ 死循环防御
				// 测试关心 24h timer 兜底，避免 watcher 自然结束影响断言
				if (method === 'agent.wait') return new Promise(() => {});
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
			expect(store.__accepted).toBe(true);

			const runsStore = useAgentRunsStore();
			expect(runsStore.isRunning(store.runKey)).toBe(true);

			const [, result] = await Promise.allSettled([
				vi.advanceTimersByTimeAsync(POST_ACCEPT_TIMEOUT_MS),
				sendPromise,
			]);

			// 24h 后 endRun + dropRun 触发：sendMessage resolve（不抛错），run 被清理
			expect(result.status).toBe('fulfilled');
			expect(result.value).toMatchObject({ accepted: true });
			expect(runsStore.isRunning(store.runKey)).toBe(false);
		});

		test('accepted 后 WS_CLOSED：runAgent 接管收尾，sendMessage 返回 accepted=true 并透出 endReason+errorMessage', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

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
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const result = await store.sendMessage('hello');
			expect(result).toEqual({ accepted: true, endReason: 'failed', errorMessage: 'ws closed' });
		});

		test('accepted 后模型不可用（FailoverError）：sendMessage 透出 endReason="failed" + 原始错误信息（让 ChatPage 可以 notify）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			const failoverMsg = 'FailoverError: No API key found for provider "openai"';
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-fail' });
					// server 端 ok=false → ClawConnection reject 为带 message+code 的 Error
					const err = new Error(failoverMsg);
					err.code = 'UNAVAILABLE';
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
			expect(result.accepted).toBe(true);
			expect(result.endReason).toBe('failed');
			expect(result.errorMessage).toBe(failoverMsg);
		});

		test('accepted 后业务级 status="error"（防御 ok=true 漏发协议）：sendMessage 透出 endReason="failed"', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-biz-err' });
					return Promise.resolve({ runId: 'run-biz-err', status: 'error', summary: 'business level fail' });
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const result = await store.sendMessage('hello');
			expect(result.accepted).toBe(true);
			expect(result.endReason).toBe('failed');
			expect(result.errorMessage).toBe('business level fail');
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
			expect(result).toEqual({ accepted: true, endReason: 'rpc', errorMessage: null });
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
			expect(result).toMatchObject({ accepted: true });
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
			expect(result).toMatchObject({ accepted: true });
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
			expect(result).toEqual({ accepted: true, endReason: 'rpc', errorMessage: null });
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
			expect(result).toMatchObject({ accepted: true });
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

		test('accepted 后 RTC_LOST：runAgent 接管收尾，sendMessage 返回 { accepted: true }', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-rtc-settled' });
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
			expect(result).toMatchObject({ accepted: true });
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
			expect(result).toMatchObject({ accepted: true });
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
			expect(result).toMatchObject({ accepted: true });
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
			expect(result).toMatchObject({ accepted: true });
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
			expect(result).toMatchObject({ accepted: true });

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
			// agent RPC pending：让 run 不进入终态，streamingMsgs 不会被 dropRun 释放，
			// 测试可以观察到 register 之后的 _pending 标记状态
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-p' });
					return new Promise(() => {});
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

			void store.sendMessage('hello');
			// 等 register + onAccepted 完成
			await Promise.resolve();
			await Promise.resolve();
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
			// 诊断信号：第一次失败的断连分支应打 agent.run.send-retry
			expect(remoteLogCalls.find((t) => t.startsWith('agent.run.send-retry') && t.includes('code=DC_CLOSED'))).toBeTruthy();
		});

		test('取消发送（上传阶段）：无本地消息、清理 fileUploadState', async () => {
			const { postFile } = await import('../services/file-transfer.js');

			let rejectFn;
			postFile.mockReturnValue({
				promise: new Promise((_r, reject) => { rejectFn = reject; }),
				cancel() {
					const err = new Error('cancelled');
					err.code = 'ERR_CANCELED';
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
			// 诊断信号：上传被取消的分支应打 agent.run.upload-cancelled
			expect(remoteLogCalls.find((t) => t.startsWith('agent.run.upload-cancelled'))).toBeTruthy();
		});

		// event:agent 监听器已由 clawsStore.__bridgeConn 集中管理
		// register 不再自行注册/注销 conn.on('event:agent')，相关测试已移至 agent-runs.store.test.js

		// =====================================================================
		// runPromise.then accepted 分支：silent loadMessages 失败时不应 dropRun
		// （否则用户已收到的流式 streamingMsgs 会被无声清空、终态消息又没拉到）
		// =====================================================================

		test('accepted 后 silent loadMessages 失败：保留 run 与 streamingMsgs，不调 dropRun', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-fail-load' });
					// RPC 终态到达 → endRun → runPromise.then 触发 silent loadMessages
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'sessions.get') {
					// silent reload 失败：网络/连接错误
					return Promise.reject(new Error('network down'));
				}
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'cur' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const runsStore = useAgentRunsStore();
			const dropSpy = vi.spyOn(runsStore, 'dropRun');

			const result = await store.sendMessage('hello');
			expect(result).toMatchObject({ accepted: true });

			// 等待 runPromise.then 链跑完 if 判断：仅等 sessions.get 被调不够（catch + return false +
			// then continuation 仍在 microtask 队列里）。挂额外 spy 在 runPromise.then 之后的
			// loadMessages 路径——当 storeRun.streamingMsgs 还在且 dropRun 始终未触发，等多个 microtask
			// 让 then 链 settle。
			await vi.waitFor(() => {
				const sessGet = conn.request.mock.calls.find((c) => c[0] === 'sessions.get');
				expect(sessGet).toBeTruthy();
			});
			// 多排几次 microtask + macrotask，确保 then 链跑完 await loadMessages → catch → return false → if(ok) 分支
			await Promise.resolve();
			await Promise.resolve();
			await new Promise((r) => setTimeout(r, 0));

			// 关键断言：dropRun 没被调用，run 仍在 + streamingMsgs 仍保留
			expect(dropSpy).not.toHaveBeenCalled();
			const run = runsStore.getActiveRun(store.runKey);
			expect(run).not.toBeNull();
			// register 时把 optimisticUser + optimisticClaw 入 streamingMsgs
			expect(run.streamingMsgs.length).toBeGreaterThan(0);
		});

		test('accepted 后 silent loadMessages 成功：触发 dropRun', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-load-ok' });
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

			const runsStore = useAgentRunsStore();
			const dropSpy = vi.spyOn(runsStore, 'dropRun');

			const result = await store.sendMessage('hello');
			expect(result).toMatchObject({ accepted: true });

			// loadMessages 成功后 dropRun 被调用一次（带 expectedRunId）
			await vi.waitFor(() => {
				expect(dropSpy).toHaveBeenCalledWith(store.runKey, 'run-load-ok');
			});
			// run 已被 dropRun 清掉
			expect(runsStore.getActiveRun(store.runKey)).toBeNull();
		});

		// =====================================================================
		// __awaitPersistAndDrop 契约（方案 D：源头 grace + 下游统一行为）
		//
		// "等持久化"已收拢到 agent-runs.store 的 rpc grace 窗口。无论 endReason
		// 是 'rpc' / 'wait' / 'failed'，下游本函数行为统一：
		//   - loadMessages 一次 → 成功则 dropRun；失败则不 dropRun（streamingMsgs 残留至下次 chat 重建时自愈，详见 TODO.md #2）
		// 不再按 endReason 区分快慢路径、不再 sleep + 重试、不再 hasTerminalAssistantAfter 校验。
		// 这避免了 fast follow-up 场景下把上一轮回答误判成本轮终态。
		// =====================================================================

		test('endReason=wait 与 endReason=rpc 行为一致：loadMessages 一次 + dropRun，无 sleep/重试', async () => {
			vi.useFakeTimers();
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-lc-ok' });
					return new Promise(() => {}); // RPC pending；让 wait 先赢但等 grace
				}
				if (method === 'sessions.get') {
					return Promise.resolve({
						messages: [
							{ role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 1000 },
							{ role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', timestamp: 2000 },
						],
					});
				}
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'sess-1' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const runsStore = useAgentRunsStore();
			const dropSpy = vi.spyOn(runsStore, 'dropRun');

			const sendPromise = store.sendMessage('hello');
			await vi.advanceTimersByTimeAsync(0); // 等 register
			expect(runsStore.runs['run-lc-ok']).toBeTruthy();

			// 模拟 wait 终态先到，挂 grace；推进 RPC_GRACE_MS 让源头降级 endRun('wait')
			runsStore.__schedulePendingEnd('run-lc-ok', 'wait');
			await vi.advanceTimersByTimeAsync(2000); // RPC_GRACE_MS
			await sendPromise;

			// 下游 loadMessages 一次（无前置 sleep）→ dropRun
			await vi.waitFor(() => {
				expect(dropSpy).toHaveBeenCalledWith(store.runKey, 'run-lc-ok');
			});
			const sessGetCalls = conn.request.mock.calls.filter((c) => c[0] === 'sessions.get');
			expect(sessGetCalls.length).toBe(1);
			// 不再有 persist-stale 降级 remoteLog（撤掉了）
			expect(remoteLogCalls.find((t) => t.includes('persist-stale'))).toBeFalsy();
		});

		test('endReason=wait + silent loadMessages 失败：不 dropRun（streamingMsgs 残留至下次 chat 重建自愈，TODO #2）', async () => {
			vi.useFakeTimers();
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-lc-fail' });
					return new Promise(() => {});
				}
				if (method === 'sessions.get') return Promise.reject(new Error('network down'));
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'sess-1' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const runsStore = useAgentRunsStore();
			const dropSpy = vi.spyOn(runsStore, 'dropRun');

			const sendPromise = store.sendMessage('hello');
			await vi.advanceTimersByTimeAsync(0);
			runsStore.__schedulePendingEnd('run-lc-fail', 'wait');
			await vi.advanceTimersByTimeAsync(2000); // grace 满 → endRun('wait')
			await sendPromise;

			// 多排几次 microtask 让 then 链 settle
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(0);

			// 至少试过一次 sessions.get；失败后不 dropRun
			const sessGetCalls = conn.request.mock.calls.filter((c) => c[0] === 'sessions.get');
			expect(sessGetCalls.length).toBeGreaterThanOrEqual(1);
			expect(dropSpy).not.toHaveBeenCalled();
			expect(runsStore.getActiveRun(store.runKey)).not.toBeNull();
			expect(remoteLogCalls.find((t) => t.includes('persist-stale'))).toBeFalsy();
		});

		// 双气泡 bug 回归：DC 抖动时 chat.history（取 currentSessionId 的辅助 RPC）失败，
		// 不应反向阻挡 sessions.get 已经成功拉到的服务端消息覆盖 + dropRun 释放
		// streamingMsgs。否则 streamingMsgs 与 server 持久化消息会同时被合并，
		// groupSessionMessages 因 streamingMsgs 内残留的 optimisticUser 把"流式 assistant"
		// 与"持久化 assistant"切成两个独立 botTask（截图症状："思考中" + "已思考" 并存）。
		test('endReason=failed + sessions.get 成功 + chat.history 失败：仍 dropRun（chat.history 是辅助 RPC）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			let agentReject = null;
			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-2bot' });
					return new Promise((_, reject) => { agentReject = reject; });
				}
				if (method === 'sessions.get') {
					return Promise.resolve({
						messages: [
							{ role: 'user', content: [{ type: 'text', text: 'ok' }], timestamp: 1000 },
							{ role: 'assistant', content: [{ type: 'text', text: 'final' }], stopReason: 'end_turn', timestamp: 2000, model: 'mini-m2' },
						],
					});
				}
				if (method === 'chat.history') {
					const err = new Error('DC_CLOSED');
					err.code = 'DC_CLOSED';
					return Promise.reject(err);
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const runsStore = useAgentRunsStore();
			const dropSpy = vi.spyOn(runsStore, 'dropRun');

			const sendPromise = store.sendMessage('ok');
			// 等 onAccepted + register 完成（注册时 streamingMsgs 已含 optimistic user/claw）
			await Promise.resolve();
			await Promise.resolve();
			expect(runsStore.runs['run-2bot']).toBeTruthy();

			// 模拟 DC 死：主 RPC reject → __onRpcFailed → __endRun('failed')
			const err = new Error('rtc lost');
			err.code = 'DC_CLOSED';
			agentReject(err);
			await sendPromise;

			// 等 runPromise.then → __awaitPersistAndDrop → loadMessages 链路 settle
			await vi.waitFor(() => {
				expect(dropSpy).toHaveBeenCalledWith(store.runKey, 'run-2bot');
			});

			// streamingMsgs 已释放：getActiveRun 返回 null
			expect(runsStore.getActiveRun(store.runKey)).toBeNull();
			// allMessages 不再含 streamingMsgs；groupSessionMessages 只输出一个 botTask
			const grouped = groupSessionMessages(store.allMessages);
			const botTasks = grouped.filter((i) => i.type === 'botTask');
			expect(botTasks).toHaveLength(1);
		});

		// 双气泡 bug 慢挂起变体：DC 抖动事故路径下 chat.history 不一定立即 reject，
		// 也可能挂起到 60s timeout 才返回。dropRun 必须在 sessions.get 主数据落地的
		// 一瞬间就触发，不能等 chat.history——否则双气泡可见窗口最长 60s。
		test('endReason=failed + sessions.get 成功 + chat.history 挂起：sessions.get 落地后立即 dropRun（不等 chat.history）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			let agentReject = null;
			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-hang' });
					return new Promise((_, reject) => { agentReject = reject; });
				}
				if (method === 'sessions.get') {
					return Promise.resolve({
						messages: [
							{ role: 'user', content: [{ type: 'text', text: 'q' }], timestamp: 1000 },
							{ role: 'assistant', content: [{ type: 'text', text: 'a' }], stopReason: 'end_turn', timestamp: 2000 },
						],
					});
				}
				if (method === 'chat.history') {
					// 挂起：永不 resolve / reject——模拟事故路径下 chat.history 慢挂起到 timeout
					return new Promise(() => {});
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const runsStore = useAgentRunsStore();
			const dropSpy = vi.spyOn(runsStore, 'dropRun');

			const sendPromise = store.sendMessage('q');
			await Promise.resolve();
			await Promise.resolve();
			expect(runsStore.runs['run-hang']).toBeTruthy();

			const err = new Error('rtc lost');
			err.code = 'DC_CLOSED';
			agentReject(err);
			await sendPromise;

			// dropRun 必须在 chat.history 仍挂起时就被调用——hook 在 sessions.get 落地时同步触发
			await vi.waitFor(() => {
				expect(dropSpy).toHaveBeenCalledWith(store.runKey, 'run-hang');
			});
			expect(runsStore.getActiveRun(store.runKey)).toBeNull();

			// chat.history 仍挂起，但 dropRun 已发——force 路径不进 __silentLoadPromise，
			// 这里断言 sessions.get 已被 force 路径调过且 chat.history 还卡着
			const sessionsGetCalls = conn.request.mock.calls.filter(c => c[0] === 'sessions.get');
			const chatHistoryCalls = conn.request.mock.calls.filter(c => c[0] === 'chat.history');
			expect(sessionsGetCalls.length).toBeGreaterThanOrEqual(1);
			expect(chatHistoryCalls.length).toBeGreaterThanOrEqual(1);
		});

		// stale-A 抗性：__awaitPersistAndDrop 必须用 force 路径绕过飞行守卫，
		// 否则会复用一个 sessions.get 早就拉过的 silent reload，那个 reload 的快照
		// 不含本 run 的回复——hook 同步触发 dropRun 删 streamingMsgs，本 run 整段消失。
		test('__awaitPersistAndDrop bypasses flight guard: 即使有 stale silent reload 在飞，仍发独立 fresh sessions.get', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			let agentReject = null;
			const chatHistoryRejects = [];
			let externalSessionsGetCalls = 0;
			let forceSessionsGetCalls = 0;
			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-stale' });
					return new Promise((_, reject) => { agentReject = reject; });
				}
				if (method === 'sessions.get') {
					// 第一次 = 外部 silent reload（拉的是 run 之前的状态，不含 q/a）
					// 第二次 = __awaitPersistAndDrop force 路径（拉到 q + a 完整状态）
					if (externalSessionsGetCalls === 0) {
						externalSessionsGetCalls++;
						return Promise.resolve({ messages: [] });
					}
					forceSessionsGetCalls++;
					return Promise.resolve({
						messages: [
							{ role: 'user', content: [{ type: 'text', text: 'q' }], timestamp: 1000 },
							{ role: 'assistant', content: [{ type: 'text', text: 'a' }], stopReason: 'end_turn', timestamp: 2000 },
						],
					});
				}
				if (method === 'chat.history') {
					// 卡住——所有 chat.history 调用各自创建独立 reject 收进数组，
					// 测试结尾统一 reject，避免任何一条 promise 漏 settle 让测试 hang
					return new Promise((_, reject) => { chatHistoryRejects.push(reject); });
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const runsStore = useAgentRunsStore();
			const dropSpy = vi.spyOn(runsStore, 'dropRun');

			// 1. 起一个外部 silent reload（无 hook，模拟 activate / connReady），sessions.get 即刻返回空
			const externalReload = store.loadMessages({ silent: true });
			await vi.waitFor(() => {
				expect(externalSessionsGetCalls).toBe(1);
			});
			// 外部 reload 已写完 messages（空），卡在 chat.history
			expect(store.__silentLoadPromise).not.toBeNull();

			// 2. 起 sendMessage + 触发 run 终态
			const sendPromise = store.sendMessage('q');
			await Promise.resolve();
			await Promise.resolve();
			expect(runsStore.runs['run-stale']).toBeTruthy();
			const err = new Error('rtc lost');
			err.code = 'DC_CLOSED';
			agentReject(err);
			await sendPromise;

			// 3. force 路径独立发了一次 fresh sessions.get，并基于 fresh 数据触发 hook
			await vi.waitFor(() => {
				expect(forceSessionsGetCalls).toBe(1);
				expect(dropSpy).toHaveBeenCalledWith(store.runKey, 'run-stale');
			});
			expect(runsStore.getActiveRun(store.runKey)).toBeNull();

			// 4. this.messages 来自 force 路径的 fresh 快照，包含 run 的回复
			expect(store.messages.some(m => m.message?.role === 'assistant')).toBe(true);

			// 5. 外部 reload 还在飞行（force 没有绑定到外部 promise 上，证明走的是独立 doLoad）
			expect(store.__silentLoadPromise).not.toBeNull();

			// 收尾：统一 reject 所有挂起的 chat.history（外部 reload + force load 各一条）
			for (const r of chatHistoryRejects) r(new Error('cleanup'));
			await externalReload;
		});

		// 翻历史 + force 路径写 messages 的并发竞争（TODO #3 第 5 轮 review 补）：
		// 用户向上翻历史（loadOlderMessages 拉更长列表）与 run 终态 force 路径同时落地，
		// 谁后写谁覆盖前一个的 messages。验证最终列表仍包含本 run 的回复——前提是
		// loadOlderMessages 拉的"更长 N 条"本来就含本 run 终态消息（server 端的事）。
		// 若未来 loadOlderMessages 的 localMsgs 过滤逻辑变化导致丢数据，本测试会 fail。
		test('翻历史 + force 路径并发写 messages：loadOlderMessages 后落地仍保留本 run 的回复', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			let agentReject = null;
			let olderSessResolve = null;
			let forceSessResolve = null;
			let sessGetCallCount = 0;
			const chatHistoryRejects = [];
			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-older' });
					return new Promise((_, reject) => { agentReject = reject; });
				}
				if (method === 'sessions.get') {
					sessGetCallCount++;
					// 第 1 次 = loadOlderMessages（先发起）；第 2 次 = force 路径
					if (sessGetCallCount === 1) {
						return new Promise((res) => { olderSessResolve = res; });
					}
					return new Promise((res) => { forceSessResolve = res; });
				}
				if (method === 'chat.history') {
					return new Promise((_, reject) => { chatHistoryRejects.push(reject); });
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			// 让 loadOlderMessages 能进入 RPC 路径（绕过 hasMoreMessages 守卫）
			store.__loadedMsgLimit = 50;
			store.hasMoreMessages = true;

			const runsStore = useAgentRunsStore();
			const dropSpy = vi.spyOn(runsStore, 'dropRun');

			// 1. 起 sendMessage 让 run register 起来
			const sendPromise = store.sendMessage('q');
			await Promise.resolve();
			await Promise.resolve();
			expect(runsStore.runs['run-older']).toBeTruthy();

			// 2. 用户向上翻历史 → loadOlderMessages 发出 sessions.get（pending）
			const olderPromise = store.loadOlderMessages();
			await vi.waitFor(() => { expect(olderSessResolve).not.toBeNull(); });

			// 3. run 终态 → __awaitPersistAndDrop 触发 force 路径 sessions.get（pending）
			const err = new Error('rtc lost');
			err.code = 'DC_CLOSED';
			agentReject(err);
			await sendPromise;
			await vi.waitFor(() => { expect(forceSessResolve).not.toBeNull(); });

			// 4. 让 force 路径先 resolve（fresh + hook 触发 dropRun）
			forceSessResolve({
				messages: [
					{ role: 'user', content: [{ type: 'text', text: 'q' }], timestamp: 1000 },
					{ role: 'assistant', content: [{ type: 'text', text: 'a' }], stopReason: 'end_turn', timestamp: 2000 },
				],
			});
			await vi.waitFor(() => {
				expect(dropSpy).toHaveBeenCalledWith(store.runKey, 'run-older');
			});

			// 5. loadOlderMessages 后 resolve（更长 N 条，仍含本 run 的 q/a）
			olderSessResolve({
				messages: [
					{ role: 'user', content: [{ type: 'text', text: 'old-q' }], timestamp: 100 },
					{ role: 'assistant', content: [{ type: 'text', text: 'old-a' }], timestamp: 200 },
					{ role: 'user', content: [{ type: 'text', text: 'q' }], timestamp: 1000 },
					{ role: 'assistant', content: [{ type: 'text', text: 'a' }], stopReason: 'end_turn', timestamp: 2000 },
				],
			});
			await olderPromise;

			// 6. 最终 messages 仍含本 run 的 'a'（loadOlderMessages 后写不丢数据）
			const hasFinalAssistant = store.messages.some(m =>
				m.message?.role === 'assistant' && m.message?.content?.[0]?.text === 'a'
			);
			expect(hasFinalAssistant).toBe(true);

			// 收尾：reject 挂起的 chat.history
			for (const r of chatHistoryRejects) r(new Error('cleanup'));
		});

		// force 路径错误流（第 5 轮 review 补）：
		// run 终态触发 force 路径，sessions.get 失败 → hook 不触发 + ok=false → dropRun 不调，
		// run 仍存活、streamingMsgs 残留（等下次 chat 重建自愈，详见 TODO.md #2）。
		// 与现有 'endReason=wait + silent loadMessages 失败' 测试覆盖的是非 force 路径，
		// 本条专门覆盖 force 路径下的错误流不会误删消息。
		test('force 路径 sessions.get 失败：不调 dropRun，run 仍存活', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			let agentReject = null;
			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-fail' });
					return new Promise((_, reject) => { agentReject = reject; });
				}
				if (method === 'sessions.get') {
					return Promise.reject(new Error('network down'));
				}
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'sess-1' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const runsStore = useAgentRunsStore();
			const dropSpy = vi.spyOn(runsStore, 'dropRun');

			const sendPromise = store.sendMessage('q');
			await Promise.resolve();
			await Promise.resolve();
			expect(runsStore.runs['run-fail']).toBeTruthy();

			const err = new Error('rtc lost');
			err.code = 'DC_CLOSED';
			agentReject(err);
			await sendPromise;

			// 等 force 路径的 sessions.get 已发出（且已失败 settle）
			await vi.waitFor(() => {
				expect(conn.request.mock.calls.some(c => c[0] === 'sessions.get')).toBe(true);
			});
			// 给 then/catch 链跑完
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();

			// sessions.get 失败 → 既无 hook 触发也无 ok=true 兜底 → dropRun 不被调
			expect(dropSpy).not.toHaveBeenCalled();
			// run 仍存活（streamingMsgs 残留，TODO #2 已记录的预存缺陷）
			expect(runsStore.getActiveRun(store.runKey)).not.toBeNull();
		});

		// topic 模式 force 路径仍能 dropRun（第 5 轮 review 补）：
		// topic 模式 run 终态：__awaitPersistAndDrop force 路径走 __loadTopicMessages，
		// topic 没有 chat.history 也不走 onMessagesPersisted hook，但应通过 ok=true 兜底
		// 调 dropRun 释放 streamingMsgs。验证 topic 与 chat 模式行为对齐。
		test('topic 模式 force 路径仍能 dropRun：__loadTopicMessages 成功后走 ok=true 兜底', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			let agentReject = null;
			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-topic' });
					return new Promise((_, reject) => { agentReject = reject; });
				}
				if (method === 'coclaw.sessions.getById') {
					return Promise.resolve({
						messages: [
							{ role: 'user', content: [{ type: 'text', text: 'q' }], timestamp: 1000 },
							{ role: 'assistant', content: [{ type: 'text', text: 'a' }], stopReason: 'end_turn', timestamp: 2000 },
						],
					});
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = createChatStore('topic:t-bubble', { clawId: '1', agentId: 'main' });

			const runsStore = useAgentRunsStore();
			const dropSpy = vi.spyOn(runsStore, 'dropRun');

			const sendPromise = store.sendMessage('q');
			await Promise.resolve();
			await Promise.resolve();
			expect(runsStore.runs['run-topic']).toBeTruthy();

			const err = new Error('rtc lost');
			err.code = 'DC_CLOSED';
			agentReject(err);
			await sendPromise;

			// topic 模式无 hook，但走 ok=true 兜底路径仍调 dropRun
			await vi.waitFor(() => {
				expect(dropSpy).toHaveBeenCalledWith(store.runKey, 'run-topic');
			});
			expect(runsStore.getActiveRun(store.runKey)).toBeNull();

			// 走 topic 路径：用 coclaw.sessions.getById，不走 sessions.get / chat.history
			const topicLoadCalls = conn.request.mock.calls.filter(c => c[0] === 'coclaw.sessions.getById');
			expect(topicLoadCalls.length).toBeGreaterThanOrEqual(1);
			const chatModeCalls = conn.request.mock.calls.filter(
				c => c[0] === 'sessions.get' || c[0] === 'chat.history'
			);
			expect(chatModeCalls.length).toBe(0);
		});
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
	// bumpActivity（让 MainList 立刻浮顶）
	// =====================================================================

	describe('bump on send', () => {
		test('chat 模式 sendMessage 入口给 sessionsStore 写 bumpedAt', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, _params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'r-1' });
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 's' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const before = Date.now();
			await store.sendMessage('hi');
			const after = Date.now();

			const sessionsStore = useSessionsStore();
			const item = sessionsStore.items.find((s) => s.clawId === '1' && s.agentId === 'main');
			expect(item).toBeTruthy();
			expect(item.bumpedAt).toBeGreaterThanOrEqual(before);
			expect(item.bumpedAt).toBeLessThanOrEqual(after);
		});

		test('topic 模式 sendMessage 不 bump（topic 不在 agent 列表）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, _params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'r-1' });
					return Promise.resolve({ status: 'ok' });
				}
				if (method === 'coclaw.sessions.getById') return Promise.resolve({ messages: [] });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = createChatStore('topic:t-1', { clawId: '1', agentId: 'main' });
			const sessionsStore = useSessionsStore();
			const spy = vi.spyOn(sessionsStore, 'bumpActivity');

			await store.sendMessage('topic msg');

			// 强断言：bumpActivity 完全没被调用（length 0 在 storeKey 解析失败时也成立，会假阳性）
			expect(spy).not.toHaveBeenCalled();
		});

		test('pre-acceptance 失败（断连等）不留下幻影 bumpedAt', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			// agent RPC reject 模拟 pre-acceptance 失败（DC 断、连接超时等）
			conn.request.mockImplementation((method) => {
				if (method === 'agent') return Promise.reject(Object.assign(new Error('disconnect'), { code: 'DC_CLOSED' }));
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			// 关掉自动重试以确保走失败路径
			store.__retried = true;

			await expect(store.sendMessage('hi')).rejects.toBeTruthy();

			const sessionsStore = useSessionsStore();
			const item = sessionsStore.items.find((s) => s.clawId === '1' && s.agentId === 'main');
			// 没 accepted → 不应有任何 bump 痕迹
			expect(item).toBeUndefined();
		});

		test('sendSlashCommand 在 chat.send 成功后才 bump', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockResolvedValue({ runId: 'slash-1', status: 'started' });
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const before = Date.now();
			const p = store.sendSlashCommand('/help');
			// 让 chat.send 的 mockResolvedValue microtask 跑完，bumpActivity 才会触发
			await Promise.resolve();
			await Promise.resolve();
			const after = Date.now();

			const sessionsStore = useSessionsStore();
			const item = sessionsStore.items.find((s) => s.clawId === '1' && s.agentId === 'main');
			expect(item).toBeTruthy();
			expect(item.bumpedAt).toBeGreaterThanOrEqual(before);
			expect(item.bumpedAt).toBeLessThanOrEqual(after);

			// 收尾：触发 final 事件让 promise 自然 settle
			const handler = conn.on.mock.calls.find((c) => c[0] === 'event:chat')[1];
			handler({ runId: store.__slashCommandRunId, state: 'final' });
			await p;
		});

		test('sendSlashCommand chat.send 失败不留下 bumpedAt', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockRejectedValue(Object.assign(new Error('boom'), { code: 'WS_CLOSED' }));
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			await expect(store.sendSlashCommand('/help')).rejects.toBeTruthy();

			const sessionsStore = useSessionsStore();
			expect(sessionsStore.items).toHaveLength(0);
		});

		test('topic 模式 sendSlashCommand 不 bump（与 sendMessage 对称）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockResolvedValue({ runId: 'slash-topic', status: 'started' });
			setConn('1', conn);

			const store = createChatStore('topic:t-1', { clawId: '1', agentId: 'main' });
			const sessionsStore = useSessionsStore();
			const spy = vi.spyOn(sessionsStore, 'bumpActivity');

			const p = store.sendSlashCommand('/help');
			// 让 chat.send 的 mockResolvedValue microtask 跑完
			await Promise.resolve();
			await Promise.resolve();

			// 强断言：bumpActivity 完全没被调用（topicMode 守卫生效）
			expect(spy).not.toHaveBeenCalled();

			// 收尾：触发 final 事件让 promise 自然 settle
			const handler = conn.on.mock.calls.find((c) => c[0] === 'event:chat')[1];
			handler({ runId: store.__slashCommandRunId, state: 'final' });
			await p;
		});

		test('pre-accept 超时后迟到的 onAccepted 不再触发 bump（preAcceptInvalidated 守卫）', async () => {
			vi.useFakeTimers();
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			let capturedOnAccepted;
			const conn = mockConn();
			conn.request.mockImplementation((method, _params, options) => {
				if (method === 'agent') {
					// 捕获 onAccepted 但不立即触发——模拟 server 长时间没回 accepted
					capturedOnAccepted = options?.onAccepted;
					return new Promise(() => {}); // 永不 settle，配合超时路径
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 's' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			// 触发 sendMessage（不 await：超时会 reject）
			const sendP = store.sendMessage('hi').catch(() => {});

			// 推进 180s 触发 pre-acceptance 超时
			await vi.advanceTimersByTimeAsync(180_001);
			// 此时 sendMessage 已 reject 走 catch 清理了
			await sendP;

			// 后到的 accepted 来了：迟到回调被守卫挡住
			expect(capturedOnAccepted).toBeTypeOf('function');
			capturedOnAccepted({ runId: 'late-r-1' });

			const sessionsStore = useSessionsStore();
			expect(sessionsStore.items).toHaveLength(0);
			vi.useRealTimers();
		});

		test('用户在 pre-accept 期间点 STOP，accepted 到达后不 bump（cancelIntent 守卫）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			let capturedOnAccepted;
			const conn = mockConn();
			conn.request.mockImplementation((method, _params, options) => {
				if (method === 'agent') {
					capturedOnAccepted = options?.onAccepted;
					return new Promise(() => {});
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 's' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			// fire-and-forget：sendMessage 在测试场景下无法自然 settle（runPromise / timeout / cancel 都不到），
			// 我们只关心 onAccepted 触发后的同步状态，不需要等 sendMessage resolve。
			// .catch 兜底 unhandled rejection（store 实例的 dispose 在测试 afterEach 触发时会让 promise 走 cancelReject）
			const _sendP = store.sendMessage('hi').catch(() => {});
			void _sendP;
			await Promise.resolve();
			// 用户点 STOP（pre-accept 阶段，仅挂起 cancel 意图）
			store.cancelSend();
			expect(store.__pendingCancelIntent).toBe(true);

			// accepted 到达
			expect(capturedOnAccepted).toBeTypeOf('function');
			capturedOnAccepted({ runId: 'r-cancel' });

			const sessionsStore = useSessionsStore();
			// 用户已决定取消 → 不应该浮顶
			expect(sessionsStore.items).toHaveLength(0);
		});
	});

	// =====================================================================
	// cancelSend
	// =====================================================================

	describe('cancelSend', () => {
		test('pre-accept（RPC 在飞、等 accepted）取消：挂起意图、保留气泡、sending 不变', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			// agent RPC 永不触发 onAccepted，也永不 resolve → 模拟真实"在飞"状态
			conn.request.mockImplementation((method) => {
				if (method === 'agent') return new Promise(() => {});
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-1';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			let sendResolved = false;
			const sendPromise = store.sendMessage('hello').then((r) => { sendResolved = true; return r; });
			// 等 sendMessage 走到 await Promise.race 的位置（乐观消息已追加、__cancelReject 已就绪）
			await vi.waitFor(() => expect(store.__cancelReject).not.toBeNull());

			expect(store.sending).toBe(true);
			expect(store.__accepted).toBe(false);
			expect(store.messages.some((m) => m._local)).toBe(true);

			expect(store.cancelSend()).toBeNull();

			// 挂起意图标志置位；isCancelling getter 反映出来
			expect(store.__pendingCancelIntent).toBe(true);
			expect(store.isCancelling).toBe(true);
			// 气泡保留、sending 仍 true（STOP 按钮依旧显示且被禁用）
			expect(store.messages.some((m) => m._local)).toBe(true);
			expect(store.sending).toBe(true);
			// sendMessage 不立即 resolve——等 onAccepted / 超时 / 断连
			await Promise.resolve(); await Promise.resolve();
			expect(sendResolved).toBe(false);
			// 未发起 abort RPC（没有 sid 可用、且 run 尚未 accepted）
			const abortCalls = conn.request.mock.calls.filter(c => c[0] === 'coclaw.agent.abort');
			expect(abortCalls).toHaveLength(0);

			// 清理 pending sendPromise
			store.cleanup();
			await expect(sendPromise).resolves.toEqual({ accepted: false });
		});

		test('pre-accept 挂意图后 cancelSend 幂等：第二次点击不抛错、标志位保持', async () => {
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

			store.sendMessage('hi');
			await vi.waitFor(() => expect(store.__cancelReject).not.toBeNull());

			expect(store.cancelSend()).toBeNull();
			expect(store.__pendingCancelIntent).toBe(true);
			// 幂等：第二次仍返回 null，不抛错
			expect(store.cancelSend()).toBeNull();
			expect(store.__pendingCancelIntent).toBe(true);

			store.cleanup();
		});

		test('pre-accept 挂意图后 onAccepted 到达：立刻转交 accepted 分支发 abort RPC', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			let triggerOnAccepted;
			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					triggerOnAccepted = () => options?.onAccepted?.({ runId: 'run-handoff' });
					return new Promise(() => {});
				}
				if (method === 'coclaw.agent.abort') {
					return Promise.resolve({ ok: true });
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-handoff';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			store.sendMessage('hi');
			await vi.waitFor(() => expect(store.__cancelReject).not.toBeNull());

			// 用户在 accepted 之前点 STOP → 挂意图
			expect(store.cancelSend()).toBeNull();
			expect(store.__pendingCancelIntent).toBe(true);
			expect(store.isCancelling).toBe(true);

			// 服务端终于回了 accepted
			triggerOnAccepted();
			await Promise.resolve();

			// 意图已被消费，__cancelling 协调任务已启动并触发 abort RPC
			expect(store.__pendingCancelIntent).toBe(false);
			expect(store.__accepted).toBe(true);
			await vi.waitFor(() => {
				const abortCalls = conn.request.mock.calls.filter(c => c[0] === 'coclaw.agent.abort');
				expect(abortCalls.length).toBeGreaterThan(0);
				expect(abortCalls[0][1]).toEqual({
					sessionId: 'sess-handoff',
					runDuration: expect.any(Number),
					abortDuration: expect.any(Number),
				});
			});
			// run 已进入 settling(cancel) 状态
			const runsStore = useAgentRunsStore();
			const run = runsStore.getActiveRun(store.runKey);
			expect(run?.cancelled).toBe(true);

			store.cleanup();
		});

		test('pre-accept 挂意图后调 cleanup()：意图清除', async () => {
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

			const sendPromise = store.sendMessage('hi');
			await vi.waitFor(() => expect(store.__cancelReject).not.toBeNull());
			store.cancelSend();
			expect(store.__pendingCancelIntent).toBe(true);

			store.cleanup();
			expect(store.__pendingCancelIntent).toBe(false);
			await expect(sendPromise).resolves.toEqual({ accepted: false });
		});

		test('pre-accept 挂意图后 pre-acceptance timeout 触发：意图清除', async () => {
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
			store.sessionId = 'sess-timeout';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			const sendPromise = store.sendMessage('hi').catch((e) => e);
			await vi.waitFor(() => expect(store.__cancelReject).not.toBeNull());
			store.cancelSend();
			expect(store.__pendingCancelIntent).toBe(true);

			// 180s 预发超时触发：catch 块顶部清意图 + 抛 PRE_ACCEPTANCE_TIMEOUT
			await vi.advanceTimersByTimeAsync(180_000);
			const err = await sendPromise;
			expect(err?.code).toBe('PRE_ACCEPTANCE_TIMEOUT');
			expect(store.__pendingCancelIntent).toBe(false);
			expect(store.sending).toBe(false);
		});

		test('pre-accept 挂意图后 DC 断连触发 retry：意图清除', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			let agentCall = 0;
			let firstReject;
			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					agentCall++;
					if (agentCall === 1) {
						// 可控的 pending 拒绝：测试在 cancelSend 挂意图之后再触发 reject
						return new Promise((_, reject) => { firstReject = reject; });
					}
					// 第二次（retry）直接回 accepted（不触发 handoff，因意图已被 catch 清除）
					options?.onAccepted?.({ runId: 'run-retry' });
					return new Promise(() => {});
				}
				if (method === 'sessions.get') return Promise.resolve({ messages: [] });
				if (method === 'chat.history') return Promise.resolve({ sessionId: 'sess-retry' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.sessionId = 'sess-retry';
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			store.sendMessage('hi');
			await vi.waitFor(() => expect(store.__cancelReject).not.toBeNull());

			// 用户点 STOP → 挂意图
			store.cancelSend();
			expect(store.__pendingCancelIntent).toBe(true);

			// 触发 DC_CLOSED → catch 清意图 → 走 retry → 第二次 agent 调用回 accepted
			const err = new Error('DC closed'); err.code = 'DC_CLOSED';
			firstReject(err);

			await vi.waitFor(() => expect(agentCall).toBe(2));
			// retry 后意图清除，且第二轮 onAccepted 下意图为 false 不触发 handoff
			expect(store.__pendingCancelIntent).toBe(false);
			expect(store.__accepted).toBe(true);

			store.cleanup();
		});

		test('pre-accept 挂意图后再 send 被 __clearCancelling(superseded) 清除', async () => {
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

			store.sendMessage('first');
			await vi.waitFor(() => expect(store.__cancelReject).not.toBeNull());
			store.cancelSend();
			expect(store.__pendingCancelIntent).toBe(true);

			// sending=true 下新 send 会被早退；手动释放后再触发以模拟"用户清了输入又发"的路径
			store.sending = false;
			store.__clearCancelling('superseded');
			expect(store.__pendingCancelIntent).toBe(false);
		});

		test('accepted 之后取消：不终止服务端 run，保留 streamingMsgs、run 进入 settling(reason=cancel)、sending=false', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-cancel' });
					return new Promise(() => {}); // 模拟 run 仍在服务端运行
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

			// 不 await sendPromise（服务端永不返回）
			store.sendMessage('hello');
			await Promise.resolve();

			expect(store.__accepted).toBe(true);

			const runsStore = useAgentRunsStore();
			const runKey = store.runKey;
			// accepted 后乐观消息已移入 streamingMsgs
			expect(runsStore.getActiveRun(runKey)?.streamingMsgs?.length).toBeGreaterThan(0);

			const reconcileSpy = vi.spyOn(store, '__reconcileMessages');
			const cancelRejectBefore = store.__cancelReject;
			const rejectSpy = vi.fn();
			// 包一层 spy 以精准验证 reject 未被调用
			store.__cancelReject = (err) => { rejectSpy(err); cancelRejectBefore(err); };

			store.cancelSend();

			// cancelSend 不立即 reconcile（等真终态信号 rpc/wait/failed 驱动）
			expect(reconcileSpy).not.toHaveBeenCalled();
			// cancelPromise 未被 reject；cancelSend accepted 分支显式 nullify 槽位
			expect(rejectSpy).not.toHaveBeenCalled();
			expect(store.__cancelReject).toBeNull();
			// run 进入 settling 过渡态，streamingMsgs 仍保留
			const run = runsStore.getActiveRun(runKey);
			expect(run).not.toBeNull();
			expect(run.cancelled).toBe(true);
			expect(run.ended).toBe(false);
			expect(run.streamingMsgs.length).toBeGreaterThan(0);
			// UI 本地状态解挂
			expect(store.sending).toBe(false);
			expect(store.__streamingTimer).toBeNull();
			// isRunning 仍为 true（run 未 settled），所以 isSending 仍为 true，输入框依然禁用
			expect(runsStore.isRunning(runKey)).toBe(true);
			expect(store.isSending).toBe(true);
			// 插件侧门 RPC 被触发，sessionId 用 store.sessionId；duration 字段类型校验
			expect(conn.request).toHaveBeenCalledWith('coclaw.agent.abort', {
				sessionId: 'sess-1',
				runDuration: expect.any(Number),
				abortDuration: expect.any(Number),
			});
		});

		test('accepted 后取消 chat 模式：sessionId 为空时退回 currentSessionId', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-chat' });
					return new Promise(() => {});
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			// chat 模式下 sessionId 是空串，loadMessages 后 currentSessionId 才被填充
			store.sessionId = '';
			store.currentSessionId = 'cur-sess-42';

			store.sendMessage('hello');
			await Promise.resolve();
			expect(store.__accepted).toBe(true);

			store.cancelSend();

			expect(conn.request).toHaveBeenCalledWith('coclaw.agent.abort', {
				sessionId: 'cur-sess-42',
				runDuration: expect.any(Number),
				abortDuration: expect.any(Number),
			});
		});

		test('accepted 后取消：sessionId 与 currentSessionId 均不可知时跳过 abort RPC', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-nosid' });
					return new Promise(() => {});
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.sessionId = '';
			store.currentSessionId = null;

			store.sendMessage('hello');
			await Promise.resolve();
			expect(store.__accepted).toBe(true);

			store.cancelSend();

			const abortCalls = conn.request.mock.calls.filter(c => c[0] === 'coclaw.agent.abort');
			expect(abortCalls).toHaveLength(0);
			// 前端降级到纯阶段 1 行为：settling(cancel)、streamingMsgs 保留
			const runsStore = useAgentRunsStore();
			const run = runsStore.getActiveRun(store.runKey);
			expect(run?.cancelled).toBe(true);
		});

		test('accepted 后取消：cancelSend 返回 RPC promise，resolve 值透传给调用方', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-ret' });
					return new Promise(() => {});
				}
				if (method === 'coclaw.agent.abort') {
					return Promise.resolve({ ok: false, reason: 'not-supported' });
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.sessionId = 'sess-ret';

			store.sendMessage('hi');
			await Promise.resolve();
			expect(store.__accepted).toBe(true);

			const p = store.cancelSend();
			expect(p).toBeInstanceOf(Promise);
			await expect(p).resolves.toEqual({ ok: false, reason: 'not-supported' });
		});

		test('未 accepted 取消：cancelSend 返回 null', () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.sending = true;
			store.__accepted = false;

			expect(store.cancelSend()).toBeNull();
		});

		test('accepted 后取消：abort RPC reject 时 tick 继续重试（直到 run 结束）', async () => {
			vi.useFakeTimers();
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			let abortAttempts = 0;
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-reject' });
					return new Promise(() => {});
				}
				if (method === 'coclaw.agent.abort') {
					abortAttempts++;
					return Promise.reject(new Error('WS_CLOSED'));
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.sessionId = 'sess-reject';

			store.sendMessage('hi');
			await Promise.resolve();

			const p = store.cancelSend();
			// 微任务 flush：首次 tick 的 RPC reject → catch → 调度 500ms 重试
			await Promise.resolve(); await Promise.resolve();
			expect(abortAttempts).toBe(1);
			// 500ms 后第二次 tick 触发新 RPC（再次 reject）
			await vi.advanceTimersByTimeAsync(500);
			await Promise.resolve();
			expect(abortAttempts).toBe(2);
			// 模拟 run 自然结束：清除 agentRunsStore 中的 run
			const runsStore = useAgentRunsStore();
			runsStore.settle(store.runKey);
			// 下次 tick 检测 isRunning=false → 以 run-ended 结束
			await vi.advanceTimersByTimeAsync(500);
			await expect(p).resolves.toEqual({ ok: false, reason: 'run-ended' });
			expect(store.__cancelling).toBeNull();
		});

		test('accepted 取消但 sessionId 不可知：cancelSend 返回 null', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-null' });
					return new Promise(() => {});
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.sessionId = '';
			store.currentSessionId = null;

			store.sendMessage('hi');
			await Promise.resolve();

			expect(store.cancelSend()).toBeNull();
		});

		test('accepted 取消但 conn 不可用：cancelSend 返回 null（仍进入 settling(cancel)）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-noconn' });
					return new Promise(() => {});
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.sessionId = 'sess-noconn';

			store.sendMessage('hi');
			await Promise.resolve();
			expect(store.__accepted).toBe(true);

			// 模拟 WS 断连：conn 已从 claw-connection-manager 移除
			mockConnections.clear();

			expect(store.cancelSend()).toBeNull();
			// run 仍进入 settling(cancel)，等待 rpc/wait/failed 终态或 24h fallback
			const runsStore = useAgentRunsStore();
			const run = runsStore.getActiveRun(store.runKey);
			expect(run?.cancelled).toBe(true);
		});

		test('accepted 后第二次 cancelSend：幂等——返回同一 promise，RPC 不重复触发', async () => {
			vi.useFakeTimers();
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			let abortCallCount = 0;
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-double' });
					return new Promise(() => {});
				}
				if (method === 'coclaw.agent.abort') {
					abortCallCount++;
					// 永不 resolve，让 tick 调度等待
					return new Promise(() => {});
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.sessionId = 'sess-double';

			store.sendMessage('hi');
			await Promise.resolve();
			expect(store.__accepted).toBe(true);

			const first = store.cancelSend();
			expect(first).toBeInstanceOf(Promise);
			expect(store.isCancelling).toBe(true);
			// 首次 tick 同步已发 RPC（返回 never-resolving promise）
			await Promise.resolve(); await Promise.resolve();
			expect(abortCallCount).toBe(1);

			// 第二次点击 STOP（双击场景）—— UI 在 isCancelling=true 下禁用按钮，
			// 但仍保留内部幂等保护：返回同一 cancel 协调 promise（Pinia 反射代理下用 toStrictEqual），
			// 关键是 RPC 不重复发
			const second = store.cancelSend();
			expect(second).toStrictEqual(first);
			expect(abortCallCount).toBe(1);
		});

		// 阶段 2.9 回归：cancel 协调以 immediate 收尾后，__cancelling 已清，
		// 但服务端 run 真终态信号尚未到达时（cancelled=true / !ended），
		// isCancelling 兜底要保持 true，避免按钮假活。
		test('cancel 协调以 immediate 收尾后，run 未 ended 期间 isCancelling 仍 true（按钮持续 disable）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			let abortCalls = 0;
			let agentReject;
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-stuck' });
					// agent RPC 永不 resolve：模拟"终态信号尚未到达"的窗口
					return new Promise((_, rej) => { agentReject = rej; });
				}
				if (method === 'coclaw.agent.abort') {
					abortCalls++;
					return Promise.resolve({ ok: true });
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.sessionId = 'sess-stuck';

			store.sendMessage('hi');
			await Promise.resolve();
			expect(store.__accepted).toBe(true);
			expect(store.isCancelling).toBe(false);

			// 用户点 STOP → 协调首 tick 拿到 ok=true → done immediate，__cancelling 清
			const p1 = store.cancelSend();
			await expect(p1).resolves.toEqual({ ok: true, aborted: 'immediate' });
			expect(store.__cancelling).toBeNull();
			expect(abortCalls).toBe(1);

			// 终态信号未到达：run 仍 cancelled=true / !ended
			const runsStore = useAgentRunsStore();
			const stuckRun = runsStore.getActiveRun(store.runKey);
			expect(stuckRun?.cancelled).toBe(true);
			expect(stuckRun?.ended).toBe(false);
			expect(runsStore.isRunning(store.runKey)).toBe(true);

			// 关键回归断言：__cancelling 已清，但 isCancelling 兜底仍 true
			// → ChatInput 的 cancelDisabled 保持 true → 按钮 disable + loader icon 不变
			expect(store.__cancelling).toBeNull();
			expect(store.isCancelling, '按钮应继续 disable 直到 run.ended=true').toBe(true);

			// 模拟 run 真终态到达 → run.ended=true → isCancelling 自然翻 false
			runsStore.settle(store.runKey);
			expect(store.isCancelling).toBe(false);

			// 防止悬挂 agent RPC 影响后续测试
			agentReject?.(new Error('test cleanup'));
		});

		// 阶段 2.10 回归：OpenClaw 把 aborted run 的二阶段 res 改成 status='timeout'。
		// ClawConnection 已按"非 accepted 即终态"统一 resolve 透传，agent-runs 走 __onRpcDone
		// 自然收尾，run.ended=true，isCancelling 不再依赖兜底就翻 false。
		test('cancel 后上游回 status=timeout 终态：run 自然 ended，isCancelling 翻 false（阶段 2.10）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			let agentResolve;
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-timeout' });
					return new Promise((res) => { agentResolve = res; });
				}
				if (method === 'coclaw.agent.abort') return Promise.resolve({ ok: true });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.sessionId = 'sess-timeout';

			store.sendMessage('hi');
			await Promise.resolve();

			const p1 = store.cancelSend();
			await expect(p1).resolves.toEqual({ ok: true, aborted: 'immediate' });
			expect(store.isCancelling).toBe(true);

			// 模拟 ClawConnection 收到上游的 status='timeout' 二阶段 res 并 resolve agent RPC
			// （阶段 2.10 修复后这条路径会走通；修复前 unknown 分支静默丢弃 → 永挂）
			agentResolve({
				runId: 'run-timeout',
				status: 'timeout',
				summary: 'aborted',
				stopReason: 'stop',
				result: { meta: { aborted: true, completion: { stopReason: 'stop' } } },
			});
			await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

			const runsStore = useAgentRunsStore();
			const run = runsStore.getActiveRun(store.runKey);
			// run 真终态被 __endRun 写入：ended=true → isRunning=false → isCancelling 兜底失效
			expect(run?.ended).toBe(true);
			expect(runsStore.isRunning(store.runKey)).toBe(false);
			expect(store.isCancelling).toBe(false);
		});

		test('accepted 后取消：hit 立即返回 {ok:true, aborted:immediate}，清除 __cancelling', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-hit' });
					return new Promise(() => {});
				}
				if (method === 'coclaw.agent.abort') return Promise.resolve({ ok: true });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.sessionId = 'sess-hit';

			store.sendMessage('hi');
			await Promise.resolve();

			const p = store.cancelSend();
			expect(store.isCancelling).toBe(true);
			await expect(p).resolves.toEqual({ ok: true, aborted: 'immediate' });
			expect(store.__cancelling).toBeNull();
			// __cancelling 已清，但 isCancelling 兜底（cancelled && !ended）保持 true
			// 直到 run 真终态信号到达——与"按钮 disable + loader icon 不消失"契约对齐
			expect(store.isCancelling).toBe(true);
			expect(remoteLogCalls).toContain('cancel.start sid=sess-hit');
			// ticks=1 是关键证据：tick 头 isRunning 检查通过后立即 RPC，第一次就 hit
			expect(remoteLogCalls).toContain('cancel.immediate sid=sess-hit ticks=1');
		});

		test('accepted 后取消：先 miss（not-found）后 hit —— tick 重试直到 immediate', async () => {
			vi.useFakeTimers();
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			let abortCalls = 0;
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-retry' });
					return new Promise(() => {});
				}
				if (method === 'coclaw.agent.abort') {
					abortCalls++;
					if (abortCalls < 3) return Promise.resolve({ ok: false, reason: 'not-found' });
					return Promise.resolve({ ok: true });
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.sessionId = 'sess-retry';

			store.sendMessage('hi');
			await Promise.resolve();

			const p = store.cancelSend();
			// 第 1 次 tick：RPC + miss → 调度 500ms 重试
			await Promise.resolve(); await Promise.resolve();
			expect(abortCalls).toBe(1);
			expect(store.isCancelling).toBe(true);
			// 推进 500ms：第 2 次 tick
			await vi.advanceTimersByTimeAsync(500);
			await Promise.resolve();
			expect(abortCalls).toBe(2);
			// 再推进 500ms：第 3 次 tick → hit → resolve
			await vi.advanceTimersByTimeAsync(500);
			await expect(p).resolves.toEqual({ ok: true, aborted: 'immediate' });
			expect(store.__cancelling).toBeNull();
		});

		test('accepted 后取消：not-supported 立即收尾本地 run + 不重试', async () => {
			vi.useFakeTimers();
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			let abortCalls = 0;
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-ns' });
					return new Promise(() => {});
				}
				if (method === 'coclaw.agent.abort') {
					abortCalls++;
					return Promise.resolve({ ok: false, reason: 'not-supported' });
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.sessionId = 'sess-ns';

			store.sendMessage('hi');
			await Promise.resolve();

			const p = store.cancelSend();
			await expect(p).resolves.toEqual({ ok: false, reason: 'not-supported' });
			// 推进 500ms 验证不重试
			await vi.advanceTimersByTimeAsync(500);
			expect(abortCalls).toBe(1);
			expect(store.__cancelling).toBeNull();
			expect(remoteLogCalls).toContain('cancel.not-supported sid=sess-ns');
			// 关键：UI 主动 settleByCancel('cancel-not-supported')，本地 run 已 endRun
			const runsStore = useAgentRunsStore();
			expect(runsStore.isRunning(store.runKey)).toBe(false);
			expect(remoteLogCalls).toContain('agent.run.end runId=run-ns reason=cancel-not-supported');
			// store 通过 getSharedNotifier 弹 warning toast（不再由 ChatPage 触发——为了 handoff 路径）
			expect(mockNotifier.warning).toHaveBeenCalledWith({
				title: 'chat.cancelNotSupported',
				description: 'chat.upgradeOpenClawHint',
			});
		});

		test('accepted 后取消：plugin 返回 gone（启发判定 run 已结束）→ 主动 settleByCancel + 不重试', async () => {
			vi.useFakeTimers();
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			let abortCalls = 0;
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-gone' });
					return new Promise(() => {});
				}
				if (method === 'coclaw.agent.abort') {
					abortCalls++;
					return Promise.resolve({ ok: false, reason: 'gone' });
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.sessionId = 'sess-gone';

			store.sendMessage('hi');
			await Promise.resolve();

			const p = store.cancelSend();
			await expect(p).resolves.toEqual({ ok: false, reason: 'gone' });
			// 不重试
			await vi.advanceTimersByTimeAsync(500);
			expect(abortCalls).toBe(1);
			expect(store.__cancelling).toBeNull();
			// UI 主动 settleByCancel('cancel-gone')，本地 run 已 endRun
			const runsStore = useAgentRunsStore();
			expect(runsStore.isRunning(store.runKey)).toBe(false);
			expect(remoteLogCalls).toContain('agent.run.end runId=run-gone reason=cancel-gone');
			// cancel.gone remoteLog 携带 ticks + 两个 duration 字段
			const goneLog = remoteLogCalls.find((t) => t.startsWith('cancel.gone sid=sess-gone'));
			expect(goneLog).toBeTruthy();
			expect(goneLog).toContain('ticks=1');
			expect(goneLog).toMatch(/runDur=\d+/);
			expect(goneLog).toMatch(/abortDur=\d+/);
			// store 通过 getSharedNotifier 弹 info toast（不再由 ChatPage 触发——为了 handoff 路径）
			expect(mockNotifier.info).toHaveBeenCalledWith({
				title: 'chat.cancelGone',
				description: 'chat.cancelGoneHint',
			});
		});

		test('accepted 后取消：post-await isRunning 守卫 — RPC 飞行中 run 自然结束 + plugin 返 gone → 降级 run-ended，不弹 toast、不再 settleByCancel', async () => {
			vi.useFakeTimers();
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			// abort RPC 用可控的 promise，让我们先模拟 run 自然结束、再让 RPC 返回 gone
			let resolveAbort;
			const abortPromise = new Promise((r) => { resolveAbort = r; });
			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-race' });
					return new Promise(() => {});
				}
				if (method === 'coclaw.agent.abort') return abortPromise;
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.sessionId = 'sess-race';

			store.sendMessage('hi');
			await Promise.resolve();

			const p = store.cancelSend();
			await Promise.resolve(); await Promise.resolve();
			// abort RPC 在飞，tick 阻塞。这时 run 自然结束（模拟 rpc/wait 终态信号到达）
			const runsStore = useAgentRunsStore();
			runsStore.settle(store.runKey);
			// 现在让 RPC 终于返 gone — post-await 守卫应识别 run 已 ended，降级走 run-ended
			resolveAbort({ ok: false, reason: 'gone' });
			await expect(p).resolves.toEqual({ ok: false, reason: 'run-ended' });
			// 守卫上报 fallback 信号
			expect(remoteLogCalls.some((t) => t === 'cancel.run-ended-fallback sid=sess-race rawReason=gone')).toBe(true);
			// 不应弹 gone toast
			expect(mockNotifier.info).not.toHaveBeenCalled();
			// 不应有第二次 'agent.run.end' 上报（第一次是 settle('manual') 触发）
			const endCalls = remoteLogCalls.filter((t) => t.startsWith('agent.run.end runId=run-race'));
			expect(endCalls).toHaveLength(1);
			expect(endCalls[0]).toContain('reason=manual');
		});

		test('accepted 后取消：handoff 路径（pre-accept STOP → onAccepted 内部 cancelSend）下 gone toast 仍能弹', async () => {
			vi.useFakeTimers();
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			let triggerOnAccepted;
			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					triggerOnAccepted = () => options?.onAccepted?.({ runId: 'run-handoff-gone' });
					return new Promise(() => {});
				}
				if (method === 'coclaw.agent.abort') return Promise.resolve({ ok: false, reason: 'gone' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.sessionId = 'sess-handoff-gone';

			store.sendMessage('hi');
			await vi.waitFor(() => expect(store.__cancelReject).not.toBeNull());

			// 用户在 accepted 前点 STOP → 挂意图（cancelSend 返 null）
			expect(store.cancelSend()).toBeNull();
			expect(store.__pendingCancelIntent).toBe(true);

			// onAccepted 触发 → handoff 内部自调 cancelSend → 走 accepted 分支 → 收到 gone
			triggerOnAccepted();
			// 等 handoff cancelSend 的协调跑完
			await vi.waitFor(() => expect(mockNotifier.info).toHaveBeenCalled());

			// 关键证据：toast 通过 store 内部 getSharedNotifier 触发，handoff 路径下也能 toast
			expect(mockNotifier.info).toHaveBeenCalledWith({
				title: 'chat.cancelGone',
				description: 'chat.cancelGoneHint',
			});
		});

		test('accepted 后取消：handoff 路径下 not-supported toast 也能弹（与 gone 对称）', async () => {
			vi.useFakeTimers();
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			let triggerOnAccepted;
			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					triggerOnAccepted = () => options?.onAccepted?.({ runId: 'run-handoff-ns' });
					return new Promise(() => {});
				}
				if (method === 'coclaw.agent.abort') return Promise.resolve({ ok: false, reason: 'not-supported' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.sessionId = 'sess-handoff-ns';

			store.sendMessage('hi');
			await vi.waitFor(() => expect(store.__cancelReject).not.toBeNull());

			// 用户在 accepted 前点 STOP → 挂意图（cancelSend 返 null）
			expect(store.cancelSend()).toBeNull();
			expect(store.__pendingCancelIntent).toBe(true);

			// onAccepted 触发 → handoff 内部自调 cancelSend → 走 accepted 分支 → 收到 not-supported
			triggerOnAccepted();
			await vi.waitFor(() => expect(mockNotifier.warning).toHaveBeenCalled());

			expect(mockNotifier.warning).toHaveBeenCalledWith({
				title: 'chat.cancelNotSupported',
				description: 'chat.upgradeOpenClawHint',
			});
		});

		test('accepted 后取消：notifier.info 抛异常时 coord promise 仍应 resolve（防御性合约）', async () => {
			// 复现 review 提的真问题候选：gone 分支当前实现是 cleanup → settleByCancel → notify → resolveFn。
			// 若 notify（或其参数 i18n.t）抛同步异常，async tick 内未 catch → tick 的隐式 promise reject →
			// resolveFn 永不被调，coord promise 永挂。真实 nuxt useNotify / vue-i18n 在常规配置下不抛，
			// 但 mockImplementation 的 throw 等价于"未来 i18n 切 strict 或 toast 实现引入 bug"的边界。
			vi.useFakeTimers();
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			// 隔离 unhandled rejection（tick 函数 reject 会冒到 process）
			const unhandled = [];
			const handler = (reason) => unhandled.push(reason);
			process.on('unhandledRejection', handler);

			try {
				mockNotifier.info.mockImplementation(() => { throw new Error('toast crash'); });

				const conn = mockConn();
				conn.request.mockImplementation((method, params, options) => {
					if (method === 'agent') {
						options?.onAccepted?.({ runId: 'run-p1' });
						return new Promise(() => {});
					}
					if (method === 'coclaw.agent.abort') {
						return Promise.resolve({ ok: false, reason: 'gone' });
					}
					return Promise.resolve(null);
				});
				setConn('1', conn);

				const store = useChatStore();
				store.clawId = '1';
				store.chatSessionKey = 'agent:main:main';
				store.sessionId = 'sess-p1';

				store.sendMessage('hi');
				await Promise.resolve();

				const p = store.cancelSend();
				let outcome = null;
				p.then((v) => { outcome = v; }, (e) => { outcome = { __rejected: e }; });

				// 让 tick 跑完：abort RPC resolve + notify 同步抛 + 后续微任务
				await vi.runAllTimersAsync();
				await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

				// 防御性合约：notify 抛后 coord promise 仍应 resolve 为 gone
				// 当前代码：outcome 仍为 null（resolveFn 永不被调）→ 测试失败 → 暴露 bug
				expect(outcome).toEqual({ ok: false, reason: 'gone' });

				store.cleanup();
			}
			finally {
				process.removeListener('unhandledRejection', handler);
			}
		});

		test('accepted 后取消：gone settle 后立即新 sendMessage 不被破坏（端到端用户场景）', async () => {
			// 用户场景：plugin 启发判定 gone（可能是误判）→ UI 主动 settleByCancel + 弹 toast →
			// 用户立即继续发新消息。
			//
			// 关键不变式：
			// 1) gone settle 触发 __endRun → 老 run.ended=true，但 runKeyIndex 在自然 cleanup
			//    链（runPromise.then → loadMessages → dropRun）跑完前可能仍指向老 runId。
			// 2) 不论自然 cleanup 是否已完成，新 sendMessage 都应能正常 accept 并切换 runKeyIndex
			//    到新 runId。本测试用阻塞 sessions.get 来定格"自然 cleanup 尚未跑完"的中间窗口，
			//    强制 register 路径自带的 __cleanupRun(oldRunId, 'superseded') 接管老 entry。
			// 3) 新 run isRunning=true，老 runId 不再存在。
			vi.useFakeTimers();
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			let acceptedCount = 0;
			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					acceptedCount += 1;
					const runId = `run-s1-${acceptedCount}`;
					options?.onAccepted?.({ runId });
					return new Promise(() => {});
				}
				if (method === 'coclaw.agent.abort') {
					return Promise.resolve({ ok: false, reason: 'gone' });
				}
				// 关键：阻塞 sessions.get 让 __awaitPersistAndDrop 中的 loadMessages 不完成 →
				// dropRun 不会被自然路径调到 → 强制 register 内部的清理路径接管
				if (method === 'sessions.get') return new Promise(() => {});
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.sessionId = 'sess-s1';

			// 第一次发送
			store.sendMessage('first message').catch(() => {});
			await Promise.resolve();
			expect(store.__accepted).toBe(true);
			expect(acceptedCount).toBe(1);

			const runsStore = useAgentRunsStore();
			const runKey = store.runKey;
			expect(runsStore.runKeyIndex[runKey]).toBe('run-s1-1');
			expect(runsStore.isRunning(runKey)).toBe(true);

			// cancel + plugin 返 gone
			const p1 = store.cancelSend();
			await expect(p1).resolves.toEqual({ ok: false, reason: 'gone' });

			// gone settle 后核心断言：本地 run 已 ended（用户从感官上"已结束"）
			expect(runsStore.runs['run-s1-1']?.ended).toBe(true);
			expect(runsStore.isRunning(runKey)).toBe(false);
			// runKeyIndex 此时仍指向老 runId（自然 cleanup 链被 sessions.get 阻塞挡住）
			expect(runsStore.runKeyIndex[runKey]).toBe('run-s1-1');

			// 用户立即发新消息：__clearCancelling('superseded') + 新 runAgent →
			// register('run-s1-2') 内部触发 __cleanupRun(老 runId, 'superseded') → runKeyIndex 切换
			store.sendMessage('second message').catch(() => {});
			await Promise.resolve();
			await Promise.resolve();

			// 新 send 应被 server accept，runKeyIndex 切到新 runId，新 run 在跑
			expect(acceptedCount).toBe(2);
			expect(runsStore.runKeyIndex[runKey]).toBe('run-s1-2');
			expect(runsStore.isRunning(runKey)).toBe(true);

			// 老 runId 应被 register 路径的 __cleanupRun 移除（不再存在于 runs 表）
			expect(runsStore.runs['run-s1-1']).toBeUndefined();

			store.cleanup();
		});

		test('accepted 后取消：abort RPC 入参携带 runDuration / abortDuration（每 tick 实算墙钟差）', async () => {
			vi.useFakeTimers({ now: 1_000_000 });
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const abortCallParams = [];
			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-dur' });
					return new Promise(() => {});
				}
				if (method === 'coclaw.agent.abort') {
					abortCallParams.push(params);
					// 始终 not-found，让 tick 反复跑
					return Promise.resolve({ ok: false, reason: 'not-found' });
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.sessionId = 'sess-dur';

			store.sendMessage('hi');
			await Promise.resolve();
			// onAccepted 已同步触发，__acceptedAt = 1_000_000
			expect(store.__acceptedAt).toBe(1_000_000);

			// 模拟 accepted → 60s 后用户点 STOP
			await vi.advanceTimersByTimeAsync(60_000); // now = 1_060_000
			store.cancelSend();
			await Promise.resolve(); await Promise.resolve();

			// 第 1 次 tick：runDur = 60s, abortDur = 0（cancelStartAt = 1_060_000）
			expect(abortCallParams).toHaveLength(1);
			expect(abortCallParams[0]).toEqual({
				sessionId: 'sess-dur',
				runDuration: 60_000,
				abortDuration: 0,
			});

			// CANCEL_TICK_MS=500 后第 2 次 tick：runDur=60.5s, abortDur=0.5s
			await vi.advanceTimersByTimeAsync(500); // now = 1_060_500
			await Promise.resolve();
			expect(abortCallParams).toHaveLength(2);
			expect(abortCallParams[1].runDuration).toBe(60_500);
			expect(abortCallParams[1].abortDuration).toBe(500);

			store.cleanup();
		});

		test('accepted 后取消：abortDuration 用墙钟差（非 tickSeq*CANCEL_TICK_MS 估算）', async () => {
			// 这个测试用"延迟 RPC + 非整数推进"撑开 tick 间隔，验证 abortDuration 是
			// 真正的 Date.now() 墙钟差。若实现误用 me.tickSeq * CANCEL_TICK_MS，
			// 第 2 次 tick 的 abortDuration 会是 1000（=2*500）而非 800（=300+500），测试失败。
			vi.useFakeTimers({ now: 2_000_000 });
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const abortCallParams = [];
			const abortResolvers = [];
			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-skew' });
					return new Promise(() => {});
				}
				if (method === 'coclaw.agent.abort') {
					abortCallParams.push(params);
					return new Promise((resolve) => { abortResolvers.push(resolve); });
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.sessionId = 'sess-skew';

			store.sendMessage('hi');
			await Promise.resolve();
			store.cancelSend(); // cancelStartAt = 2_000_000
			await Promise.resolve(); await Promise.resolve();
			expect(abortCallParams).toHaveLength(1);
			expect(abortCallParams[0].abortDuration).toBe(0);

			// 推进 300ms（系统时间 2_000_300），让 RPC 滞后才返回
			await vi.advanceTimersByTimeAsync(300);
			abortResolvers[0]({ ok: false, reason: 'not-found' });
			await Promise.resolve(); await Promise.resolve();
			// tick1 完成，下一个 tickTimer 调度在 2_000_300 + 500 = 2_000_800

			// 推进 500ms（系统时间到 2_000_800）→ tick2 触发，Date.now() = 2_000_800
			await vi.advanceTimersByTimeAsync(500);
			await Promise.resolve(); await Promise.resolve();
			expect(abortCallParams).toHaveLength(2);
			// 关键断言：800（300 RPC 延迟 + 500 调度间隔）而非 1000（2 * CANCEL_TICK_MS）
			expect(abortCallParams[1].abortDuration).toBe(800);
			expect(abortCallParams[1].runDuration).toBe(800);

			store.cleanup();
		});

		test('accepted 后取消：run 在 tick 之间自然结束 → resolve {ok:false, reason:run-ended}', async () => {
			vi.useFakeTimers();
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-end' });
					return new Promise(() => {});
				}
				if (method === 'coclaw.agent.abort') return Promise.resolve({ ok: false, reason: 'not-found' });
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.sessionId = 'sess-end';

			store.sendMessage('hi');
			await Promise.resolve();

			const p = store.cancelSend();
			// 首次 tick：miss + 调度重试
			await Promise.resolve(); await Promise.resolve();
			expect(store.isCancelling).toBe(true);
			// 模拟 run 自然结束（rpc/wait 终态信号到达清理了 agentRunsStore）
			const runsStore = useAgentRunsStore();
			runsStore.settle(store.runKey);
			// 下一个 tick 检测 isRunning=false → 立即 resolve run-ended
			await vi.advanceTimersByTimeAsync(500);
			await expect(p).resolves.toEqual({ ok: false, reason: 'run-ended' });
			expect(remoteLogCalls).toContain('cancel.run-ended sid=sess-end');
			expect(store.__cancelling).toBeNull();
		});

		test('cleanup() 期间清理 __cancelling 的 tickTimer，不再重发 RPC', async () => {
			vi.useFakeTimers();
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			let abortCalls = 0;
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-cleanup' });
					return new Promise(() => {});
				}
				if (method === 'coclaw.agent.abort') {
					abortCalls++;
					return Promise.resolve({ ok: false, reason: 'not-found' });
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.sessionId = 'sess-cleanup';

			store.sendMessage('hi');
			await Promise.resolve();

			store.cancelSend();
			await Promise.resolve(); await Promise.resolve();
			expect(abortCalls).toBe(1);
			expect(store.isCancelling).toBe(true);

			// 模拟页面离开 → cleanup()，应清理 __cancelling、撤销 tickTimer
			store.cleanup();
			expect(store.__cancelling).toBeNull();

			// 推进 500ms 确认没有新的 RPC 发出
			await vi.advanceTimersByTimeAsync(500);
			expect(abortCalls).toBe(1);
		});

		test('id 隔离：tick1 在 RPC 飞行中被 __clearCancelling+新 cancelSend 取代后，老 tick 不污染新协调', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			const abortResolves = [];
			let agentCalls = 0;
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					agentCalls++;
					options?.onAccepted?.({ runId: `run-iso-${agentCalls}` });
					return new Promise(() => {});
				}
				if (method === 'coclaw.agent.abort') {
					return new Promise((r) => { abortResolves.push(r); });
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.sessionId = 'sess-iso';

			// 第 1 轮：发消息 → cancelSend → tick1 await RPC
			store.sendMessage('hi-1');
			await Promise.resolve();
			const p1 = store.cancelSend();
			await Promise.resolve(); await Promise.resolve();
			expect(abortResolves.length).toBe(1);
			const resolveAbort1 = abortResolves[0];

			// 第 2 轮：用户发新消息 → __clearCancelling('superseded') 触发 → p1 立即 resolve
			store.sendMessage('hi-2');
			await Promise.resolve();
			await expect(p1).resolves.toEqual({ ok: false, reason: 'superseded' });

			// 第 2 轮：用户再点 STOP → 新 cancelSend → tick2 启动
			const p2 = store.cancelSend();
			await Promise.resolve(); await Promise.resolve();
			expect(abortResolves.length).toBe(2);
			const resolveAbort2 = abortResolves[1];

			// 老的 tick1 RPC 现在以 ok=true resolve → tick1 恢复时应识别 id 不匹配 → 退出，
			// **不能** 误清理 store.__cancelling（即 tick2 的状态）
			resolveAbort1({ ok: true });
			await Promise.resolve();
			expect(store.__cancelling).not.toBeNull();
			expect(store.__cancelling.sid).toBe('sess-iso');

			// tick2 RPC 正常 resolve → p2 成为 immediate
			resolveAbort2({ ok: true });
			await expect(p2).resolves.toEqual({ ok: true, aborted: 'immediate' });
			expect(store.__cancelling).toBeNull();
		});

		test('cleanup() 在 RPC 飞行中触发：RPC 结果到达后被 __cancelling=null 守卫吞掉，coordination promise 不 resolve', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			let resolveAbort;
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-cleanup-await' });
					return new Promise(() => {});
				}
				if (method === 'coclaw.agent.abort') {
					return new Promise((r) => { resolveAbort = r; });
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.sessionId = 'sess-cleanup-await';

			store.sendMessage('hi');
			await Promise.resolve();

			const p = store.cancelSend();
			await Promise.resolve(); await Promise.resolve();
			// RPC 飞行中（resolveAbort 已捕获但未 resolve），cleanup() 触发
			expect(typeof resolveAbort).toBe('function');
			store.cleanup();
			expect(store.__cancelling).toBeNull();

			// 现在让 RPC 以 hit 结果到达 → tick 恢复后看到 __cancelling=null → 早退、不 resolve p
			let settled = false;
			let settledValue = null;
			p.then((v) => { settled = true; settledValue = v; }, () => { settled = true; });
			resolveAbort({ ok: true });
			await new Promise((r) => setImmediate(r));
			expect(settled).toBe(false);
			expect(settledValue).toBeNull();
		});

		// 关键回归：没有这条守护，旧 cancel tick 会在新 send 开始后的空窗期结束时
		// 命中 ACTIVE_EMBEDDED_RUNS[sid] 的新 handle，把用户新发的 run 误 abort。
		test('sendMessage 开始时同步清除 __cancelling，旧 tick 不再发 RPC（superseded 终态）', async () => {
			vi.useFakeTimers();
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			let abortCalls = 0;
			let agentCalls = 0;
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					agentCalls++;
					options?.onAccepted?.({ runId: `run-${agentCalls}` });
					return new Promise(() => {});
				}
				if (method === 'coclaw.agent.abort') {
					abortCalls++;
					// 永远 not-found：模拟空窗期一直没结束
					return Promise.resolve({ ok: false, reason: 'not-found' });
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.sessionId = 'sess-sup';

			// 第 1 次 send
			store.sendMessage('hi');
			await Promise.resolve();
			expect(store.__accepted).toBe(true);

			// 取消：__cancelling 激活，首 tick 发一次 RPC 并 schedule 重试
			const p = store.cancelSend();
			await Promise.resolve(); await Promise.resolve();
			expect(abortCalls).toBe(1);
			expect(store.isCancelling).toBe(true);

			// 用户发起新 send → __cancelling 必须被同步清掉
			store.sending = false; // cancelSend 已将 sending 置 false，再模拟用户重新输入
			store.__accepted = false;
			const p2 = store.sendMessage('follow up');
			await Promise.resolve();

			// 旧协调 promise 以 superseded 终态 resolve
			await expect(p).resolves.toEqual({ ok: false, reason: 'superseded' });
			expect(store.__cancelling).toBeNull();

			// 推进 500ms 以确认旧 tick 不再发 RPC
			await vi.advanceTimersByTimeAsync(500);
			expect(abortCalls).toBe(1);
			// agent RPC 触发了两次（旧 + 新）
			expect(agentCalls).toBe(2);
			expect(p2).toBeInstanceOf(Promise);
		});

		test('sendSlashCommand 开始时也清除 __cancelling（superseded）', async () => {
			vi.useFakeTimers();
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			let abortCalls = 0;
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-slash' });
					return new Promise(() => {});
				}
				if (method === 'coclaw.agent.abort') {
					abortCalls++;
					return Promise.resolve({ ok: false, reason: 'not-found' });
				}
				if (method === 'chat.send') {
					return Promise.resolve({ runId: 'slash-run', status: 'started' });
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.sessionId = 'sess-slash';

			store.sendMessage('hi');
			await Promise.resolve();
			const p = store.cancelSend();
			await Promise.resolve(); await Promise.resolve();
			expect(abortCalls).toBe(1);

			// 取消 cancelSend 的 sending=false 之后，发 /help
			store.sending = false;
			store.sendSlashCommand('/help');
			// sendSlashCommand 是 async——让它进入 try 块完成 chat.send 调用
			await Promise.resolve();

			await expect(p).resolves.toEqual({ ok: false, reason: 'superseded' });
			expect(store.__cancelling).toBeNull();

			// 推进 500ms：旧 tick 不会发 RPC
			await vi.advanceTimersByTimeAsync(500);
			expect(abortCalls).toBe(1);
		});

		test('accepted 后取消：abort RPC 失败时 cancelSend 不抛错、无 unhandledRejection 且保持 settling(cancel) 状态', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-abort-fail' });
					return new Promise(() => {});
				}
				if (method === 'coclaw.agent.abort') {
					return Promise.reject(new Error('RPC_UNKNOWN'));
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.sessionId = 'sess-abort-fail';

			store.sendMessage('hello');
			await Promise.resolve();
			expect(store.__accepted).toBe(true);

			// 捕获 unhandledRejection，若 cancelSend 没在内部 catch 则会被观测到
			const unhandledRejections = [];
			const onUnhandled = (err) => { unhandledRejections.push(err); };
			process.on('unhandledRejection', onUnhandled);

			try {
				expect(() => store.cancelSend()).not.toThrow();
				// 等 setImmediate 让 microtask + rejection 检测跑完
				await new Promise((resolve) => setImmediate(resolve));
				expect(unhandledRejections).toHaveLength(0);
			}
			finally {
				process.off('unhandledRejection', onUnhandled);
			}

			const runsStore = useAgentRunsStore();
			const run = runsStore.getActiveRun(store.runKey);
			expect(run?.cancelled).toBe(true);
		});

		test('accepted 取消后独立 loadMessages：cancelled run 的 streamingMsgs 仍保留（P0 回归防护）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method, params, options) => {
				if (method === 'agent') {
					options?.onAccepted?.({ runId: 'run-pz' });
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

			store.sendMessage('hello');
			await Promise.resolve();
			expect(store.__accepted).toBe(true);

			const runsStore = useAgentRunsStore();
			const runKey = store.runKey;
			const streamingBefore = runsStore.getActiveRun(runKey).streamingMsgs.length;
			expect(streamingBefore).toBeGreaterThan(0);

			store.cancelSend();

			// 模拟 WS 重连 / 前台恢复 / activate 重入 等独立触发路径
			await store.loadMessages({ silent: true });

			// 核心断言：run 仍在、streamingMsgs 未被 completeSettle 清空
			const run = runsStore.getActiveRun(runKey);
			expect(run).not.toBeNull();
			expect(run.cancelled).toBe(true);
			expect(run.streamingMsgs.length).toBe(streamingBefore);
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

		test('cleanup 在 in-flight sendMessage 上触发 USER_CANCELLED → 打 agent.run.send-cancelled', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			// 让 agent RPC 永远 pending —— 让 sendMessage 卡在 Promise.race 等 cancelPromise 触发
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
			// 等到 __cancelReject 已就位
			await vi.waitFor(() => expect(store.__cancelReject).not.toBeNull());

			// cleanup 路径：触发 __cancelReject(USER_CANCELLED) → catch 走 send-cancelled 分支
			store.cleanup();
			const result = await sendPromise;
			expect(result).toEqual({ accepted: false });
			expect(remoteLogCalls.find((t) => t.startsWith('agent.run.send-cancelled') && t.includes('accepted=false'))).toBeTruthy();
		});
	});

	// =====================================================================
	// inputFiles 管理（per-chat/topic 隔离的输入区附件）
	// =====================================================================

	describe('inputFiles', () => {
		beforeEach(() => {
			// jsdom 不提供 createObjectURL/revokeObjectURL —— 用 vi.fn 拦截以便断言
			URL.createObjectURL = vi.fn(() => `blob:mock-${Math.random()}`);
			URL.revokeObjectURL = vi.fn();
		});

		test('默认 inputFiles 为空', () => {
			const store = useChatStore();
			expect(store.inputFiles).toEqual([]);
		});

		test('addFiles 追加文件，不做大小校验（校验留在 ChatInput 入口）', () => {
			const store = useChatStore();
			store.addFiles([
				{ id: 'a', isImg: false, name: 'a.txt', url: null },
				{ id: 'b', isImg: true, name: 'b.png', url: 'blob:b' },
			]);
			expect(store.inputFiles).toHaveLength(2);
			expect(store.inputFiles[0].id).toBe('a');
			expect(store.inputFiles[1].id).toBe('b');
		});

		test('addFiles 空入参 / null 静默 no-op', () => {
			const store = useChatStore();
			store.addFiles([]);
			store.addFiles(null);
			store.addFiles(undefined);
			expect(store.inputFiles).toHaveLength(0);
		});

		test('addFiles 重复同 id 不去重（UI 显示两份）', () => {
			const store = useChatStore();
			const f = { id: 'a', isImg: false, url: null };
			store.addFiles([f]);
			store.addFiles([f]);
			expect(store.inputFiles).toHaveLength(2);
		});

		test('removeInputFile(idx) 对图片调 revoke 并 splice', () => {
			const store = useChatStore();
			store.inputFiles.push(
				{ id: 'a', isImg: true, url: 'blob:a' },
				{ id: 'b', isImg: false, url: null },
			);
			store.removeInputFile(0);
			expect(store.inputFiles).toHaveLength(1);
			expect(store.inputFiles[0].id).toBe('b');
			expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:a');
		});

		test('removeInputFile 非图片（url=null）不调 revoke', () => {
			const store = useChatStore();
			store.inputFiles.push({ id: 'a', isImg: false, url: null });
			store.removeInputFile(0);
			expect(store.inputFiles).toHaveLength(0);
			expect(URL.revokeObjectURL).not.toHaveBeenCalled();
		});

		test('removeFileById 找到目标 → revoke + splice', () => {
			const store = useChatStore();
			store.inputFiles.push(
				{ id: 'a', isImg: true, url: 'blob:a' },
				{ id: 'b', isImg: false, url: null },
			);
			store.removeFileById('a');
			expect(store.inputFiles).toHaveLength(1);
			expect(store.inputFiles[0].id).toBe('b');
			expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:a');
		});

		test('removeFileById 不存在的 id 静默 no-op', () => {
			const store = useChatStore();
			store.inputFiles.push({ id: 'x', url: null });
			store.removeFileById('nonexistent');
			expect(store.inputFiles).toHaveLength(1);
			expect(URL.revokeObjectURL).not.toHaveBeenCalled();
		});

		test('clearInputFiles 仅对 url 非空的（图片）revoke 并清空数组', () => {
			const store = useChatStore();
			store.inputFiles.push(
				{ id: 'a', isImg: true, url: 'blob:a' },
				{ id: 'b', isImg: false, url: null },
				{ id: 'c', isImg: true, url: 'blob:c' },
			);
			store.clearInputFiles();
			expect(store.inputFiles).toHaveLength(0);
			expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
			expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:a');
			expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:c');
		});

		test('restoreFiles 对图片重建 ObjectURL，非图片不重建，保留其它字段', () => {
			const store = useChatStore();
			const blob = new Blob(['data']);
			store.restoreFiles([
				{ id: 'a', isImg: true, file: blob, name: 'a.png' },
				{ id: 'b', isImg: false, file: null, name: 'b.txt', remotePath: '/r/b.txt' },
			]);
			expect(store.inputFiles).toHaveLength(2);
			expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
			expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
			expect(store.inputFiles[0].url).toMatch(/^blob:mock-/);
			expect(store.inputFiles[1].url).toBeUndefined();
			// 非图片字段透传（remotePath 是上传缓存，不能丢）
			expect(store.inputFiles[1].remotePath).toBe('/r/b.txt');
		});

		test('restoreFiles isImg=true 但 file=null 时显式置 url=null（不带入 stale url）', () => {
			const store = useChatStore();
			// 模拟上传 onFileUploaded 已 revoke 过原 url 的场景：f.url 是 stale 字符串
			const stale = { id: 'a', isImg: true, file: null, url: 'blob:already-revoked', name: 'a.png' };
			expect(() => store.restoreFiles([stale])).not.toThrow();
			expect(store.inputFiles).toHaveLength(1);
			// 关键断言：spread 的 stale url 必须被显式覆盖为 null，避免模板渲染破图
			expect(store.inputFiles[0].url).toBeNull();
			// 同时其它字段（特别是 isImg）必须保留，否则模板分支判断会出错
			expect(store.inputFiles[0].isImg).toBe(true);
			expect(store.inputFiles[0].name).toBe('a.png');
			expect(URL.createObjectURL).not.toHaveBeenCalled();
		});

		test('restoreFiles 非图片不动 url 字段（保留原值或 null）', () => {
			const store = useChatStore();
			store.restoreFiles([{ id: 'a', isImg: false, name: 'a.txt', url: null }]);
			expect(store.inputFiles[0].url).toBeNull();
			expect(URL.createObjectURL).not.toHaveBeenCalled();
		});

		test('restoreFiles 空入参 / null 静默 no-op', () => {
			const store = useChatStore();
			store.restoreFiles([]);
			store.restoreFiles(null);
			expect(store.inputFiles).toHaveLength(0);
		});

		test('dispose 仅 revoke 图片（url 非空）的 ObjectURL', () => {
			const store = useChatStore();
			store.inputFiles.push(
				{ id: 'a', isImg: true, url: 'blob:a' },
				{ id: 'b', isVoice: true, url: null }, // voice 没 url
				{ id: 'c', isImg: false, url: null },
			);
			store.dispose();
			expect(store.inputFiles).toHaveLength(0);
			expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
			expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:a');
		});

		test('dispose 在 inputFiles 为空时不抛异常', () => {
			const store = useChatStore();
			expect(() => store.dispose()).not.toThrow();
			expect(URL.revokeObjectURL).not.toHaveBeenCalled();
		});

		test('promote 后老 store dispose 不 revoke 已转移的 ObjectURL（关键 invariant）', () => {
			// 模拟 promoteToTopic 行为：先把 oldStore.inputFiles = []（切断引用），再 dispose
			const oldStore = createChatStore('new-topic:1:main', { clawId: '1', agentId: 'main' });
			const transferred = [{ id: 'img', isImg: true, url: 'blob:transferred' }];
			oldStore.inputFiles = transferred;
			// commit() 时第一步：切断引用
			oldStore.inputFiles = [];
			// 第二步：dispose
			oldStore.dispose();
			// transferred 引用的图片 URL 不能被 revoke —— 它已经归新 topic store 所有
			expect(URL.revokeObjectURL).not.toHaveBeenCalled();
		});
	});

	// =====================================================================
	// newTopicMode（new-topic:* storeKey 的特殊行为）
	// =====================================================================

	describe('newTopicMode', () => {
		test('newTopicMode 标志根据 storeKey 前缀计算', () => {
			const newTopic = createChatStore('new-topic:1:main', { clawId: '1', agentId: 'main' });
			const session = createChatStore('session:1:main', { clawId: '1', agentId: 'main' });
			const topic = createChatStore('topic:t1', { clawId: '1', agentId: 'main' });
			expect(newTopic.newTopicMode).toBe(true);
			expect(session.newTopicMode).toBe(false);
			expect(topic.newTopicMode).toBe(false);
		});

		test('newTopicMode 下 chatSessionKey 留空（避免 getter 误把它当普通 chat）', () => {
			const store = createChatStore('new-topic:1:main', { clawId: '1', agentId: 'main' });
			expect(store.chatSessionKey).toBe('');
			expect(store.topicMode).toBe(false);
			expect(store.sessionId).toBe('');
		});

		test('newTopicMode 下 activate 不触发任何 RPC（短路返回）', async () => {
			const conn = mockConn();
			setConn('1', conn);

			const store = createChatStore('new-topic:1:main', { clawId: '1', agentId: 'main' });
			await store.activate();

			expect(conn.request).not.toHaveBeenCalled();
			expect(store.__initialized).toBe(true);
			expect(store.__messagesLoaded).toBe(true);
			expect(store.loading).toBe(false);
		});

		test('newTopicMode 下 inputFiles 仍可正常读写', () => {
			const store = createChatStore('new-topic:1:main', { clawId: '1', agentId: 'main' });
			store.addFiles([{ id: 'a', isImg: false, url: null }]);
			expect(store.inputFiles).toHaveLength(1);
		});
	});

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

		// --- isLoadingMessages ---

		test('isLoadingMessages 默认 false', () => {
			const store = useChatStore();
			expect(store.isLoadingMessages).toBe(false);
		});

		test('isLoadingMessages 在 __silentLoadPromise 飞行中为 true', () => {
			const store = useChatStore();
			store.__silentLoadPromise = Promise.resolve(true);
			expect(store.isLoadingMessages).toBe(true);
			store.__silentLoadPromise = null;
			expect(store.isLoadingMessages).toBe(false);
		});

		test('isLoadingMessages 在 __loadPromise 飞行中为 true', () => {
			const store = useChatStore();
			store.__loadPromise = Promise.resolve(true);
			expect(store.isLoadingMessages).toBe(true);
			store.__loadPromise = null;
			expect(store.isLoadingMessages).toBe(false);
		});

		test('isLoadingMessages 两个 promise 都在飞行时为 true', () => {
			const store = useChatStore();
			store.__silentLoadPromise = Promise.resolve(true);
			store.__loadPromise = Promise.resolve(true);
			expect(store.isLoadingMessages).toBe(true);
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
				ended: false,
				cancelled: false,
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
				ended: false,
				cancelled: false,
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
				ended: false,
				cancelled: false,
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
				ended: false,
				cancelled: false,
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
				ended: false,
				cancelled: false,
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
				ended: false,
				cancelled: false,
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
				runKey: '::agent:main:main',
				ended: true,
				cancelled: false,
				streamingMsgs: [
					{ type: 'message', id: '__local_user_1', _local: true, message: { role: 'user', content: 'hi' } },
				],
			};
			runsStore.runKeyIndex['::agent:main:main'] = 'run-x';

			runsStore.stripLocalUserMsgs('::agent:main:main');

			// settled run 不做任何操作
			expect(runsStore.runs['run-x'].streamingMsgs).toHaveLength(1);
		});

		// run 进行中点刷新触发的流式占位错位回归保护：
		// 调 stripLocalUserMsgs 后 anchor 应升级到 server 的 user 消息上；
		// allMessages 据此把 optimisticClaw 插到新 user 之后，
		// groupSessionMessages 才能把 _streaming 落到当前轮 botTask 上，
		// 不再走 ChatMsgItem.vue v-else 分支显示"任务未完成"。
		test('run 进行中刷新：stripLocalUserMsgs 后 streamingMsgs 落在当前轮 botTask 上', () => {
			const store = useChatStore();
			store.chatSessionKey = 'agent:main:main';

			// loadMessages 拉到的服务器 transcript：上一轮完整 + 当前 user 已落盘 + 中间 assistant
			const serverMsgs = [
				{
					type: 'message', id: 'oc-u-1',
					message: { role: 'user', content: [{ type: 'text', text: '上一个问题' }], timestamp: 1000 },
				},
				{
					type: 'message', id: 'oc-a-1',
					timestamp: 2000,
					message: {
						role: 'assistant',
						content: [{ type: 'text', text: '上一轮的回答' }],
						stopReason: 'end_turn',
						model: 'gpt-5',
						timestamp: 2000,
					},
				},
				{
					type: 'message', id: 'oc-u-2',
					message: { role: 'user', content: [{ type: 'text', text: '当前问题' }], timestamp: 10000 },
				},
				// 中间 assistant entry：仅 thinking 块，未输出最终文本
				{
					type: 'message', id: 'oc-a-2',
					timestamp: 26000,
					message: {
						role: 'assistant',
						content: [{ type: 'thinking', thinking: '思考中...' }],
						stopReason: null,
						model: 'MiniMax-M2.7',
						timestamp: 26000,
					},
				},
			];
			store.messages = serverMsgs;

			const runsStore = useAgentRunsStore();
			const runId = 'run-misplaced';
			const runKey = store.runKey;
			runsStore.runs[runId] = {
				runId,
				runKey,
				// send 时锚点指向上一轮 assistant final
				anchorMsgId: 'oc-a-1',
				ended: false,
				cancelled: false,
				streamingMsgs: [
					{
						type: 'message', id: '__local_user_x',
						_local: true,
						message: { role: 'user', content: '当前问题', timestamp: 9000 },
					},
					{
						type: 'message', id: '__local_claw_x',
						_local: true, _streaming: true, _startTime: 9500,
						message: { role: 'assistant', content: '', stopReason: null },
					},
				],
			};
			runsStore.runKeyIndex[runKey] = runId;

			// 模拟 loadMessages 触发 __reconcileRunAfterLoad
			runsStore.stripLocalUserMsgs(runKey, serverMsgs);

			// 锚点应升级到 server 的 user 消息（oc-u-2）上
			expect(runsStore.runs[runId].anchorMsgId).toBe('oc-u-2');

			// allMessages 把 optimisticClaw 插到 oc-u-2 之后
			const merged = store.allMessages;
			expect(merged.map((m) => m.id)).toEqual([
				'oc-u-1', 'oc-a-1', 'oc-u-2', '__local_claw_x', 'oc-a-2',
			]);

			const items = groupSessionMessages(merged);
			const botTasks = items.filter((i) => i.type === 'botTask');
			expect(botTasks).toHaveLength(2);

			// 上一轮 botTask：完整 final，无流式标记
			const [prevBot, currBot] = botTasks;
			expect(prevBot.resultText).toBe('上一轮的回答');
			expect(prevBot.isStreaming).toBe(false);

			// 当前 botTask：optimisticClaw 落在这一组 → isStreaming=true → 不会渲染"任务未完成"
			expect(currBot.isStreaming).toBe(true);
		});

		// 边界场景：activate 失败留下 messages=[] → send 时 anchorMsgId=null，
		// 用户刷新成功拉回完整 transcript（含远古历史）。
		// 此分支不能把 anchor 升到 server 第一条 user（那是远古），保持 null 走末尾追加。
		test('无锚点 + 历史场景刷新：optimisticClaw 末尾追加，当前轮 botTask isStreaming=true', () => {
			const store = useChatStore();
			store.chatSessionKey = 'agent:main:main';

			const serverMsgs = [
				{ type: 'message', id: 'old-u', message: { role: 'user', content: '远古问题', timestamp: 1000 } },
				{
					type: 'message', id: 'old-a',
					timestamp: 2000,
					message: { role: 'assistant', content: [{ type: 'text', text: '远古回答' }], stopReason: 'end_turn', timestamp: 2000 },
				},
				{ type: 'message', id: 'curr-u', message: { role: 'user', content: '当前问题', timestamp: 8000 } },
				{
					type: 'message', id: 'curr-a-mid',
					timestamp: 12000,
					message: { role: 'assistant', content: [{ type: 'thinking', thinking: '思考中...' }], stopReason: null, model: 'gpt-5', timestamp: 12000 },
				},
			];
			store.messages = serverMsgs;

			const runsStore = useAgentRunsStore();
			const runId = 'run-no-anchor-with-history';
			const runKey = store.runKey;
			runsStore.runs[runId] = {
				runId,
				runKey,
				anchorMsgId: null, // activate 失败遗留
				ended: false,
				cancelled: false,
				streamingMsgs: [
					{
						type: 'message', id: '__local_user_x',
						_local: true,
						message: { role: 'user', content: '当前问题' },
					},
					{
						type: 'message', id: '__local_claw_x',
						_local: true, _streaming: true,
						message: { role: 'assistant', content: '', stopReason: null },
					},
				],
			};
			runsStore.runKeyIndex[runKey] = runId;

			runsStore.stripLocalUserMsgs(runKey, serverMsgs);

			// anchor 不被错误升级到 'old-u'
			expect(runsStore.runs[runId].anchorMsgId).toBeNull();

			// allMessages 走末尾追加：optimisticClaw 在 transcript 末尾
			const merged = store.allMessages;
			expect(merged.map((m) => m.id)).toEqual([
				'old-u', 'old-a', 'curr-u', 'curr-a-mid', '__local_claw_x',
			]);

			const botTasks = groupSessionMessages(merged).filter((i) => i.type === 'botTask');
			expect(botTasks).toHaveLength(2);
			const [oldBot, currBot] = botTasks;
			expect(oldBot.resultText).toBe('远古回答');
			expect(oldBot.isStreaming).toBe(false);
			// 当前 botTask：mid_assistant + optimisticClaw 都进这一组，_streaming 落到位
			expect(currBot.isStreaming).toBe(true);
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

		test('过滤 archivedAt 为 null 或缺失的条目（plugin 新契约的当前 session 标记）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			// 模拟 plugin 新契约返回：含一个 archivedAt=null（当前 session）+ 一个无 archivedAt 字段
			// + 两个正常归档的孤儿。UI 应只保留两个孤儿。
			const conn = mockConn();
			conn.request.mockResolvedValue({
				history: [
					{ sessionId: 'orphan-1', archivedAt: 100 },
					{ sessionId: 'orphan-2', archivedAt: 200 },
					{ sessionId: 'missing-field' },
					{ sessionId: 'current-session', archivedAt: null },
				],
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			await store.__loadChatHistory();

			expect(store.historySessionIds).toEqual([
				{ sessionId: 'orphan-1', archivedAt: 100 },
				{ sessionId: 'orphan-2', archivedAt: 200 },
			]);
			expect(store.historyExhausted).toBe(false);
		});

		test('过滤后列表为空时设置 historyExhausted 为 true', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			// 列表里只有"当前 session"标记（archivedAt=null），过滤后为空
			const conn = mockConn();
			conn.request.mockResolvedValue({
				history: [{ sessionId: 'current-only', archivedAt: null }],
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';

			await store.__loadChatHistory();

			expect(store.historySessionIds).toEqual([]);
			expect(store.historyExhausted).toBe(true);
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

		test('source-filter 守住下游：含 current marker 的 list 不会触发 getById 拉取 marker', async () => {
			// 端到端校验 __loadChatHistory 的 filter 真正保护下游：
			// 即便 plugin 把"当前 session"作为无 archivedAt 的条目写进 list，
			// 后续 loadNextHistorySession 也不应去 RPC 拉取它的 messages。
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: '1', online: true }]);

			const conn = mockConn();
			conn.request.mockImplementation((method) => {
				if (method === 'coclaw.chatHistory.list') {
					return Promise.resolve({
						history: [
							{ sessionId: 'orphan-1', archivedAt: 200 },
							{ sessionId: 'current-marker', archivedAt: null },
						],
					});
				}
				if (method === 'coclaw.sessions.getById') {
					return Promise.resolve({ messages: [] });
				}
				return Promise.resolve(null);
			});
			setConn('1', conn);

			const store = useChatStore();
			store.clawId = '1';
			store.chatSessionKey = 'agent:main:main';
			store.__messagesLoaded = true;

			await store.__loadChatHistory();
			// 连调两次：第一次应拉 orphan-1，第二次应判定耗尽（current-marker 被 filter 掉了）
			await store.loadNextHistorySession();
			await store.loadNextHistorySession();

			const getByIdCalls = conn.request.mock.calls
				.filter(([m]) => m === 'coclaw.sessions.getById');
			expect(getByIdCalls).toHaveLength(1);
			expect(getByIdCalls[0][1].sessionId).toBe('orphan-1');
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
			// 本地 user 占位已清除，仅剩 server 回复的 assistant message
			expect(store.messages.length).toBe(1);
			expect(store.messages[0].message.content[0].text).toBe('help text');
		});

		test('sending 为 true 时不发送', async () => {
			store.sending = true;
			await store.sendSlashCommand('/help');
			expect(conn.request).not.toHaveBeenCalled();
		});

		// 与 sendMessage 对齐：用 wait-mode 取 conn，离线 / DC 重建期点击仍发送，
		// conn.request() 内部 waitReady() 会排队直到连接恢复。
		test('claw 离线（dcReady=false）时仍发送，由 conn.waitReady() 排队', async () => {
			useClawsStore().byId['1'].dcReady = false;
			const p = store.sendSlashCommand('/help');
			expect(conn.request).toHaveBeenCalledWith('chat.send', expect.any(Object));
			// 完成 round-trip 以避免悬挂的 promise
			const handler = conn.on.mock.calls.find((c) => c[0] === 'event:chat')[1];
			handler({ runId: store.__slashCommandRunId, state: 'final' });
			await p;
		});

		test('claw 未注册（conn 不存在）时静默返回', async () => {
			store.clawId = 'unknown-claw';
			await store.sendSlashCommand('/help');
			// conn 缺失 → 未进入发送路径，连 event:chat 监听都没注册
			expect(conn.on).not.toHaveBeenCalled();
			expect(conn.request).not.toHaveBeenCalled();
			expect(store.sending).toBe(false);
		});

		// 协议演进保险：上游 chat.send 失败一般走 ok=false（→ catch），但协议允许
		// ok=true + payload.status='error'。当前修复让 resolve 后立即识别 status='error'，
		// 避免 spinner 卡到 slashTimeout（5min~24h）才超时清理。
		test('chat.send resolve 但 payload.status="error" → 立即清理 + reject（不等 event timeout）', async () => {
			conn.request.mockResolvedValue({
				runId: 'r-bad',
				status: 'error',
				error: 'slash command rejected by server',
			});

			await expect(store.sendSlashCommand('/help')).rejects.toMatchObject({
				code: 'SLASH_CMD_REJECTED',
				message: 'slash command rejected by server',
			});
			expect(store.sending).toBe(false);
			expect(store.messages.length).toBe(0);
			// event:chat 监听已注销
			expect(conn.off).toHaveBeenCalledWith('event:chat', expect.any(Function));
		});

		// 协议演进保险：当前 chat.ts 未见 status='timeout' 分支，但保留兜底，防上游新增
		// 超时反馈而 UI 静默卡死（spinner 卡到 5min~24h slashTimeout）。
		test('chat.send resolve 但 payload.status="timeout" → 立即清理 + reject（不等 event timeout）', async () => {
			conn.request.mockResolvedValue({
				runId: 'r-tmo',
				status: 'timeout',
				summary: 'upstream timeout',
			});

			await expect(store.sendSlashCommand('/help')).rejects.toMatchObject({
				code: 'SLASH_CMD_REJECTED',
				message: 'upstream timeout',
			});
			expect(store.sending).toBe(false);
			expect(store.messages.length).toBe(0);
			expect(conn.off).toHaveBeenCalledWith('event:chat', expect.any(Function));
		});

		// P3 防御：error 字段是 object 形态（协议偏离）时不丢失信息，stringify 兜底
		// （非字符串 → String() 兜底，至少不会丢成 undefined description）
		test('chat.send resolve status="error" 且 error 为 object → stringify 后透出', async () => {
			conn.request.mockResolvedValue({
				runId: 'r-obj',
				status: 'error',
				error: { code: 'X', message: 'oops' },
			});

			await expect(store.sendSlashCommand('/help')).rejects.toMatchObject({
				code: 'SLASH_CMD_REJECTED',
				message: '[object Object]',
			});
		});

		// B2：用户高频场景——slash 命令失败后立即重发，期望生成全新 idempotencyKey，
		// 不复用旧 key（防止服务端按旧 key 去重命中而吞掉重发）
		test('status="error" reject 后用户重发：生成新 idempotencyKey，不复用旧 key', async () => {
			conn.request.mockResolvedValue({
				runId: 'r-bad',
				status: 'error',
				error: 'first attempt rejected',
			});
			await expect(store.sendSlashCommand('/help')).rejects.toMatchObject({
				code: 'SLASH_CMD_REJECTED',
			});
			const firstKey = conn.request.mock.calls.at(-1)[1].idempotencyKey;
			expect(firstKey).toBeTruthy();

			// 重发：第二次也失败（保持简单，验证 key 行为即可）
			conn.request.mockResolvedValue({
				runId: 'r-bad-2',
				status: 'error',
				error: 'second attempt rejected',
			});
			await expect(store.sendSlashCommand('/help')).rejects.toMatchObject({
				code: 'SLASH_CMD_REJECTED',
			});
			const secondKey = conn.request.mock.calls.at(-1)[1].idempotencyKey;
			expect(secondKey).toBeTruthy();
			expect(secondKey).not.toBe(firstKey);
		});

		// 与 sendMessage 一致：accepted（chat.send resolve）前，乐观 user 消息带
		// _pending=true，ChatMsgItem 渲染为 spinner 占位、不显示命令文本；
		// chat.send 成功返回后清 _pending，bubble 才呈现真实命令文本。
		test('优化 user 消息：chat.send 接受前 _pending=true，接受后清除', async () => {
			let resolveReq;
			conn.request.mockImplementation(() => new Promise((resolve) => { resolveReq = resolve; }));
			const p = store.sendSlashCommand('/help');

			// chat.send 未 resolve：本地 user 消息应带 _pending=true
			expect(store.messages.length).toBe(1);
			expect(store.messages[0]._pending).toBe(true);

			// 模拟 chat.send 返回（accepted）
			resolveReq({ runId: 'r', status: 'started' });
			await Promise.resolve(); // flush microtasks
			await Promise.resolve();
			expect(store.messages[0]._pending).toBe(false);

			// 触发 final 让 sendSlashCommand 完整结束，避免悬挂
			const handler = conn.on.mock.calls.find((c) => c[0] === 'event:chat')[1];
			handler({ runId: store.__slashCommandRunId, state: 'final' });
			await p;
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

		// OpenClaw 不把 /new、/reset、/compact 持久化为 user message（拦截点：commands-compact.ts:71、session.ts:354），
		// 故 final 成功后必须移除本地乐观占位，避免残留错位到新会话或与 server 历史重复。
		test('/compact final 成功后移除本地乐观占位', async () => {
			setupConnForLoad(conn, { flatMessages: [], currentSessionId: 'sess-1' });
			const origImpl = conn.request.getMockImplementation();
			conn.request.mockImplementation((method, ...args) => {
				if (method === 'chat.send') return Promise.resolve({ runId: 'r', status: 'started' });
				return origImpl(method, ...args);
			});

			const p = store.sendSlashCommand('/compact');
			expect(store.messages.some((m) => m._local)).toBe(true);
			const handler = conn.on.mock.calls.find((c) => c[0] === 'event:chat')[1];
			handler({ runId: store.__slashCommandRunId, state: 'final' });
			await p; // resolve 现已随 .then 同步释放，await 返回时 removeSlashLocals 已执行

			expect(store.messages.some((m) => m._local)).toBe(false);
		});

		test('/new final 成功后移除本地乐观占位', async () => {
			setupConnForLoad(conn, { flatMessages: [], currentSessionId: 'new-sess' });
			const origImpl = conn.request.getMockImplementation();
			conn.request.mockImplementation((method, ...args) => {
				if (method === 'chat.send') return Promise.resolve({ runId: 'r', status: 'started' });
				return origImpl(method, ...args);
			});

			const p = store.sendSlashCommand('/new');
			expect(store.messages.some((m) => m._local)).toBe(true);
			const handler = conn.on.mock.calls.find((c) => c[0] === 'event:chat')[1];
			handler({ runId: store.__slashCommandRunId, state: 'final' });
			await p;

			expect(store.messages.some((m) => m._local)).toBe(false);
		});

		// race 回归：final 后 __cleanupSlashCommand 立刻置 sending=false，用户在 loadMessages
		// 异步期间可启动 sendMessage；若 .then 里无差别 __removeLocalMessages 会连带清掉
		// sendMessage 刚压入的 _local 占位，破坏其 onAccepted→streamingMsgs 流程。
		// 修复是按 id 精准删除，下面的用例验证不会误伤其它 _local。
		test('/compact final 后 loadMessages .then 不会清掉新 sendMessage 的 _local', async () => {
			setupConnForLoad(conn, { flatMessages: [], currentSessionId: 'sess-1' });
			const origImpl = conn.request.getMockImplementation();
			conn.request.mockImplementation((method, ...args) => {
				if (method === 'chat.send') return Promise.resolve({ runId: 'r', status: 'started' });
				return origImpl(method, ...args);
			});

			const p = store.sendSlashCommand('/compact');
			const slashLocalId = store.messages.find((m) => m._local).id;
			const handler = conn.on.mock.calls.find((c) => c[0] === 'event:chat')[1];
			handler({ runId: store.__slashCommandRunId, state: 'final' });
			// 模拟 race：loadMessages 的 .then 尚未跑完前，sendMessage 已 push 新占位
			store.messages.push(
				{ type: 'message', id: '__local_user_send', _local: true, message: { role: 'user', content: 'hi' } },
				{ type: 'message', id: '__local_claw_send', _local: true, _streaming: true, message: { role: 'assistant', content: '' } },
			);

			await p; // resolve 现已随 .then 同步释放，await 返回时 removeSlashLocals 已执行

			// slash 的占位被精准移除
			expect(store.messages.some((m) => m.id === slashLocalId)).toBe(false);
			// 新 sendMessage 的 _local 不受影响
			expect(store.messages.some((m) => m.id === '__local_user_send')).toBe(true);
			expect(store.messages.some((m) => m.id === '__local_claw_send')).toBe(true);
		});

		// 默认分支（如 /help）final 同步处理：slash 本地占位清除 + server 回复入列。
		// 该分支无异步，故不涉及 race 场景（race 回归见上一条 /compact 测试）。
		test('默认分支 final 后清除自身占位并入列 server 回复', async () => {
			const p = store.sendSlashCommand('/help');
			expect(store.messages.some((m) => m._local)).toBe(true);
			const slashLocalId = store.messages.find((m) => m._local).id;
			const handler = conn.on.mock.calls.find((c) => c[0] === 'event:chat')[1];
			handler({
				runId: store.__slashCommandRunId,
				state: 'final',
				message: { role: 'assistant', content: 'help text' },
			});
			await p;

			expect(store.messages.some((m) => m.id === slashLocalId)).toBe(false);
			expect(store.messages).toHaveLength(1);
			expect(store.messages[0].message.role).toBe('assistant');
			expect(store.messages[0].message.content).toBe('help text');
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

		test('/compact 使用与 agent run 对齐的 POST_ACCEPT_TIMEOUT_MS 超时', async () => {
			vi.useFakeTimers();
			const p = store.sendSlashCommand('/compact');
			expect(store.sending).toBe(true);

			// 10min 后不应超时（/new|/reset 的 600s 已超，但 /compact 对齐 agent）
			vi.advanceTimersByTime(600_000);
			expect(store.__slashCommandRunId).not.toBeNull();

			// 推进到 POST_ACCEPT_TIMEOUT_MS 后超时
			vi.advanceTimersByTime(POST_ACCEPT_TIMEOUT_MS - 600_000);
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

		test('cleanup 主动 settle 挂起的 slash command promise（防止调用方 await 永久悬挂）', async () => {
			const p = store.sendSlashCommand('/help');
			expect(store.__slashCommandRunId).toBeTruthy();
			expect(store.sending).toBe(true);

			// 直接走 cleanup（模拟 dispose / logout 路径）
			store.cleanup();

			// promise 应被 resolve（而非永挂）
			await expect(p).resolves.toBeUndefined();
			expect(store.__slashCommandResolve).toBeNull();
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

		test('sending=true 时 loadMessages 不影响 run 状态（仍 isRunning=true）', async () => {
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
