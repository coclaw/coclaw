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

	describe('credSignalKnown=false（旧插件，凭据信号未知）', () => {
		test('压制 noKey：hasAny=false 但 primary 已设 → null（不报 noKey/invalid）', () => {
			expect(pickGuidanceState({ hasAny: false, primary: 'groq/llama', effective: false, credSignalKnown: false })).toBe(null);
		});

		test('压制 invalid：primary 已设 + effective=false → null', () => {
			expect(pickGuidanceState({ hasAny: true, primary: 'groq/llama', effective: false, credSignalKnown: false })).toBe(null);
		});

		test('noPrimary 仍可显示：primary 为空 → noPrimary（不被 noKey 压制吞掉）', () => {
			// 关键：旧插件 hasAny 默认 false，若按"先判 noKey 再事后压制"会把本该显示的 noPrimary 一起吞掉
			expect(pickGuidanceState({ hasAny: false, primary: null, effective: false, credSignalKnown: false })).toBe('noPrimary');
			expect(pickGuidanceState({ hasAny: false, primary: '', effective: false, credSignalKnown: false })).toBe('noPrimary');
		});

		test('凭据齐全形态下也只看 primary 是否为空：primary 有 → null', () => {
			expect(pickGuidanceState({ hasAny: true, primary: 'groq/llama', effective: true, credSignalKnown: false })).toBe(null);
		});
	});
});
