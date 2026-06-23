import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import os from 'node:os';
import test from 'node:test';

import {
	AutoUpgradeScheduler,
	getLoadedPluginVersion,
	getLockPath,
	isPathInside,
	isUpgradeLocked,
	shouldSkipAutoUpgrade,
	writeUpgradeLock,
} from './updater.js';
import { setRuntime } from '../runtime.js';
import { addSkippedVersion, readState, writeInflight, writeState } from './state.js';
import { __reset as resetRemoteLog, __buffer as remoteLogBuffer } from '../remote-log.js';

// 测试确定性：本测试进程可能跑在 systemd 环境（CI runner 等），删掉触发
// spawn 探针的环境变量，使 __check 默认走裸 spawn；探针行为用 opts 显式注入测试
delete process.env.OPENCLAW_SYSTEMD_UNIT;
delete process.env.INVOCATION_ID;

// updater-check.js 的 getPackageInfo 默认读取 import.meta.dirname/../.. 即插件根目录的 package.json
// 无需在 src/ 创建临时文件，直接使用真实 package.json
const LOCAL_VERSION = '0.1.7';
const TEST_PLUGIN_ID = 'test-plugin';

async function makeTmpDir(prefix = 'coclaw-sched-') {
	return await fs.mkdtemp(nodePath.join(os.tmpdir(), prefix));
}

// resetEnv 创建的临时 state-dir 累积引用，进程退出时统一清掉，避免每个测试残留空目录
const __isolatedStateDirs = [];
process.on('exit', () => {
	for (const dir of __isolatedStateDirs) {
		try { nodeFs.rmSync(dir, { recursive: true, force: true }); } catch {}
	}
});

/**
 * 重置 runtime + state-dir。
 * 默认把 OPENCLAW_STATE_DIR 指向新建的临时空目录，隔离 state 读写，
 * 避免污染机器上真实的 `~/.openclaw`（与本地 OpenClaw 共用 state-dir）。
 */
function resetEnv() {
	setRuntime(null);
	const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'coclaw-sched-iso-'));
	__isolatedStateDirs.push(dir);
	process.env.OPENCLAW_STATE_DIR = dir;
}

/** 创建仅含 state.resolveStateDir 的模拟 runtime（L0 位置自检用） */
function makeStateRuntime(stateDir) {
	return { state: { resolveStateDir: () => stateDir } };
}

/** 标准 npm 安装记录的 inspectInstallFn mock */
function npmInspectFn(install = { source: 'npm', installPath: '/opt/test-plugin', version: '1.0.0' }) {
	return async () => ({ ok: true, install });
}

/** 静默 logger，记录所有日志（使用 .info 对齐 pino/gateway logger） */
function silentLogger() {
	const infos = [];
	const warns = [];
	return {
		info: (...args) => infos.push(args.join(' ')),
		warn: (...args) => warns.push(args.join(' ')),
		infos,
		warns,
	};
}

/** 模拟 execFile：模拟 npm view 返回版本 */
function mockExecFile(err, stdout) {
	return (_cmd, _args, _opts, cb) => cb(err, stdout);
}

// --- isPathInside：包含谓词边角 ---

test('isPathInside - 相同目录视为在内', () => {
	assert.equal(isPathInside('/a/b', '/a/b'), true);
});

test('isPathInside - 子路径在内', () => {
	assert.equal(isPathInside('/a', '/a/b/c'), true);
});

test('isPathInside - ".." 前缀目录名不被误判为在外', () => {
	// 裸 startsWith('..') 会把 "..foo" 误判成在外——钉死谓词回归锚
	assert.equal(isPathInside('/a', '/a/..foo'), true);
});

test('isPathInside - 兄弟目录前缀不被误判为在内', () => {
	assert.equal(isPathInside('/tmp/aaa', '/tmp/aaabbb'), false);
});

test('isPathInside - 父目录与 ".." 本身在外', () => {
	assert.equal(isPathInside('/a/b', '/a'), false);
});

test('isPathInside - win32 跨盘符由 isAbsolute 兜住', () => {
	assert.equal(isPathInside('C:\\state', 'D:\\pkg', nodePath.win32), false);
});

test('isPathInside - win32 大小写差异由 relative 天然归一', () => {
	assert.equal(isPathInside('C:\\State\\dir', 'c:\\state\\dir\\pkg', nodePath.win32), true);
});

// --- shouldSkipAutoUpgrade（L0：Nix 短路 + 位置自检）---

test('shouldSkipAutoUpgrade - 包根在 state-dir 内时不跳过', async () => {
	resetEnv();
	resetRemoteLog();
	const stateDir = await makeTmpDir('coclaw-l0-state-');
	try {
		const pkgRoot = nodePath.join(stateDir, 'npm', 'projects', 'pkg');
		await fs.mkdir(pkgRoot, { recursive: true });
		setRuntime(makeStateRuntime(stateDir));
		assert.equal(shouldSkipAutoUpgrade(TEST_PLUGIN_ID, { pluginRoot: pkgRoot }), false);
		assert.ok(!remoteLogBuffer.some(e => e.text.startsWith('upgrade.position-skip')));
	} finally {
		await fs.rm(stateDir, { recursive: true, force: true });
		resetRemoteLog();
	}
});

test('shouldSkipAutoUpgrade - 包根在 state-dir 外时跳过并 remoteLog position-skip', async () => {
	resetEnv();
	resetRemoteLog();
	const stateDir = await makeTmpDir('coclaw-l0-state-');
	const pkgRoot = await makeTmpDir('coclaw-l0-pkg-');
	try {
		setRuntime(makeStateRuntime(stateDir));
		assert.equal(shouldSkipAutoUpgrade(TEST_PLUGIN_ID, { pluginRoot: pkgRoot }), true);
		const entry = remoteLogBuffer.find(e => e.text.startsWith('upgrade.position-skip'));
		assert.ok(entry, 'expected position-skip signal');
		// 信号须携带两侧 realpath，便于远程定位
		assert.ok(entry.text.includes(`pkgRoot=${nodeFs.realpathSync(pkgRoot)}`));
		assert.ok(entry.text.includes(`stateDir=${nodeFs.realpathSync(stateDir)}`));
	} finally {
		await fs.rm(stateDir, { recursive: true, force: true });
		await fs.rm(pkgRoot, { recursive: true, force: true });
		resetRemoteLog();
	}
});

test('shouldSkipAutoUpgrade - state-dir 为软链时 realpath 归一后不误判在外', async () => {
	resetEnv();
	resetRemoteLog();
	const realState = await makeTmpDir('coclaw-l0-real-');
	const linkParent = await makeTmpDir('coclaw-l0-link-');
	try {
		const linkPath = nodePath.join(linkParent, 'state-link');
		await fs.symlink(realState, linkPath, 'dir');
		const pkgRoot = nodePath.join(realState, 'extensions', 'pkg');
		await fs.mkdir(pkgRoot, { recursive: true });
		// runtime 给软链路径、包根给真实路径：realpath 归一后应判定在内
		setRuntime(makeStateRuntime(linkPath));
		assert.equal(shouldSkipAutoUpgrade(TEST_PLUGIN_ID, { pluginRoot: pkgRoot }), false);
	} finally {
		await fs.rm(linkParent, { recursive: true, force: true });
		await fs.rm(realState, { recursive: true, force: true });
		resetRemoteLog();
	}
});

test('shouldSkipAutoUpgrade - runtime 缺失时放行到 L1 并 remoteLog state-dir-failed', () => {
	resetEnv();
	resetRemoteLog();
	// resetEnv 已 setRuntime(null)；env 兜底不得用于"在外"判定
	assert.equal(shouldSkipAutoUpgrade(TEST_PLUGIN_ID), false);
	assert.ok(remoteLogBuffer.some(e => e.text.startsWith('upgrade.state-dir-failed')));
	resetRemoteLog();
});

test('shouldSkipAutoUpgrade - runtime 无 resolveStateDir 时同样放行', () => {
	resetEnv();
	resetRemoteLog();
	setRuntime({ state: {} });
	assert.equal(shouldSkipAutoUpgrade(TEST_PLUGIN_ID), false);
	assert.ok(remoteLogBuffer.some(e => e.text.startsWith('upgrade.state-dir-failed')));
	resetRemoteLog();
});

