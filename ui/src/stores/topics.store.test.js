// @vitest-environment node
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { useTopicsStore, __resetTopicsInternals } from './topics.store.js';

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
		__resetTopicsInternals(); // 清模块级 in-flight Map，防跨用例污染
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
		expect(conn.request).toHaveBeenCalledWith('coclaw.topics.create', { agentId: 'main' }, { timeout: 60_000 });
	});

	test('createTopic claw 未连接时抛出错误', async () => {
		const store = useTopicsStore();
		await expect(store.createTopic('no-bot', 'main')).rejects.toThrow('Claw not connected');
	});

	// await 期间 claw 被另一端解绑（SSE claw.unbound → removeByClaw 同步清 byId）：
	// plugin 那条 JSON 是持久信息，重绑同 id claw 会自然拉回；UI 端不应再写一条挂在
	// 已消失 claw 上的 dangling 条目（点开会失败）。
	test('createTopic await 期间 claw 被解绑 → 不写本地 byId（plugin 那条由重绑后 loadTopicsForClaw 拉回）', async () => {
		const clawsStore = useClawsStore();
		let resolveCreate;
		const conn = {
			request: vi.fn().mockImplementation(() => new Promise((r) => { resolveCreate = r; })),
			on: vi.fn(), off: vi.fn(),
		};
		setConn('bot-1', conn);

		const store = useTopicsStore();
		const p = store.createTopic('bot-1', 'main');

		// await 飞行中：另一端解绑 → SSE 推送 → removeByClaw + clawsStore.byId 同步清
		delete clawsStore.byId['bot-1'];

		// plugin 端创建已落库，返回 topicId（持久数据正确）
		resolveCreate({ topicId: 'orphan-uuid' });
		const id = await p;

		// 返回 topicId 仍是真的（plugin 写好了），UI 端跳过本地写入
		expect(id).toBe('orphan-uuid');
		expect(store.byId['orphan-uuid']).toBeUndefined();
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
		expect(conn.request).toHaveBeenCalledWith('coclaw.topics.create', { agentId: 'main' }, { timeout: 60_000 });
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
		expect(conn.request).toHaveBeenCalledWith('coclaw.topics.delete', { topicId: 't1' }, { timeout: 60_000 });
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
		expect(conn.request).toHaveBeenCalledWith('coclaw.topics.update', { topicId: 't1', changes: { title: '新标题' } }, { timeout: 60_000 });
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

	describe('loadTopicsForClaw (per-claw)', () => {
		test('仅替换该 claw 的 topics，其他 claw 的旧数据保留', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([
				{ id: 'bot-1', name: 'B1', online: true },
				{ id: 'bot-2', name: 'B2', online: true },
			]);
			const conn1 = mockConn({ topics: [{ topicId: 't1', agentId: 'main', title: 'T1', createdAt: 100 }] });
			const conn2 = mockConn({ topics: [{ topicId: 't2', agentId: 'main', title: 'T2', createdAt: 200 }] });
			setConn('bot-1', conn1);
			setConn('bot-2', conn2);

			const store = useTopicsStore();
			await store.loadAllTopics();
			expect(store.items).toHaveLength(2);

			// bot-1 新增一个 topic，bot-2 不变
			conn1.request.mockResolvedValue({
				topics: [
					{ topicId: 't1', agentId: 'main', title: 'T1', createdAt: 100 },
					{ topicId: 't1b', agentId: 'main', title: 'T1b', createdAt: 150 },
				],
			});
			await store.loadTopicsForClaw('bot-1');

			expect(store.items).toHaveLength(3);
			expect(store.byId['t1']).toBeDefined();
			expect(store.byId['t1b']).toBeDefined();
			expect(store.byId['t2']).toBeDefined();
			expect(store.byId['t2'].title).toBe('T2');
			expect(conn2.request).toHaveBeenCalledTimes(1); // 没再打扰 bot-2
		});

		test('该 claw 服务端删除某 topic 后，对应条目被移除', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);
			const conn = mockConn({
				topics: [
					{ topicId: 't1', agentId: 'main', title: 'A', createdAt: 100 },
					{ topicId: 't2', agentId: 'main', title: 'B', createdAt: 200 },
				],
			});
			setConn('bot-1', conn);

			const store = useTopicsStore();
			await store.loadAllTopics();
			expect(store.items).toHaveLength(2);

			// 服务端只剩 t1
			conn.request.mockResolvedValue({
				topics: [{ topicId: 't1', agentId: 'main', title: 'A', createdAt: 100 }],
			});
			await store.loadTopicsForClaw('bot-1');

			expect(store.items).toHaveLength(1);
			expect(store.byId['t1']).toBeDefined();
			expect(store.byId['t2']).toBeUndefined();
		});

		test('无连接时跳过，不动 byId', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);
			const conn = mockConn({ topics: [{ topicId: 't1', agentId: 'main', title: 'A', createdAt: 100 }] });
			setConn('bot-1', conn);

			const store = useTopicsStore();
			await store.loadAllTopics();
			expect(store.items).toHaveLength(1);

			clawsStore.byId['bot-1'].dcReady = false;
			await store.loadTopicsForClaw('bot-1');

			expect(store.items).toHaveLength(1); // 旧数据保留
			expect(conn.request).toHaveBeenCalledTimes(1); // 没再发请求
		});

		test('RPC 失败时保留旧 topics', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);
			const conn = mockConn({ topics: [{ topicId: 't1', agentId: 'main', title: 'A', createdAt: 100 }] });
			setConn('bot-1', conn);

			const store = useTopicsStore();
			await store.loadAllTopics();
			expect(store.items).toHaveLength(1);

			conn.request.mockRejectedValueOnce(new Error('rpc error'));
			await store.loadTopicsForClaw('bot-1');

			expect(store.items).toHaveLength(1); // 旧数据保留
			expect(store.byId['t1'].title).toBe('A');
		});

		test('同 claw 并发调用合流到同一 promise', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);
			const conn = mockConn({ topics: [{ topicId: 't1', agentId: 'main', title: 'A', createdAt: 100 }] });
			setConn('bot-1', conn);

			const store = useTopicsStore();
			await Promise.all([
				store.loadTopicsForClaw('bot-1'),
				store.loadTopicsForClaw('bot-1'),
				store.loadTopicsForClaw('bot-1'),
			]);

			expect(conn.request).toHaveBeenCalledTimes(1);
			expect(store.items).toHaveLength(1);
		});

		test('不同 claw 并发不互相合流', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([
				{ id: 'bot-1', name: 'B1', online: true },
				{ id: 'bot-2', name: 'B2', online: true },
			]);
			const conn1 = mockConn({ topics: [{ topicId: 't1', agentId: 'main', title: 'A', createdAt: 100 }] });
			const conn2 = mockConn({ topics: [{ topicId: 't2', agentId: 'main', title: 'B', createdAt: 200 }] });
			setConn('bot-1', conn1);
			setConn('bot-2', conn2);

			const store = useTopicsStore();
			await Promise.all([
				store.loadTopicsForClaw('bot-1'),
				store.loadTopicsForClaw('bot-2'),
			]);

			expect(conn1.request).toHaveBeenCalledTimes(1);
			expect(conn2.request).toHaveBeenCalledTimes(1);
			expect(store.items).toHaveLength(2);
		});

		test('顺手清理已不存在的 claw 的旧 topics', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([
				{ id: 'bot-1', name: 'B1', online: true },
				{ id: 'bot-gone', name: 'Gone', online: true },
			]);
			const conn1 = mockConn({ topics: [{ topicId: 't1', agentId: 'main', title: 'A', createdAt: 100 }] });
			const connGone = mockConn({ topics: [{ topicId: 't-gone', agentId: 'main', title: 'X', createdAt: 50 }] });
			setConn('bot-1', conn1);
			setConn('bot-gone', connGone);

			const store = useTopicsStore();
			await store.loadAllTopics();
			expect(store.items).toHaveLength(2);

			delete clawsStore.byId['bot-gone'];
			await store.loadTopicsForClaw('bot-1');

			expect(store.items).toHaveLength(1);
			expect(store.byId['t1']).toBeDefined();
			expect(store.byId['t-gone']).toBeUndefined();
		});

		test('clawId 归一化为 string', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 42, name: 'B', online: true }]);
			const conn = mockConn({ topics: [{ topicId: 't1', agentId: 'main', title: 'A', createdAt: 100 }] });
			setConn('42', conn);

			const store = useTopicsStore();
			await store.loadTopicsForClaw(42);

			expect(store.items).toHaveLength(1);
			expect(store.byId['t1'].clawId).toBe('42');
		});

		test('fetch 期间目标 claw 被移除时丢弃结果（防幽灵数据）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([
				{ id: 'bot-1', name: 'B1', online: true },
				{ id: 'bot-keep', name: 'Keep', online: true },
			]);
			let resolveReq;
			const deferredConn = {
				request: vi.fn().mockImplementation(() => new Promise((r) => { resolveReq = r; })),
				on: vi.fn(),
				off: vi.fn(),
			};
			setConn('bot-1', deferredConn);
			const connKeep = mockConn({ topics: [{ topicId: 't-keep', agentId: 'main', title: 'Keep', createdAt: 100 }] });
			setConn('bot-keep', connKeep);

			const store = useTopicsStore();
			await store.loadTopicsForClaw('bot-keep');
			expect(store.items).toHaveLength(1);

			// 触发 bot-1 的 loadForClaw 进入 await fetch
			const inflight = store.loadTopicsForClaw('bot-1');

			// 模拟 SSE claw.unbound：同步移除 bot-1
			delete clawsStore.byId['bot-1'];
			store.removeByClaw('bot-1');

			// fetch 返回结果
			resolveReq({ topics: [{ topicId: 't-ghost', agentId: 'main', title: 'Ghost', createdAt: 200 }] });
			await inflight;

			// bot-1 已被移除，刚 fetch 到的数据不应写回
			expect(store.byId['t-ghost']).toBeUndefined();
			// bot-keep 不受影响
			expect(store.byId['t-keep']).toBeDefined();
		});

		// removeByClaw 必须对称清 _perClawLoading：否则 claw 同 id 重绑后
		// 新 loadTopicsForClaw 被旧 dedup 拦死，新 conn 不会发起请求。
		test('removeByClaw 期间清飞行中 dedup：同 id 重绑后新 loadForClaw 走独立请求', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);

			let resolveOld;
			const oldConn = {
				request: vi.fn().mockImplementation(() => new Promise((r) => { resolveOld = r; })),
				on: vi.fn(),
				off: vi.fn(),
			};
			setConn('bot-1', oldConn);

			const store = useTopicsStore();
			const oldPromise = store.loadTopicsForClaw('bot-1');
			expect(oldConn.request).toHaveBeenCalledTimes(1);

			// 模拟 SSE claw.unbound：同步移除 + 立刻同 id 重绑
			delete clawsStore.byId['bot-1'];
			store.removeByClaw('bot-1');
			clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);
			const newConn = mockConn({ topics: [{ topicId: 't-new', agentId: 'main', title: 'New', createdAt: 100 }] });
			setConn('bot-1', newConn);

			// 关键断言：新 loadForClaw 必须不被旧 dedup 拦死，发起独立请求
			const newPromise = store.loadTopicsForClaw('bot-1');
			expect(newConn.request).toHaveBeenCalledTimes(1);
			await newPromise;
			expect(store.byId['t-new']).toBeDefined();

			// 解析旧 promise：让 promise 自然 settle
			resolveOld({ topics: [{ topicId: 't-old', agentId: 'main', title: 'Old', createdAt: 200 }] });
			await oldPromise;
		});

		// 同 id 重绑：旧 loadTopicsForClaw 的 stale finally 不能把替换上去的新 promise
		// 删掉，否则下一次同 id 调用 dedup 失效，会发起第三次 RPC
		test('同 id 重绑：旧 loadTopicsForClaw 的 stale finally 不删替换 promise', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);

			let resolveOld;
			const oldConn = {
				request: vi.fn().mockImplementation(() => new Promise((r) => { resolveOld = r; })),
				on: vi.fn(),
				off: vi.fn(),
			};
			setConn('bot-1', oldConn);

			const store = useTopicsStore();
			const oldPromise = store.loadTopicsForClaw('bot-1');
			expect(oldConn.request).toHaveBeenCalledTimes(1);

			// 重绑：清掉再加，并换 deferred newConn
			delete clawsStore.byId['bot-1'];
			store.removeByClaw('bot-1');
			clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);
			let resolveNew;
			const newConn = {
				request: vi.fn().mockImplementation(() => new Promise((r) => { resolveNew = r; })),
				on: vi.fn(),
				off: vi.fn(),
			};
			setConn('bot-1', newConn);

			// 第一次新 loadForClaw：发起新 RPC、新 promise 入 in-flight Map
			const newPromise1 = store.loadTopicsForClaw('bot-1');
			expect(newConn.request).toHaveBeenCalledTimes(1);

			// 解析旧 promise，让 stale finally 跑完
			resolveOld({ topics: [] });
			await oldPromise;
			await Promise.resolve();
			await Promise.resolve();

			// 关键：第三次同 id loadForClaw 应被新 promise dedup 拦下，不发起第三次 RPC
			const newPromise2 = store.loadTopicsForClaw('bot-1');
			expect(newConn.request).toHaveBeenCalledTimes(1);

			// 收尾：把两个外层 promise 都 await 收完
			resolveNew({ topics: [] });
			await newPromise1;
			await newPromise2;
		});
	});

	describe('loadAllTopics edge cases', () => {
		test('同步 conn 消失的 claw 不发请求，旧 topics 保留', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([
				{ id: 'bot-A', name: 'A', online: true },
				{ id: 'bot-B', name: 'B', online: true },
			]);

			// bot-A 进入 setClaws 后立刻把 conn 抹掉：getReadyConn(A) 在 connectedClaws filter 时返 null
			const connA = mockConn({ topics: [] });
			setConn('bot-A', connA);
			mockConnections.delete('bot-A');

			// bot-B 正常返 1 条新 topic
			const connB = mockConn({ topics: [{ topicId: 't-B-new', agentId: 'main', title: 'B new', createdAt: 200 }] });
			setConn('bot-B', connB);

			const store = useTopicsStore();
			// 预置 bot-A 的旧 topic
			store.byId = toById([{ topicId: 't-A-old', agentId: 'main', title: 'A old', createdAt: 100, clawId: 'bot-A' }]);

			await store.loadAllTopics();

			// 关键：A 旧 topic 必须保留（A 不在 connectedClaws，loadTopicsForClaw 不触发）
			expect(store.byId['t-A-old']?.title).toBe('A old');
			// B 新 topic 写入
			expect(store.byId['t-B-new']?.title).toBe('B new');
			// A 一次 RPC 都没发
			expect(connA.request).toHaveBeenCalledTimes(0);
			expect(connB.request).toHaveBeenCalledTimes(1);
		});

		test('conn 健康但远端真空 topics 时，旧 topics 被清空', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);

			// 预置 bot-1 的旧 topic
			const store = useTopicsStore();
			store.byId = toById([{ topicId: 't-stale', agentId: 'main', title: 'Stale', createdAt: 50, clawId: 'bot-1' }]);

			// conn 全程在线，远端返空 topics
			const conn = mockConn({ topics: [] });
			setConn('bot-1', conn);

			await store.loadAllTopics();

			// 旧 t-stale 应被清空——loadTopicsForClaw 拿到空 topics 后替换该 claw 的旧数据
			expect(store.byId['t-stale']).toBeUndefined();
		});

		// 跨入口合流：loadAllTopics 内部对每个 claw 调 loadTopicsForClaw，与外部直接
		// 调 loadTopicsForClaw 共享同一份 _perClawLoading 飞行缓存，并发时只发一次 RPC
		test('跨入口并发：loadAllTopics 与 loadTopicsForClaw 同 claw 合流到一次 RPC', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B1', online: true }]);

			let resolveReq;
			const conn = {
				request: vi.fn().mockImplementation(() => new Promise((r) => { resolveReq = r; })),
				on: vi.fn(),
				off: vi.fn(),
			};
			setConn('bot-1', conn);

			const store = useTopicsStore();
			// 先发起 loadAllTopics，再发起 loadTopicsForClaw（同 claw）
			const allPromise = store.loadAllTopics();
			const perClawPromise = store.loadTopicsForClaw('bot-1');

			// 关键断言：两个入口应共享 _perClawLoading，conn.request 只被调一次
			expect(conn.request).toHaveBeenCalledTimes(1);

			resolveReq({ topics: [{ topicId: 't1', agentId: 'main', title: 'T1', createdAt: 100 }] });
			await Promise.all([allPromise, perClawPromise]);

			expect(store.items).toHaveLength(1);
			expect(store.byId['t1'].title).toBe('T1');
		});
	});
});
