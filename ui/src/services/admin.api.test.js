import { beforeEach, describe, expect, test, vi } from 'vitest';

const mockedHttp = vi.hoisted(() => ({
	get: vi.fn(),
}));

vi.mock('./http.js', () => ({
	httpClient: mockedHttp,
}));

import {
	fetchAdminDashboard,
	fetchAdminClaws,
	fetchAdminUsers,
	adminStreamUrl,
} from './admin.api.js';

describe('admin api', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('fetchAdminDashboard', () => {
		test('GET 正确路径并返回 data', async () => {
			const dashboard = { totalUsers: 42, totalBots: 5 };
			mockedHttp.get.mockResolvedValue({ data: dashboard });

			const result = await fetchAdminDashboard();

			expect(mockedHttp.get).toHaveBeenCalledWith('/api/v1/admin/dashboard');
			expect(result).toEqual(dashboard);
		});

		test('data 为 null 时返回 null', async () => {
			mockedHttp.get.mockResolvedValue({ data: null });
			expect(await fetchAdminDashboard()).toBeNull();
		});
	});

	describe('fetchAdminClaws', () => {
		test('无参数时 params 为空对象', async () => {
			mockedHttp.get.mockResolvedValue({ data: { items: [], nextCursor: null } });
			await fetchAdminClaws();
			expect(mockedHttp.get).toHaveBeenCalledWith('/api/v1/admin/claws', { params: {} });
		});

		test('传递 cursor/limit/search', async () => {
			mockedHttp.get.mockResolvedValue({ data: { items: [{ id: '1' }], nextCursor: '1' } });
			const res = await fetchAdminClaws({ cursor: 'c1', limit: 20, search: 'foo' });
			expect(mockedHttp.get).toHaveBeenCalledWith('/api/v1/admin/claws', {
				params: { cursor: 'c1', limit: 20, search: 'foo' },
			});
			expect(res).toEqual({ items: [{ id: '1' }], nextCursor: '1' });
		});

		test('空/undefined 字段不放入 params', async () => {
			mockedHttp.get.mockResolvedValue({ data: { items: [], nextCursor: null } });
			await fetchAdminClaws({ search: '' });
			expect(mockedHttp.get).toHaveBeenCalledWith('/api/v1/admin/claws', { params: {} });
		});

		test('data 缺失时回退默认结构', async () => {
			mockedHttp.get.mockResolvedValue({ data: null });
			expect(await fetchAdminClaws()).toEqual({ items: [], nextCursor: null });
		});
	});

	describe('fetchAdminUsers', () => {
		test('传递 cursor/limit/search', async () => {
			mockedHttp.get.mockResolvedValue({ data: { items: [{ id: 'u1' }], nextCursor: null } });
			const res = await fetchAdminUsers({ cursor: 'c2', limit: 30, search: 'alice' });
			expect(mockedHttp.get).toHaveBeenCalledWith('/api/v1/admin/users', {
				params: { cursor: 'c2', limit: 30, search: 'alice' },
			});
			expect(res).toEqual({ items: [{ id: 'u1' }], nextCursor: null });
		});

		test('data 缺失时回退默认结构', async () => {
			mockedHttp.get.mockResolvedValue({ data: null });
			expect(await fetchAdminUsers()).toEqual({ items: [], nextCursor: null });
		});
	});

	describe('adminStreamUrl', () => {
		test('返回 admin SSE 端点', () => {
			expect(adminStreamUrl()).toBe('/api/v1/admin/stream');
		});
	});
});
