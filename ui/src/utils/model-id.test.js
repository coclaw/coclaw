// @vitest-environment node
import { describe, test, expect } from 'vitest';

import { parseModelId } from './model-id.js';

describe('parseModelId', () => {
	test('空 / 非字符串 → null', () => {
		expect(parseModelId('')).toBe(null);
		expect(parseModelId(null)).toBe(null);
		expect(parseModelId(undefined)).toBe(null);
		expect(parseModelId(123)).toBe(null);
	});

	test('正常 provider/model 按第一个 / 拆两段', () => {
		expect(parseModelId('groq/llama-3.3-70b')).toEqual({ provider: 'groq', model: 'llama-3.3-70b' });
	});

	test('model 段内含多个 / 只按第一个拆', () => {
		expect(parseModelId('openai-codex/gpt-5/preview')).toEqual({ provider: 'openai-codex', model: 'gpt-5/preview' });
	});

	test('无 / 整串当 model 兜底（provider 空）', () => {
		expect(parseModelId('llama3')).toEqual({ provider: '', model: 'llama3' });
	});

	test('/ 落在首或尾 → 兜底当 model', () => {
		expect(parseModelId('/model')).toEqual({ provider: '', model: '/model' });
		expect(parseModelId('provider/')).toEqual({ provider: '', model: 'provider/' });
	});
});
