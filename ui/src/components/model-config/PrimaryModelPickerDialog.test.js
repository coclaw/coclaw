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

const catalog = [
	{ id: 'gpt-4', provider: 'openai' },
	{ id: 'gpt-3.5', provider: 'openai' },
	{ id: 'claude-sonnet', provider: 'anthropic' },
	{ id: 'claude-opus', provider: 'anthropic' },
	{ id: 'llama-3.3-70b-versatile', provider: 'groq' },
	{ id: 'orphan-model', provider: 'someUnboundProvider' },
];

function makeWrapper(props = {}) {
	return mount(PrimaryModelPickerDialog, {
		props: {
			open: true,
			providers: ['openai', 'groq'], // anthropic NOT bound → its models excluded
			catalog,
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

describe('PrimaryModelPickerDialog — intersection of providers + catalog', () => {
	test('only renders models whose provider is in the providers array', () => {
		const w = makeWrapper();
		// openai (bound) → both models
		expect(w.find('[data-testid="primary-picker-item-openai__gpt-4"]').exists()).toBe(true);
		expect(w.find('[data-testid="primary-picker-item-openai__gpt-3.5"]').exists()).toBe(true);
		// groq (bound) → its model
		expect(w.find('[data-testid="primary-picker-item-groq__llama-3.3-70b-versatile"]').exists()).toBe(true);
		// anthropic NOT bound → excluded
		expect(w.find('[data-testid="primary-picker-item-anthropic__claude-sonnet"]').exists()).toBe(false);
		// orphan provider not in catalog (well, in catalog but not in providers list)
		expect(w.find('[data-testid="primary-picker-item-someUnboundProvider__orphan-model"]').exists()).toBe(false);
	});

	test('current model gets check mark; others do not', () => {
		const w = makeWrapper({ current: 'openai/gpt-4' });
		const current = w.find('[data-testid="primary-picker-item-openai__gpt-4"]');
		expect(current.find('[data-icon="i-lucide-check"]').exists()).toBe(true);
		const other = w.find('[data-testid="primary-picker-item-groq__llama-3.3-70b-versatile"]');
		expect(other.find('[data-icon="i-lucide-check"]').exists()).toBe(false);
	});

	test('groups labeled by displayName from PROVIDER_META', () => {
		const w = makeWrapper();
		// openai group header text should contain "OpenAI" (PROVIDER_META)
		const openaiGroup = w.find('[data-testid="primary-picker-group-openai"]');
		expect(openaiGroup.exists()).toBe(true);
		expect(openaiGroup.text()).toBe('OpenAI');
		// groq group → "Groq"
		expect(w.find('[data-testid="primary-picker-group-groq"]').text()).toBe('Groq');
	});

	test('empty providers list → empty hint', () => {
		const w = makeWrapper({ providers: [] });
		expect(w.find('[data-testid="primary-picker-empty"]').exists()).toBe(true);
	});

	test('empty catalog → empty hint', () => {
		const w = makeWrapper({ catalog: [] });
		expect(w.find('[data-testid="primary-picker-empty"]').exists()).toBe(true);
	});

	test('current invalid format (no slash) → no item highlighted, no crash', () => {
		const w = makeWrapper({ current: 'malformed' });
		// 仍渲染列表，仅没人被勾上
		const checkmarks = w.findAll('[data-icon="i-lucide-check"]');
		expect(checkmarks.length).toBe(0);
	});

	test('current null → no checkmark, no crash', () => {
		const w = makeWrapper({ current: null });
		const checkmarks = w.findAll('[data-icon="i-lucide-check"]');
		expect(checkmarks.length).toBe(0);
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

	test('double-click while busy → only one RPC fires', async () => {
		let resolveSet;
		const setPrimary = vi.fn(() => new Promise(res => { resolveSet = res; }));
		const w = makeWrapper({ setPrimary });
		await w.find('[data-testid="primary-picker-item-groq__llama-3.3-70b-versatile"]').trigger('click');
		await Promise.resolve();
		await w.find('[data-testid="primary-picker-item-groq__llama-3.3-70b-versatile"]').trigger('click');
		await Promise.resolve();
		expect(setPrimary).toHaveBeenCalledTimes(1);
		// settle 收尾
		resolveSet({});
		await flushPromises();
	});

	test('spinner shows on the clicked NON-current row while saving (not tied to isCurrent)', async () => {
		let resolveSet;
		const setPrimary = vi.fn(() => new Promise(res => { resolveSet = res; }));
		// current is openai/gpt-4; user clicks a different (groq) row
		const w = makeWrapper({ setPrimary, current: 'openai/gpt-4' });
		await w.find('[data-testid="primary-picker-item-groq__llama-3.3-70b-versatile"]').trigger('click');
		await Promise.resolve();
		await w.vm.$nextTick();
		// the clicked groq row shows the loader spinner even though it is NOT the current primary
		const clicked = w.find('[data-testid="primary-picker-item-groq__llama-3.3-70b-versatile"]');
		expect(clicked.find('[data-icon="i-lucide-loader-2"]').exists()).toBe(true);
		// the current openai row does NOT spin
		const current = w.find('[data-testid="primary-picker-item-openai__gpt-4"]');
		expect(current.find('[data-icon="i-lucide-loader-2"]').exists()).toBe(false);
		resolveSet({});
		await flushPromises();
	});

	test('Cancel ignored while busy', async () => {
		let resolveSet;
		const setPrimary = vi.fn(() => new Promise(res => { resolveSet = res; }));
		const w = makeWrapper({ setPrimary });
		await w.find('[data-testid="primary-picker-item-groq__llama-3.3-70b-versatile"]').trigger('click');
		await Promise.resolve();
		await w.find('[data-testid="primary-picker-cancel"]').trigger('click');
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

describe('PrimaryModelPickerDialog — cancel / mask close', () => {
	test('Cancel button emits update:open=false', async () => {
		const w = makeWrapper();
		await w.find('[data-testid="primary-picker-cancel"]').trigger('click');
		const events = w.emitted('update:open');
		expect(events).toBeTruthy();
		expect(events[events.length - 1]).toEqual([false]);
	});

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
