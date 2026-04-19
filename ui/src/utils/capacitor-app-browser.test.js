/**
 * capacitor-app.js 的浏览器环境桥接测试
 *
 * 独立文件，因为这里的 `@capacitor/core` mock 与主测试文件不同（isNative=false），
 * 且本文件需要通过 hoisted 变量动态切换 isNative / isMobileOs 以覆盖多种环境组合。
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const envRef = vi.hoisted(() => ({ isNative: false, isMobileOs: false }));

vi.mock('@capacitor/core', () => ({
	Capacitor: {
		isNativePlatform: () => envRef.isNative,
		getPlatform: () => (envRef.isNative ? 'android' : 'web'),
		isPluginAvailable: () => true,
	},
	registerPlugin: vi.fn(() => ({})),
}));

vi.mock('./platform.js', () => ({
	get isMobileOs() { return envRef.isMobileOs; },
}));

vi.mock('../services/remote-log.js', () => ({ remoteLog: vi.fn() }));
vi.mock('./dialog-history.js', () => ({ hasOpenDialog: vi.fn(), closeCurrentDialog: vi.fn() }));
vi.mock('../i18n/index.js', () => ({ i18n: { global: { t: (k) => k } } }));
vi.mock('../composables/use-notify.js', () => ({ useNotify: () => ({ info: vi.fn() }) }));

async function loadFresh(env) {
	envRef.isNative = env.isNative;
	envRef.isMobileOs = env.isMobileOs;
	vi.resetModules();
	return import('./capacitor-app.js');
}

// 注意用例顺序：
// vi.resetModules() 不会清理 document 上已注册的 visibilitychange 监听器（jsdom 的 document
// 跨模块重载仍是同一实例）。因此把"不应注册桥接"的用例放在最前，避免被后续用例注册的监听器污染。
describe('capacitor-app — 浏览器环境 visibility 桥接', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	test('桌面浏览器 → 不注册桥接', async () => {
		await loadFresh({ isNative: false, isMobileOs: false });
		const spy = vi.spyOn(window, 'dispatchEvent');
		Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
		document.dispatchEvent(new Event('visibilitychange'));
		expect(spy.mock.calls.find((c) => c[0]?.type === 'app:foreground')).toBeUndefined();
		expect(spy.mock.calls.find((c) => c[0]?.type === 'app:background')).toBeUndefined();
	});

	test('Capacitor 原生 → 不注册浏览器桥接（原生 appStateChange 负责）', async () => {
		await loadFresh({ isNative: true, isMobileOs: true });
		const spy = vi.spyOn(window, 'dispatchEvent');
		Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
		document.dispatchEvent(new Event('visibilitychange'));
		expect(spy.mock.calls.find((c) => c[0]?.type === 'app:foreground')).toBeUndefined();
	});

	test('移动浏览器 + visibilityState=visible → 派发 app:foreground', async () => {
		await loadFresh({ isNative: false, isMobileOs: true });
		const spy = vi.spyOn(window, 'dispatchEvent');
		Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
		document.dispatchEvent(new Event('visibilitychange'));
		const fg = spy.mock.calls.find((c) => c[0]?.type === 'app:foreground');
		expect(fg).toBeDefined();
	});

	test('移动浏览器 + visibilityState=hidden → 派发 app:background', async () => {
		await loadFresh({ isNative: false, isMobileOs: true });
		const spy = vi.spyOn(window, 'dispatchEvent');
		Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
		document.dispatchEvent(new Event('visibilitychange'));
		const bg = spy.mock.calls.find((c) => c[0]?.type === 'app:background');
		expect(bg).toBeDefined();
	});
});
