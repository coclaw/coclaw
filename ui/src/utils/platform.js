/**
 * 统一平台检测
 * - Capacitor：移动端原生壳（Android/iOS）
 * - Electron：桌面端原生壳（Windows/macOS）
 * - Tauri：桌面端原生壳（保留待用）
 * - Web：普通浏览器
 *
 * 注意：此模块不依赖 capacitor-app.js，避免 Tauri/Web 环境加载 @capacitor/core
 */

// 浏览器下 globalThis === window；node/SSR/单测的 node 环境下没有 window，回退到 globalThis 以避免 import 时崩
const _g = typeof window !== 'undefined' ? window : globalThis;

/** 是否运行在桌面壳子（Electron）中 */
export const isElectronApp = !!_g.electronAPI;

/** 是否运行在桌面壳子（Tauri，保留待用）中 */
export const isTauriApp = '__TAURI_INTERNALS__' in _g;

/** 是否运行在移动壳子（Capacitor）中 */
export const isCapacitorApp = !!_g.Capacitor?.isNativePlatform();

/** 是否运行在任何原生壳子中 */
export const isNativeShell = isCapacitorApp || isElectronApp || isTauriApp;

/** 是否为桌面环境（原生桌面壳 或 普通浏览器桌面视口） */
export const isDesktop = isElectronApp || isTauriApp || !isCapacitorApp;

/**
 * 浏览器环境下通过 UA 检测操作系统平台
 * 优先 User-Agent Client Hints（Chromium 系），回退到 UA 字符串 + iPadOS 桌面模式伪装识别
 * @returns {'android'|'ios'|'windows'|'mac'|'linux'|'unknown'}
 */
export function detectWebPlatform() {
	if (typeof navigator === 'undefined') return 'unknown';
	const uaData = navigator.userAgentData;
	if (uaData?.platform) {
		const p = uaData.platform.toLowerCase();
		if (p === 'android') return 'android';
		if (p === 'ios') return 'ios';
		if (p === 'windows') return 'windows';
		if (p.includes('mac')) return 'mac';
		if (p.includes('linux')) return 'linux';
	}
	const ua = navigator.userAgent || '';
	if (/Android/i.test(ua)) return 'android';
	if (/iPad|iPhone|iPod/.test(ua)
		|| (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
	if (/Windows/i.test(ua)) return 'windows';
	if (/Macintosh|Mac OS/i.test(ua)) return 'mac';
	if (/Linux/i.test(ua)) return 'linux';
	return 'unknown';
}

/**
 * 是否运行在移动端操作系统（Android/iOS），覆盖原生壳与移动浏览器。
 * 用于判断 OS 是否会在应用进入后台时挂起进程/暂停网络——桌面 OS 不会。
 */
export const isMobileOs = detectMobileOs();

function detectMobileOs() {
	if (isCapacitorApp) return true;
	if (isElectronApp || isTauriApp) return false;
	const p = detectWebPlatform();
	return p === 'android' || p === 'ios';
}

/**
 * 平台标识
 * @returns {'capacitor' | 'electron' | 'tauri' | 'web'}
 */
export function getPlatformType() {
	if (isCapacitorApp) return 'capacitor';
	if (isElectronApp) return 'electron';
	if (isTauriApp) return 'tauri';
	return 'web';
}

/**
 * 诊断级平台细标签：比 getPlatformType 多区分 Capacitor 下的 android/ios 与 Electron 下的 win/mac/linux。
 *
 * 实现上**每次调用读 globalThis**（不依赖 module-const），便于测试用 vi.stubGlobal 切换平台。
 * @returns {'cap-android' | 'cap-ios' | `cap-${string}` | 'electron-win' | 'electron-mac' | 'electron-linux' | 'electron' | 'web'}
 */
export function detectPlatformLabel() {
	const Cap = _g.Capacitor;
	if (Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform()) {
		const p = typeof Cap.getPlatform === 'function' ? Cap.getPlatform() : '';
		if (p === 'android') return 'cap-android';
		if (p === 'ios') return 'cap-ios';
		return `cap-${p || 'unknown'}`;
	}
	if (_g.electronAPI) return detectElectronOsLabel();
	return 'web';
}

function detectElectronOsLabel() {
	const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
	if (/Windows/i.test(ua)) return 'electron-win';
	if (/Mac OS X|Macintosh/i.test(ua)) return 'electron-mac';
	if (/Linux/i.test(ua)) return 'electron-linux';
	return 'electron';
}
