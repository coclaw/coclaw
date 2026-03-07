import { mount } from '@vue/test-utils';

import NuxtUiDemoPage from './NuxtUiDemoPage.vue';

test('should render nuxt ui demo and increase count after click', async () => {
	const wrapper = mount(NuxtUiDemoPage, {
		global: {
			mocks: {
				$t: (key, params = {}) => {
					if (key === 'demo.title') {
						return 'Nuxt UI 4 Demo';
					}
					if (key === 'demo.desc') {
						return 'Nuxt UI component library baseline integration is ready.';
					}
					if (key === 'demo.ready') {
						return 'Ready';
					}
					if (key === 'demo.clickedTimes') {
						return `Clicked ${params.count} times`;
					}
					if (key === 'demo.backToAuthPrototype') {
						return 'Back to Auth Prototype';
					}
					return key;
				},
			},
			stubs: {
				UContainer: {
					template: '<div><slot /></div>',
				},
				UCard: {
					template: '<section><slot name="header" /><slot /></section>',
				},
				UBadge: {
					template: '<span><slot /></span>',
				},
				UButton: {
					emits: ['click'],
					template: '<button v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>',
				},
			},
		},
	});

	const countBtn = wrapper.get('[data-testid="demo-count-btn"]');
	expect(wrapper.text()).toContain('Nuxt UI 4 Demo');
	expect(countBtn.text()).toContain('Clicked 0 times');

	await countBtn.trigger('click');
	expect(countBtn.text()).toContain('Clicked 1 times');
});
