import { createI18n } from 'vue-i18n';

import { deMessages } from './locales/de.js';
import { enMessages } from './locales/en.js';
import { esMessages } from './locales/es.js';
import { frMessages } from './locales/fr.js';
import { hiMessages } from './locales/hi.js';
import { jaMessages } from './locales/ja.js';
import { koMessages } from './locales/ko.js';
import { ptMessages } from './locales/pt.js';
import { ruMessages } from './locales/ru.js';
import { viMessages } from './locales/vi.js';
import { zhCNMessages } from './locales/zh-CN.js';
import { zhTWMessages } from './locales/zh-TW.js';

const DEFAULT_LOCALE = 'en';
const SUPPORTED_LOCALES = new Set([
	'zh-CN', 'zh-TW', 'en', 'ja', 'ko',
	'fr', 'de', 'es', 'pt', 'ru', 'vi', 'hi',
]);

export function normalizeLocale(input) {
	if (typeof input !== 'string') {
		return DEFAULT_LOCALE;
	}
	const value = input.trim();
	if (!value) {
		return DEFAULT_LOCALE;
	}
	if (SUPPORTED_LOCALES.has(value)) {
		return value;
	}
	// zh-TW, zh-Hant → zh-TW; 其余 zh* → zh-CN
	if (value.startsWith('zh')) {
		if (value === 'zh-TW' || value === 'zh-Hant' || value.startsWith('zh-Hant')) {
			return 'zh-TW';
		}
		return 'zh-CN';
	}
	// 带区域后缀的匹配，如 ja-JP → ja, ko-KR → ko
	const base = value.split('-')[0];
	if (SUPPORTED_LOCALES.has(base)) {
		return base;
	}
	return DEFAULT_LOCALE;
}

export function detectBrowserLocale() {
	if (typeof navigator === 'undefined') {
		return DEFAULT_LOCALE;
	}
	return normalizeLocale(navigator.language || navigator.userLanguage || DEFAULT_LOCALE);
}

// 判断输入是否能匹配到已支持的语言
function isRecognizedLocale(input) {
	if (typeof input !== 'string') return false;
	const value = input.trim();
	if (!value) return false;
	if (SUPPORTED_LOCALES.has(value)) return true;
	if (value.startsWith('zh')) return true;
	const base = value.split('-')[0];
	return SUPPORTED_LOCALES.has(base);
}

export function normalizeSettingsLocale(settings) {
	const value = settings?.lang;
	if (value === null || value === undefined) {
		return null;
	}
	// 不识别的语言回退到 null（auto 模式，使用浏览器语言）
	if (!isRecognizedLocale(String(value))) return null;
	return normalizeLocale(String(value));
}

const i18n = createI18n({
	legacy: false,
	globalInjection: true,
	locale: detectBrowserLocale(),
	fallbackLocale: DEFAULT_LOCALE,
	messages: {
		'zh-CN': zhCNMessages,
		'zh-TW': zhTWMessages,
		en: enMessages,
		ja: jaMessages,
		ko: koMessages,
		fr: frMessages,
		de: deMessages,
		es: esMessages,
		pt: ptMessages,
		ru: ruMessages,
		vi: viMessages,
		hi: hiMessages,
	},
});

export function setLocale(locale) {
	i18n.global.locale.value = normalizeLocale(locale);
}

export { i18n, DEFAULT_LOCALE };
