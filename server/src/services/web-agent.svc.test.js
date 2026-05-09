import assert from 'node:assert/strict';
import test from 'node:test';

import { recordClick } from './web-agent.svc.js';

test('recordClick: 不可见时返 false 且不调 incrementClick', async () => {
	let visibleArgs = null;
	let incrementCalled = false;
	const ok = await recordClick(
		{ userId: 100n, webAgentId: 9999 },
		{
			findVisibleAgentIdImpl: async (args) => { visibleArgs = args; return null; },
			incrementClickImpl: async () => { incrementCalled = true; },
		},
	);
	assert.equal(ok, false);
	assert.equal(incrementCalled, false);
	// 校验入参确实带 userId/webAgentId（防止 mock 写错时被误掩盖）
	assert.deepEqual(visibleArgs, { userId: 100n, webAgentId: 9999 });
});

test('recordClick: 可见时返 true 且调 incrementClick 透传 userId/webAgentId', async () => {
	let incrementArgs = null;
	let incrementCallCount = 0;
	const ok = await recordClick(
		{ userId: 100n, webAgentId: 7 },
		{
			findVisibleAgentIdImpl: async () => 7,
			incrementClickImpl: async (args) => {
				incrementCallCount += 1;
				incrementArgs = args;
			},
		},
	);
	assert.equal(ok, true);
	assert.deepEqual(incrementArgs, { userId: 100n, webAgentId: 7 });
	// 防止同一次成功记录里 increment 被多次调用（实测点击数会失真）
	assert.equal(incrementCallCount, 1);
});

test('recordClick: incrementClick 抛错时透传出去（不静默吞）', async () => {
	const expected = new Error('upsert failed');
	await assert.rejects(
		() => recordClick(
			{ userId: 100n, webAgentId: 7 },
			{
				findVisibleAgentIdImpl: async () => 7,
				incrementClickImpl: async () => { throw expected; },
			},
		),
		(err) => err === expected,
	);
});
