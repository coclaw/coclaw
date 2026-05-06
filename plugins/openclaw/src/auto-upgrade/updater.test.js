import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import os from 'node:os';
import test from 'node:test';

import {
	AutoUpgradeScheduler,
	getLockPath,
	getPluginInstallPath,
	isUpgradeLocked,
	shouldSkipAutoUpgrade,
	writeUpgradeLock,
} from './updater.js';
import { setRuntime } from '../runtime.js';
import { addSkippedVersion, readState, writeState } from './state.js';
import { __reset as resetRemoteLog, __buffer as remoteLogBuffer } from '../remote-log.js';

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
 * 默认把 OPENCLAW_STATE_DIR 指向新建的临时空目录，确保 loadInstallRecord 走
 * "账本不存在 → 回落到 loadConfig" 路径，避免误读到机器上真实
 * `~/.openclaw/plugins/installs.json`（与本地 OpenClaw 共用 state-dir）。
 */
function resetEnv() {
	setRuntime(null);
	const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'coclaw-sched-iso-'));
	__isolatedStateDirs.push(dir);
	process.env.OPENCLAW_STATE_DIR = dir;
}

/** 在指定 state-dir 写入新版账本文件。 */
function writeInstallsLedger(stateDir, installRecords) {
	const ledgerPath = nodePath.join(stateDir, 'plugins', 'installs.json');
	nodeFs.mkdirSync(nodePath.dirname(ledgerPath), { recursive: true });
	nodeFs.writeFileSync(ledgerPath, JSON.stringify({ version: 1, installRecords }), 'utf8');
	return ledgerPath;
}

