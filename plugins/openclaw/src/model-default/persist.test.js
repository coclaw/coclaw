import test from 'node:test';
import assert from 'node:assert/strict';

import { writePrimary } from './persist.js';

/**
 * 构造一个 mock mutateConfigFile：内部对 draft 走 structuredClone 模拟上游行为；
 * 暴露最终 draft 给断言。
 */
function makeMutateMock(initialCfg) {
	const calls = [];
	const mutateConfigFile = async ({ mutate }) => {
		const draft = structuredClone(initialCfg ?? {});
		const result = await mutate(draft, { snapshot: {}, previousHash: null });
		calls.push({ draft, result });
		return { result, currentHash: 'h1', writtenAt: 1 };
	};
	return { mutateConfigFile, calls };
}

test('writePrimary default: cfg 全空 → 创建 agents.defaults.model.primary', async () => {
	const { mutateConfigFile, calls } = makeMutateMock({});
	await writePrimary({ primary: 'openai-codex/gpt-5.5' }, { mutateConfigFile });
	assert.deepEqual(calls[0].draft, {
		agents: { defaults: { model: { primary: 'openai-codex/gpt-5.5' } } },
	});
});

test('writePrimary default: 已有 fallbacks 时只动 primary 保留 fallbacks', async () => {
	const initial = {
		agents: {
			defaults: {
				model: { primary: 'old/a', fallbacks: ['anthropic/claude-opus-4-7'], timeoutMs: 60_000 },
			},
		},
	};
	const { mutateConfigFile, calls } = makeMutateMock(initial);
	await writePrimary({ primary: 'openai-codex/gpt-5.5' }, { mutateConfigFile });
	assert.deepEqual(calls[0].draft.agents.defaults.model, {
		primary: 'openai-codex/gpt-5.5',
		fallbacks: ['anthropic/claude-opus-4-7'],
		timeoutMs: 60_000,
	});
});

test('writePrimary default: model 是 string 形态 → 升级成 object', async () => {
	const initial = { agents: { defaults: { model: 'old/a' } } };
	const { mutateConfigFile, calls } = makeMutateMock(initial);
	await writePrimary({ primary: 'new/b' }, { mutateConfigFile });
	assert.deepEqual(calls[0].draft.agents.defaults.model, { primary: 'new/b' });
});

test('writePrimary default: 保留 defaults 上其它字段', async () => {
	const initial = {
		agents: {
			defaults: {
				model: { primary: 'x/y' },
				thinkingDefault: 'medium',
			},
		},
	};
	const { mutateConfigFile, calls } = makeMutateMock(initial);
	await writePrimary({ primary: 'a/b' }, { mutateConfigFile });
	assert.equal(calls[0].draft.agents.defaults.thinkingDefault, 'medium');
});

test('writePrimary default clear: model 为 object 删 primary 后剩 fallbacks 保留', async () => {
	const initial = {
		agents: {
			defaults: { model: { primary: 'old/a', fallbacks: ['anthropic/claude-opus-4-7'] } },
		},
	};
	const { mutateConfigFile, calls } = makeMutateMock(initial);
	await writePrimary({ primary: null }, { mutateConfigFile });
	assert.deepEqual(calls[0].draft.agents.defaults.model, {
		fallbacks: ['anthropic/claude-opus-4-7'],
	});
});

test('writePrimary default clear: object 只有 primary 时整体删 model', async () => {
	const initial = { agents: { defaults: { model: { primary: 'old/a' } } } };
	const { mutateConfigFile, calls } = makeMutateMock(initial);
	await writePrimary({ primary: null }, { mutateConfigFile });
	assert.deepEqual(calls[0].draft.agents.defaults, {});
});

test('writePrimary default clear: model 是 string 形态 → 删 model', async () => {
	const initial = { agents: { defaults: { model: 'old/a', thinkingDefault: 'low' } } };
	const { mutateConfigFile, calls } = makeMutateMock(initial);
	await writePrimary({ primary: null }, { mutateConfigFile });
	assert.deepEqual(calls[0].draft.agents.defaults, { thinkingDefault: 'low' });
});

