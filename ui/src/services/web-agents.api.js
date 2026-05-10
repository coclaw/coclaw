import { httpClient as client } from './http.js';

export async function listWebAgents() {
	const res = await client.get('/api/v1/web-agents');
	return res.data?.items ?? [];
}

export async function recordWebAgentClick(id) {
	await client.post(`/api/v1/web-agents/${id}/click`);
}

export async function hideWebAgent(id) {
	await client.post(`/api/v1/web-agents/${id}/hide`);
}
