import { describe, expect, test } from 'vitest';

import { detectBrowserLocale, normalizeLocale, normalizeSettingsLocale } from './index.js';

describe('i18n', () => {
	test('normalizeLocale should map zh variants to zh-CN', () => {
		expect(normalizeLocale('zh')).toBe('zh-CN');
		expect(normalizeLocale('zh-Hans')).toBe('zh-CN');
		expect(normalizeLocale('zh-CN')).toBe('zh-CN');
	});

	test('normalizeLocale should fallback to en', () => {
		expect(normalizeLocale('en-US')).toBe('en');
		expect(normalizeLocale('fr')).toBe('en');
		expect(normalizeLocale('')).toBe('en');
		expect(normalizeLocale(null)).toBe('en');
	});

	test('normalizeSettingsLocale should return null when unset', () => {
		expect(normalizeSettingsLocale({ lang: null })).toBeNull();
		expect(normalizeSettingsLocale({})).toBeNull();
	});

	test('normalizeSettingsLocale should keep supported value', () => {
		expect(normalizeSettingsLocale({ lang: 'zh-CN' })).toBe('zh-CN');
		expect(normalizeSettingsLocale({ lang: 'en' })).toBe('en');
	});

	test('detectBrowserLocale should return en in non-browser env', () => {
		expect(detectBrowserLocale()).toBe('en');
	});
});
