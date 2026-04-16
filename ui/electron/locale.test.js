import { describe, test, expect, vi, beforeEach } from 'vitest';

const appMock = vi.hoisted(() => ({
	getLocale: vi.fn(),
}));

vi.mock('electron', () => ({
	app: appMock,
}));

const { isZhLocale, getAppTitle, t } = await import('./locale.js');

describe('locale / isZhLocale', () => {
	beforeEach(() => {
		appMock.getLocale.mockReset();
	});

	test('简体中文识别为 zh', () => {
		appMock.getLocale.mockReturnValue('zh-CN');
		expect(isZhLocale()).toBe(true);
	});

	test('繁体中文识别为 zh', () => {
		appMock.getLocale.mockReturnValue('zh-TW');
		expect(isZhLocale()).toBe(true);
	});

	test('香港中文识别为 zh', () => {
		appMock.getLocale.mockReturnValue('zh-HK');
		expect(isZhLocale()).toBe(true);
	});

	test('纯 zh 识别为 zh', () => {
		appMock.getLocale.mockReturnValue('zh');
		expect(isZhLocale()).toBe(true);
	});

	test('英文不识别为 zh', () => {
		appMock.getLocale.mockReturnValue('en-US');
		expect(isZhLocale()).toBe(false);
	});

	test('日文不识别为 zh（防 startsWith("zh") 误判）', () => {
		appMock.getLocale.mockReturnValue('ja-JP');
		expect(isZhLocale()).toBe(false);
	});

	test('法文不识别为 zh', () => {
		appMock.getLocale.mockReturnValue('fr-FR');
		expect(isZhLocale()).toBe(false);
	});
});

describe('locale / getAppTitle', () => {
	beforeEach(() => {
		appMock.getLocale.mockReset();
	});

	test('中文系统返回 "可虾"', () => {
		appMock.getLocale.mockReturnValue('zh-CN');
		expect(getAppTitle()).toBe('可虾');
	});

	test('英文系统返回 "CoClaw"', () => {
		appMock.getLocale.mockReturnValue('en-US');
		expect(getAppTitle()).toBe('CoClaw');
	});

	test('其它语种也返回 "CoClaw"', () => {
		appMock.getLocale.mockReturnValue('de-DE');
		expect(getAppTitle()).toBe('CoClaw');
	});
});

describe('locale / t', () => {
	beforeEach(() => {
		appMock.getLocale.mockReset();
	});

	test('中文系统返回第 1 个参数', () => {
		appMock.getLocale.mockReturnValue('zh-CN');
		expect(t('你好', 'Hello')).toBe('你好');
	});

	test('英文系统返回第 2 个参数', () => {
		appMock.getLocale.mockReturnValue('en-US');
		expect(t('你好', 'Hello')).toBe('Hello');
	});

	test('未知语种回退英文', () => {
		appMock.getLocale.mockReturnValue('xx-XX');
		expect(t('你好', 'Hello')).toBe('Hello');
	});
});
