/**
 * Capacitor 原生壳初始化
 * - Edge-to-Edge 状态栏配置
 * - 软键盘适配（scrollIntoView）
 * - Android 返回键处理
 * - 后台保活前台服务
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { hasOpenDialog, closeCurrentDialog } from './dialog-history.js';
import { remoteLog } from '../services/remote-log.js';
import { i18n } from '../i18n/index.js';
import { useNotify } from '../composables/use-notify.js';

/** 是否运行在 Capacitor 原生壳中 */
export const isNative = Capacitor.isNativePlatform();

// Web 端：桥接浏览器原生 online 事件为统一的 network:online
// 追踪是否经历过 offline，防止无前置 offline 的 spurious online 事件
if (!isNative && typeof window !== 'undefined') {
	let wasOffline = !navigator.onLine;
	window.addEventListener('offline', () => { wasOffline = true; });
	window.addEventListener('online', () => {
		if (!wasOffline) return;
		wasOffline = false;
		console.log('[network] browser online → dispatch network:online');
		remoteLog('app.network connected=true source=browser');
		window.dispatchEvent(new CustomEvent('network:online'));
	});
}

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

	try {
		setupDeepLink(router);
	}
	catch (e) {
		console.warn('[capacitor] deepLink init failed:', e);
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

	try {
		setupNetworkListener();
	}
	catch (e) {
		console.warn('[capacitor] Network init failed:', e);
	}

	// 以下为 Android 自定义原生插件，iOS 无对应实现
	if (Capacitor.getPlatform() === 'android') {
		try {
			startKeepAlive();
		}
		catch (e) {
			console.warn('[capacitor] KeepAlive init failed:', e);
		}

		try {
			initShareIntent();
		}
		catch (e) {
			console.warn('[capacitor] ShareIntent init failed:', e);
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

// --- Share Intent（外部 App 分享内容到 CoClaw） ---

const ShareIntent = Capacitor.isNativePlatform()
	? registerPlugin('ShareIntent')
	: null;

function initShareIntent() {
	if (!Capacitor.isPluginAvailable('ShareIntent')) return;

	// 冷启动：检查是否有待消费的分享数据
	ShareIntent.checkPending().then((data) => {
		if (data?.type) {
			handleShareReceived(data).catch((e) => console.warn('[capacitor] handleShareReceived failed:', e));
		}
	}).catch((e) => console.warn('[capacitor] ShareIntent.checkPending failed:', e));

	// 热启动：监听后续分享事件
	ShareIntent.addListener('shareReceived', (data) => {
		handleShareReceived(data).catch((e) => console.warn('[capacitor] handleShareReceived failed:', e));
	});

	console.log('[capacitor] ShareIntent listener registered');
}

/**
 * 处理从外部 App 接收到的分享数据。
 *
 * TODO (#159): 将来实现完整流程：
 * - 弹出 Agent 选择器，让用户选择发送目标
 * - 导航到对应的聊天页面
 * - 文本：填入输入框
 * - 文件：通过 path 读取为 Blob，作为附件添加
 *
 * @param {{ type: 'text' | 'file', text?: string, files?: Array<{ path: string, name: string, mimeType: string, size?: number }> }} data
 */
async function handleShareReceived(data) {
	console.log('[capacitor] share received: type=%s', data.type, data);

	// TODO (#159): 替换为实际的 Agent 选择 → 路由跳转 → 内容填充
	const notify = useNotify();
	notify.info({ title: i18n.global.t('common.featureComingSoon'), duration: 4000 });

	// 清理原生层临时文件
	if (data.type === 'file') {
		ShareIntent.clearFiles()
			.catch((e) => console.warn('[capacitor] clearFiles failed:', e));
	}
}

function setupAppStateChange() {
	import('@capacitor/app').then(({ App }) => {
		App.addListener('appStateChange', ({ isActive }) => {
			console.log('[capacitor] appStateChange: isActive=%s', isActive);
			remoteLog(`app.stateChange active=${isActive}`);
			if (isActive) {
				// 通知各模块进行前台恢复（ClawConnection/SSE/Polling/ChatPage）
				window.dispatchEvent(new CustomEvent('app:foreground'));
			} else {
				// 通知各模块进入后台（可用于保存状态、记录时间戳等）
				window.dispatchEvent(new CustomEvent('app:background'));
			}
		});
		console.log('[capacitor] appStateChange listener registered');
	});
}

/** 上次已知的网络类型（仅 wifi/cellular 时更新） */
let _lastConnectionType = null;

/**
 * 归一化 connectionType：仅保留 wifi / cellular，其余返回 null
 * @param {string} type
 * @returns {'wifi' | 'cellular' | null}
 */
function normalizeConnectionType(type) {
	if (type === 'wifi') return 'wifi';
	if (type === 'cellular') return 'cellular';
	return null;
}

function setupNetworkListener() {
	import('@capacitor/network').then(({ Network }) => {
		Network.addListener('networkStatusChange', ({ connected, connectionType }) => {
			const normalized = normalizeConnectionType(connectionType);
			console.log('[capacitor] networkStatusChange: connected=%s type=%s', connected, connectionType);
			remoteLog(`app.network connected=${connected} type=${connectionType}`);
			if (connected) {
				let typeChanged = false;
				if (normalized && _lastConnectionType && normalized !== _lastConnectionType) {
					typeChanged = true;
					remoteLog(`app.network typeChanged ${_lastConnectionType}→${normalized}`);
				}
				if (normalized) _lastConnectionType = normalized;
				window.dispatchEvent(new CustomEvent('network:online', { detail: { typeChanged } }));
			}
		});
		// 读取初始网络类型
		Network.getStatus().then(({ connectionType }) => {
			const normalized = normalizeConnectionType(connectionType);
			if (normalized) _lastConnectionType = normalized;
			console.log('[capacitor] initial connectionType=%s', connectionType);
		}).catch(() => {});
		console.log('[capacitor] Network listener registered');
	}).catch((e) => console.warn('[capacitor] Network setup failed:', e));
}

function setupDeepLink(router) {
	import('@capacitor/app').then(({ App }) => {
		App.addListener('appUrlOpen', ({ url }) => {
			if (!url) return;
			try {
				const parsed = new URL(url);
				// coclaw://chat/123 → host="chat", pathname="/123" → routePath="/chat/123"
				const routePath = '/' + [parsed.host, parsed.pathname].filter(Boolean).join('').replace(/^\/+/, '');
				if (routePath !== '/') {
					console.log('[capacitor] deep-link → %s', routePath);
					router.push(routePath);
				}
			}
			catch (e) {
				console.warn('[capacitor] invalid deep-link URL:', url, e);
			}
		});
		console.log('[capacitor] deep-link listener registered');
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
