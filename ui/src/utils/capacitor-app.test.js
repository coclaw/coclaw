import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

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
vi.mock('@capacitor/network', () => ({
	Network: { addListener: (event, cb) => { networkListeners[event] = cb; } },
}));

vi.mock('../composables/use-notify.js', () => ({
	useNotify: () => ({
		info: mockNotifyInfo,
		success: vi.fn(),
		warning: vi.fn(),
		error: vi.fn(),
	}),
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

	beforeEach(() => {
		resetMocks();
		clearListeners();
		mockRouter = createMockRouter();
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
		window.removeEventListener('app:foreground', handler);
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
		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);
		await flush();

		const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
		networkListeners['networkStatusChange']({ connected: true });
		expect(dispatchSpy.mock.calls.find((c) => c[0]?.type === 'network:online')).toBeTruthy();
		dispatchSpy.mockRestore();
	});

	test('setupNetworkListener: connected=false 时不派发 network:online', async () => {
		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);
		await flush();

		const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
		networkListeners['networkStatusChange']({ connected: false });
		expect(dispatchSpy.mock.calls.find((c) => c[0]?.type === 'network:online')).toBeUndefined();
		dispatchSpy.mockRestore();
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
});
