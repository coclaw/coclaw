import { httpClient as client } from './http.js';

export async function loginByLoginName(payload) {
	const res = await client.post('/api/v1/auth/local/login', payload);
	return res.data;
}

export async function registerByLoginName(payload) {
	const res = await client.post('/api/v1/auth/local/register', payload);
	return res.data;
}

export async function logout() {
	await client.post('/api/v1/auth/logout');
}

export async function fetchSessionUser() {
	try {
		const res = await client.get('/api/v1/user', {
			params: {
				includeSettings: true,
			},
		});
		const profile = res.data.profile ?? null;
		if (!profile) {
			return null;
		}
		return {
			...profile,
			settings: res.data.settings ?? profile.settings ?? {},
		};
	}
	catch (err) {
		if (err?.response?.status === 401) {
			return null;
		}
		throw err;
	}
}

export async function patchCurrentUserProfile(payload) {
	const res = await client.patch('/api/v1/user', payload);
	return res.data.profile ?? null;
}

export async function changePassword(payload) {
	const res = await client.put('/api/v1/user/password', payload);
	return res.data;
}

export async function patchCurrentUserSettings(payload) {
	const res = await client.patch('/api/v1/user/settings', payload);
	return res.data.settings ?? null;
}
