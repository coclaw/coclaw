import { mount, flushPromises } from '@vue/test-utils';
import { test, expect, describe, vi, beforeEach } from 'vitest';

// --- mock 平台跳转：避免真触发 window.open / openExternalUrl 副作用 ---
const openExternalUrlMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../utils/external-url.js', () => ({
	openExternalUrl: openExternalUrlMock,
}));

// env store：可写的 ltMd 控制移动端分支
const envState = vi.hoisted(() => ({ screen: { ltMd: false } }));
vi.mock('../../stores/env.store.js', () => ({
	useEnvStore: () => envState,
}));

import AddProviderDialog from './AddProviderDialog.vue';

const UButtonStub = {
	props: { disabled: { type: Boolean, default: false }, loading: { type: Boolean, default: false } },
	emits: ['click'],
	template: '<button :disabled="disabled || loading" :data-loading="loading" @click="$emit(\'click\')"><slot /></button>',
};

const UInputStub = {
	props: ['modelValue', 'disabled', 'placeholder', 'type', 'icon', 'autocomplete', 'spellcheck', 'id'],
	emits: ['update:modelValue', 'keydown'],
	template: `<input
		:id="id"
		:type="type ?? 'text'"
		:disabled="disabled"
		:placeholder="placeholder"
		:value="modelValue"
		:data-type="type"
		@input="$emit('update:modelValue', $event.target.value)"
		@keydown.enter="$emit('keydown', $event)"
	/>`,
};

const UIconStub = { props: ['name'], template: '<span :data-icon="name" />' };

const UModalStub = {
	props: ['open', 'fullscreen', 'ui', 'title', 'description'],
	emits: ['update:open'],
	template: `<div
		v-if="open"
		class="u-modal-stub"
		:data-fullscreen="String(fullscreen)"
		:data-title="title"
		:data-ui-body="ui?.body ?? ''"
		:data-ui-header="ui?.header ?? ''"
		:data-ui-footer="ui?.footer ?? ''"
	>
		<header class="modal-header">{{ title }}</header>
		<div class="modal-body"><slot name="body" /></div>
		<div class="modal-footer"><slot name="footer" /></div>
	</div>`,
};

const catalog = [
	{ id: 'gpt-4', provider: 'openai' },
	{ id: 'gpt-3.5', provider: 'openai' },
	{ id: 'claude-sonnet', provider: 'anthropic' },
	{ id: 'llama-3.3-70b-versatile', provider: 'groq' },
	{ id: 'gpt-mystery', provider: 'mystery' }, // 未在 PROVIDER_META
];

