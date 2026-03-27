/**
 * Capacitor 原生壳初始化
 * - Edge-to-Edge 状态栏配置
 * - 软键盘适配（scrollIntoView）
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
		setupKeyboard();
	}
	catch (e) {
		console.warn('[capacitor] Keyboard init failed:', e);
	}

	try {
		setupBackButton(router);
	}
	catch (e) {
		console.warn('[capacitor] BackButton init failed:', e);
	}

	try {
		setupAppStateChange();
	}
	catch (e) {
		console.warn('[capacitor] appStateChange init failed:', e);
	}

	// 所有初始化完成后隐藏启动屏（配合 SplashScreen.launchAutoHide: false）
	try {
		const { SplashScreen } = await import('@capacitor/splash-screen');
		await SplashScreen.hide();
		console.log('[capacitor] SplashScreen hidden');
	}
	catch (e) {
		console.warn('[capacitor] SplashScreen.hide failed:', e);
	}

	// KeepAlive 是 Android 自定义原生插件，iOS 无对应实现
	if (Capacitor.getPlatform() === 'android') {
		try {
			startKeepAlive();
		}
		catch (e) {
			console.warn('[capacitor] KeepAlive init failed:', e);
		}
	}
}

async function setupStatusBar() {
	const { StatusBar, Style } = await import('@capacitor/status-bar');
	await StatusBar.setOverlaysWebView({ overlay: true });
	// iOS 不支持 setBackgroundColor（静默忽略），仅 Android 生效
	await StatusBar.setBackgroundColor({ color: '#00000000' });
	// 根据当前主题设置初始样式
	const isDark = document.documentElement.classList.contains('dark');
	await StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light });

	// Android 14 及以下，env(safe-area-inset-top) 不可靠（Capacitor SystemBars 仅 Android 15+ 注入）
	// 通过 StatusBar.getInfo() 获取实际高度，注入 CSS 变量作为可靠兜底
	// iOS 的 StatusBar.getInfo() 不返回 height，safe-area 由 env() 原生提供，无需此兜底
	try {
		const info = await StatusBar.getInfo();
		if (info?.height > 0) {
			const root = document.documentElement.style;
			root.setProperty('--safe-area-inset-top', `${info.height}px`);
			console.log('[capacitor] safe-area-inset-top injected: %dpx', info.height);
		}
	}
	catch (e) {
		console.warn('[capacitor] StatusBar.getInfo failed:', e);
	}

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

function setupKeyboard() {
	import('@capacitor/keyboard').then(({ Keyboard }) => {
		// 键盘弹出后确保输入框可见
		Keyboard.addListener('keyboardDidShow', () => {
			const el = document.activeElement;
			if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) {
				el.scrollIntoView({ behavior: 'smooth', block: 'center' });
			}
		});
		console.log('[capacitor] Keyboard listener registered');
	}).catch((e) => console.warn('[capacitor] Keyboard setup failed:', e));
}

function startKeepAlive() {
	const KeepAlive = registerPlugin('KeepAlive');
	KeepAlive.start()
		.then(() => console.log('[capacitor] KeepAliveService started'))
		.catch((e) => console.warn('[capacitor] KeepAliveService start failed:', e));
}

function setupAppStateChange() {
	import('@capacitor/app').then(({ App }) => {
		App.addListener('appStateChange', ({ isActive }) => {
			// 前后台切换钩子 — 后续接入 WS 重连/断连逻辑
			console.log('[capacitor] appStateChange: isActive=%s', isActive);
		});
		console.log('[capacitor] appStateChange listener registered');
	});
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
