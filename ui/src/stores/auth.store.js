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
import { closeAllRtcInstances } from '../services/webrtc-connection.js';
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
import { __cancelPendingNetworkDispatch } from '../utils/network-debounce.js';

function applyUserPreferences(user) {
	syncThemeModeFromSettings(user?.settings);
	const locale = normalizeSettingsLocale(user?.settings);
	if (locale) {
		setLocale(locale);
	}
}

// logout 清理链单步隔离工具：任一步抛错只打 debug log，不中断后续清理
function safeRun(label, fn) {
	try { fn(); }
	catch (err) { console.debug('[auth] logout step %s failed: %s', label, err?.message); }
}

// 进行中 logout 锁（模块级）
// 作用 1：logout 自身幂等。401-during-logout 场景下（API 返回 401 → http.js 同步派发
//        auth:session-expired → __onSessionExpired 再次调用 logout），重入调用直接返回同一 Promise，
//        避免两条清理链并行跑
// 作用 2：login / register / refreshSession 开头 await 该锁，保证"新 login 面对的是干净环境"
let __logoutInflight = null;

// logout 纪元计数器。每次 logout 进入 IIFE 时递增。
// 作用：仅靠 __logoutInflight 无法防住"action 先 await API，期间 logout 开始又结束"这种交错：
//   app:foreground → refreshSession → await fetchSessionUser ……
//     （期间用户点 Logout）→ logout 完整跑完 → __logoutInflight 回归 null
//   fetchSessionUser 最终 resolve 后 `this.user = data` 把已清理的 user 复活。
// 各 action 在进入 await 前捕获 epoch，await 结束后若 epoch 已变，丢弃本次结果，不写 user。
let __logoutEpoch = 0;

/** @internal 仅供测试重置 */
export function __resetAuthInternals() {
	__logoutInflight = null;
	__logoutEpoch = 0;
}

