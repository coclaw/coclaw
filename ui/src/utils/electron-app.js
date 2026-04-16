/**
 * Electron 桌面壳子渲染端初始化
 *
 * - Deep Link (coclaw://xxx) 解析并路由跳转
 * - 窗口 focus/blur 桥接为 app:foreground / app:background（与 Capacitor 对齐）
 * - 前后台切换调 remoteLog 上报（与 Capacitor 对齐 app.stateChange 埋点）
 *
 * 自动更新走 electron-updater 后台无感模式（autoDownload=true，下次退出时安装），
 * 与 Capacitor /version.json 路径一致，因此 renderer 不再桥接 update-* 事件。
 * 文件下载走 OS 自带下载条提示，与 Capacitor 系统分享一致，也不桥接 download-* 事件。
 * 截图全局快捷键暂未启用（无对应业务），相关事件桥接同步移除。
 *
 * preload 的 onXxx 仍返回 unsubscribe；本模块保存订阅的 unsub，
 * disposeElectronApp() 可清理全部订阅（HMR 重载/测试 teardown 场景）
 */
import { isElectronApp } from './platform.js';
import { remoteLog } from '../services/remote-log.js';

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

	// 窗口焦点 → Capacitor 风格事件 + 远程日志埋点
	// （app-update / claws.store / ChatPage 等模块依赖 app:foreground/background）
	track(api.onWindowFocus(() => {
		remoteLog('app.stateChange active=true source=electron');
		window.dispatchEvent(new CustomEvent('app:foreground'));
	}));
	track(api.onWindowBlur(() => {
		remoteLog('app.stateChange active=false source=electron');
		window.dispatchEvent(new CustomEvent('app:background'));
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
