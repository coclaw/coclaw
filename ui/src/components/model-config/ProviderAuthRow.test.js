import { mount } from '@vue/test-utils';
import { test, expect, describe } from 'vitest';

import ProviderAuthRow from './ProviderAuthRow.vue';

const UButtonStub = {
	props: { disabled: { type: Boolean, default: false } },
	emits: ['click'],
	template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
};

// UBadge 非全局注册于 vitest（未挂 @nuxt/ui/vite），stub 成渲染 slot 的 span 即可断言标签文案
const UBadgeStub = {
	template: '<span class="ubadge"><slot /></span>',
};

function makeWrapper(profile, extraProps = {}) {
	return mount(ProviderAuthRow, {
		props: { profile, ...extraProps },
		global: {
			stubs: { UButton: UButtonStub, UBadge: UBadgeStub },
			mocks: { $t: (key) => key },
		},
	});
}

describe('ProviderAuthRow', () => {
	test('renders mapped displayName for known provider + keyPreview as secondary', () => {
		const w = makeWrapper({ provider: 'groq', type: 'api_key', keyPreview: 'gsk_…ABCD', profileId: 'groq:default', source: 'profile', removable: true });
		const text = w.text();
		expect(text).toContain('Groq');
		expect(text).toContain('gsk_…ABCD');
	});

	test('falls back to provider id for unknown provider', () => {
		const w = makeWrapper({ provider: 'mystery', type: 'api_key', keyPreview: 'k…1', profileId: 'mystery:default', source: 'profile', removable: true });
		expect(w.text()).toContain('mystery');
	});

	test('emits remove with { provider, source } when remove clicked', async () => {
		const w = makeWrapper({ provider: 'anthropic', type: 'api_key', keyPreview: 'sk-an…XYZW', profileId: 'anthropic:default', source: 'profile', removable: true });
		const btn = w.find('[data-testid="btn-remove-provider"]');
		expect(btn.exists()).toBe(true);
		await btn.trigger('click');
		expect(w.emitted('remove')).toBeTruthy();
		expect(w.emitted('remove')[0]).toEqual([{ provider: 'anthropic', source: 'profile' }]);
	});

	test('OAuth profile is read-only (no remove button)', () => {
		const w = makeWrapper({ provider: 'minimax', type: 'oauth', email: 'u@example.com', profileId: 'minimax:default', source: 'profile', removable: true });
		expect(w.find('[data-testid="btn-remove-provider"]').exists()).toBe(false);
		// 仍渲染 email
		expect(w.text()).toContain('u@example.com');
	});

	test('CoClaw-managed scan-login oauth (minimax-portal) is removable', async () => {
		const w = makeWrapper({ provider: 'minimax-portal', type: 'oauth', email: 'u@example.com', profileId: 'minimax-portal:default', source: 'profile', removable: true });
		const btn = w.find('[data-testid="btn-remove-provider"]');
		expect(btn.exists()).toBe(true);
		await btn.trigger('click');
		expect(w.emitted('remove')[0]).toEqual([{ provider: 'minimax-portal', source: 'profile' }]);
	});

	test('token-type profile is removable (treated like api_key)', () => {
		const w = makeWrapper({ provider: 'someTokenProvider', type: 'token', displayName: 'My Token', profileId: 'tok:default', source: 'profile', removable: true });
		expect(w.find('[data-testid="btn-remove-provider"]').exists()).toBe(true);
	});

	test('disabled prop disables remove button', () => {
		const w = makeWrapper(
			{ provider: 'groq', type: 'api_key', keyPreview: 'gsk_…X', profileId: 'groq:default', source: 'profile', removable: true },
			{ disabled: true },
		);
		const btn = w.find('[data-testid="btn-remove-provider"]');
		expect(btn.element.disabled).toBe(true);
	});

	test('does not render secondary line when nothing useful is available', () => {
		const w = makeWrapper({ provider: 'groq', type: 'api_key', profileId: 'groq:default', source: 'profile', removable: true });
		// 不应渲染 keyPreview 占位空行——secondary 为空时只剩品牌名那行 + 不渲染次行
		expect(w.find('p.text-muted').exists()).toBe(false);
	});

	test('does not emit when profile lacks provider id (emits empty provider, page guards)', async () => {
		const w = makeWrapper({ type: 'api_key', keyPreview: 'k', profileId: 'orphan', source: 'profile', removable: true });
		await w.find('[data-testid="btn-remove-provider"]').trigger('click');
		expect(w.emitted('remove')[0]).toEqual([{ provider: '', source: 'profile' }]);
	});

	// --- 来源标签（§2.4 source）---
	test('source tag renders the profile label', () => {
		const w = makeWrapper({ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default', source: 'profile', removable: true });
		expect(w.find('[data-testid="provider-source-tag"]').text()).toBe('modelConfig.providerAuth.source.profile');
	});

	test('inline source: tag + emits source=inline, button enabled', async () => {
		const w = makeWrapper({ provider: 'minimax', type: 'api_key', keyPreview: 'mm…Y', profileId: 'minimax#inline', source: 'inline', removable: true });
		expect(w.find('[data-testid="provider-source-tag"]').text()).toBe('modelConfig.providerAuth.source.inline');
		const btn = w.find('[data-testid="btn-remove-provider"]');
		expect(btn.element.disabled).toBe(false);
		await btn.trigger('click');
		expect(w.emitted('remove')[0]).toEqual([{ provider: 'minimax', source: 'inline' }]);
	});

	test('env source: tag + disabled remove button + readonly hint as secondary + no emit', async () => {
		const w = makeWrapper({ provider: 'openai', type: 'api_key', profileId: 'openai#env', source: 'env', removable: false });
		expect(w.find('[data-testid="provider-source-tag"]').text()).toBe('modelConfig.providerAuth.source.env');
		const btn = w.find('[data-testid="btn-remove-provider"]');
		// env 行渲染按钮但禁用（区别于只读 oauth 的"不渲染"）
		expect(btn.exists()).toBe(true);
		expect(btn.element.disabled).toBe(true);
		// 次行显示"去主机移除"提示
		expect(w.text()).toContain('modelConfig.providerAuth.envReadonlyHint');
		// 即便强制点击，canRemove=false → 不 emit
		await btn.trigger('click');
		expect(w.emitted('remove')).toBeFalsy();
	});

	// --- 旧插件退化：出参无 source / removable 字段 ---
	test('legacy plugin (no source / removable fields) degrades to profile + removable', async () => {
		const w = makeWrapper({ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default' });
		expect(w.find('[data-testid="provider-source-tag"]').text()).toBe('modelConfig.providerAuth.source.profile');
		const btn = w.find('[data-testid="btn-remove-provider"]');
		expect(btn.element.disabled).toBe(false);
		await btn.trigger('click');
		expect(w.emitted('remove')[0]).toEqual([{ provider: 'groq', source: 'profile' }]);
	});
});
