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

// 子组件 ProviderOAuthLoginStep 透传 import use-notify → @nuxt/ui 桶口的 #imports 会拖炸 vitest，
// 即便本测试 stub 了该子组件，模块 import 链仍会加载真实 use-notify。统一 mock 掉（memory
// feedback_ui_avoid_nuxt_ui_in_stores）。
vi.mock('../../composables/use-notify.js', () => ({
	useNotify: () => ({ success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() }),
}));

import AddProviderDialog from './AddProviderDialog.vue';
import { promptModalUi } from '../../constants/prompt-modal-ui.js';

const UButtonStub = {
	props: { disabled: { type: Boolean, default: false }, loading: { type: Boolean, default: false } },
	emits: ['click'],
	template: '<button :disabled="disabled || loading" :data-loading="loading" @click="$emit(\'click\')"><slot /></button>',
};

const UInputStub = {
	props: ['modelValue', 'disabled', 'placeholder', 'type', 'icon', 'autocomplete', 'spellcheck', 'autocapitalize', 'autocorrect', 'id', 'ui'],
	emits: ['update:modelValue', 'keydown'],
	template: `<input
		:id="id"
		:type="type ?? 'text'"
		:class="ui?.base"
		:disabled="disabled"
		:placeholder="placeholder"
		:value="modelValue"
		:data-type="type"
		:autocomplete="autocomplete"
		:spellcheck="spellcheck"
		:autocapitalize="autocapitalize"
		:autocorrect="autocorrect"
		@input="$emit('update:modelValue', $event.target.value)"
		@keydown.enter="$emit('keydown', $event)"
	/>`,
};

const UIconStub = { props: ['name'], template: '<span :data-icon="name" />' };

// 账号授权子步：stub 出来便于断言 props 透传 + 驱动 success/cancel/update:phase 事件。
// 动作（取消/返回/重试）已上移到父 footer，footer 经 $refs 调本 stub 的 onCancel/onBack/start，
// 故 stub 也暴露这三个方法（模拟真组件契约）。oauth-stub-pending/error 供测试驱动 footer 切换。
const ProviderOAuthLoginStepStub = {
	name: 'ProviderOAuthLoginStep',
	props: ['provider', 'loginOauth', 'cancelOauth', 'autoStart'],
	emits: ['success', 'cancel', 'update:phase'],
	mounted() {
		this.$emit('update:phase', 'starting');
	},
	methods: {
		onCancel() { this.$emit('cancel'); },
		onBack() { this.$emit('cancel'); },
		start() { this.$emit('update:phase', 'starting'); },
	},
	template: `<div class="oauth-step-stub" :data-provider="provider" :data-has-login="String(!!loginOauth)" :data-has-cancel="String(!!cancelOauth)">
		<button class="oauth-stub-success" @click="$emit('success', { provider, profileId: provider + ':default' })">ok</button>
		<button class="oauth-stub-cancel" @click="$emit('cancel')">x</button>
		<button class="oauth-stub-pending" @click="$emit('update:phase', 'pending')">p</button>
		<button class="oauth-stub-error" @click="$emit('update:phase', 'error')">e</button>
	</div>`,
};

// UBadge stub：暴露 size 便于断言字号；data-testid 经 attr fallthrough 落到 root span
const UBadgeStub = {
	props: { size: { type: String, default: '' }, color: String, variant: String },
	template: '<span class="ubadge" :data-size="size"><slot /></span>',
};

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

// providerAuth.catalog 出参形态：每 provider 一条 { provider, authMethods, hasCred }
const catalog = [
	{ provider: 'openai', authMethods: ['api-key'], hasCred: false },
	{ provider: 'anthropic', authMethods: ['api-key'], hasCred: false },
	{ provider: 'groq', authMethods: ['api-key'], hasCred: false },
	{ provider: 'mystery', authMethods: ['api-key'], hasCred: false }, // 未在 PROVIDER_META
];

