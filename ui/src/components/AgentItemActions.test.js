import { mount } from '@vue/test-utils';
import { expect, test, vi } from 'vitest';

import AgentItemActions from './AgentItemActions.vue';

// UDropdownMenu stub：trigger（默认插槽）+ 把 :items 平铺成按钮，便于点击触发 onSelect 与断言项。
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
	template: '<button class="u-button-stub" @click="$emit(\'click\')"><slot /></button>',
};

const UIconStub = {
	props: ['name'],
	template: '<span class="icon" :name="name" />',
};

function createWrapper(props = {}) {
	const push = vi.fn();
	const wrapper = mount(AgentItemActions, {
		props: {
			clawId: 'b1',
			agentId: 'main',
			...props,
		},
		global: {
			stubs: {
				UDropdownMenu: UDropdownMenuStub,
				UButton: UButtonStub,
				UIcon: UIconStub,
			},
			mocks: {
				$t: (key, params) => (params && params.name ? `${key} · ${params.name}` : key),
				$router: { push },
			},
		},
	});
	return { wrapper, push };
}

test('trigger aria-label carries row name when name prop is set (WCAG 2.4.6)', () => {
	const { wrapper } = createWrapper({ name: 'helper@bot' });
	const label = wrapper.find('.u-button-stub').attributes('aria-label');
	// locale 安全：断言走带占位符的新 key 且行名出现在标签内，不硬编码完整英文
	expect(label).toContain('common.moreActionsFor');
	expect(label).toContain('helper@bot');
});

test('trigger aria-label falls back to generic label without name', () => {
	const { wrapper } = createWrapper();
	expect(wrapper.find('.u-button-stub').attributes('aria-label')).toBe('common.moreActions');
});

test('renders chat / files menu items', () => {
	const { wrapper } = createWrapper();
	const buttons = wrapper.findAll('button');
	// 第一个是 trigger 的 UButton stub，剩下两个是菜单项
	expect(buttons.length).toBeGreaterThanOrEqual(3);
	expect(wrapper.text()).toContain('agents.chat');
	expect(wrapper.text()).toContain('agents.files');
});

test('clicking chat menu item pushes to chat route and closes popover', async () => {
	const { wrapper, push } = createWrapper({ clawId: 'b1', agentId: 'main' });
	wrapper.vm.menuOpen = true;
	await wrapper.vm.$nextTick();

	// 找 "对话" 菜单项（含 agents.chat 文本的 button）
	const buttons = wrapper.findAll('button').filter((b) => b.text().includes('agents.chat'));
	expect(buttons.length).toBe(1);
	await buttons[0].trigger('click');

	expect(push).toHaveBeenCalledWith({
		name: 'chat',
		params: { clawId: 'b1', agentId: 'main' },
	});
	expect(wrapper.vm.menuOpen).toBe(false);
});

test('clicking files menu item pushes to files route and closes popover', async () => {
	const { wrapper, push } = createWrapper({ clawId: 'b2', agentId: 'helper' });
	wrapper.vm.menuOpen = true;
	await wrapper.vm.$nextTick();

	const buttons = wrapper.findAll('button').filter((b) => b.text().includes('agents.files'));
	expect(buttons.length).toBe(1);
	await buttons[0].trigger('click');

	expect(push).toHaveBeenCalledWith({
		name: 'files',
		params: { clawId: 'b2', agentId: 'helper' },
	});
	expect(wrapper.vm.menuOpen).toBe(false);
});

test('chat menu uses message-square icon, files menu uses folder icon', () => {
	// 钉死菜单项与图标的配对：互换图标会让用户混淆"对话"和"文件"，但仅查文本断言无法发现
	const { wrapper } = createWrapper();
	const chatBtn = wrapper.findAll('button').find((b) => b.text().includes('agents.chat'));
	const filesBtn = wrapper.findAll('button').find((b) => b.text().includes('agents.files'));
	expect(chatBtn.find('[name="i-lucide-message-square"]').exists()).toBe(true);
	expect(filesBtn.find('[name="i-lucide-folder"]').exists()).toBe(true);
	// 交叉确认：chat 菜单项内不含 folder 图标，files 菜单项内不含 message-square 图标
	expect(chatBtn.find('[name="i-lucide-folder"]').exists()).toBe(false);
	expect(filesBtn.find('[name="i-lucide-message-square"]').exists()).toBe(false);
});
