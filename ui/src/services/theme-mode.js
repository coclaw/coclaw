import { syncStatusBarStyle } from '../utils/capacitor-app.js';

const THEME_VALUES = new Set(['auto', 'dark', 'light']);

/** dark / light 模式对应的 theme-color（用于 Android 任务切换器等） */
const THEME_COLORS = { dark: '#202122', light: '#ffffff' };

/**
 * Windows 自定义壳标题栏 WCO（窗口控件覆盖层）按钮区配色，按 appliedTheme 静态映射（不读 DOM）。
 * color 是设计常量（见设计稿 §6）：
 * - dark `#1b1b1b` 对应 main.css .dark 的 --ui-bg-elevated；
 * - light `#f1f5f9` 来源于项目未配 neutral → Nuxt UI 默认 slate → --ui-color-neutral-100(slate-100)；
 *   它是无 main.css 锚点的硬编码，Nuxt UI 升级改默认 neutral 或项目将来配置 neutral 时须重新核对。
 * symbolColor（按钮图标色）：dark 近白、light 深色。
 */
const WCO_COLORS = {
	dark: { color: '#1b1b1b', symbolColor: '#e5e5e5' },
	light: { color: '#f1f5f9', symbolColor: '#1e293b' },
};

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

/**
 * 把 WCO 按钮区配色同步到当前主题（仅 Electron 自定义壳 + Windows 生效）。
 * - 必须走 window.electronAPI（裸标识符在浏览器抛 ReferenceError）。
 * - mac 红绿灯系统自适应、无需同步；非 Windows / 非 custom 直接跳过。
 * - best-effort：setTitleBarOverlay 走 invoke、失败会重抛 renderer，必须 .catch 吞掉，绝不影响 .dark/meta 主链。
 * @param {string} appliedTheme - 已解析的实际主题（dark/light）
 */
function syncWindowsTitleBarOverlay(appliedTheme) {
	const api = window.electronAPI;
	// 平台细分沿用现有 electronAPI.platform（process.platform：win32/darwin/linux）
	if (!api?.titleBar?.custom || api.platform !== 'win32') {
		return;
	}
	const overlay = WCO_COLORS[appliedTheme] ?? WCO_COLORS.dark;
	Promise.resolve(api.setTitleBarOverlay?.({ ...overlay, height: 38 })).catch(() => {});
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

	// 同步原生状态栏样式 + theme-color meta + Windows WCO 按钮色
	syncStatusBarStyle(appliedTheme);
	updateThemeColorMeta(appliedTheme);
	syncWindowsTitleBarOverlay(appliedTheme);

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