function makeWrapper(props = {}) {
	return mount(AddProviderDialog, {
		props: {
			open: true,
			catalog,
			existingProviders: [],
			setApiKey: vi.fn().mockResolvedValue({ profileId: 'openai:default' }),
			loginOauth: vi.fn(),
			cancelOauth: vi.fn(),
			...props,
		},
		global: {
			stubs: {
				UButton: UButtonStub,
				UInput: UInputStub,
				UModal: UModalStub,
				UIcon: UIconStub,
				UBadge: UBadgeStub,
				ProviderOAuthLoginStep: ProviderOAuthLoginStepStub,
			},
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

	test('deduplicates by provider (defensive: duplicate provider entries collapse to one item)', () => {
		const w = makeWrapper({ catalog: [
			{ provider: 'openai', authMethods: ['api-key'], hasCred: false },
			{ provider: 'openai', authMethods: ['oauth-device-code'], hasCred: false },
		] });
		const items = w.findAll('[data-testid^="add-provider-item-openai"]');
		expect(items).toHaveLength(1);
	});

	test('oauth-capable provider shows an oauth badge (size sm); api-key-only does not', () => {
		const w = makeWrapper({ catalog: [
			{ provider: 'openai', authMethods: ['api-key'], hasCred: false },
			{ provider: 'openai-codex', authMethods: ['oauth-device-code', 'api-key'], hasCred: false },
		] });
		// oauth 能力 provider：贴 oauth 徽章，字面量 oauth，size=sm
		const oauthTag = w.find('[data-testid="add-provider-oauth-tag-openai-codex"]');
		expect(oauthTag.exists()).toBe(true);
		expect(oauthTag.text()).toBe('oauth');
		expect(oauthTag.attributes('data-size')).toBe('sm');
		// 纯 api-key provider：不贴徽章（降噪）
		expect(w.find('[data-testid="add-provider-oauth-tag-openai"]').exists()).toBe(false);
	});

	test('hasOauth merges across duplicate catalog entries (api-key + oauth → badge shown)', () => {
		const w = makeWrapper({ catalog: [
			{ provider: 'openai', authMethods: ['api-key'], hasCred: false },
			{ provider: 'openai', authMethods: ['oauth-login'], hasCred: false },
		] });
		expect(w.find('[data-testid="add-provider-oauth-tag-openai"]').exists()).toBe(true);
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

	test('renders the API key field as a masked text input, not type=password (keeps the browser password manager out)', async () => {
		const w = await goToStep2(makeWrapper());
		const input = w.find('[data-testid="add-provider-key-input"]');
		// type=text（非 password）：浏览器不再当它是密码框，不弹“保存/更新密码”
		expect(input.attributes('type')).toBe('text');
		// 仍通过 CSS 打码遮挡（-webkit-text-security）
		expect(input.classes()).toContain('cc-secret-mask');
	});

	test('API key field disables autofill / capitalize / correct / spellcheck so手敲的 key 不被改写', async () => {
		const w = await goToStep2(makeWrapper());
		const input = w.find('[data-testid="add-provider-key-input"]');
		// 不让密码管家介入
		expect(input.attributes('autocomplete')).toBe('off');
		// type=text 后移动端输入法的自动大写/纠错会复活，必须显式关掉，否则会弄坏 key
		expect(input.attributes('autocapitalize')).toBe('none');
		expect(input.attributes('autocorrect')).toBe('off');
		expect(input.attributes('spellcheck')).toBe('false');
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

	test('footer Cancel button closes the dialog without calling RPC', async () => {
		const setApiKey = vi.fn().mockResolvedValue({});
		const w = await goToStep2(makeWrapper({ setApiKey }));
		await w.find('[data-testid="add-provider-cancel"]').trigger('click');
		expect(setApiKey).not.toHaveBeenCalled();
		const openEvents = w.emitted('update:open');
		expect(openEvents[openEvents.length - 1]).toEqual([false]);
	});

	test('footer Cancel is ignored while submitting (RPC in-flight)', async () => {
		let resolveSet;
		const setApiKey = vi.fn(() => new Promise(res => { resolveSet = res; }));
		const w = await goToStep2(makeWrapper({ setApiKey }));
		await w.find('[data-testid="add-provider-key-input"]').setValue('gsk_abc');
		await w.find('[data-testid="add-provider-submit"]').trigger('click');
		await Promise.resolve();
		// 提交中点取消：应被 submitting 守卫挡下
		await w.find('[data-testid="add-provider-cancel"]').trigger('click');
		await Promise.resolve();
		const openEvents = w.emitted('update:open');
		expect(openEvents?.some(e => e[0] === false)).not.toBe(true);
		// settle 让 unmount 别孤儿
		resolveSet({ profileId: 'groq:default' });
		await flushPromises();
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

	test('Enter / form submit triggers onSubmit', async () => {
		const setApiKey = vi.fn().mockResolvedValue({ profileId: 'groq:default' });
		const w = await goToStep2(makeWrapper({ setApiKey }));
		await w.find('[data-testid="add-provider-key-input"]').setValue('gsk_abc');
		// 密码框现包在 <form> 内：回车触发原生表单提交 → @submit.prevent="onSubmit"
		await w.find('form').trigger('submit');
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

describe('AddProviderDialog — exclusion set (parent-computed from catalog.hasCred)', () => {
	// 新 catalog：setup 全集、基座 id、每 provider 一条带 hasCred
	const credCatalog = [
		{ provider: 'openai', authMethods: ['api-key'], hasCred: true },
		{ provider: 'groq', authMethods: ['api-key'], hasCred: false },
		{ provider: 'deepseek', authMethods: ['api-key'], hasCred: false },
	];

	test('excludes providers the parent marks as already-configured (hasCred===true → existingProviders)', () => {
		// 父组件把 hasCred===true 的集合算成 existingProviders 传入
		const w = makeWrapper({ catalog: credCatalog, existingProviders: ['openai'] });
		expect(w.find('[data-testid="add-provider-item-openai"]').exists()).toBe(false);
		// hasCred===false 的可加
		expect(w.find('[data-testid="add-provider-item-groq"]').exists()).toBe(true);
		expect(w.find('[data-testid="add-provider-item-deepseek"]').exists()).toBe(true);
	});

	test('empty exclusion → every catalog provider is addable', () => {
		const w = makeWrapper({ catalog: credCatalog, existingProviders: [] });
		expect(w.find('[data-testid="add-provider-item-openai"]').exists()).toBe(true);
		expect(w.find('[data-testid="add-provider-item-groq"]').exists()).toBe(true);
		expect(w.find('[data-testid="add-provider-item-deepseek"]').exists()).toBe(true);
	});

	test('exclusion is by exact provider id', () => {
		const w = makeWrapper({ catalog: credCatalog, existingProviders: ['groq'] });
		expect(w.find('[data-testid="add-provider-item-groq"]').exists()).toBe(false);
		expect(w.find('[data-testid="add-provider-item-openai"]').exists()).toBe(true);
		expect(w.find('[data-testid="add-provider-item-deepseek"]').exists()).toBe(true);
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

	test('Step 2 (configure) is never fullscreen, even on mobile (confirm card)', async () => {
		envState.screen.ltMd = true;
		const w = makeWrapper();
		// Step 1 在移动端全屏
		expect(w.find('.u-modal-stub').attributes('data-fullscreen')).toBe('true');
		// 进 Step 2 → 切到 confirm 小卡片，不全屏
		await w.find('[data-testid="add-provider-item-groq"]').trigger('click');
		expect(w.find('.u-modal-stub').attributes('data-fullscreen')).toBe('false');
	});

	test('Step 1 uses default modal ui; Step 2 adopts the confirm ui with locally tightened body pb', async () => {
		const w = makeWrapper();
		// Step 1：不注入 :ui（走默认更宽的弹窗）
		expect(w.find('.u-modal-stub').attributes('data-ui-body')).toBe('');
		// Step 2：套 confirm 弹窗样式，但本对话框局部收紧 body 底部 padding（pt-3 同全局、pb-2 收紧；不改全局 promptModalUi）
		await w.find('[data-testid="add-provider-item-groq"]').trigger('click');
		expect(w.find('.u-modal-stub').attributes('data-ui-body')).toBe('px-4 pt-3 pb-2 sm:px-5 sm:pt-3 sm:pb-2');
		expect(promptModalUi.body).toBe('px-4 py-3 sm:px-5 sm:py-3');
	});
});

describe('AddProviderDialog — multi-entry (authMethods)', () => {
	// 多桶 provider（authMethods 故意乱序，验证固定渲染顺序）+ 单 device-code + 单 api-key
	const multiCatalog = [
		// openai-codex：api-key + code + cb → cb（oauth-login）被隐（device-code 在场），塌成 api-key + device-code
		{ provider: 'openai-codex', authMethods: ['oauth-login', 'oauth-device-code', 'api-key'], hasCred: false },
		// gemini：api-key + cb（无 code）→ cb 保留，chooser 列 api-key + oauth-login（点后者走"暂不支持"）
		{ provider: 'gemini', authMethods: ['oauth-login', 'api-key'], hasCred: false },
		{ provider: 'github-copilot', authMethods: ['oauth-device-code'], hasCred: false },
		{ provider: 'groq', authMethods: ['api-key'], hasCred: false },
	];

	test('single api-key provider goes straight to key input (no chooser)', async () => {
		const w = makeWrapper({ catalog: multiCatalog });
		await w.find('[data-testid="add-provider-item-groq"]').trigger('click');
		expect(w.vm.selectedMethod).toBe('api-key');
		expect(w.find('[data-testid="add-method-chooser"]').exists()).toBe(false);
		expect(w.find('[data-testid="add-provider-key-input"]').exists()).toBe(true);
		// api-key 入口保留 footer Submit
		expect(w.find('[data-testid="add-provider-submit"]').exists()).toBe(true);
	});

	test('single device-code provider goes straight to ProviderOAuthLoginStep (no chooser; starting shows a single Cancel)', async () => {
		const w = makeWrapper({ catalog: multiCatalog });
		await w.find('[data-testid="add-provider-item-github-copilot"]').trigger('click');
		expect(w.vm.selectedMethod).toBe('oauth-device-code');
		expect(w.find('[data-testid="add-method-chooser"]').exists()).toBe(false);
		const step = w.find('.oauth-step-stub');
		expect(step.exists()).toBe(true);
		expect(step.attributes('data-provider')).toBe('github-copilot');
		// loginOauth / cancelOauth 透传到子步
		expect(step.attributes('data-has-login')).toBe('true');
		expect(step.attributes('data-has-cancel')).toBe('true');
		// starting 阶段也渲染单个取消（footer 不再为空、标题区不发虚）；api-key 的 Submit 自然不在
		expect(w.vm.footerMode).toBe('oauth-cancel');
		expect(w.find('[data-testid="oauth-cancel"]').exists()).toBe(true);
		expect(w.find('[data-testid="add-provider-submit"]').exists()).toBe(false);
		// starting 态点取消 → 委托子步 onCancel（stub emit cancel）→ 单方式回到 provider 选择
		await w.find('[data-testid="oauth-cancel"]').trigger('click');
		expect(w.vm.step).toBe('select');
	});

	test('device-code pending → footer shows a single solid Cancel; clicking it returns', async () => {
		const w = makeWrapper({ catalog: multiCatalog });
		// 单方式 → 直接进账号授权步；驱动子步进入 pending
		await w.find('[data-testid="add-provider-item-github-copilot"]').trigger('click');
		await w.find('.oauth-stub-pending').trigger('click');
		expect(w.vm.footerMode).toBe('oauth-cancel');
		expect(w.find('[data-testid="oauth-cancel"]').exists()).toBe(true);
		// footer Cancel → 委托子步 onCancel（stub emit cancel）→ 单方式回到 provider 选择
		await w.find('[data-testid="oauth-cancel"]').trigger('click');
		expect(w.vm.step).toBe('select');
	});

	test('device-code error → footer shows Back + Retry; Retry re-arms (back to starting)', async () => {
		const w = makeWrapper({ catalog: multiCatalog });
		await w.find('[data-testid="add-provider-item-github-copilot"]').trigger('click');
		await w.find('.oauth-stub-error').trigger('click');
		expect(w.vm.footerMode).toBe('oauth-error');
		expect(w.find('[data-testid="oauth-back"]').exists()).toBe(true);
		expect(w.find('[data-testid="oauth-retry"]').exists()).toBe(true);
		// Retry → 委托子步 start（stub emit update:phase 'starting'）→ footer 回到 starting 取消态
		await w.find('[data-testid="oauth-retry"]').trigger('click');
		expect(w.vm.oauthPhase).toBe('starting');
		expect(w.vm.footerMode).toBe('oauth-cancel');
		// 重新驱动到 error 再点 Back → 单方式回 provider 选择
		await w.find('.oauth-stub-error').trigger('click');
		await w.find('[data-testid="oauth-back"]').trigger('click');
		expect(w.vm.step).toBe('select');
	});

	test('single oauth-login provider does not navigate; notifies "not supported" and stays on select', async () => {
		const w = makeWrapper({ catalog: [
			{ provider: 'gemini-cli', authMethods: ['oauth-login'], hasCred: false },
		] });
		await w.find('[data-testid="add-provider-item-gemini-cli"]').trigger('click');
		// 不进配置屏：留在 provider 选择步，selectedProvider 不残留（滚动位置天然保住）
		expect(w.vm.step).toBe('select');
		expect(w.vm.selectedProvider).toBe('');
		expect(w.find('[data-testid="add-provider-list"]').exists()).toBe(true);
		// notify 提示账号授权暂不支持（带 provider）
		expect(w.vm.notify.warning).toHaveBeenCalledTimes(1);
		expect(w.vm.notify.warning.mock.calls[0][0]).toContain('modelConfig.providerAuth.add.oauthLoginUnsupported');
		expect(w.vm.notify.warning.mock.calls[0][0]).toContain('gemini-cli');
	});

	test('device-code present hides oauth-login; chooser shows api-key + device-code in fixed order', async () => {
		const w = makeWrapper({ catalog: multiCatalog });
		await w.find('[data-testid="add-provider-item-openai-codex"]').trigger('click');
		expect(w.vm.selectedMethod).toBe('');
		expect(w.find('[data-testid="add-method-chooser"]').exists()).toBe(true);
		// cb 被过滤（device-code 在场）；固定顺序，与 catalog authMethods 的乱序无关
		expect(w.vm.selectedProviderMethods).toEqual(['api-key', 'oauth-device-code']);
		// 渲染层也按固定顺序（防模板按 catalog 插入序渲染的回归）
		const renderedOrder = w.findAll('[data-testid^="add-method-"]')
			.map(b => b.attributes('data-testid'))
			.filter(t => t !== 'add-method-back' && t !== 'add-method-chooser');
		expect(renderedOrder).toEqual([
			'add-method-api-key',
			'add-method-oauth-device-code',
		]);
		// oauth-login 入口不渲染
		expect(w.find('[data-testid="add-method-oauth-login"]').exists()).toBe(false);
	});

	test('without device-code, oauth-login stays in the chooser (api-key + oauth-login)', async () => {
		const w = makeWrapper({ catalog: multiCatalog });
		await w.find('[data-testid="add-provider-item-gemini"]').trigger('click');
		expect(w.vm.selectedMethod).toBe('');
		expect(w.find('[data-testid="add-method-chooser"]').exists()).toBe(true);
		expect(w.vm.selectedProviderMethods).toEqual(['api-key', 'oauth-login']);
		expect(w.find('[data-testid="add-method-oauth-login"]').exists()).toBe(true);
	});

	test('chooser → pick api-key opens the key form', async () => {
		const w = makeWrapper({ catalog: multiCatalog });
		await w.find('[data-testid="add-provider-item-openai-codex"]').trigger('click');
		await w.find('[data-testid="add-method-api-key"]').trigger('click');
		expect(w.find('[data-testid="add-provider-key-input"]').exists()).toBe(true);
		expect(w.find('[data-testid="add-provider-submit"]').exists()).toBe(true);
	});

	test('chooser → pick device-code mounts ProviderOAuthLoginStep', async () => {
		const w = makeWrapper({ catalog: multiCatalog });
		await w.find('[data-testid="add-provider-item-openai-codex"]').trigger('click');
		await w.find('[data-testid="add-method-oauth-device-code"]').trigger('click');
		const step = w.find('.oauth-step-stub');
		expect(step.exists()).toBe(true);
		expect(step.attributes('data-provider')).toBe('openai-codex');
	});

	test('device-code success → emits added { provider, profileId } + closes', async () => {
		const w = makeWrapper({ catalog: multiCatalog });
		await w.find('[data-testid="add-provider-item-github-copilot"]').trigger('click');
		await w.find('.oauth-stub-success').trigger('click');
		expect(w.emitted('added')?.[0]).toEqual([{ provider: 'github-copilot', profileId: 'github-copilot:default' }]);
		const openEvents = w.emitted('update:open');
		expect(openEvents[openEvents.length - 1]).toEqual([false]);
	});

	test('device-code cancel → returns to chooser (multi-method) without closing', async () => {
		const w = makeWrapper({ catalog: multiCatalog });
		await w.find('[data-testid="add-provider-item-openai-codex"]').trigger('click');
		await w.find('[data-testid="add-method-oauth-device-code"]').trigger('click');
		await w.find('.oauth-stub-cancel').trigger('click');
		// 回到 chooser，对话框未关闭
		expect(w.vm.selectedMethod).toBe('');
		expect(w.find('[data-testid="add-method-chooser"]').exists()).toBe(true);
		expect(w.emitted('update:open')?.some(e => e[0] === false)).not.toBe(true);
	});

	test('device-code cancel for single-method provider returns to provider select', async () => {
		const w = makeWrapper({ catalog: multiCatalog });
		await w.find('[data-testid="add-provider-item-github-copilot"]').trigger('click');
		await w.find('.oauth-stub-cancel').trigger('click');
		// 单方式：回到 provider 选择步
		expect(w.vm.step).toBe('select');
		expect(w.find('[data-testid="add-provider-list"]').exists()).toBe(true);
	});

	test('chooser oauth-login entry does not navigate; notifies "not supported" and stays in chooser', async () => {
		const w = makeWrapper({ catalog: multiCatalog });
		// gemini = api-key + cb（无 code）→ chooser 保留 oauth-login 入口
		await w.find('[data-testid="add-provider-item-gemini"]').trigger('click');
		await w.find('[data-testid="add-method-oauth-login"]').trigger('click');
		// 点了不进配置子屏：仍停在 chooser
		expect(w.vm.selectedMethod).toBe('');
		expect(w.find('[data-testid="add-method-chooser"]').exists()).toBe(true);
		// notify 提示账号授权暂不支持（带 provider）
		expect(w.vm.notify.warning).toHaveBeenCalledTimes(1);
		expect(w.vm.notify.warning.mock.calls[0][0]).toContain('modelConfig.providerAuth.add.oauthLoginUnsupported');
		expect(w.vm.notify.warning.mock.calls[0][0]).toContain('gemini');
	});

	test('chooser back returns to provider select', async () => {
		const w = makeWrapper({ catalog: multiCatalog });
		await w.find('[data-testid="add-provider-item-openai-codex"]').trigger('click');
		await w.find('[data-testid="add-method-back"]').trigger('click');
		expect(w.vm.step).toBe('select');
		expect(w.find('[data-testid="add-provider-list"]').exists()).toBe(true);
	});

	test('reopening resets multi-entry state (selectedMethod cleared)', async () => {
		const w = makeWrapper({ catalog: multiCatalog, open: false });
		await w.setProps({ open: true });
		await w.find('[data-testid="add-provider-item-openai-codex"]').trigger('click');
		await w.find('[data-testid="add-method-oauth-device-code"]').trigger('click');
		expect(w.vm.selectedMethod).toBe('oauth-device-code');
		await w.setProps({ open: false });
		await w.setProps({ open: true });
		expect(w.vm.step).toBe('select');
		expect(w.vm.selectedMethod).toBe('');
	});
});
