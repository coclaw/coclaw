import assert from 'node:assert/strict';
import test from 'node:test';

import { PRESETS, validatePresets } from './web-agent.presets.js';

test('PRESETS: 5 个条目，slug/name/url/sort 齐全', () => {
	assert.equal(PRESETS.length, 5);
	for (const p of PRESETS) {
		assert.ok(p.slug, `missing slug: ${JSON.stringify(p)}`);
		assert.ok(p.name, `missing name: ${JSON.stringify(p)}`);
		assert.ok(p.url, `missing url: ${JSON.stringify(p)}`);
		assert.equal(typeof p.sort, 'number');
	}
});

test('PRESETS: slug 集合与设计第五章一致', () => {
	const slugs = PRESETS.map(p => p.slug).sort();
	assert.deepEqual(slugs, ['deepseek', 'doubao', 'kimi', 'qwen', 'yuanbao']);
});

test('PRESETS: sort 严格递增 1..N', () => {
	const sorts = PRESETS.map(p => p.sort);
	for (let i = 0; i < sorts.length; i += 1) {
		assert.equal(sorts[i], i + 1);
	}
});

test('validatePresets: 合法清单不抛错', () => {
	assert.doesNotThrow(() => validatePresets(PRESETS));
});

test('validatePresets: 重复 slug 抛 duplicate', () => {
	const presets = [
		{ slug: 'a', name: 'A', url: 'https://a/', sort: 1 },
		{ slug: 'a', name: 'B', url: 'https://b/', sort: 2 },
	];
	assert.throws(() => validatePresets(presets), /duplicate preset slug: a/);
});

test('validatePresets: slug 缺失抛 missing slug/name/url', () => {
	const presets = [{ name: 'A', url: 'https://a/', sort: 1 }];
	assert.throws(() => validatePresets(presets), /invalid preset/);
});

test('validatePresets: name 缺失抛 missing slug/name/url', () => {
	const presets = [{ slug: 'a', url: 'https://a/', sort: 1 }];
	assert.throws(() => validatePresets(presets), /invalid preset/);
});

test('validatePresets: url 缺失抛 missing slug/name/url', () => {
	const presets = [{ slug: 'a', name: 'A', sort: 1 }];
	assert.throws(() => validatePresets(presets), /invalid preset/);
});

test('validatePresets: 空清单合法（不抛错）', () => {
	assert.doesNotThrow(() => validatePresets([]));
});
