import assert from 'node:assert/strict';
import test from 'node:test';
import nodePath from 'node:path';
import os from 'node:os';

import { getWorkerPath, spawnUpgradeWorker } from './updater-spawn.js';
import { setRuntime } from '../runtime.js';

// --- getWorkerPath ---

test('getWorkerPath 返回以 worker.js 结尾的路径', () => {
	const p = getWorkerPath();
	assert.ok(p.endsWith('worker.js'), `expected path ending with worker.js, got: ${p}`);
});

// --- spawnUpgradeWorker ---

/** 创建 mock spawnFn，记录调用参数 */
function createMockSpawn(pid = 12345) {
	const calls = [];
	const mockChild = {
		pid,
		unref: () => { mockChild._unrefCalled = true; },
		_unrefCalled: false,
	};
	const spawnFn = (cmd, args, options) => {
		calls.push({ cmd, args, options });
		return mockChild;
	};
	return { spawnFn, calls, mockChild };
}

test('spawnUpgradeWorker 使用正确参数调用 spawn', () => {
	const { spawnFn, calls } = createMockSpawn();
	spawnUpgradeWorker({
		pluginDir: '/tmp/plugin',
		fromVersion: '1.0.0',
		toVersion: '2.0.0',
		pluginId: 'test-plugin',
		pkgName: '@test/pkg',
		opts: { spawnFn },
		logger: () => {},
	});

	assert.equal(calls.length, 1);
	const { cmd, args, options } = calls[0];
	assert.equal(cmd, process.execPath);
	assert.equal(args[0], getWorkerPath());
	// 命名参数格式
	assert.deepEqual(args.slice(1), [
		'--pluginDir', '/tmp/plugin',
		'--fromVersion', '1.0.0',
		'--toVersion', '2.0.0',
		'--pluginId', 'test-plugin',
		'--pkgName', '@test/pkg',
	]);
	assert.equal(options.detached, true);
	assert.equal(options.stdio, 'ignore');
});

test('spawnUpgradeWorker 调用 child.unref()', () => {
	const { spawnFn, mockChild } = createMockSpawn();
	spawnUpgradeWorker({
		pluginDir: '/tmp/plugin',
		fromVersion: '1.0.0',
		toVersion: '2.0.0',
		pluginId: 'test-plugin',
		pkgName: '@test/pkg',
		opts: { spawnFn },
		logger: () => {},
	});

	assert.ok(mockChild._unrefCalled, 'child.unref() should be called');
});

test('spawnUpgradeWorker 返回包含 child 的对象', () => {
	const { spawnFn, mockChild } = createMockSpawn(999);
	const result = spawnUpgradeWorker({
		pluginDir: '/tmp/plugin',
		fromVersion: '1.0.0',
		toVersion: '2.0.0',
		pluginId: 'test-plugin',
		pkgName: '@test/pkg',
		opts: { spawnFn },
		logger: () => {},
	});

	assert.equal(result.child, mockChild);
	assert.equal(result.child.pid, 999);
});

test('spawnUpgradeWorker 未提供 logger 时使用 console.log', () => {
	const { spawnFn } = createMockSpawn();
	const origLog = console.log;
	const logged = [];
	console.log = (...args) => logged.push(args.join(' '));

	try {
		spawnUpgradeWorker({
			pluginDir: '/tmp/plugin',
			fromVersion: '0.1.0',
			toVersion: '0.2.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: { spawnFn },
		});
		// 验证 console.log 被调用（两次：spawning + spawned）
		assert.equal(logged.length, 2);
		assert.ok(logged[0].includes('[spawner]'));
		assert.ok(logged[1].includes('pid'));
	} finally {
		console.log = origLog;
	}
});

test('spawnUpgradeWorker 自定义 logger 收到日志', () => {
	const { spawnFn } = createMockSpawn(42);
	const msgs = [];
	spawnUpgradeWorker({
		pluginDir: '/x',
		fromVersion: 'a',
		toVersion: 'b',
		pluginId: 'test-plugin',
		pkgName: '@test/pkg',
		opts: { spawnFn },
		logger: (m) => msgs.push(m),
	});

	assert.equal(msgs.length, 2);
	assert.ok(msgs[0].includes('a → b'));
	assert.ok(msgs[1].includes('42'));
});

// --- resolveStateDirForWorker 通过 env.OPENCLAW_STATE_DIR 间接验证 ---

test('spawnUpgradeWorker 无 runtime 时 env 包含 OPENCLAW_STATE_DIR（回退到默认路径）', () => {
	setRuntime(null);
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	delete process.env.OPENCLAW_STATE_DIR;

	try {
		const { spawnFn, calls } = createMockSpawn();
		spawnUpgradeWorker({
			pluginDir: '/tmp/plugin',
			fromVersion: '1.0.0',
			toVersion: '2.0.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: { spawnFn },
			logger: () => {},
		});

		const { options } = calls[0];
		// 无 runtime 且无环境变量时，回退到 ~/.openclaw
		const expected = nodePath.join(os.homedir(), '.openclaw');
		assert.equal(options.env.OPENCLAW_STATE_DIR, expected);
	} finally {
		if (origEnv !== undefined) process.env.OPENCLAW_STATE_DIR = origEnv;
		else delete process.env.OPENCLAW_STATE_DIR;
	}
});

test('spawnUpgradeWorker 无 runtime 时 env 使用 OPENCLAW_STATE_DIR 环境变量', () => {
	setRuntime(null);
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = '/custom/state/dir';

	try {
		const { spawnFn, calls } = createMockSpawn();
		spawnUpgradeWorker({
			pluginDir: '/tmp/plugin',
			fromVersion: '1.0.0',
			toVersion: '2.0.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: { spawnFn },
			logger: () => {},
		});

		const { options } = calls[0];
		assert.equal(options.env.OPENCLAW_STATE_DIR, '/custom/state/dir');
	} finally {
		if (origEnv !== undefined) process.env.OPENCLAW_STATE_DIR = origEnv;
		else delete process.env.OPENCLAW_STATE_DIR;
	}
});

test('spawnUpgradeWorker 有 runtime 时 env 使用 runtime.state.resolveStateDir()', () => {
	const mockRuntime = {
		state: {
			resolveStateDir: () => '/runtime/state/dir',
		},
	};
	setRuntime(mockRuntime);

	try {
		const { spawnFn, calls } = createMockSpawn();
		spawnUpgradeWorker({
			pluginDir: '/tmp/plugin',
			fromVersion: '1.0.0',
			toVersion: '2.0.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: { spawnFn },
			logger: () => {},
		});

		const { options } = calls[0];
		assert.equal(options.env.OPENCLAW_STATE_DIR, '/runtime/state/dir');
	} finally {
		setRuntime(null);
	}
});
