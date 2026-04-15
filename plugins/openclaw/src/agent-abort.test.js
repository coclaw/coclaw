import assert from 'node:assert/strict';
import test from 'node:test';

import { abortAgentRun } from './agent-abort.js';

const KEY = Symbol.for('openclaw.embeddedRunState');
const REPLY_KEY = Symbol.for('openclaw.replyRunRegistry');

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

function withStubbedReplyState(stub, fn) {
	const had = Object.prototype.hasOwnProperty.call(globalThis, REPLY_KEY);
	const prev = globalThis[REPLY_KEY];
	globalThis[REPLY_KEY] = stub;
	try { return fn(); }
	finally {
		if (had) globalThis[REPLY_KEY] = prev;
		else delete globalThis[REPLY_KEY];
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

// --- not-found 分支的诊断输出（logger.info）---

test('abortAgentRun not-found with logger dumps embedded + reply registry snapshot', () => {
	const infoMsgs = [];
	const logger = { info: (msg) => infoMsgs.push(msg) };
	const embeddedMap = new Map();
	embeddedMap.set('other-sid', { abort: () => {} });
	const replyByKey = new Map([['agent:main:main', { foo: 1 }]]);
	const replyByIdToKey = new Map([['live-sid', 'agent:main:main']]);
	withStubbedState({ activeRuns: embeddedMap }, () => {
		withStubbedReplyState({ activeRunsByKey: replyByKey, activeKeysBySessionId: replyByIdToKey }, () => {
			const result = abortAgentRun('missing-sid', logger);
			assert.deepEqual(result, { ok: false, reason: 'not-found' });
		});
	});
	assert.equal(infoMsgs.length, 1);
	const line = infoMsgs[0];
	assert.match(line, /\[coclaw\.agent\.abort\] not-found diag/);
	assert.match(line, /sessionId=missing-sid/);
	assert.match(line, /embedded\.size=1/);
	assert.match(line, /embedded\.keys=\["other-sid"\]/);
	assert.match(line, /reply\.activeRunsByKey\.size=1/);
	assert.match(line, /reply\.keys=\["agent:main:main"\]/);
	assert.match(line, /reply\.keyForSid=null/);
});

test('abortAgentRun not-found without logger is silent', () => {
	const embeddedMap = new Map();
	withStubbedState({ activeRuns: embeddedMap }, () => {
		// 不传 logger 也不应抛
		const result = abortAgentRun('missing-sid');
		assert.deepEqual(result, { ok: false, reason: 'not-found' });
	});
});

test('abortAgentRun not-found diag handles absent reply registry', () => {
	const infoMsgs = [];
	const logger = { info: (msg) => infoMsgs.push(msg) };
	const embeddedMap = new Map();
	withStubbedState({ activeRuns: embeddedMap }, () => {
		withStubbedReplyState(undefined, () => {
			abortAgentRun('missing-sid', logger);
		});
	});
	assert.equal(infoMsgs.length, 1);
	assert.match(infoMsgs[0], /reply\.state=absent/);
});

test('abortAgentRun not-found diag reports missing activeRunsByKey', () => {
	const infoMsgs = [];
	const logger = { info: (msg) => infoMsgs.push(msg) };
	const embeddedMap = new Map();
	withStubbedState({ activeRuns: embeddedMap }, () => {
		withStubbedReplyState({ activeKeysBySessionId: new Map() }, () => {
			abortAgentRun('missing-sid', logger);
		});
	});
	assert.match(infoMsgs[0], /reply\.activeRunsByKey=absent/);
	assert.match(infoMsgs[0], /reply\.keyForSid=null/);
});

test('abortAgentRun not-found diag reports missing activeKeysBySessionId', () => {
	const infoMsgs = [];
	const logger = { info: (msg) => infoMsgs.push(msg) };
	const embeddedMap = new Map();
	withStubbedState({ activeRuns: embeddedMap }, () => {
		withStubbedReplyState({ activeRunsByKey: new Map() }, () => {
			abortAgentRun('missing-sid', logger);
		});
	});
	assert.match(infoMsgs[0], /reply\.activeKeysBySessionId=absent/);
	assert.match(infoMsgs[0], /reply\.activeRunsByKey\.size=0/);
});

test('abortAgentRun not-found diag returns key mapping when reply registry has entry', () => {
	const infoMsgs = [];
	const logger = { info: (msg) => infoMsgs.push(msg) };
	const embeddedMap = new Map();
	const byId = new Map([['target-sid', 'agent:main:main']]);
	withStubbedState({ activeRuns: embeddedMap }, () => {
		withStubbedReplyState({ activeRunsByKey: new Map(), activeKeysBySessionId: byId }, () => {
			abortAgentRun('target-sid', logger);
		});
	});
	assert.match(infoMsgs[0], /reply\.keyForSid="agent:main:main"/);
});

test('abortAgentRun not-found diag survives thrown keys() iterator on embedded map', () => {
	const infoMsgs = [];
	const logger = { info: (msg) => infoMsgs.push(msg) };
	const throwingMap = {
		get: () => undefined,
		size: 3,
		keys: () => { throw new Error('iter-boom'); },
	};
	withStubbedState({ activeRuns: throwingMap }, () => {
		withStubbedReplyState(undefined, () => {
			abortAgentRun('x', logger);
		});
	});
	assert.match(infoMsgs[0], /embedded\.keysErr=iter-boom/);
});

test('abortAgentRun not-found diag survives thrown keys() iterator on reply.activeRunsByKey', () => {
	const infoMsgs = [];
	const logger = { info: (msg) => infoMsgs.push(msg) };
	const embedded = new Map();
	const replyRuns = {
		size: 2,
		keys: () => { throw new Error('rep-iter'); },
	};
	withStubbedState({ activeRuns: embedded }, () => {
		withStubbedReplyState({ activeRunsByKey: replyRuns }, () => {
			abortAgentRun('x', logger);
		});
	});
	assert.match(infoMsgs[0], /reply\.keysErr=rep-iter/);
});

test('abortAgentRun not-found diag survives thrown get() on reply.activeKeysBySessionId', () => {
	const infoMsgs = [];
	const logger = { info: (msg) => infoMsgs.push(msg) };
	const embedded = new Map();
	const byId = { get: () => { throw new Error('lookup-boom'); } };
	withStubbedState({ activeRuns: embedded }, () => {
		withStubbedReplyState({ activeKeysBySessionId: byId }, () => {
			abortAgentRun('x', logger);
		});
	});
	assert.match(infoMsgs[0], /reply\.keyForSidErr=lookup-boom/);
});
