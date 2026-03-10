import { syncStatusBarStyle } from '../utils/capacitor-app.js';

const THEME_VALUES = new Set(['auto', 'dark', 'light']);

/** dark / light 模式对应的 theme-color（用于 Android 任务切换器等） */
const THEME_COLORS = { dark: '#202122', light: '#ffffff' };

function isBrowser() {
	return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function normalizeTheme(input) {
	if (typeof input !== 'string') {
		return 'dark';
	}
	const theme = input.trim().toLowerCase();
	return THEME_VALUES.has(theme) ? theme : 'dark';
}

function resolveAppliedTheme(theme) {
	if (theme === 'auto') {
		if (!isBrowser() || typeof window.matchMedia !== 'function') {
			return 'light';
		}
		return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
	}
	return theme;
}

/** 更新 <meta name="theme-color"> 值 */
function updateThemeColorMeta(appliedTheme) {
	const color = THEME_COLORS[appliedTheme] ?? THEME_COLORS.dark;
	let meta = document.querySelector('meta[name="theme-color"]');
	if (meta) {
		meta.setAttribute('content', color);
	}
	else {
		meta = document.createElement('meta');
		meta.name = 'theme-color';
		meta.content = color;
		document.head.appendChild(meta);
	}
}

export function applyThemeMode(inputTheme) {
	const theme = normalizeTheme(inputTheme);
	if (!isBrowser()) {
		return theme;
	}

	const appliedTheme = resolveAppliedTheme(theme);
	document.documentElement.classList.toggle('dark', appliedTheme === 'dark');
	document.documentElement.dataset.theme = appliedTheme;

	// 同步原生状态栏样式 + theme-color meta
	syncStatusBarStyle(appliedTheme);
	updateThemeColorMeta(appliedTheme);

	return theme;
}

export function syncThemeModeFromSettings(settings) {
	const theme = normalizeTheme(settings?.theme);
	return applyThemeMode(theme);
}
