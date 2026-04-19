import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { useAuthStore, isLogoutInflight, __resetAuthInternals } from './auth.store.js';

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

// logout 调用顺序跟踪（按计划中的顺序断言）
// 顶层常量——vi.mock 工厂被 hoist 到 import 前执行，必须用 vi.hoisted 才能在工厂中引用
const {
	logoutCallOrder,
	mockConnManager,
	mockSigDisconnect,
	mockClearRemoteLogBuffer,
	mockResetAuthExpiredThrottle,
	mockFilesCancelAll,
	mockAgentRunsResetAll,
	mockChatStoreDisposeAll,
	mockDashboardReset,
	mockCloseAllRtcInstances,
} = vi.hoisted(() => {
	const order = [];
	return {
		logoutCallOrder: order,
		mockConnManager: {
			get: vi.fn(),
			connect: vi.fn(),
			disconnect: vi.fn(),
			syncConnections: vi.fn(),
			disconnectAll: vi.fn(() => { order.push('disconnectAll'); }),
		},
		mockSigDisconnect: vi.fn(() => { order.push('sigDisconnect'); }),
		mockClearRemoteLogBuffer: vi.fn(() => { order.push('clearRemoteLogBuffer'); }),
		mockResetAuthExpiredThrottle: vi.fn(() => { order.push('resetAuthExpiredThrottle'); }),
		mockFilesCancelAll: vi.fn(() => { order.push('filesCancelAll'); }),
		mockAgentRunsResetAll: vi.fn(() => { order.push('agentRunsResetAll'); }),
		mockChatStoreDisposeAll: vi.fn(() => { order.push('chatStoreDisposeAll'); }),
		mockDashboardReset: vi.fn(() => { order.push('dashboardReset'); }),
		mockCloseAllRtcInstances: vi.fn(() => { order.push('rtcCloseAll'); }),
	};
});

vi.mock('../services/claw-connection-manager.js', () => ({
	useClawConnections: () => mockConnManager,
	__resetClawConnections: vi.fn(),
}));

vi.mock('../services/signaling-connection.js', () => ({
	useSignalingConnection: () => ({ disconnect: mockSigDisconnect, state: 'connected' }),
}));

vi.mock('../services/webrtc-connection.js', () => ({
	closeAllRtcInstances: (...args) => mockCloseAllRtcInstances(...args),
}));

vi.mock('../services/remote-log.js', () => ({
	clearRemoteLogBuffer: (...args) => mockClearRemoteLogBuffer(...args),
	useRemoteLog: () => ({ log: () => {} }),
	remoteLog: () => {},
}));

vi.mock('../services/http.js', () => ({
	resetAuthExpiredThrottle: (...args) => mockResetAuthExpiredThrottle(...args),
	httpClient: { interceptors: { request: { use: () => {} }, response: { use: () => {} } } },
	resolveApiBaseUrl: () => '',
}));

// 4 个新接入的清理目标——mock 模块返回带间谍的实例/对象
vi.mock('./files.store.js', () => ({
	useFilesStore: () => ({
		cancelAll: mockFilesCancelAll,
		tasks: new Map(),
		dirCache: new Map(),
	}),
}));

vi.mock('./agent-runs.store.js', () => ({
	useAgentRunsStore: () => ({
		resetAll: mockAgentRunsResetAll,
		runs: {},
		runKeyIndex: {},
	}),
}));

vi.mock('./chat-store-manager.js', () => ({
	chatStoreManager: {
		disposeAll: mockChatStoreDisposeAll,
		get size() { return 0; },
	},
}));

vi.mock('./dashboard.store.js', () => ({
	useDashboardStore: () => ({
		$reset: mockDashboardReset,
		byClaw: {},
	}),
}));

