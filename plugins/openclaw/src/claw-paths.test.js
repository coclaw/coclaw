import assert from 'node:assert/strict';
import nodePath from 'node:path';
import test from 'node:test';

import {
	clawStateDir,
	pluginDir,
	sessionStorePath,
	agentSessionsDir,
	sessionTranscriptPath,
	mainAgentDir,
	CHANNEL_ID,
} from './claw-paths.js';
import { setRuntime } from './runtime.js';

function reset() {
	setRuntime(null);
}

test('clawStateDir 直接信任 runtime.state.resolveStateDir', () => {
	setRuntime({ state: { resolveStateDir: () => '/custom/state' } });
	try {
		assert.equal(clawStateDir(), '/custom/state');
	}
	finally {
		reset();
	}
});

test('clawStateDir 在 runtime 未注入时抛错', () => {
	reset();
	assert.throws(() => clawStateDir(), /runtime not injected/);
});

test('clawStateDir 在 runtime.state 缺失时抛错', () => {
	setRuntime({});
	try {
		assert.throws(() => clawStateDir(), /runtime not injected/);
	}
	finally {
		reset();
	}
});

test('pluginDir 拼上 coclaw 子目录', () => {
	setRuntime({ state: { resolveStateDir: () => '/custom/state' } });
	try {
		assert.equal(pluginDir(), nodePath.join('/custom/state', CHANNEL_ID));
	}
	finally {
		reset();
	}
});

test('CHANNEL_ID 常量为 coclaw', () => {
	assert.equal(CHANNEL_ID, 'coclaw');
});

// === sessionStorePath ===

test('sessionStorePath 优先用 runtime.agent.session.resolveStorePath', () => {
	const captured = [];
	setRuntime({
		state: { resolveStateDir: () => '/state' },
		agent: {
			session: {
				resolveStorePath: (store, opts) => {
					captured.push({ store, opts });
					return '/custom/sessions.json';
				},
			},
		},
	});
	try {
		const p = sessionStorePath('main');
		assert.equal(p, '/custom/sessions.json');
		assert.deepEqual(captured, [{ store: undefined, opts: { agentId: 'main' } }]);
	}
	finally {
		reset();
	}
});

test('sessionStorePath 在缺 helper 时回退到固定布局（3 月初老版本场景）', () => {
	setRuntime({ state: { resolveStateDir: () => '/state' } });
	try {
		const p = sessionStorePath('main');
		assert.equal(p, nodePath.join('/state', 'agents', 'main', 'sessions', 'sessions.json'));
	}
	finally {
		reset();
	}
});

test('sessionStorePath 在 agent 子树存在但 session helper 缺失时也回退', () => {
	setRuntime({ state: { resolveStateDir: () => '/state' }, agent: {} });
	try {
		const p = sessionStorePath('a1');
		assert.equal(p, nodePath.join('/state', 'agents', 'a1', 'sessions', 'sessions.json'));
	}
	finally {
		reset();
	}
});

// === agentSessionsDir ===

test('agentSessionsDir 通过 sessionStorePath 反推 dirname', () => {
	setRuntime({
		state: { resolveStateDir: () => '/state' },
		agent: { session: { resolveStorePath: () => '/custom/place/sessions.json' } },
	});
	try {
		assert.equal(agentSessionsDir('main'), '/custom/place');
	}
	finally {
		reset();
	}
});

test('agentSessionsDir fallback 到固定布局', () => {
	setRuntime({ state: { resolveStateDir: () => '/state' } });
	try {
		assert.equal(agentSessionsDir('a1'), nodePath.join('/state', 'agents', 'a1', 'sessions'));
	}
	finally {
		reset();
	}
});

// === sessionTranscriptPath ===

test('sessionTranscriptPath 优先用 runtime.agent.session.resolveSessionFilePath', () => {
	const captured = [];
	setRuntime({
		state: { resolveStateDir: () => '/state' },
		agent: {
			session: {
				resolveSessionFilePath: (sid, entry, opts) => {
					captured.push({ sid, entry, opts });
					return '/picked.jsonl';
				},
			},
		},
	});
	try {
		const entry = { sessionFile: 'overridden.jsonl' };
		const p = sessionTranscriptPath('s1', 'a1', entry);
		assert.equal(p, '/picked.jsonl');
		assert.deepEqual(captured, [{ sid: 's1', entry, opts: { agentId: 'a1' } }]);
	}
	finally {
		reset();
	}
});

test('sessionTranscriptPath 在缺 helper 时回退到 agentSessionsDir + sessionId.jsonl', () => {
	setRuntime({ state: { resolveStateDir: () => '/state' } });
	try {
		const p = sessionTranscriptPath('s1', 'a1');
		assert.equal(p, nodePath.join('/state', 'agents', 'a1', 'sessions', 's1.jsonl'));
	}
	finally {
		reset();
	}
});

