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

const mockSigDisconnect = vi.fn();
vi.mock('../services/signaling-connection.js', () => ({
	useSignalingConnection: () => ({ disconnect: mockSigDisconnect, state: 'connected' }),
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
import { useSessionsStore, __resetSessionsInternals } from './sessions.store.js';
import { useBotsStore, __resetBotStoreInternals } from './bots.store.js';
import { useAgentsStore } from './agents.store.js';
import { useTopicsStore, __resetTopicsInternals } from './topics.store.js';

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

	test('refreshSession 同一用户不调用 draftStore.onUserChanged', async () => {
		fetchSessionUser.mockResolvedValue({ id: '1' });
		const store = useAuthStore();
		store.user = { id: '1' }; // 已有同一用户
		const spy = vi.spyOn(useDraftStore(), 'onUserChanged');

		await store.refreshSession();

		expect(spy).not.toHaveBeenCalled();
	});

	test('refreshSession 用户变更时调用 draftStore.onUserChanged', async () => {
		fetchSessionUser.mockResolvedValue({ id: '2' });
		const store = useAuthStore();
		store.user = { id: '1' }; // 旧用户
		const spy = vi.spyOn(useDraftStore(), 'onUserChanged');

		await store.refreshSession();

		expect(spy).toHaveBeenCalledOnce();
		expect(spy).toHaveBeenCalledWith('2');
	});

	test('refreshSession 首次加载（user 从 null 到有值）调用 draftStore.onUserChanged', async () => {
		fetchSessionUser.mockResolvedValue({ id: '1' });
		const store = useAuthStore();
		// store.user 初始为 null
		const spy = vi.spyOn(useDraftStore(), 'onUserChanged');

		await store.refreshSession();

		expect(spy).toHaveBeenCalledOnce();
		expect(spy).toHaveBeenCalledWith('1');
	});

	test('refreshSession 失败时不调用 draftStore.onUserChanged', async () => {
		fetchSessionUser.mockRejectedValue(new Error('network'));
		const store = useAuthStore();
		store.user = { id: '1' };
		const spy = vi.spyOn(useDraftStore(), 'onUserChanged');

		await store.refreshSession();

		expect(spy).not.toHaveBeenCalled();
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

	test('logout should reset all business stores', async () => {
		logout.mockResolvedValue();
		const store = useAuthStore();
		store.user = { id: '3' };

		// 预填充业务 store
		const sessionsStore = useSessionsStore();
		const botsStore = useBotsStore();
		const agentsStore = useAgentsStore();
		const topicsStore = useTopicsStore();
		sessionsStore.items = [{ sessionId: 's1' }];
		botsStore.items = [{ id: 'b1' }];
		agentsStore.byBot = { b1: { agents: [{ id: 'a1' }], defaultId: 'main', loading: false, fetched: true } };
		topicsStore.byId = { t1: { topicId: 't1', agentId: 'main', title: 'test', createdAt: 1, botId: 'b1' } };

		await store.logout();

		expect(sessionsStore.items).toEqual([]);
		expect(botsStore.items).toEqual([]);
		expect(agentsStore.byBot).toEqual({});
		expect(topicsStore.byId).toEqual({});
	});

	test('logout should disconnect all bot connections and signaling WS', async () => {
		logout.mockResolvedValue();
		const store = useAuthStore();
		store.user = { id: '3' };

		await store.logout();

		expect(mockConnManager.disconnectAll).toHaveBeenCalledTimes(1);
		expect(mockSigDisconnect).toHaveBeenCalledTimes(1);
	});

	test('logout should reset module-level internals (timers, loading guards)', async () => {
		logout.mockResolvedValue();
		const store = useAuthStore();
		store.user = { id: '3' };

		// auth.store 导入并调用了这三个函数；验证它们确实是有效导出
		expect(typeof __resetBotStoreInternals).toBe('function');
		expect(typeof __resetSessionsInternals).toBe('function');
		expect(typeof __resetTopicsInternals).toBe('function');

		// logout 应正常完成（含 internals 重置 + $reset）
		await store.logout();
		expect(useBotsStore().items).toEqual([]);
	});

	test('login 成功后调用 draftStore.onUserChanged', async () => {
		loginByLoginName.mockResolvedValue({ user: { id: '5' } });
		const store = useAuthStore();
		const draftStore = useDraftStore();
		const spy = vi.spyOn(draftStore, 'onUserChanged');

		await store.login({ loginName: 'a', password: 'b' });

		expect(spy).toHaveBeenCalledWith('5');
	});

	test('logout 时先 persist 草稿再调用 onUserChanged(null)', async () => {
		logout.mockResolvedValue();
		const store = useAuthStore();
		store.user = { id: '3' };
		const draftStore = useDraftStore();
		const callOrder = [];
		vi.spyOn(draftStore, 'persist').mockImplementation(() => callOrder.push('persist'));
		vi.spyOn(draftStore, 'onUserChanged').mockImplementation(() => callOrder.push('onUserChanged'));

		await store.logout();

		expect(callOrder).toEqual(['persist', 'onUserChanged']);
		expect(draftStore.onUserChanged).toHaveBeenCalledWith(null);
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
		// 即使 API 失败，本地状态也应被清理
		expect(store.user).toBeNull();
	});

	test('logout API 返回 401 时视为成功登出，不设 errorMessage', async () => {
		logout.mockRejectedValue({
			response: { status: 401, data: { message: 'unauthorized' } },
		});
		const store = useAuthStore();
		store.user = { id: '1' };

		await store.logout();

		expect(store.user).toBeNull();
		expect(store.errorMessage).toBe('');
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

	test('updateProfile should expose error message on failure and log warning', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
		expect(warnSpy).toHaveBeenCalledWith('[auth] updateProfile failed:', 'failed-profile');
		warnSpy.mockRestore();
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

	test('changePassword should return false and set error on failure and log warning', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
		expect(warnSpy).toHaveBeenCalledWith('[auth] changePassword failed:', 'Invalid credentials');
		warnSpy.mockRestore();
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

	test('updateSettings should expose error message on failure and log warning', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
		expect(warnSpy).toHaveBeenCalledWith('[auth] updateSettings failed:', 'failed-settings');
		warnSpy.mockRestore();
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
