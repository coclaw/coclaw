import { createPinia } from 'pinia';
import { mount, flushPromises } from '@vue/test-utils';
import { vi, test, expect } from 'vitest';

vi.mock('../services/server-info.api.js', () => ({
	fetchServerInfo: vi.fn().mockResolvedValue({ version: '1.2.3' }),
}));

const mockOpenExternalUrl = vi.hoisted(() => vi.fn());
vi.mock('../utils/external-url.js', () => ({
	openExternalUrl: mockOpenExternalUrl,
}));

vi.stubGlobal('__APP_VERSION__', '0.0.0-test');

import AboutPage from './AboutPage.vue';

function createWrapper() {
	return mount(AboutPage, {
		global: {
			plugins: [createPinia()],
			stubs: {
				MobilePageHeader: { props: ['title'], template: '<div />' },
				UAccordion: { props: ['items'], template: '<div />' },
			},
			mocks: {
				$t: (key) => key,
				$router: { push: vi.fn(), replace: vi.fn() },
			},
		},
	});
}

test('未登录显示登录按钮与版本号', async () => {
	const wrapper = createWrapper();
	await flushPromises();

	expect(wrapper.find('[data-testid="btn-about-login"]').exists()).toBe(true);
	expect(wrapper.find('[data-testid="btn-about-logout"]').exists()).toBe(false);
	expect(wrapper.text()).toContain('0.0.0-test');
	expect(wrapper.text()).toContain('1.2.3');
});

test('开源声明入口存在，点击跳转声明页', async () => {
	const wrapper = createWrapper();
	await flushPromises();

	const btn = wrapper.find('[data-testid="btn-open-source-notices"]');
	expect(btn.exists()).toBe(true);
	await btn.trigger('click');
	expect(wrapper.vm.$router.push).toHaveBeenCalledWith('/about/notices');
});