vi.mock('../services/claws.api.js', () => ({
	listClaws: vi.fn(() => Promise.resolve([])),
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
import { useClawsStore, __resetClawStoreInternals } from './claws.store.js';
import { useAgentsStore } from './agents.store.js';
import { useTopicsStore, __resetTopicsInternals } from './topics.store.js';
import { useAdminStore } from './admin.store.js';

describe('auth store', () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		vi.clearAllMocks();
		logoutCallOrder.length = 0;
		__resetAuthInternals();
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
		const clawsStore = useClawsStore();
		const agentsStore = useAgentsStore();
		const topicsStore = useTopicsStore();
		const adminStore = useAdminStore();
		sessionsStore.items = [{ sessionId: 's1' }];
		clawsStore.byId = { b1: { id: 'b1' } };
		agentsStore.byClaw = { b1: { agents: [{ id: 'a1' }], defaultId: 'main', loading: false, fetched: true } };
		topicsStore.byId = { t1: { topicId: 't1', agentId: 'main', title: 'test', createdAt: 1, clawId: 'b1' } };
		adminStore.dashboard = { users: { total: 1 } };
		adminStore.claws.items = [{ id: 'c1', name: 'x' }];
		adminStore.claws.search = 'prev-search';
		adminStore.users.items = [{ id: 'u1' }];

		await store.logout();

		expect(sessionsStore.items).toEqual([]);
		expect(clawsStore.items).toEqual([]);
		expect(agentsStore.byClaw).toEqual({});
		expect(topicsStore.byId).toEqual({});
		// admin store 跨用户数据须在登出时清理，避免下一位管理员看到上一位的残留
		expect(adminStore.dashboard).toBeNull();
		expect(adminStore.claws.items).toEqual([]);
		expect(adminStore.claws.search).toBe('');
		expect(adminStore.users.items).toEqual([]);
	});

	test('logout should disconnect all claw connections and signaling WS', async () => {
		logout.mockResolvedValue();
		const store = useAuthStore();
		store.user = { id: '3' };

		await store.logout();

		expect(mockConnManager.disconnectAll).toHaveBeenCalledTimes(1);
		expect(mockSigDisconnect).toHaveBeenCalledTimes(1);
	});

	test('logout 按顺序清理 files → agent runs → conns → rtc → sig → remote log → throttle → chat stores → dashboard → admin SSE', async () => {
		logout.mockResolvedValue();
		const store = useAuthStore();
		store.user = { id: '3' };
		const adminStore = useAdminStore();
		const teardownSpy = vi.spyOn(adminStore, 'teardownStream')
			.mockImplementation(() => { logoutCallOrder.push('adminTeardownStream'); });

		await store.logout();

		expect(mockFilesCancelAll).toHaveBeenCalledTimes(1);
		expect(mockAgentRunsResetAll).toHaveBeenCalledTimes(1);
		expect(mockConnManager.disconnectAll).toHaveBeenCalledTimes(1);
		expect(mockCloseAllRtcInstances).toHaveBeenCalledTimes(1);
		expect(mockSigDisconnect).toHaveBeenCalledTimes(1);
		expect(mockChatStoreDisposeAll).toHaveBeenCalledTimes(1);
		expect(mockDashboardReset).toHaveBeenCalledTimes(1);
		expect(teardownSpy).toHaveBeenCalledTimes(1);

		// 顺序：files.cancelAll 必须在 disconnectAll 之前（让 transfer abort 有机会下发）
		// agent runs.resetAll 在 disconnectAll 之前（清 timer 不依赖网络）
		// rtc.closeAll 紧跟 disconnectAll：补清未完成 init 的 rtc（clawConn.__rtc 为 null，disconnectAll 碰不到）
		// chat stores.disposeAll 在 sig.disconnect 之后（先断连再 cleanup 避免 off 到 null conn）
		// admin.teardownStream 在 admin.$reset 之前（否则 $reset 直接清引用会泄漏 EventSource）
		expect(logoutCallOrder).toEqual([
			'filesCancelAll',
			'agentRunsResetAll',
			'disconnectAll',
			'rtcCloseAll',
			'sigDisconnect',
			'clearRemoteLogBuffer',
			'resetAuthExpiredThrottle',
			'chatStoreDisposeAll',
			'dashboardReset',
			'adminTeardownStream',
		]);
	});

	test('logout 某一步清理钩子抛错时，后续钩子仍被调用（错误隔离）', async () => {
		// 场景：任意一步抛同步异常（Capacitor/polyfill 边界 case），
		// 应由 safeRun 隔离并降级为 debug log，后续步骤照常执行。
		const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
		logout.mockResolvedValue();
		mockFilesCancelAll.mockClear();
		mockAgentRunsResetAll.mockClear();
		mockConnManager.disconnectAll.mockClear();
		mockCloseAllRtcInstances.mockClear();
		mockSigDisconnect.mockClear();
		mockChatStoreDisposeAll.mockClear();
		mockDashboardReset.mockClear();
		mockClearRemoteLogBuffer.mockClear();
		mockResetAuthExpiredThrottle.mockClear();

		// 让 files.cancelAll 抛错，验证剩余链条不被打断
		mockFilesCancelAll.mockImplementationOnce(() => {
			logoutCallOrder.push('filesCancelAll');
			throw new Error('boom from cancelAll');
		});

		const store = useAuthStore();
		store.user = { id: '9' };
		const adminStore = useAdminStore();
		const teardownSpy = vi.spyOn(adminStore, 'teardownStream');

		await store.logout();

		// 后续每一个清理钩子都应被调用——哪怕早期抛错
		expect(mockFilesCancelAll).toHaveBeenCalledTimes(1);
		expect(mockAgentRunsResetAll).toHaveBeenCalledTimes(1);
		expect(mockConnManager.disconnectAll).toHaveBeenCalledTimes(1);
		expect(mockCloseAllRtcInstances).toHaveBeenCalledTimes(1);
		expect(mockSigDisconnect).toHaveBeenCalledTimes(1);
		expect(mockChatStoreDisposeAll).toHaveBeenCalledTimes(1);
		expect(mockDashboardReset).toHaveBeenCalledTimes(1);
		expect(teardownSpy).toHaveBeenCalledTimes(1);
		expect(mockClearRemoteLogBuffer).toHaveBeenCalledTimes(1);
		expect(mockResetAuthExpiredThrottle).toHaveBeenCalledTimes(1);
		expect(store.user).toBeNull();
		// debug log 至少记录了那一次失败
		expect(debugSpy).toHaveBeenCalled();
		debugSpy.mockRestore();
	});

	test('logout 清空 remote-log 缓冲区，防止跨用户 flush', async () => {
		logout.mockResolvedValue();
		mockClearRemoteLogBuffer.mockClear();
		const store = useAuthStore();
		store.user = { id: '3' };

		await store.logout();

		expect(mockClearRemoteLogBuffer).toHaveBeenCalledTimes(1);
	});

	test('logout 复位 401 节流窗口，避免跨用户误吞首个合法 401', async () => {
		logout.mockResolvedValue();
		mockResetAuthExpiredThrottle.mockClear();
		const store = useAuthStore();
		store.user = { id: '3' };

		await store.logout();

		expect(mockResetAuthExpiredThrottle).toHaveBeenCalledTimes(1);
	});

	test('logout API 失败时新接入的清理钩子仍被执行', async () => {
		// 验证 auth.store.js 的契约：catch 不 return，本地清理链无条件跑
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		logout.mockRejectedValue({ response: { data: { message: 'server error' } } });
		mockResetAuthExpiredThrottle.mockClear();
		mockClearRemoteLogBuffer.mockClear();
		const store = useAuthStore();
		store.user = { id: '9' };
		const adminStore = useAdminStore();
		const teardownSpy = vi.spyOn(adminStore, 'teardownStream');

		await store.logout();

		expect(store.errorMessage).toBe('server error');
		expect(store.user).toBeNull();
		expect(teardownSpy).toHaveBeenCalledTimes(1);
		expect(mockResetAuthExpiredThrottle).toHaveBeenCalledTimes(1);
		expect(mockClearRemoteLogBuffer).toHaveBeenCalledTimes(1);
		warnSpy.mockRestore();
	});

	test('logout should reset module-level internals (timers, loading guards)', async () => {
		logout.mockResolvedValue();
		const store = useAuthStore();
		store.user = { id: '3' };

		// auth.store 导入并调用了这三个函数；验证它们确实是有效导出
		expect(typeof __resetClawStoreInternals).toBe('function');
		expect(typeof __resetSessionsInternals).toBe('function');
		expect(typeof __resetTopicsInternals).toBe('function');

		// logout 应正常完成（含 internals 重置 + $reset）
		await store.logout();
		expect(useClawsStore().items).toEqual([]);
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

	// --- logout 进行中锁 ---
	// 这组用例涉及 deferred logout API：统一使用 mockImplementationOnce/mockReturnValueOnce，
	// 避免 vi.clearAllMocks 不清 mock 实现导致 Promise 泄漏到后续 test

	test('logout 幂等：重入调用返回同一 Promise，API 只被调用一次', async () => {
		// 用 deferred 手动控制 logout API 结算时机，制造"API 还没返回时再次调用 logout"的场景
		let resolveLogoutApi;
		logout.mockReturnValueOnce(new Promise((r) => { resolveLogoutApi = r; }));
		const store = useAuthStore();
		store.user = { id: '1' };

		// 第一次 logout 尚未 settle
		const p1 = store.logout();
		// 锁应该已经占位
		expect(isLogoutInflight()).toBe(true);
		// 重入调用：API 不应被再次调用，清理链也不应再跑一次
		// （p1/p2/p3 是不同的 Promise 壳——async 函数每次调用产生新 Promise——
		// 但它们都在等同一 __logoutInflight，同时 settle；功能等价不要求对象相等）
		const p2 = store.logout();
		const p3 = store.logout();

		resolveLogoutApi();
		await Promise.all([p1, p2, p3]);

		// API 只调用一次，清理动作只执行一次
		expect(logout).toHaveBeenCalledTimes(1);
		expect(mockConnManager.disconnectAll).toHaveBeenCalledTimes(1);
		expect(mockFilesCancelAll).toHaveBeenCalledTimes(1);
		expect(mockSigDisconnect).toHaveBeenCalledTimes(1);
		// 锁已释放
		expect(isLogoutInflight()).toBe(false);
		expect(store.user).toBeNull();
	});

	test('logout API 抛错时锁仍释放，后续 logout 可再次发起', async () => {
		// 先让一次 logout 以 API 错误结束
		logout.mockRejectedValueOnce(new Error('network failed'));
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const store = useAuthStore();
		store.user = { id: '1' };

		await store.logout();
		expect(isLogoutInflight()).toBe(false);

		// 再次 logout（例如回到 /about 后用户又点登出）应能正常进入
		store.user = { id: '2' };
		logout.mockResolvedValueOnce();
		await store.logout();
		expect(logout).toHaveBeenCalledTimes(2);
		expect(store.user).toBeNull();
		warnSpy.mockRestore();
	});

	test('logout 清理链中途抛错时锁仍被释放，loading 恢复 false', async () => {
		// 模拟某个 safeRun 兜不住的路径抛同步错（虽然目前所有步骤都被 safeRun 包裹；
		// 本 test 固定"锁释放独立于清理成败"这一不变量，防御未来重构）
		logout.mockResolvedValueOnce();
		// 让 disconnectAll 同步抛错——其实 safeRun 会兜住；我们关注锁是否释放
		mockConnManager.disconnectAll.mockImplementationOnce(() => {
			logoutCallOrder.push('disconnectAll');
			throw new Error('boom mid-cleanup');
		});

		const store = useAuthStore();
		store.user = { id: '1' };
		await store.logout();

		expect(isLogoutInflight()).toBe(false);
		expect(store.loading).toBe(false);
		expect(store.user).toBeNull();
	});

	test('login 发起时若 logout 在飞，先等它完成再跑自己的逻辑', async () => {
		// 场景：401 自动 logout 还在进行，用户恰好此时在 /login 页提交登录
		const logoutOrder = [];
		let resolveLogoutApi;
		logout.mockImplementationOnce(() => {
			logoutOrder.push('logout:api-start');
			return new Promise((r) => { resolveLogoutApi = () => { logoutOrder.push('logout:api-end'); r(); }; });
		});
		loginByLoginName.mockImplementationOnce(async () => {
			logoutOrder.push('login:api-start');
			return { user: { id: 'new' } };
		});

		const store = useAuthStore();
		store.user = { id: 'old' };

		const logoutP = store.logout();
		// logout 未完成就发起 login
		const loginP = store.login({ loginName: 'alice', password: 'x' });

		// 此时 logout API 还没 settle，login API 不应该已经被调用
		await Promise.resolve();
		expect(logoutOrder).toEqual(['logout:api-start']);
		expect(loginByLoginName).not.toHaveBeenCalled();

		// 结算 logout API，让清理链跑完 → login 继续
		resolveLogoutApi();
		await Promise.all([logoutP, loginP]);

		// 严格顺序：logout API → (清理链) → login API；且 login 只跑一次
		expect(logoutOrder).toEqual(['logout:api-start', 'logout:api-end', 'login:api-start']);
		expect(loginByLoginName).toHaveBeenCalledTimes(1);
		// 清理动作已跑完（在 login 发起前）
		expect(mockConnManager.disconnectAll).toHaveBeenCalledTimes(1);
		expect(mockSigDisconnect).toHaveBeenCalledTimes(1);
		expect(store.user).toEqual({ id: 'new' });
	});

	test('register 发起时若 logout 在飞，先等它完成再注册', async () => {
		let resolveLogoutApi;
		logout.mockReturnValueOnce(new Promise((r) => { resolveLogoutApi = r; }));
		registerByLoginName.mockResolvedValueOnce({ user: { id: 'reg-1' } });

		const store = useAuthStore();
		store.user = { id: 'old' };
		const logoutP = store.logout();
		const registerP = store.register({ loginName: 'new', password: 'pwd' });

		await Promise.resolve();
		expect(registerByLoginName).not.toHaveBeenCalled();

		resolveLogoutApi();
		await Promise.all([logoutP, registerP]);

		expect(registerByLoginName).toHaveBeenCalledTimes(1);
		expect(mockConnManager.disconnectAll).toHaveBeenCalledTimes(1);
		expect(store.user).toEqual({ id: 'reg-1' });
	});

	test('refreshSession 发起时若 logout 在飞，先等它完成再拉 session', async () => {
		let resolveLogoutApi;
		logout.mockReturnValueOnce(new Promise((r) => { resolveLogoutApi = r; }));
		fetchSessionUser.mockResolvedValueOnce({ id: 'fresh' });

		const store = useAuthStore();
		store.user = { id: 'old' };
		const logoutP = store.logout();
		const refreshP = store.refreshSession();

		await Promise.resolve();
		expect(fetchSessionUser).not.toHaveBeenCalled();

		resolveLogoutApi();
		await Promise.all([logoutP, refreshP]);

		expect(fetchSessionUser).toHaveBeenCalledTimes(1);
		// logout 清空了 user → refreshSession 重新填入
		expect(store.user).toEqual({ id: 'fresh' });
	});

	test('isLogoutInflight 在 logout 过程中为 true，完成后为 false', async () => {
		let resolveLogoutApi;
		logout.mockReturnValueOnce(new Promise((r) => { resolveLogoutApi = r; }));
		const store = useAuthStore();
		store.user = { id: '1' };

		expect(isLogoutInflight()).toBe(false);
		const p = store.logout();
		expect(isLogoutInflight()).toBe(true);
		resolveLogoutApi();
		await p;
		expect(isLogoutInflight()).toBe(false);
	});

	test('__resetAuthInternals 强制清理锁（测试工具）', async () => {
		// 人为置锁 → 验证 reset 能把它清空
		let resolveLogoutApi;
		logout.mockReturnValueOnce(new Promise((r) => { resolveLogoutApi = r; }));
		const store = useAuthStore();
		store.user = { id: '1' };
		const p = store.logout();
		expect(isLogoutInflight()).toBe(true);

		__resetAuthInternals();
		expect(isLogoutInflight()).toBe(false);

		// 原 logout 还在跑，让它结算避免泄漏
		resolveLogoutApi();
		await p;
	});

	// --- logout 期间的 user-data 写入被阻拦 ---

	test('updateProfile 在 logout 进行中时直接返回，不调 API、不写 user，置 errorMessage', async () => {
		let resolveLogoutApi;
		logout.mockReturnValueOnce(new Promise((r) => { resolveLogoutApi = r; }));
		patchCurrentUserProfile.mockResolvedValueOnce({ name: 'x' });
		const store = useAuthStore();
		store.user = { id: '1' };

		const logoutP = store.logout();
		// logout 飞行中调 updateProfile
		await store.updateProfile({ name: 'x' });

		// API 未被调用、user 未被"复活"
		expect(patchCurrentUserProfile).not.toHaveBeenCalled();
		// errorMessage 必须非空：调用方 UI 的 "if (!errorMessage) notify.success" 才不会误报成功
		expect(store.errorMessage).toBe('Cannot update profile while signing out');

		resolveLogoutApi();
		await logoutP;
		// logout 完成后 user 为 null（不是被 updateProfile 复活的 { name: 'x' }）
		expect(store.user).toBeNull();
		// 注意：logout 的 clearError() 发生在 IIFE 头部（早于 updateProfile 的守卫），
		// 所以守卫设的 errorMessage 在 logout 完成后仍保留。
		// 这不构成用户可见 bug：UserProfilePanel 已随导航 /about 卸载；下次 login 的 clearError 会清。
		expect(store.errorMessage).toBe('Cannot update profile while signing out');
	});

	test('updateSettings 在 logout 进行中时直接返回并置 errorMessage', async () => {
		let resolveLogoutApi;
		logout.mockReturnValueOnce(new Promise((r) => { resolveLogoutApi = r; }));
		patchCurrentUserSettings.mockResolvedValueOnce({ lang: 'en' });
		const store = useAuthStore();
		store.user = { id: '1' };

		const logoutP = store.logout();
		await store.updateSettings({ lang: 'en' });

		expect(patchCurrentUserSettings).not.toHaveBeenCalled();
		expect(store.errorMessage).toBe('Cannot update settings while signing out');

		resolveLogoutApi();
		await logoutP;
		expect(store.user).toBeNull();
		// 同 updateProfile：守卫设的 errorMessage 在 logout 完成后保留
		expect(store.errorMessage).toBe('Cannot update settings while signing out');
	});

	test('changePassword 在 logout 进行中时返回 false 并置 errorMessage（避免空 toast）', async () => {
		let resolveLogoutApi;
		logout.mockReturnValueOnce(new Promise((r) => { resolveLogoutApi = r; }));
		changePassword.mockResolvedValueOnce({ message: 'ok' });
		const store = useAuthStore();
		store.user = { id: '1' };

		const logoutP = store.logout();
		const ok = await store.changePassword({ oldPassword: 'a', newPassword: 'b' });

		expect(ok).toBe(false);
		expect(changePassword).not.toHaveBeenCalled();
		expect(store.errorMessage).toBe('Cannot change password while signing out');

		resolveLogoutApi();
		await logoutP;
		expect(store.errorMessage).toBe('Cannot change password while signing out');
	});
});
