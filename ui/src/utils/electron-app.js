/**
 * Electron 桌面壳子渲染端初始化
 *
 * - Deep Link (coclaw://xxx) 解析并路由跳转
 * - 窗口 focus/blur 桥接为 app:foreground / app:background（与 Capacitor 对齐）
 * - autoUpdater 事件桥接为 window CustomEvent，供 UI 组件订阅
 * - 截图快捷键、文件下载进度/完成事件桥接
 *
 * preload 的 onXxx 返回 unsubscribe；本模块保存所有 unsub，
 * disposeElectronApp() 可清理全部订阅（HMR 重载/测试 teardown 场景）
 */
import { isElectronApp } from './platform.js';

let unsubs = [];

function track(unsub) {
	if (typeof unsub === 'function') unsubs.push(unsub);
}

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
 * 非 Electron 环境下直接返回。重复调用会先 dispose 旧订阅，避免 HMR 累积。
 * @param {import('vue-router').Router} router
 */
export function initElectronApp(router) {
	if (!isElectronApp) return;
	console.log('[electron] desktop shell detected, initializing...');

	// 防 HMR 重复 init 导致的订阅泄漏
	disposeElectronApp();

	const api = window.electronAPI;

	// Deep Link 路由跳转
	track(api.onDeepLink((url) => {
		const routePath = parseDeepLinkToRoute(url);
		if (routePath) {
			console.log('[electron] deep-link → %s', routePath);
			router.push(routePath);
		}
		else {
			console.warn('[electron] invalid deep-link URL:', url);
		}
	}));

	// 窗口焦点 → Capacitor 风格事件（app-update / claws.store / ChatPage 等模块依赖）
	track(api.onWindowFocus(() => {
		window.dispatchEvent(new CustomEvent('app:foreground'));
	}));
	track(api.onWindowBlur(() => {
		window.dispatchEvent(new CustomEvent('app:background'));
	}));

	// 自动更新全流程事件 → CustomEvent
	track(api.onUpdateAvailable((info) => {
		console.log('[electron] update available: %s', info?.version);
		window.dispatchEvent(new CustomEvent('electron:update-available', { detail: info }));
	}));
	track(api.onUpdateDownloadProgress((info) => {
		window.dispatchEvent(new CustomEvent('electron:update-download-progress', { detail: info }));
	}));
	track(api.onUpdateDownloaded((info) => {
		console.log('[electron] update downloaded: %s', info?.version);
		window.dispatchEvent(new CustomEvent('electron:update-downloaded', { detail: info }));
	}));
	track(api.onUpdateNotAvailable((info) => {
		window.dispatchEvent(new CustomEvent('electron:update-not-available', { detail: info }));
	}));
	track(api.onUpdateError((info) => {
		console.warn('[electron] update error:', info?.message);
		window.dispatchEvent(new CustomEvent('electron:update-error', { detail: info }));
	}));
	// 补发 renderer 挂载前主进程已缓存的 update-available（若有）
	api.getPendingUpdate().then((info) => {
		if (info) {
			console.log('[electron] pending update restored: %s', info.version);
			window.dispatchEvent(new CustomEvent('electron:update-available', { detail: info }));
		}
	}).catch((e) => console.warn('[electron] getPendingUpdate failed:', e));

	// 截图全局快捷键
	track(api.onScreenshotTrigger(() => {
		window.dispatchEvent(new CustomEvent('electron:screenshot-trigger'));
	}));

	// 文件下载
	track(api.onDownloadProgress((info) => {
		window.dispatchEvent(new CustomEvent('electron:download-progress', { detail: info }));
	}));
	track(api.onDownloadDone((info) => {
		window.dispatchEvent(new CustomEvent('electron:download-done', { detail: info }));
	}));

	console.log('[electron] initialized');
}

/** 清理全部 IPC 订阅，避免 HMR/重 init 累积监听 */
export function disposeElectronApp() {
	for (const unsub of unsubs) {
		try { unsub(); }
		catch (e) { console.warn('[electron] unsubscribe failed:', e); }
	}
	unsubs = [];
}
