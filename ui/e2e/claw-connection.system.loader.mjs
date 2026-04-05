/**
 * ESM loader hook：拦截依赖浏览器/Vite 环境的模块，返回 Node.js 兼容的 stub
 * 仅供系统测试使用
 */

const STUBS = {
	// http.js — 去除 import.meta.env 依赖
	'services/http.js': `
		export function resolveApiBaseUrl() {
			return process.env.COCLAW_TEST_API_URL ?? 'http://localhost:3000';
		}
		import axios from 'axios';
		export const httpClient = axios.create({
			baseURL: resolveApiBaseUrl(),
			withCredentials: true,
		});
	`,
	// i18n — vue-i18n 需要完整 Vue 环境，此处 stub
	'i18n/index.js': `
		export function normalizeSettingsLocale() { return null; }
		export function setLocale() {}
	`,
	// theme-mode.js — 依赖 capacitor-app（原生 API）
	'services/theme-mode.js': `
		export function syncThemeModeFromSettings() {}
	`,
	// file-helper.js — 使用 FileReader（浏览器 API），sendMessage 测试中不涉及文件
	'utils/file-helper.js': `
		export function fileToBase64() { return Promise.resolve(''); }
		export function formatFileSize() { return '0 B'; }
		export function formatFileBlob(blob) {
			return { id: 'stub', isImg: false, isVoice: false, label: '0 B', name: 'file', ext: '', bytes: 0, file: blob, url: null };
		}
	`,
};

export async function resolve(specifier, context, nextResolve) {
	return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
	for (const [pattern, source] of Object.entries(STUBS)) {
		if (url.includes(`/src/${pattern}`) || url.endsWith(pattern)) {
			return { format: 'module', shortCircuit: true, source };
		}
	}
	return nextLoad(url, context);
}
