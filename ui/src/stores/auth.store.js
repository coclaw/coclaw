import { defineStore } from 'pinia';

import {
	changePassword,
	fetchSessionUser,
	loginByLoginName,
	logout,
	patchCurrentUserProfile,
	patchCurrentUserSettings,
	registerByLoginName,
} from '../services/auth.api.js';
import {
	normalizeSettingsLocale,
	setLocale,
} from '../i18n/index.js';
import { syncThemeModeFromSettings } from '../services/theme-mode.js';
import { useClawConnections } from '../services/claw-connection-manager.js';
import { useSignalingConnection } from '../services/signaling-connection.js';
import { clearRemoteLogBuffer } from '../services/remote-log.js';
import { resetAuthExpiredThrottle } from '../services/http.js';
import { useDraftStore } from './draft.store.js';
import { useSessionsStore, __resetSessionsInternals } from './sessions.store.js';
import { useClawsStore, __resetClawStoreInternals } from './claws.store.js';
import { useAgentsStore } from './agents.store.js';
import { useTopicsStore, __resetTopicsInternals } from './topics.store.js';
import { useAdminStore } from './admin.store.js';
import { useAgentRunsStore } from './agent-runs.store.js';
import { chatStoreManager } from './chat-store-manager.js';
import { useFilesStore } from './files.store.js';
import { useDashboardStore } from './dashboard.store.js';

function applyUserPreferences(user) {
	syncThemeModeFromSettings(user?.settings);
	const locale = normalizeSettingsLocale(user?.settings);
	if (locale) {
		setLocale(locale);
	}
}

export const useAuthStore = defineStore('auth', {
	state: () => ({
		user: null,
		loading: false,
		errorMessage: '',
	}),
	actions: {
		clearError() {
			this.errorMessage = '';
		},
		async refreshSession() {
			this.loading = true;
			this.clearError();
			try {
				const prevUserId = this.user?.id;
				this.user = await fetchSessionUser();
				applyUserPreferences(this.user);
				// 仅在用户实际切换时才重置 draft 存储空间，避免每次导航清空未持久化的内存态草稿
				if (this.user?.id !== prevUserId) useDraftStore().onUserChanged(this.user?.id);
				console.debug('[auth] session refreshed, user=%s', this.user?.id ?? null);
			} catch (err) {
				this.errorMessage = err?.response?.data?.message ?? err?.message ?? 'Failed to load session';
				console.warn('[auth] refreshSession failed:', this.errorMessage);
			} finally {
				this.loading = false;
			}
		},
		async login(credentials) {
			this.loading = true;
			this.clearError();
			try {
				const data = await loginByLoginName(credentials);
				this.user = data.user;
				applyUserPreferences(this.user);
				useDraftStore().onUserChanged(this.user?.id);
				console.log('[auth] login ok, user=%s', this.user?.id);
			} catch (err) {
				this.user = null;
				this.errorMessage = err?.response?.data?.message ?? err?.message ?? 'Login failed';
				console.warn('[auth] login failed:', this.errorMessage);
			} finally {
				this.loading = false;
			}
		},
		async register(credentials) {
			this.loading = true;
			this.clearError();
			try {
				const data = await registerByLoginName(credentials);
				this.user = data.user;
				applyUserPreferences(this.user);
				useDraftStore().onUserChanged(this.user?.id);
				console.log('[auth] register ok, user=%s', this.user?.id);
			} catch (err) {
				this.user = null;
				this.errorMessage = err?.response?.data?.message ?? err?.message ?? 'Registration failed';
				console.warn('[auth] register failed:', this.errorMessage);
			} finally {
				this.loading = false;
			}
		},
		async logout() {
			this.loading = true;
			this.clearError();
			try {
				await logout();
			} catch (err) {
				// 401 = session 已过期，视为登出成功；其他错误仍继续清理
				if (err?.response?.status !== 401) {
					this.errorMessage = err?.response?.data?.message ?? err?.message ?? 'Logout failed';
					console.warn('[auth] logout failed:', this.errorMessage);
				}
			}
			// 无论 API 成功/401/其他错误，均执行本地清理
			const draftStore = useDraftStore();
			draftStore.persist();
			this.user = null;
			draftStore.onUserChanged(null);
			syncThemeModeFromSettings(null);
			// 先 files.cancelAll：让 transferHandle.cancel 能借仍在线的 DC 下发 abort
			useFilesStore().cancelAll();
			// agent runs：清 24h 兜底 timer 与 idle watcher，释放 blob URL，唤醒悬挂的 finalPromise
			useAgentRunsStore().resetAll();
			useClawConnections().disconnectAll();
			useSignalingConnection().disconnect();
			clearRemoteLogBuffer(); // 防止前一用户的未发送日志被下一用户的 WS 通道 flush 出去
			resetAuthExpiredThrottle(); // 复位 401 节流窗口，避免跨用户误吞首个合法 401
			// chat/topic store 实例逐个 dispose（cleanup() + $dispose()）
			chatStoreManager.disposeAll();
			useDashboardStore().$reset();
			// admin SSE 强制关闭：$reset() 不会 close handle，直接清引用会泄漏 EventSource + 窗口监听器
			useAdminStore().teardownStream();
			__resetClawStoreInternals();
			__resetSessionsInternals();
			__resetTopicsInternals();
			useSessionsStore().$reset();
			useAgentsStore().$reset();
			useTopicsStore().$reset();
			useClawsStore().$reset();
			useAdminStore().$reset();
			console.log('[auth] logged out');
			this.loading = false;
		},
		async updateProfile(payload) {
			this.loading = true;
			this.clearError();
			try {
				const profile = await patchCurrentUserProfile(payload);
				this.user = {
					...(this.user ?? {}),
					...(profile ?? {}),
				};
			} catch (err) {
				this.errorMessage = err?.response?.data?.message ?? err?.message ?? 'Update profile failed';
				console.warn('[auth] updateProfile failed:', this.errorMessage);
			} finally {
				this.loading = false;
			}
		},
		async changePassword(payload) {
			this.clearError();
			try {
				await changePassword(payload);
				return true;
			} catch (err) {
				this.errorMessage = err?.response?.data?.message ?? err?.message ?? 'Change password failed';
				console.warn('[auth] changePassword failed:', this.errorMessage);
				return false;
			}
		},
		async updateSettings(payload) {
			this.loading = true;
			this.clearError();
			try {
				const settings = await patchCurrentUserSettings(payload);
				this.user = {
					...(this.user ?? {}),
					settings: {
						...(this.user?.settings ?? {}),
						...(settings ?? {}),
					},
				};
				applyUserPreferences(this.user);
			} catch (err) {
				this.errorMessage = err?.response?.data?.message ?? err?.message ?? 'Update settings failed';
				console.warn('[auth] updateSettings failed:', this.errorMessage);
			} finally {
				this.loading = false;
			}
		},
	},
});
