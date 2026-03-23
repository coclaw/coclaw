import { describe, test, expect } from 'vitest';
import { CAPABILITY_MAP, mapToolsToCapabilities } from './capability-map.js';

describe('CAPABILITY_MAP', () => {
	test('包含 11 个能力定义', () => {
		expect(CAPABILITY_MAP).toHaveLength(11);
	});
});

describe('mapToolsToCapabilities', () => {
	test('所有 11 个能力标签都能被正确匹配', () => {
		const allTools = CAPABILITY_MAP
			.filter(c => c.matchTools)
			.flatMap(c => c.matchTools);
		const result = mapToolsToCapabilities(allTools, true);
		expect(result).toHaveLength(11);
		expect(result.map(r => r.id)).toEqual(CAPABILITY_MAP.map(c => c.id));
	});

	test('toolIds 为空数组 → 返回空数组', () => {
		expect(mapToolsToCapabilities([])).toEqual([]);
	});

	test('ttsEnabled=true 时包含语音标签', () => {
		const result = mapToolsToCapabilities([], true);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('tts');
		expect(result[0].labelKey).toBe('dashboard.cap.tts');
	});

	test('ttsEnabled=false 时不包含语音标签', () => {
		const result = mapToolsToCapabilities([], false);
		expect(result.find(r => r.id === 'tts')).toBeUndefined();
	});

	test('工具部分匹配（只有 web_search 没有 web_fetch）也能命中', () => {
		const result = mapToolsToCapabilities(['web_search']);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('web_search');
	});

	test('返回顺序与 CAPABILITY_MAP 一致', () => {
		// 倒序传入工具，验证输出仍按 MAP 顺序
		const tools = ['message', 'browser', 'exec', 'web_search'];
		const result = mapToolsToCapabilities(tools);
		const ids = result.map(r => r.id);
		expect(ids).toEqual(['web_search', 'code_exec', 'browser', 'messaging']);
	});

	test('返回对象只包含 id, label, icon 字段', () => {
		const result = mapToolsToCapabilities(['web_search']);
		expect(Object.keys(result[0]).sort()).toEqual(['icon', 'id', 'labelKey']);
	});

	test('null 输入 → 返回空数组', () => {
		expect(mapToolsToCapabilities(null)).toEqual([]);
	});

	test('undefined 输入 → 返回空数组', () => {
		expect(mapToolsToCapabilities(undefined)).toEqual([]);
	});
});
