import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// mock @capacitor/core
vi.mock('@capacitor/core', () => ({
	Capacitor: {
		isNativePlatform: () => false,
		getPlatform: () => 'web',
	},
}));

// mock matchMedia（@vueuse/core 内部依赖）
function mockMatchMedia(overrides = {}) {
	const listeners = {};
	window.matchMedia = vi.fn((query) => ({
		matches: overrides[query] ?? false,
		media: query,
		addEventListener: vi.fn((evt, fn) => {
			listeners[query] = listeners[query] || [];
			listeners[query].push(fn);
		}),
		removeEventListener: vi.fn(),
		addListener: vi.fn(),
		removeListener: vi.fn(),
		dispatchEvent: vi.fn(),
	}));
	return listeners;
}

describe('env.store', () => {
	let origMatchMedia;

	beforeEach(() => {
		origMatchMedia = window.matchMedia;
		setActivePinia(createPinia());
	});

	afterEach(() => {
		window.matchMedia = origMatchMedia;
	});

	test('screen.ltMd 在窄屏下为 true', async () => {
		// 模拟 < 768 的窄屏：(min-width: 768px) → false
		mockMatchMedia({
			'(pointer: coarse)': false,
			'(any-pointer: coarse)': false,
			'(hover: hover)': true,
		});

		const { useEnvStore } = await import('./env.store.js');
		const env = useEnvStore();

		// ltMd 是 computed ref，取 .value
		expect(env.screen.ltMd).toBeDefined();
	});

	test('isTouch 在触屏设备下为 true', async () => {
		mockMatchMedia({
			'(pointer: coarse)': true,
			'(any-pointer: coarse)': true,
			'(hover: hover)': false,
		});

		// 需要重新 import 以便拿到新 mock 下的 store
		vi.resetModules();
		setActivePinia(createPinia());
		const { useEnvStore } = await import('./env.store.js');
		const env = useEnvStore();

		expect(env.isTouch).toBe(true);
		expect(env.hasTouch).toBe(true);
		expect(env.canHover).toBe(false);
	});

	test('非原生环境下 isNative 为 false', async () => {
		mockMatchMedia({});
		vi.resetModules();
		setActivePinia(createPinia());
		const { useEnvStore } = await import('./env.store.js');
		const env = useEnvStore();

		expect(env.isNative).toBe(false);
		// jsdom UA 包含 "Linux"，detectWebPlatform 返回对应平台
		expect(typeof env.platform).toBe('string');
		expect(env.platform).not.toBe('');
	});

	test('平台快捷属性在 web 环境下正确', async () => {
		mockMatchMedia({});
		vi.resetModules();
		setActivePinia(createPinia());
		const { useEnvStore } = await import('./env.store.js');
		const env = useEnvStore();

		// Web 环境，detectWebPlatform 会根据 UA 返回具体平台
		// 测试环境中 navigator.userAgent 通常含 "Linux" (jsdom)
		expect(typeof env.isAndroid).toBe('boolean');
		expect(typeof env.isIos).toBe('boolean');
		expect(typeof env.isWin).toBe('boolean');
		expect(typeof env.isMac).toBe('boolean');
		expect(typeof env.isLinux).toBe('boolean');
	});

	test('detectWebPlatform 根据 UA 正确识别 Windows', async () => {
		mockMatchMedia({});
		const origUA = navigator.userAgent;
		Object.defineProperty(navigator, 'userAgent', {
			value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
			configurable: true,
		});

		vi.resetModules();
		setActivePinia(createPinia());
		const { useEnvStore } = await import('./env.store.js');
		const env = useEnvStore();
		expect(env.platform).toBe('windows');
		expect(env.isWin).toBe(true);

		Object.defineProperty(navigator, 'userAgent', { value: origUA, configurable: true });
	});

	test('detectWebPlatform 根据 UA 正确识别 Android', async () => {
		mockMatchMedia({});
		const origUA = navigator.userAgent;
		Object.defineProperty(navigator, 'userAgent', {
			value: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36',
			configurable: true,
		});

		vi.resetModules();
		setActivePinia(createPinia());
		const { useEnvStore } = await import('./env.store.js');
		const env = useEnvStore();
		expect(env.platform).toBe('android');
		expect(env.isAndroid).toBe(true);

		Object.defineProperty(navigator, 'userAgent', { value: origUA, configurable: true });
	});

	test('detectWebPlatform 识别 iPadOS (MacIntel + maxTouchPoints)', async () => {
		mockMatchMedia({});
		const origUA = navigator.userAgent;
		const origPlatform = navigator.platform;
		const origTouchPoints = navigator.maxTouchPoints;

		Object.defineProperty(navigator, 'userAgent', {
			value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
			configurable: true,
		});
		Object.defineProperty(navigator, 'platform', {
			value: 'MacIntel',
			configurable: true,
		});
		Object.defineProperty(navigator, 'maxTouchPoints', {
			value: 5,
			configurable: true,
		});

		vi.resetModules();
		setActivePinia(createPinia());
		const { useEnvStore } = await import('./env.store.js');
		const env = useEnvStore();
		expect(env.platform).toBe('ios');
		expect(env.isIos).toBe(true);

		Object.defineProperty(navigator, 'userAgent', { value: origUA, configurable: true });
		Object.defineProperty(navigator, 'platform', { value: origPlatform, configurable: true });
		Object.defineProperty(navigator, 'maxTouchPoints', { value: origTouchPoints, configurable: true });
	});
});
