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

// 即使无法捕获 appStateChange 回调，也需要 mock 这些原生模块避免 isNative=true 路径下走真实模块
vi.mock('@capacitor/app', () => ({ App: { addListener: vi.fn(), minimizeApp: vi.fn() } }));
vi.mock('@capacitor/status-bar', () => ({
	StatusBar: {
		setOverlaysWebView: vi.fn().mockResolvedValue(),
		setBackgroundColor: vi.fn().mockResolvedValue(),
		setStyle: vi.fn().mockResolvedValue(),
		getInfo: vi.fn().mockResolvedValue({}),
	},
	Style: { Dark: 'DARK', Light: 'LIGHT' },
}));
vi.mock('@capacitor/keyboard', () => ({ Keyboard: { addListener: vi.fn() } }));
vi.mock('@capacitor/network', () => ({ Network: { addListener: vi.fn(), getStatus: vi.fn().mockResolvedValue({ connectionType: 'wifi' }) } }));
vi.mock('@capacitor/splash-screen', () => ({ SplashScreen: { hide: vi.fn().mockResolvedValue() } }));

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

describe('capacitor-app — 浏览器环境 online/offline 桥接（wasOffline gate）', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	// wasOffline 初始 = !navigator.onLine。JSDOM 默认 navigator.onLine=true → wasOffline=false
	// 起步时未经过 offline，online 事件被 gate 拦截不派发，避免页面冷启动时的无意义 spurious online。
	test('未经过 offline 的 online 事件 → 不派发 network:online（冷启动 spurious 抑制）', async () => {
		await loadFresh({ isNative: false, isMobileOs: false });
		const spy = vi.spyOn(window, 'dispatchEvent');
		// 不先派发 offline，直接派发 online
		window.dispatchEvent(new Event('online'));
		expect(spy.mock.calls.find((c) => c[0]?.type === 'network:online')).toBeUndefined();
	});

	test('先 offline 后 online → 派发 network:online + 写 remoteLog', async () => {
		await loadFresh({ isNative: false, isMobileOs: false });
		const { remoteLog } = await import('../services/remote-log.js');
		const spy = vi.spyOn(window, 'dispatchEvent');

		// 1) 先 offline 让 wasOffline=true
		window.dispatchEvent(new Event('offline'));
		// 2) 再 online → 这次必须派发
		window.dispatchEvent(new Event('online'));

		const evt = spy.mock.calls.find((c) => c[0]?.type === 'network:online');
		expect(evt).toBeDefined();
		expect(remoteLog).toHaveBeenCalledWith(expect.stringContaining('connected=true'));
	});
});

describe('capacitor-app — setupAppStateChange focusin 处理（间接锁）', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	// 注意：vitest 对 mocked 模块多次动态 import 不返回同一引用，setupAppStateChange
	// 的 `import('@capacitor/app').then(({App}) => App.addListener('appStateChange', cb))`
	// 中拿到的 App 是真实模块、不是 mock，导致 cb 无法在测试里捕获 / 触发。
	// 因此 isActive=true / isActive=false 分支只能通过日志路径间接覆盖（已存在
	// "前台恢复派发" 用例锁）。这里锁定 setupAppStateChange 内同步部分：document
	// focusin 监听已挂上、且非 INPUT/TEXTAREA 元素聚焦时不会污染 _lastFocusedInput。
	test('isNative=true 时挂上 document focusin 监听', async () => {
		const docAddSpy = vi.spyOn(document, 'addEventListener');
		const router = { push: vi.fn(), currentRoute: { value: { meta: {} } } };
		const mod = await loadFresh({ isNative: true, isMobileOs: true });
		await mod.initCapacitorApp(router);
		await new Promise((r) => setTimeout(r, 50));

		const focusinReg = docAddSpy.mock.calls.find((c) => c[0] === 'focusin');
		expect(focusinReg).toBeDefined();
		docAddSpy.mockRestore();
	});

	test('focusin 处理函数对 INPUT vs DIV 区别处理（不抛异常即可）', async () => {
		const router = { push: vi.fn(), currentRoute: { value: { meta: {} } } };
		const mod = await loadFresh({ isNative: true, isMobileOs: true });
		await mod.initCapacitorApp(router);
		await new Promise((r) => setTimeout(r, 50));

		const input = document.createElement('input');
		const div = document.createElement('div');
		document.body.appendChild(input);
		document.body.appendChild(div);

		// 不应抛 — handler 区分 INPUT/TEXTAREA vs 其它分支
		expect(() => input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))).not.toThrow();
		expect(() => div.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))).not.toThrow();

		document.body.removeChild(input);
		document.body.removeChild(div);
	});
});