test('shouldSkipAutoUpgrade - realpath 抛错时放行并 remoteLog state-dir-failed', async () => {
	resetEnv();
	resetRemoteLog();
	const stateDir = await makeTmpDir('coclaw-l0-state-');
	try {
		setRuntime(makeStateRuntime(stateDir));
		const ghost = nodePath.join(stateDir, 'no-such-dir');
		assert.doesNotThrow(() => shouldSkipAutoUpgrade(TEST_PLUGIN_ID, { pluginRoot: ghost }));
		assert.equal(shouldSkipAutoUpgrade(TEST_PLUGIN_ID, { pluginRoot: ghost }), false);
		assert.ok(remoteLogBuffer.some(e => e.text.startsWith('upgrade.state-dir-failed')));
	} finally {
		await fs.rm(stateDir, { recursive: true, force: true });
		resetRemoteLog();
	}
});

test('shouldSkipAutoUpgrade - Nix mode 短路（先于位置判定，不发位置信号）', () => {
	resetEnv();
	resetRemoteLog();
	const prev = process.env.OPENCLAW_NIX_MODE;
	process.env.OPENCLAW_NIX_MODE = '1';
	try {
		// runtime 缺失本应发 state-dir-failed；Nix 短路在前 → 不发任何信号
		assert.equal(shouldSkipAutoUpgrade(TEST_PLUGIN_ID), true);
		assert.equal(remoteLogBuffer.length, 0);
	}
	finally {
		if (prev === undefined) delete process.env.OPENCLAW_NIX_MODE;
		else process.env.OPENCLAW_NIX_MODE = prev;
		resetRemoteLog();
	}
});

test('shouldSkipAutoUpgrade - 默认自推包根（真实检出）在临时 state-dir 外时跳过', async () => {
	resetEnv();
	resetRemoteLog();
	const stateDir = await makeTmpDir('coclaw-l0-state-');
	try {
		// 不注入 pluginRoot：覆盖默认自推包根分支；真实检出必不在临时 state-dir 内。
		// stateDir 经 opts 注入（绕过 runtime），同时覆盖 opts.stateDir 分支
		assert.equal(shouldSkipAutoUpgrade(TEST_PLUGIN_ID, { stateDir }), true);
		assert.ok(remoteLogBuffer.some(e => e.text.startsWith('upgrade.position-skip')));
	} finally {
		await fs.rm(stateDir, { recursive: true, force: true });
		resetRemoteLog();
	}
});

// --- AutoUpgradeScheduler: constructor ---

test('AutoUpgradeScheduler - 默认构造无异常', () => {
	resetEnv();
	const s = new AutoUpgradeScheduler();
	assert.equal(s.__logger, console);
	assert.deepEqual(s.__opts, {});
});

test('AutoUpgradeScheduler - 可注入 pluginId、logger 和 opts', () => {
	resetEnv();
	const logger = silentLogger();
	const s = new AutoUpgradeScheduler({ pluginId: TEST_PLUGIN_ID, logger, opts: { initialDelayMs: 10 } });
	assert.equal(s.__pluginId, TEST_PLUGIN_ID);
	assert.equal(s.__logger, logger);
	assert.equal(s.__opts.initialDelayMs, 10);
});

test('AutoUpgradeScheduler - 仅传 logger 不传 opts', () => {
	resetEnv();
	const logger = silentLogger();
	const s = new AutoUpgradeScheduler({ logger });
	assert.equal(s.__logger, logger);
	assert.deepEqual(s.__opts, {});
});

// --- start: 非 npm 安装跳过 ---

test('start - pluginId 未提供时跳过调度并记录警告', () => {
	resetEnv();
	const logger = silentLogger();
	const s = new AutoUpgradeScheduler({
		logger,
		opts: {
			shouldSkipFn: () => false,
			initialDelayMs: 10,
		},
	});

	s.start();

	assert.equal(s.__running, false);
	assert.ok(logger.warns.some(m => m.includes('pluginId not provided')));
	assert.equal(s.__initialTimer, null);
});

test('start - shouldSkip 判定跳过（位置在外）时不启动调度', () => {
	resetEnv();
	const logger = silentLogger();
	const s = new AutoUpgradeScheduler({
		pluginId: TEST_PLUGIN_ID,
		logger,
		opts: {
			shouldSkipFn: () => true,
			initialDelayMs: 10,
		},
	});

	s.start();

	assert.equal(s.__running, false);
	assert.ok(logger.infos.some(m => m.includes('outside state-dir')));
	assert.equal(s.__initialTimer, null);
});

test('start - 默认实现判定包根在 state-dir 外时跳过调度', async () => {
	resetEnv();
	resetRemoteLog();
	const stateDir = await makeTmpDir('coclaw-l0-state-');
	try {
		const logger = silentLogger();
		// 不注入 shouldSkipFn：走默认 shouldSkipAutoUpgrade，stateDir 经 __opts 透传
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: { stateDir, initialDelayMs: 100000 },
		});

		s.start();

		assert.equal(s.__running, false);
		assert.ok(logger.infos.some(m => m.includes('outside state-dir')));
		assert.ok(remoteLogBuffer.some(e => e.text.startsWith('upgrade.position-skip')));
	} finally {
		await fs.rm(stateDir, { recursive: true, force: true });
		resetRemoteLog();
	}
});

test('start - host 在 Nix mode 时跳过调度并 remoteLog', () => {
	resetEnv();
	resetRemoteLog();
	const logger = silentLogger();
	const shouldSkipCalls = [];
	const s = new AutoUpgradeScheduler({
		pluginId: TEST_PLUGIN_ID,
		logger,
		opts: {
			isNixModeFn: () => true,
			shouldSkipFn: () => { shouldSkipCalls.push(1); return false; },
			initialDelayMs: 10,
		},
	});

	s.start();

	assert.equal(s.__running, false);
	assert.ok(logger.infos.some(m => m.includes('Nix mode')));
	assert.equal(s.__initialTimer, null);
	// Nix mode 必须在 shouldSkip 之前短路，否则会浪费一次账本读取
	assert.equal(shouldSkipCalls.length, 0);
	// 上推 server 用于事后定位用户反馈
	assert.ok(remoteLogBuffer.some(e => e.text === 'upgrade.nix-mode-skip'));
});

test('start - 不提供 isNixModeFn 时使用默认 isNixMode（OPENCLAW_NIX_MODE=1）', () => {
	resetEnv();
	resetRemoteLog();
	const prev = process.env.OPENCLAW_NIX_MODE;
	process.env.OPENCLAW_NIX_MODE = '1';
	try {
		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				shouldSkipFn: () => false,
				initialDelayMs: 10,
			},
		});

		s.start();

		assert.equal(s.__running, false);
		assert.ok(logger.infos.some(m => m.includes('Nix mode')));
		assert.ok(remoteLogBuffer.some(e => e.text === 'upgrade.nix-mode-skip'));
	}
	finally {
		if (prev === undefined) delete process.env.OPENCLAW_NIX_MODE;
		else process.env.OPENCLAW_NIX_MODE = prev;
	}
});

// --- start: 正常启动 ---

test('start - 正常启动后设置 __running 和 timer', async () => {
	resetEnv();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				shouldSkipFn: () => false,
				initialDelayMs: 10,
				checkIntervalMs: 100000,
				execFileFn: mockExecFile(null, `${LOCAL_VERSION}\n`),
			},
		});

		s.start();
		assert.equal(s.__running, true);
		assert.ok(s.__initialTimer !== null);
		assert.ok(logger.infos.some(m => m.includes('Scheduler started')));

		// 等 initial delay 触发 __check
		await new Promise(r => setTimeout(r, 80));

		s.stop();
	} finally {
		resetEnv();
	}
});

// --- double start 是 no-op ---

test('start - 重复调用 start 是 no-op', () => {
	resetEnv();
	const logger = silentLogger();
	const s = new AutoUpgradeScheduler({
		pluginId: TEST_PLUGIN_ID,
		logger,
		opts: {
			shouldSkipFn: () => false,
			initialDelayMs: 100000,
			checkIntervalMs: 100000,
		},
	});

	s.start();
	const timer1 = s.__initialTimer;
	s.start(); // 应该直接 return
	assert.equal(s.__initialTimer, timer1);

	s.stop();
});

// --- stop ---

test('stop - 清除 timer 并设置 __running = false', () => {
	resetEnv();
	const logger = silentLogger();
	const s = new AutoUpgradeScheduler({
		pluginId: TEST_PLUGIN_ID,
		logger,
		opts: {
			shouldSkipFn: () => false,
			initialDelayMs: 100000,
			checkIntervalMs: 100000,
		},
	});

	s.start();
	assert.equal(s.__running, true);

	s.stop();
	assert.equal(s.__running, false);
	assert.equal(s.__initialTimer, null);
	assert.equal(s.__intervalTimer, null);
	assert.ok(logger.infos.some(m => m.includes('Scheduler stopped')));
});

