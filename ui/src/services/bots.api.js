import { httpClient as client } from './http.js';

export async function listBots() {
	const res = await client.get('/api/v1/claws');
	return res.data?.items ?? [];
}

export async function createBindingCode() {
	const res = await client.post('/api/v1/claws/binding-codes');
	return {
		code: res.data?.code ?? '',
		expiresAt: res.data?.expiresAt ?? null,
		waitToken: res.data?.waitToken ?? '',
	};
}

export async function waitBindingCode(code, waitToken) {
	const res = await client.post('/api/v1/claws/binding-codes/wait', {
		code,
		waitToken,
	});
	return {
		code: res.data?.code ?? 'BINDING_PENDING',
		claw: res.data?.claw ?? null,
	};
}

export async function cancelBindingCode(code) {
	await client.delete(`/api/v1/claws/binding-codes/${code}`);
}

export async function claimBot(code) {
	const res = await client.post('/api/v1/claws/claim', { code });
	return {
		clawId: res.data?.clawId ?? null,
		clawName: res.data?.clawName ?? null,
	};
}

export async function unbindBotByUser(botId) {
	const res = await client.post('/api/v1/claws/unbind-by-user', { clawId: botId });
	return {
		clawId: res.data?.clawId ?? null,
		status: res.data?.status ?? null,
	};
}