/** 创建模拟 runtime */
function makeRuntime(installInfo = {}, pluginId = TEST_PLUGIN_ID) {
	return {
		config: {
			loadConfig: () => ({
				plugins: {
					installs: {
						[pluginId]: installInfo,
					},
				},
			}),
		},
	};
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

// --- shouldSkipAutoUpgrade ---

test('shouldSkipAutoUpgrade - source 为 npm 时返回 false（不跳过）', () => {
	resetEnv();
	setRuntime(makeRuntime({ source: 'npm', installPath: '/x' }));
	assert.equal(shouldSkipAutoUpgrade(TEST_PLUGIN_ID), false);
});

test('shouldSkipAutoUpgrade - source 为 path 时返回 true（跳过）', () => {
	resetEnv();
	setRuntime(makeRuntime({ source: 'path', installPath: '/x' }));
	assert.equal(shouldSkipAutoUpgrade(TEST_PLUGIN_ID), true);
});

test('shouldSkipAutoUpgrade - source 为 archive 时返回 true（跳过）', () => {
	resetEnv();
	setRuntime(makeRuntime({ source: 'archive', installPath: '/x' }));
	assert.equal(shouldSkipAutoUpgrade(TEST_PLUGIN_ID), true);
});

test('shouldSkipAutoUpgrade - runtime 不可用时返回 true（跳过）', () => {
	resetEnv();
	assert.equal(shouldSkipAutoUpgrade(TEST_PLUGIN_ID), true);
});

test('shouldSkipAutoUpgrade - loadConfig 抛异常时返回 true（跳过）', () => {
	resetEnv();
	setRuntime({
		config: {
			loadConfig: () => { throw new Error('corrupt'); },
		},
	});
	assert.equal(shouldSkipAutoUpgrade(TEST_PLUGIN_ID), true);
});

test('shouldSkipAutoUpgrade - config.loadConfig 不存在时返回 true（跳过）', () => {
	resetEnv();
	setRuntime({ config: {} });
	assert.equal(shouldSkipAutoUpgrade(TEST_PLUGIN_ID), true);
});

test('shouldSkipAutoUpgrade - plugins.installs 无对应插件时返回 true（跳过）', () => {
	resetEnv();
	setRuntime({
		config: {
			loadConfig: () => ({ plugins: { installs: {} } }),
		},
	});
	assert.equal(shouldSkipAutoUpgrade(TEST_PLUGIN_ID), true);
});

test('shouldSkipAutoUpgrade - installInfo 无 source 字段时返回 true（跳过）', () => {
	resetEnv();
	setRuntime(makeRuntime({ installPath: '/x' }));
	assert.equal(shouldSkipAutoUpgrade(TEST_PLUGIN_ID), true);
});

test('shouldSkipAutoUpgrade - loadConfig 返回 null 时返回 true（跳过）', () => {
	resetEnv();
	setRuntime({
		config: {
			loadConfig: () => null,
		},
	});
	assert.equal(shouldSkipAutoUpgrade(TEST_PLUGIN_ID), true);
});

// --- getPluginInstallPath ---

test('getPluginInstallPath - 正常返回 installPath', () => {
	resetEnv();
	setRuntime(makeRuntime({ source: 'npm', installPath: '/opt/plugins/coclaw' }));
	assert.equal(getPluginInstallPath(TEST_PLUGIN_ID), '/opt/plugins/coclaw');
});

test('getPluginInstallPath - installPath 缺失时返回 null', () => {
	resetEnv();
	setRuntime(makeRuntime({ source: 'npm' }));
	assert.equal(getPluginInstallPath(TEST_PLUGIN_ID), null);
});

test('getPluginInstallPath - runtime 不可用时返回 null', () => {
	resetEnv();
	assert.equal(getPluginInstallPath(TEST_PLUGIN_ID), null);
});

test('getPluginInstallPath - loadConfig 抛异常时返回 null', () => {
	resetEnv();
	setRuntime({
		config: {
			loadConfig: () => { throw new Error('broken'); },
		},
	});
	assert.equal(getPluginInstallPath(TEST_PLUGIN_ID), null);
});

test('getPluginInstallPath - config.loadConfig 不存在时返回 null', () => {
	resetEnv();
	setRuntime({ config: {} });
	assert.equal(getPluginInstallPath(TEST_PLUGIN_ID), null);
});

test('getPluginInstallPath - plugins.installs 无对应插件时返回 null', () => {
	resetEnv();
	setRuntime({
		config: {
			loadConfig: () => ({ plugins: { installs: {} } }),
		},
	});
	assert.equal(getPluginInstallPath(TEST_PLUGIN_ID), null);
});

test('getPluginInstallPath - loadConfig 返回 null 时返回 null', () => {
	resetEnv();
	setRuntime({
		config: {
			loadConfig: () => null,
		},
	});
	assert.equal(getPluginInstallPath(TEST_PLUGIN_ID), null);
});

// --- 新账本路径（OpenClaw ≥ 2026.4.25）：installs.json 是真相 ---

test('新账本 - source=npm 时 shouldSkip=false 且能拿到 installPath', () => {
	resetEnv();
	const dir = process.env.OPENCLAW_STATE_DIR;
	writeInstallsLedger(dir, {
		[TEST_PLUGIN_ID]: { source: 'npm', installPath: '/opt/pkg/test-plugin', version: '1.0.0' },
	});
	// runtime 不需要设置：新版 gateway 下 loadConfig 拿不到 plugins.installs，账本是唯一来源
	assert.equal(shouldSkipAutoUpgrade(TEST_PLUGIN_ID), false);
	assert.equal(getPluginInstallPath(TEST_PLUGIN_ID), '/opt/pkg/test-plugin');
});

test('新账本 - source=path（link 模式）时 shouldSkip=true', () => {
	resetEnv();
	const dir = process.env.OPENCLAW_STATE_DIR;
	writeInstallsLedger(dir, {
		[TEST_PLUGIN_ID]: { source: 'path', installPath: '/opt/local/test-plugin' },
	});
	assert.equal(shouldSkipAutoUpgrade(TEST_PLUGIN_ID), true);
});

test('新账本 - source=archive 时 shouldSkip=true', () => {
	resetEnv();
	const dir = process.env.OPENCLAW_STATE_DIR;
	writeInstallsLedger(dir, {
		[TEST_PLUGIN_ID]: { source: 'archive', installPath: '/opt/tar/test-plugin' },
	});
	assert.equal(shouldSkipAutoUpgrade(TEST_PLUGIN_ID), true);
});

test('新账本 - 账本里没有本插件时 shouldSkip=true，且不回落到 loadConfig 老字段', () => {
	resetEnv();
	const dir = process.env.OPENCLAW_STATE_DIR;
	// 账本存在但只列了别的插件
	writeInstallsLedger(dir, {
		'some-other-plugin': { source: 'npm', installPath: '/opt/other' },
	});
	// 老字段里就算有 npm 安装记录也不能被用，否则会在新 gateway 下错判
	setRuntime(makeRuntime({ source: 'npm', installPath: '/should/not/be/used' }));
	assert.equal(shouldSkipAutoUpgrade(TEST_PLUGIN_ID), true);
	assert.equal(getPluginInstallPath(TEST_PLUGIN_ID), null);
});

test('新账本 - JSON 损坏时 shouldSkip=true、不回落，并 remoteLog 诊断信号', () => {
	resetEnv();
	resetRemoteLog();
	const dir = process.env.OPENCLAW_STATE_DIR;
	const ledgerPath = nodePath.join(dir, 'plugins', 'installs.json');
	nodeFs.mkdirSync(nodePath.dirname(ledgerPath), { recursive: true });
	nodeFs.writeFileSync(ledgerPath, '{not valid json', 'utf8');
	setRuntime(makeRuntime({ source: 'npm', installPath: '/should/not/be/used' }));
	assert.equal(shouldSkipAutoUpgrade(TEST_PLUGIN_ID), true);
	assert.equal(getPluginInstallPath(TEST_PLUGIN_ID), null);
	assert.ok(remoteLogBuffer.some(e => e.text.startsWith('upgrade.ledger-parse-failed')));
});

test('新账本 - installRecords 字段不是对象时 shouldSkip=true', () => {
	resetEnv();
	const dir = process.env.OPENCLAW_STATE_DIR;
	const ledgerPath = nodePath.join(dir, 'plugins', 'installs.json');
	nodeFs.mkdirSync(nodePath.dirname(ledgerPath), { recursive: true });
	nodeFs.writeFileSync(ledgerPath, JSON.stringify({ version: 1, installRecords: null }), 'utf8');
	assert.equal(shouldSkipAutoUpgrade(TEST_PLUGIN_ID), true);
	assert.equal(getPluginInstallPath(TEST_PLUGIN_ID), null);
});

test('新账本 - 读取失败（非 ENOENT）时 shouldSkip=true、不回落，并 remoteLog 诊断信号', () => {
	resetEnv();
	resetRemoteLog();
	const dir = process.env.OPENCLAW_STATE_DIR;
	const ledgerDir = nodePath.join(dir, 'plugins');
	const ledgerPath = nodePath.join(ledgerDir, 'installs.json');
	nodeFs.mkdirSync(ledgerDir, { recursive: true });
	// 用目录占位 ledgerPath：readFileSync 会抛 EISDIR（不是 ENOENT）
	nodeFs.mkdirSync(ledgerPath, { recursive: true });
	setRuntime(makeRuntime({ source: 'npm', installPath: '/should/not/be/used' }));
	assert.equal(shouldSkipAutoUpgrade(TEST_PLUGIN_ID), true);
	assert.equal(getPluginInstallPath(TEST_PLUGIN_ID), null);
	assert.ok(remoteLogBuffer.some(e => e.text.startsWith('upgrade.ledger-read-failed code=EISDIR')));
});

test('新账本 - 账本里有插件但 installPath 缺失时 getPluginInstallPath=null', () => {
	resetEnv();
	const dir = process.env.OPENCLAW_STATE_DIR;
	writeInstallsLedger(dir, {
		[TEST_PLUGIN_ID]: { source: 'npm', version: '1.0.0' }, // 故意不写 installPath
	});
	assert.equal(shouldSkipAutoUpgrade(TEST_PLUGIN_ID), false);
	assert.equal(getPluginInstallPath(TEST_PLUGIN_ID), null);
});

test('shouldSkipAutoUpgrade - resolveStateDir 抛异常时返回 true、不传播，并 remoteLog 诊断信号', () => {
	resetEnv();
	resetRemoteLog();
	setRuntime({
		state: { resolveStateDir: () => { throw new Error('boom'); } },
	});
	assert.doesNotThrow(() => shouldSkipAutoUpgrade(TEST_PLUGIN_ID));
	assert.equal(shouldSkipAutoUpgrade(TEST_PLUGIN_ID), true);
	assert.equal(getPluginInstallPath(TEST_PLUGIN_ID), null);
	assert.ok(remoteLogBuffer.some(e => e.text.startsWith('upgrade.state-dir-failed')));
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

test('start - 非 npm 安装时跳过调度', () => {
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
	assert.ok(logger.infos.some(m => m.includes('not an npm-installed plugin')));
	assert.equal(s.__initialTimer, null);
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
				getPluginInstallPathFn: () => '/opt/test-plugin',
				spawnFn: mockSpawnFn,
				isUpgradeLockedFn: async () => false,
				writeUpgradeLockFn: async (pid) => { lockPids.push(pid); },
			},
		});

		await s.__check();

		assert.ok(msgs.some(m => m.includes('Update available')));
		assert.equal(spawnCalls.length, 1);
		// 命名参数格式：--pluginDir /opt/test-plugin
		assert.ok(spawnCalls[0].args.includes('/opt/test-plugin'));
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

// --- __check: 有更新但无 pluginDir 时警告 ---

test('__check - 有更新但 pluginDir 为 null 时记录警告', async () => {
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
				getPluginInstallPathFn: () => null,
			},
		});

		await s.__check();

		assert.ok(logger.warns.some(m => m.includes('Cannot determine plugin install path')));
		// remoteLog 应推送 upgrade.no-install-path
		assert.ok(remoteLogBuffer.some(e => e.text === 'upgrade.no-install-path'));
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

test('start - 不提供 shouldSkipFn 时使用默认 shouldSkipAutoUpgrade', () => {
	resetEnv();
	// runtime 为 null，shouldSkipAutoUpgrade(pluginId) 返回 true，跳过
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
	assert.equal(s.__running, false);
	assert.ok(logger.infos.some(m => m.includes('not an npm-installed plugin')));

	s.stop();
});

// --- 使用默认 getPluginInstallPathFn（覆盖 ?? 回退分支） ---

test('__check - 不提供 getPluginInstallPathFn 时使用默认 getPluginInstallPath', async () => {
	resetEnv();
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		// runtime 为 null，getPluginInstallPath(pluginId) 返回 null -> 走 pluginDir 为空的分支
		const logger = silentLogger();
		const s = new AutoUpgradeScheduler({
			pluginId: TEST_PLUGIN_ID,
			logger,
			opts: {
				execFileFn: mockExecFile(null, '99.0.0\n'),
				// 不提供 getPluginInstallPathFn，使用默认
			},
		});

		await s.__check();

		// 因为 runtime 为 null，getPluginInstallPath 返回 null
		assert.ok(logger.warns.some(m => m.includes('Cannot determine plugin install path')));
	} finally {
		resetEnv();
	}
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
				getPluginInstallPathFn: () => '/opt/test-plugin',
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
