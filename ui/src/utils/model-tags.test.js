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
		expect(tags.find(t => t.type === 'provider').label).toBe('由 Anthropic 提供');
		expect(tags.find(t => t.label === '深度推理')).toBeTruthy();
		expect(tags.find(t => t.label === '支持视觉')).toBeTruthy();
		expect(tags.find(t => t.label === '文档理解')).toBeTruthy();
		expect(tags.find(t => t.label === '200K+ 上下文')).toBeTruthy();
	});

	test('reasoning=false → 不包含推理标签', () => {
		const tags = generateModelTags({ name: 'Test', reasoning: false });
		expect(tags.find(t => t.label === '深度推理')).toBeUndefined();
	});

	test('无 image input → 不包含视觉标签', () => {
		const tags = generateModelTags({ name: 'Test', input: ['text'] });
		expect(tags.find(t => t.label === '支持视觉')).toBeUndefined();
	});

	test('contextWindow >= 200000 → 200K+ 上下文', () => {
		const tags = generateModelTags({ contextWindow: 200000 });
		expect(tags.find(t => t.type === 'context').label).toBe('200K+ 上下文');
	});

	test('contextWindow 100000 → 100K 上下文', () => {
		const tags = generateModelTags({ contextWindow: 100000 });
		expect(tags.find(t => t.type === 'context').label).toBe('100K 上下文');
	});

	test('contextWindow 32000 → 32K 上下文', () => {
		const tags = generateModelTags({ contextWindow: 32000 });
		expect(tags.find(t => t.type === 'context').label).toBe('32K 上下文');
	});

	test('contextWindow 10000 → 无上下文标签', () => {
		const tags = generateModelTags({ contextWindow: 10000 });
		expect(tags.find(t => t.type === 'context')).toBeUndefined();
	});

	test('未知 provider → 直接使用 provider 字符串', () => {
		const tags = generateModelTags({ provider: 'xai' });
		expect(tags.find(t => t.type === 'provider').label).toBe('由 xai 提供');
	});

	test('空对象 → 返回空数组', () => {
		expect(generateModelTags({})).toEqual([]);
	});
});
