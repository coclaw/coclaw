import test from 'node:test';
import assert from 'node:assert/strict';

import {
	readPrimaryFromModel,
	readDefaultPrimary,
	readAgentPrimary,
	findAgentEntry,
	listAllPrimaries,
	MAIN_AGENT_ID,
} from './resolve.js';

test('readPrimaryFromModel: string 形态返回原值', () => {
	assert.equal(readPrimaryFromModel('openai-codex/gpt-5.5'), 'openai-codex/gpt-5.5');
});

test('readPrimaryFromModel: 空字符串返回 null', () => {
	assert.equal(readPrimaryFromModel(''), null);
});

test('readPrimaryFromModel: object 形态有 primary 非空', () => {
	assert.equal(readPrimaryFromModel({ primary: 'anthropic/claude-opus-4-7' }), 'anthropic/claude-opus-4-7');
});

test('readPrimaryFromModel: object 形态 primary 为空字符串', () => {
	assert.equal(readPrimaryFromModel({ primary: '' }), null);
});

test('readPrimaryFromModel: object 形态无 primary（只有 fallbacks）', () => {
	assert.equal(readPrimaryFromModel({ fallbacks: ['anthropic/claude-opus-4-7'] }), null);
});

test('readPrimaryFromModel: object 形态 primary 非 string', () => {
	assert.equal(readPrimaryFromModel({ primary: 123 }), null);
});

test('readPrimaryFromModel: null / undefined / number 返回 null', () => {
	assert.equal(readPrimaryFromModel(null), null);
	assert.equal(readPrimaryFromModel(undefined), null);
	assert.equal(readPrimaryFromModel(42), null);
	assert.equal(readPrimaryFromModel(true), null);
});

test('readDefaultPrimary: cfg.agents.defaults.model = string', () => {
	const cfg = { agents: { defaults: { model: 'openai-codex/gpt-5.5' } } };
	assert.equal(readDefaultPrimary(cfg), 'openai-codex/gpt-5.5');
});

test('readDefaultPrimary: cfg.agents.defaults.model = object', () => {
	const cfg = {
		agents: {
			defaults: {
				model: { primary: 'anthropic/claude-opus-4-7', fallbacks: ['openai-codex/gpt-5.5'] },
			},
		},
	};
	assert.equal(readDefaultPrimary(cfg), 'anthropic/claude-opus-4-7');
});

test('readDefaultPrimary: cfg.agents.defaults 缺 / cfg 缺 / 空对象', () => {
	assert.equal(readDefaultPrimary({}), null);
	assert.equal(readDefaultPrimary({ agents: {} }), null);
	assert.equal(readDefaultPrimary({ agents: { defaults: {} } }), null);
	assert.equal(readDefaultPrimary(null), null);
	assert.equal(readDefaultPrimary(undefined), null);
});

test('readAgentPrimary: 找到 entry 且有 primary', () => {
	const cfg = {
		agents: {
			list: [{ id: 'researcher', model: { primary: 'anthropic/claude-opus-4-7' } }],
		},
	};
	assert.equal(readAgentPrimary(cfg, 'researcher'), 'anthropic/claude-opus-4-7');
});

test('readAgentPrimary: 找到 entry 但 model 缺', () => {
	const cfg = { agents: { list: [{ id: 'researcher' }] } };
	assert.equal(readAgentPrimary(cfg, 'researcher'), null);
});

test('readAgentPrimary: list 中没该 agentId', () => {
	const cfg = { agents: { list: [{ id: 'main', model: 'openai-codex/gpt-5.5' }] } };
	assert.equal(readAgentPrimary(cfg, 'researcher'), null);
});

test('readAgentPrimary: list 不是数组 / cfg 缺', () => {
	assert.equal(readAgentPrimary({ agents: { list: 'oops' } }, 'main'), null);
	assert.equal(readAgentPrimary({}, 'main'), null);
	assert.equal(readAgentPrimary(null, 'main'), null);
});

test('findAgentEntry: list 不是数组返回 null', () => {
	assert.equal(findAgentEntry({ agents: {} }, 'main'), null);
});

test('findAgentEntry: list 含 null entry 不崩', () => {
	const cfg = { agents: { list: [null, { id: 'main', model: 'x/y' }] } };
	assert.deepEqual(findAgentEntry(cfg, 'main'), { id: 'main', model: 'x/y' });
});

test('listAllPrimaries: 完整 cfg 装配 default + agents', () => {
	const cfg = {
		agents: {
			defaults: { model: 'openai-codex/gpt-5.5' },
			list: [
				{ id: 'main' },
				{ id: 'researcher', model: { primary: 'anthropic/claude-opus-4-7' } },
				{ id: 'writer', model: 'minimax/abab' },
			],
		},
	};
	assert.deepEqual(listAllPrimaries(cfg), {
		default: { primary: 'openai-codex/gpt-5.5' },
		agents: {
			main: { primary: null },
			researcher: { primary: 'anthropic/claude-opus-4-7' },
			writer: { primary: 'minimax/abab' },
		},
	});
});

test('listAllPrimaries: cfg 没 list → agents 只有补出来的 main', () => {
	const cfg = { agents: { defaults: { model: 'openai-codex/gpt-5.5' } } };
	assert.deepEqual(listAllPrimaries(cfg), {
		default: { primary: 'openai-codex/gpt-5.5' },
		agents: { main: { primary: null } },
	});
});

test('listAllPrimaries: cfg 完全空 → 补 main, default null', () => {
	assert.deepEqual(listAllPrimaries({}), {
		default: { primary: null },
		agents: { main: { primary: null } },
	});
});

test('listAllPrimaries: cfg 已含 main entry → 不覆盖', () => {
	const cfg = {
		agents: { list: [{ id: 'main', model: 'openai-codex/gpt-5.5' }] },
	};
	assert.deepEqual(listAllPrimaries(cfg), {
		default: { primary: null },
		agents: { main: { primary: 'openai-codex/gpt-5.5' } },
	});
});

test('listAllPrimaries: entry 缺 id / id 空字符串 / id 非 string 跳过', () => {
	const cfg = {
		agents: {
			list: [
				{ model: 'x/y' },
				{ id: '', model: 'x/y' },
				{ id: 123, model: 'x/y' },
				{ id: 'ok', model: 'a/b' },
			],
		},
	};
	const result = listAllPrimaries(cfg);
	assert.deepEqual(Object.keys(result.agents).sort(), ['main', 'ok']);
	assert.deepEqual(result.agents.ok, { primary: 'a/b' });
});

test('MAIN_AGENT_ID 导出常量', () => {
	assert.equal(MAIN_AGENT_ID, 'main');
});
