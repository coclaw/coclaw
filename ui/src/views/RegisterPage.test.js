import { createPinia, setActivePinia } from 'pinia';
import { mount, flushPromises } from '@vue/test-utils';
import { vi } from 'vitest';

import RegisterPage from './RegisterPage.vue';

vi.mock('../services/auth.api.js', () => ({
	fetchSessionUser: vi.fn().mockResolvedValue(null),
	registerByLoginName: vi.fn().mockResolvedValue({ user: null }),
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
		screen: { ltMd: true },
	}),
}));

vi.mock('../validators/login-name.js', () => ({
	validateLoginName: () => ({ valid: true }),
}));

const i18nMap = {
	'register.title': 'Register',
	'register.desc': 'Create account',
	'register.account': 'Account',
	'register.accountPlaceholder': 'Enter account',
	'register.password': 'Password',
	'register.passwordPlaceholder': 'Enter password',
	'register.confirmPassword': 'Confirm',
	'register.confirmPasswordPlaceholder': 'Confirm password',
	'register.registerBtn': 'Register',
	'register.hasAccount': 'Have account?',
	'register.goLogin': 'Login',
	'register.passwordMismatch': 'Passwords do not match',
};

function createWrapper({ query = {} } = {}) {
	const pinia = createPinia();
	setActivePinia(pinia);
	return mount(RegisterPage, {
		global: {
			plugins: [pinia],
			stubs: {
				UInput: { props: ['modelValue'], template: '<div />', inheritAttrs: false },
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

test('账号框 autocomplete=off：注册建新号，故意不让浏览器弹已存账号建议（勿改成 username）', () => {
	const pinia = createPinia();
	setActivePinia(pinia);
	const wrapper = mount(RegisterPage, {
		global: {
			plugins: [pinia],
			stubs: {
				// 渲染真实 input 并透传 $attrs，让 autocomplete 落到 DOM 才能断言
				UInput: { inheritAttrs: false, props: ['modelValue', 'size'], template: '<input v-bind="$attrs" :value="modelValue" />' },
				UButton: { template: '<button><slot /></button>' },
				UFormField: { props: ['label', 'name'], template: '<div><slot /></div>' },
				RouterLink: { props: ['to'], template: '<a><slot /></a>' },
			},
			mocks: {
				$t: (key) => i18nMap[key] ?? key,
				$route: { query: {} },
				$router: { replace: vi.fn() },
			},
		},
	});
	const account = wrapper.find('[data-testid="register-name"]');
	expect(account.exists()).toBe(true);
	expect(account.attributes('autocomplete')).toBe('off');
});

test('safeRedirect should return valid redirect path', () => {
	const wrapper = createWrapper({ query: { redirect: '/claim?code=123' } });
	expect(wrapper.vm.safeRedirect).toBe('/claim?code=123');
});

test('safeRedirect should reject protocol-relative URLs', () => {
	const wrapper = createWrapper({ query: { redirect: '//evil.com' } });
	expect(wrapper.vm.safeRedirect).toBeNull();
});

test('safeRedirect should reject absolute URLs', () => {
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

test('should redirect to defaultRoute (mobile) when logged in without redirect', async () => {
	const { fetchSessionUser } = await import('../services/auth.api.js');
	fetchSessionUser.mockResolvedValueOnce({ id: 1 });

	const wrapper = createWrapper({ query: {} });
	await flushPromises();

	// ltMd=true → '/topics'
	expect(wrapper.vm.$router.replace).toHaveBeenCalledWith('/topics');
});
