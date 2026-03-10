import { httpClient as client } from './http.js';

export async function listBots() {
	const res = await client.get('/api/v1/bots');
	return res.data?.items ?? [];
}

export async function createBindingCode() {
	const res = await client.post('/api/v1/bots/binding-codes');
	return {
		code: res.data?.code ?? '',
		expiresAt: res.data?.expiresAt ?? null,
		waitToken: res.data?.waitToken ?? '',
	};
}

export async function waitBindingCode(code, waitToken) {
	const res = await client.post('/api/v1/bots/binding-codes/wait', {
		code,
		waitToken,
	});
	return {
		code: res.data?.code ?? 'BINDING_PENDING',
		bot: res.data?.bot ?? null,
	};
}

export async function cancelBindingCode(code) {
	await client.delete(`/api/v1/bots/binding-codes/${code}`);
}

export async function unbindBotByUser(botId) {
	const res = await client.post('/api/v1/bots/unbind-by-user', { botId });
	return {
		botId: res.data?.botId ?? null,
		status: res.data?.status ?? null,
	};
}

export async function createBotWsTicket(botId) {
	const payload = botId ? { botId } : {};
	const res = await client.post('/api/v1/bots/ws-ticket', payload);
	return {
		ticket: res.data?.ticket ?? '',
		botId: res.data?.botId ?? null,
	};
}
