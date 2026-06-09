import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { describe, expect, test, vi } from 'vitest';

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

describe('DesktopSidebar 品牌行恒显 + 标题栏作用域 marker', () => {
	test('showSidebarBrand 恒为 true：全端统一显示 logo+名称（平台特例已删）', () => {
		const wrapper = createWrapper();
		expect(wrapper.vm.showSidebarBrand).toBe(true);
		expect(brandRowExists(wrapper)).toBe(true);
	});

	test('MainList 不再带 pt-2 死分支（品牌行恒显，无需顶间距补偿）', () => {
		const wrapper = createWrapper();
		expect(wrapper.find('.mainlist-stub').classes()).not.toContain('pt-2');
	});

	test('侧边栏根挂 cc-desktop-sidebar 惰性 marker，且原有布局类不变（纯追加）', () => {
		const wrapper = createWrapper();
		const aside = wrapper.find('aside');
		const cls = aside.classes();
		expect(cls).toContain('cc-desktop-sidebar');
		// marker 是纯追加，不替换/破坏既有满高与定位类
		expect(cls).toContain('sticky');
		expect(cls).toContain('top-0');
		expect(cls).toContain('h-screen');
		expect(cls).toContain('bg-elevated');
	});
});
