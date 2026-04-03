import { describe, test, expect, vi, beforeEach } from 'vitest';

// --- hoisted mocks ---
const mockCheckPending = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const mockClearFiles = vi.hoisted(() => vi.fn().mockResolvedValue());
const mockShareListeners = vi.hoisted(() => ({})); // { eventName: callback }
const mockNotifyInfo = vi.hoisted(() => vi.fn());
const mockI18nT = vi.hoisted(() => vi.fn((key) => key));

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

// 静态依赖
vi.mock('../services/remote-log.js', () => ({ remoteLog: vi.fn() }));
vi.mock('./dialog-history.js', () => ({ hasOpenDialog: vi.fn(), closeCurrentDialog: vi.fn() }));

// initCapacitorApp 内部的动态依赖（全部 stub，防止真实 import 失败）
vi.mock('@capacitor/status-bar', () => ({
	StatusBar: {
		setOverlaysWebView: vi.fn().mockResolvedValue(),
		setBackgroundColor: vi.fn().mockResolvedValue(),
		setStyle: vi.fn().mockResolvedValue(),
		getInfo: vi.fn().mockResolvedValue({}),
	},
	Style: { Dark: 'DARK', Light: 'LIGHT' },
}));
vi.mock('@capacitor/keyboard', () => ({
	Keyboard: { addListener: vi.fn() },
}));
vi.mock('@capacitor/app', () => ({
	App: { addListener: vi.fn(), minimizeApp: vi.fn() },
}));
vi.mock('@capacitor/splash-screen', () => ({
	SplashScreen: { hide: vi.fn().mockResolvedValue() },
}));
vi.mock('@capacitor/network', () => ({
	Network: { addListener: vi.fn() },
}));

// handleShareReceived 内部的动态依赖
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

// --- 测试 ---

describe('ShareIntent', () => {
	/** @type {import('vue-router').Router} */
	let mockRouter;

	beforeEach(() => {
		vi.clearAllMocks();
		// 清空监听器缓存
		Object.keys(mockShareListeners).forEach((k) => delete mockShareListeners[k]);

		mockRouter = {
			push: vi.fn(),
			currentRoute: { value: { meta: {} } },
		};
	});

	test('initCapacitorApp 注册 ShareIntent：调用 checkPending 并注册 shareReceived 监听', async () => {
		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);

		expect(mockCheckPending).toHaveBeenCalledOnce();
		expect(mockShareListeners).toHaveProperty('shareReceived');
		expect(typeof mockShareListeners.shareReceived).toBe('function');
	});

	test('冷启动：checkPending 返回文本数据时，展示 notify', async () => {
		mockCheckPending.mockResolvedValueOnce({ type: 'text', text: 'hello from wechat' });

		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);

		// checkPending 是异步的，等待其微任务完成
		await vi.waitFor(() => {
			expect(mockNotifyInfo).toHaveBeenCalledOnce();
		});
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

		await vi.waitFor(() => {
			expect(mockNotifyInfo).toHaveBeenCalledOnce();
		});
		expect(mockClearFiles).toHaveBeenCalledOnce();
	});

	test('冷启动：checkPending 返回空对象时，不触发 notify', async () => {
		mockCheckPending.mockResolvedValueOnce({});

		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);

		// 给足时间让微任务执行
		await new Promise((r) => setTimeout(r, 50));
		expect(mockNotifyInfo).not.toHaveBeenCalled();
	});

	test('热启动：shareReceived 事件携带文本数据时，展示 notify 不清理文件', async () => {
		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);

		// 模拟热启动分享
		mockShareListeners.shareReceived({ type: 'text', text: '分享的文字' });

		await vi.waitFor(() => {
			expect(mockNotifyInfo).toHaveBeenCalled();
		});
		expect(mockClearFiles).not.toHaveBeenCalled();
	});

	test('热启动：shareReceived 事件携带文件数据时，展示 notify 并清理文件', async () => {
		const { initCapacitorApp } = await import('./capacitor-app.js');
		await initCapacitorApp(mockRouter);

		mockShareListeners.shareReceived({
			type: 'file',
			files: [{ path: '/cache/share_intent/1_img.png', name: 'img.png', mimeType: 'image/png', size: 1024 }],
		});

		await vi.waitFor(() => {
			expect(mockNotifyInfo).toHaveBeenCalled();
		});
		expect(mockClearFiles).toHaveBeenCalledOnce();
	});
});
