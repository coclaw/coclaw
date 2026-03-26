import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { useAuthStore } from './auth.store.js';

vi.mock('../services/auth.api.js', () => ({
	changePassword: vi.fn(),
	fetchSessionUser: vi.fn(),
	loginByLoginName: vi.fn(),
	logout: vi.fn(),
	patchCurrentUserProfile: vi.fn(),
	patchCurrentUserSettings: vi.fn(),
	registerByLoginName: vi.fn(),
}));

vi.mock('../services/theme-mode.js', () => ({
	syncThemeModeFromSettings: vi.fn(),
}));

vi.mock('../i18n/index.js', () => ({
	normalizeSettingsLocale: vi.fn((settings) => settings?.lang ?? null),
	setLocale: vi.fn(),
}));

const mockConnManager = {
	get: vi.fn(),
	connect: vi.fn(),
	disconnect: vi.fn(),
	syncConnections: vi.fn(),
	disconnectAll: vi.fn(),
};
vi.mock('../services/bot-connection-manager.js', () => ({
	useBotConnections: () => mockConnManager,
	__resetBotConnections: vi.fn(),
}));

vi.mock('../services/bots.api.js', () => ({
	listBots: vi.fn(() => Promise.resolve([])),
}));

import {
	changePassword,
	fetchSessionUser,
	loginByLoginName,
	logout,
	patchCurrentUserProfile,
	patchCurrentUserSettings,
	registerByLoginName,
} from '../services/auth.api.js';
import { syncThemeModeFromSettings } from '../services/theme-mode.js';
import { useDraftStore } from './draft.store.js';
import { useSessionsStore } from './sessions.store.js';
import { useBotsStore } from './bots.store.js';

