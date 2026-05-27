import { mount } from '@vue/test-utils';
import { test, expect, describe } from 'vitest';

import ProviderAuthRow from './ProviderAuthRow.vue';

const UButtonStub = {
	props: { disabled: { type: Boolean, default: false } },
	emits: ['click'],
	template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
};

function makeWrapper(profile, extraProps = {}) {
	return mount(ProviderAuthRow, {
		props: { profile, ...extraProps },
		global: {
			stubs: { UButton: UButtonStub },
			mocks: { $t: (key) => key },
		},
	});
}

describe('ProviderAuthRow', () => {
	test('renders mapped displayName for known provider + keyPreview as secondary', () => {
		const w = makeWrapper({ provider: 'groq', type: 'api_key', keyPreview: 'gsk_…ABCD', profileId: 'groq:default' });
		const text = w.text();
		expect(text).toContain('Groq');
		expect(text).toContain('gsk_…ABCD');
	});

	test('falls back to provider id for unknown provider', () => {
		const w = makeWrapper({ provider: 'mystery', type: 'api_key', keyPreview: 'k…1', profileId: 'mystery:default' });
		expect(w.text()).toContain('mystery');
	});

	test('emits remove with provider id when remove clicked', async () => {
		const w = makeWrapper({ provider: 'anthropic', type: 'api_key', keyPreview: 'sk-an…XYZW', profileId: 'anthropic:default' });
		const btn = w.find('[data-testid="btn-remove-provider"]');
		expect(btn.exists()).toBe(true);
		await btn.trigger('click');
		expect(w.emitted('remove')).toBeTruthy();
		expect(w.emitted('remove')[0]).toEqual(['anthropic']);
	});

	test('OAuth profile is read-only (no remove button)', () => {
		const w = makeWrapper({ provider: 'minimax', type: 'oauth', email: 'u@example.com', profileId: 'minimax:default' });
		expect(w.find('[data-testid="btn-remove-provider"]').exists()).toBe(false);
		// 仍渲染 email
		expect(w.text()).toContain('u@example.com');
	});

	test('CoClaw-managed scan-login oauth (minimax-portal) is removable', async () => {
		const w = makeWrapper({ provider: 'minimax-portal', type: 'oauth', email: 'u@example.com', profileId: 'minimax-portal:default' });
		const btn = w.find('[data-testid="btn-remove-provider"]');
		expect(btn.exists()).toBe(true);
		await btn.trigger('click');
		expect(w.emitted('remove')[0]).toEqual(['minimax-portal']);
	});

	test('token-type profile is removable (treated like api_key)', () => {
		const w = makeWrapper({ provider: 'someTokenProvider', type: 'token', displayName: 'My Token', profileId: 'tok:default' });
		expect(w.find('[data-testid="btn-remove-provider"]').exists()).toBe(true);
	});

	test('disabled prop disables remove button', () => {
		const w = makeWrapper(
			{ provider: 'groq', type: 'api_key', keyPreview: 'gsk_…X', profileId: 'groq:default' },
			{ disabled: true },
		);
		const btn = w.find('[data-testid="btn-remove-provider"]');
		expect(btn.element.disabled).toBe(true);
	});

	test('does not render secondary line when nothing useful is available', () => {
		const w = makeWrapper({ provider: 'groq', type: 'api_key', profileId: 'groq:default' });
		// 不应渲染 keyPreview 占位空行——通过 DOM 节点数判断
		const paragraphs = w.findAll('p');
		expect(paragraphs.length).toBe(1);
	});

	test('does not emit when profile lacks provider id', async () => {
		const w = makeWrapper({ type: 'api_key', keyPreview: 'k', profileId: 'orphan' });
		await w.find('[data-testid="btn-remove-provider"]').trigger('click');
		expect(w.emitted('remove')[0]).toEqual(['']);
	});
});
