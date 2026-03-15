import { createPinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { vi } from 'vitest';

import ManageBotsPage from './ManageBotsPage.vue';

vi.mock('../services/bots.api.js', () => ({
	listBots: vi.fn().mockResolvedValue([]),
	unbindBotByUser: vi.fn().mockResolvedValue({}),
}));

vi.mock('../composables/use-notify.js', () => ({
	useNotify: () => ({
		success: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warning: vi.fn(),
	}),
}));

const UButtonStub = {
	props: ['icon', 'loading'],
	emits: ['click'],
	template: '<button v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>',
};

function createWrapper() {
	return mount(ManageBotsPage, {
		global: {
			plugins: [createPinia()],
			stubs: {
				UButton: UButtonStub,
			},
			mocks: {
				$t: (key) => {
					const map = {
						'bots.pageTitle': '我的 Claw',
						'bots.addBot': '添加机器人',
						'bots.noBot': '未绑定机器人。',
					};
					return map[key] ?? key;
				},
				$router: { push: vi.fn() },
			},
		},
	});
}

test('should render page title and empty state when no bots', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	expect(wrapper.text()).toContain('我的 Claw');
	expect(wrapper.text()).toContain('未绑定机器人。');
});

test('should show add bot button', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	expect(wrapper.text()).toContain('添加机器人');
});
