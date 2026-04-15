import { httpClient as client } from './http.js';

export async function fetchAdminDashboard() {
	const res = await client.get('/api/v1/admin/dashboard');
	return res.data;
}

/**
 * 拉取实例列表（分页，支持搜索）
 * @param {{ cursor?: string, limit?: number, search?: string }} [opts]
 * @returns {Promise<{ items: object[], nextCursor: string|null }>}
 */
export async function fetchAdminClaws(opts = {}) {
	const params = {};
	if (opts.cursor) params.cursor = opts.cursor;
	if (opts.limit) params.limit = opts.limit;
	if (opts.search) params.search = opts.search;
	const res = await client.get('/api/v1/admin/claws', { params });
	return {
		items: res.data?.items ?? [],
		nextCursor: res.data?.nextCursor ?? null,
	};
}

/**
 * 拉取用户列表（分页，支持搜索）
 * @param {{ cursor?: string, limit?: number, search?: string }} [opts]
 * @returns {Promise<{ items: object[], nextCursor: string|null }>}
 */
export async function fetchAdminUsers(opts = {}) {
	const params = {};
	if (opts.cursor) params.cursor = opts.cursor;
	if (opts.limit) params.limit = opts.limit;
	if (opts.search) params.search = opts.search;
	const res = await client.get('/api/v1/admin/users', { params });
	return {
		items: res.data?.items ?? [],
		nextCursor: res.data?.nextCursor ?? null,
	};
}

/** Admin SSE 端点 URL（EventSource 使用同源相对路径） */
export function adminStreamUrl() {
	return '/api/v1/admin/stream';
}
