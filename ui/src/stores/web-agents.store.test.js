// @vitest-environment node
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mockedApi = vi.hoisted(() => ({
	listWebAgents: vi.fn(),
	recordWebAgentClick: vi.fn(),
	hideWebAgent: vi.fn(),
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
			{ id: 1, slug: 'a', name: 'A', url: 'u', sort: 1, lastClickedAt: '2026-05-01T00:00:00Z', hiddenAt: null },
			{ id: 2, slug: 'b', name: 'B', url: 'u', sort: 2, lastClickedAt: null, hiddenAt: null },
			{ id: 3, slug: 'c', name: 'C', url: 'u', sort: 3, lastClickedAt: '2026-05-08T00:00:00Z', hiddenAt: null },
			{ id: 4, slug: 'd', name: 'D', url: 'u', sort: 4, lastClickedAt: '2026-05-05T00:00:00Z', hiddenAt: null },
		];

		const ordered = store.recentlyClicked.map((i) => i.slug);
		expect(ordered).toEqual(['c', 'd', 'a']);
	});

	test('recentlyClicked: 过滤已隐藏的条目（hiddenAt != null）', () => {
		const store = useWebAgentsStore();
		store.items = [
			{ id: 1, slug: 'a', name: 'A', url: 'u', sort: 1, lastClickedAt: '2026-05-01T00:00:00Z', hiddenAt: null },
			{ id: 2, slug: 'b', name: 'B', url: 'u', sort: 2, lastClickedAt: '2026-05-09T00:00:00Z', hiddenAt: '2026-05-09T01:00:00Z' },
			{ id: 3, slug: 'c', name: 'C', url: 'u', sort: 3, lastClickedAt: '2026-05-08T00:00:00Z', hiddenAt: null },
		];

		const ordered = store.recentlyClicked.map((i) => i.slug);
		expect(ordered).toEqual(['c', 'a']);
	});

	test('hide: 本地乐观把 hiddenAt 标为现在 + fire-and-forget POST', () => {
		mockedApi.hideWebAgent.mockResolvedValue();
		const store = useWebAgentsStore();
		store.items = [
			{ id: 5, slug: 's', name: 'S', url: 'u', sort: 5, lastClickedAt: '2026-05-01T00:00:00Z', hiddenAt: null },
		];

		store.hide(5);

		expect(store.items[0].hiddenAt).toBeTruthy();
		expect(mockedApi.hideWebAgent).toHaveBeenCalledWith(5);
	});

	test('hide: id 不在 items 时不抛错（仍发请求）', () => {
		mockedApi.hideWebAgent.mockResolvedValue();
		const store = useWebAgentsStore();
		store.items = [{ id: 1, slug: 'a', name: 'A', url: 'u', sort: 1, lastClickedAt: null, hiddenAt: null }];

		expect(() => store.hide(999)).not.toThrow();
		expect(mockedApi.hideWebAgent).toHaveBeenCalledWith(999);
	});

	test('hide: 上报失败被 catch，不产生 unhandled rejection', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		mockedApi.hideWebAgent.mockRejectedValue(new Error('net down'));

		const store = useWebAgentsStore();
		store.items = [{ id: 6, slug: 's', name: 'S', url: 'u', sort: 6, lastClickedAt: null, hiddenAt: null }];
		store.hide(6);

		await new Promise((r) => setTimeout(r, 0));

		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	test('recordClick: 同步把 hiddenAt 清成 null（再点取消隐藏）', () => {
		mockedApi.recordWebAgentClick.mockResolvedValue();
		const store = useWebAgentsStore();
		store.items = [
			{ id: 7, slug: 'k', name: 'K', url: 'u', sort: 4, lastClickedAt: '2026-04-01T00:00:00Z', hiddenAt: '2026-05-09T00:00:00Z' },
		];

		store.recordClick(7);

		expect(store.items[0].lastClickedAt).toBeTruthy();
		expect(store.items[0].hiddenAt).toBeNull();
	});

	test('loadAll merge：本地刚 hide 后旧响应到达不应覆盖 hiddenAt', async () => {
		const store = useWebAgentsStore();
		const optimisticHide = '2026-05-09T12:00:00.000Z';
		store.items = [
			{ id: 1, slug: 'a', name: 'A', url: 'u', sort: 1, lastClickedAt: '2026-05-01T00:00:00Z', hiddenAt: optimisticHide },
		];
		// 服务器旧响应：尚未处理 hide，hiddenAt=null
		mockedApi.listWebAgents.mockResolvedValue([
			{ id: 1, slug: 'a', name: 'A', url: 'u', sort: 1, lastClickedAt: '2026-05-01T00:00:00Z', hiddenAt: null },
		]);
		await store.loadAll();

		expect(store.items[0].hiddenAt).toBe(optimisticHide);
	});

	test('loadAll merge：本地刚 recordClick（清 hiddenAt + 推 lastClickedAt）后旧响应到达不应复活 hiddenAt', async () => {
		const store = useWebAgentsStore();
		const optimisticClick = '2026-05-09T12:00:00.000Z';
		// 本地 lastClickedAt 比服务器新（recordClick 已 fire 但服务器尚未确认）
		store.items = [
			{ id: 1, slug: 'a', name: 'A', url: 'u', sort: 1, lastClickedAt: optimisticClick, hiddenAt: null },
		];
		mockedApi.listWebAgents.mockResolvedValue([
			{ id: 1, slug: 'a', name: 'A', url: 'u', sort: 1, lastClickedAt: '2026-04-01T00:00:00Z', hiddenAt: '2026-04-15T00:00:00Z' },
		]);
		await store.loadAll();

		expect(store.items[0].hiddenAt).toBeNull();
		expect(store.items[0].lastClickedAt).toBe(optimisticClick);
	});

	test('loadAll merge：服务器更新（lastClickedAt 更新且 hiddenAt 服务器写入）应胜出本地', async () => {
		const store = useWebAgentsStore();
		store.items = [
			{ id: 1, slug: 'a', name: 'A', url: 'u', sort: 1, lastClickedAt: '2026-04-01T00:00:00Z', hiddenAt: null },
		];
		mockedApi.listWebAgents.mockResolvedValue([
			{ id: 1, slug: 'a', name: 'A', url: 'u', sort: 1, lastClickedAt: '2026-05-01T00:00:00Z', hiddenAt: '2026-05-01T01:00:00Z' },
		]);
		await store.loadAll();

		expect(store.items[0].hiddenAt).toBe('2026-05-01T01:00:00Z');
		expect(store.items[0].lastClickedAt).toBe('2026-05-01T00:00:00Z');
	});

	test('loadAll merge：新增条目时 hiddenAt 直接落服务器值（无 prev）', async () => {
		const store = useWebAgentsStore();
		mockedApi.listWebAgents.mockResolvedValue([
			{ id: 1, slug: 'a', name: 'A', url: 'u', sort: 1, hiddenAt: '2026-05-01T00:00:00Z' },
		]);
		await store.loadAll();
		expect(store.items[0].hiddenAt).toBe('2026-05-01T00:00:00Z');
	});

	test('loadAll merge：服务器响应未带 hiddenAt 字段时回落 null', async () => {
		const store = useWebAgentsStore();
		mockedApi.listWebAgents.mockResolvedValue([
			{ id: 1, slug: 'a', name: 'A', url: 'u', sort: 1 },
		]);
		await store.loadAll();
		expect(store.items[0].hiddenAt).toBeNull();
	});

	test('loadAll merge：另一设备 click 已清 server hiddenAt → 本地 stale hiddenAt 不应永久阻挡显示', async () => {
		// 场景：用户曾在本设备 hide → 本地 hiddenAt 非空；之后另一台设备从 picker 点开同一 agent，
		// server 的 incrementClick upsert 把 hiddenAt 清成 null 并推进 lastClickedAt。
		// loadAll 拉到 server 最新值时，本地 stale hiddenAt 必须让位（否则用户在 A 设备取消隐藏，
		// B 设备会永远看不到该 agent 重现）。
		const store = useWebAgentsStore();
		store.items = [
			{ id: 1, slug: 'a', name: 'A', url: 'u', sort: 1, lastClickedAt: '2026-05-01T00:00:00Z', hiddenAt: '2026-05-02T00:00:00Z' },
		];
		mockedApi.listWebAgents.mockResolvedValue([
			{ id: 1, slug: 'a', name: 'A', url: 'u', sort: 1, lastClickedAt: '2026-05-09T00:00:00Z', hiddenAt: null },
		]);
		await store.loadAll();

		expect(store.items[0].hiddenAt).toBeNull();
		expect(store.items[0].lastClickedAt).toBe('2026-05-09T00:00:00Z');
	});
});
