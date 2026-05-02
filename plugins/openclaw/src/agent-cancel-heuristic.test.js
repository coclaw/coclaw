import assert from 'node:assert/strict';
import test from 'node:test';

import {
	decideCancelResponse,
	RUN_DURATION_GONE_THRESHOLD_MS,
	ABORT_DURATION_GONE_THRESHOLD_MS,
} from './agent-cancel-heuristic.js';

const RUN_OK = RUN_DURATION_GONE_THRESHOLD_MS;
const ABORT_OK = ABORT_DURATION_GONE_THRESHOLD_MS;

test('thresholds are set to documented values (3min run, 1min abort)', () => {
	assert.equal(RUN_DURATION_GONE_THRESHOLD_MS, 3 * 60 * 1000);
	assert.equal(ABORT_DURATION_GONE_THRESHOLD_MS, 60 * 1000);
});

test('passes through ok=true regardless of ctx', () => {
	const result = decideCancelResponse({ ok: true }, { runDuration: 0, abortDuration: 0 });
	assert.deepEqual(result, { ok: true });
});

test('passes through not-supported (side door absent / handle shape changed)', () => {
	const result = decideCancelResponse(
		{ ok: false, reason: 'not-supported' },
		{ runDuration: RUN_OK, abortDuration: ABORT_OK },
	);
	// 即使时长达阈值，not-supported 也不参与启发——侧门契约缺失是独立信号
	assert.deepEqual(result, { ok: false, reason: 'not-supported' });
});

test('passes through abort-threw with error field intact', () => {
	const input = { ok: false, reason: 'abort-threw', error: 'boom' };
	const result = decideCancelResponse(input, { runDuration: RUN_OK, abortDuration: ABORT_OK });
	assert.deepEqual(result, input);
});

test('not-found + both gates met → upgrades to gone', () => {
	const result = decideCancelResponse(
		{ ok: false, reason: 'not-found' },
		{ runDuration: RUN_OK, abortDuration: ABORT_OK },
	);
	assert.deepEqual(result, { ok: false, reason: 'gone' });
});

test('not-found + only run gate met (abort gate just shy) → stays not-found', () => {
	const result = decideCancelResponse(
		{ ok: false, reason: 'not-found' },
		{ runDuration: RUN_OK, abortDuration: ABORT_OK - 1 },
	);
	assert.deepEqual(result, { ok: false, reason: 'not-found' });
});

test('not-found + only abort gate met (run gate just shy) → stays not-found', () => {
	const result = decideCancelResponse(
		{ ok: false, reason: 'not-found' },
		{ runDuration: RUN_OK - 1, abortDuration: ABORT_OK },
	);
	assert.deepEqual(result, { ok: false, reason: 'not-found' });
});

test('not-found + both gates well below → stays not-found', () => {
	const result = decideCancelResponse(
		{ ok: false, reason: 'not-found' },
		{ runDuration: 0, abortDuration: 0 },
	);
	assert.deepEqual(result, { ok: false, reason: 'not-found' });
});

test('not-found + old UI (no durations in ctx) → stays not-found (backward compat)', () => {
	const result = decideCancelResponse({ ok: false, reason: 'not-found' }, {});
	assert.deepEqual(result, { ok: false, reason: 'not-found' });
});

test('not-found + ctx itself missing → stays not-found', () => {
	// handler 总会传 ctx，但 heuristic 函数不假设；防止未来 caller 漏传
	const result = decideCancelResponse({ ok: false, reason: 'not-found' });
	assert.deepEqual(result, { ok: false, reason: 'not-found' });
});

test('not-found + non-numeric durations (string) → stays not-found', () => {
	const result = decideCancelResponse(
		{ ok: false, reason: 'not-found' },
		{ runDuration: '180000', abortDuration: '60000' },
	);
	assert.deepEqual(result, { ok: false, reason: 'not-found' });
});

test('not-found + NaN durations → stays not-found', () => {
	const result = decideCancelResponse(
		{ ok: false, reason: 'not-found' },
		{ runDuration: Number.NaN, abortDuration: Number.NaN },
	);
	assert.deepEqual(result, { ok: false, reason: 'not-found' });
});

test('not-found + Infinity durations → stays not-found (treated as malformed)', () => {
	// Number.isFinite 拒收 Infinity，避免外部传入异常值意外升格
	const result = decideCancelResponse(
		{ ok: false, reason: 'not-found' },
		{ runDuration: Infinity, abortDuration: Infinity },
	);
	assert.deepEqual(result, { ok: false, reason: 'not-found' });
});
