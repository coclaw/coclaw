// @vitest-environment node
import { describe, test, expect } from 'vitest';

import { pickGuidanceState } from './guidance-state.js';

describe('pickGuidanceState', () => {
	test('无凭据 → noKey（优先级最高，盖过 primary/effective）', () => {
		expect(pickGuidanceState({ hasAny: false, primary: null, effective: false })).toBe('noKey');
		// 即便恰好带了 primary / effective，只要没凭据仍优先报 noKey
		expect(pickGuidanceState({ hasAny: false, primary: 'groq/llama', effective: true })).toBe('noKey');
	});

	test('有凭据但未设主模型 → noPrimary', () => {
		expect(pickGuidanceState({ hasAny: true, primary: null, effective: false })).toBe('noPrimary');
		// 空字符串也视作未设
		expect(pickGuidanceState({ hasAny: true, primary: '', effective: false })).toBe('noPrimary');
	});

	test('有凭据 + 已设主模型但失效 → invalid', () => {
		expect(pickGuidanceState({ hasAny: true, primary: 'groq/llama', effective: false })).toBe('invalid');
	});

	test('凭据齐 + 主模型有效 → null（不提示）', () => {
		expect(pickGuidanceState({ hasAny: true, primary: 'groq/llama', effective: true })).toBe(null);
	});

	test('优先级钉死：primary 为 null 时落 noPrimary，不落 invalid', () => {
		expect(pickGuidanceState({ hasAny: true, primary: null, effective: false })).toBe('noPrimary');
	});

	test('无参数 / 空对象调用不抛错，按"无凭据"降级为 noKey', () => {
		expect(pickGuidanceState()).toBe('noKey');
		expect(pickGuidanceState({})).toBe('noKey');
	});
});
