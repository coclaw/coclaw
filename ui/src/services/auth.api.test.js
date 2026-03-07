import { beforeEach, describe, expect, test, vi } from 'vitest';

const mockedHttp = vi.hoisted(() => ({
	post: vi.fn(),
	get: vi.fn(),
	patch: vi.fn(),
	put: vi.fn(),
}));

vi.mock('./http.js', () => ({
	httpClient: mockedHttp,
}));

import {
	changePassword,
	fetchSessionUser,
	loginByLoginName,
	logout,
	patchCurrentUserProfile,
	patchCurrentUserSettings,
	registerByLoginName,
} from './auth.api.js';

describe('auth api', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('loginByLoginName should post credentials and return response data', async () => {
		mockedHttp.post.mockResolvedValue({
			data: {
				user: {
					id: '1',
					auth: {
						local: {
							loginName: 'test',
						},
					},
				},
			},
		});

		const data = await loginByLoginName({
			loginName: 'test',
			password: '123456',
		});

		expect(mockedHttp.post).toHaveBeenCalledWith('/api/v1/auth/local/login', {
			loginName: 'test',
			password: '123456',
		});
		expect(data.user.auth.local.loginName).toBe('test');
	});

	test('fetchSessionUser should return profile from /api/v1/user', async () => {
		mockedHttp.get.mockResolvedValue({
			data: {
				profile: {
					id: '2',
					auth: {
						local: {
							loginName: 'alice',
						},
					},
				},
				settings: {
					theme: 'dark',
					lang: 'zh-CN',
				},
			},
		});

		const user = await fetchSessionUser();

		expect(mockedHttp.get).toHaveBeenCalledWith('/api/v1/user', {
			params: {
				includeSettings: true,
			},
		});
		expect(user).toEqual({
			id: '2',
			auth: {
				local: {
					loginName: 'alice',
				},
			},
			settings: {
				theme: 'dark',
				lang: 'zh-CN',
			},
		});
	});

	test('fetchSessionUser should return null when profile is absent', async () => {
		mockedHttp.get.mockResolvedValue({
			data: {},
		});

		const user = await fetchSessionUser();

		expect(user).toBeNull();
	});

	test('fetchSessionUser should return null on 401', async () => {
		mockedHttp.get.mockRejectedValue({
			response: {
				status: 401,
			},
		});

		const user = await fetchSessionUser();

		expect(user).toBeNull();
	});

	test('fetchSessionUser should throw error when status is not 401', async () => {
		const err = {
			response: {
				status: 500,
			},
		};
		mockedHttp.get.mockRejectedValue(err);

		await expect(fetchSessionUser()).rejects.toBe(err);
	});

	test('logout should call logout endpoint', async () => {
		mockedHttp.post.mockResolvedValue({ data: null });

		await logout();

		expect(mockedHttp.post).toHaveBeenCalledWith('/api/v1/auth/logout');
	});

	test('patchCurrentUserProfile should patch profile and return profile', async () => {
		mockedHttp.patch.mockResolvedValue({
			data: {
				profile: {
					id: '2',
					name: 'Bob',
				},
			},
		});

		const profile = await patchCurrentUserProfile({
			name: 'Bob',
		});

		expect(mockedHttp.patch).toHaveBeenCalledWith('/api/v1/user', {
			name: 'Bob',
		});
		expect(profile).toEqual({
			id: '2',
			name: 'Bob',
		});
	});

	test('patchCurrentUserProfile should return null when profile is absent', async () => {
		mockedHttp.patch.mockResolvedValue({
			data: {},
		});

		const profile = await patchCurrentUserProfile({
			name: 'Bob',
		});

		expect(profile).toBeNull();
	});

	test('patchCurrentUserSettings should patch settings and return settings', async () => {
		mockedHttp.patch.mockResolvedValue({
			data: {
				settings: {
					theme: 'dark',
					lang: 'zh-CN',
				},
			},
		});

		const settings = await patchCurrentUserSettings({
			theme: 'dark',
		});

		expect(mockedHttp.patch).toHaveBeenCalledWith('/api/v1/user/settings', {
			theme: 'dark',
		});
		expect(settings).toEqual({
			theme: 'dark',
			lang: 'zh-CN',
		});
	});

	test('changePassword should put payload and return response data', async () => {
		mockedHttp.put.mockResolvedValue({
			data: { message: 'Password changed' },
		});

		const data = await changePassword({
			oldPassword: '123456',
			newPassword: 'Xyz-456',
		});

		expect(mockedHttp.put).toHaveBeenCalledWith('/api/v1/user/password', {
			oldPassword: '123456',
			newPassword: 'Xyz-456',
		});
		expect(data.message).toBe('Password changed');
	});

	test('registerByLoginName should post credentials and return response data', async () => {
		mockedHttp.post.mockResolvedValue({
			data: {
				user: {
					id: '10',
					auth: {
						local: {
							loginName: 'newuser',
						},
					},
				},
			},
		});

		const data = await registerByLoginName({
			loginName: 'newuser',
			password: '123456',
		});

		expect(mockedHttp.post).toHaveBeenCalledWith('/api/v1/auth/local/register', {
			loginName: 'newuser',
			password: '123456',
		});
		expect(data.user.auth.local.loginName).toBe('newuser');
	});

	test('patchCurrentUserSettings should return null when settings is absent', async () => {
		mockedHttp.patch.mockResolvedValue({
			data: {},
		});

		const settings = await patchCurrentUserSettings({
			theme: 'dark',
		});

		expect(settings).toBeNull();
	});
});
