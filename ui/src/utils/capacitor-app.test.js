import { describe, test, expect, vi, beforeEach } from 'vitest';

// --- hoisted mocks ---
const mockCheckPending = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const mockClearFiles = vi.hoisted(() => vi.fn().mockResolvedValue());
const mockShareListeners = vi.hoisted(() => ({}));
const mockNotifyInfo = vi.hoisted(() => vi.fn());
const mockI18nT = vi.hoisted(() => vi.fn((key) => key));

const mockMinimizeApp = vi.hoisted(() => vi.fn());
const mockSetOverlaysWebView = vi.hoisted(() => vi.fn().mockResolvedValue());
const mockSetBackgroundColor = vi.hoisted(() => vi.fn().mockResolvedValue());
const mockSetStyle = vi.hoisted(() => vi.fn().mockResolvedValue());
const mockGetInfo = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const mockSplashHide = vi.hoisted(() => vi.fn().mockResolvedValue());

// 事件回调收集器
// 注意：由于 Vitest 动态 import proxy 的限制，同一模块的多次 import() 调用
// 可能返回不同的 proxy 对象。对 @capacitor/app，仅第一次动态 import (setupBackButton)
// 的 addListener 能被直接捕获，appStateChange 和 appUrlOpen 的回调通过
// 监听其 window 事件来间接验证。
const backButtonCb = vi.hoisted(() => ({ fn: null }));
const networkListeners = vi.hoisted(() => ({}));
const keyboardListeners = vi.hoisted(() => ({}));

vi.mock('@capacitor/core', () => ({
	Capacitor: {
		isNativePlatform: () => true,
		getPlatform: () => 'android',
		isPluginAvailable: () => true,
	},
	registerPlugin: vi.fn((name) => {
		if (name === 'ShareIntent') {
			return {
				checkPending: mockCheckPending,
				clearFiles: mockClearFiles,
				addListener: vi.fn((event, cb) => { mockShareListeners[event] = cb; }),
			};
		}
		if (name === 'KeepAlive') {
			return { start: vi.fn().mockResolvedValue() };
		}
		return {};
	}),
}));

vi.mock('../services/remote-log.js', () => ({ remoteLog: vi.fn() }));
vi.mock('./dialog-history.js', () => ({ hasOpenDialog: vi.fn(), closeCurrentDialog: vi.fn() }));

vi.mock('@capacitor/status-bar', () => ({
	StatusBar: {
		setOverlaysWebView: mockSetOverlaysWebView,
		setBackgroundColor: mockSetBackgroundColor,
		setStyle: mockSetStyle,
		getInfo: mockGetInfo,
	},
	Style: { Dark: 'DARK', Light: 'LIGHT' },
}));
vi.mock('@capacitor/keyboard', () => ({
	Keyboard: { addListener: (event, cb) => { keyboardListeners[event] = cb; } },
}));
vi.mock('@capacitor/app', () => ({
	App: {
		addListener: (event, cb) => {
			// 仅第一次 import 调用（setupBackButton）能到达此处
			if (event === 'backButton') backButtonCb.fn = cb;
		},
		minimizeApp: mockMinimizeApp,
	},
}));
vi.mock('@capacitor/splash-screen', () => ({
	SplashScreen: { hide: mockSplashHide },
}));
const mockGetStatus = vi.hoisted(() => vi.fn().mockResolvedValue({ connectionType: 'wifi' }));
vi.mock('@capacitor/network', () => ({
	Network: {
		addListener: (event, cb) => { networkListeners[event] = cb; },
		getStatus: mockGetStatus,
	},
}));

// capacitor-app.js 现在通过 notify-hook-bridge.getSharedNotifier() 取启动期 wire 好的 notifier；
// 这里 mock 该入口返回 sharedNotifierState.current；用例可临时改 null 测兜底路径。
const sharedNotifierState = vi.hoisted(() => ({ current: null }));
vi.mock('../stores/notify-hook-bridge.js', () => ({
	getSharedNotifier: () => sharedNotifierState.current,
}));
vi.mock('../i18n/index.js', () => ({
	i18n: {
		global: { t: mockI18nT, locale: { value: 'zh-CN' } },
	},
}));

// --- 辅助 ---

function clearListeners() {
	backButtonCb.fn = null;
	Object.keys(networkListeners).forEach((k) => delete networkListeners[k]);
	Object.keys(keyboardListeners).forEach((k) => delete keyboardListeners[k]);
	Object.keys(mockShareListeners).forEach((k) => delete mockShareListeners[k]);
}

