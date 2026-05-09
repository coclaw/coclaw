import assert from 'node:assert/strict';
import test from 'node:test';

import { PRESETS, validatePresets } from './web-agent.presets.js';

// 锁住 PRESETS 全字段：未来手滑改错 URL / 改错 sort / 错配 name 都会立刻失败
// 注意：千问/Kimi 的 URL 已与设计稿原始值不同，这里以代码现状为准
test('PRESETS: 5 条精确匹配 slug→name→url→sort（防止手滑漂移）', () => {
	const expected = [
		{ slug: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/',   sort: 1 },
		{ slug: 'doubao',   name: '豆包',     url: 'https://www.doubao.com/chat/',  sort: 2 },
		{ slug: 'qwen',     name: '千问',     url: 'https://www.qianwen.com/',      sort: 3 },
		{ slug: 'kimi',     name: 'Kimi',     url: 'https://www.kimi.com/',         sort: 4 },
		{ slug: 'yuanbao',  name: '元宝',     url: 'https://yuanbao.tencent.com/',  sort: 5 },
	];
	assert.equal(PRESETS.length, expected.length);
	assert.deepEqual(PRESETS, expected);
});

test('PRESETS: 每条 URL 都是 https 开头（防止意外配置 http 或 javascript 协议）', () => {
	for (const p of PRESETS) {
		assert.match(p.url, /^https:\/\//, `${p.slug} url is not https: ${p.url}`);
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