function makeWrapper(props = {}) {
	return mount(AddProviderDialog, {
		props: {
			open: true,
			catalog,
			existingProviders: [],
			setApiKey: vi.fn().mockResolvedValue({ profileId: 'openai:default' }),
			...props,
		},
		global: {
			stubs: { UButton: UButtonStub, UInput: UInputStub, UModal: UModalStub, UIcon: UIconStub },
			mocks: {
				$t: (key, params) => params ? `${key}|${JSON.stringify(params)}` : key,
			},
		},
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	envState.screen.ltMd = false;
});

describe('AddProviderDialog — Step 1 (select)', () => {
	test('shows popular and other groups; excludes already-bound providers', () => {
		const w = makeWrapper({ existingProviders: ['openai'] });
		// openai 排除：不应渲染 item
		expect(w.find('[data-testid="add-provider-item-openai"]').exists()).toBe(false);
		// anthropic (popular) + groq (popular) + mystery (other) 应有
		expect(w.find('[data-testid="add-provider-item-anthropic"]').exists()).toBe(true);
		expect(w.find('[data-testid="add-provider-item-groq"]').exists()).toBe(true);
		expect(w.find('[data-testid="add-provider-item-mystery"]').exists()).toBe(true);
		// 标题是 Step 1
		expect(w.find('.modal-header').text()).toBe('modelConfig.providerAuth.add.stepSelectTitle');
		// Submit button 不该出现在 Step 1
		expect(w.find('[data-testid="add-provider-submit"]').exists()).toBe(false);
	});

	test('deduplicates providers (catalog has multiple models per provider)', () => {
		const w = makeWrapper();
		// openai 有两个 model 但只该出现一次 item
		const items = w.findAll('[data-testid^="add-provider-item-openai"]');
		expect(items).toHaveLength(1);
	});

	test('search filters by id and displayName (case-insensitive)', async () => {
		const w = makeWrapper();
		const search = w.find('[data-testid="add-provider-search"]');
		await search.setValue('claude');
		// Anthropic 的 displayName 是 "Anthropic Claude"，应命中
		expect(w.find('[data-testid="add-provider-item-anthropic"]').exists()).toBe(true);
		expect(w.find('[data-testid="add-provider-item-openai"]').exists()).toBe(false);
		// 切搜索词
		await search.setValue('GroQ');
		expect(w.find('[data-testid="add-provider-item-groq"]').exists()).toBe(true);
		expect(w.find('[data-testid="add-provider-item-anthropic"]').exists()).toBe(false);
	});

	test('search with no matches shows empty hint', async () => {
		const w = makeWrapper();
		await w.find('[data-testid="add-provider-search"]').setValue('zzz-nonexistent');
		expect(w.find('[data-testid="add-provider-empty"]').exists()).toBe(true);
	});

	test('clicking a provider transitions to Step 2 (configure)', async () => {
		const w = makeWrapper();
		await w.find('[data-testid="add-provider-item-groq"]').trigger('click');
		// 标题切到 stepConfigTitle，带原生 provider id（不再用映射名）
		expect(w.find('.modal-header').text()).toContain('modelConfig.providerAuth.add.stepConfigTitle');
		expect(w.find('.modal-header').text()).toContain('groq');
		// Step 2 元素出现
		expect(w.find('[data-testid="add-provider-key-input"]').exists()).toBe(true);
		expect(w.find('[data-testid="add-provider-submit"]').exists()).toBe(true);
	});

	test('UModal close (mask / Esc / X) on Step 1 closes the dialog (no footer cancel)', async () => {
		const w = makeWrapper();
		const modal = w.findComponent(UModalStub);
		modal.vm.$emit('update:open', false);
		await w.vm.$nextTick();
		expect(w.emitted('update:open')).toBeTruthy();
		expect(w.emitted('update:open')[0]).toEqual([false]);
	});
});

describe('AddProviderDialog — Step 2 (configure / key input)', () => {
	async function goToStep2(w, providerId = 'groq') {
		await w.find(`[data-testid="add-provider-item-${providerId}"]`).trigger('click');
		return w;
	}

	test('renders password-type input (raw HTML type=password)', async () => {
		const w = await goToStep2(makeWrapper());
		const input = w.find('[data-testid="add-provider-key-input"]');
		expect(input.attributes('type')).toBe('password');
	});

	test('shows dashboard link when provider has dashboardUrl (groq has one)', async () => {
		const w = await goToStep2(makeWrapper());
		expect(w.find('[data-testid="add-provider-dashboard-link"]').exists()).toBe(true);
	});

	test('does NOT show dashboard link for provider without dashboardUrl (mystery)', async () => {
		const w = await goToStep2(makeWrapper(), 'mystery');
		expect(w.find('[data-testid="add-provider-dashboard-link"]').exists()).toBe(false);
	});

	test('clicking dashboard link calls openExternalUrl with the catalog URL', async () => {
		const w = await goToStep2(makeWrapper(), 'groq');
		await w.find('[data-testid="add-provider-dashboard-link"]').trigger('click');
		expect(openExternalUrlMock).toHaveBeenCalledWith('https://console.groq.com/keys');
	});

	test('UModal close (mask / Esc / X) on Step 2 closes the dialog without calling RPC', async () => {
		const w = await goToStep2(makeWrapper());
		const modal = w.findComponent(UModalStub);
		modal.vm.$emit('update:open', false);
		await w.vm.$nextTick();
		expect(w.emitted('update:open')).toBeTruthy();
		expect(w.emitted('update:open')[w.emitted('update:open').length - 1]).toEqual([false]);
		// 关闭不该触发任何 setApiKey 调用
		expect(w.vm.$props.setApiKey).not.toHaveBeenCalled();
	});

	test('submit with empty key shows inline INVALID_ARGS error and does NOT call RPC', async () => {
		const setApiKey = vi.fn().mockResolvedValue({});
		const w = await goToStep2(makeWrapper({ setApiKey }));
		// key 留空，直接 submit
		await w.find('[data-testid="add-provider-submit"]').trigger('click');
		await flushPromises();
		expect(setApiKey).not.toHaveBeenCalled();
		expect(w.find('[data-testid="add-provider-error"]').exists()).toBe(true);
		expect(w.find('[data-testid="add-provider-error"]').text()).toBe('modelConfig.common.errInvalidArgs');
	});

	test('submit with whitespace-only key shows inline INVALID_ARGS (trim before check)', async () => {
		const setApiKey = vi.fn().mockResolvedValue({});
		const w = await goToStep2(makeWrapper({ setApiKey }));
		await w.find('[data-testid="add-provider-key-input"]').setValue('   \t   ');
		await w.find('[data-testid="add-provider-submit"]').trigger('click');
		await flushPromises();
		expect(setApiKey).not.toHaveBeenCalled();
		expect(w.find('[data-testid="add-provider-error"]').text()).toBe('modelConfig.common.errInvalidArgs');
	});

	test('apiKey field is cleared SYNCHRONOUSLY on submit, before the RPC resolves (no lingering raw key)', async () => {
		let resolveSet;
		const setApiKey = vi.fn(() => new Promise(res => { resolveSet = res; }));
		const w = await goToStep2(makeWrapper({ setApiKey }));
		await w.find('[data-testid="add-provider-key-input"]').setValue('gsk_secret_value');
		await w.find('[data-testid="add-provider-submit"]').trigger('click');
		// RPC is in-flight (never resolved yet) — the data field must already be empty
		expect(w.vm.apiKey).toBe('');
		// but the RPC received the real trimmed key (carried by a local copy)
		expect(setApiKey).toHaveBeenCalledTimes(1);
		expect(setApiKey.mock.calls[0][0].apiKey).toBe('gsk_secret_value');
		// settle to avoid orphan async after unmount
		resolveSet({ profileId: 'groq:default' });
		await flushPromises();
	});

	test('submit success: trims key, calls RPC, emits added, closes dialog', async () => {
		const setApiKey = vi.fn().mockResolvedValue({ profileId: 'groq:default' });
		const w = await goToStep2(makeWrapper({ setApiKey }));
		await w.find('[data-testid="add-provider-key-input"]').setValue('  gsk_abc12345  ');
		await w.find('[data-testid="add-provider-submit"]').trigger('click');
		await flushPromises();
		// RPC 被 trim 后的 key 调用（包含 timeout 字段是实现细节，断言关键的两个字段）
		expect(setApiKey).toHaveBeenCalledTimes(1);
		const callArgs = setApiKey.mock.calls[0][0];
		expect(callArgs.provider).toBe('groq');
		expect(callArgs.apiKey).toBe('gsk_abc12345');
		// added 事件 + close
		expect(w.emitted('added')?.[0]).toEqual([{ provider: 'groq', profileId: 'groq:default' }]);
		const openEvents = w.emitted('update:open');
		expect(openEvents[openEvents.length - 1]).toEqual([false]);
		// apiKey 字段在 data 上立刻清空
		expect(w.vm.apiKey).toBe('');
	});

	test('submit failure maps error code to inline message (INVALID_ARGS)', async () => {
		const setApiKey = vi.fn().mockRejectedValue(Object.assign(new Error('bad'), { code: 'INVALID_ARGS' }));
		const w = await goToStep2(makeWrapper({ setApiKey }));
		await w.find('[data-testid="add-provider-key-input"]').setValue('gsk_abc');
		await w.find('[data-testid="add-provider-submit"]').trigger('click');
		await flushPromises();
		expect(w.find('[data-testid="add-provider-error"]').text()).toBe('modelConfig.common.errInvalidArgs');
		// 失败不关闭
		const openEvents = w.emitted('update:open');
		expect(openEvents?.some(e => e[0] === false)).not.toBe(true);
		// apiKey 失败也清空（不在内存里多留）
		expect(w.vm.apiKey).toBe('');
	});

	test('submit failure with IO_FAILED → inline errIoFailed', async () => {
		const setApiKey = vi.fn().mockRejectedValue(Object.assign(new Error('io'), { code: 'IO_FAILED' }));
		const w = await goToStep2(makeWrapper({ setApiKey }));
		await w.find('[data-testid="add-provider-key-input"]').setValue('gsk_abc');
		await w.find('[data-testid="add-provider-submit"]').trigger('click');
		await flushPromises();
		expect(w.find('[data-testid="add-provider-error"]').text()).toBe('modelConfig.common.errIoFailed');
	});

	test('submit failure with connection code → inline connError', async () => {
		const setApiKey = vi.fn().mockRejectedValue(Object.assign(new Error('to'), { code: 'RPC_TIMEOUT' }));
		const w = await goToStep2(makeWrapper({ setApiKey }));
		await w.find('[data-testid="add-provider-key-input"]').setValue('gsk_abc');
		await w.find('[data-testid="add-provider-submit"]').trigger('click');
		await flushPromises();
		expect(w.find('[data-testid="add-provider-error"]').text()).toBe('modelConfig.common.connError');
	});

	test('submit failure with unknown error → inline generic submitFailed key', async () => {
		const setApiKey = vi.fn().mockRejectedValue(new Error('weird'));
		const w = await goToStep2(makeWrapper({ setApiKey }));
		await w.find('[data-testid="add-provider-key-input"]').setValue('gsk_abc');
		await w.find('[data-testid="add-provider-submit"]').trigger('click');
		await flushPromises();
		expect(w.find('[data-testid="add-provider-error"]').text()).toBe('modelConfig.providerAuth.add.submitFailed');
	});

	test('submit while busy (no resolve): second click is ignored (one RPC)', async () => {
		let resolveSet;
		const setApiKey = vi.fn(() => new Promise(res => { resolveSet = res; }));
		const w = await goToStep2(makeWrapper({ setApiKey }));
		await w.find('[data-testid="add-provider-key-input"]').setValue('gsk_abc');
		await w.find('[data-testid="add-provider-submit"]').trigger('click');
		await Promise.resolve();
		// 第二次点击应被 submitting 拦下
		await w.find('[data-testid="add-provider-submit"]').trigger('click');
		await Promise.resolve();
		expect(setApiKey).toHaveBeenCalledTimes(1);
		// 收尾 settle
		resolveSet({ profileId: 'groq:default' });
		await flushPromises();
	});

	test('mask / Esc close ignored while submitting', async () => {
		let resolveSet;
		const setApiKey = vi.fn(() => new Promise(res => { resolveSet = res; }));
		const w = await goToStep2(makeWrapper({ setApiKey }));
		await w.find('[data-testid="add-provider-key-input"]').setValue('gsk_abc');
		await w.find('[data-testid="add-provider-submit"]').trigger('click');
		await Promise.resolve();
		// 提交中 mask/Esc 关闭：应被 submitting 守卫挡下（onModalOpenChange）
		w.findComponent(UModalStub).vm.$emit('update:open', false);
		await Promise.resolve();
		// 没有发出 false 的 update:open（除非 RPC 完成后）
		const openEvents = w.emitted('update:open');
		expect(openEvents?.some(e => e[0] === false)).not.toBe(true);
		// settle 让 unmount 别孤儿
		resolveSet({ profileId: 'g' });
		await flushPromises();
	});

	test('Enter key on input triggers submit', async () => {
		const setApiKey = vi.fn().mockResolvedValue({ profileId: 'groq:default' });
		const w = await goToStep2(makeWrapper({ setApiKey }));
		const input = w.find('[data-testid="add-provider-key-input"]');
		await input.setValue('gsk_abc');
		// 触发 keydown.enter
		await input.trigger('keydown.enter');
		await flushPromises();
		expect(setApiKey).toHaveBeenCalledTimes(1);
	});

	test('NEVER logs raw key (no console.log call mentions input value)', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const setApiKey = vi.fn().mockRejectedValue(Object.assign(new Error('bad'), { code: 'INVALID_ARGS' }));
		const w = await goToStep2(makeWrapper({ setApiKey }));
		const raw = 'gsk_thisShouldNeverLeak_8888';
		await w.find('[data-testid="add-provider-key-input"]').setValue(raw);
		await w.find('[data-testid="add-provider-submit"]').trigger('click');
		await flushPromises();
		for (const spy of [logSpy, warnSpy, errSpy]) {
			for (const call of spy.mock.calls) {
				for (const arg of call) {
					const s = typeof arg === 'string' ? arg : JSON.stringify(arg);
					expect(s).not.toContain(raw);
				}
			}
		}
		logSpy.mockRestore();
		warnSpy.mockRestore();
		errSpy.mockRestore();
	});

	test('NO setApiKey prop: submit shows inline connError, does not throw', async () => {
		const w = await goToStep2(makeWrapper({ setApiKey: null }));
		await w.find('[data-testid="add-provider-key-input"]').setValue('gsk');
		await w.find('[data-testid="add-provider-submit"]').trigger('click');
		await flushPromises();
		expect(w.find('[data-testid="add-provider-error"]').text()).toBe('modelConfig.common.connError');
	});
});

