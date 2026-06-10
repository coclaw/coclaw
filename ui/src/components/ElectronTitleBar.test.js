import { mount } from '@vue/test-utils';
import { describe, test, expect } from 'vitest';

import ElectronTitleBar from './ElectronTitleBar.vue';

function mountBar(props = {}) {
	return mount(ElectronTitleBar, {
		props,
		global: {
			mocks: {
				$t: (key) => (key === 'layout.productName' ? 'CoClaw' : key),
			},
		},
	});
}

describe('ElectronTitleBar', () => {
	test('默认（非全屏）渲染色带：cc-electron-titlebar + 固定定位（z-[60] 压过页面内固定层）+ aria-hidden', () => {
		const wrapper = mountBar();
		const bar = wrapper.find('.cc-electron-titlebar');
		expect(bar.exists()).toBe(true);
		expect(bar.attributes('aria-hidden')).toBe('true');
		// 满窗宽、固定盖在两列之上、不占流
		const cls = bar.classes();
		expect(cls).toContain('fixed');
		expect(cls).toContain('top-0');
		expect(cls).toContain('inset-x-0');
		expect(cls).toContain('z-[60]');
		expect(cls).toContain('bg-elevated');
		// app-region:drag 落在 scoped <style> 里、按 .cc-electron-titlebar 命中（jsdom 不解析非标准 CSS 属性，
		// 实际拖动手感由打包壳冒烟门禁验，见设计稿 §10）；此处以 marker 类在场作为绑定锁
	});

	test('isFullScreen=true 时不渲染（全屏无条）', () => {
		const wrapper = mountBar({ isFullScreen: true });
		expect(wrapper.find('.cc-electron-titlebar').exists()).toBe(false);
	});

	test('props 只有 isFullScreen + platform——不收 custom prop（custom 门由 App.vue 父级 v-if 负责）', () => {
		expect(Object.keys(ElectronTitleBar.props)).toEqual(['isFullScreen', 'platform']);
	});

	test('win32：条左侧渲染品牌（logo 16×16 距左 16px、文字距 icon 16px、caption 12px，微软规范）', () => {
		const wrapper = mountBar({ platform: 'win32' });
		const brand = wrapper.find('.cc-titlebar-brand');
		expect(brand.exists()).toBe(true);
		// 垂直在条内居中
		expect(brand.classes()).toContain('items-center');
		expect(brand.classes()).toContain('h-full');
		// logo：16×16（size-4）、距左 16px（ml-4）、小圆角
		const logo = brand.find('img');
		expect(logo.exists()).toBe(true);
		expect(logo.classes()).toContain('size-4');
		expect(logo.classes()).toContain('ml-4');
		// 文字：距 icon 16px（ml-4）、caption 12px（text-xs）、主题色 token
		const name = brand.find('span');
		expect(name.text()).toBe('CoClaw');
		expect(name.classes()).toContain('ml-4');
		expect(name.classes()).toContain('text-xs');
		expect(name.classes()).toContain('text-default');
	});

	test('darwin / 未知平台：条内不渲染品牌（mac 留空，身份由系统菜单栏+侧边栏承载）', () => {
		expect(mountBar({ platform: 'darwin' }).find('.cc-titlebar-brand').exists()).toBe(false);
		expect(mountBar().find('.cc-titlebar-brand').exists()).toBe(false);
	});

	test('不访问任何 Electron API：无 window.electronAPI 下挂载/卸载无副作用、不抛', () => {
		// jsdom 下 window.electronAPI 为 undefined；组件若误访问会抛错（platform 经 prop 传入，含 win32 分支）
		expect(() => {
			const w = mountBar({ isFullScreen: false, platform: 'win32' });
			w.unmount();
		}).not.toThrow();
	});
});
