import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeAgentId } from './agent-id.js';

test('normalizeAgentId - 非字符串 agentId 抛 INVALID_INPUT', () => {
	for (const bad of [123, {}, true, ['x'], 0, false]) {
		assert.throws(
			() => normalizeAgentId({ agentId: bad }),
			(err) => err instanceof Error && err.code === 'INVALID_INPUT',
			`agentId=${JSON.stringify(bad)} 应抛 INVALID_INPUT`,
		);
	}
});

test('normalizeAgentId - 缺省 / null / undefined → main', () => {
	assert.equal(normalizeAgentId(undefined), 'main');
	assert.equal(normalizeAgentId(null), 'main');
	assert.equal(normalizeAgentId({}), 'main');
	assert.equal(normalizeAgentId({ agentId: undefined }), 'main');
	assert.equal(normalizeAgentId({ agentId: null }), 'main');
});

test('normalizeAgentId - 空串 / 纯空白 → main（不抛）', () => {
	assert.equal(normalizeAgentId({ agentId: '' }), 'main');
	// 纯空白专杀「trim 后空就抛」变异：必须回落 main，不能抛
	assert.equal(normalizeAgentId({ agentId: '   ' }), 'main');
	assert.equal(normalizeAgentId({ agentId: '\t\n ' }), 'main');
});

test('normalizeAgentId - 合法字符串原样 / 去首尾空白', () => {
	assert.equal(normalizeAgentId({ agentId: 'foo' }), 'foo');
	assert.equal(normalizeAgentId({ agentId: '  foo  ' }), 'foo');
});