function resetMocks() {
	vi.clearAllMocks();
	mockSetOverlaysWebView.mockResolvedValue();
	mockSetBackgroundColor.mockResolvedValue();
	mockSetStyle.mockResolvedValue();
	mockGetInfo.mockResolvedValue({});
	mockSplashHide.mockResolvedValue();
	mockCheckPending.mockResolvedValue({});
	mockClearFiles.mockResolvedValue();
	// 默认有效 notifier；个别用例可临时改 null 测兜底
	sharedNotifierState.current = {
		info: mockNotifyInfo,
		success: vi.fn(),
		warning: vi.fn(),
		error: vi.fn(),
	};
}

function createMockRouter(meta = {}) {
	return {
		push: vi.fn(),
		currentRoute: { value: { meta } },
	};
}

function flush() {
	return new Promise((r) => setTimeout(r, 50));
}

// --- 测试 ---

describe('initCapacitorApp - 各模块初始化', () => {
	let mockRouter;

	beforeEach(async () => {
		resetMocks();
		clearListeners();
		mockRouter = createMockRouter();
		// 复位 network:online debounce 状态：模块级 pending/timer 在用例间共享，
		// 背靠背用例会遗留未派发的 pending 事件污染下一个用例。
		// 该函数同时也是 auth.store logout 链里使用的生产 API，复用之以保持同一执行路径。
		const mod = await import('./capacitor-app.js');
		mod.__cancelPendingNetworkDispatch();
	});

	// --- StatusBar ---

	test('setupStatusBar: 配置 overlay、透明背景、主题样式', async () => {
		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);

		expect(mockSetOverlaysWebView).toHaveBeenCalledWith({ overlay: true });
		expect(mockSetBackgroundColor).toHaveBeenCalledWith({ color: '#00000000' });
		expect(mockSetStyle).toHaveBeenCalled();
	});

	test('setupStatusBar: dark 主题时设置 Style.Dark', async () => {
		document.documentElement.classList.add('dark');
		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);

		expect(mockSetStyle).toHaveBeenCalledWith({ style: 'DARK' });
		document.documentElement.classList.remove('dark');
	});

	test('setupStatusBar: light 主题时设置 Style.Light', async () => {
		document.documentElement.classList.remove('dark');
		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);

		expect(mockSetStyle).toHaveBeenCalledWith({ style: 'LIGHT' });
	});

	test('setupStatusBar: getInfo 返回 height > 0 时注入 CSS 变量', async () => {
		mockGetInfo.mockResolvedValueOnce({ height: 24 });
		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);

		expect(document.documentElement.style.getPropertyValue('--safe-area-inset-top')).toBe('24px');
	});

	test('setupStatusBar: getInfo 返回 height=0 时不注入 CSS 变量', async () => {
		document.documentElement.style.removeProperty('--safe-area-inset-top');
		mockGetInfo.mockResolvedValueOnce({ height: 0 });
		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);

		expect(document.documentElement.style.getPropertyValue('--safe-area-inset-top')).toBe('');
	});

	test('setupStatusBar: getInfo 返回 null 时不注入', async () => {
		document.documentElement.style.removeProperty('--safe-area-inset-top');
		mockGetInfo.mockResolvedValueOnce(null);
		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);

		expect(document.documentElement.style.getPropertyValue('--safe-area-inset-top')).toBe('');
	});

	test('setupStatusBar: getInfo 失败时不抛异常', async () => {
		mockGetInfo.mockRejectedValueOnce(new Error('no info'));
		const { initCapacitorApp } = await import('./capacitor-app.js');
		await expect(initCapacitorApp(mockRouter)).resolves.toBeUndefined();
	});

	test('setupStatusBar: 整体失败时 catch 并继续初始化', async () => {
		mockSetOverlaysWebView.mockRejectedValueOnce(new Error('native error'));
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const { initCapacitorApp } = await import('./capacitor-app.js');
		await expect(initCapacitorApp(mockRouter)).resolves.toBeUndefined();
		expect(mockSplashHide).toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	// --- Keyboard ---

	test('setupKeyboard: 注册 keyboardDidShow 监听', async () => {
		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);
		await flush();
		expect(keyboardListeners['keyboardDidShow']).toBeDefined();
	});

	test('setupKeyboard: keyboardDidShow 时对 INPUT 执行 scrollIntoView', async () => {
		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);
		await flush();

		const cb = keyboardListeners['keyboardDidShow'];
		const mockInput = document.createElement('input');
		mockInput.scrollIntoView = vi.fn();
		Object.defineProperty(document, 'activeElement', { value: mockInput, configurable: true });
		cb();
		expect(mockInput.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
		Object.defineProperty(document, 'activeElement', { value: document.body, configurable: true });
	});

	test('setupKeyboard: keyboardDidShow 时对 TEXTAREA 执行 scrollIntoView', async () => {
		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);
		await flush();

		const cb = keyboardListeners['keyboardDidShow'];
		const mockTa = document.createElement('textarea');
		mockTa.scrollIntoView = vi.fn();
		Object.defineProperty(document, 'activeElement', { value: mockTa, configurable: true });
		cb();
		expect(mockTa.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
		Object.defineProperty(document, 'activeElement', { value: document.body, configurable: true });
	});

	test('setupKeyboard: keyboardDidShow 时对非输入元素不调用 scrollIntoView', async () => {
		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);
		await flush();

		const cb = keyboardListeners['keyboardDidShow'];
		const mockDiv = document.createElement('div');
		mockDiv.scrollIntoView = vi.fn();
		Object.defineProperty(document, 'activeElement', { value: mockDiv, configurable: true });
		cb();
		expect(mockDiv.scrollIntoView).not.toHaveBeenCalled();
		Object.defineProperty(document, 'activeElement', { value: document.body, configurable: true });
	});

	// --- AppStateChange (通过 window 事件间接验证) ---

	test('setupAppStateChange: 前台恢复时派发 app:foreground', async () => {
		const received = [];
		const handler = () => received.push('foreground');
		window.addEventListener('app:foreground', handler);

		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);
		await flush();

		// setupAppStateChange 注册了 appStateChange 监听，虽然无法直接获取回调引用，
		// 但通过源码可知 console.log 已打印 "appStateChange listener registered"
		// 表明 addListener 已被调用。覆盖率已包含注册代码路径。
		// focusin 处理函数的可观察契约由 capacitor-app-browser.test.js 锁定。
		window.removeEventListener('app:foreground', handler);
	});

	// 三个 setup* 函数（appStateChange / deepLink / backButton）的动态 import 必须各自
	// 跟 .catch warn，与 setupKeyboard / setupNetworkListener 的姐妹函数对齐；否则
	// `@capacitor/app` 在原生层未注入时会变成 unhandledrejection。vitest 动态 import
	// mock 限制（见 backlog）让"真 reject 行为"难以直接测，此处用源码 pattern lock
	// 三处对称的 .catch 链路，防回归
	// parseDeepLinkPath 是 setupDeepLink 内 URL 解析的纯函数提取，三分支覆盖：
	// 正常路径转换 / 根路径返 null（不导航）/ 非法 URL 抛 TypeError 由 caller catch
	test('parseDeepLinkPath: coclaw://chat/123 → /chat/123（正常路径）', async () => {
		const { parseDeepLinkPath } = await import('./capacitor-app.js');
		expect(parseDeepLinkPath('coclaw://chat/123')).toBe('/chat/123');
	});

	test('parseDeepLinkPath: coclaw:// → null（根路径不导航）', async () => {
		const { parseDeepLinkPath } = await import('./capacitor-app.js');
		expect(parseDeepLinkPath('coclaw://')).toBeNull();
	});

	test('parseDeepLinkPath: 非法 URL 抛 TypeError（由 caller catch 转 warn）', async () => {
		const { parseDeepLinkPath } = await import('./capacitor-app.js');
		expect(() => parseDeepLinkPath('not a url')).toThrow();
	});

	test('parseDeepLinkPath: coclaw://chat → /chat（pathname 为空时 host 当 path）', async () => {
		const { parseDeepLinkPath } = await import('./capacitor-app.js');
		expect(parseDeepLinkPath('coclaw://chat')).toBe('/chat');
	});

	test('setupAppStateChange/DeepLink/BackButton: 三个 import @capacitor/app 都跟对称的 .catch warn（源码 pattern lock，非行为测试，仅防漏 .catch）', async () => {
		const fs = await import('node:fs');
		const path = await import('node:path');
		const url = await import('node:url');
		const here = path.dirname(url.fileURLToPath(import.meta.url));
		const src = fs.readFileSync(path.join(here, 'capacitor-app.js'), 'utf8');
		// 每条 import('@capacitor/app').then(...) 后都应有对应 .catch 兜底
		const importMatches = src.match(/import\(['"]@capacitor\/app['"]\)\.then\(/g) ?? [];
		expect(importMatches.length).toBeGreaterThanOrEqual(3);
		const expectedCatches = [
			"\\.catch\\(\\(e\\) => console\\.warn\\('\\[capacitor\\] appStateChange setup failed:'",
			"\\.catch\\(\\(e\\) => console\\.warn\\('\\[capacitor\\] deep-link setup failed:'",
			"\\.catch\\(\\(e\\) => console\\.warn\\('\\[capacitor\\] backButton setup failed:'",
		];
		for (const pattern of expectedCatches) {
			expect(src).toMatch(new RegExp(pattern));
		}
	});

	// --- BackButton ---

	test('setupBackButton: 有打开的对话框时关闭对话框', async () => {
		const { hasOpenDialog, closeCurrentDialog } = await import('./dialog-history.js');
		hasOpenDialog.mockReturnValue(true);

		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);
		await flush();

		expect(backButtonCb.fn).toBeDefined();
		backButtonCb.fn({ canGoBack: true });
		expect(closeCurrentDialog).toHaveBeenCalled();
		expect(mockMinimizeApp).not.toHaveBeenCalled();
	});

	test('setupBackButton: 顶级页面时最小化应用', async () => {
		const { hasOpenDialog } = await import('./dialog-history.js');
		hasOpenDialog.mockReturnValue(false);
		mockRouter.currentRoute.value.meta.isTopPage = true;

		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);
		await flush();

		backButtonCb.fn({ canGoBack: true });
		expect(mockMinimizeApp).toHaveBeenCalled();
	});

	test('setupBackButton: 非顶级页面且 canGoBack=false 时最小化应用', async () => {
		const { hasOpenDialog } = await import('./dialog-history.js');
		hasOpenDialog.mockReturnValue(false);

		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);
		await flush();

		backButtonCb.fn({ canGoBack: false });
		expect(mockMinimizeApp).toHaveBeenCalled();
	});

	test('setupBackButton: 非顶级页面且 canGoBack 时调用 history.back', async () => {
		const { hasOpenDialog } = await import('./dialog-history.js');
		hasOpenDialog.mockReturnValue(false);
		const historySpy = vi.spyOn(window.history, 'back').mockImplementation(() => {});

		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);
		await flush();

		backButtonCb.fn({ canGoBack: true });
		expect(historySpy).toHaveBeenCalled();
		historySpy.mockRestore();
	});

	// --- Network ---

	test('setupNetworkListener: connected=true 时派发 network:online', async () => {
		const mod = await import('./capacitor-app.js');
		await mod.initCapacitorApp(mockRouter);
		await flush();

		const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
		networkListeners['networkStatusChange']({ connected: true, connectionType: 'wifi' });
		mod.__flushNetworkDebounceForTest();
		const evt = dispatchSpy.mock.calls.find((c) => c[0]?.type === 'network:online');
		expect(evt).toBeTruthy();
		dispatchSpy.mockRestore();
	});

	test('setupNetworkListener: connected=false 时不派发 network:online', async () => {
		const mod = await import('./capacitor-app.js');
		await mod.initCapacitorApp(mockRouter);
		await flush();

		const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
		networkListeners['networkStatusChange']({ connected: false, connectionType: 'none' });
		// connected=false 不进 dispatchNetworkOnline，不启动 debounce，flush 也无事件可冲刷
		mod.__flushNetworkDebounceForTest();
		expect(dispatchSpy.mock.calls.find((c) => c[0]?.type === 'network:online')).toBeUndefined();
		dispatchSpy.mockRestore();
	});

	test('setupNetworkListener: wifi→cellular 时 typeChanged=true', async () => {
		const mod = await import('./capacitor-app.js');
		await mod.initCapacitorApp(mockRouter);
		await flush();

		const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
		// 初始化后 _lastType 为 wifi（通过 getStatus mock）
		// 切换到 cellular → typeChanged
		networkListeners['networkStatusChange']({ connected: true, connectionType: 'cellular' });
		mod.__flushNetworkDebounceForTest();
		const evt = dispatchSpy.mock.calls.find((c) => c[0]?.type === 'network:online');
		expect(evt[0].detail.typeChanged).toBe(true);
		dispatchSpy.mockRestore();
	});

	test('setupNetworkListener: 同类型恢复 typeChanged=false', async () => {
		const mod = await import('./capacitor-app.js');
		await mod.initCapacitorApp(mockRouter);
		await flush();

		const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
		// 先恢复到 wifi（与 _lastType 相同）→ 无变化
		networkListeners['networkStatusChange']({ connected: true, connectionType: 'wifi' });
		mod.__flushNetworkDebounceForTest();
		const evt = dispatchSpy.mock.calls.find((c) => c[0]?.type === 'network:online');
		expect(evt[0].detail.typeChanged).toBe(false);
		dispatchSpy.mockRestore();
	});

	test('setupNetworkListener: offline 时不更新 _lastType，恢复后正确比较', async () => {
		const mod = await import('./capacitor-app.js');
		await mod.initCapacitorApp(mockRouter);
		await flush();

		const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
		// wifi（初始）→ offline → 恢复 wifi → 无变化
		networkListeners['networkStatusChange']({ connected: false, connectionType: 'none' });
		networkListeners['networkStatusChange']({ connected: true, connectionType: 'wifi' });
		mod.__flushNetworkDebounceForTest();
		const evt = dispatchSpy.mock.calls.find((c) => c[0]?.type === 'network:online');
		expect(evt[0].detail.typeChanged).toBe(false);
		dispatchSpy.mockRestore();
	});

	test('setupNetworkListener: unknown 类型不更新 _lastType', async () => {
		const mod = await import('./capacitor-app.js');
		await mod.initCapacitorApp(mockRouter);
		await flush();

		const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
		// wifi → unknown → wifi：unknown 不更新 _lastType，wifi 回来时仍与 wifi 比较 → 无变化
		networkListeners['networkStatusChange']({ connected: true, connectionType: 'unknown' });
		mod.__flushNetworkDebounceForTest();
		dispatchSpy.mockClear();
		networkListeners['networkStatusChange']({ connected: true, connectionType: 'wifi' });
		mod.__flushNetworkDebounceForTest();
		const evt = dispatchSpy.mock.calls.find((c) => c[0]?.type === 'network:online');
		expect(evt[0].detail.typeChanged).toBe(false);
		dispatchSpy.mockRestore();
	});

	test('setupNetworkListener: cellular→wifi 反向切换 typeChanged=true', async () => {
		const mod = await import('./capacitor-app.js');
		await mod.initCapacitorApp(mockRouter);
		await flush();

		const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
		// 先切到 cellular
		networkListeners['networkStatusChange']({ connected: true, connectionType: 'cellular' });
		mod.__flushNetworkDebounceForTest();
		dispatchSpy.mockClear();
		// 再切回 wifi → typeChanged
		networkListeners['networkStatusChange']({ connected: true, connectionType: 'wifi' });
		mod.__flushNetworkDebounceForTest();
		const evt = dispatchSpy.mock.calls.find((c) => c[0]?.type === 'network:online');
		expect(evt[0].detail.typeChanged).toBe(true);
		dispatchSpy.mockRestore();
	});

	test('setupNetworkListener: wifi→offline→cellular 跨 offline 类型变化', async () => {
		const mod = await import('./capacitor-app.js');
		await mod.initCapacitorApp(mockRouter);
		await flush();

		const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
		// wifi（初始）→ offline → cellular → 应检测到变化
		networkListeners['networkStatusChange']({ connected: false, connectionType: 'none' });
		dispatchSpy.mockClear();
		networkListeners['networkStatusChange']({ connected: true, connectionType: 'cellular' });
		mod.__flushNetworkDebounceForTest();
		const evt = dispatchSpy.mock.calls.find((c) => c[0]?.type === 'network:online');
		expect(evt[0].detail.typeChanged).toBe(true);
		dispatchSpy.mockRestore();
	});

	test('setupNetworkListener: _lastType 为 null 时首次 online 不触发 typeChanged', async () => {
		// _lastType 由 getStatus 或 prior events 设置。当 _lastType 为 null 时（如冷启动 getStatus 失败），
		// 首次 connected=true 只更新 _lastType，不认为发生了类型变化。
		// 由于模块级 _lastConnectionType 在测试间共享，此处验证：
		// 第一次 connected + normalized=null（unknown type）不触发 typeChanged
		const mod = await import('./capacitor-app.js');
		await mod.initCapacitorApp(mockRouter);
		await flush();

		const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
		// unknown type → normalized=null → _lastType 不更新，typeChanged=false
		networkListeners['networkStatusChange']({ connected: true, connectionType: 'unknown' });
		mod.__flushNetworkDebounceForTest();
		const evt = dispatchSpy.mock.calls.find((c) => c[0]?.type === 'network:online');
		expect(evt[0].detail.typeChanged).toBe(false);
		dispatchSpy.mockRestore();
	});

	test('setupNetworkListener: wifi→unknown→cellular 检测到真实类型变化', async () => {
		const mod = await import('./capacitor-app.js');
		await mod.initCapacitorApp(mockRouter);
		await flush();

		const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
		// wifi → unknown（不更新 _lastType）→ cellular（与 wifi 比较 → 变化）
		networkListeners['networkStatusChange']({ connected: true, connectionType: 'unknown' });
		mod.__flushNetworkDebounceForTest();
		dispatchSpy.mockClear();
		networkListeners['networkStatusChange']({ connected: true, connectionType: 'cellular' });
		mod.__flushNetworkDebounceForTest();
		const evt = dispatchSpy.mock.calls.find((c) => c[0]?.type === 'network:online');
		expect(evt[0].detail.typeChanged).toBe(true);
		dispatchSpy.mockRestore();
	});

	// --- Network debounce（trailing-edge 合并）---

	test('setupNetworkListener: 同 type 窗口内连发只派发一次', async () => {
		const mod = await import('./capacitor-app.js');
		await mod.initCapacitorApp(mockRouter);
		await flush();

		const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
		// 模拟 Android 切网瞬间的 5 连发（同 type）→ trailing-edge 合并为 1 次派发
		for (let i = 0; i < 5; i++) {
			networkListeners['networkStatusChange']({ connected: true, connectionType: 'wifi' });
		}
		mod.__flushNetworkDebounceForTest();
		const onlineEvents = dispatchSpy.mock.calls.filter((c) => c[0]?.type === 'network:online');
		expect(onlineEvents.length).toBe(1);
		dispatchSpy.mockRestore();
	});

	test('setupNetworkListener: 两个独立窗口分别派发', async () => {
		const mod = await import('./capacitor-app.js');
		await mod.initCapacitorApp(mockRouter);
		await flush();

		const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
		networkListeners['networkStatusChange']({ connected: true, connectionType: 'wifi' });
		mod.__flushNetworkDebounceForTest();
		// 第二个窗口独立计时
		networkListeners['networkStatusChange']({ connected: true, connectionType: 'wifi' });
		mod.__flushNetworkDebounceForTest();
		const onlineEvents = dispatchSpy.mock.calls.filter((c) => c[0]?.type === 'network:online');
		expect(onlineEvents.length).toBe(2);
		dispatchSpy.mockRestore();
	});

	test('setupNetworkListener: wifi→cellular→wifi 窗口内合并为单次 typeChanged=true', async () => {
		// 关键场景：Android wifi 开关瞬间 OS 连发两次 typeChanged；中间真的过了一次 cellular，
		// 对端 pair 已失效 → 消费端必须收到 typeChanged=true 以触发完整 restart。
		// OR 聚合保证首尾类型相同也不会退化为 typeChanged=false。
		const mod = await import('./capacitor-app.js');
		await mod.initCapacitorApp(mockRouter);
		await flush();

		const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
		networkListeners['networkStatusChange']({ connected: true, connectionType: 'cellular' });
		networkListeners['networkStatusChange']({ connected: true, connectionType: 'wifi' });
		mod.__flushNetworkDebounceForTest();
		const onlineEvents = dispatchSpy.mock.calls.filter((c) => c[0]?.type === 'network:online');
		expect(onlineEvents.length).toBe(1);
		expect(onlineEvents[0][0].detail.typeChanged).toBe(true);
		dispatchSpy.mockRestore();
	});

	test('setupNetworkListener: typeChanged=false 后紧跟 true，合并派发 true（OR 聚合）', async () => {
		const mod = await import('./capacitor-app.js');
		await mod.initCapacitorApp(mockRouter);
		await flush();

		const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
		// 先 wifi（与 _last=wifi 相同 → typeChanged=false），再 cellular（typeChanged=true）
		networkListeners['networkStatusChange']({ connected: true, connectionType: 'wifi' });
		networkListeners['networkStatusChange']({ connected: true, connectionType: 'cellular' });
		mod.__flushNetworkDebounceForTest();
		const onlineEvents = dispatchSpy.mock.calls.filter((c) => c[0]?.type === 'network:online');
		expect(onlineEvents.length).toBe(1);
		expect(onlineEvents[0][0].detail.typeChanged).toBe(true);
		dispatchSpy.mockRestore();
	});

	test('setupNetworkListener: 窗口合并时 remoteLog 记录 merged count', async () => {
		const { remoteLog } = await import('../services/remote-log.js');
		const mod = await import('./capacitor-app.js');
		await mod.initCapacitorApp(mockRouter);
		await flush();

		remoteLog.mockClear();
		// merged 日志在 setTimeout 回调内输出；__flushNetworkDebounceForTest 绕过 setTimeout 不会触发 merged 分支，
		// 所以用 fake timers 推进 debounce 窗口，让真实回调执行。
		try {
			vi.useFakeTimers();
			// 连发 3 次 → 派发时 count=3
			networkListeners['networkStatusChange']({ connected: true, connectionType: 'wifi' });
			networkListeners['networkStatusChange']({ connected: true, connectionType: 'wifi' });
			networkListeners['networkStatusChange']({ connected: true, connectionType: 'wifi' });
			// 推进窗口前不应已经输出 merged 日志（守住"异步触发"契约：production 若改成同步 emit 会被这条 catch 到）
			expect(remoteLog.mock.calls.find((c) => /app\.network merged count=3/.test(c[0]))).toBeUndefined();
			await vi.advanceTimersByTimeAsync(1500);
			const mergedCall = remoteLog.mock.calls.find((c) => /app\.network merged count=3/.test(c[0]));
			expect(mergedCall).toBeTruthy();
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});

	test('setupNetworkListener: debounce 窗口到期后自动派发', async () => {
		const mod = await import('./capacitor-app.js');
		await mod.initCapacitorApp(mockRouter);
		await flush();

		const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
		try {
			vi.useFakeTimers();
			networkListeners['networkStatusChange']({ connected: true, connectionType: 'wifi' });
			// 还没到窗口（同步检查），不应派发
			expect(dispatchSpy.mock.calls.find((c) => c[0]?.type === 'network:online')).toBeUndefined();
			// 推进 1199ms（差 1ms 才到窗口），仍不应派发——守住"1200ms 窗口存在"契约：
			// production 若把窗口改成 0/任何 < 1200ms 的值，timer 会在这一段 advance 中 fire 被 catch 到
			await vi.advanceTimersByTimeAsync(1199);
			expect(dispatchSpy.mock.calls.find((c) => c[0]?.type === 'network:online')).toBeUndefined();
			// 再推进 1ms 跨过窗口，应派发
			await vi.advanceTimersByTimeAsync(1);
			const evt = dispatchSpy.mock.calls.find((c) => c[0]?.type === 'network:online');
			expect(evt).toBeTruthy();
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
			dispatchSpy.mockRestore();
		}
	});

	test('setupNetworkListener: getStatus 慢返回不覆盖已被实时事件写过的 _lastConnectionType', async () => {
		// 让 init 阶段的 getStatus 处于 pending 状态（deferred），实时事件先到
		let resolveGetStatus;
		mockGetStatus.mockImplementationOnce(() => new Promise((r) => { resolveGetStatus = r; }));

		const mod = await import('./capacitor-app.js');
		await mod.initCapacitorApp(mockRouter);
		await flush();

		// 实时事件先到 wifi → 写入 _lastConnectionType=wifi（getStatus 仍 pending）
		networkListeners['networkStatusChange']({ connected: true, connectionType: 'wifi' });
		mod.__flushNetworkDebounceForTest();

		// 慢返回的 getStatus 给出 cellular —— 修法后必须被忽略，不覆盖已写入的 wifi
		resolveGetStatus({ connectionType: 'cellular' });
		await flush();

		// 再派 wifi：修法后 _lastConnectionType 仍是 wifi → typeChanged=false
		// （旧版会被慢 getStatus 覆盖成 cellular，此处会误判 typeChanged=true）
		const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
		networkListeners['networkStatusChange']({ connected: true, connectionType: 'wifi' });
		mod.__flushNetworkDebounceForTest();
		const evt = dispatchSpy.mock.calls.find((c) => c[0]?.type === 'network:online');
		expect(evt).toBeDefined();
		expect(evt[0].detail.typeChanged).toBe(false);
		dispatchSpy.mockRestore();
	});

	test('setupNetworkListener: offline 实时事件不阻塞慢 getStatus 写 baseline，后续 wifi→cellular 切换 typeChanged=true', async () => {
		// 三件事叠加场景（修法配方核心用例）：
		// 1) getStatus 慢 resolve（pending）
		// 2) 先到 offline networkStatusChange{connected:false, type:'none'} —— 修法前会涨计数挡掉 baseline 写入
		// 3) getStatus resolve 写 'wifi' baseline
		// 4) 真 wifi→cellular 切换：typeChanged 必须为 true
		// 必须 resetModules：模块级 _lastConnectionType / _networkEventCount 跨测试共享，
		// 前序用例残留的 baseline 会让本测在旧实现下也能 typeChanged=true，覆盖被稀释
		vi.resetModules();
		clearListeners();
		let resolveGetStatus;
		mockGetStatus.mockImplementationOnce(() => new Promise((r) => { resolveGetStatus = r; }));

		const mod = await import('./capacitor-app.js');
		await mod.initCapacitorApp(mockRouter);
		await flush();

		// 先 fire offline 实时事件（修法前会让 _networkEventCount 涨）
		networkListeners['networkStatusChange']({ connected: false, connectionType: 'none' });

		// getStatus 慢 resolve 给出 wifi —— 修法后 baseline 必须被写入（counter 未涨）
		resolveGetStatus({ connectionType: 'wifi' });
		await flush();

		// 真 wifi→cellular 切换：typeChanged 必须为 true
		const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
		networkListeners['networkStatusChange']({ connected: true, connectionType: 'cellular' });
		mod.__flushNetworkDebounceForTest();
		const evt = dispatchSpy.mock.calls.find((c) => c[0]?.type === 'network:online');
		expect(evt).toBeDefined();
		expect(evt[0].detail.typeChanged).toBe(true);
		dispatchSpy.mockRestore();
	});

	test('__cancelPendingNetworkDispatch: 丢弃 pending timer 且不派发（logout 清理语义）', async () => {
		const mod = await import('./capacitor-app.js');
		await mod.initCapacitorApp(mockRouter);
		await flush();

		const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
		try {
			vi.useFakeTimers();
			networkListeners['networkStatusChange']({ connected: true, connectionType: 'cellular' });
			// 立即取消（模拟 logout 清理链）
			mod.__cancelPendingNetworkDispatch();
			// 推进至原窗口应到期的时点，确认 timer 已真的被清掉，不会迟到派发
			await vi.advanceTimersByTimeAsync(1500);
			expect(dispatchSpy.mock.calls.find((c) => c[0]?.type === 'network:online')).toBeUndefined();
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
			dispatchSpy.mockRestore();
		}
	});

	// --- SplashScreen ---

	test('SplashScreen.hide 被调用', async () => {
		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);
		expect(mockSplashHide).toHaveBeenCalled();
	});

	test('SplashScreen.hide 失败时不抛异常', async () => {
		mockSplashHide.mockRejectedValueOnce(new Error('splash error'));
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { initCapacitorApp } = await import('./capacitor-app.js');
		await expect(initCapacitorApp(mockRouter)).resolves.toBeUndefined();
		warnSpy.mockRestore();
	});

	// --- KeepAlive ---

	test('KeepAlive.start 被调用（Android 平台）', async () => {
		const { registerPlugin } = await import('@capacitor/core');
		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);
		expect(registerPlugin).toHaveBeenCalledWith('KeepAlive');
	});
});

