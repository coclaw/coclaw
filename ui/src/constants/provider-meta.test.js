import { test, expect } from 'vitest';

import { PROVIDER_META, getProviderMeta } from './provider-meta.js';

const POPULAR_IDS = ['anthropic', 'openai', 'google', 'groq', 'deepseek', 'moonshot', 'zai'];

test('PROVIDER_META 包含 7 个常用 provider', () => {
	const popularIds = Object.entries(PROVIDER_META)
		.filter(([, meta]) => meta.popular === true)
		.map(([id]) => id);
	expect(popularIds.sort()).toEqual([...POPULAR_IDS].sort());
});

test('每个 popular 条目都有 displayName 与 dashboardUrl', () => {
	for (const id of POPULAR_IDS) {
		const entry = PROVIDER_META[id];
		expect(entry, `missing provider entry: ${id}`).toBeDefined();
		expect(typeof entry.displayName).toBe('string');
		expect(entry.displayName.length).toBeGreaterThan(0);
		expect(entry.popular).toBe(true);
		expect(typeof entry.dashboardUrl).toBe('string');
		expect(entry.dashboardUrl.startsWith('https://')).toBe(true);
	}
});

test('getProviderMeta 命中返回真实 meta', () => {
	const meta = getProviderMeta('anthropic');
	expect(meta.displayName).toBe('Anthropic Claude');
	expect(meta.popular).toBe(true);
	expect(meta.dashboardUrl).toBeDefined();
});

test('getProviderMeta 未知 id 返回 fallback', () => {
	const meta = getProviderMeta('unknown-provider-xyz');
	expect(meta).toEqual({ displayName: 'unknown-provider-xyz', popular: false });
	expect(meta.dashboardUrl).toBeUndefined();
});

test('getProviderMeta 对空字符串走 fallback', () => {
	const meta = getProviderMeta('');
	expect(meta).toEqual({ displayName: '', popular: false });
});

// 回归锁：智谱的 popular meta 必须挂在 OpenClaw 真实 provider id 'zai' 上，
// 而非旧的错误 key 'zhipuai'（后者匹配不上 catalog → 智谱掉出"常用"组）。
test('智谱真实 catalog id zai 被识别为常用', () => {
	expect(getProviderMeta('zai').popular).toBe(true);
	expect(getProviderMeta('zai').displayName).toBe('智谱 AI (GLM)');
	// 旧 key 已不存在 → 走 fallback、不再 popular
	expect(getProviderMeta('zhipuai').popular).toBe(false);
});
