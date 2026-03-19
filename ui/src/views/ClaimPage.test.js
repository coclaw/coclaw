import { createPinia } from 'pinia';
import { mount, flushPromises } from '@vue/test-utils';
import { vi } from 'vitest';

import ClaimPage from './ClaimPage.vue';

const mockClaimBot = vi.fn();

vi.mock('../services/bots.api.js', () => ({
	claimBot: (...args) => mockClaimBot(...args),
}));

const mockNotify = {
	success: vi.fn(),
	info: vi.fn(),
	warning: vi.fn(),
	error: vi.fn(),
};
vi.mock('../composables/use-notify.js', () => ({
	useNotify: () => mockNotify,
}));

const i18nMap = {
	'claim.title': 'Claim Bot',
	'claim.claiming': 'Claiming...',
	'claim.success': 'Success!',
	'claim.expired': 'Code expired',
	'claim.invalid': 'Code invalid',
	'claim.alreadyBound': 'Already bound',
	'claim.failed': 'Failed',
	'claim.retryHint': 'Please retry',
	'claim.noCode': 'No code provided',
};

function createWrapper({ query = {} } = {}) {
	return mount(ClaimPage, {
		global: {
			plugins: [createPinia()],
			stubs: {
				UIcon: { props: ['name'], template: '<span />' },
				MobilePageHeader: { props: ['title'], template: '<div />' },
			},
			mocks: {
				$t: (key) => i18nMap[key] ?? key,
				$route: { query },
				$router: { replace: vi.fn() },
			},
		},
	});
}

beforeEach(() => {
	mockClaimBot.mockReset();
	mockNotify.success.mockReset();
	mockNotify.error.mockReset();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

test('should show noCode state when query has no code', async () => {
	const wrapper = createWrapper({ query: {} });
	await flushPromises();

	expect(wrapper.text()).toContain('No code provided');
	expect(mockClaimBot).not.toHaveBeenCalled();
});

test('should call claimBot and show success on valid code', async () => {
	mockClaimBot.mockResolvedValueOnce({ botId: '42', botName: 'test' });
	const wrapper = createWrapper({ query: { code: '12345678' } });
	await flushPromises();

	expect(mockClaimBot).toHaveBeenCalledWith('12345678');
	expect(wrapper.text()).toContain('Success!');
	// 成功时仅 inline 展示，不再弹 notify
	expect(mockNotify.success).not.toHaveBeenCalled();
});

test('should navigate to /bots after success with delay', async () => {
	mockClaimBot.mockResolvedValueOnce({ botId: '42' });
	const wrapper = createWrapper({ query: { code: '12345678' } });
	await flushPromises();

	vi.advanceTimersByTime(1500);
	expect(wrapper.vm.$router.replace).toHaveBeenCalledWith('/bots');
});

test('should show expired error on CLAIM_CODE_EXPIRED with retryHint', async () => {
	mockClaimBot.mockRejectedValueOnce({
		response: { data: { code: 'CLAIM_CODE_EXPIRED' } },
	});
	const wrapper = createWrapper({ query: { code: 'EXPIRED1' } });
	await flushPromises();

	expect(wrapper.text()).toContain('Code expired');
	expect(wrapper.text()).toContain('Please retry');
	expect(mockNotify.error).toHaveBeenCalledWith('Code expired');
});

test('should show invalid error on CLAIM_CODE_INVALID', async () => {
	mockClaimBot.mockRejectedValueOnce({
		response: { data: { code: 'CLAIM_CODE_INVALID' } },
	});
	const wrapper = createWrapper({ query: { code: 'BADCODE' } });
	await flushPromises();

	expect(wrapper.text()).toContain('Code invalid');
	expect(mockNotify.error).toHaveBeenCalledWith('Code invalid');
});

test('should show alreadyBound error on ALREADY_BOUND without retryHint', async () => {
	mockClaimBot.mockRejectedValueOnce({
		response: { data: { code: 'ALREADY_BOUND' } },
	});
	const wrapper = createWrapper({ query: { code: 'BOUND123' } });
	await flushPromises();

	expect(wrapper.text()).toContain('Already bound');
	expect(wrapper.text()).not.toContain('Please retry');
	expect(mockNotify.error).toHaveBeenCalledWith('Already bound');
});

test('should show generic error on unknown error', async () => {
	mockClaimBot.mockRejectedValueOnce(new Error('network error'));
	const wrapper = createWrapper({ query: { code: '12345678' } });
	await flushPromises();

	expect(wrapper.text()).toContain('Failed');
	expect(mockNotify.error).toHaveBeenCalledWith('Failed');
});

test('should clear navigation timer on unmount', async () => {
	mockClaimBot.mockResolvedValueOnce({ botId: '42' });
	const wrapper = createWrapper({ query: { code: '12345678' } });
	await flushPromises();

	// timer 已设置
	expect(wrapper.vm.__navTimer).not.toBeNull();

	wrapper.unmount();
	// unmount 后 timer 不会触发路由跳转
	vi.advanceTimersByTime(2000);
	// replace 不应被调用（已清理）
	expect(wrapper.vm.$router.replace).not.toHaveBeenCalled();
});