test('stop - 未启动时调用是 no-op', () => {
	resetEnv();
	const logger = silentLogger();
	const s = new AutoUpgradeScheduler({ logger });

	s.stop();
	assert.equal(logger.infos.length, 0);
});

test('stop - 清除 intervalTimer', async () => {
	resetEnv();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				shouldSkipFn: () => false,
				initialDelayMs: 10,
				checkIntervalMs: 30,
				execFileFn: mockExecFile(null, `${LOCAL_VERSION}\n`),
			},
		});

		s.start();

		// 等初始延迟 + interval 被设置
		await new Promise(r => setTimeout(r, 80));

		// interval timer 应已创建
		assert.ok(s.__intervalTimer !== null, 'intervalTimer 应已设置');

		s.stop();
		assert.equal(s.__intervalTimer, null);
		assert.equal(s.__initialTimer, null);
	} finally {
		resetEnv();
	}
});

// --- __check: 无更新时记录日志 ---

test('__check - 无更新时记录日志', async () => {
	resetEnv();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: mockExecFile(null, `${LOCAL_VERSION}\n`),
			},
		});

		await s.__check();

		assert.ok(logger.infos.some(m => m.includes('Checking for updates')));
		assert.ok(logger.infos.some(m => m.includes('No update available')));
	} finally {
		resetEnv();
	}
});

// --- __check: 跳过版本时记录日志 ---

test('__check - skippedVersions 命中时记录跳过日志', async () => {
	resetEnv();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		// 将 99.0.0 加入 skippedVersions
		await addSkippedVersion('99.0.0');

		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: mockExecFile(null, '99.0.0\n'),
			},
		});

		await s.__check();

		assert.ok(logger.infos.some(m => m.includes('99.0.0 skipped')));
		assert.ok(logger.infos.some(m => m.includes('previously failed')));
	} finally {
		resetEnv();
	}
});

// --- __check: 有更新时 spawn worker ---

test('__check - 有更新时调用 spawnUpgradeWorker 并写入锁', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		const spawnCalls = [];
		const mockSpawnFn = (cmd, args, opts) => {
			spawnCalls.push({ cmd, args, opts });
			return { pid: 9999, unref: () => {}, on: () => {} };
		};

		const lockPids = [];
		const msgs = [];
		const logger = {
			info: (...args) => msgs.push(args.join(' ')),
			warn: (...args) => msgs.push(args.join(' ')),
		};

		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: mockExecFile(null, '99.0.0\n'),
				inspectInstallFn: npmInspectFn(),
				spawnFn: mockSpawnFn,
				isUpgradeLockedFn: async () => false,
				writeUpgradeLockFn: async (pid) => { lockPids.push(pid); },
			},
		});

		await s.__check();

		assert.ok(msgs.some(m => m.includes('Update available')));
		assert.equal(spawnCalls.length, 1);
		// 命名参数格式：--pluginDir /opt/test-plugin（取自权威记录 installPath）
		assert.ok(spawnCalls[0].args.includes('/opt/test-plugin'));
		// 基线版本接线：--baselineVersion 1.0.0（取自权威记录 version）
		const args = spawnCalls[0].args;
		assert.equal(args[args.indexOf('--baselineVersion') + 1], '1.0.0');
		// writeUpgradeLockFn 应被调用，且传入 child.pid
		assert.deepEqual(lockPids, [9999]);
		// remoteLog 应推送 upgrade.available
		assert.ok(remoteLogBuffer.some(e => e.text.startsWith('upgrade.available')));
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

// --- __check: 升级锁被持有时跳过检查 ---

test('__check - isUpgradeLockedFn 返回 true 时跳过检查', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		let checkForUpdateCalled = false;
		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: (_cmd, _args, _opts, cb) => {
					checkForUpdateCalled = true;
					cb(null, '99.0.0\n');
				},
				isUpgradeLockedFn: async () => true,
			},
		});

		await s.__check();

		// 不应调用 checkForUpdate
		assert.equal(checkForUpdateCalled, false);
		// 应记录 "still running" 日志
		assert.ok(logger.infos.some(m => m.includes('still running')));
		// remoteLog 应推送 upgrade.worker-locked
		assert.ok(remoteLogBuffer.some(e => e.text === 'upgrade.worker-locked'));
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

// --- __check: L1 来源门禁 ---

test('L1 - source 非 npm 时本周期跳过：不 spawn、无 available、source-skip 去重', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		let inspectCalls = 0;
		let spawnCalls = 0;
		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: mockExecFile(null, '99.0.0\n'),
				inspectInstallFn: async () => {
					inspectCalls += 1;
					return { ok: true, install: { source: 'path', installPath: '/x' } };
				},
				spawnFn: () => { spawnCalls += 1; return { pid: 1, unref: () => {}, on: () => {} }; },
			},
		});

		await s.__check();
		await s.__check();

		assert.equal(spawnCalls, 0);
		// 逐周期重验：两轮都应调用 inspect（瞬时误判下周期自愈的结构保证）
		assert.equal(inspectCalls, 2);
		// available 后移：source 未验明 npm 不得上报
		assert.ok(!remoteLogBuffer.some(e => e.text.startsWith('upgrade.available')));
		// 稳定态信号按 (原因, toVersion) 去重：两轮只发一条
		const skips = remoteLogBuffer.filter(e => e.text === 'upgrade.source-skip source=path to=99.0.0');
		assert.equal(skips.length, 1);
		assert.ok(logger.infos.some(m => m.includes('install source is path')));
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

test('L1 - 无 install 记录时按 source=none 跳过', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: mockExecFile(null, '99.0.0\n'),
				inspectInstallFn: async () => ({ ok: true, install: null }),
			},
		});

		await s.__check();

		assert.ok(remoteLogBuffer.some(e => e.text === 'upgrade.source-skip source=none to=99.0.0'));
		assert.ok(!remoteLogBuffer.some(e => e.text.startsWith('upgrade.available')));
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

test('L1 - inspect 真失败时跳过本周期、去重上报，并在下周期自愈后放行', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		let inspectCalls = 0;
		const spawnCalls = [];
		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: mockExecFile(null, '99.0.0\n'),
				inspectInstallFn: async () => {
					inspectCalls += 1;
					if (inspectCalls <= 2) return { ok: false, reason: 'exit 1' };
					return { ok: true, install: { source: 'npm', installPath: '/opt/test-plugin', version: '1.0.0' } };
				},
				spawnFn: (cmd, args) => { spawnCalls.push(args); return { pid: 1, unref: () => {}, on: () => {} }; },
				isUpgradeLockedFn: async () => false,
				writeUpgradeLockFn: async () => {},
			},
		});

		await s.__check();
		await s.__check();
		// 前两轮失败：不 spawn，信号去重只发一条
		assert.equal(spawnCalls.length, 0);
		assert.equal(
			remoteLogBuffer.filter(e => e.text === 'upgrade.gate-inspect-failed to=99.0.0 msg=exit 1').length,
			1,
		);

		// 第三轮 inspect 恢复：放行 spawn（瞬时失败自愈，无永久停摆）
		await s.__check();
		assert.equal(spawnCalls.length, 1);
		assert.ok(remoteLogBuffer.some(e => e.text.startsWith('upgrade.available')));
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

test('L1 - available 信号多周期去重：连续放行只发一条 upgrade.available', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		const spawnCalls = [];
		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: mockExecFile(null, '99.0.0\n'),
				inspectInstallFn: npmInspectFn(),
				spawnFn: (cmd, args) => { spawnCalls.push(args); return { pid: 1, unref: () => {}, on: () => {} }; },
				isUpgradeLockedFn: async () => false,
				writeUpgradeLockFn: async () => {},
			},
		});

		// 同一 scheduler 实例连续三周期，每轮 npm 放行且 available 成立
		await s.__check();
		await s.__check();
		await s.__check();

		// 三周期都抵达 available 放行处（spawn 是 available 的紧邻下游，三次为证；
		// 若某轮没到 available，spawn 也不会触发）
		assert.equal(spawnCalls.length, 3);
		// available 同为稳定态，按 (原因, toVersion) 去重：三周期只发一条
		assert.equal(
			remoteLogBuffer.filter(e => e.text.startsWith('upgrade.available')).length,
			1,
		);
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

