// @vitest-environment node
import { describe, test, expect } from 'vitest';

import { wrapOcMessages } from './message-normalize.js';

describe('wrapOcMessages', () => {
	test('有 timestamp 时生成 role+timestamp 稳定 id', () => {
		const flat = [
			{ role: 'user', content: 'hello', timestamp: 1000 },
			{ role: 'assistant', content: 'hi', model: 'claude-3', timestamp: 2000 },
		];
		const result = wrapOcMessages(flat);

		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({ type: 'message', id: 'oc-user-1000', message: flat[0] });
		expect(result[1]).toEqual({ type: 'message', id: 'oc-assistant-2000', message: flat[1] });
	});

	test('无 timestamp 时回退到索引 id', () => {
		const flat = [
			{ role: 'user', content: 'hello' },
			{ role: 'assistant', content: 'hi', model: 'claude-3', stopReason: 'end_turn' },
		];
		const result = wrapOcMessages(flat);

		expect(result[0].id).toBe('oc-0');
		expect(result[1].id).toBe('oc-1');
	});

	test('混合有无 timestamp 的消息', () => {
		const flat = [
			{ role: 'user', content: 'a', timestamp: 100 },
			{ role: 'assistant', content: 'b' },
			{ role: 'user', content: 'c', timestamp: 300 },
		];
		const result = wrapOcMessages(flat);

		expect(result[0].id).toBe('oc-user-100');
		expect(result[1].id).toBe('oc-1');
		expect(result[2].id).toBe('oc-user-300');
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
		const msg = { role: 'user', content: 'test', timestamp: 999 };
		const result = wrapOcMessages([msg]);
		expect(result[0].message).toBe(msg);
	});

	test('id 在分页窗口变化时保持稳定', () => {
		// 模拟首次加载 3 条
		const page1 = [
			{ role: 'user', content: 'a', timestamp: 100 },
			{ role: 'assistant', content: 'b', timestamp: 200 },
			{ role: 'user', content: 'c', timestamp: 300 },
		];
		// 模拟扩展到 5 条（前面多了 2 条更早的消息）
		const page2 = [
			{ role: 'user', content: 'old1', timestamp: 10 },
			{ role: 'assistant', content: 'old2', timestamp: 20 },
			...page1,
		];

		const ids1 = wrapOcMessages(page1).map((r) => r.id);
		const ids2 = wrapOcMessages(page2).map((r) => r.id);

		// page1 的 3 个 id 应与 page2 后 3 个 id 完全一致
		expect(ids2.slice(2)).toEqual(ids1);
	});
});
