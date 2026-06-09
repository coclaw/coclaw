import { mount } from '@vue/test-utils';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// ui.store：组件只调 initResize/destroyResize，用稳定 hoisted mock 便于断言调用
const uiStoreMock = vi.hoisted(() => ({
	initResize: vi.fn(),
	destroyResize: vi.fn(),
}));

// use-notify / notify-hook-bridge / global-error-handler 内部（直接或间接）import @nuxt/ui 的 '#imports'，
// vitest 未装 @nuxt/ui/vite 插件、无法解析，整体 mock 掉
vi.mock('./composables/use-notify.js', () => ({
	useNotify: () => ({
		success: vi.fn(),
		info: vi.fn(),
		warning: vi.fn(),
		error: vi.fn(),
	}),
}));
vi.mock('./utils/global-error-handler.js', () => ({
	setGlobalErrorNotify: vi.fn(),
}));
vi.mock('./stores/notify-hook-bridge.js', () => ({
	wireNotifyHooks: vi.fn(),
}));
vi.mock('./stores/env.store.js', () => ({
	useEnvStore: () => ({ screen: { ltMd: false } }),
}));
vi.mock('./stores/ui.store.js', () => ({
	useUiStore: () => uiStoreMock,
}));

import App from './App.vue';

function mountApp() {
	return mount(App, {
		global: {
			stubs: {
				UApp: { template: '<div><slot /></div>' },
				RouterView: { template: '<div class="rv-stub" />' },
				// 把 ElectronTitleBar 桩成可识别元素，data-fs 回放传入的 isFullScreen prop
				ElectronTitleBar: {
					props: ['isFullScreen'],
					template: '<div class="ettb-stub" :data-fs="String(isFullScreen)" />',
				},
			},
		},
	});
}

const root = () => document.documentElement;
const hasScopeClass = () => root().classList.contains('cc-electron-custom');

// 排干所有微任务（getFullScreen 的 Promise.resolve(p).then 链需多个 tick）：setTimeout(0) 宏任务在微任务全清后才跑
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	root().classList.remove('cc-electron-custom');
	delete window.electronAPI;
});

afterEach(() => {
	delete window.electronAPI;
	root().classList.remove('cc-electron-custom');
});

describe('App.vue 浏览器路径回归（主目标保护）', () => {
	test('electronAPI 未定义：mounted 不抛、不挂 cc-electron-custom 类、不挂出标题栏条、仍跑 initResize', () => {
		let wrapper;
		expect(() => {
			wrapper = mountApp();
		}).not.toThrow();
		expect(hasScopeClass()).toBe(false);
		expect(wrapper.find('.ettb-stub').exists()).toBe(false);
		// resize 初始化不能被 Electron 收口跳过
		expect(uiStoreMock.initResize).toHaveBeenCalledTimes(1);
	});

	test('DOM 回归：router-view 外层是纯空壳 cc-app-content（仅此一个类、无 flex/grid/height 等布局类）', () => {
		const wrapper = mountApp();
		const content = wrapper.find('.cc-app-content');
		expect(content.exists()).toBe(true);
		expect(content.classes()).toEqual(['cc-app-content']);
		// 包裹的 router-view 仍在内
		expect(content.find('.rv-stub').exists()).toBe(true);
	});
});

