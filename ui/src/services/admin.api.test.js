import { beforeEach, describe, expect, test, vi } from 'vitest';

const mockedHttp = vi.hoisted(() => ({
	get: vi.fn(),
}));

vi.mock('./http.js', () => ({
	httpClient: mockedHttp,
}));

import { fetchAdminDashboard } from './admin.api.js';

describe('admin api', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('fetchAdminDashboard 应 GET 正确路径并返回 data', async () => {
		const dashboard = { totalUsers: 42, totalBots: 5 };
		mockedHttp.get.mockResolvedValue({ data: dashboard });

		const result = await fetchAdminDashboard();

		expect(mockedHttp.get).toHaveBeenCalledWith('/api/v1/admin/dashboard');
		expect(result).toEqual(dashboard);
	});

	test('fetchAdminDashboard 在 data 为 null 时应返回 null', async () => {
		mockedHttp.get.mockResolvedValue({ data: null });

		const result = await fetchAdminDashboard();

		expect(result).toBeNull();
	});
});
