import { mount, flushPromises } from '@vue/test-utils';
import { test, expect, describe, vi, beforeEach } from 'vitest';

// 平台外链：避免真触发 openExternalUrl 副作用
const openExternalUrlMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../utils/external-url.js', () => ({
	openExternalUrl: openExternalUrlMock,
}));

// notify：错误终态会 notify.error
const mockNotify = vi.hoisted(() => ({
	success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn(),
}));
vi.mock('../../composables/use-notify.js', () => ({
	useNotify: () => mockNotify,
}));

import ProviderOAuthLoginStep from './ProviderOAuthLoginStep.vue';

const UButtonStub = {
	props: { disabled: { type: Boolean, default: false }, loading: { type: Boolean, default: false } },
	emits: ['click'],
	template: '<button :disabled="disabled || loading" @click="$emit(\'click\')"><slot /></button>',
};

/**
 * 构造一个受控的 loginOauth 注入函数：暴露 onAccepted/resolve/reject/signal 句柄，
 * 让测试逐步驱动两阶段流。
 */
function makeLogin() {
	const ctl = { calls: 0 };
	ctl.loginOauth = vi.fn(({ provider, onAccepted, signal }) => {
		ctl.calls += 1;
		ctl.provider = provider;
		ctl.onAccepted = onAccepted;
		ctl.signal = signal;
		return new Promise((res, rej) => { ctl.resolve = res; ctl.reject = rej; });
	});
	return ctl;
}

function makeWrapper(props = {}) {
	return mount(ProviderOAuthLoginStep, {
		props: {
			provider: 'github-copilot',
			...props,
		},
		global: {
			stubs: { UButton: UButtonStub },
			mocks: {
				$t: (key, params) => params ? `${key}|${JSON.stringify(params)}` : key,
			},
		},
	});
}

