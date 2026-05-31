import { mount, flushPromises } from '@vue/test-utils';
import { test, expect, describe, vi, beforeEach } from 'vitest';

// notify mock
const mockNotify = vi.hoisted(() => ({
	success: vi.fn(),
	info: vi.fn(),
	warning: vi.fn(),
	error: vi.fn(),
}));
vi.mock('../../composables/use-notify.js', () => ({
	useNotify: () => mockNotify,
}));

const envState = vi.hoisted(() => ({ screen: { ltMd: false } }));
vi.mock('../../stores/env.store.js', () => ({
	useEnvStore: () => envState,
}));

import PrimaryModelPickerDialog from './PrimaryModelPickerDialog.vue';

const UButtonStub = {
	props: { disabled: { type: Boolean, default: false } },
	emits: ['click'],
	template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
};

const UInputStub = {
	props: ['modelValue', 'disabled', 'placeholder', 'icon'],
	emits: ['update:modelValue'],
	template: '<input :value="modelValue" :disabled="disabled" :placeholder="placeholder" @input="$emit(\'update:modelValue\', $event.target.value)" />',
};

const UIconStub = { props: ['name'], template: '<span :data-icon="name" />' };

const UModalStub = {
	props: ['open', 'fullscreen', 'ui', 'title'],
	emits: ['update:open'],
	template: `<div v-if="open"
		class="u-modal-stub"
		:data-fullscreen="String(fullscreen)"
		:data-title="title"
	>
		<header>{{ title }}</header>
		<div class="modal-body"><slot name="body" /></div>
		<div class="modal-footer"><slot name="footer" /></div>
	</div>`,
};

// listAvailable.byProvider 唯一数据源：openai + groq 可用（anthropic 未配 → 不出现）。
const usableDefault = {
	openai: ['gpt-4', 'gpt-3.5'],
	groq: ['llama-3.3-70b-versatile'],
};

