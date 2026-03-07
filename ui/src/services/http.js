import axios from 'axios';

function resolveApiBaseUrl() {
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

httpClient.interceptors.response.use(
	(res) => {
		console.debug('[http] %s %s → %d', res.config.method?.toUpperCase(), res.config.url, res.status);
		return res;
	},
	(err) => {
		const status = err?.response?.status ?? 0;
		const msg = err?.response?.data?.message ?? err?.message ?? '';
		console.warn('[http] %s %s → %d %s', err?.config?.method?.toUpperCase(), err?.config?.url, status, msg);
		return Promise.reject(err);
	},
);
