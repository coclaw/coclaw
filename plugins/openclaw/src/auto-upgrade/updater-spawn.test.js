import assert from 'node:assert/strict';
import test from 'node:test';
import nodePath from 'node:path';
import os from 'node:os';

import { getWorkerPath, probeSystemdScopeArgs, shouldAttemptScopeEscape, spawnUpgradeWorker } from './updater-spawn.js';
import { setRuntime } from '../runtime.js';

// 测试确定性：本测试进程自身可能跑在 systemd 环境（CI runner 等），
// 删掉触发探针的环境变量，默认路径恒为裸 spawn；探针行为用 opts 显式注入测试
delete process.env.OPENCLAW_SYSTEMD_UNIT;
delete process.env.INVOCATION_ID;

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

test('spawnUpgradeWorker 使用正确参数调用 spawn', async () => {
	const { spawnFn, calls } = createMockSpawn();
	await spawnUpgradeWorker({
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
	// 命名参数格式；未提供 baselineVersion 时不出现该 flag
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

test('spawnUpgradeWorker 提供 baselineVersion 时追加 --baselineVersion argv', async () => {
	const { spawnFn, calls } = createMockSpawn();
	await spawnUpgradeWorker({
		pluginDir: '/tmp/plugin',
		fromVersion: '1.0.0',
		toVersion: '2.0.0',
		baselineVersion: '1.0.0',
		pluginId: 'test-plugin',
		pkgName: '@test/pkg',
		opts: { spawnFn },
		logger: { info: () => {} },
	});

	const { args } = calls[0];
	assert.deepEqual(args.slice(1), [
		'--pluginDir', '/tmp/plugin',
		'--fromVersion', '1.0.0',
		'--toVersion', '2.0.0',
		'--pluginId', 'test-plugin',
		'--pkgName', '@test/pkg',
		'--baselineVersion', '1.0.0',
	]);
});

test('spawnUpgradeWorker baselineVersion 为空串时不追加 flag（基线不可得交 worker 退化）', async () => {
	const { spawnFn, calls } = createMockSpawn();
	await spawnUpgradeWorker({
		pluginDir: '/tmp/plugin',
		fromVersion: '1.0.0',
		toVersion: '2.0.0',
		baselineVersion: '',
		pluginId: 'test-plugin',
		pkgName: '@test/pkg',
		opts: { spawnFn },
		logger: { info: () => {} },
	});

	assert.ok(!calls[0].args.includes('--baselineVersion'));
});

test('spawnUpgradeWorker 调用 child.unref()', async () => {
	const { spawnFn, mockChild } = createMockSpawn();
	await spawnUpgradeWorker({
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

test('spawnUpgradeWorker 返回包含 child 与 escapeFailed 的对象', async () => {
	const { spawnFn, mockChild } = createMockSpawn(999);
	const result = await spawnUpgradeWorker({
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
	assert.equal(result.escapeFailed, false);
});

test('spawnUpgradeWorker 注册 error 事件监听器防止 gateway 崩溃', async () => {
	const { spawnFn, mockChild } = createMockSpawn();
	const warns = [];
	await spawnUpgradeWorker({
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

test('spawnUpgradeWorker error 监听器在无 logger 时不抛异常', async () => {
	const { spawnFn, mockChild } = createMockSpawn();
	await spawnUpgradeWorker({
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

test('spawnUpgradeWorker 未提供 logger 时静默跳过日志，不抛异常', async () => {
	const { spawnFn, mockChild } = createMockSpawn();
	const result = await spawnUpgradeWorker({
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

test('spawnUpgradeWorker 自定义 logger 收到日志', async () => {
	const { spawnFn } = createMockSpawn(42);
	const msgs = [];
	await spawnUpgradeWorker({
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

test('spawnUpgradeWorker 使用 pino 风格 logger（无 .log）时不抛异常且正常记录', async () => {
	const { spawnFn, mockChild } = createMockSpawn(77);
	const msgs = [];
	// 模拟 gateway 的 pino logger：有 info/warn/error，无 log
	const pinoLikeLogger = {
		info: (m) => msgs.push(m),
		warn: () => {},
		error: () => {},
	};
	assert.equal(pinoLikeLogger.log, undefined);

	const result = await spawnUpgradeWorker({
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

test('spawnUpgradeWorker 无 runtime 时 env 包含 OPENCLAW_STATE_DIR（回退到默认路径）', async () => {
	setRuntime(null);
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	delete process.env.OPENCLAW_STATE_DIR;

	try {
		const { spawnFn, calls } = createMockSpawn();
		await spawnUpgradeWorker({
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

test('spawnUpgradeWorker 无 runtime 时 env 使用 OPENCLAW_STATE_DIR 环境变量', async () => {
	setRuntime(null);
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = '/custom/state/dir';

	try {
		const { spawnFn, calls } = createMockSpawn();
		await spawnUpgradeWorker({
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

test('spawnUpgradeWorker 有 runtime 时 env 使用 runtime.state.resolveStateDir()', async () => {
	const mockRuntime = {
		state: {
			resolveStateDir: () => '/runtime/state/dir',
		},
	};
	setRuntime(mockRuntime);

	try {
		const { spawnFn, calls } = createMockSpawn();
		await spawnUpgradeWorker({
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

// --- shouldAttemptScopeEscape ---

test('shouldAttemptScopeEscape - linux + systemd env 变量在场时为 true', () => {
	assert.equal(shouldAttemptScopeEscape('linux', { INVOCATION_ID: 'abc' }), true);
	assert.equal(shouldAttemptScopeEscape('linux', { OPENCLAW_SYSTEMD_UNIT: 'openclaw-gateway.service' }), true);
});

test('shouldAttemptScopeEscape - linux 但无 systemd env 时为 false', () => {
	assert.equal(shouldAttemptScopeEscape('linux', {}), false);
});

test('shouldAttemptScopeEscape - 非 linux 平台恒为 false', () => {
	assert.equal(shouldAttemptScopeEscape('darwin', { INVOCATION_ID: 'abc' }), false);
	assert.equal(shouldAttemptScopeEscape('win32', { INVOCATION_ID: 'abc' }), false);
});

// --- probeSystemdScopeArgs ---

/** 创建探针 execFile mock：variantOk 控制 --user / 无 --user 两个变体是否成功 */
function createProbeExec({ userOk, systemOk }) {
	const calls = [];
	const execFileFn = (cmd, args, opts, cb) => {
		calls.push({ cmd, args: [...args], opts });
		const ok = args.includes('--user') ? userOk : systemOk;
		cb(ok ? null : new Error('probe failed'));
	};
	return { execFileFn, calls };
}

test('probeSystemdScopeArgs - --user 变体成功时返回 ["--user"]（不再试第二变体）', async () => {
	const { execFileFn, calls } = createProbeExec({ userOk: true, systemOk: true });
	const result = await probeSystemdScopeArgs({ execFileFn });
	assert.deepEqual(result, ['--user']);
	assert.equal(calls.length, 1);
	// 探针命令形态：systemd-run --user --scope --quiet --collect -- /bin/true
	assert.equal(calls[0].cmd, 'systemd-run');
	assert.deepEqual(calls[0].args, ['--user', '--scope', '--quiet', '--collect', '--', '/bin/true']);
	// 探针必须带短超时：systemd-run 异常挂起时不得拖住 __check 整个周期
	assert.ok(
		Number.isFinite(calls[0].opts?.timeout) && calls[0].opts.timeout > 0,
		'probe execFile must carry a positive timeout option',
	);
});

test('probeSystemdScopeArgs - --user 失败、无 --user 成功时返回 []（system service 形态）', async () => {
	const { execFileFn, calls } = createProbeExec({ userOk: false, systemOk: true });
	const result = await probeSystemdScopeArgs({ execFileFn });
	assert.deepEqual(result, []);
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[1].args, ['--scope', '--quiet', '--collect', '--', '/bin/true']);
});

test('probeSystemdScopeArgs - 两个变体都失败时返回 null', async () => {
	const { execFileFn } = createProbeExec({ userOk: false, systemOk: false });
	const result = await probeSystemdScopeArgs({ execFileFn });
	assert.equal(result, null);
});

test('probeSystemdScopeArgs - execFileFn 同步抛错时按失败处理', async () => {
	const execFileFn = () => { throw new Error('spawn ENOENT'); };
	const result = await probeSystemdScopeArgs({ execFileFn });
	assert.equal(result, null);
});

// --- spawnUpgradeWorker × systemd scope 脱逃 ---

test('spawnUpgradeWorker - systemd 环境探针通过时包成 systemd-run scope（--user 变体）', async () => {
	const { spawnFn, calls } = createMockSpawn(321);
	const { execFileFn } = createProbeExec({ userOk: true, systemOk: true });
	const msgs = [];
	const result = await spawnUpgradeWorker({
		pluginDir: '/tmp/plugin',
		fromVersion: '1.0.0',
		toVersion: '2.0.0',
		pluginId: 'test-plugin',
		pkgName: '@test/pkg',
		opts: { spawnFn, execFileFn, platform: 'linux', scopeEnv: { INVOCATION_ID: 'abc' } },
		logger: { info: (m) => msgs.push(m) },
	});

	assert.equal(result.escapeFailed, false);
	assert.equal(calls.length, 1);
	const { cmd, args, options } = calls[0];
	assert.equal(cmd, 'systemd-run');
	// scope 前缀 + 原 worker 命令完整保留
	assert.deepEqual(args.slice(0, 6), ['--user', '--scope', '--quiet', '--collect', '--', process.execPath]);
	assert.equal(args[6], getWorkerPath());
	assert.ok(args.includes('--pluginDir') && args.includes('/tmp/plugin'));
	// spawn 选项不变
	assert.equal(options.detached, true);
	assert.equal(options.stdio, 'ignore');
	assert.ok(msgs.some(m => m.includes('scope escape enabled (user variant)')));
});

test('spawnUpgradeWorker - --user 失败时用 system 变体（无 --user 前缀）', async () => {
	const { spawnFn, calls } = createMockSpawn();
	const { execFileFn } = createProbeExec({ userOk: false, systemOk: true });
	const msgs = [];
	const result = await spawnUpgradeWorker({
		pluginDir: '/tmp/plugin',
		fromVersion: '1.0.0',
		toVersion: '2.0.0',
		pluginId: 'test-plugin',
		pkgName: '@test/pkg',
		opts: { spawnFn, execFileFn, platform: 'linux', scopeEnv: { OPENCLAW_SYSTEMD_UNIT: 'x.service' } },
		logger: { info: (m) => msgs.push(m) },
	});

	assert.equal(result.escapeFailed, false);
	assert.equal(calls[0].cmd, 'systemd-run');
	assert.deepEqual(calls[0].args.slice(0, 5), ['--scope', '--quiet', '--collect', '--', process.execPath]);
	assert.ok(msgs.some(m => m.includes('scope escape enabled (system variant)')));
});

test('spawnUpgradeWorker - 两个探针变体都失败时降级裸 spawn 且 escapeFailed=true', async () => {
	const { spawnFn, calls } = createMockSpawn();
	const { execFileFn } = createProbeExec({ userOk: false, systemOk: false });
	const warns = [];
	const result = await spawnUpgradeWorker({
		pluginDir: '/tmp/plugin',
		fromVersion: '1.0.0',
		toVersion: '2.0.0',
		pluginId: 'test-plugin',
		pkgName: '@test/pkg',
		opts: { spawnFn, execFileFn, platform: 'linux', scopeEnv: { INVOCATION_ID: 'abc' } },
		logger: { info: () => {}, warn: (m) => warns.push(m) },
	});

	// 降级=现状：裸 spawn，真 worker 只 spawn 一次（无重拉）
	assert.equal(result.escapeFailed, true);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].cmd, process.execPath);
	assert.equal(calls[0].args[0], getWorkerPath());
	assert.ok(warns.some(m => m.includes('probe failed')));
});

test('spawnUpgradeWorker - 非 systemd 环境不探针（execFileFn 不被调用）', async () => {
	const { spawnFn, calls } = createMockSpawn();
	const probeCalls = [];
	const execFileFn = (...args) => { probeCalls.push(args); args[3](null); };
	const result = await spawnUpgradeWorker({
		pluginDir: '/tmp/plugin',
		fromVersion: '1.0.0',
		toVersion: '2.0.0',
		pluginId: 'test-plugin',
		pkgName: '@test/pkg',
		opts: { spawnFn, execFileFn, platform: 'linux', scopeEnv: {} },
		logger: { info: () => {} },
	});

	assert.equal(probeCalls.length, 0);
	assert.equal(result.escapeFailed, false);
	assert.equal(calls[0].cmd, process.execPath);
});