function makeWrapper(props = {}) {
	return mount(PrimaryModelPickerDialog, {
		props: {
			open: true,
			usable: usableDefault,
			current: 'openai/gpt-4',
			setPrimary: vi.fn().mockResolvedValue({}),
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

describe('PrimaryModelPickerDialog — byProvider (listAvailable) sole data source', () => {
	test('renders models straight from usable.byProvider', () => {
		const w = makeWrapper();
		expect(w.find('[data-testid="primary-picker-item-openai__gpt-4"]').exists()).toBe(true);
		expect(w.find('[data-testid="primary-picker-item-openai__gpt-3.5"]').exists()).toBe(true);
		expect(w.find('[data-testid="primary-picker-item-groq__llama-3.3-70b-versatile"]').exists()).toBe(true);
		// anthropic 不在 usable → 不渲染（即使 catalog 里有它）
		expect(w.find('[data-testid="primary-picker-item-anthropic__claude-sonnet"]').exists()).toBe(false);
	});

	test('renders alias plan variant model (e.g. volcengine-plan/ark-code-latest)', () => {
		const w = makeWrapper({
			usable: { 'volcengine-plan': ['ark-code-latest'], groq: ['llama-3.3-70b-versatile'] },
			current: null,
		});
		// 别名套餐变体作为一等公民出现，可被选中
		const variant = w.find('[data-testid="primary-picker-item-volcengine-plan__ark-code-latest"]');
		expect(variant.exists()).toBe(true);
		// 分组标题直接显示变体 provider id
		expect(w.find('[data-testid="primary-picker-group-volcengine-plan"]').text()).toBe('volcengine-plan');
	});

	test('clicking the variant calls setPrimary with the variant provider/model', async () => {
		const setPrimary = vi.fn().mockResolvedValue({});
		const w = makeWrapper({
			usable: { 'volcengine-plan': ['ark-code-latest'] },
			current: null,
			setPrimary,
		});
		await w.find('[data-testid="primary-picker-item-volcengine-plan__ark-code-latest"]').trigger('click');
		await flushPromises();
		expect(setPrimary).toHaveBeenCalledTimes(1);
		expect(setPrimary.mock.calls[0][0].primary).toBe('volcengine-plan/ark-code-latest');
	});

	test('usable is the sole data source', () => {
		const w = makeWrapper();
		expect(w.find('[data-testid="primary-picker-item-openai__gpt-4"]').exists()).toBe(true);
		expect(w.find('[data-testid="primary-picker-item-groq__llama-3.3-70b-versatile"]').exists()).toBe(true);
	});

	test('empty usable → empty hint', () => {
		const w = makeWrapper({ usable: {} });
		expect(w.find('[data-testid="primary-picker-empty"]').exists()).toBe(true);
	});

	test('provider key with empty model array contributes no group', () => {
		const w = makeWrapper({ usable: { groq: [], openai: ['gpt-4'] }, current: null });
		expect(w.find('[data-testid="primary-picker-group-groq"]').exists()).toBe(false);
		expect(w.find('[data-testid="primary-picker-item-openai__gpt-4"]').exists()).toBe(true);
	});

	test('current model gets check mark; others do not', () => {
		const w = makeWrapper({ current: 'openai/gpt-4' });
		const current = w.find('[data-testid="primary-picker-item-openai__gpt-4"]');
		expect(current.find('[data-icon="i-lucide-check"]').exists()).toBe(true);
		const other = w.find('[data-testid="primary-picker-item-groq__llama-3.3-70b-versatile"]');
		expect(other.find('[data-icon="i-lucide-check"]').exists()).toBe(false);
	});

	test('groups labeled by raw provider id (no displayName mapping)', () => {
		const w = makeWrapper();
		expect(w.find('[data-testid="primary-picker-group-openai"]').text()).toBe('openai');
		expect(w.find('[data-testid="primary-picker-group-groq"]').text()).toBe('groq');
	});

	test('current invalid format (no slash) → no highlight, no crash', () => {
		const w = makeWrapper({ current: 'malformed' });
		expect(w.findAll('[data-icon="i-lucide-check"]').length).toBe(0);
	});

	test('current null → no checkmark, no crash', () => {
		const w = makeWrapper({ current: null });
		expect(w.findAll('[data-icon="i-lucide-check"]').length).toBe(0);
	});

	test('tolerates malformed usable entries (non-array values / non-string ids)', () => {
		const w = makeWrapper({
			usable: { openai: 'not-an-array', groq: ['llama-3.3-70b-versatile', 123, null] },
			current: null,
		});
		// openai 值非数组 → 跳过；groq 仅保留合法 string id
		expect(w.find('[data-testid="primary-picker-group-openai"]').exists()).toBe(false);
		expect(w.find('[data-testid="primary-picker-item-groq__llama-3.3-70b-versatile"]').exists()).toBe(true);
	});
});

describe('PrimaryModelPickerDialog — search', () => {
	test('filters by model id (case-insensitive)', async () => {
		const w = makeWrapper();
		await w.find('[data-testid="primary-picker-search"]').setValue('GPT');
		expect(w.find('[data-testid="primary-picker-item-openai__gpt-4"]').exists()).toBe(true);
		expect(w.find('[data-testid="primary-picker-item-openai__gpt-3.5"]').exists()).toBe(true);
		expect(w.find('[data-testid="primary-picker-item-groq__llama-3.3-70b-versatile"]').exists()).toBe(false);
	});

	test('filters by provider id (case-insensitive)', async () => {
		const w = makeWrapper();
		await w.find('[data-testid="primary-picker-search"]').setValue('groq');
		expect(w.find('[data-testid="primary-picker-item-groq__llama-3.3-70b-versatile"]').exists()).toBe(true);
		expect(w.find('[data-testid="primary-picker-item-openai__gpt-4"]').exists()).toBe(false);
	});

	test('no matches → empty hint', async () => {
		const w = makeWrapper();
		await w.find('[data-testid="primary-picker-search"]').setValue('zzz-nope');
		expect(w.find('[data-testid="primary-picker-empty"]').exists()).toBe(true);
	});
});

describe('PrimaryModelPickerDialog — click to save (immediate, no second confirm)', () => {
	test('clicking a row immediately calls setPrimary with provider/model', async () => {
		const setPrimary = vi.fn().mockResolvedValue({});
		const w = makeWrapper({ setPrimary });
		await w.find('[data-testid="primary-picker-item-groq__llama-3.3-70b-versatile"]').trigger('click');
		await flushPromises();
		expect(setPrimary).toHaveBeenCalledTimes(1);
		expect(setPrimary.mock.calls[0][0].primary).toBe('groq/llama-3.3-70b-versatile');
	});

	test('success: emits picked + closes dialog', async () => {
		const setPrimary = vi.fn().mockResolvedValue({});
		const w = makeWrapper({ setPrimary });
		await w.find('[data-testid="primary-picker-item-groq__llama-3.3-70b-versatile"]').trigger('click');
		await flushPromises();
		expect(w.emitted('picked')?.[0]).toEqual([{ primary: 'groq/llama-3.3-70b-versatile' }]);
		const openEvents = w.emitted('update:open');
		expect(openEvents[openEvents.length - 1]).toEqual([false]);
	});

	test('failure: notify error, dialog stays open, no picked emit', async () => {
		const setPrimary = vi.fn().mockRejectedValue(Object.assign(new Error('bad'), { code: 'INVALID_ARGS' }));
		const w = makeWrapper({ setPrimary });
		await w.find('[data-testid="primary-picker-item-groq__llama-3.3-70b-versatile"]').trigger('click');
		await flushPromises();
		expect(mockNotify.error).toHaveBeenCalledWith('modelConfig.common.errInvalidArgs');
		expect(w.emitted('picked')).toBeFalsy();
		const openEvents = w.emitted('update:open');
		expect(openEvents?.some(e => e[0] === false)).not.toBe(true);
	});

	test('failure with IO_FAILED → notify errIoFailed', async () => {
		const setPrimary = vi.fn().mockRejectedValue(Object.assign(new Error('io'), { code: 'IO_FAILED' }));
		const w = makeWrapper({ setPrimary });
		await w.find('[data-testid="primary-picker-item-groq__llama-3.3-70b-versatile"]').trigger('click');
		await flushPromises();
		expect(mockNotify.error).toHaveBeenCalledWith('modelConfig.common.errIoFailed');
	});

	test('failure with connection code → notify connError', async () => {
		const setPrimary = vi.fn().mockRejectedValue(Object.assign(new Error('dc'), { code: 'DC_CLOSED' }));
		const w = makeWrapper({ setPrimary });
		await w.find('[data-testid="primary-picker-item-groq__llama-3.3-70b-versatile"]').trigger('click');
		await flushPromises();
		expect(mockNotify.error).toHaveBeenCalledWith('modelConfig.common.connError');
	});

	test('failure with unknown code → notify generic saveFailed', async () => {
		const setPrimary = vi.fn().mockRejectedValue(new Error('weird'));
		const w = makeWrapper({ setPrimary });
		await w.find('[data-testid="primary-picker-item-groq__llama-3.3-70b-versatile"]').trigger('click');
		await flushPromises();
		expect(mockNotify.error).toHaveBeenCalledWith('modelConfig.common.saveFailed');
	});

	test('canceled error → silent close, no notify', async () => {
		const setPrimary = vi.fn().mockRejectedValue(Object.assign(new Error('abort'), { code: 'ERR_CANCELED' }));
		const w = makeWrapper({ setPrimary });
		await w.find('[data-testid="primary-picker-item-groq__llama-3.3-70b-versatile"]').trigger('click');
		await flushPromises();
		expect(mockNotify.error).not.toHaveBeenCalled();
		const openEvents = w.emitted('update:open');
		expect(openEvents[openEvents.length - 1]).toEqual([false]);
	});

	test('double-click while busy → only one RPC fires', async () => {
		let resolveSet;
		const setPrimary = vi.fn(() => new Promise(res => { resolveSet = res; }));
		const w = makeWrapper({ setPrimary });
		await w.find('[data-testid="primary-picker-item-groq__llama-3.3-70b-versatile"]').trigger('click');
		await Promise.resolve();
		await w.find('[data-testid="primary-picker-item-groq__llama-3.3-70b-versatile"]').trigger('click');
		await Promise.resolve();
		expect(setPrimary).toHaveBeenCalledTimes(1);
		resolveSet({});
		await flushPromises();
	});

	test('spinner shows on the clicked NON-current row while saving (not tied to isCurrent)', async () => {
		let resolveSet;
		const setPrimary = vi.fn(() => new Promise(res => { resolveSet = res; }));
		const w = makeWrapper({ setPrimary, current: 'openai/gpt-4' });
		await w.find('[data-testid="primary-picker-item-groq__llama-3.3-70b-versatile"]').trigger('click');
		await Promise.resolve();
		await w.vm.$nextTick();
		const clicked = w.find('[data-testid="primary-picker-item-groq__llama-3.3-70b-versatile"]');
		expect(clicked.find('[data-icon="i-lucide-loader-2"]').exists()).toBe(true);
		const current = w.find('[data-testid="primary-picker-item-openai__gpt-4"]');
		expect(current.find('[data-icon="i-lucide-loader-2"]').exists()).toBe(false);
		resolveSet({});
		await flushPromises();
	});

	test('mask / Esc close ignored while busy', async () => {
		let resolveSet;
		const setPrimary = vi.fn(() => new Promise(res => { resolveSet = res; }));
		const w = makeWrapper({ setPrimary });
		await w.find('[data-testid="primary-picker-item-groq__llama-3.3-70b-versatile"]').trigger('click');
		await Promise.resolve();
		w.findComponent(UModalStub).vm.$emit('update:open', false);
		await Promise.resolve();
		const openEvents = w.emitted('update:open');
		expect(openEvents?.some(e => e[0] === false)).not.toBe(true);
		resolveSet({});
		await flushPromises();
	});

	test('NO setPrimary prop: notify connError, no crash', async () => {
		const w = makeWrapper({ setPrimary: null });
		await w.find('[data-testid="primary-picker-item-groq__llama-3.3-70b-versatile"]').trigger('click');
		await flushPromises();
		expect(mockNotify.error).toHaveBeenCalledWith('modelConfig.common.connError');
	});
});

describe('PrimaryModelPickerDialog — mask / Esc close', () => {
	test('UModal close (mask / Esc) = cancel', async () => {
		const w = makeWrapper();
		w.findComponent(UModalStub).vm.$emit('update:open', false);
		await w.vm.$nextTick();
		expect(w.emitted('update:open')?.[0]).toEqual([false]);
	});

	test('UModal open=true reflux does NOT emit cancel', async () => {
		const w = makeWrapper();
		w.findComponent(UModalStub).vm.$emit('update:open', true);
		await w.vm.$nextTick();
		expect(w.emitted('update:open')).toBeFalsy();
	});
});

describe('PrimaryModelPickerDialog — open lifecycle', () => {
	test('Reopening clears search text + pendingTarget', async () => {
		const w = makeWrapper({ open: false });
		await w.setProps({ open: true });
		await w.find('[data-testid="primary-picker-search"]').setValue('xyz');
		expect(w.vm.searchText).toBe('xyz');
		await w.setProps({ open: false });
		await w.setProps({ open: true });
		expect(w.vm.searchText).toBe('');
		expect(w.vm.pendingTarget).toBe('');
	});
});

describe('PrimaryModelPickerDialog — mobile / desktop layout', () => {
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
