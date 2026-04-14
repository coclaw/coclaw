import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { useTopicsStore } from './topics.store.js';

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

vi.mock('../services/claws.api.js', () => ({
	listClaws: vi.fn().mockResolvedValue([]),
}));

import { useClawsStore } from './claws.store.js';

function mockConn(topicsResponse) {
	return {
		request: vi.fn().mockResolvedValue(topicsResponse),
		on: vi.fn(),
		off: vi.fn(),
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

/** 辅助：将 topic 数组转为 byId 格式 */
function toById(items) {
	const byId = {};
	for (const t of items) byId[t.topicId] = t;
	return byId;
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

	test('loadAllTopics 无已连接 bot 时保留现有 items（不清空）', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: false }]);

		const store = useTopicsStore();
		const existing = [{ topicId: 'old', agentId: 'main', title: 'Old', createdAt: 100, clawId: 'bot-1' }];
		store.byId = toById(existing);
		await store.loadAllTopics();
		// 重连过渡期间保留缓存数据，不清空
		expect(store.items).toHaveLength(1);
		expect(store.byId['old'].title).toBe('Old');
	});

	test('loadAllTopics 从已连接 bot 加载 topics', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);

		const conn = mockConn({
			topics: [
				{ topicId: 't1', agentId: 'main', title: '话题一', createdAt: 1000 },
				{ topicId: 't2', agentId: 'main', title: null, createdAt: 2000 },
			],
		});
		setConn('bot-1', conn);

		const store = useTopicsStore();
		await store.loadAllTopics();

		expect(store.items).toHaveLength(2);
		expect(store.byId['t1']).toEqual({
			topicId: 't1', agentId: 'main', title: '话题一', createdAt: 1000, clawId: 'bot-1',
		});
		expect(store.byId['t2']).toEqual({
			topicId: 't2', agentId: 'main', title: null, createdAt: 2000, clawId: 'bot-1',
		});
	});

	test('loadAllTopics 从多 bot 加载并合并（只查 main agent）', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([
			{ id: 'bot-1', name: 'B1', online: true },
			{ id: 'bot-2', name: 'B2', online: true },
		]);

		const conn1 = mockConn({ topics: [{ topicId: 't-main', agentId: 'main', title: 'Main topic', createdAt: 100 }] });
		const conn2 = mockConn({ topics: [{ topicId: 't-b2', agentId: 'main', title: 'B2 topic', createdAt: 300 }] });
		setConn('bot-1', conn1);
		setConn('bot-2', conn2);

		const store = useTopicsStore();
		await store.loadAllTopics();

		expect(store.items).toHaveLength(2);
		expect(store.byId['t-main']).toBeTruthy();
		expect(store.byId['t-b2']).toBeTruthy();
		// 每个 bot 只请求一次（main agent）
		expect(conn1.request).toHaveBeenCalledWith('coclaw.topics.list', { agentId: 'main' }, { timeout: 60_000 });
		expect(conn2.request).toHaveBeenCalledWith('coclaw.topics.list', { agentId: 'main' }, { timeout: 60_000 });
	});

	test('loadAllTopics 增量合并：保留未查询 bot 的已有 topics', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([
			{ id: 'bot-1', name: 'B1', online: true },
			{ id: 'bot-2', name: 'B2', online: true },
		]);

		// bot-1 已连接，bot-2 未连接
		const conn1 = mockConn({ topics: [{ topicId: 't1', agentId: 'main', title: 'New', createdAt: 200 }] });
		setConn('bot-1', conn1);
		// bot-2 无连接

		const store = useTopicsStore();
		// 预存 bot-2 的旧 topics
		store.byId = toById([
			{ topicId: 't2', agentId: 'main', title: 'Old B2', createdAt: 100, clawId: 'bot-2' },
		]);

		await store.loadAllTopics();

		// bot-1 的 topics 应被加载，bot-2 的旧 topics 应保留
		expect(store.items).toHaveLength(2);
		expect(store.byId['t1'].title).toBe('New');
		expect(store.byId['t1'].clawId).toBe('bot-1');
		expect(store.byId['t2'].title).toBe('Old B2');
		expect(store.byId['t2'].clawId).toBe('bot-2');
	});

	test('loadAllTopics 增量合并：清理已删除 bot 的残留 topics', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);

		const conn1 = mockConn({ topics: [{ topicId: 't1', agentId: 'main', title: 'A', createdAt: 100 }] });
		setConn('bot-1', conn1);

		const store = useTopicsStore();
		// 预存已删除 bot 的 topics
		store.byId = toById([
			{ topicId: 't-old', agentId: 'main', title: 'Deleted bot', createdAt: 50, clawId: 'bot-removed' },
		]);

		await store.loadAllTopics();

		// 已删除 bot 的 topics 应被清理
		expect(store.byId['t-old']).toBeUndefined();
		expect(store.byId['t1']).toBeDefined();
		expect(store.items).toHaveLength(1);
	});

	test('loadAllTopics 部分失败时保留成功结果', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([
			{ id: 'bot-ok', name: 'OK', online: true },
			{ id: 'bot-fail', name: 'Fail', online: true },
		]);

		const connOk = mockConn({ topics: [{ topicId: 't1', agentId: 'main', title: 'OK', createdAt: 100 }] });
		const connFail = {
			request: vi.fn().mockRejectedValue(new Error('rpc error')),
			on: vi.fn(), off: vi.fn(),
		};
		setConn('bot-ok', connOk);
		setConn('bot-fail', connFail);

		const store = useTopicsStore();
		await store.loadAllTopics();

		expect(store.items).toHaveLength(1);
		expect(store.byId['t1'].topicId).toBe('t1');
	});

	test('并发 loadAllTopics 应合流', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);

		const conn = mockConn({ topics: [{ topicId: 't1', agentId: 'main', title: 'T', createdAt: 100 }] });
		setConn('bot-1', conn);

		const store = useTopicsStore();
		await Promise.all([store.loadAllTopics(), store.loadAllTopics()]);

		expect(conn.request).toHaveBeenCalledTimes(1);
		expect(store.loading).toBe(false);
	});

	test('loading 状态管理', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);

		const conn = mockConn({ topics: [] });
		setConn('bot-1', conn);

		const store = useTopicsStore();
		expect(store.loading).toBe(false);

		const p = store.loadAllTopics();
		expect(store.loading).toBe(true);

		await p;
		expect(store.loading).toBe(false);
	});

	// --- createTopic ---

	test('createTopic 成功创建并插入 byId', async () => {
		const conn = {
			request: vi.fn().mockResolvedValue({ topicId: 'new-uuid' }),
			on: vi.fn(), off: vi.fn(),
		};
		setConn('bot-1', conn);

		const store = useTopicsStore();
		store.byId = toById([{ topicId: 'old', agentId: 'main', title: 'Old', createdAt: 100, clawId: 'bot-1' }]);

		const id = await store.createTopic('bot-1', 'main');
		expect(id).toBe('new-uuid');
		expect(store.items).toHaveLength(2);
		expect(store.byId['new-uuid'].topicId).toBe('new-uuid');
		expect(store.byId['new-uuid'].title).toBeNull();
		expect(store.byId['new-uuid'].agentId).toBe('main');
		expect(store.byId['new-uuid'].clawId).toBe('bot-1');
		expect(conn.request).toHaveBeenCalledWith('coclaw.topics.create', { agentId: 'main' });
	});

	test('createTopic claw 未连接时抛出错误', async () => {
		const store = useTopicsStore();
		await expect(store.createTopic('no-bot', 'main')).rejects.toThrow('Claw not connected');
	});

	test('createTopic 在 dcReady=false 时仍能成功创建（由底层 waitReady 处理）', async () => {
		const conn = {
			request: vi.fn().mockResolvedValue({ topicId: 'new-uuid-2' }),
			on: vi.fn(), off: vi.fn(),
		};
		setConn('bot-1', conn, { dcReady: false });

		const store = useTopicsStore();
		const id = await store.createTopic('bot-1', 'main');
		expect(id).toBe('new-uuid-2');
		expect(conn.request).toHaveBeenCalledWith('coclaw.topics.create', { agentId: 'main' });
		expect(store.byId['new-uuid-2'].topicId).toBe('new-uuid-2');
	});

	// --- generateTitle ---

	test('generateTitle 成功时更新本地 title', async () => {
		const conn = {
			request: vi.fn().mockResolvedValue({ title: '新标题' }),
			on: vi.fn(), off: vi.fn(),
		};
		setConn('bot-1', conn);

		const store = useTopicsStore();
		store.byId = toById([{ topicId: 't1', agentId: 'main', title: null, createdAt: 100, clawId: 'bot-1' }]);

		store.generateTitle('bot-1', 't1');
		// generateTitle 是 fire-and-forget，需等待微任务完成
		await vi.waitFor(() => {
			expect(store.byId['t1'].title).toBe('新标题');
		});
		expect(conn.request).toHaveBeenCalledWith('coclaw.topics.generateTitle', { topicId: 't1' }, { timeout: 600_000 });
	});

	test('generateTitle 失败时不影响本地数据', async () => {
		const conn = {
			request: vi.fn().mockRejectedValue(new Error('agent error')),
			on: vi.fn(), off: vi.fn(),
		};
		setConn('bot-1', conn);

		const store = useTopicsStore();
		store.byId = toById([{ topicId: 't1', agentId: 'main', title: null, createdAt: 100, clawId: 'bot-1' }]);

		store.generateTitle('bot-1', 't1');
		await vi.waitFor(() => {
			expect(conn.request).toHaveBeenCalled();
		});
		// title 保持 null
		expect(store.byId['t1'].title).toBeNull();
	});

	test('generateTitle claw 未连接时静默返回', () => {
		const store = useTopicsStore();
		// 不应抛出异常
		store.generateTitle('no-bot', 't1');
	});

	test('generateTitle 并发调用同一 topicId 时只发一次请求，完成后可再次调用', async () => {
		let resolveReq;
		const conn = {
			request: vi.fn().mockImplementation(() => new Promise((resolve) => { resolveReq = resolve; })),
			on: vi.fn(), off: vi.fn(),
		};
		setConn('bot-1', conn);

		const store = useTopicsStore();
		store.byId = toById([{ topicId: 't1', agentId: 'main', title: null, createdAt: 100, clawId: 'bot-1' }]);

		store.generateTitle('bot-1', 't1');
		store.generateTitle('bot-1', 't1');
		expect(conn.request).toHaveBeenCalledTimes(1);

		resolveReq({ title: '标题' });
		await vi.waitFor(() => {
			expect(store.byId['t1'].title).toBe('标题');
		});
		// 等 .finally() 清理防重入锁
		await new Promise((r) => setTimeout(r, 0));

		// 完成后可再次调用
		conn.request.mockResolvedValue({ title: '新标题' });
		store.generateTitle('bot-1', 't1');
		expect(conn.request).toHaveBeenCalledTimes(2);
	});

	test('generateTitle 失败后允许重新调用', async () => {
		let rejectReq;
		const conn = {
			request: vi.fn().mockImplementation(() => new Promise((_, reject) => { rejectReq = reject; })),
			on: vi.fn(), off: vi.fn(),
		};
		setConn('bot-1', conn);

		const store = useTopicsStore();
		store.byId = toById([{ topicId: 't2', agentId: 'main', title: null, createdAt: 100, clawId: 'bot-1' }]);

		store.generateTitle('bot-1', 't2');
		expect(conn.request).toHaveBeenCalledTimes(1);

		rejectReq(new Error('fail'));
		// 等 .catch() + .finally() 完成
		await new Promise((r) => setTimeout(r, 0));

		// 失败后应可重新调用
		conn.request.mockResolvedValue({ title: '重试标题' });
		store.generateTitle('bot-1', 't2');
		await vi.waitFor(() => {
			expect(store.byId['t2'].title).toBe('重试标题');
		});
		expect(conn.request).toHaveBeenCalledTimes(2);
	});

	// --- deleteTopic ---

	test('deleteTopic 成功删除并移除 byId 条目', async () => {
		const conn = {
			request: vi.fn().mockResolvedValue({ ok: true }),
			on: vi.fn(), off: vi.fn(),
		};
		setConn('bot-1', conn);

		const store = useTopicsStore();
		store.byId = toById([
			{ topicId: 't1', agentId: 'main', title: 'A', createdAt: 100, clawId: 'bot-1' },
			{ topicId: 't2', agentId: 'main', title: 'B', createdAt: 200, clawId: 'bot-1' },
		]);

		await store.deleteTopic('bot-1', 't1');
		expect(store.items).toHaveLength(1);
		expect(store.byId['t1']).toBeUndefined();
		expect(store.byId['t2']).toBeTruthy();
		expect(conn.request).toHaveBeenCalledWith('coclaw.topics.delete', { topicId: 't1' });
	});

	test('deleteTopic topic 不存在时抛出错误', async () => {
		const conn = {
			request: vi.fn().mockResolvedValue({ ok: false }),
			on: vi.fn(), off: vi.fn(),
		};
		setConn('bot-1', conn);

		const store = useTopicsStore();
		await expect(store.deleteTopic('bot-1', 'nonexistent')).rejects.toThrow('Topic not found');
	});

	test('deleteTopic claw 未连接时抛出错误', async () => {
		const store = useTopicsStore();
		await expect(store.deleteTopic('no-bot', 't1')).rejects.toThrow('Claw not connected');
	});

	// --- updateTopic ---

	test('updateTopic 成功更新并同步本地缓存', async () => {
		const conn = {
			request: vi.fn().mockResolvedValue({ topic: { topicId: 't1', agentId: 'main', title: '新标题', createdAt: 100 } }),
			on: vi.fn(), off: vi.fn(),
		};
		setConn('bot-1', conn);

		const store = useTopicsStore();
		store.byId = toById([{ topicId: 't1', agentId: 'main', title: 'Old', createdAt: 100, clawId: 'bot-1' }]);

		await store.updateTopic('bot-1', 't1', { title: '新标题' });
		expect(store.byId['t1'].title).toBe('新标题');
		expect(store.byId['t1'].clawId).toBe('bot-1'); // clawId 保留
		expect(conn.request).toHaveBeenCalledWith('coclaw.topics.update', { topicId: 't1', changes: { title: '新标题' } });
	});

	test('updateTopic 响应无 topic 时抛出错误', async () => {
		const conn = {
			request: vi.fn().mockResolvedValue({}),
			on: vi.fn(), off: vi.fn(),
		};
		setConn('bot-1', conn);

		const store = useTopicsStore();
		store.byId = toById([{ topicId: 't1', agentId: 'main', title: 'Old', createdAt: 100, clawId: 'bot-1' }]);
		await expect(store.updateTopic('bot-1', 't1', { title: 'x' })).rejects.toThrow('Update failed');
	});

	test('updateTopic claw 未连接时抛出错误', async () => {
		const store = useTopicsStore();
		await expect(store.updateTopic('no-bot', 't1', { title: 'x' })).rejects.toThrow('Claw not connected');
	});

	// --- removeByClaw ---

	test('removeByClaw 移除指定 claw 的所有 topics', () => {
		const store = useTopicsStore();
		store.byId = toById([
			{ topicId: 't1', agentId: 'main', title: 'A', createdAt: 100, clawId: 'bot-1' },
			{ topicId: 't2', agentId: 'main', title: 'B', createdAt: 200, clawId: 'bot-1' },
			{ topicId: 't3', agentId: 'main', title: 'C', createdAt: 300, clawId: 'bot-2' },
		]);

		store.removeByClaw('bot-1');

		expect(store.items).toHaveLength(1);
		expect(store.byId['t1']).toBeUndefined();
		expect(store.byId['t2']).toBeUndefined();
		expect(store.byId['t3']).toBeDefined();
	});

	test('removeByClaw 目标 bot 无 topics 时无副作用', () => {
		const store = useTopicsStore();
		store.byId = toById([
			{ topicId: 't1', agentId: 'main', title: 'A', createdAt: 100, clawId: 'bot-1' },
		]);

		store.removeByClaw('nonexistent');

		expect(store.items).toHaveLength(1);
	});

	// --- findTopic getter ---

	test('findTopic 返回匹配的 topic', () => {
		const store = useTopicsStore();
		store.byId = toById([
			{ topicId: 't1', agentId: 'main', title: 'A', createdAt: 100, clawId: 'b1' },
			{ topicId: 't2', agentId: 'ops', title: 'B', createdAt: 200, clawId: 'b2' },
		]);
		const found = store.findTopic('t2');
		expect(found.topicId).toBe('t2');
		expect(found.agentId).toBe('ops');
	});

	test('findTopic 未找到时返回 null', () => {
		const store = useTopicsStore();
		store.byId = toById([{ topicId: 't1', agentId: 'main', title: 'A', createdAt: 100, clawId: 'b1' }]);
		expect(store.findTopic('nonexistent')).toBeNull();
	});
});
