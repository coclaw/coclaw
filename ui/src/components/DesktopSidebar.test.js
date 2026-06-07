import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// platform.js 的 isElectronApp 是 import 时捕获的 module const；用可变 hoisted 对象 + getter 按用例切换。
// 仅覆盖 isElectronApp，其余导出保留真值（capacitor-app 等同图模块还会用 isMobileOs）
const platformMock = vi.hoisted(() => ({
	isElectronApp: false,
}));
vi.mock('../utils/platform.js', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		get isElectronApp() {
			return platformMock.isElectronApp;
		},
	};
});

// env store：组件只读 isWin/isMac，用普通对象 mock，按用例设值
const defaultEnv = {
	isWin: false,
	isMac: false,
};
let mockEnv = { ...defaultEnv };
vi.mock('../stores/env.store.js', () => ({
	useEnvStore: () => mockEnv,
}));

// MainList 子树会经 store/子组件间接 import @nuxt/ui（#imports 测试环境不可解析），整体 mock 掉模块
vi.mock('./MainList.vue', () => ({
	default: { name: 'MainList', template: '<div class="mainlist-stub" />' },
}));

// 对话框 composable 内部 import @nuxt/ui，测试环境 #imports 不可解析，整体 mock 掉
vi.mock('../composables/use-user-dialogs.js', () => ({
	useUserDialogs: () => ({
		openSettingsDialog: vi.fn(),
		openProfileDialog: vi.fn(),
	}),
}));
vi.mock('../composables/use-web-agent-dialogs.js', () => ({
	useWebAgentDialogs: () => ({
		openPickerDialog: vi.fn(),
	}),
}));

import DesktopSidebar from './DesktopSidebar.vue';

function createWrapper() {
	return mount(DesktopSidebar, {
		props: {
			currentPath: '/',
			user: null,
		},
		global: {
			plugins: [createPinia()],
			stubs: {
				MainList: { template: '<div class="mainlist-stub" />' },
				UPopover: { template: '<div><slot /><slot name="content" /></div>' },
				UButton: { template: '<button><slot /></button>' },
				UIcon: { template: '<i />' },
			},
			mocks: {
				$t: (key) => key,
				$router: { push: vi.fn() },
			},
		},
	});
}

/** 顶部品牌行的唯一标识：alt="CoClaw" 的 logo 图（MainList 已 stub，无其它 img） */
function brandRowExists(wrapper) {
	return wrapper.find('img[alt="CoClaw"]').exists();
}

describe('DesktopSidebar 顶部品牌行平台门控', () => {
	beforeEach(() => {
		platformMock.isElectronApp = false;
		mockEnv = { ...defaultEnv };
	});

	test('web/非 Electron：保留 logo+名称', () => {
		platformMock.isElectronApp = false;
		mockEnv.isWin = true; // Windows 浏览器（无原生标题栏）仍须保留
		const wrapper = createWrapper();
		expect(wrapper.vm.showSidebarBrand).toBe(true);
		expect(brandRowExists(wrapper)).toBe(true);
	});

	test('Windows Electron：隐藏 logo+名称', () => {
		platformMock.isElectronApp = true;
		mockEnv.isWin = true;
		const wrapper = createWrapper();
		expect(wrapper.vm.showSidebarBrand).toBe(false);
		expect(brandRowExists(wrapper)).toBe(false);
	});

	test('macOS Electron：保留 logo+名称', () => {
		platformMock.isElectronApp = true;
		mockEnv.isMac = true;
		const wrapper = createWrapper();
		expect(wrapper.vm.showSidebarBrand).toBe(true);
		expect(brandRowExists(wrapper)).toBe(true);
	});
});
