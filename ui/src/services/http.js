import axios from 'axios';

export function resolveApiBaseUrl() {
	const configured = String(import.meta.env.VITE_API_BASE_URL ?? '').trim();
	if (configured) {
		return configured;
	}
	if (typeof window !== 'undefined' && window.location?.origin) {
		return window.location.origin;
	}
	return 'http://localhost:3000';
}

export const httpClient = axios.create({
	baseURL: resolveApiBaseUrl(),
	withCredentials: true,
});

httpClient.interceptors.request.use((config) => {
	console.debug('[http] %s %s', config.method?.toUpperCase(), config.url);
	return config;
});

// 401 去重：3s 内只派发一次 auth:session-expired
let __lastExpiredAt = 0;
const AUTH_EXPIRED_THROTTLE_MS = 3000;

httpClient.interceptors.response.use(
	(res) => {
		console.debug('[http] %s %s → %d', res.config.method?.toUpperCase(), res.config.url, res.status);
		return res;
	},
	(err) => {
		const status = err?.response?.status ?? 0;
		const msg = err?.response?.data?.message ?? err?.message ?? '';
		console.warn('[http] %s %s → %d %s', err?.config?.method?.toUpperCase(), err?.config?.url, status, msg);

		// 401 → 通知认证过期（监听方会 guard 避免初始化阶段误触发）
		if (status === 401) {
			const now = Date.now();
			if (now - __lastExpiredAt > AUTH_EXPIRED_THROTTLE_MS) {
				__lastExpiredAt = now;
				console.warn('[http] 401 detected → dispatch auth:session-expired');
				window.dispatchEvent(new CustomEvent('auth:session-expired'));
			}
		}
		return Promise.reject(err);
	},
);