describe('auth store', () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		vi.clearAllMocks();
	});

	test('refreshSession should set user when api returns session user', async () => {
		fetchSessionUser.mockResolvedValue({
			id: '1',
			auth: {
				local: {
					loginName: 'test',
				},
			},
		});
		const store = useAuthStore();

		await store.refreshSession();

		expect(store.user).toEqual({
			id: '1',
			auth: {
				local: {
					loginName: 'test',
				},
			},
		});
		expect(store.errorMessage).toBe('');
		expect(syncThemeModeFromSettings).toHaveBeenCalledWith(store.user?.settings);
	});

	test('refreshSession should expose error message on failure', async () => {
		fetchSessionUser.mockRejectedValue({
			response: {
				data: {
					message: 'failed-refresh',
				},
			},
		});
		const store = useAuthStore();

		await store.refreshSession();

		expect(store.errorMessage).toBe('failed-refresh');
	});

	test('refreshSession should fallback to err.message when response message is missing', async () => {
		fetchSessionUser.mockRejectedValue(new Error('refresh-message'));
		const store = useAuthStore();

		await store.refreshSession();

		expect(store.errorMessage).toBe('refresh-message');
	});

	test('login should save user after success', async () => {
		loginByLoginName.mockResolvedValue({
			user: {
				id: '2',
				auth: {
					local: {
						loginName: 'alice',
					},
				},
			},
		});
		const store = useAuthStore();

		await store.login({ loginName: 'alice', password: '123456' });

		expect(store.user).toEqual({
			id: '2',
			auth: {
				local: {
					loginName: 'alice',
				},
			},
		});
		expect(store.errorMessage).toBe('');
		expect(syncThemeModeFromSettings).toHaveBeenCalledWith(store.user?.settings);
	});

	test('login should expose error message on failure', async () => {
		loginByLoginName.mockRejectedValue({
			response: {
				data: {
					message: 'Invalid credentials',
				},
			},
		});
		const store = useAuthStore();

		await store.login({ loginName: 'test', password: 'wrong' });

		expect(store.user).toBeNull();
		expect(store.errorMessage).toBe('Invalid credentials');
	});

	test('register should save user after success', async () => {
		registerByLoginName.mockResolvedValue({
			user: {
				id: '10',
				auth: {
					local: {
						loginName: 'newuser',
					},
				},
			},
		});
		const store = useAuthStore();

		await store.register({ loginName: 'newuser', password: '123456' });

		expect(store.user).toEqual({
			id: '10',
			auth: {
				local: {
					loginName: 'newuser',
				},
			},
		});
		expect(store.errorMessage).toBe('');
		expect(syncThemeModeFromSettings).toHaveBeenCalledWith(store.user?.settings);
	});

	test('register should expose error message on failure', async () => {
		registerByLoginName.mockRejectedValue({
			response: {
				data: {
					message: 'LOGIN_NAME_TAKEN',
				},
			},
		});
		const store = useAuthStore();

		await store.register({ loginName: 'taken', password: '123456' });

		expect(store.user).toBeNull();
		expect(store.errorMessage).toBe('LOGIN_NAME_TAKEN');
	});

	test('register should fallback to default message when error is empty', async () => {
		registerByLoginName.mockRejectedValue({});
		const store = useAuthStore();

		await store.register({ loginName: 'x', password: 'y' });

		expect(store.user).toBeNull();
		expect(store.errorMessage).toBe('Registration failed');
	});

	test('logout should clear user', async () => {
		logout.mockResolvedValue();
		const store = useAuthStore();
		store.user = {
			id: '3',
			auth: {
				local: {
					loginName: 'bob',
				},
			},
		};

		await store.logout();

		expect(store.user).toBeNull();
		expect(store.errorMessage).toBe('');
		expect(syncThemeModeFromSettings).toHaveBeenCalledWith(null);
	});

	test('logout should reset sessions and bots stores', async () => {
		logout.mockResolvedValue();
		const store = useAuthStore();
		store.user = { id: '3' };

		// 预填充业务 store
		const sessionsStore = useSessionsStore();
		const botsStore = useBotsStore();
		sessionsStore.items = [{ sessionId: 's1' }];
		botsStore.items = [{ id: 'b1' }];

		await store.logout();

		expect(sessionsStore.items).toEqual([]);
		expect(botsStore.items).toEqual([]);
	});

	test('logout should disconnect all bot connections', async () => {
		logout.mockResolvedValue();
		const store = useAuthStore();
		store.user = { id: '3' };

		await store.logout();

		expect(mockConnManager.disconnectAll).toHaveBeenCalledTimes(1);
	});

	test('login 成功后调用 draftStore.onUserChanged', async () => {
		loginByLoginName.mockResolvedValue({ user: { id: '5' } });
		const store = useAuthStore();
		const draftStore = useDraftStore();
		const spy = vi.spyOn(draftStore, 'onUserChanged');

		await store.login({ loginName: 'a', password: 'b' });

		expect(spy).toHaveBeenCalled();
	});

	test('logout 时先 persist 草稿再调用 onUserChanged', async () => {
		logout.mockResolvedValue();
		const store = useAuthStore();
		store.user = { id: '3' };
		const draftStore = useDraftStore();
		const callOrder = [];
		vi.spyOn(draftStore, 'persist').mockImplementation(() => callOrder.push('persist'));
		vi.spyOn(draftStore, 'onUserChanged').mockImplementation(() => callOrder.push('onUserChanged'));

		await store.logout();

		expect(callOrder).toEqual(['persist', 'onUserChanged']);
	});

	test('logout should expose error message on failure', async () => {
		logout.mockRejectedValue({
			response: {
				data: {
					message: 'failed-logout',
				},
			},
		});
		const store = useAuthStore();

		await store.logout();

		expect(store.errorMessage).toBe('failed-logout');
	});

	test('updateProfile should merge patched profile', async () => {
		patchCurrentUserProfile.mockResolvedValue({
			name: 'new-name',
		});
		const store = useAuthStore();
		store.user = {
			id: '9',
			auth: {
				local: {
					loginName: 'test',
				},
			},
		};

		await store.updateProfile({
			name: 'new-name',
		});

		expect(store.user).toEqual({
			id: '9',
			name: 'new-name',
			auth: {
				local: {
					loginName: 'test',
				},
			},
		});
	});

	test('updateProfile should handle null user and null profile', async () => {
		patchCurrentUserProfile.mockResolvedValue(null);
		const store = useAuthStore();
		store.user = null;

		await store.updateProfile({
			name: 'new-name',
		});

		expect(store.user).toEqual({});
	});

	test('updateProfile should expose error message on failure', async () => {
		patchCurrentUserProfile.mockRejectedValue({
			response: {
				data: {
					message: 'failed-profile',
				},
			},
		});
		const store = useAuthStore();

		await store.updateProfile({
			name: 'x',
		});

		expect(store.errorMessage).toBe('failed-profile');
	});

	test('updateProfile should fallback to default message when error is empty', async () => {
		patchCurrentUserProfile.mockRejectedValue({});
		const store = useAuthStore();

		await store.updateProfile({
			name: 'x',
		});

		expect(store.errorMessage).toBe('Update profile failed');
	});

	test('changePassword should return true on success', async () => {
		changePassword.mockResolvedValue({ message: 'Password changed' });
		const store = useAuthStore();

		const ok = await store.changePassword({
			oldPassword: '123456',
			newPassword: 'Xyz-456',
		});

		expect(ok).toBe(true);
		expect(store.errorMessage).toBe('');
		expect(changePassword).toHaveBeenCalledWith({
			oldPassword: '123456',
			newPassword: 'Xyz-456',
		});
	});

	test('changePassword should return false and set error on failure', async () => {
		changePassword.mockRejectedValue({
			response: {
				data: {
					message: 'Invalid credentials',
				},
			},
		});
		const store = useAuthStore();

		const ok = await store.changePassword({
			oldPassword: 'wrong',
			newPassword: 'Xyz-456',
		});

		expect(ok).toBe(false);
		expect(store.errorMessage).toBe('Invalid credentials');
	});

	test('updateSettings should merge settings fields', async () => {
		patchCurrentUserSettings.mockResolvedValue({
			lang: 'en',
		});
		const store = useAuthStore();
		store.user = {
			id: '9',
			settings: {
				theme: 'dark',
			},
		};

		await store.updateSettings({
			lang: 'en',
		});

		expect(store.user).toEqual({
			id: '9',
			settings: {
				theme: 'dark',
				lang: 'en',
			},
		});
		expect(syncThemeModeFromSettings).toHaveBeenCalledWith(store.user?.settings);
	});

	test('updateSettings should handle null user and null settings', async () => {
		patchCurrentUserSettings.mockResolvedValue(null);
		const store = useAuthStore();
		store.user = null;

		await store.updateSettings({
			lang: 'en',
		});

		expect(store.user).toEqual({
			settings: {},
		});
	});

	test('updateSettings should expose error message on failure', async () => {
		patchCurrentUserSettings.mockRejectedValue({
			response: {
				data: {
					message: 'failed-settings',
				},
			},
		});
		const store = useAuthStore();

		await store.updateSettings({
			lang: 'en',
		});

		expect(store.errorMessage).toBe('failed-settings');
	});

	test('updateSettings should fallback to err.message when response message is missing', async () => {
		patchCurrentUserSettings.mockRejectedValue(new Error('settings-message'));
		const store = useAuthStore();

		await store.updateSettings({
			lang: 'en',
		});

		expect(store.errorMessage).toBe('settings-message');
	});
});
