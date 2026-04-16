/**
 * Electron 桌面壳子渲染端初始化
 *
 * - Deep Link (coclaw://xxx) 解析并路由跳转
 * - 窗口 focus/blur 桥接为 app:foreground / app:background（与 Capacitor 对齐）
 * - autoUpdater 事件桥接为 window CustomEvent，供 UI 组件订阅
 * - 截图快捷键、文件下载进度/完成事件桥接
 */
import { isElectronApp } from './platform.js';

/**
 * 将 coclaw:// URL 解析为 Vue Router 路径
 * 例：coclaw://chat/123 → "/chat/123"
 * @param {string} url
 * @returns {string | null}
 */
export function parseDeepLinkToRoute(url) {
	try {
		const parsed = new URL(url);
		const joined = [parsed.host, parsed.pathname].filter(Boolean).join('').replace(/^\/+/, '');
		if (!joined) return null;
		return '/' + joined;
	}
	catch {
		return null;
	}
}

/**
 * 初始化 Electron 壳子渲染端
 * 非 Electron 环境下直接返回。
 * @param {import('vue-router').Router} router
 */
export function initElectronApp(router) {
	if (!isElectronApp) return;
	console.log('[electron] desktop shell detected, initializing...');

	const api = window.electronAPI;

	// Deep Link 路由跳转
	api.onDeepLink((url) => {
		const routePath = parseDeepLinkToRoute(url);
		if (routePath) {
			console.log('[electron] deep-link → %s', routePath);
			router.push(routePath);
		}
		else {
			console.warn('[electron] invalid deep-link URL:', url);
		}
	});

	// 窗口焦点 → Capacitor 风格事件（app-update / claws.store / ChatPage 等模块依赖）
	api.onWindowFocus(() => {
		window.dispatchEvent(new CustomEvent('app:foreground'));
	});
	api.onWindowBlur(() => {
		window.dispatchEvent(new CustomEvent('app:background'));
	});

	// 自动更新全流程事件 → CustomEvent
	api.onUpdateAvailable((info) => {
		console.log('[electron] update available: %s', info?.version);
		window.dispatchEvent(new CustomEvent('electron:update-available', { detail: info }));
	});
	api.onUpdateDownloadProgress((info) => {
		window.dispatchEvent(new CustomEvent('electron:update-download-progress', { detail: info }));
	});
	api.onUpdateDownloaded((info) => {
		console.log('[electron] update downloaded: %s', info?.version);
		window.dispatchEvent(new CustomEvent('electron:update-downloaded', { detail: info }));
	});
	api.onUpdateNotAvailable((info) => {
		window.dispatchEvent(new CustomEvent('electron:update-not-available', { detail: info }));
	});
	api.onUpdateError((info) => {
		console.warn('[electron] update error:', info?.message);
		window.dispatchEvent(new CustomEvent('electron:update-error', { detail: info }));
	});
	// 补发 renderer 挂载前主进程已缓存的 update-available（若有）
	api.getPendingUpdate().then((info) => {
		if (info) {
			console.log('[electron] pending update restored: %s', info.version);
			window.dispatchEvent(new CustomEvent('electron:update-available', { detail: info }));
		}
	}).catch((e) => console.warn('[electron] getPendingUpdate failed:', e));

	// 截图全局快捷键
	api.onScreenshotTrigger(() => {
		window.dispatchEvent(new CustomEvent('electron:screenshot-trigger'));
	});

	// 文件下载
	api.onDownloadProgress((info) => {
		window.dispatchEvent(new CustomEvent('electron:download-progress', { detail: info }));
	});
	api.onDownloadDone((info) => {
		window.dispatchEvent(new CustomEvent('electron:download-done', { detail: info }));
	});

	console.log('[electron] initialized');
}