describe('App.vue 自定义壳挂载时序（§5.2）', () => {
	/** 造一个自定义壳 electronAPI；getFullScreen 默认永不 resolve（隔离 getter 影响） */
	function stubCustomShell({ onFullScreenChange, getFullScreen, platform } = {}) {
		window.electronAPI = {
			platform: platform ?? 'darwin',
			titleBar: { custom: true },
			onFullScreenChange: onFullScreenChange ?? vi.fn(() => () => {}),
			getFullScreen: getFullScreen ?? vi.fn(() => new Promise(() => {})),
		};
		return window.electronAPI;
	}

	test('M-1 首帧同步：getFullScreen 未决时，mounted 返回即已同步挂上 cc-electron-custom 类', () => {
		const onFullScreenChange = vi.fn(() => () => {});
		stubCustomShell({ onFullScreenChange, getFullScreen: vi.fn(() => new Promise(() => {})) });
		mountApp();
		// 不依赖 getFullScreen resolve——同步段已挂类
		expect(hasScopeClass()).toBe(true);
		// 订阅已发生
		expect(onFullScreenChange).toHaveBeenCalledTimes(1);
	});

	test('订阅 onFullScreenChange 必须早于 getFullScreen 调用', () => {
		const order = [];
		const onFullScreenChange = vi.fn(() => { order.push('subscribe'); return () => {}; });
		const getFullScreen = vi.fn(() => { order.push('getter'); return new Promise(() => {}); });
		stubCustomShell({ onFullScreenChange, getFullScreen });
		mountApp();
		expect(order).toEqual(['subscribe', 'getter']);
	});

	test('父级 v-if="custom"：custom 下挂出标题栏条、isFullScreen=false prop 透传', async () => {
		stubCustomShell();
		const wrapper = mountApp();
		await wrapper.vm.$nextTick();
		const bar = wrapper.find('.ettb-stub');
		expect(bar.exists()).toBe(true);
		expect(bar.attributes('data-fs')).toBe('false');
	});

	test('全屏事件：enter 摘类（条收 isFullScreen=true），leave 复原', async () => {
		let cb;
		const onFullScreenChange = vi.fn((fn) => { cb = fn; return () => {}; });
		stubCustomShell({ onFullScreenChange });
		const w = mountApp();
		expect(hasScopeClass()).toBe(true);
		await w.vm.$nextTick();
		expect(w.find('.ettb-stub').attributes('data-fs')).toBe('false');

		// 进入全屏 → 摘类、prop 翻 true
		cb(true);
		await w.vm.$nextTick();
		expect(hasScopeClass()).toBe(false);
		expect(w.find('.ettb-stub').attributes('data-fs')).toBe('true');

		// 离开全屏 → 复原
		cb(false);
		await w.vm.$nextTick();
		expect(hasScopeClass()).toBe(true);
		expect(w.find('.ettb-stub').attributes('data-fs')).toBe('false');
	});

	test('maximize（非原生全屏，不发 fullscreen 事件）：getFullScreen(false) 后类仍保留', async () => {
		const getFullScreen = vi.fn(() => Promise.resolve(false));
		stubCustomShell({ getFullScreen });
		const w = mountApp();
		await flush();
		await w.vm.$nextTick();
		expect(hasScopeClass()).toBe(true);
	});

	test('冷启即全屏：无实时事件时 getFullScreen(true) 纠正为全屏并摘类', async () => {
		const getFullScreen = vi.fn(() => Promise.resolve(true));
		stubCustomShell({ getFullScreen });
		const w = mountApp();
		// 首帧同步先挂类
		expect(hasScopeClass()).toBe(true);
		await flush();
		await w.vm.$nextTick();
		expect(hasScopeClass()).toBe(false);
		expect(w.vm.isFullScreen).toBe(true);
	});

	test('primed 防陈旧覆盖：实时事件后迟到的 getFullScreen 回填不覆盖新值', async () => {
		let cb;
		let resolveGetter;
		const onFullScreenChange = vi.fn((fn) => { cb = fn; return () => {}; });
		const getFullScreen = vi.fn(() => new Promise((res) => { resolveGetter = res; }));
		stubCustomShell({ onFullScreenChange, getFullScreen });
		const w = mountApp();

		// 实时事件先到：进入全屏 → primed 置位、摘类
		cb(true);
		await w.vm.$nextTick();
		expect(hasScopeClass()).toBe(false);
		expect(w.vm.isFullScreen).toBe(true);

		// getter 迟到 resolve(false)（陈旧）——primed 已置位，必须被忽略
		resolveGetter(false);
		await flush();
		await w.vm.$nextTick();
		expect(w.vm.isFullScreen).toBe(true);
		expect(hasScopeClass()).toBe(false);
	});

	test('getFullScreen reject：不抛、不影响已挂的类', async () => {
		const getFullScreen = vi.fn(() => Promise.reject(new Error('ipc failed')));
		stubCustomShell({ getFullScreen });
		let w;
		expect(() => { w = mountApp(); }).not.toThrow();
		expect(hasScopeClass()).toBe(true);
		await flush();
		await w.vm.$nextTick();
		// reject 被 .catch 吞掉，类不受影响
		expect(hasScopeClass()).toBe(true);
	});

	test('beforeUnmount：调 destroyResize、退订 onFullScreenChange、摘掉根类', () => {
		const unsub = vi.fn();
		const onFullScreenChange = vi.fn(() => unsub);
		stubCustomShell({ onFullScreenChange });
		const w = mountApp();
		expect(hasScopeClass()).toBe(true);
		w.unmount();
		expect(uiStoreMock.destroyResize).toHaveBeenCalledTimes(1);
		expect(unsub).toHaveBeenCalledTimes(1);
		expect(hasScopeClass()).toBe(false);
	});
});