test('L1 - inspectInstallFn 抛异常按真失败处理（局部 catch，不落外层 check-failed）', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: mockExecFile(null, '99.0.0\n'),
				inspectInstallFn: async () => { throw new Error('inspect boom'); },
			},
		});

		await s.__check();

		assert.ok(remoteLogBuffer.some(e => e.text === 'upgrade.gate-inspect-failed to=99.0.0 msg=inspect boom'));
		// 信号不得被外层 catch-all 吞成泛化 check-failed
		assert.ok(!remoteLogBuffer.some(e => e.text.startsWith('upgrade.check-failed')));
		assert.ok(logger.warns.some(m => m.includes('inspect threw')));
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

test('L1 - installPath 缺失：回退包根 + 降级日志，包名核验通过后 spawn', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	const fakeRoot = await makeTmpDir('coclaw-l1-root-');
	try {
		// 回退目录的包名须与 checkForUpdate 读到的真实包名一致才放行
		const realPkg = JSON.parse(
			nodeFs.readFileSync(nodePath.resolve(import.meta.dirname, '../../package.json'), 'utf8'),
		);
		await fs.writeFile(
			nodePath.join(fakeRoot, 'package.json'),
			JSON.stringify({ name: realPkg.name, version: '0.0.1' }),
		);

		const spawnCalls = [];
		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: mockExecFile(null, '99.0.0\n'),
				inspectInstallFn: npmInspectFn({ source: 'npm', version: '1.0.0' }), // 无 installPath
				pluginRoot: fakeRoot,
				spawnFn: (cmd, args) => { spawnCalls.push(args); return { pid: 1, unref: () => {}, on: () => {} }; },
				isUpgradeLockedFn: async () => false,
				writeUpgradeLockFn: async () => {},
			},
		});

		await s.__check();

		assert.ok(remoteLogBuffer.some(e => e.text === `upgrade.install-path-fallback to=99.0.0 dir=${fakeRoot}`));
		assert.equal(spawnCalls.length, 1);
		const args = spawnCalls[0];
		assert.equal(args[args.indexOf('--pluginDir') + 1], fakeRoot);
	} finally {
		resetEnv();
		resetRemoteLog();
		await fs.rm(fakeRoot, { recursive: true, force: true });
	}
});

test('L1 - installPath 缺失且回退目录包名不符时拒绝 spawn', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	const fakeRoot = await makeTmpDir('coclaw-l1-root-');
	try {
		await fs.writeFile(
			nodePath.join(fakeRoot, 'package.json'),
			JSON.stringify({ name: '@evil/other-pkg', version: '0.0.1' }),
		);

		let spawnCalls = 0;
		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: mockExecFile(null, '99.0.0\n'),
				inspectInstallFn: npmInspectFn({ source: 'npm', version: '1.0.0' }),
				pluginRoot: fakeRoot,
				spawnFn: () => { spawnCalls += 1; return { pid: 1, unref: () => {}, on: () => {} }; },
			},
		});

		await s.__check();

		assert.equal(spawnCalls, 0);
		assert.ok(remoteLogBuffer.some(e => e.text === 'upgrade.no-install-path reason=pkg-name-mismatch got=@evil/other-pkg'));
		assert.ok(logger.warns.some(m => m.includes('package name check')));
	} finally {
		resetEnv();
		resetRemoteLog();
		await fs.rm(fakeRoot, { recursive: true, force: true });
	}
});

test('L1 - installPath 回退两条信号按 (原因, toVersion) 去重：两轮各只发一条', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	const fakeRoot = await makeTmpDir('coclaw-l1-root-');
	try {
		// 包名不符是稳定异常态：每周期都走 fallback + mismatch，两轮信号须各去重为一条
		await fs.writeFile(
			nodePath.join(fakeRoot, 'package.json'),
			JSON.stringify({ name: '@evil/other-pkg', version: '0.0.1' }),
		);

		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: mockExecFile(null, '99.0.0\n'),
				inspectInstallFn: npmInspectFn({ source: 'npm', version: '1.0.0' }), // 无 installPath
				pluginRoot: fakeRoot,
			},
		});

		await s.__check();
		await s.__check();

		assert.equal(
			remoteLogBuffer.filter(e => e.text === `upgrade.install-path-fallback to=99.0.0 dir=${fakeRoot}`).length,
			1,
		);
		assert.equal(
			remoteLogBuffer.filter(e => e.text === 'upgrade.no-install-path reason=pkg-name-mismatch got=@evil/other-pkg').length,
			1,
		);
		// 非去重的 warn 每周期都发：证明第二轮确实穿透到回退路径，去重断言才有意义
		assert.equal(logger.warns.filter(m => m.includes('package name check')).length, 2);
	} finally {
		resetEnv();
		resetRemoteLog();
		await fs.rm(fakeRoot, { recursive: true, force: true });
	}
});

test('L1 - installPath 缺失且回退目录无 package.json 时拒绝 spawn', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	const fakeRoot = await makeTmpDir('coclaw-l1-root-');
	try {
		let spawnCalls = 0;
		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: mockExecFile(null, '99.0.0\n'),
				inspectInstallFn: npmInspectFn({ source: 'npm', version: '1.0.0' }),
				pluginRoot: fakeRoot,
				spawnFn: () => { spawnCalls += 1; return { pid: 1, unref: () => {}, on: () => {} }; },
			},
		});

		await s.__check();

		assert.equal(spawnCalls, 0);
		assert.ok(remoteLogBuffer.some(e => e.text === 'upgrade.no-install-path reason=pkg-name-mismatch got=null'));
	} finally {
		resetEnv();
		resetRemoteLog();
		await fs.rm(fakeRoot, { recursive: true, force: true });
	}
});

test('L1 - installPath 缺失且未注入 pluginRoot 时回退默认自推包根（真实检出，核验通过）', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		const spawnCalls = [];
		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: mockExecFile(null, '99.0.0\n'),
				inspectInstallFn: npmInspectFn({ source: 'npm', version: '1.0.0' }), // 无 installPath
				spawnFn: (cmd, args) => { spawnCalls.push(args); return { pid: 1, unref: () => {}, on: () => {} }; },
				isUpgradeLockedFn: async () => false,
				writeUpgradeLockFn: async () => {},
			},
		});

		await s.__check();

		// 默认自推包根 = 真实插件检出根，包名与 checkForUpdate 读到的一致 → 放行
		assert.equal(spawnCalls.length, 1);
		const args = spawnCalls[0];
		assert.equal(args[args.indexOf('--pluginDir') + 1], nodePath.resolve(import.meta.dirname, '../..'));
		assert.ok(remoteLogBuffer.some(e => e.text.startsWith('upgrade.install-path-fallback')));
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

test('L1 - 记录无 version 时不传 --baselineVersion（基线不可得退化交给 worker）', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		const spawnCalls = [];
		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: mockExecFile(null, '99.0.0\n'),
				inspectInstallFn: npmInspectFn({ source: 'npm', installPath: '/opt/test-plugin' }), // 无 version
				spawnFn: (cmd, args) => { spawnCalls.push(args); return { pid: 1, unref: () => {}, on: () => {} }; },
				isUpgradeLockedFn: async () => false,
				writeUpgradeLockFn: async () => {},
			},
		});

		await s.__check();

		assert.equal(spawnCalls.length, 1);
		assert.ok(!spawnCalls[0].includes('--baselineVersion'));
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

test('L1 - 不提供 inspectInstallFn 时默认走 inspectPluginInstall（经 execFileFn 全链路）', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		const inspectExecCalls = [];
		// 同一 execFileFn 分流 npm view 与 openclaw plugins inspect
		const execFileFn = (cmd, args, opts, cb) => {
			if (cmd === 'npm') return cb(null, '99.0.0\n');
			if (cmd === 'openclaw' && args[1] === 'inspect') {
				inspectExecCalls.push({ args: [...args], opts });
				return cb(null, JSON.stringify({
					install: { source: 'npm', installPath: '/opt/test-plugin', version: '1.0.0' },
				}));
			}
			return cb(null, '');
		};

		const spawnCalls = [];
		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn,
				spawnFn: (cmd, args) => { spawnCalls.push(args); return { pid: 1, unref: () => {}, on: () => {} }; },
				isUpgradeLockedFn: async () => false,
				writeUpgradeLockFn: async () => {},
			},
		});

		await s.__check();

		assert.equal(spawnCalls.length, 1);
		assert.equal(inspectExecCalls.length, 1);
		// execFile 选项对齐先例：30s timeout + win32 shell
		assert.deepEqual(inspectExecCalls[0].args, ['plugins', 'inspect', TEST_PLUGIN_ID, '--json']);
		assert.equal(inspectExecCalls[0].opts.timeout, 30_000);
		assert.ok(remoteLogBuffer.some(e => e.text.startsWith('upgrade.available')));
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

