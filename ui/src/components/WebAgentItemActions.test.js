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

// UDropdownMenu stub：trigger（默认插槽）+ 把 :items 平铺成按钮（含 item-leading / item-label 插槽），
// 便于点击触发 onSelect 与断言项；testid 由组件经 item-label 插槽渲染（与真实组件一致），不放在 item 元素上。
const UDropdownMenuStub = {
	name: 'UDropdownMenu',
	props: ['items', 'open', 'content'],
	emits: ['update:open'],
	template: `
		<div class="dropdown-stub">
			<slot :open="open" />
			<button
				v-for="(it, i) in (items || [])"
				:key="i"
				type="button"
				class="dropdown-item"
				@click="it.onSelect && it.onSelect()"
			>
				<slot name="item-leading" :item="it"><span class="icon" :name="it.icon" /></slot>
				<slot name="item-label" :item="it">{{ it.label }}</slot>
			</button>
		</div>
	`,
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
				UDropdownMenu: UDropdownMenuStub,
				UButton: UButtonStub,
				UIcon: UIconStub,
			},
			mocks: {
				$t: (key, params) => {
					const map = {
						'webAgents.removeFromRecent': '从列表移除',
					};
					const base = map[key] ?? key;
					return params && params.name ? `${base} · ${params.name}` : base;
				},
			},
		},
	});
}

describe('WebAgentItemActions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('trigger 的 aria-label 带行级名字（有 name prop，WCAG 2.4.6）', () => {
		const wrapper = createWrapper({ name: 'Kimi' });
		const label = wrapper.findAll('button')[0].attributes('aria-label');
		expect(label).toContain('common.moreActionsFor');
		expect(label).toContain('Kimi');
	});

	test('无 name 时 aria-label 回退到通用标签', () => {
		const wrapper = createWrapper();
		expect(wrapper.findAll('button')[0].attributes('aria-label')).toBe('common.moreActions');
	});

	test('渲染 trigger 按钮 + 单一菜单项', () => {
		const wrapper = createWrapper();
		// trigger 按钮 + 单菜单项 = 2 个 button
		expect(wrapper.findAll('button').length).toBe(2);
		expect(wrapper.text()).toContain('从列表移除');
	});

	test('main 实例在「移除」项 label 上渲染 data-testid（E2E 锚点）；sidebar 实例不渲染', () => {
		const main = createWrapper({ webAgentId: 7, instance: 'main' });
		// 真实组件经 #item-label 插槽把 testid 挂到 label span 上（item 元素不透传任意 data-*）
		expect(main.find('[data-testid="web-agent-actions-remove-7"]').exists()).toBe(true);

		const sidebar = createWrapper({ webAgentId: 7, instance: 'sidebar' });
		expect(sidebar.find('[data-testid^="web-agent-actions-remove-"]').exists()).toBe(false);
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