describe('AddProviderDialog — open/close lifecycle', () => {
	test('Reopening resets step to select + clears any prior key/state', async () => {
		const w = makeWrapper({ open: false });
		// 模拟"父组件 open 它"
		await w.setProps({ open: true });
		expect(w.vm.step).toBe('select');
		// 进 Step 2
		await w.find('[data-testid="add-provider-item-groq"]').trigger('click');
		expect(w.vm.step).toBe('configure');
		// 关闭
		await w.setProps({ open: false });
		// 重开应回到 Step 1
		await w.setProps({ open: true });
		expect(w.vm.step).toBe('select');
		expect(w.vm.apiKey).toBe('');
		expect(w.vm.inlineErrorKey).toBe('');
	});

	test('Closing clears apiKey field (no in-memory residual)', async () => {
		const w = makeWrapper({ open: true });
		await w.find('[data-testid="add-provider-item-groq"]').trigger('click');
		await w.find('[data-testid="add-provider-key-input"]').setValue('gsk_xyz');
		// close
		await w.setProps({ open: false });
		expect(w.vm.apiKey).toBe('');
	});
});

describe('AddProviderDialog — mobile / desktop layout', () => {
	// 布局/安全区现由全局 modal 主题统一提供（见 constants/modal-theme.js + 其单测），
	// 本组件只负责 fullscreen 开关；不再在实例 ui 上设 padding/safe-area。
	test('mobile (ltMd=true): UModal fullscreen=true', () => {
		envState.screen.ltMd = true;
		const w = makeWrapper();
		expect(w.find('.u-modal-stub').attributes('data-fullscreen')).toBe('true');
	});

	test('desktop (ltMd=false): fullscreen=false', () => {
		envState.screen.ltMd = false;
		const w = makeWrapper();
		expect(w.find('.u-modal-stub').attributes('data-fullscreen')).toBe('false');
	});
});