// --- __check: checkForUpdate 抛异常时记录警告 ---

test('__check - checkForUpdate 异常时记录警告（npm 错误）', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: mockExecFile(new Error('ETIMEDOUT'), ''),
			},
		});

		await s.__check();

		assert.ok(logger.warns.some(m => m.includes('Check failed')));
		assert.ok(logger.warns.some(m => m.includes('npm view failed')));
		// remoteLog 应推送 upgrade.check-failed
		assert.ok(remoteLogBuffer.some(e => e.text.startsWith('upgrade.check-failed')));
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

test('__check - checkForUpdate 异常时记录警告（execFileFn 同步抛异常）', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;

	const logger = silentLogger();
	const s = new AutoUpgradeScheduler({
		pluginId: TEST_PLUGIN_ID,
		logger,
		opts: {
			execFileFn: () => { throw new Error('sync crash'); },
		},
	});

	await s.__check();

	assert.ok(logger.warns.some(m => m.includes('Check failed')));
	// remoteLog 应推送 upgrade.check-failed
	assert.ok(remoteLogBuffer.some(e => e.text.startsWith('upgrade.check-failed')));
	resetEnv();
	resetRemoteLog();
});

// --- 使用默认 shouldSkipFn（覆盖 ?? 回退分支） ---

test('start - 不提供 shouldSkipFn 时使用默认实现：runtime 缺失放行（fail-open 到 L1）', () => {
	resetEnv();
	resetRemoteLog();
	// runtime 为 null：L0 不下"在外"结论，放行启动（一次误判不再永久停摆）
	const logger = silentLogger();
	const s = new AutoUpgradeScheduler({
		pluginId: TEST_PLUGIN_ID,
		logger,
		opts: {
			initialDelayMs: 100000,
			checkIntervalMs: 100000,
		},
	});

	s.start();
	assert.equal(s.__running, true);
	assert.ok(s.__initialTimer !== null);
	assert.ok(remoteLogBuffer.some(e => e.text.startsWith('upgrade.state-dir-failed')));

	s.stop();
	resetRemoteLog();
});

// --- start 触发 __check 并设置 interval ---

test('start - initialDelay 后触发 __check 并设置 interval', async () => {
	resetEnv();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		let checkCount = 0;
		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				shouldSkipFn: () => false,
				initialDelayMs: 10,
				checkIntervalMs: 40,
				execFileFn: (_cmd, _args, _opts, cb) => {
					checkCount++;
					cb(null, `${LOCAL_VERSION}\n`);
				},
			},
		});

		s.start();

		// 等初次检查
		await new Promise(r => setTimeout(r, 50));
		assert.ok(checkCount >= 1, '首次检查应已触发');

		// 等第二次 interval 检查
		await new Promise(r => setTimeout(r, 80));
		assert.ok(checkCount >= 2, 'interval 检查应已触发');

		s.stop();
	} finally {
		resetEnv();
	}
});

// --- pino 风格 logger 兼容性（gateway 真实场景） ---

test('__check - 使用 pino 风格 logger（无 .log）完整走通 check + spawn 流程', async () => {
	resetEnv();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		const spawnCalls = [];
		const infos = [];
		const warns = [];
		// 模拟 gateway 的 pino logger：有 info/warn/error，无 log
		const pinoLikeLogger = {
			info: (...args) => infos.push(args.join(' ')),
			warn: (...args) => warns.push(args.join(' ')),
			error: () => {},
		};
		assert.equal(pinoLikeLogger.log, undefined);

		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger: pinoLikeLogger,
			opts: {
				shouldSkipFn: () => false,
				initialDelayMs: 10,
				checkIntervalMs: 100000,
				execFileFn: mockExecFile(null, '99.0.0\n'),
				inspectInstallFn: npmInspectFn(),
				spawnFn: (cmd, args, opts) => {
					spawnCalls.push({ cmd, args, opts });
					return { pid: 8888, unref: () => {}, on: () => {} };
				},
				isUpgradeLockedFn: async () => false,
				writeUpgradeLockFn: async () => {},
			},
		});

		s.start();
		assert.ok(infos.some(m => m.includes('Scheduler started')));

		await s.__check();

		assert.ok(infos.some(m => m.includes('Checking for updates')));
		assert.ok(infos.some(m => m.includes('Update available')));
		// spawnUpgradeWorker 内部也通过同一 logger 输出
		assert.ok(infos.some(m => m.includes('[spawner]')));
		assert.equal(spawnCalls.length, 1);
		assert.equal(warns.length, 0);

		s.stop();
		assert.ok(infos.some(m => m.includes('Scheduler stopped')));
	} finally {
		resetEnv();
	}
});

test('isUpgradeLocked 使用 pino 风格 logger（无 .log）清理过期锁时不抛异常', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		const infos = [];
		const pinoLikeLogger = {
			info: (...args) => infos.push(args.join(' ')),
			warn: () => {},
			error: () => {},
		};
		assert.equal(pinoLikeLogger.log, undefined);

		await writeUpgradeLock(999999999);
		const locked = await isUpgradeLocked({ logger: pinoLikeLogger });
		assert.equal(locked, false);
		assert.ok(infos.some(m => m.includes('Stale lock removed')));
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

// --- getLockPath ---

test('getLockPath 使用 OPENCLAW_STATE_DIR', () => {
	resetEnv();
	process.env.OPENCLAW_STATE_DIR = '/tmp/fake-state';
	const p = getLockPath();
	assert.equal(p, '/tmp/fake-state/coclaw/upgrade.lock');
});

test('getLockPath 使用 runtime.state.resolveStateDir', () => {
	resetEnv();
	setRuntime({ state: { resolveStateDir: () => '/custom/state' } });
	const p = getLockPath();
	assert.equal(p, '/custom/state/coclaw/upgrade.lock');
});

test('getLockPath 默认回退到 ~/.openclaw', () => {
	resetEnv();
	delete process.env.OPENCLAW_STATE_DIR;
	const p = getLockPath();
	assert.equal(p, nodePath.join(os.homedir(), '.openclaw', 'coclaw', 'upgrade.lock'));
});

// --- writeUpgradeLock ---

test('writeUpgradeLock 创建锁文件（含 pid 和 ts）', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		await writeUpgradeLock(12345);

		const raw = await fs.readFile(getLockPath(), 'utf8');
		const lock = JSON.parse(raw);
		assert.equal(lock.pid, 12345);
		assert.ok(lock.ts);
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

// --- isUpgradeLocked ---

test('isUpgradeLocked 锁文件不存在时返回 false', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		const locked = await isUpgradeLocked();
		assert.equal(locked, false);
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('isUpgradeLocked 锁文件存在且 PID 存活时返回 true', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		await writeUpgradeLock(process.pid);
		const locked = await isUpgradeLocked();
		assert.equal(locked, true);
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('isUpgradeLocked PID 已死时返回 false 并清理过期锁', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		const logger = silentLogger();
		await writeUpgradeLock(999999999);
		const locked = await isUpgradeLocked({ logger });
		assert.equal(locked, false);
		await assert.rejects(fs.access(getLockPath()));
		assert.ok(logger.infos.some(m => m.includes('Stale lock removed')));
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('isUpgradeLocked 锁文件内容无效时返回 false 并清理', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		const lockPath = getLockPath();
		await fs.mkdir(nodePath.dirname(lockPath), { recursive: true });
		await fs.writeFile(lockPath, 'not valid json', 'utf8');

		const logger = silentLogger();
		const locked = await isUpgradeLocked({ logger });
		assert.equal(locked, false);
		await assert.rejects(fs.access(lockPath));
		assert.ok(logger.infos.some(m => m.includes('Stale lock removed')));
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('isUpgradeLocked 锁文件无 pid 字段时返回 false 并清理', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		const lockPath = getLockPath();
		await fs.mkdir(nodePath.dirname(lockPath), { recursive: true });
		await fs.writeFile(lockPath, JSON.stringify({ ts: '2026-03-12' }), 'utf8');

		const logger = silentLogger();
		const locked = await isUpgradeLocked({ logger });
		assert.equal(locked, false);
		await assert.rejects(fs.access(lockPath));
		assert.ok(logger.infos.some(m => m.includes('missing-pid')));
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('isUpgradeLocked 锁文件超龄（> TTL）时返回 false 并清理，不检查 PID 存活', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		const lockPath = getLockPath();
		await fs.mkdir(nodePath.dirname(lockPath), { recursive: true });
		// ts 比 TTL 还早得多；PID 用当前进程 PID（肯定活）反证 "TTL 判断优先于 PID 检活"——
		// 若实现遗漏 TTL 分支直接走 process.kill(pid, 0)，本测试会因 locked === true 而挂
		const staleTs = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
		await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, ts: staleTs }), 'utf8');

		const logger = silentLogger();
		const locked = await isUpgradeLocked({ logger });
		assert.equal(locked, false);
		await assert.rejects(fs.access(lockPath));
		assert.ok(logger.infos.some(m => m.includes('ttl-exceeded')));
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('isUpgradeLocked 锁文件 ts 字段无效时返回 false 并清理', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		const lockPath = getLockPath();
		await fs.mkdir(nodePath.dirname(lockPath), { recursive: true });
		await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, ts: 'not-a-date' }), 'utf8');

		const logger = silentLogger();
		const locked = await isUpgradeLocked({ logger });
		assert.equal(locked, false);
		await assert.rejects(fs.access(lockPath));
		assert.ok(logger.infos.some(m => m.includes('ttl-exceeded')));
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('isUpgradeLocked 清锁失败时打 warn + 上报 remoteLog，不抛异常', async () => {
	resetEnv();
	resetRemoteLog();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	const lockPath = getLockPath();
	const lockDir = nodePath.dirname(lockPath);
	try {
		await fs.mkdir(lockDir, { recursive: true });
		// 构造一个会走 ttl-exceeded 清锁分支的锁
		const staleTs = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
		await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, ts: staleTs }), 'utf8');
		// 去掉父目录写权限，让 fs.rm(lockPath) 抛 EACCES
		await fs.chmod(lockDir, 0o555);

		const logger = silentLogger();
		const locked = await isUpgradeLocked({ logger });

		assert.equal(locked, false);
		assert.ok(
			logger.warns.some(m => m.includes('Stale lock removal failed') && m.includes('ttl-exceeded')),
			'expected warn containing "Stale lock removal failed (ttl-exceeded)"',
		);
		assert.ok(
			remoteLogBuffer.some(e => e.text.startsWith('upgrade.lock-cleanup-failed reason=ttl-exceeded')),
			'expected remoteLog entry with reason=ttl-exceeded',
		);
	}
	finally {
		try { await fs.chmod(lockDir, 0o755); } catch {}
		await fs.rm(dir, { recursive: true, force: true });
		resetRemoteLog();
	}
});

