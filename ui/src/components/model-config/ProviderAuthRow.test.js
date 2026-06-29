import { mount } from '@vue/test-utils';
import { test, expect, describe } from 'vitest';

import ProviderAuthRow from './ProviderAuthRow.vue';

const UButtonStub = {
	props: { disabled: { type: Boolean, default: false } },
	emits: ['click'],
	template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
};

// UBadge 非全局注册于 vitest（未挂 @nuxt/ui/vite），stub 成渲染 slot 的 span 即可断言标签文案；
// 暴露 size 经 data-size 落到 root，便于断言字号
const UBadgeStub = {
	props: { size: { type: String, default: '' } },
	template: '<span class="ubadge" :data-size="size"><slot /></span>',
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
	test('renders friendly brand name (getProviderName) + keyPreview as secondary', () => {
		const w = makeWrapper({ provider: 'groq', type: 'api_key', keyPreview: 'gsk_…ABCD', profileId: 'groq:default', source: 'profile', removable: true });
		const text = w.text();
		// 展示友好品牌名（groq → 'Groq'），不再是裸 id
		expect(text).toContain('Groq');
		expect(text).toContain('gsk_…ABCD');
	});

	test('row carries a testid keyed by the raw provider id (E2E anchor, decoupled from displayed label)', () => {
		const w = makeWrapper({ provider: 'groq', type: 'api_key', keyPreview: 'gsk_…ABCD', profileId: 'groq:default', source: 'profile', removable: true });
		// testid 用裸 id（id 是唯一真值）；即便 label 展示 'Groq'，E2E 仍可按裸 id 锚定该行
		expect(w.find('[data-testid="provider-auth-row-groq"]').exists()).toBe(true);
	});

	test('renders friendly brand name for a known provider (anthropic → "Anthropic Claude")', () => {
		const w = makeWrapper({ provider: 'anthropic', type: 'api_key', keyPreview: 'sk-an…XYZW', profileId: 'anthropic:default', source: 'profile', removable: true });
		expect(w.text()).toContain('Anthropic Claude');
	});

	test('unknown provider (no brand name) falls back to the raw id verbatim', () => {
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

	test('OAuth profile renders oauth badge + email, and is removable (whitelist gate removed)', async () => {
		const w = makeWrapper({ provider: 'minimax', type: 'oauth', email: 'u@example.com', profileId: 'minimax:default', source: 'profile', removable: true });
		// oauth 徽章（字面量 oauth，不进 i18n），size=sm
		const oauthTag = w.find('[data-testid="provider-oauth-tag"]');
		expect(oauthTag.text()).toBe('oauth');
		expect(oauthTag.attributes('data-size')).toBe('sm');
		// 撤销纯看后端 removable → 有凭据即可撤销
		const btn = w.find('[data-testid="btn-remove-provider"]');
		expect(btn.exists()).toBe(true);
		await btn.trigger('click');
		expect(w.emitted('remove')[0]).toEqual([{ provider: 'minimax', source: 'profile' }]);
		// 仍渲染 email
		expect(w.text()).toContain('u@example.com');
	});

	test('non-CoClaw oauth (e.g. openai-codex) is now removable too — no provider whitelist', async () => {
		const w = makeWrapper({ provider: 'openai-codex', type: 'oauth', email: 'd@example.com', profileId: 'openai-codex:default', source: 'profile', removable: true });
		const btn = w.find('[data-testid="btn-remove-provider"]');
		expect(btn.exists()).toBe(true);
		await btn.trigger('click');
		expect(w.emitted('remove')[0]).toEqual([{ provider: 'openai-codex', source: 'profile' }]);
	});

	test('oauth with backend removable=false → button rendered but disabled (backend authoritative)', () => {
		const w = makeWrapper({ provider: 'openai-codex', type: 'oauth', email: 'd@example.com', profileId: 'openai-codex:default', source: 'profile', removable: false });
		const btn = w.find('[data-testid="btn-remove-provider"]');
		expect(btn.exists()).toBe(true);
		expect(btn.element.disabled).toBe(true);
	});

	test('api_key profile renders NO oauth badge', () => {
		const w = makeWrapper({ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default', source: 'profile', removable: true });
		expect(w.find('[data-testid="provider-oauth-tag"]').exists()).toBe(false);
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

	// --- 来源标签（§2.4 source）：仅 inline/env 打标签，账本 profile 不打标签 ---
	test('profile source renders NO source tag', () => {
		const w = makeWrapper({ provider: 'groq', type: 'api_key', keyPreview: 'g…X', profileId: 'groq:default', source: 'profile', removable: true });
		expect(w.find('[data-testid="provider-source-tag"]').exists()).toBe(false);
	});

	test('inline source: tag + emits source=inline, button enabled', async () => {
		const w = makeWrapper({ provider: 'minimax', type: 'api_key', keyPreview: 'mm…Y', profileId: 'minimax#inline', source: 'inline', removable: true });
		const sourceTag = w.find('[data-testid="provider-source-tag"]');
		expect(sourceTag.text()).toBe('modelConfig.providerAuth.source.inline');
		expect(sourceTag.attributes('data-size')).toBe('sm');
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
		// 退化为 profile → 不打来源标签
		expect(w.find('[data-testid="provider-source-tag"]').exists()).toBe(false);
		const btn = w.find('[data-testid="btn-remove-provider"]');
		expect(btn.element.disabled).toBe(false);
		await btn.trigger('click');
		expect(w.emitted('remove')[0]).toEqual([{ provider: 'groq', source: 'profile' }]);
	});
});
