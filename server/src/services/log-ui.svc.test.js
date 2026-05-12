import assert from 'node:assert/strict';
import test from 'node:test';

import {
	acceptBatch,
	pruneStaleEntries,
	startUiLogCleanupTimer,
	stopUiLogCleanupTimer,
	__resetUiLogState,
	__getUiLogState,
	__UI_LOG_TTL_MS,
	__UI_LOG_CLEANUP_INTERVAL_MS,
} from './log-ui.svc.js';

test.beforeEach(() => {
	stopUiLogCleanupTimer();
	__resetUiLogState();
});

test.after(() => {
	stopUiLogCleanupTimer();
	__resetUiLogState();
});

// --- acceptBatch ---

test('acceptBatch: 未知 uiId 首批 seq=1 应接受', () => {
	assert.equal(acceptBatch('ui-A', 1, 1000), true);
	const map = __getUiLogState();
	assert.deepEqual(map.get('ui-A'), { lastSeq: 1, lastSeenAt: 1000 });
});

test('acceptBatch: 严格递增 seq 应连续接受并更新 lastSeenAt', () => {
	acceptBatch('ui-A', 1, 1000);
	assert.equal(acceptBatch('ui-A', 2, 2000), true);
	assert.equal(acceptBatch('ui-A', 3, 3000), true);
	assert.deepEqual(__getUiLogState().get('ui-A'), { lastSeq: 3, lastSeenAt: 3000 });
});

test('acceptBatch: seq 等于 lastSeq 视为重传，应拒绝但 lastSeq 不回退', () => {
	acceptBatch('ui-A', 5, 1000);
	assert.equal(acceptBatch('ui-A', 5, 9999), false);
	const entry = __getUiLogState().get('ui-A');
	assert.equal(entry.lastSeq, 5);
});

test('acceptBatch: seq 小于 lastSeq 视为乱序重传，应拒绝但 lastSeq 不回退', () => {
	acceptBatch('ui-A', 5, 1000);
	assert.equal(acceptBatch('ui-A', 4, 2000), false);
	const entry = __getUiLogState().get('ui-A');
	assert.equal(entry.lastSeq, 5);
});

test('acceptBatch: 重传也刷新 lastSeenAt（活跃重试客户端不被 TTL 误清）', () => {
	acceptBatch('ui-A', 5, 1000);
	acceptBatch('ui-A', 5, 9999); // 重传同 seq
	assert.equal(__getUiLogState().get('ui-A').lastSeenAt, 9999);
	acceptBatch('ui-A', 3, 50_000); // 乱序老 seq
	assert.equal(__getUiLogState().get('ui-A').lastSeenAt, 50_000);
});

test('acceptBatch: 跳号递增（5→10）应接受，覆盖在飞重试场景', () => {
	acceptBatch('ui-A', 5, 1000);
	assert.equal(acceptBatch('ui-A', 10, 2000), true);
	assert.deepEqual(__getUiLogState().get('ui-A'), { lastSeq: 10, lastSeenAt: 2000 });
});

test('acceptBatch: 多 uiId 独立分桶互不干扰', () => {
	acceptBatch('ui-A', 1, 1000);
	acceptBatch('ui-B', 1, 1100);
	assert.equal(acceptBatch('ui-A', 2, 2000), true);
	assert.equal(acceptBatch('ui-B', 2, 2100), true);
	assert.deepEqual(__getUiLogState().get('ui-A'), { lastSeq: 2, lastSeenAt: 2000 });
	assert.deepEqual(__getUiLogState().get('ui-B'), { lastSeq: 2, lastSeenAt: 2100 });
});

test('acceptBatch: 默认 now 取 Date.now()', () => {
	const before = Date.now();
	acceptBatch('ui-A', 1);
	const after = Date.now();
	const entry = __getUiLogState().get('ui-A');
	assert.ok(entry.lastSeenAt >= before && entry.lastSeenAt <= after);
});

// --- pruneStaleEntries ---

test('pruneStaleEntries: lastSeenAt 早于 now-ttl 的条目应被清理', () => {
	acceptBatch('ui-A', 1, 1_000);
	acceptBatch('ui-B', 1, 5_000);
	pruneStaleEntries(7_000, 3_000); // ttl=3s，ui-A 6s 前活动 → 清理；ui-B 2s 前 → 保留
	const map = __getUiLogState();
	assert.equal(map.has('ui-A'), false);
	assert.equal(map.has('ui-B'), true);
});

test('pruneStaleEntries: 恰好 lastSeenAt+ttl == now 不应清理（边界保留）', () => {
	acceptBatch('ui-A', 1, 1_000);
	pruneStaleEntries(4_000, 3_000); // 1000+3000 == 4000，不严格大于
	assert.equal(__getUiLogState().has('ui-A'), true);
});

test('pruneStaleEntries: 全部新鲜则不清理任何条目', () => {
	acceptBatch('ui-A', 1, 1_000);
	acceptBatch('ui-B', 1, 1_100);
	pruneStaleEntries(1_500, 3_000);
	assert.equal(__getUiLogState().size, 2);
});

test('pruneStaleEntries: 全部过期则清空 map', () => {
	acceptBatch('ui-A', 1, 1_000);
	acceptBatch('ui-B', 1, 1_100);
	pruneStaleEntries(99_000, 3_000);
	assert.equal(__getUiLogState().size, 0);
});

test('pruneStaleEntries: 默认 ttlMs = 1h', () => {
	acceptBatch('ui-A', 1, 0);
	pruneStaleEntries(__UI_LOG_TTL_MS + 1, undefined); // 略超 1h
	assert.equal(__getUiLogState().has('ui-A'), false);
});

// --- 定时器 ---

test('startUiLogCleanupTimer: 周期触发 pruneStaleEntries，应清理过期条目', async () => {
	// 写一个 lastSeenAt 远远早于 now-ttl 的条目，启 50ms 周期定时器，等一拍后应被清理
	acceptBatch('ui-A', 1, 0);
	startUiLogCleanupTimer(50);
	await new Promise(resolve => setTimeout(resolve, 120));
	stopUiLogCleanupTimer();
	assert.equal(__getUiLogState().has('ui-A'), false);
});

test('startUiLogCleanupTimer: 多次调用幂等（不会创建多个定时器）', () => {
	startUiLogCleanupTimer(1_000_000);
	startUiLogCleanupTimer(1_000_000); // 第二次应 no-op
	stopUiLogCleanupTimer();
	// 不抛错即视为通过
});

test('stopUiLogCleanupTimer: 停止后不再触发', async () => {
	acceptBatch('ui-A', 1, 0);
	startUiLogCleanupTimer(30);
	stopUiLogCleanupTimer();
	await new Promise(resolve => setTimeout(resolve, 80));
	// 定时器已停，条目不该被清
	assert.equal(__getUiLogState().has('ui-A'), true);
});

test('stopUiLogCleanupTimer: 未启动状态下调用不抛错', () => {
	stopUiLogCleanupTimer();
	stopUiLogCleanupTimer();
});

test('常量导出: TTL 与 CLEANUP_INTERVAL 与设计值一致', () => {
	assert.equal(__UI_LOG_TTL_MS, 60 * 60 * 1000);
	assert.equal(__UI_LOG_CLEANUP_INTERVAL_MS, 5 * 60 * 1000);
});