// --- __reportLastUpgradeResult ---

test('__reportLastUpgradeResult - 有未报告的 lastUpgrade 时 remoteLog 并写入 lastReport', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		await writeState({
			lastUpgrade: { from: '0.10.0', to: '0.11.0', result: 'success', ts: '2026-04-01T00:00:00.000Z' },
		});

		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: mockExecFile(null, `${LOCAL_VERSION}\n`),
			},
		});

		await s.__check();

		assert.ok(remoteLogBuffer.some(e => e.text === 'upgrade.result result=success from=0.10.0 to=0.11.0'));
		assert.ok(logger.infos.some(m => m.includes('Last upgrade') && m.includes('success')));
		const state = await readState();
		assert.equal(state.lastReport, '2026-04-01T00:00:00.000Z');
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

test('__reportLastUpgradeResult - lastReport 等于 lastUpgrade.ts 时不重复推送', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		await writeState({
			lastUpgrade: { from: '0.10.0', to: '0.11.0', result: 'success', ts: '2026-04-01T00:00:00.000Z' },
			lastReport: '2026-04-01T00:00:00.000Z',
		});

		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: mockExecFile(null, `${LOCAL_VERSION}\n`),
			},
		});

		await s.__check();

		assert.ok(!remoteLogBuffer.some(e => e.text.startsWith('upgrade.result')));
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

test('__reportLastUpgradeResult - worker 的 noop-skip 结局经下轮 upgrade.result 上报', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		// 模拟 worker no-op 分支写入的 lastUpgrade（result=noop-skip token）
		await writeState({
			lastUpgrade: { from: '1.0.0', to: '1.1.0', result: 'noop-skip', ts: '2026-06-11T00:00:00.000Z' },
		});

		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: mockExecFile(null, `${LOCAL_VERSION}\n`),
			},
		});

		await s.__check();

		assert.ok(remoteLogBuffer.some(e => e.text === 'upgrade.result result=noop-skip from=1.0.0 to=1.1.0'));
		const state = await readState();
		assert.equal(state.lastReport, '2026-06-11T00:00:00.000Z');
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

test('__reportLastUpgradeResult - 无 lastUpgrade 时静默跳过', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		await writeState({});

		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: mockExecFile(null, `${LOCAL_VERSION}\n`),
			},
		});

		await s.__check();

		assert.ok(!remoteLogBuffer.some(e => e.text.startsWith('upgrade.result')));
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

test('__reportLastUpgradeResult - state 无 lastReport 字段时正常报告', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		// lastUpgrade 存在，但 state 中无 lastReport 字段
		await writeState({
			lastUpgrade: { from: '0.9.0', to: '0.10.0', result: 'rollback', ts: '2026-03-15T12:00:00.000Z' },
		});

		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: mockExecFile(null, `${LOCAL_VERSION}\n`),
			},
		});

		await s.__check();

		assert.ok(remoteLogBuffer.some(e => e.text === 'upgrade.result result=rollback from=0.9.0 to=0.10.0'));
		const state = await readState();
		assert.equal(state.lastReport, '2026-03-15T12:00:00.000Z');
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

test('__reportLastUpgradeResult - readState 抛异常时输出日志和 remoteLog 且不影响 __check 主流程', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: mockExecFile(null, `${LOCAL_VERSION}\n`),
				readStateFn: async () => { throw new Error('disk error'); },
			},
		});

		await s.__check();

		// __check 主流程不应被中断
		assert.ok(logger.infos.some(m => m.includes('Checking for updates')));
		// 异常应输出本地 warn 和 remoteLog
		assert.ok(logger.warns.some(m => m.includes('Report last upgrade result failed') && m.includes('disk error')));
		assert.ok(remoteLogBuffer.some(e => e.text === 'upgrade.report-failed msg=disk error'));
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

test('__reportLastUpgradeResult - writeState 失败时输出 remoteLog 且同进程内不重复报告同一 ts', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		await writeState({
			lastUpgrade: { from: '0.10.0', to: '0.11.0', result: 'rollback', ts: '2026-04-01T00:00:00.000Z' },
		});

		const logger = silentLogger();
		// mock writeState 使 lastReport 写入失败
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: mockExecFile(null, `${LOCAL_VERSION}\n`),
				writeStateFn: async () => { throw new Error('write failed'); },
			},
		});

		await s.__check();
		// upgrade.result 应已推送（在 writeState 失败之前）
		assert.equal(remoteLogBuffer.filter(e => e.text.startsWith('upgrade.result')).length, 1);
		// writeState 失败应输出 report-failed
		assert.ok(remoteLogBuffer.some(e => e.text === 'upgrade.report-failed msg=write failed'));
		assert.ok(logger.warns.some(m => m.includes('Report last upgrade result failed')));

		// 第二次调用，__lastReportedUpgradeTs 应阻止重复推送
		resetRemoteLog();
		await s.__check();
		assert.equal(remoteLogBuffer.filter(e => e.text.startsWith('upgrade.result')).length, 0);
		// report-failed 也不应再出现
		assert.equal(remoteLogBuffer.filter(e => e.text.startsWith('upgrade.report-failed')).length, 0);
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

// --- __check: skipped 版本 remoteLog ---

test('__check - skippedVersions 命中时 remoteLog upgrade.skipped', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		await addSkippedVersion('99.0.0');

		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: mockExecFile(null, '99.0.0\n'),
			},
		});

		await s.__check();

		assert.ok(remoteLogBuffer.some(e => e.text === 'upgrade.skipped version=99.0.0'));
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

test('__check - skippedVersions 命中信号按 (skipped, version) 去重：两轮只发一条', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		await addSkippedVersion('99.0.0');

		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: mockExecFile(null, '99.0.0\n'),
			},
		});

		await s.__check();
		await s.__check();

		assert.equal(
			remoteLogBuffer.filter(e => e.text === 'upgrade.skipped version=99.0.0').length,
			1,
			'稳定态 skipped 信号必须去重，不能每小时刷一条',
		);
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

