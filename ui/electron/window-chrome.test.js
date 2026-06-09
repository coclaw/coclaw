import { describe, test, expect } from 'vitest';
import {
	buildWindowChrome,
	markWindowWco,
	isWindowWcoEnabled,
	TITLEBAR_HEIGHT,
} from './window-chrome.js';

describe('buildWindowChrome — 平台分支', () => {
	test('macOS：custom + titleBarStyle hidden、无 titleBarOverlay', () => {
		const chrome = buildWindowChrome('darwin');
		expect(chrome.custom).toBe(true);
		expect(chrome.titleBarStyle).toBe('hidden');
		expect(chrome.titleBarOverlay).toBeNull();
		expect(chrome.backgroundColor).toBe('#202122');
	});

	test('Windows：custom + hidden + titleBarOverlay(height=38)', () => {
		const chrome = buildWindowChrome('win32');
		expect(chrome.custom).toBe(true);
		expect(chrome.titleBarStyle).toBe('hidden');
		expect(chrome.titleBarOverlay).toMatchObject({ height: TITLEBAR_HEIGHT });
		expect(chrome.titleBarOverlay.height).toBe(38);
		// 颜色含 color/symbolColor（初值暗色，运行时由 web 侧主题刷新）
		expect(typeof chrome.titleBarOverlay.color).toBe('string');
		expect(typeof chrome.titleBarOverlay.symbolColor).toBe('string');
		expect(chrome.backgroundColor).toBe('#202122');
	});

	test('Linux：非 custom、无 hidden、保持原生栏', () => {
		const chrome = buildWindowChrome('linux');
		expect(chrome.custom).toBe(false);
		expect(chrome.titleBarStyle).toBeNull();
		expect(chrome.titleBarOverlay).toBeNull();
		expect(chrome.backgroundColor).toBe('#202122');
	});

	test('未知平台：按 Linux 同款回落原生栏', () => {
		const chrome = buildWindowChrome('freebsd');
		expect(chrome.custom).toBe(false);
		expect(chrome.titleBarStyle).toBeNull();
		expect(chrome.titleBarOverlay).toBeNull();
	});
});

describe('buildWindowChrome — forceNative 应急回退', () => {
	test('forceNative 三平台均回落原生栏（custom:false、无 hidden、无 overlay）', () => {
		for (const plat of ['darwin', 'win32', 'linux']) {
			const chrome = buildWindowChrome(plat, { forceNative: true });
			expect(chrome.custom).toBe(false);
			expect(chrome.titleBarStyle).toBeNull();
			expect(chrome.titleBarOverlay).toBeNull();
			expect(chrome.backgroundColor).toBe('#202122');
		}
	});

	test('forceNative:false 与不传等价', () => {
		expect(buildWindowChrome('win32', { forceNative: false }))
			.toEqual(buildWindowChrome('win32'));
	});
});

describe('WCO 启用标记 — markWindowWco / isWindowWcoEnabled', () => {
	test('未标记的窗口判定为未启用 WCO', () => {
		const win = {};
		expect(isWindowWcoEnabled(win)).toBe(false);
	});

	test('标记后判定为启用，且不影响其它窗口', () => {
		const a = {};
		const b = {};
		markWindowWco(a);
		expect(isWindowWcoEnabled(a)).toBe(true);
		expect(isWindowWcoEnabled(b)).toBe(false);
	});
});
