// @vitest-environment jsdom
import { describe, test, expect, vi, afterEach } from 'vitest';

import { buildUiStartText } from './env-snapshot.js';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('buildUiStartText', () => {
	test('包含必备字段 uiId / version / platform / theme / tz / ua', () => {
		vi.stubGlobal('__APP_VERSION__', '9.9.9');
		const text = buildUiStartText('TESTID_______________');
		expect(text.startsWith('ui.start ')).toBe(true);
		expect(text).toContain('uiId=TESTID_______________');
		expect(text).toContain('version=9.9.9');
		expect(text).toMatch(/platform=(web|cap-\w+|electron-\w+|electron)/);
		expect(text).toMatch(/theme=(light|dark|no-pref)/);
		expect(text).toMatch(/tz=\S+/);
		expect(text).toMatch(/lang=\S+/);
		expect(text).toMatch(/ua="[^"]+"/);
	});

	test('navigator.deviceMemory / connection 不可读时整字段省略（不写占位）', () => {
		const ndm = Object.getOwnPropertyDescriptor(navigator, 'deviceMemory');
		const nconn = Object.getOwnPropertyDescriptor(navigator, 'connection');
		Object.defineProperty(navigator, 'deviceMemory', { configurable: true, get: () => undefined });
		Object.defineProperty(navigator, 'connection', { configurable: true, get: () => undefined });
		try {
			const text = buildUiStartText('Y_____________________');
			expect(text).not.toMatch(/mem=/);
			expect(text).not.toMatch(/net=/);
		} finally {
			if (ndm) Object.defineProperty(navigator, 'deviceMemory', ndm); else delete navigator.deviceMemory;
			if (nconn) Object.defineProperty(navigator, 'connection', nconn); else delete navigator.connection;
		}
	});

	test('navigator 缺失时不抛 ReferenceError（非浏览器环境兜底）', () => {
		const origNav = globalThis.navigator;
		// @ts-ignore
		delete globalThis.navigator;
		try {
			expect(() => buildUiStartText('NV____________________')).not.toThrow();
			const text = buildUiStartText('NV____________________');
			expect(text).toContain('uiId=NV____________________');
			expect(text).not.toMatch(/ua=/);
			expect(text).not.toMatch(/net=/);
			expect(text).not.toMatch(/touch=/);
			expect(text).not.toMatch(/lang=/);
		} finally {
			globalThis.navigator = origNav;
		}
	});

	test('version 未注入时回退 unknown', () => {
		const orig = globalThis.__APP_VERSION__;
		vi.unstubAllGlobals();
		// @ts-ignore
		globalThis.__APP_VERSION__ = '';
		try {
			const text = buildUiStartText('Z_____________________');
			expect(text).toContain('version=unknown');
		} finally {
			globalThis.__APP_VERSION__ = orig;
		}
	});

	test('detectTheme: dark / light / no-pref / 抛错也降级 no-pref', () => {
		const origMm = window.matchMedia;
		window.matchMedia = (q) => ({ matches: q.includes('dark') });
		expect(buildUiStartText('a_____________________')).toContain('theme=dark');
		window.matchMedia = (q) => ({ matches: q.includes('light') });
		expect(buildUiStartText('a_____________________')).toContain('theme=light');
		window.matchMedia = () => ({ matches: false });
		expect(buildUiStartText('a_____________________')).toContain('theme=no-pref');
		window.matchMedia = () => { throw new Error('not supported'); };
		expect(buildUiStartText('a_____________________')).toContain('theme=no-pref');
		window.matchMedia = origMm;
	});

	test('platform 字段调用 utils/platform.js 的 detectPlatformLabel——cap-android', () => {
		vi.stubGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => 'android' });
		expect(buildUiStartText('p_____________________')).toContain('platform=cap-android');
	});

	test('viewport 字段附加 devicePixelRatio', () => {
		const orig = window.devicePixelRatio;
		Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2.5 });
		try {
			const text = buildUiStartText('v_____________________');
			expect(text).toMatch(/viewport=\d+x\d+@2\.5/);
		} finally {
			Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: orig });
		}
	});

	test('tryDetectTimeZone: Intl.DateTimeFormat 抛错时 tz 字段省略', () => {
		const origIntl = globalThis.Intl;
		// 让 Intl.DateTimeFormat() 抛错——模拟极端环境（如部分嵌入式 webview）
		globalThis.Intl = { DateTimeFormat: () => { throw new Error('Intl unavailable'); } };
		try {
			const text = buildUiStartText('TZ____________________');
			expect(text).not.toMatch(/tz=/);
		} finally {
			globalThis.Intl = origIntl;
		}
	});

	test('mem / net 字段在 navigator.deviceMemory / connection 可读时被填充', () => {
		const ndm = Object.getOwnPropertyDescriptor(navigator, 'deviceMemory');
		const nconn = Object.getOwnPropertyDescriptor(navigator, 'connection');
		Object.defineProperty(navigator, 'deviceMemory', { configurable: true, get: () => 8 });
		Object.defineProperty(navigator, 'connection', { configurable: true, get: () => ({ effectiveType: '4g' }) });
		try {
			const text = buildUiStartText('m_____________________');
			expect(text).toContain('mem=8');
			expect(text).toContain('net=4g');
		} finally {
			if (ndm) Object.defineProperty(navigator, 'deviceMemory', ndm); else delete navigator.deviceMemory;
			if (nconn) Object.defineProperty(navigator, 'connection', nconn); else delete navigator.connection;
		}
	});
});