/** 对外暴露是否有 logout 正在进行（只读视图，避免外部直接操作 Promise） */
export function isLogoutInflight() {
	return __logoutInflight !== null;
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
			// 让未完成的 logout 清理先跑完：避免 refreshSession 在脏 state 上赋值 user
			if (__logoutInflight) {
				try { await __logoutInflight; }
				catch (err) { console.debug('[auth] refreshSession waited logout settle with error: %s', err?.message); }
			}
			const epochAtStart = __logoutEpoch;
			this.loading = true;
			this.clearError();
			try {
				const prevUserId = this.user?.id;
				const data = await fetchSessionUser();
				// await 期间若 logout 执行过，本次响应已无效，丢弃避免把刚清理的 user 复活
				if (__logoutEpoch !== epochAtStart) {
					console.debug('[auth] refreshSession result dropped: logout occurred during fetch');
					return;
				}
				this.user = data;
				applyUserPreferences(this.user);
				// 仅在用户实际切换时才重置 draft 存储空间，避免每次导航清空未持久化的内存态草稿
				if (this.user?.id !== prevUserId) useDraftStore().onUserChanged(this.user?.id);
				console.debug('[auth] session refreshed, user=%s', this.user?.id ?? null);
			} catch (err) {
				if (__logoutEpoch !== epochAtStart) return; // logout 期间的 401/网络错不是真正的失败
				this.errorMessage = err?.response?.data?.message ?? err?.message ?? 'Failed to load session';
				console.warn('[auth] refreshSession failed:', this.errorMessage);
			} finally {
				this.loading = false;
			}
		},
		async login(credentials) {
			// 等待未完成的 logout：保证新 login 拿到的是全新环境（断开 WS/RTC/SSE、store 已 reset）
			if (__logoutInflight) {
				console.debug('[auth] login waits for in-flight logout to settle');
				try { await __logoutInflight; }
				catch (err) { console.debug('[auth] login waited logout settle with error: %s', err?.message); }
			}
			const epochAtStart = __logoutEpoch;
			this.loading = true;
			this.clearError();
			try {
				const data = await loginByLoginName(credentials);
				if (__logoutEpoch !== epochAtStart) {
					console.debug('[auth] login result dropped: logout occurred during request');
					return;
				}
				this.user = data.user;
				applyUserPreferences(this.user);
				useDraftStore().onUserChanged(this.user?.id);
				console.log('[auth] login ok, user=%s', this.user?.id);
			} catch (err) {
				if (__logoutEpoch !== epochAtStart) return;
				this.user = null;
				this.errorMessage = err?.response?.data?.message ?? err?.message ?? 'Login failed';
				console.warn('[auth] login failed:', this.errorMessage);
			} finally {
				this.loading = false;
			}
		},
		async register(credentials) {
			// 与 login 同理：等待 logout 清理完成后再注册，避免复用上一用户残留连接
			if (__logoutInflight) {
				console.debug('[auth] register waits for in-flight logout to settle');
				try { await __logoutInflight; }
				catch (err) { console.debug('[auth] register waited logout settle with error: %s', err?.message); }
			}
			const epochAtStart = __logoutEpoch;
			this.loading = true;
			this.clearError();
			try {
				const data = await registerByLoginName(credentials);
				if (__logoutEpoch !== epochAtStart) {
					console.debug('[auth] register result dropped: logout occurred during request');
					return;
				}
				this.user = data.user;
				applyUserPreferences(this.user);
				useDraftStore().onUserChanged(this.user?.id);
				console.log('[auth] register ok, user=%s', this.user?.id);
			} catch (err) {
				if (__logoutEpoch !== epochAtStart) return;
				this.user = null;
				this.errorMessage = err?.response?.data?.message ?? err?.message ?? 'Registration failed';
				console.warn('[auth] register failed:', this.errorMessage);
			} finally {
				this.loading = false;
			}
		},
		async logout() {
			// 幂等：重入调用返回进行中的同一 Promise，避免两条清理链并行跑
			if (__logoutInflight) return __logoutInflight;
			// 用 IIFE 包裹清理体：不作为 pinia action 暴露，外部无法绕过锁直接触发
			// loading 用 try/finally 兜底：即便中间同步抛错（safeRun 兜不住的边界情形），UI 也不会卡在 loading
			__logoutInflight = (async () => {
				__logoutEpoch++; // 供其他 action 的 await-recheck 识别
				this.loading = true;
				this.clearError();
				try {
					try {
						await logout();
					} catch (err) {
						// 401 = session 已过期，视为登出成功；其他错误仍继续清理
						if (err?.response?.status !== 401) {
							this.errorMessage = err?.response?.data?.message ?? err?.message ?? 'Logout failed';
							console.warn('[auth] logout failed:', this.errorMessage);
						}
					}
					// 无论 API 成功/401/其他错误，均执行本地清理。
					// 每一步独立 safeRun 包裹：单步抛错不传染，保证后续资源一定被清理。
					//
					// 重要：从 `this.user = null` 起到 `signaling.disconnect` 之间**严禁插入 await**。
					// AuthedLayout.vue 对 `authStore.user?.id` 的 watch 默认 flush:'pre'（异步 microtask），
					// 当前这段顺序同步执行，watch 回调延迟到 IIFE 完成后才 fire，因此 WS/SSE 的手动 disconnect
					// 先于 watch 触发的 disconnect，DC/RTC 资源能在连接仍在线时完成清理。
					// 若在这段期间 await（例如未来想让 files.cancelAll 等待 abort 发出），
					// watch 会抢先 disconnect WS，导致 DC 提前关闭、abort 无法送达、rtcInstances.delete 竞态。
					const draftStore = useDraftStore();
					safeRun('draft.persist', () => draftStore.persist());
					this.user = null;
					safeRun('draft.onUserChanged', () => draftStore.onUserChanged(null));
					safeRun('theme.reset', () => syncThemeModeFromSettings(null));
					// 先 files.cancelAll：让 transferHandle.cancel 能借仍在线的 DC 下发 abort
					safeRun('files.cancelAll', () => useFilesStore().cancelAll());
					// agent runs：清 24h 兜底 timer 与 idle watcher，释放 blob URL，唤醒悬挂的 finalPromise
					safeRun('agentRuns.resetAll', () => useAgentRunsStore().resetAll());
					safeRun('clawConns.disconnectAll', () => useClawConnections().disconnectAll());
					// 补清未完成 init 的 rtc（此时 clawConn.__rtc === null，disconnectAll 碰不到）：
					// 否则 15s 内同 clawId 重登会复用旧 rtc Promise，onReady 闭包指向旧 clawConn
					safeRun('rtc.closeAll', () => closeAllRtcInstances());
					safeRun('signaling.disconnect', () => useSignalingConnection().disconnect());
					// 丢弃 pending network:online debounce timer：避免 ≤1.2s 内的 logout→relogin
					// 场景里，上一会话的遗留 timer 对新会话派发一次多余的 restart/reconnect 信号
					safeRun('network.cancelPending', () => __cancelPendingNetworkDispatch());
					// 注：remoteLog 走独立 HTTP 通道（端点不强制登录态），登出无需清缓冲；详见
					// docs/designs/ui-remote-log-http-channel.md §3.6
					safeRun('http.resetThrottle', () => resetAuthExpiredThrottle()); // 复位 401 节流窗口，避免跨用户误吞首个合法 401
					// chat/topic store 实例逐个 dispose（cleanup() + $dispose()）
					safeRun('chatStoreMgr.disposeAll', () => chatStoreManager.disposeAll());
					safeRun('dashboard.$reset', () => useDashboardStore().$reset());
					// admin SSE 强制关闭：$reset() 不会 close handle，直接清引用会泄漏 EventSource + 窗口监听器
					safeRun('admin.teardownStream', () => useAdminStore().teardownStream());
					safeRun('claws.__resetInternals', () => __resetClawStoreInternals());
					safeRun('sessions.__resetInternals', () => __resetSessionsInternals());
					safeRun('topics.__resetInternals', () => __resetTopicsInternals());
					safeRun('sessions.$reset', () => useSessionsStore().$reset());
					safeRun('agents.$reset', () => useAgentsStore().$reset());
					safeRun('topics.$reset', () => useTopicsStore().$reset());
					safeRun('claws.$reset', () => useClawsStore().$reset());
					safeRun('admin.$reset', () => useAdminStore().$reset());
					console.log('[auth] logged out');
				} finally {
					this.loading = false;
				}
			})();
			try { return await __logoutInflight; }
			finally { __logoutInflight = null; }
		},
		async updateProfile(payload) {
			// logout 期间禁止写 user：否则 API 返回后合并进 null user 会把它"复活"为残缺对象
			// 同时 set errorMessage：UI 的 "if (!errorMessage) notify.success" 分支才不会误报成功
			if (__logoutInflight) {
				console.debug('[auth] updateProfile skipped: logout in flight');
				this.errorMessage = 'Cannot update profile while signing out';
				return;
			}
			const epochAtStart = __logoutEpoch;
			this.loading = true;
			this.clearError();
			try {
				const profile = await patchCurrentUserProfile(payload);
				if (__logoutEpoch !== epochAtStart) {
					console.debug('[auth] updateProfile result dropped: logout occurred during request');
					return;
				}
				this.user = {
					...(this.user ?? {}),
					...(profile ?? {}),
				};
			} catch (err) {
				if (__logoutEpoch !== epochAtStart) return;
				this.errorMessage = err?.response?.data?.message ?? err?.message ?? 'Update profile failed';
				console.warn('[auth] updateProfile failed:', this.errorMessage);
			} finally {
				this.loading = false;
			}
		},
		async changePassword(payload) {
			// logout 期间 session 即将失效，该请求无意义
			// set errorMessage：调用方 UI 会在 !ok 时 notify.error(errorMessage)，避免空 toast
			if (__logoutInflight) {
				console.debug('[auth] changePassword skipped: logout in flight');
				this.errorMessage = 'Cannot change password while signing out';
				return false;
			}
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
			// 与 updateProfile 同：logout 期间的合并写会把 user 复活为脏对象
			if (__logoutInflight) {
				console.debug('[auth] updateSettings skipped: logout in flight');
				this.errorMessage = 'Cannot update settings while signing out';
				return;
			}
			const epochAtStart = __logoutEpoch;
			this.loading = true;
			this.clearError();
			try {
				const settings = await patchCurrentUserSettings(payload);
				if (__logoutEpoch !== epochAtStart) {
					console.debug('[auth] updateSettings result dropped: logout occurred during request');
					return;
				}
				this.user = {
					...(this.user ?? {}),
					settings: {
						...(this.user?.settings ?? {}),
						...(settings ?? {}),
					},
				};
				applyUserPreferences(this.user);
			} catch (err) {
				if (__logoutEpoch !== epochAtStart) return;
				this.errorMessage = err?.response?.data?.message ?? err?.message ?? 'Update settings failed';
				console.warn('[auth] updateSettings failed:', this.errorMessage);
			} finally {
				this.loading = false;
			}
		},
	},
});
