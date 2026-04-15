import assert from 'node:assert/strict';
import test from 'node:test';

import { abortAgentRun } from './agent-abort.js';

const KEY = Symbol.for('openclaw.embeddedRunState');

function withStubbedState(stub, fn) {
	const had = Object.prototype.hasOwnProperty.call(globalThis, KEY);
	const prev = globalThis[KEY];
	globalThis[KEY] = stub;
	try { return fn(); }
	finally {
		if (had) globalThis[KEY] = prev;
		else delete globalThis[KEY];
	}
}

test('abortAgentRun returns not-supported when symbol state is absent', () => {
	withStubbedState(undefined, () => {
		const result = abortAgentRun('sid-1');
		assert.deepEqual(result, { ok: false, reason: 'not-supported' });
	});
});

test('abortAgentRun returns not-supported when activeRuns missing', () => {
	withStubbedState({}, () => {
		const result = abortAgentRun('sid-1');
		assert.deepEqual(result, { ok: false, reason: 'not-supported' });
	});
});

test('abortAgentRun returns not-supported when activeRuns.get is not a function', () => {
	withStubbedState({ activeRuns: { get: null } }, () => {
		const result = abortAgentRun('sid-1');
		assert.deepEqual(result, { ok: false, reason: 'not-supported' });
	});
});

test('abortAgentRun returns not-found when sessionId is not registered', () => {
	withStubbedState({ activeRuns: new Map() }, () => {
		const result = abortAgentRun('sid-missing');
		assert.deepEqual(result, { ok: false, reason: 'not-found' });
	});
});

test('abortAgentRun returns not-supported when handle.abort is not a function', () => {
	// OpenClaw handle shape 契约变化（如 rename abort → terminate）——归入 not-supported 让 UI 提示升级
	const handle = { terminate: () => {} };
	const map = new Map([['sid-1', handle]]);
	withStubbedState({ activeRuns: map }, () => {
		const result = abortAgentRun('sid-1');
		assert.deepEqual(result, { ok: false, reason: 'not-supported' });
	});
});

test('abortAgentRun returns ok and invokes handle.abort', () => {
	let called = 0;
	const handle = { abort: () => { called++; } };
	const map = new Map([['sid-1', handle]]);
	withStubbedState({ activeRuns: map }, () => {
		const result = abortAgentRun('sid-1');
		assert.deepEqual(result, { ok: true });
		assert.equal(called, 1);
	});
});

test('abortAgentRun returns abort-threw when handle.abort throws Error', () => {
	const handle = { abort: () => { throw new Error('boom'); } };
	const map = new Map([['sid-1', handle]]);
	withStubbedState({ activeRuns: map }, () => {
		const result = abortAgentRun('sid-1');
		assert.equal(result.ok, false);
		assert.equal(result.reason, 'abort-threw');
		assert.equal(result.error, 'boom');
	});
});

test('abortAgentRun returns abort-threw when activeRuns.get itself throws', () => {
	// 非 Map 的 duck-typed activeRuns（如自定义代理）实现 get() 时可能抛；
	// 守卫已确认 get 是函数但不能确认其内部不抛 → 包在 try/catch 内归入 abort-threw
	const throwing = { get: () => { throw new Error('state corrupted'); } };
	withStubbedState({ activeRuns: throwing }, () => {
		const result = abortAgentRun('sid-x');
		assert.equal(result.ok, false);
		assert.equal(result.reason, 'abort-threw');
		assert.equal(result.error, 'state corrupted');
	});
});

test('abortAgentRun returns abort-threw when handle.abort throws non-Error', () => {
	const handle = { abort: () => { throw 'raw-string'; } };
	const map = new Map([['sid-1', handle]]);
	withStubbedState({ activeRuns: map }, () => {
		const result = abortAgentRun('sid-1');
		assert.equal(result.ok, false);
		assert.equal(result.reason, 'abort-threw');
		assert.equal(result.error, 'raw-string');
	});
});
