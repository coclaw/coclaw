/**
 * 运行环境状态 store
 * - screen: 响应式屏幕断点（与 Tailwind 对齐）
 * - isTouch / hasTouch / canHover: 输入方式检测
 * - isNative / platform / isAndroid / isIos: 平台检测
 */
import { defineStore } from 'pinia';
import { useBreakpoints, breakpointsTailwind, useMediaQuery } from '@vueuse/core';
import { Capacitor } from '@capacitor/core';

export const useEnvStore = defineStore('env', () => {
	// --- 屏幕断点（Tailwind: sm=640, md=768, lg=1024, xl=1280, 2xl=1536） ---
	const bp = useBreakpoints(breakpointsTailwind);
	const screen = {
		xs: bp.smaller('sm'),
		sm: bp.between('sm', 'md'),
		md: bp.between('md', 'lg'),
		lg: bp.between('lg', 'xl'),
		xl: bp.greaterOrEqual('xl'),
		// 常用快捷
		ltSm: bp.smaller('sm'),
		geSm: bp.greaterOrEqual('sm'),
		ltMd: bp.smaller('md'),
		geMd: bp.greaterOrEqual('md'),
		ltLg: bp.smaller('lg'),
		geLg: bp.greaterOrEqual('lg'),
	};

	// --- 输入方式 ---
	const isTouch = useMediaQuery('(pointer: coarse)');
	const hasTouch = useMediaQuery('(any-pointer: coarse)');
	const canHover = useMediaQuery('(hover: hover)');

	// --- 平台 ---
	const isNative = Capacitor.isNativePlatform();
	const platform = isNative ? Capacitor.getPlatform() : detectWebPlatform();

	const isAndroid = platform === 'android';
	const isIos = platform === 'ios';
	const isWin = platform === 'windows';
	const isMac = platform === 'mac';
	const isLinux = platform === 'linux';

	return {
		screen,
		isTouch,
		hasTouch,
		canHover,
		isNative,
		platform,
		isAndroid,
		isIos,
		isWin,
		isMac,
		isLinux,
	};
});

/**
 * Web 环境下通过 UA 检测操作系统平台
 * @returns {'android'|'ios'|'windows'|'mac'|'linux'|'unknown'}
 */
function detectWebPlatform() {
	if (typeof navigator === 'undefined') return 'unknown';

	// 优先使用 User-Agent Client Hints（Chromium 系）
	const uaData = navigator.userAgentData;
	if (uaData?.platform) {
		const p = uaData.platform.toLowerCase();
		if (p === 'android') return 'android';
		if (p === 'ios') return 'ios';
		if (p === 'windows') return 'windows';
		if (p.includes('mac')) return 'mac';
		if (p.includes('linux')) return 'linux';
	}

	// 回退到 UA 字符串
	const ua = navigator.userAgent || '';
	if (/Android/i.test(ua)) return 'android';
	if (/iPad|iPhone|iPod/.test(ua)
		|| (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
	if (/Windows/i.test(ua)) return 'windows';
	if (/Macintosh|Mac OS/i.test(ua)) return 'mac';
	if (/Linux/i.test(ua)) return 'linux';
	return 'unknown';
}
