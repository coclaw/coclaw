import { describe, expect, test } from 'vitest';

import { detectBrowserLocale, normalizeLocale, normalizeSettingsLocale } from './index.js';

describe('i18n', () => {
	test('normalizeLocale should map zh variants to zh-CN', () => {
		expect(normalizeLocale('zh')).toBe('zh-CN');
		expect(normalizeLocale('zh-Hans')).toBe('zh-CN');
		expect(normalizeLocale('zh-CN')).toBe('zh-CN');
	});

	test('normalizeLocale should map zh-TW / zh-Hant variants to zh-TW', () => {
		expect(normalizeLocale('zh-TW')).toBe('zh-TW');
		expect(normalizeLocale('zh-Hant')).toBe('zh-TW');
		expect(normalizeLocale('zh-Hant-HK')).toBe('zh-TW');
	});

	test('normalizeLocale should return exact match for supported locales', () => {
		expect(normalizeLocale('ja')).toBe('ja');
		expect(normalizeLocale('ko')).toBe('ko');
		expect(normalizeLocale('fr')).toBe('fr');
		expect(normalizeLocale('de')).toBe('de');
		expect(normalizeLocale('es')).toBe('es');
		expect(normalizeLocale('pt')).toBe('pt');
		expect(normalizeLocale('ru')).toBe('ru');
		expect(normalizeLocale('vi')).toBe('vi');
		expect(normalizeLocale('hi')).toBe('hi');
	});

	test('normalizeLocale should strip region suffix to match base locale', () => {
		expect(normalizeLocale('en-US')).toBe('en');
		expect(normalizeLocale('ja-JP')).toBe('ja');
		expect(normalizeLocale('ko-KR')).toBe('ko');
		expect(normalizeLocale('fr-FR')).toBe('fr');
		expect(normalizeLocale('de-DE')).toBe('de');
		expect(normalizeLocale('es-MX')).toBe('es');
		expect(normalizeLocale('pt-BR')).toBe('pt');
		expect(normalizeLocale('ru-RU')).toBe('ru');
		expect(normalizeLocale('vi-VN')).toBe('vi');
		expect(normalizeLocale('hi-IN')).toBe('hi');
	});

	test('normalizeLocale should fallback to en for unsupported locales', () => {
		expect(normalizeLocale('ar')).toBe('en');
		expect(normalizeLocale('th')).toBe('en');
		expect(normalizeLocale('')).toBe('en');
		expect(normalizeLocale(null)).toBe('en');
	});

	test('normalizeSettingsLocale should return null when unset', () => {
		expect(normalizeSettingsLocale({ lang: null })).toBeNull();
		expect(normalizeSettingsLocale({})).toBeNull();
	});

	test('normalizeSettingsLocale should keep supported value', () => {
		expect(normalizeSettingsLocale({ lang: 'zh-CN' })).toBe('zh-CN');
		expect(normalizeSettingsLocale({ lang: 'zh-TW' })).toBe('zh-TW');
		expect(normalizeSettingsLocale({ lang: 'en' })).toBe('en');
		expect(normalizeSettingsLocale({ lang: 'ja' })).toBe('ja');
		expect(normalizeSettingsLocale({ lang: 'ko' })).toBe('ko');
		expect(normalizeSettingsLocale({ lang: 'fr' })).toBe('fr');
	});

	test('detectBrowserLocale should return en in non-browser env', () => {
		expect(detectBrowserLocale()).toBe('en');
	});
});
