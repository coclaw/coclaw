import { mount } from '@vue/test-utils';
import { describe, test, expect } from 'vitest';

import FileBreadcrumb from './FileBreadcrumb.vue';

function mountBreadcrumb(path = '') {
	return mount(FileBreadcrumb, {
		props: { path },
		global: {
			mocks: { $t: (key) => key },
			stubs: { UIcon: { template: '<span />' } },
		},
	});
}

describe('FileBreadcrumb', () => {
	test('根目录只显示 rootDir 按钮', () => {
		const w = mountBreadcrumb('');
		const buttons = w.findAll('button');
		expect(buttons).toHaveLength(1);
		expect(buttons[0].text()).toBe('files.rootDir');
		// 无中间段和末尾 span
		expect(w.findAll('span').filter((s) => s.classes().length === 0)).toHaveLength(0);
	});

	test('单层目录：rootDir + 当前段（不可点击）', () => {
		const w = mountBreadcrumb('docs');
		const buttons = w.findAll('button');
		expect(buttons).toHaveLength(1); // 只有 rootDir 可点击
		expect(w.find('span.font-medium').text()).toBe('docs');
	});

	test('多层目录：中间段可点击，末尾段不可点击', () => {
		const w = mountBreadcrumb('src/components/files');
		const buttons = w.findAll('button');
		// rootDir + src + components = 3 个可点击
		expect(buttons).toHaveLength(3);
		expect(buttons[1].text()).toBe('src');
		expect(buttons[2].text()).toBe('components');
		// 末尾段
		expect(w.find('span.font-medium').text()).toBe('files');
	});

	test('点击 rootDir 触发 navigate("")', async () => {
		const w = mountBreadcrumb('src/utils');
		await w.findAll('button')[0].trigger('click');
		expect(w.emitted('navigate')[0]).toEqual(['']);
	});

	test('点击中间段触发 navigate(对应路径)', async () => {
		const w = mountBreadcrumb('a/b/c');
		const buttons = w.findAll('button');
		await buttons[1].trigger('click'); // 'a'
		expect(w.emitted('navigate')[0]).toEqual(['a']);
		await buttons[2].trigger('click'); // 'b'
		expect(w.emitted('navigate')[1]).toEqual(['a/b']);
	});

	test('segments computed 过滤空段', () => {
		const w = mountBreadcrumb('a//b');
		// 'a//b'.split('/').filter(Boolean) → ['a', 'b']
		expect(w.vm.segments).toEqual(['a', 'b']);
	});
});
