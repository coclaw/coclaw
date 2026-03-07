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
import { useSessionsStore } from './sessions.store.js';
import { useBotsStore } from './bots.store.js';

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
				this.user = await fetchSessionUser();
				applyUserPreferences(this.user);
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
				this.user = null;
				syncThemeModeFromSettings(null);
				useSessionsStore().$reset();
				useBotsStore().$reset();
				console.log('[auth] logged out');
			} catch (err) {
				this.errorMessage = err?.response?.data?.message ?? err?.message ?? 'Logout failed';
				console.warn('[auth] logout failed:', this.errorMessage);
			} finally {
				this.loading = false;
			}
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
			} finally {
				this.loading = false;
			}
		},
	},
});
