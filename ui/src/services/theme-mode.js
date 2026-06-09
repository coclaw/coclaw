import { syncStatusBarStyle } from '../utils/capacitor-app.js';

const THEME_VALUES = new Set(['auto', 'dark', 'light']);

/** dark / light 模式对应的 theme-color（用于 Android 任务切换器等） */
const THEME_COLORS = { dark: '#202122', light: '#ffffff' };

/** 当前生效的主题 mode（auto/dark/light），由 applyThemeMode 写入；watcher 据此判断是否需跟随系统重跑 */
let activeMode = 'dark';
/** initThemeModeWatcher 幂等守卫，防止重复注册监听 + 兜住 Vite HMR 重跑模块级代码 */
let initialized = false;

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
	activeMode = theme;
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

/**
 * 注册系统明暗变化监听：auto 模式下系统运行中翻明暗时，重跑 applyThemeMode('auto')
 * 让 .dark class / theme-color meta / 原生状态栏样式实时跟手。
 * 必须在开机一次的入口（main.js）调用，切勿挂在 applyThemeMode/applyUserPreferences 链上（会泄漏监听）。
 * 幂等：重复调用 no-op（同时兜住 Vite HMR 重跑模块级代码）。
 */
export function initThemeModeWatcher() {
	if (initialized) {
		return;
	}
	if (!isBrowser() || typeof window.matchMedia !== 'function') {
		return;
	}
	initialized = true;
	const mql = window.matchMedia('(prefers-color-scheme: dark)');
	mql.addEventListener('change', () => {
		if (activeMode === 'auto') {
			applyThemeMode('auto');
		}
	});
}
