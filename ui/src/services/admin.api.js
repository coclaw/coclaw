import { httpClient as client } from './http.js';

export async function fetchAdminDashboard() {
	const res = await client.get('/api/v1/admin/dashboard');
	return res.data;
}
