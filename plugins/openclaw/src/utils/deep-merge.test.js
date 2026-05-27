import assert from 'node:assert/strict';
import test from 'node:test';

import { deepMergeInto } from './deep-merge.js';

test('deepMergeInto: 递归并入嵌套 plain object，保留同级其它键', () => {
	const target = { models: { providers: { foo: { baseUrl: 'a' } } } };
	deepMergeInto(target, { models: { providers: { bar: { baseUrl: 'b' } } } });
	assert.deepEqual(target, {
		models: { providers: { foo: { baseUrl: 'a' }, bar: { baseUrl: 'b' } } },
	});
});

test('deepMergeInto: codex 形态 patch 注册默认模型别名，不动既有 agents 字段', () => {
	const target = { agents: { defaults: { model: 'keep-me', models: { 'old/x': {} } } } };
	deepMergeInto(target, { agents: { defaults: { models: { 'openai-codex/gpt': {} } } } });
	assert.deepEqual(target, {
		agents: { defaults: { model: 'keep-me', models: { 'old/x': {}, 'openai-codex/gpt': {} } } },
	});
});

test('deepMergeInto: 原始值 / 数组覆盖而非合并', () => {
	const target = { a: 1, list: [1, 2], obj: { x: 1 } };
	deepMergeInto(target, { a: 2, list: [9], obj: 'now-a-string' });
	assert.deepEqual(target, { a: 2, list: [9], obj: 'now-a-string' });
});

test('deepMergeInto: target 中非对象处遇 patch 对象时替换为新对象再并入', () => {
	const target = { models: 'was-a-string' };
	deepMergeInto(target, { models: { providers: { foo: {} } } });
	assert.deepEqual(target, { models: { providers: { foo: {} } } });
});

test('deepMergeInto: 跳过原型污染键', () => {
	const target = {};
	deepMergeInto(target, JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}'));
	assert.equal(target.ok, 1);
	assert.equal(({}).polluted, undefined);
	assert.equal(Object.prototype.polluted, undefined);
});

test('deepMergeInto: 嵌套层内的原型污染键也跳过', () => {
	const target = { nested: {} };
	deepMergeInto(target, JSON.parse('{"nested": {"constructor": {"bad": 1}, "good": 2}}'));
	assert.equal(target.nested.good, 2);
	assert.equal(target.nested.constructor, Object); // 未被覆盖
});

test('deepMergeInto: target 非 plain object 时静默不动', () => {
	// 数组 / null / 原始值作为 target 都无处可并，不抛错
	const arr = [1];
	deepMergeInto(arr, { 0: 9 });
	assert.deepEqual(arr, [1]);
	assert.doesNotThrow(() => deepMergeInto(null, { a: 1 }));
	assert.doesNotThrow(() => deepMergeInto(5, { a: 1 }));
});

test('deepMergeInto: patch 非 plain object 时静默不动', () => {
	const target = { a: 1 };
	deepMergeInto(target, null);
	deepMergeInto(target, undefined);
	deepMergeInto(target, [1, 2]);
	deepMergeInto(target, 'str');
	assert.deepEqual(target, { a: 1 });
});
