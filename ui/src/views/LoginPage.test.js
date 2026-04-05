import { createPinia, setActivePinia } from 'pinia';
import { mount, flushPromises } from '@vue/test-utils';
import { vi } from 'vitest';

import LoginPage from './LoginPage.vue';

vi.mock('../services/auth.api.js', () => ({
	fetchSessionUser: vi.fn().mockResolvedValue(null),
	loginByLoginName: vi.fn().mockResolvedValue({ user: null }),
}));

vi.mock('../i18n/index.js', () => ({
	normalizeSettingsLocale: () => null,
	setLocale: vi.fn(),
}));

vi.mock('../services/theme-mode.js', () => ({
	syncThemeModeFromSettings: vi.fn(),
}));

vi.mock('../services/claw-connection-manager.js', () => ({
	useClawConnections: () => ({ disconnectAll: vi.fn() }),
}));

vi.mock('../stores/sessions.store.js', () => ({
	useSessionsStore: () => ({}),
}));

vi.mock('../stores/claws.store.js', () => ({
	useClawsStore: () => ({}),
}));

vi.mock('../stores/env.store.js', () => ({
	useEnvStore: () => ({
		screen: { ltMd: false },
	}),
}));

const i18nMap = {
	'login.title': 'Login',
	'login.account': 'Account',
	'login.accountPlaceholder': 'Enter account',
	'login.password': 'Password',
	'login.passwordPlaceholder': 'Enter password',
	'login.loginBtn': 'Login',
	'login.noAccount': 'No account?',
	'login.goRegister': 'Register',
};

function createWrapper({ query = {} } = {}) {
	const pinia = createPinia();
	setActivePinia(pinia);
	return mount(LoginPage, {
		global: {
			plugins: [pinia],
			stubs: {
				UInput: { props: ['modelValue'], template: '<input />' },
				UButton: { template: '<button><slot /></button>' },
				UFormField: { props: ['label', 'name'], template: '<div><slot /></div>' },
				RouterLink: { props: ['to'], template: '<a><slot /></a>' },
			},
			mocks: {
				$t: (key) => i18nMap[key] ?? key,
				$route: { query },
				$router: { replace: vi.fn() },
			},
		},
	});
}

test('safeRedirect should return valid redirect path', () => {
	const wrapper = createWrapper({ query: { redirect: '/claim?code=123' } });
	expect(wrapper.vm.safeRedirect).toBe('/claim?code=123');
});

test('safeRedirect should reject protocol-relative URLs', () => {
	const wrapper = createWrapper({ query: { redirect: '//evil.com' } });
	expect(wrapper.vm.safeRedirect).toBeNull();
});

test('safeRedirect should reject non-string values', () => {
	const wrapper = createWrapper({ query: { redirect: 42 } });
	expect(wrapper.vm.safeRedirect).toBeNull();
});

test('safeRedirect should reject paths not starting with /', () => {
	const wrapper = createWrapper({ query: { redirect: 'https://evil.com' } });
	expect(wrapper.vm.safeRedirect).toBeNull();
});

test('safeRedirect should return null when no redirect param', () => {
	const wrapper = createWrapper({ query: {} });
	expect(wrapper.vm.safeRedirect).toBeNull();
});

test('should redirect to safeRedirect on mount when already logged in', async () => {
	const { fetchSessionUser } = await import('../services/auth.api.js');
	fetchSessionUser.mockResolvedValueOnce({ id: 1 });

	const wrapper = createWrapper({ query: { redirect: '/claim?code=abc' } });
	await flushPromises();

	expect(wrapper.vm.$router.replace).toHaveBeenCalledWith('/claim?code=abc');
});

test('should redirect to defaultRoute on mount when logged in without redirect param', async () => {
	const { fetchSessionUser } = await import('../services/auth.api.js');
	fetchSessionUser.mockResolvedValueOnce({ id: 1 });

	const wrapper = createWrapper({ query: {} });
	await flushPromises();

	expect(wrapper.vm.$router.replace).toHaveBeenCalledWith('/home');
});
