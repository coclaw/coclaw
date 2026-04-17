import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const mockedApi = vi.hoisted(() => ({
	fetchAdminDashboard: vi.fn(),
	fetchAdminClaws: vi.fn(),
	fetchAdminUsers: vi.fn(),
}));

const mockedStream = vi.hoisted(() => {
	const close = vi.fn();
	const connect = vi.fn();
	return { close, connect };
});

vi.mock('../services/admin.api.js', () => mockedApi);
vi.mock('../services/admin-stream.js', () => ({
	connectAdminStream: (handlers) => {
		mockedStream.connect(handlers);
		return { close: mockedStream.close };
	},
}));

import { useAdminStore } from './admin.store.js';

describe('admin store', () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		vi.clearAllMocks();
		mockedStream.close.mockClear();
		mockedStream.connect.mockClear();
	});

	describe('fetchDashboard', () => {
		test('成功时填充 dashboard 并清除错误', async () => {
			const data = { users: { total: 10 }, claws: { total: 5 } };
			mockedApi.fetchAdminDashboard.mockResolvedValue(data);
			const store = useAdminStore();

			await store.fetchDashboard();

			expect(store.dashboard).toEqual(data);
			expect(store.dashboardLoading).toBe(false);
			expect(store.dashboardError).toBeNull();
		});

		test('失败时写入 dashboardError 并抛出', async () => {
			const err = new Error('nope');
			mockedApi.fetchAdminDashboard.mockRejectedValue(err);
			const store = useAdminStore();

			await expect(store.fetchDashboard()).rejects.toThrow('nope');
			expect(store.dashboardError).toBe('nope');
			expect(store.dashboardLoading).toBe(false);
		});

		test('失败时优先使用 response.data.message', async () => {
			const err = { response: { data: { message: 'server down' } } };
			mockedApi.fetchAdminDashboard.mockRejectedValue(err);
			const store = useAdminStore();

			await expect(store.fetchDashboard()).rejects.toEqual(err);
			expect(store.dashboardError).toBe('server down');
		});

		test('缺少 message 时 fallback 为 load failed', async () => {
			mockedApi.fetchAdminDashboard.mockRejectedValue({});
			const store = useAdminStore();

			await expect(store.fetchDashboard()).rejects.toBeDefined();
			expect(store.dashboardError).toBe('load failed');
		});
	});

	describe('fetchClaws', () => {
		test('替换 items 并保存 search', async () => {
			mockedApi.fetchAdminClaws.mockResolvedValue({ items: [{ id: '1' }], nextCursor: 'c' });
			const store = useAdminStore();

			await store.fetchClaws({ search: 'foo' });

			expect(mockedApi.fetchAdminClaws).toHaveBeenCalledWith({
				cursor: undefined, limit: undefined, search: 'foo',
			});
			expect(store.claws.items).toEqual([{ id: '1' }]);
			expect(store.claws.nextCursor).toBe('c');
			expect(store.claws.search).toBe('foo');
		});

		test('search 为空时不透传 search 参数', async () => {
			mockedApi.fetchAdminClaws.mockResolvedValue({ items: [], nextCursor: null });
			const store = useAdminStore();

			await store.fetchClaws();

			expect(mockedApi.fetchAdminClaws).toHaveBeenCalledWith({
				cursor: undefined, limit: undefined, search: undefined,
			});
		});

		test('失败时抛出并写入 error', async () => {
			const err = new Error('boom');
			mockedApi.fetchAdminClaws.mockRejectedValue(err);
			const store = useAdminStore();

			await expect(store.fetchClaws()).rejects.toThrow('boom');
			expect(store.claws.error).toBe('boom');
			expect(store.claws.loading).toBe(false);
		});

		test('错误对象无 message 时 fallback', async () => {
			mockedApi.fetchAdminClaws.mockRejectedValue({});
			const store = useAdminStore();
			await expect(store.fetchClaws()).rejects.toBeDefined();
			expect(store.claws.error).toBe('load failed');
		});

		test('错误对象有 response.data.message 时优先使用', async () => {
			mockedApi.fetchAdminClaws.mockRejectedValue({ response: { data: { message: 'nope' } } });
			const store = useAdminStore();
			await expect(store.fetchClaws()).rejects.toBeDefined();
			expect(store.claws.error).toBe('nope');
		});
	});

	describe('fetchMoreClaws', () => {
		test('无 cursor 时直接返回', async () => {
			const store = useAdminStore();
			await store.fetchMoreClaws();
			expect(mockedApi.fetchAdminClaws).not.toHaveBeenCalled();
		});

		test('loading 时不重复触发', async () => {
			const store = useAdminStore();
			store.claws.nextCursor = 'c';
			store.claws.loading = true;
			await store.fetchMoreClaws();
			expect(mockedApi.fetchAdminClaws).not.toHaveBeenCalled();
		});

		test('追加 items 并更新 cursor', async () => {
			const store = useAdminStore();
			store.claws.items = [{ id: '1' }];
			store.claws.nextCursor = 'c1';
			store.claws.search = 'q';

			mockedApi.fetchAdminClaws.mockResolvedValue({ items: [{ id: '2' }], nextCursor: 'c2' });
			await store.fetchMoreClaws({ limit: 10 });

			expect(mockedApi.fetchAdminClaws).toHaveBeenCalledWith({
				cursor: 'c1', limit: 10, search: 'q',
			});
			expect(store.claws.items).toEqual([{ id: '1' }, { id: '2' }]);
			expect(store.claws.nextCursor).toBe('c2');
		});

		test('追加时 search 为空则不透传', async () => {
			const store = useAdminStore();
			store.claws.nextCursor = 'c1';
			mockedApi.fetchAdminClaws.mockResolvedValue({ items: [], nextCursor: null });
			await store.fetchMoreClaws();
			expect(mockedApi.fetchAdminClaws).toHaveBeenCalledWith({
				cursor: 'c1', limit: undefined, search: undefined,
			});
		});

		test('失败时抛出并写 error', async () => {
			const store = useAdminStore();
			store.claws.nextCursor = 'c1';
			mockedApi.fetchAdminClaws.mockRejectedValue(new Error('x'));
			await expect(store.fetchMoreClaws()).rejects.toThrow('x');
			expect(store.claws.error).toBe('x');
		});

		test('失败且 error 无 message 时 fallback', async () => {
			const store = useAdminStore();
			store.claws.nextCursor = 'c1';
			mockedApi.fetchAdminClaws.mockRejectedValue({});
			await expect(store.fetchMoreClaws()).rejects.toBeDefined();
			expect(store.claws.error).toBe('load failed');
		});

		test('失败且 error 有 response.data.message 时优先', async () => {
			const store = useAdminStore();
			store.claws.nextCursor = 'c1';
			mockedApi.fetchAdminClaws.mockRejectedValue({ response: { data: { message: 'x' } } });
			await expect(store.fetchMoreClaws()).rejects.toBeDefined();
			expect(store.claws.error).toBe('x');
		});
	});

	describe('resetClaws', () => {
		test('清空列表和 cursor', () => {
			const store = useAdminStore();
			store.claws.items = [{ id: '1' }];
			store.claws.nextCursor = 'c';
			store.claws.search = 'x';

			store.resetClaws();

			expect(store.claws.items).toEqual([]);
			expect(store.claws.nextCursor).toBeNull();
			expect(store.claws.search).toBe('');
		});
	});

	describe('fetchUsers / fetchMoreUsers / resetUsers', () => {
		test('fetchUsers 替换 items', async () => {
			mockedApi.fetchAdminUsers.mockResolvedValue({ items: [{ id: 'u1' }], nextCursor: 'nc' });
			const store = useAdminStore();
			await store.fetchUsers({ search: 'a' });
			expect(store.users.items).toEqual([{ id: 'u1' }]);
			expect(store.users.search).toBe('a');
		});

		test('fetchUsers search 为空时不透传', async () => {
			mockedApi.fetchAdminUsers.mockResolvedValue({ items: [], nextCursor: null });
			const store = useAdminStore();
			await store.fetchUsers();
			expect(mockedApi.fetchAdminUsers).toHaveBeenCalledWith({
				cursor: undefined, limit: undefined, search: undefined,
			});
		});

		test('fetchUsers 失败时抛出', async () => {
			mockedApi.fetchAdminUsers.mockRejectedValue(new Error('e'));
			const store = useAdminStore();
			await expect(store.fetchUsers()).rejects.toThrow('e');
			expect(store.users.error).toBe('e');
		});

		test('fetchUsers 失败 error 无 message 时 fallback', async () => {
			mockedApi.fetchAdminUsers.mockRejectedValue({});
			const store = useAdminStore();
			await expect(store.fetchUsers()).rejects.toBeDefined();
			expect(store.users.error).toBe('load failed');
		});

		test('fetchUsers 失败 error 有 response.data.message 时优先', async () => {
			mockedApi.fetchAdminUsers.mockRejectedValue({ response: { data: { message: 'mm' } } });
			const store = useAdminStore();
			await expect(store.fetchUsers()).rejects.toBeDefined();
			expect(store.users.error).toBe('mm');
		});

		test('fetchMoreUsers 无 cursor 时跳过', async () => {
			const store = useAdminStore();
			await store.fetchMoreUsers();
			expect(mockedApi.fetchAdminUsers).not.toHaveBeenCalled();
		});

		test('fetchMoreUsers loading 时跳过', async () => {
			const store = useAdminStore();
			store.users.nextCursor = 'c';
			store.users.loading = true;
			await store.fetchMoreUsers();
			expect(mockedApi.fetchAdminUsers).not.toHaveBeenCalled();
		});

		test('fetchMoreUsers 追加 items', async () => {
			const store = useAdminStore();
			store.users.items = [{ id: 'u1' }];
			store.users.nextCursor = 'nc';
			store.users.search = 'q';
			mockedApi.fetchAdminUsers.mockResolvedValue({ items: [{ id: 'u2' }], nextCursor: null });

			await store.fetchMoreUsers({ limit: 50 });

			expect(mockedApi.fetchAdminUsers).toHaveBeenCalledWith({
				cursor: 'nc', limit: 50, search: 'q',
			});
			expect(store.users.items).toEqual([{ id: 'u1' }, { id: 'u2' }]);
			expect(store.users.nextCursor).toBeNull();
		});

		test('fetchMoreUsers 追加 search 为空不透传', async () => {
			const store = useAdminStore();
			store.users.nextCursor = 'nc';
			mockedApi.fetchAdminUsers.mockResolvedValue({ items: [], nextCursor: null });
			await store.fetchMoreUsers();
			expect(mockedApi.fetchAdminUsers).toHaveBeenCalledWith({
				cursor: 'nc', limit: undefined, search: undefined,
			});
		});

		test('fetchMoreUsers 失败时抛出', async () => {
			const store = useAdminStore();
			store.users.nextCursor = 'nc';
			mockedApi.fetchAdminUsers.mockRejectedValue(new Error('y'));
			await expect(store.fetchMoreUsers()).rejects.toThrow('y');
			expect(store.users.error).toBe('y');
		});

		test('fetchMoreUsers 失败 error 无 message 时 fallback', async () => {
			const store = useAdminStore();
			store.users.nextCursor = 'nc';
			mockedApi.fetchAdminUsers.mockRejectedValue({});
			await expect(store.fetchMoreUsers()).rejects.toBeDefined();
			expect(store.users.error).toBe('load failed');
		});

		test('fetchMoreUsers 失败 error response.data.message 优先', async () => {
			const store = useAdminStore();
			store.users.nextCursor = 'nc';
			mockedApi.fetchAdminUsers.mockRejectedValue({ response: { data: { message: 'z' } } });
			await expect(store.fetchMoreUsers()).rejects.toBeDefined();
			expect(store.users.error).toBe('z');
		});

		test('resetUsers 清空', () => {
			const store = useAdminStore();
			store.users.items = [{ id: 'u1' }];
			store.users.nextCursor = 'nc';
			store.users.search = 'x';
			store.resetUsers();
			expect(store.users.items).toEqual([]);
			expect(store.users.nextCursor).toBeNull();
			expect(store.users.search).toBe('');
		});
	});

	describe('SSE 事件应用', () => {
		test('applyOnlineSnapshot 标记命中者 online=true 其余 false，并写入 onlineClawIds + 置 hasOnlineSnapshot', () => {
			const store = useAdminStore();
			store.claws.items = [
				{ id: '1', online: false },
				{ id: '2', online: true },
				{ id: '3', online: false },
			];
			expect(store.hasOnlineSnapshot).toBe(false);
			store.applyOnlineSnapshot(['1', '3']);
			expect(store.claws.items.map(c => c.online)).toEqual([true, false, true]);
			expect(store.onlineClawIds.has('1')).toBe(true);
			expect(store.onlineClawIds.has('2')).toBe(false);
			expect(store.onlineClawIds.has('3')).toBe(true);
			expect(store.onlineClawCount).toBe(2);
			expect(store.hasOnlineSnapshot).toBe(true);
		});

		test('applyOnlineSnapshot 传入 undefined 视为全部离线', () => {
			const store = useAdminStore();
			store.claws.items = [{ id: '1', online: true }];
			store.onlineClawIds = new Set(['1']);
			store.applyOnlineSnapshot();
			expect(store.claws.items[0].online).toBe(false);
			expect(store.onlineClawCount).toBe(0);
		});

		test('updateClawStatus 匹配后更新并跳出，同步 onlineClawIds', () => {
			const store = useAdminStore();
			store.claws.items = [
				{ id: '1', online: false },
				{ id: '2', online: true },
			];
			store.onlineClawIds = new Set(['2']);
			store.updateClawStatus(2, true);
			expect(store.claws.items[1].online).toBe(true);
			expect(store.onlineClawIds.has('2')).toBe(true);
			store.updateClawStatus(2, 0);
			expect(store.claws.items[1].online).toBe(false);
			expect(store.onlineClawIds.has('2')).toBe(false);
		});

		test('updateClawStatus 无匹配列表项时仍更新 onlineClawIds', () => {
			const store = useAdminStore();
			store.claws.items = [{ id: '1', online: false }];
			store.updateClawStatus('999', true);
			expect(store.claws.items[0].online).toBe(false);
			expect(store.onlineClawIds.has('999')).toBe(true);
		});

		test('updateClawInfo 覆盖指定字段且跳过 undefined', () => {
			const store = useAdminStore();
			store.claws.items = [
				{ id: '1', name: 'old', pluginVersion: '0.0.1' },
				{ id: '2', name: 'other', pluginVersion: '0.1.0' },
			];
			store.updateClawInfo('1', {
				name: 'new',
				pluginVersion: undefined,
				agentModels: [{ id: 'a' }],
			});
			expect(store.claws.items[0]).toMatchObject({
				id: '1',
				name: 'new',
				pluginVersion: '0.0.1',
				agentModels: [{ id: 'a' }],
			});
		});

		test('updateClawInfo 无匹配时不抛', () => {
			const store = useAdminStore();
			store.claws.items = [{ id: '1' }];
			expect(() => store.updateClawInfo('999', { name: 'x' })).not.toThrow();
		});

		test('updateClawInfo 显式 null 应写入（覆盖 SSE 传 null 的契约）', () => {
			const store = useAdminStore();
			store.claws.items = [{ id: '1', name: 'old', agentModels: [{ id: 'a' }] }];
			store.updateClawInfo('1', { name: null, agentModels: null });
			expect(store.claws.items[0].name).toBeNull();
			expect(store.claws.items[0].agentModels).toBeNull();
		});

		test('updateClawInfo 默认空 patch 不变更', () => {
			const store = useAdminStore();
			store.claws.items = [{ id: '1', name: 'a' }];
			store.updateClawInfo('1');
			expect(store.claws.items[0]).toEqual({ id: '1', name: 'a' });
		});
	});

	describe('getters: onlineClawCount / isClawOnline', () => {
		test('onlineClawCount 读 Set.size', () => {
			const store = useAdminStore();
			expect(store.onlineClawCount).toBe(0);
			store.onlineClawIds = new Set(['a', 'b', 'c']);
			expect(store.onlineClawCount).toBe(3);
		});

		test('isClawOnline 对字符串/数字 id 均归一化为字符串', () => {
			const store = useAdminStore();
			store.onlineClawIds = new Set(['100', '200']);
			expect(store.isClawOnline('100')).toBe(true);
			expect(store.isClawOnline(100)).toBe(true);
			expect(store.isClawOnline('999')).toBe(false);
		});
	});

	describe('SSE 订阅生命周期', () => {
		test('startStream 首次调用建立订阅', () => {
			const store = useAdminStore();
			store.startStream();
			expect(mockedStream.connect).toHaveBeenCalledTimes(1);
			expect(store.__streamRefs).toBe(1);
		});

		test('startStream 多次调用只建一条连接', () => {
			const store = useAdminStore();
			store.startStream();
			store.startStream();
			store.startStream();
			expect(mockedStream.connect).toHaveBeenCalledTimes(1);
			expect(store.__streamRefs).toBe(3);
		});

		test('stopStream 引用计数归零才 close，并清空 onlineClawIds + hasOnlineSnapshot', () => {
			const store = useAdminStore();
			store.startStream();
			store.startStream();
			store.onlineClawIds = new Set(['1', '2']);
			store.hasOnlineSnapshot = true;

			store.stopStream();
			expect(mockedStream.close).not.toHaveBeenCalled();
			expect(store.onlineClawIds.size).toBe(2);
			expect(store.hasOnlineSnapshot).toBe(true);

			store.stopStream();
			expect(mockedStream.close).toHaveBeenCalledTimes(1);
			expect(store.onlineClawIds.size).toBe(0);
			expect(store.hasOnlineSnapshot).toBe(false);
			expect(store.__streamRefs).toBe(0);
		});

		test('stopStream 在未 start 时幂等不抛', () => {
			const store = useAdminStore();
			expect(() => store.stopStream()).not.toThrow();
			expect(mockedStream.close).not.toHaveBeenCalled();
			expect(store.__streamRefs).toBe(0);
		});

		test('SSE 回调桥接到 store actions', () => {
			const store = useAdminStore();
			store.claws.items = [{ id: '1', online: false }];
			store.startStream();
			const handlers = mockedStream.connect.mock.calls[0][0];

			// onSnapshot → applyOnlineSnapshot
			handlers.onSnapshot(['1']);
			expect(store.onlineClawIds.has('1')).toBe(true);
			expect(store.claws.items[0].online).toBe(true);

			// onStatusChanged → updateClawStatus
			handlers.onStatusChanged({ clawId: '1', online: false });
			expect(store.onlineClawIds.has('1')).toBe(false);

			// onInfoUpdated → updateClawInfo（patch 语义：clawId 不落到字段里）
			handlers.onInfoUpdated({ clawId: '1', name: 'renamed' });
			expect(store.claws.items[0].name).toBe('renamed');
			expect('clawId' in store.claws.items[0]).toBe(false);
		});

		test('close→重启后仍可重新订阅', () => {
			const store = useAdminStore();
			store.startStream();
			store.stopStream();
			expect(mockedStream.close).toHaveBeenCalledTimes(1);

			store.startStream();
			expect(mockedStream.connect).toHaveBeenCalledTimes(2);
			expect(store.__streamRefs).toBe(1);
		});
	});
});
