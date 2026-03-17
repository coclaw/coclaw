import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { useTopicsStore } from './topics.store.js';

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

vi.mock('../services/bots.api.js', () => ({
	listBots: vi.fn().mockResolvedValue([]),
}));

import { useBotsStore } from './bots.store.js';

function mockConn(topicsResponse, state = 'connected') {
	return {
		state,
		request: vi.fn().mockResolvedValue(topicsResponse),
		on: vi.fn(),
		off: vi.fn(),
	};
}

describe('topics store', () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		mockConnections.clear();
		vi.clearAllMocks();
	});

	test('loadAllTopics 无 bot 时返回空', async () => {
		const store = useTopicsStore();
		await store.loadAllTopics();
		expect(store.items).toEqual([]);
	});

	test('loadAllTopics 无已连接 bot 时清空 items', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([{ id: 'bot-1', name: 'B1', online: false }]);

		const store = useTopicsStore();
		store.items = [{ topicId: 'old', agentId: 'main', title: 'Old', createdAt: 100, botId: 'bot-1' }];
		await store.loadAllTopics();
		expect(store.items).toEqual([]);
	});

	test('loadAllTopics 从已连接 bot 加载 topics', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([{ id: 'bot-1', name: 'B1', online: true }]);

		const conn = mockConn({
			topics: [
				{ topicId: 't1', agentId: 'main', title: '话题一', createdAt: 1000 },
				{ topicId: 't2', agentId: 'main', title: null, createdAt: 2000 },
			],
		});
		mockConnections.set('bot-1', conn);

		const store = useTopicsStore();
		await store.loadAllTopics();

		expect(store.items).toHaveLength(2);
		expect(store.items[0]).toEqual({
			topicId: 't1', agentId: 'main', title: '话题一', createdAt: 1000, botId: 'bot-1',
		});
		expect(store.items[1]).toEqual({
			topicId: 't2', agentId: 'main', title: null, createdAt: 2000, botId: 'bot-1',
		});
	});

	test('loadAllTopics 从多 bot 加载并合并（只查 main agent）', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([
			{ id: 'bot-1', name: 'B1', online: true },
			{ id: 'bot-2', name: 'B2', online: true },
		]);

		const conn1 = mockConn({ topics: [{ topicId: 't-main', agentId: 'main', title: 'Main topic', createdAt: 100 }] });
		const conn2 = mockConn({ topics: [{ topicId: 't-b2', agentId: 'main', title: 'B2 topic', createdAt: 300 }] });
		mockConnections.set('bot-1', conn1);
		mockConnections.set('bot-2', conn2);

		const store = useTopicsStore();
		await store.loadAllTopics();

		expect(store.items).toHaveLength(2);
		expect(store.items.map((t) => t.topicId).sort()).toEqual(['t-b2', 't-main']);
		// 每个 bot 只请求一次（main agent）
		expect(conn1.request).toHaveBeenCalledWith('coclaw.topics.list', { agentId: 'main' });
		expect(conn2.request).toHaveBeenCalledWith('coclaw.topics.list', { agentId: 'main' });
	});

	test('loadAllTopics 部分失败时保留成功结果', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([
			{ id: 'bot-ok', name: 'OK', online: true },
			{ id: 'bot-fail', name: 'Fail', online: true },
		]);

		const connOk = mockConn({ topics: [{ topicId: 't1', agentId: 'main', title: 'OK', createdAt: 100 }] });
		const connFail = {
			state: 'connected',
			request: vi.fn().mockRejectedValue(new Error('rpc error')),
			on: vi.fn(), off: vi.fn(),
		};
		mockConnections.set('bot-ok', connOk);
		mockConnections.set('bot-fail', connFail);

		const store = useTopicsStore();
		await store.loadAllTopics();

		expect(store.items).toHaveLength(1);
		expect(store.items[0].topicId).toBe('t1');
	});

	test('并发 loadAllTopics 应合流', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([{ id: 'bot-1', name: 'B1', online: true }]);

		const conn = mockConn({ topics: [{ topicId: 't1', agentId: 'main', title: 'T', createdAt: 100 }] });
		mockConnections.set('bot-1', conn);

		const store = useTopicsStore();
		await Promise.all([store.loadAllTopics(), store.loadAllTopics()]);

		expect(conn.request).toHaveBeenCalledTimes(1);
		expect(store.loading).toBe(false);
	});

	test('loading 状态管理', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([{ id: 'bot-1', name: 'B1', online: true }]);

		const conn = mockConn({ topics: [] });
		mockConnections.set('bot-1', conn);

		const store = useTopicsStore();
		expect(store.loading).toBe(false);

		const p = store.loadAllTopics();
		expect(store.loading).toBe(true);

		await p;
		expect(store.loading).toBe(false);
	});

	// --- createTopic ---

	test('createTopic 成功创建并插入本地缓存头部', async () => {
		const conn = {
			state: 'connected',
			request: vi.fn().mockResolvedValue({ topicId: 'new-uuid' }),
			on: vi.fn(), off: vi.fn(),
		};
		mockConnections.set('bot-1', conn);

		const store = useTopicsStore();
		store.items = [{ topicId: 'old', agentId: 'main', title: 'Old', createdAt: 100, botId: 'bot-1' }];

		const id = await store.createTopic('bot-1', 'main');
		expect(id).toBe('new-uuid');
		expect(store.items).toHaveLength(2);
		expect(store.items[0].topicId).toBe('new-uuid');
		expect(store.items[0].title).toBeNull();
		expect(store.items[0].agentId).toBe('main');
		expect(store.items[0].botId).toBe('bot-1');
		expect(conn.request).toHaveBeenCalledWith('coclaw.topics.create', { agentId: 'main' });
	});

	test('createTopic bot 未连接时抛出错误', async () => {
		const store = useTopicsStore();
		await expect(store.createTopic('no-bot', 'main')).rejects.toThrow('Bot not connected');
	});

	test('createTopic 连接状态非 connected 时抛出错误', async () => {
		mockConnections.set('bot-1', { state: 'connecting', request: vi.fn(), on: vi.fn(), off: vi.fn() });

		const store = useTopicsStore();
		await expect(store.createTopic('bot-1', 'main')).rejects.toThrow('Bot not connected');
	});

	// --- getHistory ---

	test('getHistory 返回对话历史', async () => {
		const messages = [{ type: 'message', message: { role: 'user', content: 'hello' } }];
		const conn = {
			state: 'connected',
			request: vi.fn().mockResolvedValue({ messages }),
			on: vi.fn(), off: vi.fn(),
		};
		mockConnections.set('bot-1', conn);

		const store = useTopicsStore();
		const result = await store.getHistory('bot-1', 't1');
		expect(result).toEqual(messages);
		expect(conn.request).toHaveBeenCalledWith('coclaw.topics.getHistory', { topicId: 't1' });
	});

	test('getHistory 返回空数组当 messages 不存在', async () => {
		const conn = {
			state: 'connected',
			request: vi.fn().mockResolvedValue({ messages: null }),
			on: vi.fn(), off: vi.fn(),
		};
		mockConnections.set('bot-1', conn);

		const store = useTopicsStore();
		const result = await store.getHistory('bot-1', 't1');
		expect(result).toEqual([]);
	});

	// --- generateTitle ---

	test('generateTitle 成功时更新本地 title', async () => {
		const conn = {
			state: 'connected',
			request: vi.fn().mockResolvedValue({ title: '新标题' }),
			on: vi.fn(), off: vi.fn(),
		};
		mockConnections.set('bot-1', conn);

		const store = useTopicsStore();
		store.items = [{ topicId: 't1', agentId: 'main', title: null, createdAt: 100, botId: 'bot-1' }];

		store.generateTitle('bot-1', 't1');
		// generateTitle 是 fire-and-forget，需等待微任务完成
		await vi.waitFor(() => {
			expect(store.items[0].title).toBe('新标题');
		});
		expect(conn.request).toHaveBeenCalledWith('coclaw.topics.generateTitle', { topicId: 't1' });
	});

	test('generateTitle 失败时不影响本地数据', async () => {
		const conn = {
			state: 'connected',
			request: vi.fn().mockRejectedValue(new Error('agent error')),
			on: vi.fn(), off: vi.fn(),
		};
		mockConnections.set('bot-1', conn);

		const store = useTopicsStore();
		store.items = [{ topicId: 't1', agentId: 'main', title: null, createdAt: 100, botId: 'bot-1' }];

		store.generateTitle('bot-1', 't1');
		await vi.waitFor(() => {
			expect(conn.request).toHaveBeenCalled();
		});
		// title 保持 null
		expect(store.items[0].title).toBeNull();
	});

	test('generateTitle bot 未连接时静默返回', () => {
		const store = useTopicsStore();
		// 不应抛出异常
		store.generateTitle('no-bot', 't1');
	});

	// --- findTopic getter ---

	test('findTopic 返回匹配的 topic', () => {
		const store = useTopicsStore();
		store.items = [
			{ topicId: 't1', agentId: 'main', title: 'A', createdAt: 100, botId: 'b1' },
			{ topicId: 't2', agentId: 'ops', title: 'B', createdAt: 200, botId: 'b2' },
		];
		const found = store.findTopic('t2');
		expect(found.topicId).toBe('t2');
		expect(found.agentId).toBe('ops');
	});

	test('findTopic 未找到时返回 null', () => {
		const store = useTopicsStore();
		store.items = [{ topicId: 't1', agentId: 'main', title: 'A', createdAt: 100, botId: 'b1' }];
		expect(store.findTopic('nonexistent')).toBeNull();
	});
});
