import test from 'node:test';
import assert from 'node:assert/strict';

import { isAgentRunResponse } from './agent-run-response.js';

test('isAgentRunResponse: 顶层 type=res + payload.runId 命中', () => {
	const frame = JSON.stringify({
		type: 'res',
		id: 7,
		ok: true,
		payload: { runId: 'r-1', status: 'ok' },
	});
	assert.equal(isAgentRunResponse(frame), true);
});

test('isAgentRunResponse: type=event 即使带 runId 也不命中', () => {
	const frame = JSON.stringify({
		type: 'event',
		event: 'agent.delta',
		payload: { runId: 'r-2', text: 'hi' },
	});
	assert.equal(isAgentRunResponse(frame), false);
});

test('isAgentRunResponse: type=req 含 runId 不命中', () => {
	const frame = JSON.stringify({
		type: 'req',
		id: 21,
		method: 'agent',
		payload: { runId: 'r-3' },
	});
	assert.equal(isAgentRunResponse(frame), false);
});

test('isAgentRunResponse: payload 嵌套层 runId（顶层无）不命中', () => {
	const frame = JSON.stringify({
		type: 'res',
		id: 15,
		ok: true,
		payload: { sessions: [{ runId: 'nested' }] },
	});
	assert.equal(isAgentRunResponse(frame), false);
});

test('isAgentRunResponse: payload 缺失 / runId falsy 各情况均不命中', () => {
	const cases = [
		{ name: 'runId=null', payload: { runId: null, status: 'ok' } },
		{ name: 'runId=undefined', payload: { status: 'ok' } },
		{ name: 'runId 空串', payload: { runId: '', status: 'ok' } },
		{ name: 'runId=0', payload: { runId: 0, status: 'ok' } },
		{ name: 'payload=null', payload: null },
	];
	for (const { name, payload } of cases) {
		const frame = JSON.stringify({ type: 'res', id: 1, ok: true, payload });
		assert.equal(isAgentRunResponse(frame), false, name);
	}
});

test('isAgentRunResponse: JSON 解析失败返回 false', () => {
	assert.equal(isAgentRunResponse('{not json'), false);
	assert.equal(isAgentRunResponse(''), false);
});

test('isAgentRunResponse: 顶层 payload 缺失字段（非 res / 非 type）不命中', () => {
	assert.equal(isAgentRunResponse(JSON.stringify({ ok: true })), false);
	assert.equal(isAgentRunResponse(JSON.stringify({ type: 'res' })), false);
});

test('isAgentRunResponse: 复合命中（agent run 多种 status）', () => {
	for (const status of ['accepted', 'ok', 'error', 'timeout', 'race', 'dedupe']) {
		const frame = JSON.stringify({
			type: 'res',
			id: 100,
			ok: true,
			payload: { runId: 'r-x', status },
		});
		assert.equal(isAgentRunResponse(frame), true, `status=${status}`);
	}
});