// --- __check: prerelease 闸 ---

test('__check - latest 为 prerelease 时不 spawn、prerelease-skip 信号去重、不写 skip', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		let spawnCalls = 0;
		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: mockExecFile(null, '99.0.0-beta.1\n'),
				inspectInstallFn: npmInspectFn(),
				spawnFn: () => { spawnCalls += 1; return { pid: 1, unref: () => {}, on: () => {} }; },
				isUpgradeLockedFn: async () => false,
				writeUpgradeLockFn: async () => {},
			},
		});

		await s.__check();
		await s.__check();

		assert.equal(spawnCalls, 0, 'prerelease 不得 spawn worker');
		assert.equal(
			remoteLogBuffer.filter(e => e.text === 'upgrade.prerelease-skip version=99.0.0-beta.1').length,
			1,
			'prerelease-skip 信号去重',
		);
		assert.ok(logger.infos.some(m => m.includes('prerelease')));

		// 闸不落持久状态：不写 skip / lastUpgrade（latest 回正后自然恢复）
		const state = await readState();
		assert.equal(state.skippedVersions, undefined);
		assert.equal(state.lastUpgrade, undefined);
		// lastCheck 照旧推进
		assert.equal(typeof state.lastCheck, 'string');
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

// --- __check: inflight 对账 ---

test('__reconcileInflight - 运行态达 verifyTarget 时补记 ok + 删备份 + 同周期上报', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		// 模拟 worker 死在 verify 期：inflight 留存、终态未记
		await writeInflight({ from: '1.0.0', to: '99.0.0', verifyTarget: '99.0.0', pluginDir: '/opt/p', phase: 'verify' });

		const removed = [];
		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				// 对账后 checkForUpdate 看到 latest=本地版本 → 无更新，不 spawn
				execFileFn: mockExecFile(null, `${LOCAL_VERSION}\n`),
				runtimeVersion: '99.0.0',
				removeBackupFn: async (id) => { removed.push(id); },
			},
		});

		await s.__check();

		const state = await readState();
		assert.equal(state.inflight, undefined, 'inflight 应被消化清除');
		assert.equal(state.lastUpgrade.result, 'ok');
		assert.equal(state.lastUpgrade.from, '1.0.0');
		assert.equal(state.lastUpgrade.to, '99.0.0');
		assert.equal(state.skippedVersions, undefined, 'verifyTarget==to 不补 skip');
		assert.deepEqual(removed, [TEST_PLUGIN_ID], '成功对账应删备份');
		assert.ok(logger.infos.some(m => m.includes('Reconciled interrupted upgrade as ok')));
		// 补记的终态经同周期 __reportLastUpgradeResult 上报
		assert.ok(remoteLogBuffer.some(e => e.text === 'upgrade.result result=ok from=1.0.0 to=99.0.0'));
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

test('__reconcileInflight - verifyTarget≠to 时复刻 worker 语义补 skip（advancedShortfall）', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		// latest-compatible 封顶：目标 99.1.0、实装/验证目标 99.0.5
		await writeInflight({ from: '1.0.0', to: '99.1.0', verifyTarget: '99.0.5', pluginDir: '/opt/p', phase: 'verify' });

		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: mockExecFile(null, `${LOCAL_VERSION}\n`),
				runtimeVersion: '99.0.5',
				removeBackupFn: async () => {},
			},
		});

		await s.__check();

		const state = await readState();
		assert.equal(state.lastUpgrade.result, 'ok');
		assert.equal(state.lastUpgrade.to, '99.0.5');
		assert.ok(state.skippedVersions.includes('99.1.0'), 'toVersion 已知到不了须补 skip');
		assert.equal(state.inflight, undefined);
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

test('__reconcileInflight - 运行态未达标时补记 interrupted（带 phase）、不 skip、不删备份、当周期继续重试', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		await writeInflight({ from: '1.0.0', to: '99.0.0', verifyTarget: '99.0.0', pluginDir: '/opt/p', phase: 'update' });

		const removed = [];
		const spawnCalls = [];
		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				// 对账后 checkForUpdate 仍看到 99.0.0 可用 → 正常重试 spawn
				execFileFn: mockExecFile(null, '99.0.0\n'),
				inspectInstallFn: npmInspectFn(),
				runtimeVersion: '1.0.0',
				removeBackupFn: async (id) => { removed.push(id); },
				spawnFn: (cmd, args) => { spawnCalls.push(args); return { pid: 1, unref: () => {}, on: () => {} }; },
				isUpgradeLockedFn: async () => false,
				writeUpgradeLockFn: async () => {},
			},
		});

		await s.__check();

		const state = await readState();
		assert.equal(state.lastUpgrade.result, 'interrupted');
		assert.equal(state.lastUpgrade.phase, 'update', '账目须带中断时刻 phase');
		assert.equal(state.skippedVersions, undefined, 'interrupted 不自动 skip');
		assert.equal(removed.length, 0, 'interrupted 不清备份（保留人工恢复）');
		assert.ok(remoteLogBuffer.some(e =>
			e.text === 'upgrade.interrupted from=1.0.0 to=99.0.0 phase=update runtime=1.0.0'));
		// 先对账再检查：同周期内正常走 checkForUpdate 重试
		assert.equal(spawnCalls.length, 1, '对账完成后当周期应继续检查并 spawn 重试');
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

test('__reconcileInflight - 判据不可得（runtimeVersion 空）时保留 inflight、跳过本周期', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		await writeInflight({ from: '1.0.0', to: '99.0.0', verifyTarget: '99.0.0', pluginDir: '/opt/p', phase: 'update' });

		let checkCalled = false;
		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: (_cmd, _args, _opts, cb) => { checkCalled = true; cb(null, '99.0.0\n'); },
				runtimeVersion: '',
			},
		});

		await s.__check();
		await s.__check();

		assert.equal(checkCalled, false, '判据不可得时不得进入 checkForUpdate');
		const state = await readState();
		assert.ok(state.inflight, 'inflight 应保留待下轮');
		assert.equal(
			remoteLogBuffer.filter(e => e.text === 'upgrade.reconcile-no-version to=99.0.0').length,
			1,
			'no-version 信号去重',
		);
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

test('getLoadedPluginVersion - 返回模块加载时刻捕获的自身版本（与 package.json 一致）', async () => {
	// 测试进程加载 updater.js 后未改过磁盘 package.json，快照应与磁盘一致
	const pkgPath = nodePath.join(import.meta.dirname, '..', '..', 'package.json');
	const diskVersion = JSON.parse(await fs.readFile(pkgPath, 'utf8')).version;
	assert.equal(getLoadedPluginVersion(), diskVersion);
});

test('__reconcileInflight - 畸形 inflight（verifyTarget 与 to 皆缺）按 interrupted/malformed 消化，管线继续', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		// writeInflight({}) 只落 ts——复刻"字段缺失"的畸形在途标记
		await writeInflight({});

		const removed = [];
		const spawnCalls = [];
		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				// 消化后 checkForUpdate 看到 99.0.0 可用 → 管线恢复正常 spawn
				execFileFn: mockExecFile(null, '99.0.0\n'),
				inspectInstallFn: npmInspectFn(),
				removeBackupFn: async (id) => { removed.push(id); },
				spawnFn: (cmd, args) => { spawnCalls.push(args); return { pid: 1, unref: () => {}, on: () => {} }; },
				isUpgradeLockedFn: async () => false,
				writeUpgradeLockFn: async () => {},
			},
		});

		await s.__check();
		await s.__check();

		const state = await readState();
		assert.equal(state.inflight, undefined, '畸形 inflight 应被消化，不得永久停摆');
		assert.equal(state.lastUpgrade.result, 'interrupted');
		assert.equal(state.lastUpgrade.phase, 'malformed');
		assert.equal(state.lastUpgrade.from, 'unknown');
		assert.equal(state.lastUpgrade.to, 'unknown');
		assert.equal(state.skippedVersions, undefined, 'malformed 不自动 skip');
		assert.equal(removed.length, 0, 'malformed 不清备份（保留人工恢复）');
		assert.ok(logger.warns.some(m => m.includes('Malformed inflight')));
		assert.equal(
			remoteLogBuffer.filter(e => e.text === 'upgrade.reconcile-malformed').length,
			1,
			'malformed 信号去重',
		);
		// 消化后管线恢复：同周期继续 checkForUpdate 并 spawn（第二周期被锁 mock 放行后正常重试）
		assert.ok(spawnCalls.length >= 1, '消化后后续周期应恢复正常检查');
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