test('writePrimary default clear: cfg 没 defaults 时无操作', async () => {
	const initial = { agents: { list: [] } };
	const { mutateConfigFile, calls } = makeMutateMock(initial);
	await writePrimary({ primary: null }, { mutateConfigFile });
	// 不应创建 agents.defaults 容器
	assert.equal(calls[0].draft.agents.defaults, undefined);
});

test('writePrimary default clear: cfg 完全空时无操作', async () => {
	const { mutateConfigFile, calls } = makeMutateMock({});
	await writePrimary({ primary: null }, { mutateConfigFile });
	// 应该创建了 agents 容器但 defaults 不存在
	assert.deepEqual(calls[0].draft, { agents: {} });
});

test('writePrimary agent set: entry 不存在 → 新建 { id, model: { primary } }', async () => {
	const initial = { agents: { list: [] } };
	const { mutateConfigFile, calls } = makeMutateMock(initial);
	await writePrimary({ agentId: 'researcher', primary: 'anthropic/claude-opus-4-7' }, { mutateConfigFile });
	assert.deepEqual(calls[0].draft.agents.list, [
		{ id: 'researcher', model: { primary: 'anthropic/claude-opus-4-7' } },
	]);
});

test('writePrimary agent set: cfg 完全没 list 时建 list', async () => {
	const { mutateConfigFile, calls } = makeMutateMock({});
	await writePrimary({ agentId: 'main', primary: 'x/y' }, { mutateConfigFile });
	assert.deepEqual(calls[0].draft.agents.list, [
		{ id: 'main', model: { primary: 'x/y' } },
	]);
});

test('writePrimary agent set: 已有 entry 有 fallbacks → 字段级动 primary', async () => {
	const initial = {
		agents: {
			list: [
				{
					id: 'researcher',
					model: { primary: 'old/a', fallbacks: ['anthropic/claude-opus-4-7'] },
					thinkingDefault: 'high',
				},
			],
		},
	};
	const { mutateConfigFile, calls } = makeMutateMock(initial);
	await writePrimary({ agentId: 'researcher', primary: 'new/b' }, { mutateConfigFile });
	assert.deepEqual(calls[0].draft.agents.list[0], {
		id: 'researcher',
		model: { primary: 'new/b', fallbacks: ['anthropic/claude-opus-4-7'] },
		thinkingDefault: 'high',
	});
});

test('writePrimary agent set: 已有 entry model 是 string → 升级成 object', async () => {
	const initial = { agents: { list: [{ id: 'r', model: 'old/a' }] } };
	const { mutateConfigFile, calls } = makeMutateMock(initial);
	await writePrimary({ agentId: 'r', primary: 'new/b' }, { mutateConfigFile });
	assert.deepEqual(calls[0].draft.agents.list[0], {
		id: 'r',
		model: { primary: 'new/b' },
	});
});

test('writePrimary agent set: 已有 entry 没 model → 字段级 set', async () => {
	const initial = { agents: { list: [{ id: 'r', thinkingDefault: 'low' }] } };
	const { mutateConfigFile, calls } = makeMutateMock(initial);
	await writePrimary({ agentId: 'r', primary: 'new/b' }, { mutateConfigFile });
	assert.deepEqual(calls[0].draft.agents.list[0], {
		id: 'r',
		thinkingDefault: 'low',
		model: { primary: 'new/b' },
	});
});

test('writePrimary agent set: 不影响其它 entry', async () => {
	const initial = {
		agents: {
			list: [
				{ id: 'main', model: 'x/y' },
				{ id: 'r', model: { primary: 'old/a' } },
			],
		},
	};
	const { mutateConfigFile, calls } = makeMutateMock(initial);
	await writePrimary({ agentId: 'r', primary: 'new/b' }, { mutateConfigFile });
	assert.deepEqual(calls[0].draft.agents.list[0], { id: 'main', model: 'x/y' });
	assert.deepEqual(calls[0].draft.agents.list[1], {
		id: 'r',
		model: { primary: 'new/b' },
	});
});

test('writePrimary agent clear: entry 不存在 → 无操作', async () => {
	const initial = { agents: { list: [{ id: 'main' }] } };
	const { mutateConfigFile, calls } = makeMutateMock(initial);
	await writePrimary({ agentId: 'r', primary: null }, { mutateConfigFile });
	// list 不应被改动
	assert.deepEqual(calls[0].draft.agents.list, [{ id: 'main' }]);
});

