import { mount } from '@vue/test-utils';
import { describe, test, expect } from 'vitest';

import ElectronTitleBar from './ElectronTitleBar.vue';

describe('ElectronTitleBar', () => {
	test('默认（非全屏）渲染色带：cc-electron-titlebar + 固定定位（z-[60] 压过页面内固定层）+ aria-hidden', () => {
		const wrapper = mount(ElectronTitleBar);
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
		const wrapper = mount(ElectronTitleBar, { props: { isFullScreen: true } });
		expect(wrapper.find('.cc-electron-titlebar').exists()).toBe(false);
	});

	test('唯一 prop 是 isFullScreen——不收 custom prop（custom 门由 App.vue 父级 v-if 负责）', () => {
		expect(Object.keys(ElectronTitleBar.props)).toEqual(['isFullScreen']);
	});

	test('不访问任何 Electron API：无 window.electronAPI 下挂载/卸载无副作用、不抛', () => {
		// jsdom 下 window.electronAPI 为 undefined；组件若误访问会抛错
		expect(() => {
			const w = mount(ElectronTitleBar, { props: { isFullScreen: false } });
			w.unmount();
		}).not.toThrow();
	});
});