test('__reconcileInflight - 畸形 inflight 终态写失败时保留 inflight、跳过本周期', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		// from 在场 / to 为空串：仍属畸形（无判定目标），且覆盖 from/to 非 nullish 取值侧
		await writeInflight({ from: '9.9.9', to: '' });

		let checkCalled = false;
		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: (_cmd, _args, _opts, cb) => { checkCalled = true; cb(null, '99.0.0\n'); },
				recordUpgradeTerminalFn: async () => { throw new Error('disk full'); },
			},
		});

		await s.__check();

		assert.equal(checkCalled, false, '未消化时不得继续本周期');
		assert.ok(remoteLogBuffer.some(e => e.text === 'upgrade.reconcile-failed msg=disk full'));
		assert.ok(logger.warns.some(m => m.includes('Inflight reconcile failed')));
		const state = await readState();
		assert.ok(state.inflight, 'inflight 应保留待下轮');
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

test('__reconcileInflight - 终态写失败时 remoteLog reconcile-failed、保留 inflight、跳过本周期', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		await writeInflight({ from: '1.0.0', to: '99.0.0', verifyTarget: '99.0.0', pluginDir: '/opt/p', phase: 'verify' });

		let checkCalled = false;
		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: (_cmd, _args, _opts, cb) => { checkCalled = true; cb(null, '99.0.0\n'); },
				runtimeVersion: '99.0.0',
				recordUpgradeTerminalFn: async () => { throw new Error('disk full'); },
			},
		});

		await s.__check();

		assert.equal(checkCalled, false, '对账未消化时不得继续本周期');
		assert.ok(remoteLogBuffer.some(e => e.text === 'upgrade.reconcile-failed msg=disk full'));
		assert.ok(logger.warns.some(m => m.includes('Inflight reconcile failed')));
		const state = await readState();
		assert.ok(state.inflight, 'inflight 应保留');
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

test('__reconcileInflight - inflight 读取失败时 reconcile-failed、跳过本周期', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		let checkCalled = false;
		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: (_cmd, _args, _opts, cb) => { checkCalled = true; cb(null, '99.0.0\n'); },
				readInflightFn: async () => { throw new Error('read boom'); },
			},
		});

		await s.__check();

		assert.equal(checkCalled, false);
		assert.ok(remoteLogBuffer.some(e => e.text === 'upgrade.reconcile-failed msg=read boom'));
		assert.ok(logger.warns.some(m => m.includes('Inflight read failed')));
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

test('__reconcileInflight - 备份清理失败不影响 ok 终态（non-fatal）', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		await writeInflight({ from: '1.0.0', to: '99.0.0', verifyTarget: '99.0.0', pluginDir: '/opt/p', phase: 'verify' });

		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: mockExecFile(null, `${LOCAL_VERSION}\n`),
				runtimeVersion: '99.0.0',
				removeBackupFn: async () => { throw new Error('rm boom'); },
			},
		});

		await s.__check();

		const state = await readState();
		assert.equal(state.lastUpgrade.result, 'ok');
		assert.equal(state.inflight, undefined);
		assert.ok(logger.warns.some(m => m.includes('Reconcile backup cleanup failed')));
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

// --- __check: spec 钉死可见性信号 ---

test('__check - install.spec 为精确版本时发 spec-pinned 去重信号（行为不变仍 spawn）', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		const spawnCalls = [];
		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: mockExecFile(null, '99.0.0\n'),
				inspectInstallFn: npmInspectFn({
					source: 'npm', installPath: '/opt/test-plugin', version: '1.0.0',
					spec: '@test/pkg@1.0.0',
				}),
				spawnFn: (cmd, args) => { spawnCalls.push(args); return { pid: 1, unref: () => {}, on: () => {} }; },
				isUpgradeLockedFn: async () => false,
				writeUpgradeLockFn: async () => {},
			},
		});

		await s.__check();
		await s.__check();

		assert.equal(
			remoteLogBuffer.filter(e => e.text === 'upgrade.spec-pinned spec=@test/pkg@1.0.0').length,
			1,
			'spec-pinned 信号去重',
		);
		// 仅可见性信号，不拦行为：worker 侧裸包名 update 负责解钉
		assert.equal(spawnCalls.length, 2);
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

test('__check - install.spec 非精确版本（裸名 / range）时不发 spec-pinned', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		const logger = silentLogger();
		for (const spec of ['@test/pkg', 'pkg@^1.0.0', undefined]) {
			const s = new AutoUpgradeScheduler({
				pluginId: TEST_PLUGIN_ID,
				logger,
				opts: {
					execFileFn: mockExecFile(null, '99.0.0\n'),
					inspectInstallFn: npmInspectFn({
						source: 'npm', installPath: '/opt/test-plugin', version: '1.0.0', spec,
					}),
					spawnFn: () => ({ pid: 1, unref: () => {}, on: () => {} }),
					isUpgradeLockedFn: async () => false,
					writeUpgradeLockFn: async () => {},
				},
			});
			await s.__check();
		}

		assert.equal(remoteLogBuffer.filter(e => e.text.startsWith('upgrade.spec-pinned')).length, 0);
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

// --- __check: cgroup 脱逃失败信号 ---

test('__check - systemd 形态探针全失败时降级裸 spawn 并发 cgroup-escape-failed 去重信号', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		const spawnCalls = [];
		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: (cmd, _args, _opts, cb) => {
					if (cmd === 'systemd-run') return cb(new Error('probe boom'));
					cb(null, '99.0.0\n');
				},
				platform: 'linux',
				scopeEnv: { INVOCATION_ID: 'abc' },
				inspectInstallFn: npmInspectFn(),
				spawnFn: (cmd, args) => { spawnCalls.push({ cmd, args }); return { pid: 1, unref: () => {}, on: () => {} }; },
				isUpgradeLockedFn: async () => false,
				writeUpgradeLockFn: async () => {},
			},
		});

		await s.__check();
		await s.__check();

		// 降级=现状：仍裸 spawn（worker 只 spawn 一次/周期，无重拉）
		assert.equal(spawnCalls.length, 2);
		assert.equal(spawnCalls[0].cmd, process.execPath);
		assert.equal(
			remoteLogBuffer.filter(e => e.text === 'upgrade.cgroup-escape-failed to=99.0.0').length,
			1,
			'escape-failed 信号去重',
		);
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

test('__check - systemd 形态探针通过时 spawn 包成 systemd-run scope', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		const spawnCalls = [];
		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: (cmd, _args, _opts, cb) => {
					if (cmd === 'systemd-run') return cb(null, '', '');
					cb(null, '99.0.0\n');
				},
				platform: 'linux',
				scopeEnv: { OPENCLAW_SYSTEMD_UNIT: 'openclaw-gateway.service' },
				inspectInstallFn: npmInspectFn(),
				spawnFn: (cmd, args) => { spawnCalls.push({ cmd, args }); return { pid: 4321, unref: () => {}, on: () => {} }; },
				isUpgradeLockedFn: async () => false,
				writeUpgradeLockFn: async () => {},
			},
		});

		await s.__check();

		assert.equal(spawnCalls.length, 1);
		assert.equal(spawnCalls[0].cmd, 'systemd-run');
		assert.deepEqual(spawnCalls[0].args.slice(0, 6), ['--user', '--scope', '--quiet', '--collect', '--', process.execPath]);
		assert.equal(remoteLogBuffer.filter(e => e.text.startsWith('upgrade.cgroup-escape-failed')).length, 0);
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});

test('__reportLastUpgradeResult - lastUpgrade 带 error 时上报行附 error=', async () => {
	resetEnv();
	resetRemoteLog();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		await writeState({
			lastUpgrade: {
				from: '1.0.0', to: '1.1.0', result: 'rollback-failed',
				error: 'fallback install failed: boom', ts: '2026-06-11T00:00:00.000Z',
			},
		});

		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({ pluginId: TEST_PLUGIN_ID, logger });
		await s.__reportLastUpgradeResult();

		assert.ok(remoteLogBuffer.some(e =>
			e.text === 'upgrade.result result=rollback-failed from=1.0.0 to=1.1.0 error=fallback install failed: boom'));
	} finally {
		resetEnv();
		resetRemoteLog();
	}
});