test('writePrimary agent clear: object model 删 primary 后剩 fallbacks 保留', async () => {
	const initial = {
		agents: {
			list: [
				{
					id: 'r',
					model: { primary: 'old/a', fallbacks: ['anthropic/claude-opus-4-7'] },
				},
			],
		},
	};
	const { mutateConfigFile, calls } = makeMutateMock(initial);
	await writePrimary({ agentId: 'r', primary: null }, { mutateConfigFile });
	assert.deepEqual(calls[0].draft.agents.list[0], {
		id: 'r',
		model: { fallbacks: ['anthropic/claude-opus-4-7'] },
	});
});

test('writePrimary agent clear: object 只有 primary 时整体删 model（留空壳 entry）', async () => {
	const initial = { agents: { list: [{ id: 'r', model: { primary: 'old/a' } }] } };
	const { mutateConfigFile, calls } = makeMutateMock(initial);
	await writePrimary({ agentId: 'r', primary: null }, { mutateConfigFile });
	// dump v9："entry 整个就只剩这一项 → 留空壳，不主动从 list 删"
	assert.deepEqual(calls[0].draft.agents.list[0], { id: 'r' });
});

test('writePrimary agent clear: string model 形态 → 删 model 字段', async () => {
	const initial = {
		agents: { list: [{ id: 'r', model: 'old/a', thinkingDefault: 'low' }] },
	};
	const { mutateConfigFile, calls } = makeMutateMock(initial);
	await writePrimary({ agentId: 'r', primary: null }, { mutateConfigFile });
	assert.deepEqual(calls[0].draft.agents.list[0], { id: 'r', thinkingDefault: 'low' });
});

test('writePrimary agent clear: entry 没 model 字段 → 无操作', async () => {
	const initial = { agents: { list: [{ id: 'r', thinkingDefault: 'low' }] } };
	const { mutateConfigFile, calls } = makeMutateMock(initial);
	await writePrimary({ agentId: 'r', primary: null }, { mutateConfigFile });
	assert.deepEqual(calls[0].draft.agents.list[0], { id: 'r', thinkingDefault: 'low' });
});

test('writePrimary: agents 容器非对象（如 array）→ 重建', async () => {
	const initial = { agents: ['junk'] };
	const { mutateConfigFile, calls } = makeMutateMock(initial);
	await writePrimary({ primary: 'a/b' }, { mutateConfigFile });
	// agents 被重置为合法 object
	assert.deepEqual(calls[0].draft.agents, { defaults: { model: { primary: 'a/b' } } });
});

test('writePrimary: defaults 非对象 → 重建', async () => {
	const initial = { agents: { defaults: 'oops' } };
	const { mutateConfigFile, calls } = makeMutateMock(initial);
	await writePrimary({ primary: 'a/b' }, { mutateConfigFile });
	assert.deepEqual(calls[0].draft.agents.defaults, { model: { primary: 'a/b' } });
});

test('writePrimary: list 非数组 → 重建', async () => {
	const initial = { agents: { list: 'oops' } };
	const { mutateConfigFile, calls } = makeMutateMock(initial);
	await writePrimary({ agentId: 'r', primary: 'a/b' }, { mutateConfigFile });
	assert.deepEqual(calls[0].draft.agents.list, [
		{ id: 'r', model: { primary: 'a/b' } },
	]);
});

test('writePrimary: list 有 null entry 不崩', async () => {
	const initial = {
		agents: { list: [null, { id: 'r', model: { primary: 'old/a' } }] },
	};
	const { mutateConfigFile, calls } = makeMutateMock(initial);
	await writePrimary({ agentId: 'r', primary: 'new/b' }, { mutateConfigFile });
	assert.equal(calls[0].draft.agents.list[0], null);
	assert.deepEqual(calls[0].draft.agents.list[1].model, { primary: 'new/b' });
});

test('writePrimary: mutateConfigFile 抛错时透传', async () => {
	const mutateConfigFile = async () => {
		throw new Error('disk full');
	};
	await assert.rejects(
		() => writePrimary({ primary: 'a/b' }, { mutateConfigFile }),
		/disk full/,
	);
});
