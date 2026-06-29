// @vitest-environment node
import { describe, test, expect } from 'vitest';
import { generateModelTags } from './model-tags.js';

describe('generateModelTags', () => {
	test('model 为 null → 返回空数组', () => {
		expect(generateModelTags(null)).toEqual([]);
	});

	test('model 为 undefined → 返回空数组', () => {
		expect(generateModelTags(undefined)).toEqual([]);
	});

	test('完整 model → 包含 name + provider + 所有 feature 标签', () => {
		const model = {
			id: 'claude-3-opus',
			name: 'Claude 3 Opus',
			provider: 'anthropic',
			contextWindow: 200000,
			reasoning: true,
			input: ['text', 'image', 'document'],
		};
		const tags = generateModelTags(model);
		const types = tags.map(t => t.type);
		expect(types).toContain('name');
		expect(types).toContain('provider');
		expect(types).toContain('feature');
		expect(types).toContain('context');
		expect(tags.find(t => t.type === 'name').label).toBe('Claude 3 Opus');
		expect(tags.find(t => t.type === 'provider').labelKey).toBe('dashboard.model.provider');
		// provider 名经 getProviderName 取（anthropic → 'Anthropic Claude'，单一数据源 PROVIDER_META）
		expect(tags.find(t => t.type === 'provider').labelParams).toEqual({ name: 'Anthropic Claude' });
		expect(tags.find(t => t.labelKey === 'dashboard.model.reasoning')).toBeTruthy();
		expect(tags.find(t => t.labelKey === 'dashboard.model.vision')).toBeTruthy();
		expect(tags.find(t => t.labelKey === 'dashboard.model.document')).toBeTruthy();
		expect(tags.find(t => t.labelKey === 'dashboard.model.context200k')).toBeTruthy();
	});

	test('reasoning=false → 不包含推理标签', () => {
		const tags = generateModelTags({ name: 'Test', reasoning: false });
		expect(tags.find(t => t.labelKey === 'dashboard.model.reasoning')).toBeUndefined();
	});

	test('无 image input → 不包含视觉标签', () => {
		const tags = generateModelTags({ name: 'Test', input: ['text'] });
		expect(tags.find(t => t.labelKey === 'dashboard.model.vision')).toBeUndefined();
	});

	test('contextWindow >= 200000 → context200k', () => {
		const tags = generateModelTags({ contextWindow: 200000 });
		expect(tags.find(t => t.type === 'context').labelKey).toBe('dashboard.model.context200k');
	});

	test('contextWindow 100000 → context100k', () => {
		const tags = generateModelTags({ contextWindow: 100000 });
		expect(tags.find(t => t.type === 'context').labelKey).toBe('dashboard.model.context100k');
	});

	test('contextWindow 32000 → context32k', () => {
		const tags = generateModelTags({ contextWindow: 32000 });
		expect(tags.find(t => t.type === 'context').labelKey).toBe('dashboard.model.context32k');
	});

	test('contextWindow 10000 → 无上下文标签', () => {
		const tags = generateModelTags({ contextWindow: 10000 });
		expect(tags.find(t => t.type === 'context')).toBeUndefined();
	});

	test('未知 provider → labelParams 使用原始 provider 字符串', () => {
		const tags = generateModelTags({ provider: 'xai' });
		const provTag = tags.find(t => t.type === 'provider');
		expect(provTag.labelKey).toBe('dashboard.model.provider');
		expect(provTag.labelParams).toEqual({ name: 'xai' });
	});

	test('空对象 → 返回空数组', () => {
		expect(generateModelTags({})).toEqual([]);
	});

	test('provider 名走 getProviderName：品牌名经 PROVIDER_META 单一数据源', () => {
		// google → 'Google Gemini'（单一数据源后比旧 PROVIDER_NAMES 的 'Google' 更具体）
		expect(generateModelTags({ provider: 'google' }).find(t => t.type === 'provider').labelParams)
			.toEqual({ name: 'Google Gemini' });
		// meta / mistral：从原 model-tags.PROVIDER_NAMES 并入 PROVIDER_META，标签不退化为裸 id
		expect(generateModelTags({ provider: 'meta' }).find(t => t.type === 'provider').labelParams)
			.toEqual({ name: 'Meta' });
		expect(generateModelTags({ provider: 'mistral' }).find(t => t.type === 'provider').labelParams)
			.toEqual({ name: 'Mistral' });
		// openai / deepseek 维持原品牌名
		expect(generateModelTags({ provider: 'openai' }).find(t => t.type === 'provider').labelParams)
			.toEqual({ name: 'OpenAI' });
	});
});
