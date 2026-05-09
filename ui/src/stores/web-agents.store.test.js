// @vitest-environment node
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mockedApi = vi.hoisted(() => ({
	listWebAgents: vi.fn(),
	recordWebAgentClick: vi.fn(),
}));

vi.mock('../services/web-agents.api.js', () => mockedApi);

import { useWebAgentsStore, __resetWebAgentsInternals } from './web-agents.store.js';

describe('web-agents store', () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		__resetWebAgentsInternals();
		// resetAllMocks 而非 clearAllMocks：清空 mockResolvedValueOnce 队列，避免跨用例泄漏
		vi.resetAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test('loadAll 拉取并写入 items, loaded=true', async () => {
		mockedApi.listWebAgents.mockResolvedValue([
			{ id: 1, slug: 'deepseek', name: 'DeepSeek', url: 'u1', sort: 1, lastClickedAt: null },
			{ id: 2, slug: 'doubao', name: '豆包', url: 'u2', sort: 2, lastClickedAt: '2026-05-01T00:00:00Z' },
		]);

		const store = useWebAgentsStore();
		await store.loadAll();

		expect(store.items).toHaveLength(2);
		expect(store.loaded).toBe(true);
		expect(store.loading).toBe(false);
		expect(store.error).toBeNull();
	});

	test('loadAll 已加载且无 error 时短路返回，不再发请求', async () => {
		mockedApi.listWebAgents.mockResolvedValue([
			{ id: 1, slug: 'a', name: 'A', url: 'u', sort: 1, lastClickedAt: null },
		]);
		const store = useWebAgentsStore();

		await store.loadAll();
		expect(mockedApi.listWebAgents).toHaveBeenCalledTimes(1);

		// 已加载，再次调用应短路
		await store.loadAll();
		expect(mockedApi.listWebAgents).toHaveBeenCalledTimes(1);
	});

	test('loadAll 在 error 状态下被再次调用时重试（不被短路）', async () => {
		mockedApi.listWebAgents.mockRejectedValueOnce(new Error('first fail'));
		const store = useWebAgentsStore();

		await store.loadAll();
		expect(store.error).toBeTruthy();
		expect(store.loaded).toBe(false);

		mockedApi.listWebAgents.mockResolvedValueOnce([
			{ id: 1, slug: 'a', name: 'A', url: 'u', sort: 1, lastClickedAt: null },
		]);
		await store.loadAll();
		expect(store.loaded).toBe(true);
		expect(store.error).toBeNull();
		expect(mockedApi.listWebAgents).toHaveBeenCalledTimes(2);
	});

	test('loadAll in-flight 合流，并发只发一次请求', async () => {
		let resolveFn;
		mockedApi.listWebAgents.mockImplementation(() => new Promise((r) => { resolveFn = r; }));

		const store = useWebAgentsStore();
		const p1 = store.loadAll();
		const p2 = store.loadAll();
		expect(mockedApi.listWebAgents).toHaveBeenCalledTimes(1);

		resolveFn([]);
		await Promise.all([p1, p2]);
		expect(store.loaded).toBe(true);
	});

	test('loadAll 失败时 error 写入、loading 复位', async () => {
		const err = new Error('boom');
		mockedApi.listWebAgents.mockRejectedValue(err);

		const store = useWebAgentsStore();
		await store.loadAll();

		expect(store.error).toBe(err);
		expect(store.loading).toBe(false);
		expect(store.loaded).toBe(false);
	});

	test('真实竞态：loadAll 在飞中 + 用户点击 → 服务器旧响应不覆盖本地乐观时间戳', async () => {
		mockedApi.recordWebAgentClick.mockResolvedValue();
		// 预置 items（首次 loadAll 已成功，loaded=true）
		const store = useWebAgentsStore();
		store.items = [
			{ id: 1, slug: 'deepseek', name: 'DeepSeek', url: 'u', sort: 1, lastClickedAt: null },
		];
		store.loaded = true;
		// 触发"重试"路径以绕过 loaded 短路
		store.error = new Error('previous fail');

		// 用一个手控 promise 让 loadAll 卡在飞中
		let resolveServer;
		mockedApi.listWebAgents.mockImplementation(() => new Promise((r) => { resolveServer = r; }));

		const inFlight = store.loadAll();

		// 用户点击：recordClick 写入乐观时间戳
		store.recordClick(1);
		const optimistic = store.items[0].lastClickedAt;
		expect(optimistic).toBeTruthy();

		// 服务器旧响应到达：未记录这次点击，lastClickedAt 仍为 null
		resolveServer([
			{ id: 1, slug: 'deepseek', name: 'DeepSeek', url: 'u', sort: 1, lastClickedAt: null },
		]);
		await inFlight;

		// merge 取 max → 乐观值幸存
		expect(store.items[0].lastClickedAt).toBe(optimistic);
		expect(store.error).toBeNull();
		expect(store.loaded).toBe(true);
	});

	test('loadAll merge 取 lastClickedAt 较大值，旧响应到达不覆盖乐观时间戳', async () => {
		const store = useWebAgentsStore();
		// 模拟"用户已点过 + 本地乐观时间戳"的状态
		const optimistic = '2026-05-09T12:00:00.000Z';
		store.items = [
			{ id: 1, slug: 'deepseek', name: 'DeepSeek', url: 'u1', sort: 1, lastClickedAt: optimistic },
			{ id: 2, slug: 'doubao', name: '豆包', url: 'u2', sort: 2, lastClickedAt: null },
		];
		// 服务器旧响应（不知道刚那次点击）：id=1 lastClickedAt 仍为 null
		mockedApi.listWebAgents.mockResolvedValue([
			{ id: 1, slug: 'deepseek', name: 'DeepSeek', url: 'u1', sort: 1, lastClickedAt: null },
			{ id: 2, slug: 'doubao', name: '豆包', url: 'u2', sort: 2, lastClickedAt: null },
		]);
		await store.loadAll();

		// 乐观更新不应被旧响应覆盖（merge 取 max）
		expect(store.items.find((i) => i.id === 1).lastClickedAt).toBe(optimistic);
	});

	test('loadAll merge：服务器值更新时取服务器（更大），更旧时仍取本地', async () => {
		const store = useWebAgentsStore();
		// 预置本地 items：模拟前一次 loadAll 已写入 + 本地乐观更新过时间戳的状态
		store.items = [
			{ id: 1, slug: 'a', name: 'A', url: 'u', sort: 1, lastClickedAt: '2026-04-01T00:00:00Z' },
			{ id: 2, slug: 'b', name: 'B', url: 'u', sort: 2, lastClickedAt: '2026-04-02T00:00:00Z' },
		];
		// 服务器返回：id=1 服务器更新（更大），id=2 服务器更旧（更小）
		mockedApi.listWebAgents.mockResolvedValue([
			{ id: 1, slug: 'a', name: 'A', url: 'u', sort: 1, lastClickedAt: '2026-05-01T00:00:00Z' },
			{ id: 2, slug: 'b', name: 'B', url: 'u', sort: 2, lastClickedAt: '2026-03-01T00:00:00Z' },
		]);
		await store.loadAll();

		expect(store.items.find((i) => i.id === 1).lastClickedAt).toBe('2026-05-01T00:00:00Z');
		expect(store.items.find((i) => i.id === 2).lastClickedAt).toBe('2026-04-02T00:00:00Z');
	});

	test('loadAll merge：新增条目时正常落入，缺旧条目无 prev 时直接用服务器值', async () => {
		const store = useWebAgentsStore();
		mockedApi.listWebAgents.mockResolvedValue([
			{ id: 1, slug: 'a', name: 'A', url: 'u', sort: 1 },
		]);
		await store.loadAll();
		// 注：服务器响应未带 lastClickedAt 字段时回落 null
		expect(store.items[0].lastClickedAt).toBeNull();
	});

	test('recordClick 本地乐观更新 lastClickedAt + fire-and-forget POST', async () => {
		mockedApi.recordWebAgentClick.mockResolvedValue();
		const store = useWebAgentsStore();
		store.items = [
			{ id: 7, slug: 'kimi', name: 'Kimi', url: 'u', sort: 4, lastClickedAt: null },
		];

		store.recordClick(7);

		expect(store.items[0].lastClickedAt).toBeTruthy();
		expect(mockedApi.recordWebAgentClick).toHaveBeenCalledWith(7);
	});

	test('recordClick id 不在 items 时不抛错（仍发请求）', () => {
		mockedApi.recordWebAgentClick.mockResolvedValue();
		const store = useWebAgentsStore();
		store.items = [{ id: 1, slug: 'a', name: 'A', url: 'u', sort: 1, lastClickedAt: null }];

		expect(() => store.recordClick(999)).not.toThrow();
		expect(mockedApi.recordWebAgentClick).toHaveBeenCalledWith(999);
	});

	test('recordClick 上报失败被 catch，不产生 unhandled rejection', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		mockedApi.recordWebAgentClick.mockRejectedValue(new Error('net down'));

		const store = useWebAgentsStore();
		store.items = [{ id: 5, slug: 's', name: 'S', url: 'u', sort: 5, lastClickedAt: null }];
		store.recordClick(5);

		// 等待微任务队列消化 fire-and-forget 的 catch
		await new Promise((r) => setTimeout(r, 0));

		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	test('pickerList: 按 sort 升序，sort=null 落最后，sort 同则按 id 升序', () => {
		const store = useWebAgentsStore();
		store.items = [
			{ id: 10, slug: 'c', name: 'C', url: 'u', sort: 2, lastClickedAt: null },
			{ id: 11, slug: 'd', name: 'D', url: 'u', sort: null, lastClickedAt: null },
			{ id: 12, slug: 'a', name: 'A', url: 'u', sort: 1, lastClickedAt: null },
			{ id: 9, slug: 'b', name: 'B', url: 'u', sort: 1, lastClickedAt: null },
			{ id: 13, slug: 'e', name: 'E', url: 'u', sort: null, lastClickedAt: null },
		];

		const ordered = store.pickerList.map((i) => i.slug);
		// sort=1 升序、id 升序：b(9, sort=1) → a(12, sort=1) → c(10, sort=2) → null 最后按 id 升序：d(11) → e(13)
		expect(ordered).toEqual(['b', 'a', 'c', 'd', 'e']);
	});

	test('recentlyClicked: 过滤未点过 + 按 lastClickedAt 降序', () => {
		const store = useWebAgentsStore();
		store.items = [
			{ id: 1, slug: 'a', name: 'A', url: 'u', sort: 1, lastClickedAt: '2026-05-01T00:00:00Z' },
			{ id: 2, slug: 'b', name: 'B', url: 'u', sort: 2, lastClickedAt: null },
			{ id: 3, slug: 'c', name: 'C', url: 'u', sort: 3, lastClickedAt: '2026-05-08T00:00:00Z' },
			{ id: 4, slug: 'd', name: 'D', url: 'u', sort: 4, lastClickedAt: '2026-05-05T00:00:00Z' },
		];

		const ordered = store.recentlyClicked.map((i) => i.slug);
		expect(ordered).toEqual(['c', 'd', 'a']);
	});
});
