import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
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
import { addSkippedVersion } from './state.js';

// updater-check.js 的 getPackageInfo 默认读取 import.meta.dirname/../.. 即插件根目录的 package.json
// 无需在 src/ 创建临时文件，直接使用真实 package.json
const LOCAL_VERSION = '0.1.7';
const TEST_PLUGIN_ID = 'test-plugin';

async function makeTmpDir(prefix = 'coclaw-sched-') {
	return await fs.mkdtemp(nodePath.join(os.tmpdir(), prefix));
}

function resetEnv() {
	delete process.env.OPENCLAW_STATE_DIR;
	setRuntime(null);
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
	const tmpDir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = tmpDir;
	try {
		const spawnCalls = [];
		const mockSpawnFn = (cmd, args, opts) => {
			spawnCalls.push({ cmd, args, opts });
			return { pid: 9999, unref: () => {} };
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
	} finally {
		resetEnv();
	}
});

// --- __check: 升级锁被持有时跳过检查 ---

test('__check - isUpgradeLockedFn 返回 true 时跳过检查', async () => {
	resetEnv();
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
	} finally {
		resetEnv();
	}
});

// --- __check: 有更新但无 pluginDir 时警告 ---

test('__check - 有更新但 pluginDir 为 null 时记录警告', async () => {
	resetEnv();
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
	} finally {
		resetEnv();
	}
});

// --- __check: checkForUpdate 抛异常时记录警告 ---

test('__check - checkForUpdate 异常时记录警告（npm 错误）', async () => {
	resetEnv();
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
	} finally {
		resetEnv();
	}
});

test('__check - checkForUpdate 异常时记录警告（execFileFn 同步抛异常）', async () => {
	resetEnv();
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
	resetEnv();
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
					return { pid: 8888, unref: () => {} };
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
		assert.ok(logger.infos.some(m => m.includes('missing pid')));
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
