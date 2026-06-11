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

// 复制授权码走跨平台 writeClipboardText：mock 掉，避免真访问剪贴板
const writeClipboardTextMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../utils/clipboard.js', () => ({
	writeClipboardText: writeClipboardTextMock,
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
			stubs: {
				UButton: UButtonStub,
				UIcon: { props: ['name'], template: '<i :data-icon="name" />' },
			},
			mocks: {
				$t: (key, params) => params ? `${key}|${JSON.stringify(params)}` : key,
			},
		},
	});
}

// phase-1 受理帧默认形态（B1 账号授权）
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
		expect(raw.classes()).toContain('cc-scrollbar-thin'); // Electron 细滚动条 marker（web 下惰性）
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

	test('clicking the verification link calls openExternalUrl with verificationUri', async () => {
		const ctl = makeLogin();
		const w = makeWrapper({ loginOauth: ctl.loginOauth });
		ctl.onAccepted(accepted());
		await w.vm.$nextTick();
		await w.find('[data-testid="oauth-verification-link"]').trigger('click');
		expect(openExternalUrlMock).toHaveBeenCalledWith('https://github.com/login/device');
		w.unmount();
	});

	test('copy button copies the user code, shows inline "copied", no toast', async () => {
		const ctl = makeLogin();
		const w = makeWrapper({ loginOauth: ctl.loginOauth });
		ctl.onAccepted(accepted());
		await w.vm.$nextTick();
		await w.find('[data-testid="oauth-copy-code"]').trigger('click');
		await flushPromises();
		expect(writeClipboardTextMock).toHaveBeenCalledWith('ABCD-1234');
		expect(w.vm.codeCopied).toBe(true);
		expect(w.find('[data-testid="oauth-code-copied"]').exists()).toBe(true);
		// 复制后按钮隐去，只留“已复制”文案（避免按钮+文案双重反馈）
		expect(w.find('[data-testid="oauth-copy-code"]').exists()).toBe(false);
		expect(mockNotify.error).not.toHaveBeenCalled();
		w.unmount();
	});

	test('copied state reverts to copyable after 3s', async () => {
		vi.useFakeTimers();
		try {
			const ctl = makeLogin();
			const w = makeWrapper({ loginOauth: ctl.loginOauth });
			ctl.onAccepted(accepted());
			await w.vm.$nextTick();
			w.vm.onCopyCode();
			await Promise.resolve();
			await Promise.resolve();
			await w.vm.$nextTick();
			expect(w.vm.codeCopied).toBe(true);
			vi.advanceTimersByTime(3000);
			await w.vm.$nextTick();
			expect(w.vm.codeCopied).toBe(false);
			expect(w.find('[data-testid="oauth-code-copied"]').exists()).toBe(false);
			// 文案消失后复制按钮恢复
			expect(w.find('[data-testid="oauth-copy-code"]').exists()).toBe(true);
			w.unmount();
		}
		finally {
			vi.useRealTimers();
		}
	});

	test('copy failure → notify.error(copyFailed), codeCopied stays false', async () => {
		writeClipboardTextMock.mockRejectedValueOnce(new Error('clip fail'));
		const ctl = makeLogin();
		const w = makeWrapper({ loginOauth: ctl.loginOauth });
		ctl.onAccepted(accepted());
		await w.vm.$nextTick();
		await w.find('[data-testid="oauth-copy-code"]').trigger('click');
		await flushPromises();
		expect(mockNotify.error).toHaveBeenCalledWith('common.copyFailed');
		expect(w.vm.codeCopied).toBe(false);
		w.unmount();
	});

	test('user code hidden when embedded in the verification URL (e.g. minimax-portal)', async () => {
		const ctl = makeLogin();
		const w = makeWrapper({ loginOauth: ctl.loginOauth });
		ctl.onAccepted(accepted({ verificationUri: 'https://portal.example.com/auth?code=ABCD-1234', userCode: 'ABCD-1234' }));
		await w.vm.$nextTick();
		// 码已嵌进链接 → 不再单列码块（含复制按钮）；用户直接点链接即可
		expect(w.find('[data-testid="oauth-user-code"]').exists()).toBe(false);
		expect(w.find('[data-testid="oauth-copy-code"]').exists()).toBe(false);
		expect(w.find('[data-testid="oauth-verification-link"]').exists()).toBe(true);
		w.unmount();
	});

	test('pending shows a spinning loader next to the waiting hint', async () => {
		const ctl = makeLogin();
		const w = makeWrapper({ loginOauth: ctl.loginOauth });
		ctl.onAccepted(accepted());
		await w.vm.$nextTick();
		const spinner = w.find('[data-icon="i-lucide-loader-2"]');
		expect(spinner.exists()).toBe(true);
		expect(spinner.classes()).toContain('animate-spin');
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
	])('phase-2 error %s → error state with mapped key (inline only, no toast)', async (code, key) => {
		const ctl = makeLogin();
		const w = makeWrapper({ loginOauth: ctl.loginOauth });
		ctl.onAccepted(accepted());
		await w.vm.$nextTick();
		ctl.reject(Object.assign(new Error('boom'), { code }));
		await flushPromises();
		expect(w.find('[data-testid="oauth-error"]').text()).toBe(key);
		// 失败只走常驻 inline error + footer 动作，不再弹 toast
		expect(mockNotify.error).not.toHaveBeenCalled();
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
		expect(mockNotify.error).not.toHaveBeenCalled();
		w.unmount();
	});

	test('error without object code → generic failed key; no detail line (no usable message)', async () => {
		const ctl = makeLogin();
		const w = makeWrapper({ loginOauth: ctl.loginOauth });
		ctl.onAccepted(accepted());
		await w.vm.$nextTick();
		ctl.reject('string error');
		await flushPromises();
		expect(w.find('[data-testid="oauth-error"]').text()).toBe('modelConfig.providerAuth.oauth.failed');
		// 非对象 reject 无 message → 不渲染原始详情行
		expect(w.find('[data-testid="oauth-error-detail"]').exists()).toBe(false);
		w.unmount();
	});

	test('failure renders the raw error message as a muted detail line (no translation)', async () => {
		const ctl = makeLogin();
		const w = makeWrapper({ loginOauth: ctl.loginOauth });
		ctl.onAccepted(accepted());
		await w.vm.$nextTick();
		const raw = 'device-code login for github-copilot returned no credentials';
		ctl.reject(Object.assign(new Error(raw), { code: 'OAUTH_FAILED' }));
		await flushPromises();
		const detail = w.find('[data-testid="oauth-error-detail"]');
		expect(detail.exists()).toBe(true);
		// 原始 message 原文展示、不经 $t 翻译（供用户截屏反馈定位）
		expect(detail.text()).toBe(raw);
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
		// 失败只走常驻 inline error，不弹 toast
		expect(mockNotify.error).not.toHaveBeenCalled();
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

	test('start() resets a lingering copied state so the fresh code is copyable', async () => {
		// pending→复制(已复制)→失败→重试 窄路径：重发起须复位 codeCopied，否则新码错显“已复制”
		const ctl = makeLogin();
		const w = makeWrapper({ loginOauth: ctl.loginOauth });
		ctl.onAccepted(accepted());
		await w.vm.$nextTick();
		await w.find('[data-testid="oauth-copy-code"]').trigger('click');
		await flushPromises();
		expect(w.vm.codeCopied).toBe(true);
		ctl.reject(Object.assign(new Error('boom'), { code: 'OAUTH_FAILED' }));
		await flushPromises();
		// 重发起即复位（无需等 3s 计时器自愈）
		w.vm.start();
		await w.vm.$nextTick();
		expect(w.vm.codeCopied).toBe(false);
		// 新一轮拿到码后是可复制态，不是残留的“已复制”
		ctl.onAccepted(accepted());
		await w.vm.$nextTick();
		expect(w.find('[data-testid="oauth-copy-code"]').exists()).toBe(true);
		expect(w.find('[data-testid="oauth-code-copied"]').exists()).toBe(false);
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

	test('no loginOauth prop → immediate error state (inline connError, no toast)', async () => {
		const w = makeWrapper({ loginOauth: null });
		await w.vm.$nextTick();
		expect(w.find('[data-testid="oauth-error"]').text()).toBe('modelConfig.common.connError');
		// 通道缺失非后端报错，无原始 message → 不渲染详情行
		expect(w.find('[data-testid="oauth-error-detail"]').exists()).toBe(false);
		expect(mockNotify.error).not.toHaveBeenCalled();
		w.unmount();
	});
});
