const THEME_VALUES = new Set(['auto', 'dark', 'light']);

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

export function applyThemeMode(inputTheme) {
	const theme = normalizeTheme(inputTheme);
	if (!isBrowser()) {
		return theme;
	}

	const appliedTheme = resolveAppliedTheme(theme);
	document.documentElement.classList.toggle('dark', appliedTheme === 'dark');
	document.documentElement.dataset.theme = appliedTheme;
	return theme;
}

export function syncThemeModeFromSettings(settings) {
	const theme = normalizeTheme(settings?.theme);
	return applyThemeMode(theme);
}
