import { mount, flushPromises } from '@vue/test-utils';
import { vi, test, expect, beforeEach, afterEach } from 'vitest';

const mockGet = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({ default: { get: mockGet } }));

const mockOpen = vi.hoisted(() => vi.fn());
const mockRegisterPlugin = vi.hoisted(() => vi.fn(() => ({ open: mockOpen })));
vi.mock('@capacitor/core', () => ({ registerPlugin: mockRegisterPlugin }));

const mockNotifyError = vi.hoisted(() => vi.fn());
vi.mock('../composables/use-notify.js', () => ({
	useNotify: () => ({
		success: vi.fn(),
		error: mockNotifyError,
		info: vi.fn(),
		warning: vi.fn(),
	}),
}));

// 用可写的 screen 对象替换 env store，便于按用例切换 ltLg（md 及以下 / lg 及以上）
const envState = vi.hoisted(() => ({ screen: { ltLg: false } }));
vi.mock('../stores/env.store.js', () => ({
	useEnvStore: () => envState,
}));

vi.stubGlobal('__APP_VERSION__', '0.0.0-test');

import OpenSourceNoticesPage from './OpenSourceNoticesPage.vue';

function createWrapper() {
	return mount(OpenSourceNoticesPage, {
		global: {
			stubs: {
				MobilePageHeader: { props: ['title', 'fallback'], template: '<div />' },
				UIcon: { props: ['name'], template: '<span />' },
			},
			mocks: {
				$t: (key) => key,
			},
		},
	});
}

/** 模拟 Android 原生壳（Capacitor 全局 + OssLicenses 插件可用性） */
function stubCapacitor({ platform = 'android', pluginAvailable = true } = {}) {
	window.Capacitor = {
		isNativePlatform: () => true,
		getPlatform: () => platform,
		isPluginAvailable: (name) => pluginAvailable && name === 'OssLicenses',
	};
}

beforeEach(() => {
	mockGet.mockResolvedValue({ data: 'NOTICES BODY' });
	envState.screen.ltLg = false;
});

afterEach(() => {
	delete window.Capacitor;
});

test('加载成功渲染声明全文', async () => {
	const wrapper = createWrapper();
	expect(wrapper.find('[data-testid="notices-loading"]').exists()).toBe(true);
	await flushPromises();

	expect(mockGet).toHaveBeenCalledWith('/third-party-notices.txt?v=0.0.0-test', expect.objectContaining({ responseType: 'text' }));
	expect(wrapper.find('[data-testid="notices-content"]').text()).toBe('NOTICES BODY');
	expect(wrapper.find('[data-testid="notices-error"]').exists()).toBe(false);
});

test('加载失败显示内联错误卡，重试后恢复', async () => {
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	mockGet.mockRejectedValueOnce(new Error('network'));
	const wrapper = createWrapper();
	await flushPromises();

	expect(wrapper.find('[data-testid="notices-error"]').exists()).toBe(true);
	expect(wrapper.find('[data-testid="notices-content"]').exists()).toBe(false);

	// 点击重试 → 第二次成功
	await wrapper.find('[data-testid="notices-error"] button').trigger('click');
	await flushPromises();
	expect(wrapper.find('[data-testid="notices-content"]').text()).toBe('NOTICES BODY');
	warnSpy.mockRestore();
});

test('Web 环境不显示 Android 原生许可入口', async () => {
	const wrapper = createWrapper();
	await flushPromises();
	expect(wrapper.find('[data-testid="btn-native-licenses"]').exists()).toBe(false);
	expect(wrapper.find('[data-testid="native-licenses-desc"]').exists()).toBe(false);
});

test('Android 壳但 APK 未带插件（旧版本）不显示入口', async () => {
	stubCapacitor({ pluginAvailable: false });
	const wrapper = createWrapper();
	await flushPromises();
	expect(wrapper.find('[data-testid="btn-native-licenses"]').exists()).toBe(false);
});

test('iOS 壳不显示 Android 原生许可入口', async () => {
	stubCapacitor({ platform: 'ios' });
	const wrapper = createWrapper();
	await flushPromises();
	expect(wrapper.find('[data-testid="btn-native-licenses"]').exists()).toBe(false);
});

test('Android 壳且插件可用时点击打开原生许可界面', async () => {
	stubCapacitor();
	mockOpen.mockResolvedValue(undefined);
	const wrapper = createWrapper();
	await flushPromises();

	const btn = wrapper.find('[data-testid="btn-native-licenses"]');
	expect(btn.exists()).toBe(true);
	// 入口旁展示 oss-licenses 收集口径的诚实说明
	expect(wrapper.find('[data-testid="native-licenses-desc"]').text()).toBe('notices.androidNativeDesc');
	await btn.trigger('click');
	await flushPromises();

	expect(mockRegisterPlugin).toHaveBeenCalledWith('OssLicenses');
	expect(mockOpen).toHaveBeenCalledWith({ title: 'notices.androidNative' });
	expect(mockNotifyError).not.toHaveBeenCalled();
});

test('原生许可界面打开失败时 notify 错误', async () => {
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	stubCapacitor();
	mockOpen.mockRejectedValueOnce(new Error('not implemented'));
	const wrapper = createWrapper();
	await flushPromises();

	await wrapper.find('[data-testid="btn-native-licenses"]').trigger('click');
	await flushPromises();

	expect(mockNotifyError).toHaveBeenCalledWith('notices.nativeOpenFailed');
	warnSpy.mockRestore();
});

test('md 及以下把定宽装饰分隔线截短到 30，正文与非纯分隔行不动', async () => {
	envState.screen.ltLg = true;
	const eq = '='.repeat(80);
	const dash = '-'.repeat(80);
	// 混入普通正文行、80 字符 = / - 分隔线，以及非纯分隔行（===partial）
	const body = `MIT License text\n${eq}\n${dash}\n===partial keep\nnormal line`;
	mockGet.mockResolvedValue({ data: body });
	const wrapper = createWrapper();
	await flushPromises();

	const rendered = wrapper.find('[data-testid="notices-content"]').text();
	// 纯分隔线被收窄到 30（不再是 80）
	expect(rendered).toContain('='.repeat(30));
	expect(rendered).not.toContain('='.repeat(31));
	expect(rendered).toContain('-'.repeat(30));
	expect(rendered).not.toContain('-'.repeat(31));
	// 普通正文与非纯分隔行原样保留
	expect(rendered).toContain('MIT License text');
	expect(rendered).toContain('normal line');
	expect(rendered).toContain('===partial keep');
});

test('lg 及以上保留原始 80 字符分隔线', async () => {
	envState.screen.ltLg = false;
	const eq = '='.repeat(80);
	mockGet.mockResolvedValue({ data: `head\n${eq}\ntail` });
	const wrapper = createWrapper();
	await flushPromises();

	const rendered = wrapper.find('[data-testid="notices-content"]').text();
	expect(rendered).toContain('='.repeat(80));
});