// phase-1 受理帧默认形态（B1 设备码）
function accepted(over = {}) {
	return {
		status: 'accepted',
		loginId: 'login-1',
		provider: 'github-copilot',
		verificationUri: 'https://github.com/login/device',
		userCode: 'ABCD-1234',
		rawText: 'Open https://github.com/login/device and enter ABCD-1234',
		...over,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('ProviderOAuthLoginStep — autostart + phase-1', () => {
	test('mounts → starts login with provider + onAccepted + AbortSignal; shows starting state', () => {
		const ctl = makeLogin();
		const w = makeWrapper({ loginOauth: ctl.loginOauth });
		expect(ctl.loginOauth).toHaveBeenCalledTimes(1);
		expect(ctl.provider).toBe('github-copilot');
		expect(typeof ctl.onAccepted).toBe('function');
		expect(ctl.signal).toBeInstanceOf(AbortSignal);
		expect(w.find('[data-testid="oauth-starting"]').exists()).toBe(true);
		w.unmount();
	});

	test('autoStart=false does NOT start login until start() called', async () => {
		const ctl = makeLogin();
		const w = makeWrapper({ loginOauth: ctl.loginOauth, autoStart: false });
		expect(ctl.loginOauth).not.toHaveBeenCalled();
		w.vm.start();
		await w.vm.$nextTick();
		expect(ctl.loginOauth).toHaveBeenCalledTimes(1);
		w.unmount();
	});

	test('phase-1 accepted → renders verification link + user code; no rawText block when structured present', async () => {
		const ctl = makeLogin();
		const w = makeWrapper({ loginOauth: ctl.loginOauth });
		ctl.onAccepted(accepted());
		await w.vm.$nextTick();
		const link = w.find('[data-testid="oauth-verification-link"]');
		expect(link.exists()).toBe(true);
		expect(link.text()).toBe('https://github.com/login/device');
		expect(w.find('[data-testid="oauth-user-code"]').text()).toBe('ABCD-1234');
		// 结构化链接在手 → 不渲染 rawText 兜底
		expect(w.find('[data-testid="oauth-raw-text"]').exists()).toBe(false);
		expect(w.find('[data-testid="oauth-starting"]').exists()).toBe(false);
		w.unmount();
	});

	test('rawText fallback renders only when verificationUri is missing', async () => {
		const ctl = makeLogin();
		const w = makeWrapper({ loginOauth: ctl.loginOauth });
		ctl.onAccepted(accepted({ verificationUri: null, userCode: null }));
		await w.vm.$nextTick();
		expect(w.find('[data-testid="oauth-verification-link"]').exists()).toBe(false);
		expect(w.find('[data-testid="oauth-user-code"]').exists()).toBe(false);
		const raw = w.find('[data-testid="oauth-raw-text"]');
		expect(raw.exists()).toBe(true);
		expect(raw.text()).toContain('Open https://github.com/login/device');
		w.unmount();
	});

	test('non-string structured fields coerce to empty (no link/code/raw when all blank)', async () => {
		const ctl = makeLogin();
		const w = makeWrapper({ loginOauth: ctl.loginOauth });
		ctl.onAccepted({ status: 'accepted', loginId: 123, verificationUri: 42, userCode: {}, rawText: null });
		await w.vm.$nextTick();
		expect(w.find('[data-testid="oauth-verification-link"]').exists()).toBe(false);
		expect(w.find('[data-testid="oauth-user-code"]').exists()).toBe(false);
		// rawText 非字符串 → '' → 不渲染兜底块
		expect(w.find('[data-testid="oauth-raw-text"]').exists()).toBe(false);
		w.unmount();
	});

	test('Open link button calls openExternalUrl with verificationUri', async () => {
		const ctl = makeLogin();
		const w = makeWrapper({ loginOauth: ctl.loginOauth });
		ctl.onAccepted(accepted());
		await w.vm.$nextTick();
		await w.find('[data-testid="oauth-open-link"]').trigger('click');
		expect(openExternalUrlMock).toHaveBeenCalledWith('https://github.com/login/device');
		w.unmount();
	});
});

describe('ProviderOAuthLoginStep — phase-2 terminal', () => {
	test('success (profileIds[]) → emits success with first profileId; no error notify', async () => {
		const ctl = makeLogin();
		const w = makeWrapper({ loginOauth: ctl.loginOauth });
		ctl.onAccepted(accepted());
		await w.vm.$nextTick();
		ctl.resolve({ status: 'ok', provider: 'github-copilot', profileIds: ['github-copilot:default'] });
		await flushPromises();
		expect(w.emitted('success')?.[0]).toEqual([{ provider: 'github-copilot', profileId: 'github-copilot:default' }]);
		expect(mockNotify.error).not.toHaveBeenCalled();
		w.unmount();
	});

	test('success (B2 profileId) → emits success with that profileId', async () => {
		const ctl = makeLogin();
		const w = makeWrapper({ loginOauth: ctl.loginOauth, provider: 'minimax-portal' });
		ctl.onAccepted(accepted({ provider: 'minimax-portal' }));
		await w.vm.$nextTick();
		ctl.resolve({ status: 'ok', profileId: 'minimax-portal:default' });
		await flushPromises();
		expect(w.emitted('success')?.[0]).toEqual([{ provider: 'minimax-portal', profileId: 'minimax-portal:default' }]);
		w.unmount();
	});

	test('success with no profile fields → emits success with undefined profileId', async () => {
		const ctl = makeLogin();
		const w = makeWrapper({ loginOauth: ctl.loginOauth });
		ctl.onAccepted(accepted());
		await w.vm.$nextTick();
		ctl.resolve({ status: 'ok' });
		await flushPromises();
		expect(w.emitted('success')?.[0]).toEqual([{ provider: 'github-copilot', profileId: undefined }]);
		w.unmount();
	});

	test.each([
		['OAUTH_FAILED', 'modelConfig.providerAuth.oauth.errors.OAUTH_FAILED'],
		['OAUTH_TIMEOUT', 'modelConfig.providerAuth.oauth.errors.OAUTH_TIMEOUT'],
		['IO_FAILED', 'modelConfig.providerAuth.oauth.errors.IO_FAILED'],
		['NOT_FOUND', 'modelConfig.providerAuth.oauth.errors.NOT_FOUND'],
	])('phase-2 error %s → error state with mapped key + notify', async (code, key) => {
		const ctl = makeLogin();
		const w = makeWrapper({ loginOauth: ctl.loginOauth });
		ctl.onAccepted(accepted());
		await w.vm.$nextTick();
		ctl.reject(Object.assign(new Error('boom'), { code }));
		await flushPromises();
		expect(w.find('[data-testid="oauth-error"]').text()).toBe(key);
		expect(mockNotify.error).toHaveBeenCalledWith(key);
		expect(w.emitted('cancel')).toBeFalsy();
		w.unmount();
	});

	test('unknown error code → generic failed key', async () => {
		const ctl = makeLogin();
		const w = makeWrapper({ loginOauth: ctl.loginOauth });
		ctl.onAccepted(accepted());
		await w.vm.$nextTick();
		ctl.reject(Object.assign(new Error('weird'), { code: 'RPC_TIMEOUT' }));
		await flushPromises();
		expect(w.find('[data-testid="oauth-error"]').text()).toBe('modelConfig.providerAuth.oauth.failed');
		expect(mockNotify.error).toHaveBeenCalledWith('modelConfig.providerAuth.oauth.failed');
		w.unmount();
	});

	test('error without object code → generic failed key', async () => {
		const ctl = makeLogin();
		const w = makeWrapper({ loginOauth: ctl.loginOauth });
		ctl.onAccepted(accepted());
		await w.vm.$nextTick();
		ctl.reject('string error');
		await flushPromises();
		expect(w.find('[data-testid="oauth-error"]').text()).toBe('modelConfig.providerAuth.oauth.failed');
		w.unmount();
	});

	test('single-frame error before accepted (NOT_FOUND) → error state without ever showing pending', async () => {
		const ctl = makeLogin();
		const w = makeWrapper({ loginOauth: ctl.loginOauth });
		// 未触发 onAccepted，直接 reject（plugin 单帧 NOT_FOUND）
		ctl.reject(Object.assign(new Error('no method'), { code: 'NOT_FOUND' }));
		await flushPromises();
		expect(w.find('[data-testid="oauth-error"]').text()).toBe('modelConfig.providerAuth.oauth.errors.NOT_FOUND');
		// 始终未进 pending（无受理帧）
		expect(w.find('[data-testid="oauth-user-code"]').exists()).toBe(false);
		// 错误操作 notify（映同一 key）
		expect(mockNotify.error).toHaveBeenCalledWith('modelConfig.providerAuth.oauth.errors.NOT_FOUND');
		w.unmount();
	});
});

describe('ProviderOAuthLoginStep — cancel', () => {
	test('OAUTH_CANCELLED reject → silent: emits cancel, no error, no notify', async () => {
		const ctl = makeLogin();
		const w = makeWrapper({ loginOauth: ctl.loginOauth });
		ctl.onAccepted(accepted());
		await w.vm.$nextTick();
		ctl.reject(Object.assign(new Error('cancelled'), { code: 'OAUTH_CANCELLED' }));
		await flushPromises();
		expect(w.emitted('cancel')).toBeTruthy();
		expect(w.find('[data-testid="oauth-error"]').exists()).toBe(false);
		expect(mockNotify.error).not.toHaveBeenCalled();
		w.unmount();
	});

	test('ERR_CANCELED reject (local abort) → silent cancel', async () => {
		const ctl = makeLogin();
		const w = makeWrapper({ loginOauth: ctl.loginOauth });
		ctl.onAccepted(accepted());
		await w.vm.$nextTick();
		ctl.reject(Object.assign(new Error('aborted'), { code: 'ERR_CANCELED' }));
		await flushPromises();
		expect(w.emitted('cancel')).toBeTruthy();
		expect(mockNotify.error).not.toHaveBeenCalled();
		// 静默取消：不进 error 态（不渲染错误文案）
		expect(w.find('[data-testid="oauth-error"]').exists()).toBe(false);
		w.unmount();
	});

	test('onCancel() in pending → calls cancelOauth(loginId) + emits cancel; late resolve ignored', async () => {
		// 取消按钮已上移到父对话框 footer，footer 经 $refs 调本组件 onCancel()
		const ctl = makeLogin();
		const cancelOauth = vi.fn().mockResolvedValue({});
		const w = makeWrapper({ loginOauth: ctl.loginOauth, cancelOauth });
		ctl.onAccepted(accepted());
		await w.vm.$nextTick();
		w.vm.onCancel();
		await w.vm.$nextTick();
		expect(cancelOauth).toHaveBeenCalledWith({ loginId: 'login-1' });
		expect(w.emitted('cancel')).toBeTruthy();
		// 取消后 in-flight promise 即便 resolve 也被 token 作废，不再 emit success
		ctl.resolve({ status: 'ok', profileIds: ['x'] });
		await flushPromises();
		expect(w.emitted('success')).toBeFalsy();
		w.unmount();
	});

	test('Cancel during starting (no loginId yet) → emits cancel, does NOT call cancelOauth', async () => {
		const ctl = makeLogin();
		const cancelOauth = vi.fn().mockResolvedValue({});
		const w = makeWrapper({ loginOauth: ctl.loginOauth, cancelOauth });
		// 还没 accepted（starting 态）
		await w.vm.$nextTick();
		w.vm.onCancel();
		expect(cancelOauth).not.toHaveBeenCalled();
		expect(w.emitted('cancel')).toBeTruthy();
		w.unmount();
	});

	test('beforeUnmount with in-flight login cancels backend polling (best-effort)', async () => {
		const ctl = makeLogin();
		const cancelOauth = vi.fn().mockResolvedValue({});
		const w = makeWrapper({ loginOauth: ctl.loginOauth, cancelOauth });
		ctl.onAccepted(accepted());
		await w.vm.$nextTick();
		w.unmount();
		expect(cancelOauth).toHaveBeenCalledWith({ loginId: 'login-1' });
	});
});

describe('ProviderOAuthLoginStep — retry + missing channel', () => {
	test('start() from error restarts login', async () => {
		// 重试按钮已上移到父对话框 footer，footer 经 $refs 调本组件 start()
		const ctl = makeLogin();
		const w = makeWrapper({ loginOauth: ctl.loginOauth });
		ctl.onAccepted(accepted());
		await w.vm.$nextTick();
		ctl.reject(Object.assign(new Error('boom'), { code: 'OAUTH_FAILED' }));
		await flushPromises();
		expect(w.find('[data-testid="oauth-error"]').exists()).toBe(true);
		w.vm.start();
		await w.vm.$nextTick();
		expect(ctl.loginOauth).toHaveBeenCalledTimes(2);
		expect(w.find('[data-testid="oauth-starting"]').exists()).toBe(true);
		w.unmount();
	});

	test('onBack() from error emits cancel', async () => {
		// 返回按钮已上移到父对话框 footer，footer 经 $refs 调本组件 onBack()
		const ctl = makeLogin();
		const w = makeWrapper({ loginOauth: ctl.loginOauth });
		ctl.onAccepted(accepted());
		await w.vm.$nextTick();
		ctl.reject(Object.assign(new Error('boom'), { code: 'OAUTH_FAILED' }));
		await flushPromises();
		w.vm.onBack();
		expect(w.emitted('cancel')).toBeTruthy();
		w.unmount();
	});

	test('emits update:phase on mount and on each phase transition', async () => {
		// 父对话框 footer 依赖 update:phase 切换动作按钮（starting→pending→error）
		const ctl = makeLogin();
		const w = makeWrapper({ loginOauth: ctl.loginOauth });
		// 挂载即上抛初始 starting
		expect(w.emitted('update:phase')?.[0]).toEqual(['starting']);
		ctl.onAccepted(accepted());
		await w.vm.$nextTick();
		ctl.reject(Object.assign(new Error('boom'), { code: 'OAUTH_FAILED' }));
		await flushPromises();
		const phases = (w.emitted('update:phase') || []).map(e => e[0]);
		expect(phases).toContain('pending');
		expect(phases[phases.length - 1]).toBe('error');
		w.unmount();
	});

	test('no loginOauth prop → immediate error state + notify connError', async () => {
		const w = makeWrapper({ loginOauth: null });
		await w.vm.$nextTick();
		expect(w.find('[data-testid="oauth-error"]').text()).toBe('modelConfig.common.connError');
		expect(mockNotify.error).toHaveBeenCalledWith('modelConfig.common.connError');
		w.unmount();
	});
});