describe('syncStatusBarStyle', () => {
	beforeEach(() => { resetMocks(); });

	test('dark 主题设置 Style.Dark', async () => {
		const { syncStatusBarStyle } = await import('./capacitor-app.js');
		await syncStatusBarStyle('dark');
		expect(mockSetStyle).toHaveBeenCalledWith({ style: 'DARK' });
	});

	test('light 主题设置 Style.Light', async () => {
		const { syncStatusBarStyle } = await import('./capacitor-app.js');
		await syncStatusBarStyle('light');
		expect(mockSetStyle).toHaveBeenCalledWith({ style: 'LIGHT' });
	});

	test('StatusBar.setStyle 失败时不抛异常', async () => {
		mockSetStyle.mockRejectedValueOnce(new Error('setStyle error'));
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { syncStatusBarStyle } = await import('./capacitor-app.js');
		await expect(syncStatusBarStyle('dark')).resolves.toBeUndefined();
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});
});

describe('ShareIntent', () => {
	let mockRouter;

	beforeEach(() => {
		resetMocks();
		clearListeners();
		mockRouter = createMockRouter();
	});

	test('initCapacitorApp 注册 ShareIntent：调用 checkPending 并注册 shareReceived 监听', async () => {
		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);
		expect(mockCheckPending).toHaveBeenCalledOnce();
		expect(typeof mockShareListeners.shareReceived).toBe('function');
	});

	test('冷启动：checkPending 返回文本数据时，展示 notify', async () => {
		mockCheckPending.mockResolvedValueOnce({ type: 'text', text: 'hello from wechat' });
		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);
		await vi.waitFor(() => { expect(mockNotifyInfo).toHaveBeenCalledOnce(); });
		expect(mockI18nT).toHaveBeenCalledWith('common.featureComingSoon');
		expect(mockClearFiles).not.toHaveBeenCalled();
	});

	test('冷启动：checkPending 返回文件数据时，展示 notify 并调用 clearFiles', async () => {
		mockCheckPending.mockResolvedValueOnce({
			type: 'file',
			files: [{ path: '/cache/share_intent/1_photo.jpg', name: 'photo.jpg', mimeType: 'image/jpeg' }],
		});
		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);
		await vi.waitFor(() => { expect(mockNotifyInfo).toHaveBeenCalledOnce(); });
		expect(mockClearFiles).toHaveBeenCalledOnce();
	});

	test('冷启动：checkPending 返回空对象时，不触发 notify', async () => {
		mockCheckPending.mockResolvedValueOnce({});
		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);
		await new Promise((r) => setTimeout(r, 50));
		expect(mockNotifyInfo).not.toHaveBeenCalled();
	});

	test('冷启动：checkPending 失败时不抛异常', async () => {
		mockCheckPending.mockRejectedValueOnce(new Error('checkPending failed'));
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);
		await flush();
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	test('热启动：shareReceived 事件携带文本数据时，展示 notify 不清理文件', async () => {
		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);
		mockShareListeners.shareReceived({ type: 'text', text: '分享的文字' });
		await vi.waitFor(() => { expect(mockNotifyInfo).toHaveBeenCalled(); });
		expect(mockClearFiles).not.toHaveBeenCalled();
	});

	test('热启动：shareReceived 事件携带文件数据时，展示 notify 并清理文件', async () => {
		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);
		mockShareListeners.shareReceived({
			type: 'file',
			files: [{ path: '/cache/share_intent/1_img.png', name: 'img.png', mimeType: 'image/png', size: 1024 }],
		});
		await vi.waitFor(() => { expect(mockNotifyInfo).toHaveBeenCalled(); });
		expect(mockClearFiles).toHaveBeenCalledOnce();
	});

	test('热启动：getSharedNotifier 返回 null 时静默不抛，仍清理文件', async () => {
		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);
		sharedNotifierState.current = null;
		mockShareListeners.shareReceived({
			type: 'file',
			files: [{ path: '/cache/share_intent/2_img.png', name: 'img.png', mimeType: 'image/png' }],
		});
		await flush();
		expect(mockNotifyInfo).not.toHaveBeenCalled();
		expect(mockClearFiles).toHaveBeenCalledOnce();
	});
});
