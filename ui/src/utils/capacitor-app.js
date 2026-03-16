/**
 * Capacitor 原生壳初始化
 * - Edge-to-Edge 状态栏配置
 * - Android 返回键处理
 * - 后台保活前台服务
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { hasOpenDialog, closeCurrentDialog } from './dialog-history.js';

/** 是否运行在 Capacitor 原生壳中 */
export const isNative = Capacitor.isNativePlatform();

/**
 * 初始化 Capacitor 原生能力
 * @param {import('vue-router').Router} router - Vue Router 实例
 */
export async function initCapacitorApp(router) {
	if (!isNative) return;
	console.log('[capacitor] native platform detected, initializing...');

	try {
		await setupStatusBar();
	}
	catch (e) {
		console.warn('[capacitor] StatusBar init failed:', e);
	}

	try {
		setupBackButton(router);
	}
	catch (e) {
		console.warn('[capacitor] BackButton init failed:', e);
	}

	try {
		startKeepAlive();
	}
	catch (e) {
		console.warn('[capacitor] KeepAlive init failed:', e);
	}
}

async function setupStatusBar() {
	const { StatusBar, Style } = await import('@capacitor/status-bar');
	await StatusBar.setOverlaysWebView({ overlay: true });
	await StatusBar.setBackgroundColor({ color: '#00000000' });
	// 根据当前主题设置初始样式
	const isDark = document.documentElement.classList.contains('dark');
	await StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light });
	console.log('[capacitor] StatusBar configured (overlay + transparent, style=%s)', isDark ? 'dark' : 'light');
}

/**
 * 根据当前主题同步状态栏文字样式
 * @param {'dark' | 'light'} appliedTheme - 当前生效的主题
 */
export async function syncStatusBarStyle(appliedTheme) {
	if (!isNative) return;
	try {
		const { StatusBar, Style } = await import('@capacitor/status-bar');
		// Dark 主题 → Style.Dark（浅色图标）；Light 主题 → Style.Light（深色图标）
		await StatusBar.setStyle({ style: appliedTheme === 'dark' ? Style.Dark : Style.Light });
	}
	catch (e) {
		console.warn('[capacitor] syncStatusBarStyle failed:', e);
	}
}

function startKeepAlive() {
	const KeepAlive = registerPlugin('KeepAlive');
	KeepAlive.start()
		.then(() => console.log('[capacitor] KeepAliveService started'))
		.catch((e) => console.warn('[capacitor] KeepAliveService start failed:', e));
}

function setupBackButton(router) {
	import('@capacitor/app').then(({ App }) => {
		App.addListener('backButton', ({ canGoBack }) => {
			// 优先关闭打开的对话框
			if (hasOpenDialog()) {
				closeCurrentDialog();
				return;
			}
			const isTopPage = !!router.currentRoute.value?.meta?.isTopPage;
			if (isTopPage || !canGoBack) {
				App.minimizeApp();
				return;
			}
			window.history.back();
		});
		console.log('[capacitor] backButton listener registered');
	});
}
