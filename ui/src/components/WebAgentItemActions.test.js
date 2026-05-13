import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mockedApi = vi.hoisted(() => ({
	listWebAgents: vi.fn().mockResolvedValue([]),
	recordWebAgentClick: vi.fn().mockResolvedValue(undefined),
	hideWebAgent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/web-agents.api.js', () => mockedApi);

// hide / recordClick 现在需要登录态；本测试关心组件行为而非鉴权门控，整组 mock 成已登录
const mockAuth = vi.hoisted(() => ({ user: { id: 1n, loginName: 'tester' } }));
vi.mock('../stores/auth.store.js', () => ({
	useAuthStore: () => mockAuth,
}));

import WebAgentItemActions from './WebAgentItemActions.vue';
import { useWebAgentsStore, __resetWebAgentsInternals } from '../stores/web-agents.store.js';

const UPopoverStub = {
	props: ['open'],
	emits: ['update:open'],
	template: '<div class="popover-stub"><slot /><slot name="content" /></div>',
};

const UButtonStub = {
	props: ['variant', 'color', 'size', 'icon'],
	template: '<button @click="$emit(\'click\')"><slot /></button>',
	emits: ['click'],
};

const UIconStub = {
	props: ['name'],
	template: '<span class="icon" :name="name" />',
};

function createWrapper(props = {}) {
	const pinia = createPinia();
	setActivePinia(pinia);
	__resetWebAgentsInternals();
	return mount(WebAgentItemActions, {
		props: {
			webAgentId: 7,
			...props,
		},
		global: {
			plugins: [pinia],
			stubs: {
				UPopover: UPopoverStub,
				UButton: UButtonStub,
				UIcon: UIconStub,
			},
			mocks: {
				$t: (key) => {
					const map = {
						'webAgents.removeFromRecent': '从列表移除',
					};
					return map[key] ?? key;
				},
			},
		},
	});
}

describe('WebAgentItemActions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('渲染 trigger 按钮 + 单一菜单项', () => {
		const wrapper = createWrapper();
		// trigger 按钮 + 单菜单项 = 2 个 button
		expect(wrapper.findAll('button').length).toBe(2);
		expect(wrapper.text()).toContain('从列表移除');
	});

	test('点击「移除」调用 store.hide(webAgentId) 并关菜单', async () => {
		const wrapper = createWrapper({ webAgentId: 42 });
		const store = useWebAgentsStore();
		const hideSpy = vi.spyOn(store, 'hide').mockImplementation(() => {});

		// 先打开菜单（trigger 按钮）
		wrapper.vm.menuOpen = true;
		await wrapper.vm.$nextTick();

		const removeBtn = wrapper.findAll('button').find((b) => b.text().includes('从列表移除'));
		expect(removeBtn).toBeTruthy();
		await removeBtn.trigger('click');

		expect(hideSpy).toHaveBeenCalledWith(42);
		expect(wrapper.vm.menuOpen).toBe(false);
	});

	test('点击「移除」走真实 store 路径：fire-and-forget POST 到 hideWebAgent', async () => {
		const wrapper = createWrapper({ webAgentId: 9 });
		const store = useWebAgentsStore();
		store.items = [
			{ id: 9, slug: 'kimi', name: 'Kimi', url: 'u', sort: 1, lastClickedAt: '2026-05-01T00:00:00Z', hiddenAt: null },
		];

		wrapper.vm.menuOpen = true;
		await wrapper.vm.$nextTick();
		const removeBtn = wrapper.findAll('button').find((b) => b.text().includes('从列表移除'));
		await removeBtn.trigger('click');

		// 乐观更新立即写入 hiddenAt
		expect(store.items[0].hiddenAt).toBeTruthy();
		// fire-and-forget POST 也确实发出了
		expect(mockedApi.hideWebAgent).toHaveBeenCalledWith(9);
	});
});
