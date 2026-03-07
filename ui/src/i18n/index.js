import { createI18n } from 'vue-i18n';

import { enMessages } from './locales/en.js';
import { zhCNMessages } from './locales/zh-CN.js';

const DEFAULT_LOCALE = 'en';
const SUPPORTED_LOCALES = new Set(['zh-CN', 'en']);

export function normalizeLocale(input) {
	if (typeof input !== 'string') {
		return DEFAULT_LOCALE;
	}
	const value = input.trim();
	if (!value) {
		return DEFAULT_LOCALE;
	}
	if (value === 'zh-CN' || value === 'en') {
		return value;
	}
	if (value.startsWith('zh')) {
		return 'zh-CN';
	}
	return DEFAULT_LOCALE;
}

export function detectBrowserLocale() {
	if (typeof navigator === 'undefined') {
		return DEFAULT_LOCALE;
	}
	return normalizeLocale(navigator.language || navigator.userLanguage || DEFAULT_LOCALE);
}

export function normalizeSettingsLocale(settings) {
	const value = settings?.lang;
	if (value === null || value === undefined) {
		return null;
	}
	const locale = normalizeLocale(String(value));
	return SUPPORTED_LOCALES.has(locale) ? locale : DEFAULT_LOCALE;
}

const i18n = createI18n({
	legacy: false,
	globalInjection: true,
	locale: detectBrowserLocale(),
	fallbackLocale: DEFAULT_LOCALE,
	messages: {
		'zh-CN': zhCNMessages,
		en: enMessages,
	},
});

export function setLocale(locale) {
	i18n.global.locale.value = normalizeLocale(locale);
}

export { i18n, DEFAULT_LOCALE };
