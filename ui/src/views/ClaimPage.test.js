import { createPinia } from 'pinia';
import { mount, flushPromises } from '@vue/test-utils';
import { vi } from 'vitest';

import ClaimPage from './ClaimPage.vue';
import { useClawsStore } from '../stores/claws.store.js';

const mockClaimBot = vi.fn();

vi.mock('../services/claws.api.js', () => ({
	claimClaw: (...args) => mockClaimBot(...args),
}));

vi.mock('../services/claw-connection-manager.js', () => ({
	useClawConnections: () => ({
		get: vi.fn(),
		connect: vi.fn(),
		disconnect: vi.fn(),
		syncConnections: vi.fn(),
		disconnectAll: vi.fn(),
	}),
}));

vi.mock('../services/signaling-connection.js', () => ({
	useSignalingConnection: () => ({
		on: vi.fn(),
		off: vi.fn(),
		connect: vi.fn(),
		disconnect: vi.fn(),
	}),
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

test('should call claimClaw and show success on valid code', async () => {
	mockClaimBot.mockResolvedValueOnce({ clawId: '42', clawName: 'test' });
	const wrapper = createWrapper({ query: { code: '12345678' } });
	await flushPromises();

	expect(mockClaimBot).toHaveBeenCalledWith('12345678');
	expect(wrapper.text()).toContain('Success!');
});

test('should navigate to /bots after success with delay', async () => {
	mockClaimBot.mockResolvedValueOnce({ clawId: '42' });
	const wrapper = createWrapper({ query: { code: '12345678' } });
	await flushPromises();

	vi.advanceTimersByTime(1500);
	expect(wrapper.vm.$router.replace).toHaveBeenCalledWith('/claws');
});

test('should show expired error on CLAIM_CODE_EXPIRED with retryHint', async () => {
	mockClaimBot.mockRejectedValueOnce({
		response: { data: { code: 'CLAIM_CODE_EXPIRED' } },
	});
	const wrapper = createWrapper({ query: { code: 'EXPIRED1' } });
	await flushPromises();

	expect(wrapper.text()).toContain('Code expired');
	expect(wrapper.text()).toContain('Please retry');
});

test('should show invalid error on CLAIM_CODE_INVALID', async () => {
	mockClaimBot.mockRejectedValueOnce({
		response: { data: { code: 'CLAIM_CODE_INVALID' } },
	});
	const wrapper = createWrapper({ query: { code: 'BADCODE' } });
	await flushPromises();

	expect(wrapper.text()).toContain('Code invalid');
});

test('should show generic error on unknown error and log warning', async () => {
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	const err = new Error('network error');
	mockClaimBot.mockRejectedValueOnce(err);
	const wrapper = createWrapper({ query: { code: '12345678' } });
	await flushPromises();

	expect(wrapper.text()).toContain('Failed');
	expect(warnSpy).toHaveBeenCalledWith('[ClaimPage] claimClaw failed:', err);
	warnSpy.mockRestore();
});

test('should add claw to store after successful claim', async () => {
	mockClaimBot.mockResolvedValueOnce({ clawId: '42', clawName: 'MyClaw' });
	createWrapper({ query: { code: '12345678' } });
	await flushPromises();

	const clawsStore = useClawsStore();
	const claw = clawsStore.byId['42'];
	expect(claw).toBeDefined();
	expect(claw.id).toBe('42');
	expect(claw.name).toBe('MyClaw');
});

test('should not add claw to store when clawId is missing', async () => {
	mockClaimBot.mockResolvedValueOnce({ clawId: null, clawName: null });
	createWrapper({ query: { code: '12345678' } });
	await flushPromises();

	const clawsStore = useClawsStore();
	expect(Object.keys(clawsStore.byId)).toHaveLength(0);
});

test('should clear navigation timer on unmount', async () => {
	mockClaimBot.mockResolvedValueOnce({ clawId: '42' });
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
