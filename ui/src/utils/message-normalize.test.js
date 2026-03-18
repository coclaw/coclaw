import { describe, test, expect } from 'vitest';

import { wrapOcMessages } from './message-normalize.js';

describe('wrapOcMessages', () => {
	test('将扁平消息包装为 JSONL 行级结构', () => {
		const flat = [
			{ role: 'user', content: 'hello', timestamp: 1000 },
			{ role: 'assistant', content: 'hi', model: 'claude-3', stopReason: 'end_turn' },
		];
		const result = wrapOcMessages(flat);

		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({ type: 'message', id: 'oc-0', message: flat[0] });
		expect(result[1]).toEqual({ type: 'message', id: 'oc-1', message: flat[1] });
	});

	test('空数组返回空数组', () => {
		expect(wrapOcMessages([])).toEqual([]);
	});

	test('非数组输入返回空数组', () => {
		expect(wrapOcMessages(null)).toEqual([]);
		expect(wrapOcMessages(undefined)).toEqual([]);
		expect(wrapOcMessages('string')).toEqual([]);
		expect(wrapOcMessages(42)).toEqual([]);
	});

	test('保留原始 message 对象引用', () => {
		const msg = { role: 'user', content: 'test' };
		const result = wrapOcMessages([msg]);
		expect(result[0].message).toBe(msg);
	});

	test('id 按索引生成', () => {
		const flat = Array.from({ length: 5 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
		const result = wrapOcMessages(flat);
		expect(result.map((r) => r.id)).toEqual(['oc-0', 'oc-1', 'oc-2', 'oc-3', 'oc-4']);
	});
});
