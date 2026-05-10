import assert from 'node:assert/strict';
import test from 'node:test';

import { hide, recordClick } from './web-agent.svc.js';

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

test('hide: 不可见时返 false 且不调 setHiddenNow', async () => {
	let visibleArgs = null;
	let setCalled = false;
	const ok = await hide(
		{ userId: 100n, webAgentId: 9999 },
		{
			findVisibleAgentIdImpl: async (args) => { visibleArgs = args; return null; },
			setHiddenNowImpl: async () => { setCalled = true; return 1; },
		},
	);
	assert.equal(ok, false);
	assert.equal(setCalled, false);
	assert.deepEqual(visibleArgs, { userId: 100n, webAgentId: 9999 });
});

test('hide: 可见但用户从未点击过该 Agent → 返 false（setHiddenNow 命中 0 行）', async () => {
	let setArgs = null;
	const ok = await hide(
		{ userId: 100n, webAgentId: 7 },
		{
			findVisibleAgentIdImpl: async () => 7,
			setHiddenNowImpl: async (args) => { setArgs = args; return 0; },
		},
	);
	assert.equal(ok, false);
	assert.deepEqual(setArgs, { userId: 100n, webAgentId: 7 });
});

test('hide: 可见且 click 行存在 → 返 true 且调 setHiddenNow 透传 userId/webAgentId', async () => {
	let setArgs = null;
	let setCallCount = 0;
	const ok = await hide(
		{ userId: 100n, webAgentId: 7 },
		{
			findVisibleAgentIdImpl: async () => 7,
			setHiddenNowImpl: async (args) => {
				setCallCount += 1;
				setArgs = args;
				return 1;
			},
		},
	);
	assert.equal(ok, true);
	assert.deepEqual(setArgs, { userId: 100n, webAgentId: 7 });
	assert.equal(setCallCount, 1);
});

test('hide: setHiddenNow 抛错时透传出去（不静默吞）', async () => {
	const expected = new Error('updateMany failed');
	await assert.rejects(
		() => hide(
			{ userId: 100n, webAgentId: 7 },
			{
				findVisibleAgentIdImpl: async () => 7,
				setHiddenNowImpl: async () => { throw expected; },
			},
		),
		(err) => err === expected,
	);
});
