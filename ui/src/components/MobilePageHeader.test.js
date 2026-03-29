import { mount } from '@vue/test-utils';
import { test, expect, vi } from 'vitest';

import MobilePageHeader from './MobilePageHeader.vue';

const UButtonStub = {
	props: ['icon', 'variant', 'color'],
	emits: ['click'],
	template: '<button v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>',
};

const routerBackMock = vi.fn();
const routerReplaceMock = vi.fn();

function createWrapper(props = {}, opts = {}) {
	return mount(MobilePageHeader, {
		props: {
			title: '测试标题',
			...props,
		},
		global: {
			stubs: {
				UButton: UButtonStub,
			},
			mocks: {
				$router: {
					back: routerBackMock,
					replace: routerReplaceMock,
				},
			},
		},
		slots: opts.slots,
	});
}

test('should render title', () => {
	const wrapper = createWrapper({ title: '我的页面' });
	expect(wrapper.find('h1').text()).toBe('我的页面');
});

test('should render back button', () => {
	const wrapper = createWrapper();
	const btn = wrapper.find('button');
	expect(btn.exists()).toBe(true);
});

test('should call router.back when history.state.back exists', async () => {
	const origState = history.state;
	history.replaceState({ ...history.state, back: '/topics' }, '');

	routerBackMock.mockClear();
	routerReplaceMock.mockClear();
	const wrapper = createWrapper();
	await wrapper.find('button').trigger('click');

	expect(routerBackMock).toHaveBeenCalled();
	expect(routerReplaceMock).not.toHaveBeenCalled();

	history.replaceState(origState, '');
});

test('should call router.replace("/") when no history back state', async () => {
	const origState = history.state;
	history.replaceState({ back: null }, '');

	routerBackMock.mockClear();
	routerReplaceMock.mockClear();
	const wrapper = createWrapper();
	await wrapper.find('button').trigger('click');

	expect(routerReplaceMock).toHaveBeenCalledWith('/');
	expect(routerBackMock).not.toHaveBeenCalled();

	history.replaceState(origState, '');
});

test('should render actions slot content', () => {
	const wrapper = createWrapper({}, {
		slots: {
			actions: '<span class="test-action">操作</span>',
		},
	});
	expect(wrapper.find('.test-action').exists()).toBe(true);
	expect(wrapper.find('.test-action').text()).toBe('操作');
});

test('should have empty actions area when no actions slot', () => {
	const wrapper = createWrapper();
	// 无 actions 插槽时右侧区域为空
	const actionsDiv = wrapper.findAll('header > div').at(0);
	expect(actionsDiv.exists()).toBe(true);
	expect(actionsDiv.text()).toBe('');
});
