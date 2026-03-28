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
		on: (evt, fn) => { mockChild._listeners[evt] = fn; },
		_unrefCalled: false,
		_listeners: {},
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
		logger: { info: () => {} },
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
		logger: { info: () => {} },
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
		logger: { info: () => {} },
	});

	assert.equal(result.child, mockChild);
	assert.equal(result.child.pid, 999);
});

test('spawnUpgradeWorker 注册 error 事件监听器防止 gateway 崩溃', () => {
	const { spawnFn, mockChild } = createMockSpawn();
	const warns = [];
	spawnUpgradeWorker({
		pluginDir: '/tmp/plugin',
		fromVersion: '1.0.0',
		toVersion: '2.0.0',
		pluginId: 'test-plugin',
		pkgName: '@test/pkg',
		opts: { spawnFn },
		logger: { info: () => {}, warn: (m) => warns.push(m) },
	});

	assert.ok(mockChild._listeners.error, 'should register error listener on child');
	// 模拟 spawn 失败触发 error 事件
	mockChild._listeners.error(new Error('spawn EMFILE'));
	assert.ok(warns.some(m => m.includes('spawn EMFILE')), 'error should be logged via logger.warn');
});

test('spawnUpgradeWorker error 监听器在无 logger 时不抛异常', () => {
	const { spawnFn, mockChild } = createMockSpawn();
	spawnUpgradeWorker({
		pluginDir: '/tmp/plugin',
		fromVersion: '1.0.0',
		toVersion: '2.0.0',
		pluginId: 'test-plugin',
		pkgName: '@test/pkg',
		opts: { spawnFn },
	});

	// 无 logger 时触发 error 也不应抛异常
	assert.doesNotThrow(() => {
		mockChild._listeners.error(new Error('spawn ENOMEM'));
	});
});

test('spawnUpgradeWorker 未提供 logger 时静默跳过日志，不抛异常', () => {
	const { spawnFn, mockChild } = createMockSpawn();
	const result = spawnUpgradeWorker({
		pluginDir: '/tmp/plugin',
		fromVersion: '0.1.0',
		toVersion: '0.2.0',
		pluginId: 'test-plugin',
		pkgName: '@test/pkg',
		opts: { spawnFn },
	});
	// spawn 正常完成
	assert.equal(result.child, mockChild);
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
		logger: { info: (m) => msgs.push(m) },
	});

	assert.equal(msgs.length, 2);
	assert.ok(msgs[0].includes('a → b'));
	assert.ok(msgs[1].includes('42'));
});

// --- pino 风格 logger 兼容性（gateway 真实场景） ---

test('spawnUpgradeWorker 使用 pino 风格 logger（无 .log）时不抛异常且正常记录', () => {
	const { spawnFn, mockChild } = createMockSpawn(77);
	const msgs = [];
	// 模拟 gateway 的 pino logger：有 info/warn/error，无 log
	const pinoLikeLogger = {
		info: (m) => msgs.push(m),
		warn: () => {},
		error: () => {},
	};
	assert.equal(pinoLikeLogger.log, undefined);

	const result = spawnUpgradeWorker({
		pluginDir: '/opt/plugin',
		fromVersion: '0.1.0',
		toVersion: '0.2.0',
		pluginId: 'test-plugin',
		pkgName: '@test/pkg',
		opts: { spawnFn },
		logger: pinoLikeLogger,
	});

	assert.equal(result.child, mockChild);
	assert.equal(msgs.length, 2);
	assert.ok(msgs[0].includes('0.1.0 → 0.2.0'));
	assert.ok(msgs[1].includes('77'));
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
			logger: { info: () => {} },
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
			logger: { info: () => {} },
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
			logger: { info: () => {} },
		});

		const { options } = calls[0];
		assert.equal(options.env.OPENCLAW_STATE_DIR, '/runtime/state/dir');
	} finally {
		setRuntime(null);
	}
});