test('sessionTranscriptPath 仅在 session helper 部分缺失时单独 fallback', () => {
	// resolveStorePath 注入但 resolveSessionFilePath 缺失：transcript 走 fallback、store 走 helper
	setRuntime({
		state: { resolveStateDir: () => '/state' },
		agent: { session: { resolveStorePath: () => '/custom/sessions.json' } },
	});
	try {
		const p = sessionTranscriptPath('s1', 'a1');
		// agentSessionsDir 通过 store helper 反推得到 /custom
		assert.equal(p, nodePath.join('/custom', 's1.jsonl'));
	}
	finally {
		reset();
	}
});

// === 文档化决策：调上游 helper 时不传 store / entry 参数 ===
// 当前实现选择"目标永远是 OpenClaw 默认布局"，不跟随 agent.<id>.store 或 entry.sessionFile 覆盖；
// 该决策由这两个测试锁定行为，未来若改造（拿配置传给 helper）需同步改这些测试。

test('sessionStorePath 调 runtime helper 时第一参数固定 undefined（不传 store config）', () => {
	const captured = [];
	setRuntime({
		state: { resolveStateDir: () => '/state' },
		agent: {
			session: {
				resolveStorePath: (store, opts) => {
					captured.push({ store, opts });
					return '/anywhere/sessions.json';
				},
			},
		},
	});
	try {
		sessionStorePath('main');
		sessionStorePath('agent2');
		assert.equal(captured.length, 2);
		assert.equal(captured[0].store, undefined);
		assert.equal(captured[1].store, undefined);
		assert.deepEqual(captured.map((c) => c.opts.agentId), ['main', 'agent2']);
	}
	finally {
		reset();
	}
});

test('sessionTranscriptPath 调 runtime helper 时 entry 参数透传（caller 不传 → undefined）', () => {
	const captured = [];
	setRuntime({
		state: { resolveStateDir: () => '/state' },
		agent: {
			session: {
				resolveSessionFilePath: (sid, entry, opts) => {
					captured.push({ sid, entry, opts });
					return '/picked.jsonl';
				},
			},
		},
	});
	try {
		// 当前 caller（session-manager）只传两个参数，entry 必然 undefined
		sessionTranscriptPath('s1', 'main');
		assert.equal(captured.length, 1);
		assert.equal(captured[0].entry, undefined);
		assert.equal(captured[0].sid, 's1');
		assert.equal(captured[0].opts.agentId, 'main');
	}
	finally {
		reset();
	}
});

// === 真实部署场景烟测 ===

test('系统级安装：state-dir = /var/lib/openclaw 风格路径', () => {
	setRuntime({ state: { resolveStateDir: () => '/var/lib/openclaw' } });
	try {
		assert.equal(clawStateDir(), '/var/lib/openclaw');
		assert.equal(pluginDir(), nodePath.join('/var/lib/openclaw', 'coclaw'));
		assert.equal(
			sessionStorePath('main'),
			nodePath.join('/var/lib/openclaw', 'agents', 'main', 'sessions', 'sessions.json'),
		);
	}
	finally {
		reset();
	}
});

test('多 profile：state-dir = ~/.openclaw-foo 风格路径（runtime 直接返回展开后绝对路径）', () => {
	const profilePath = '/home/alice/.openclaw-foo';
	setRuntime({ state: { resolveStateDir: () => profilePath } });
	try {
		assert.equal(clawStateDir(), profilePath);
		assert.equal(pluginDir(), nodePath.join(profilePath, 'coclaw'));
	}
	finally {
		reset();
	}
});

// === mainAgentDir ===

test('mainAgentDir 拼上 agents/main/agent（含 /agent 子目录）', () => {
	setRuntime({ state: { resolveStateDir: () => '/state' } });
	try {
		assert.equal(mainAgentDir(), nodePath.join('/state', 'agents', 'main', 'agent'));
	}
	finally {
		reset();
	}
});

test('mainAgentDir 在 runtime 未注入时抛错', () => {
	reset();
	assert.throws(() => mainAgentDir(), /runtime not injected/);
});

test('容器部署：state mount 到非家目录路径', () => {
	const containerPath = '/srv/openclaw-state';
	setRuntime({ state: { resolveStateDir: () => containerPath } });
	try {
		assert.equal(pluginDir(), nodePath.join(containerPath, 'coclaw'));
		assert.equal(
			agentSessionsDir('main'),
			nodePath.join(containerPath, 'agents', 'main', 'sessions'),
		);
	}
	finally {
		reset();
	}
});
