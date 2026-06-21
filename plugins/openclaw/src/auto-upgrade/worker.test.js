import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';

import { setRuntime } from '../runtime.js';
import { readState } from './state.js';
import { formatCmdFailure, runUpgrade } from './worker.js';

// 测试前清除 runtime
setRuntime(null);

// --- 工具函数 ---

/** 创建临时目录，包含 state 与 plugin 子目录 */
async function createTmpEnv() {
	const base = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'uw-test-'));
	const pluginDir = nodePath.join(base, 'plugin-dir');
	await fs.mkdir(pluginDir, { recursive: true });
	await fs.writeFile(
		nodePath.join(pluginDir, 'package.json'),
		JSON.stringify({ name: '@coclaw/openclaw-coclaw', version: '1.0.0' }),
	);
	await fs.writeFile(nodePath.join(pluginDir, 'index.js'), '// dummy');

	const stateDir = nodePath.join(base, 'state');
	await fs.mkdir(nodePath.join(stateDir, 'coclaw'), { recursive: true });

	return { base, pluginDir, stateDir };
}

/** 清理临时目录 */
async function cleanTmpEnv(base) {
	await fs.rm(base, { recursive: true, force: true });
}

/** 备份目录（自管位置：state-dir 下，npm prune 免疫）；与 worker 传参 pluginId 对应 */
function backupDirOf(stateDir, pluginId = 'test-plugin') {
	return nodePath.join(stateDir, 'coclaw', 'upgrade-backup', pluginId);
}

/**
 * 创建 mock execFileFn
 * @param {object} behavior - 按命令类型控制行为
 * @param {boolean} [behavior.updateFails] - plugins update 是否失败
 * @param {boolean} [behavior.gatewayRunning] - gateway status 是否返回 running
 * @param {boolean} [behavior.pluginListed] - plugins list 是否包含插件
 * @param {string} [behavior.healthVersion] - upgradeHealth 返回的版本号
 * @param {boolean} [behavior.healthFails] - upgradeHealth 是否失败
 * @param {boolean} [behavior.fallbackInstallFails] - fallback install 是否失败
 * @param {string} [behavior.inspectVersion] - plugins inspect 返回的记录版本
 * @param {boolean} [behavior.inspectFails] - plugins inspect 是否失败
 * @param {boolean} [behavior.inspectNoRecord] - plugins inspect 是否无 install 记录
 */
function createMockExec(behavior = {}) {
	const {
		updateFails = false,
		gatewayRunning = true,
		pluginListed = true,
		healthVersion = '1.1.0',
		healthFails = false,
		fallbackInstallFails = false,
		inspectVersion = '1.1.0',
		inspectFails = false,
		inspectNoRecord = false,
	} = behavior;

	const calls = [];

	return {
		calls,
		execFileFn: (_cmd, args, _opts, cb) => {
			calls.push({ cmd: _cmd, args: [...args] });
			const argsStr = args.join(' ');

			// plugins update
			if (argsStr.includes('plugins update')) {
				if (updateFails) return cb(new Error('update boom'));
				return cb(null, 'ok', '');
			}

			// plugins inspect（L2 结局核对）
			if (argsStr.includes('plugins inspect')) {
				if (inspectFails) return cb(new Error('inspect boom'));
				if (inspectNoRecord) return cb(null, JSON.stringify({ plugin: { id: 'test-plugin' } }), '');
				return cb(null, JSON.stringify({
					install: { source: 'npm', installPath: '/opt/p', version: inspectVersion },
				}), '');
			}

			// gateway status
			if (argsStr.includes('gateway status')) {
				if (gatewayRunning) return cb(null, 'running', '');
				return cb(new Error('not running'), '', '');
			}

			// plugins list
			if (argsStr.includes('plugins list')) {
				if (pluginListed) return cb(null, 'test-plugin', '');
				return cb(null, 'other-plugin', '');
			}

			// upgradeHealth
			if (argsStr.includes('coclaw.upgradeHealth')) {
				if (healthFails) return cb(new Error('health check failed'));
				return cb(null, JSON.stringify({ version: healthVersion }), '');
			}

			// plugins install (fallback)
			if (argsStr.includes('plugins install')) {
				if (fallbackInstallFails) return cb(new Error('install boom'));
				return cb(null, 'ok', '');
			}

			// 未知命令
			cb(null, '', '');
		},
	};
}

/** 收集日志 */
function createLogger() {
	const logs = [];
	return { logs, logger: (msg) => logs.push(msg) };
}

/** 快速 opts 生成 */
function fastOpts(execFileFn) {
	return {
		execFileFn,
		totalTimeoutMs: 200,
		pollIntervalMs: 20,
	};
}

// ============================================================
// 1. 成功升级路径
// ============================================================

test('runUpgrade — 成功升级：备份→更新→验证→删除备份→记录状态', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		const { execFileFn } = createMockExec({ healthVersion: '1.1.0' });
		const { logs, logger } = createLogger();

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(execFileFn),
			logger,
		});

		// 备份目录应已被删除
		await assert.rejects(
			fs.access(backupDirOf(stateDir)),
			'备份目录应已被删除',
		);

		// 原始插件目录应仍然存在
		await fs.access(pluginDir);

		// state 应记录成功
		const state = await readState();
		assert.equal(state.lastUpgrade.from, '1.0.0');
		assert.equal(state.lastUpgrade.to, '1.1.0');
		assert.equal(state.lastUpgrade.result, 'ok');

		// 日志文件应存在
		const logPath = nodePath.join(stateDir, 'coclaw', 'upgrade-log.jsonl');
		const logContent = await fs.readFile(logPath, 'utf8');
		const logEntry = JSON.parse(logContent.trim());
		assert.equal(logEntry.result, 'ok');

		// logger 应收到关键日志
		assert.ok(logs.some(l => l.includes('Starting upgrade')));
		assert.ok(logs.some(l => l.includes('Backup created')));
		assert.ok(logs.some(l => l.includes('Upgrade verified')));
		assert.ok(logs.some(l => l.includes('Upgrade complete')));
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

// ============================================================
// 1a.1 dist-tag 前移窗口：装上的版本比 toVersion 更新时，state 记录真实版本
// ============================================================

test('runUpgrade — 装上的版本比 toVersion 更新时，state/log 记录真实装上版本', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		// scheduler 观察到 latest=1.1.0 并发起升级（基线 1.0.0），worker 执行
		// plugins update 时 npm dist-tag 已前移到 1.1.1：inspect 记录 1.1.1
		//（达标判据走 isNewerVersion 严格大于分支）、upgradeHealth 返回 1.1.1；
		// 应视为成功并记录 1.1.1。必须传 baselineVersion，否则流程退化到
		// baseline-unknown 分支，测不到达标判据本身
		const { execFileFn } = createMockExec({ healthVersion: '1.1.1', inspectVersion: '1.1.1' });
		const { logs, logger } = createLogger();

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			baselineVersion: '1.0.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(execFileFn),
			logger,
		});

		// 决定性锚点：真走了达标分支（判据若变异为严格相等，会改走 advancedShortfall）
		assert.ok(logs.some(l => l.includes('Install record reached target: 1.1.1')));

		// state 的 to 必须是真实装上的版本 1.1.1，不是参数 toVersion=1.1.0
		const state = await readState();
		assert.equal(state.lastUpgrade.to, '1.1.1');
		assert.equal(state.lastUpgrade.result, 'ok');
		// 达标分支不记 skip；判据变异成严格相等会经 advancedShortfall 误写 skip
		assert.equal(state.skippedVersions, undefined);

		// log 也要记录真实版本
		const logPath = nodePath.join(stateDir, 'coclaw', 'upgrade-log.jsonl');
		const entry = JSON.parse((await fs.readFile(logPath, 'utf8')).trim());
		assert.equal(entry.to, '1.1.1');
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

// ============================================================
// 1b. 成功升级但 removeBackup 失败（non-fatal）
// ============================================================

test('runUpgrade — 成功升级但备份清理失败时仍正常完成', async (t) => {
	if (process.getuid?.() === 0) { t.skip('chmod-based error injection bypassed by root (CAP_DAC_OVERRIDE)'); return; }
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		const { execFileFn } = createMockExec({ healthVersion: '1.1.0' });
		const { logs, logger } = createLogger();

		// removeBackup 使用 force: true 很难失败，唯一可靠的方式是利用权限：
		// 在备份目录下创建只读子目录使 rm 失败
		const bakDir = backupDirOf(stateDir);

		// 让 backup 创建完成后，把父目录改为只读
		// 我们需要在 update 完成之后、removeBackup 之前执行
		// 通过 wrappedExecFn 在 verify 阶段的 gateway restart 首次调用时设置只读
		let restartCalls = 0;
		const wrappedExecFn = (cmd, args, opts, cb) => {
			const argsStr = args.join(' ');
			if (argsStr.includes('gateway restart')) {
				restartCalls++;
				if (restartCalls === 1) {
					// 第一次 gateway restart（verify 阶段的 triggerGatewayRestart）时，
					// 在备份目录下创建一个只读子目录使 rm 失败
					const protectedDir = nodePath.join(bakDir, 'protected');
					fs.mkdir(protectedDir, { recursive: true })
						.then(() => fs.chmod(bakDir, 0o444))
						.then(() => execFileFn(cmd, args, opts, cb))
						.catch(() => execFileFn(cmd, args, opts, cb));
					return;
				}
			}
			execFileFn(cmd, args, opts, cb);
		};

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(wrappedExecFn),
			logger,
		});

		// 恢复权限以便清理
		try { await fs.chmod(bakDir, 0o755); } catch {}

		// state 应仍记录成功
		const state = await readState();
		assert.equal(state.lastUpgrade.result, 'ok');

		// 日志应包含备份清理失败提示
		assert.ok(logs.some(l => l.includes('Backup cleanup failed')));

		// 升级仍应正常完成
		assert.ok(logs.some(l => l.includes('Upgrade complete')));
	} finally {
		// 确保恢复权限
		try { await fs.chmod(backupDirOf(stateDir), 0o755); } catch {}
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

// ============================================================
// 2. 更新命令失败 → 回滚
// ============================================================

test('runUpgrade — 更新命令失败：回滚但不记录 skippedVersions（瞬态故障）', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		const { execFileFn, calls } = createMockExec({
			updateFails: true,
			gatewayRunning: true,
		});
		const { logs, logger } = createLogger();

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(execFileFn),
			logger,
		});

		// 备份恢复后备份目录应消失
		await assert.rejects(fs.access(backupDirOf(stateDir)));

		// 插件目录应被恢复（package.json 仍是旧版本）
		const pkg = JSON.parse(
			await fs.readFile(nodePath.join(pluginDir, 'package.json'), 'utf8'),
		);
		assert.equal(pkg.version, '1.0.0');

		// state 应记录 rollback，但不应记录 skippedVersions（update 命令失败是瞬态故障）
		const state = await readState();
		assert.equal(state.lastUpgrade.result, 'rollback');
		assert.equal(state.skippedVersions, undefined);

		// logger 应收到关键日志
		assert.ok(logs.some(l => l.includes('Update command failed')));
		assert.ok(logs.some(l => l.includes('Restored from backup')));
		assert.ok(logs.some(l => l.includes('not skipped (transient failure)')));

		// 冻结新行为：失败后必须有 fallback retry（而不是立刻 rollback），
		// 防止未来重构把 mirror 兜底逻辑去掉而测试静默通过
		const updateCount = calls.filter(c => c.args.join(' ').includes('plugins update')).length;
		assert.equal(updateCount, 2, '失败后应触发一次 fallback retry，共调用两次 plugins update');

		// exit≠0 走现行回滚路径，一字不动：不进 L2 结局核对（不调 inspect）
		const inspectCount = calls.filter(c => c.args.join(' ').includes('plugins inspect')).length;
		assert.equal(inspectCount, 0, 'update 失败路径不应调用 plugins inspect');
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

// ============================================================
// 3. 验证失败 → 回滚（应记录 skippedVersions）
// ============================================================

test('runUpgrade — 验证失败：回滚并记录失败', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		// upgradeHealth 始终返回旧版本（不等于 toVersion）→ 轮询超时 → 回滚
		const { execFileFn } = createMockExec({
			updateFails: false,
			healthVersion: '1.0.0',
		});
		const { logs, logger } = createLogger();

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(execFileFn),
			logger,
		});

		// 插件目录应被恢复
		const pkg = JSON.parse(
			await fs.readFile(nodePath.join(pluginDir, 'package.json'), 'utf8'),
		);
		assert.equal(pkg.version, '1.0.0');

		// state 应记录 rollback
		const state = await readState();
		assert.equal(state.lastUpgrade.result, 'rollback');
		assert.ok(state.skippedVersions.includes('1.1.0'));

		// logger 应包含验证失败日志
		assert.ok(logs.some(l => l.includes('Verification failed')));
		assert.ok(logs.some(l => l.includes('Rollback complete')));
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

// ============================================================
// 4. 备份恢复失败 → 兜底 npm install
// ============================================================

test('runUpgrade — 备份恢复失败时使用兜底 npm install', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		const { execFileFn, calls } = createMockExec({
			updateFails: true,
			gatewayRunning: true,
		});
		const { logs, logger } = createLogger();

		// 创建备份，然后在 update 失败前删掉备份（模拟备份恢复失败）
		// 通过自定义 execFileFn 在 update 失败后、rollback 前删除 .bak
		let updateCalled = false;
		const wrappedExecFn = (cmd, args, opts, cb) => {
			const argsStr = args.join(' ');
			if (argsStr.includes('plugins update') && !updateCalled) {
				updateCalled = true;
				// 在回调前删除 .bak 目录，模拟备份丢失
				fs.rm(backupDirOf(stateDir), { recursive: true, force: true })
					.then(() => cb(new Error('update boom')));
				return;
			}
			execFileFn(cmd, args, opts, cb);
		};

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(wrappedExecFn),
			logger,
		});

		// 应尝试兜底 install
		assert.ok(logs.some(l => l.includes('Backup restore failed')));
		assert.ok(logs.some(l => l.includes('Fallback install completed')));

		// 单命令兜底：不再 uninstall 前置（非 TTY 下 uninstall 要求交互确认必失败）
		assert.ok(
			!calls.some(c => c.args.join(' ').includes('plugins uninstall')),
			'不应调用 plugins uninstall',
		);

		// 验证 plugins install 被调用（包含 pkgName@version + --force 覆盖装）
		const installCall = calls.find(
			c => c.args.join(' ').includes('plugins install'),
		);
		assert.ok(installCall, '应调用 plugins install');
		assert.ok(
			installCall.args.some(a => a.includes('@test/pkg@1.0.0')),
			'应安装旧版本',
		);
		assert.ok(installCall.args.includes('--force'), 'install 必须带 --force 覆盖已装插件');

		// state 应记录 rollback
		const state = await readState();
		assert.equal(state.lastUpgrade.result, 'rollback');
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

// ============================================================
// 4b. 备份恢复抛异常（fs 操作失败）→ 兜底 npm install
// ============================================================

test('runUpgrade — restoreFromBackup 抛异常时仍走兜底安装并记录状态', async (t) => {
	if (process.getuid?.() === 0) { t.skip('chmod-based error injection bypassed by root (CAP_DAC_OVERRIDE)'); return; }
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		const { execFileFn } = createMockExec({
			updateFails: true,
			gatewayRunning: true,
		});
		const { logs, logger } = createLogger();

		let updateCalled = false;
		const wrappedExecFn = (cmd, args, opts, cb) => {
			const argsStr = args.join(' ');
			if (argsStr.includes('plugins update') && !updateCalled) {
				updateCalled = true;
				// 使 pluginDir 只读，让 restoreFromBackup 的 fs.rm 抛出 EACCES
				fs.chmod(pluginDir, 0o555)
					.then(() => cb(new Error('update boom')));
				return;
			}
			execFileFn(cmd, args, opts, cb);
		};

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(wrappedExecFn),
			logger,
		});

		// restoreFromBackup 抛异常后应走兜底路径
		assert.ok(logs.some(l => l.includes('Backup restore error')));
		assert.ok(logs.some(l => l.includes('falling back to npm install')));
		assert.ok(logs.some(l => l.includes('Fallback install completed')));

		// state 应记录 rollback，但 update 命令失败不记录 skippedVersions
		const state = await readState();
		assert.equal(state.lastUpgrade.result, 'rollback');
		assert.equal(state.skippedVersions, undefined);
	} finally {
		try { await fs.chmod(pluginDir, 0o755); } catch {}
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

// ============================================================
// 4c. 兜底 install 命令形态：单命令 `plugins install <pkg>@<ver> --force`
// ============================================================

test('runUpgrade — 兜底回滚是单条 install --force 命令（无 uninstall 前置）', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		const { execFileFn, calls } = createMockExec({
			updateFails: true,
			gatewayRunning: true,
		});
		const { logs, logger } = createLogger();

		// 删除备份使 restoreFromBackup 返回 false → 走 fallback 路径
		let updateCalled = false;
		const wrappedExecFn = (cmd, args, opts, cb) => {
			const argsStr = args.join(' ');
			if (argsStr.includes('plugins update') && !updateCalled) {
				updateCalled = true;
				fs.rm(backupDirOf(stateDir), { recursive: true, force: true })
					.then(() => cb(new Error('update boom')));
				return;
			}
			execFileFn(cmd, args, opts, cb);
		};

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(wrappedExecFn),
			logger,
		});

		assert.ok(logs.some(l => l.includes('Fallback install completed')));

		// 精确命令形态：openclaw plugins install @test/pkg@1.0.0 --force
		const installCall = calls.find(
			c => c.args.join(' ').includes('plugins install'),
		);
		assert.ok(installCall, '应调用 plugins install');
		assert.deepEqual(installCall.args, ['plugins', 'install', '@test/pkg@1.0.0', '--force']);

		// 不再有 uninstall 前置
		assert.ok(!calls.some(c => c.args.join(' ').includes('plugins uninstall')));

		const state = await readState();
		assert.equal(state.lastUpgrade.result, 'rollback');
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

// ============================================================
// 5. 兜底 install 也失败
// ============================================================

test('runUpgrade — 兜底 install 也失败时记录 rollback-failed 终态（error 带真因）', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		const { execFileFn } = createMockExec({
			updateFails: true,
			fallbackInstallFails: true,
			gatewayRunning: true,
		});
		const { logs, logger } = createLogger();

		// 删除 .bak 前先让 createBackup 执行，然后通过 wrapped exec 在失败时删除
		let updateCalled = false;
		const wrappedExecFn = (cmd, args, opts, cb) => {
			const argsStr = args.join(' ');
			if (argsStr.includes('plugins update') && !updateCalled) {
				updateCalled = true;
				fs.rm(backupDirOf(stateDir), { recursive: true, force: true })
					.then(() => cb(new Error('update boom')));
				return;
			}
			execFileFn(cmd, args, opts, cb);
		};

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(wrappedExecFn),
			logger,
		});

		// 应记录两种失败
		assert.ok(logs.some(l => l.includes('Backup restore failed')));
		assert.ok(logs.some(l => l.includes('Fallback install also failed')));
		assert.ok(logs.some(l => l.includes('Rollback failed')));

		// 两路回滚都死 → rollback-failed 独立终态（账实一致：不再谎报 rollback）；
		// update 命令失败不记录 skippedVersions
		const state = await readState();
		assert.equal(state.lastUpgrade.result, 'rollback-failed');
		assert.equal(state.skippedVersions, undefined);
		// error 带真因：原始失败 + 回滚失败原因
		assert.ok(state.lastUpgrade.error.includes('rollback failed'));

		// 日志文件也应记录
		const logPath = nodePath.join(stateDir, 'coclaw', 'upgrade-log.jsonl');
		const logContent = await fs.readFile(logPath, 'utf8');
		const lines = logContent.trim().split('\n');
		const entry = JSON.parse(lines[0]);
		assert.equal(entry.result, 'rollback-failed');
		assert.ok(entry.error.includes('install boom'), 'jsonl error 应含 fallback install 真因');
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

// ============================================================
// 6. 备份恢复失败 + fromVersion 不合法 → fallbackInstallOldVersion 拒绝
// ============================================================

test('runUpgrade — 备份恢复失败且 fromVersion 不合法时，版本校验拒绝记录 rollback-failed', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		const { execFileFn } = createMockExec({
			updateFails: true,
			gatewayRunning: true,
		});
		const { logs, logger } = createLogger();

		// 在 update 失败时删除 .bak，模拟备份恢复失败
		let updateCalled = false;
		const wrappedExecFn = (cmd, args, opts, cb) => {
			const argsStr = args.join(' ');
			if (argsStr.includes('plugins update') && !updateCalled) {
				updateCalled = true;
				fs.rm(backupDirOf(stateDir), { recursive: true, force: true })
					.then(() => cb(new Error('update boom')));
				return;
			}
			execFileFn(cmd, args, opts, cb);
		};

		// 使用不合法的 fromVersion，触发 fallbackInstallOldVersion 的版本校验
		await runUpgrade({
			pluginDir,
			fromVersion: 'bad; rm -rf /',
			toVersion: '1.1.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(wrappedExecFn),
			logger,
		});

		// 应记录备份恢复失败
		assert.ok(logs.some(l => l.includes('Backup restore failed')));
		// 应记录兜底安装失败（版本校验拒绝）
		assert.ok(logs.some(l => l.includes('Fallback install also failed')));
		assert.ok(logs.some(l => l.includes('invalid version format')));

		// 两路都死 → rollback-failed；update 命令失败不记录 skippedVersions
		const state = await readState();
		assert.equal(state.lastUpgrade.result, 'rollback-failed');
		assert.equal(state.skippedVersions, undefined);
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

// ============================================================
// 6b. 备份恢复失败 + fromVersion 含尾部注入 → 正则拒绝
// ============================================================

test('runUpgrade — fromVersion 含尾部注入内容时，SEMVER_RE 拒绝', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		const { execFileFn } = createMockExec({
			updateFails: true,
			gatewayRunning: true,
		});
		const { logs, logger } = createLogger();

		let updateCalled = false;
		const wrappedExecFn = (cmd, args, opts, cb) => {
			const argsStr = args.join(' ');
			if (argsStr.includes('plugins update') && !updateCalled) {
				updateCalled = true;
				fs.rm(backupDirOf(stateDir), { recursive: true, force: true })
					.then(() => cb(new Error('update boom')));
				return;
			}
			execFileFn(cmd, args, opts, cb);
		};

		// "1.0.0; rm -rf /" 开头合法但尾部含注入，应被拒绝
		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0; rm -rf /',
			toVersion: '1.1.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(wrappedExecFn),
			logger,
		});

		assert.ok(logs.some(l => l.includes('Fallback install also failed')));
		assert.ok(logs.some(l => l.includes('invalid version format')));
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

// ============================================================
// 6c. 备份恢复失败 + pre-release 版本 → 正则允许
// ============================================================

test('runUpgrade — fromVersion 为 pre-release 格式时，兜底安装正常执行', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		const { execFileFn, calls } = createMockExec({
			updateFails: true,
			gatewayRunning: true,
		});
		const { logs, logger } = createLogger();

		let updateCalled = false;
		const wrappedExecFn = (cmd, args, opts, cb) => {
			const argsStr = args.join(' ');
			if (argsStr.includes('plugins update') && !updateCalled) {
				updateCalled = true;
				fs.rm(backupDirOf(stateDir), { recursive: true, force: true })
					.then(() => cb(new Error('update boom')));
				return;
			}
			execFileFn(cmd, args, opts, cb);
		};

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0-beta.1',
			toVersion: '1.1.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(wrappedExecFn),
			logger,
		});

		// pre-release 版本应通过校验，兜底安装被执行
		assert.ok(logs.some(l => l.includes('Fallback install completed')));
		const installCall = calls.find(
			c => c.args.join(' ').includes('plugins install'),
		);
		assert.ok(installCall);
		assert.ok(installCall.args.some(a => a.includes('@test/pkg@1.0.0-beta.1')));
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

// ============================================================
// 6d. 含连字符的 pre-release 版本 → 正则允许
// ============================================================

test('runUpgrade — fromVersion 为含连字符的 pre-release（如 rc-1）时，兜底安装正常执行', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		const { execFileFn, calls } = createMockExec({
			updateFails: true,
			gatewayRunning: true,
		});
		const { logs, logger } = createLogger();

		let updateCalled = false;
		const wrappedExecFn = (cmd, args, opts, cb) => {
			const argsStr = args.join(' ');
			if (argsStr.includes('plugins update') && !updateCalled) {
				updateCalled = true;
				fs.rm(backupDirOf(stateDir), { recursive: true, force: true })
					.then(() => cb(new Error('update boom')));
				return;
			}
			execFileFn(cmd, args, opts, cb);
		};

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0-rc-1',
			toVersion: '1.1.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(wrappedExecFn),
			logger,
		});

		assert.ok(logs.some(l => l.includes('Fallback install completed')));
		const installCall = calls.find(
			c => c.args.join(' ').includes('plugins install'),
		);
		assert.ok(installCall);
		assert.ok(installCall.args.some(a => a.includes('@test/pkg@1.0.0-rc-1')));
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

// ============================================================
// 7. 验证时 upgradeHealth 失败
// ============================================================

test('runUpgrade — 验证时 upgradeHealth 失败，触发回滚', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		const { execFileFn } = createMockExec({
			gatewayRunning: true,
			pluginListed: true,
			healthFails: true,
		});
		const { logs, logger } = createLogger();

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(execFileFn),
			logger,
		});

		assert.ok(logs.some(l => l.includes('Verification failed')));
		const state = await readState();
		assert.equal(state.lastUpgrade.result, 'rollback');
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

// ============================================================
// 8. 默认 logger（console.log）
// ============================================================

test('runUpgrade — 未提供 logger 时使用 console.log', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;
	const origLog = console.log;
	const logged = [];
	console.log = (...args) => logged.push(args.join(' '));

	try {
		const { execFileFn } = createMockExec({ healthVersion: '1.1.0' });

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(execFileFn),
		});

		assert.ok(logged.some(l => l.includes('[upgrade-worker]')));
	} finally {
		console.log = origLog;
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

// ============================================================
// 9. 回滚路径触发 gateway restart（不验证结果）
// ============================================================

test('runUpgrade — 回滚路径触发 gateway restart（尽力而为）', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		// update 失败触发回滚；rollback 里调 triggerGatewayRestart 吞掉命令失败
		const { execFileFn, calls } = createMockExec({
			updateFails: true,
		});
		const { logs, logger } = createLogger();

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(execFileFn),
			logger,
		});

		// 回滚路径应打出触发 restart 的日志
		assert.ok(logs.some(l => l.includes('Triggering gateway restart after rollback')));

		// update 失败场景下 verify 不跑，所以 restart 调用只来自 rollback 路径
		const restartCalls = calls.filter(c => c.args.join(' ').includes('gateway restart'));
		assert.equal(restartCalls.length, 1, '仅 rollback 路径触发一次 restart（update 失败 → 不跑 verify）');

		// restart 发生在所有 plugins update 调用之后（时序上属于 rollback 阶段）
		const lastRestartIdx = calls.findLastIndex(c => c.args.join(' ').includes('gateway restart'));
		const lastUpdateIdx = calls.findLastIndex(c => c.args.join(' ').includes('plugins update'));
		assert.ok(lastRestartIdx > lastUpdateIdx, 'rollback 的 restart 必须在所有 update 之后');

		const state = await readState();
		assert.equal(state.lastUpgrade.result, 'rollback');
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

test('runUpgrade — 回滚路径中 gateway restart 命令失败也不抛，且记账先于 restart + 落事件', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		const { execFileFn } = createMockExec({ updateFails: true });
		// 包一层使 gateway restart 命令失败；并在 restart 时点断言记账已完成
		// （记账前移：worker 在不可脱逃形态下可能被自己触发的重启杀死，
		//  记账必须发生在 restart 之前才不丢账）
		let stateAtRestart = null;
		const wrappedExecFn = (cmd, args, opts, cb) => {
			if (args.join(' ').includes('gateway restart')) {
				readState()
					.then((s) => { stateAtRestart = s; })
					.then(() => cb(new Error('restart boom')));
				return;
			}
			return execFileFn(cmd, args, opts, cb);
		};
		const { logs, logger } = createLogger();

		// 未抛即为通过
		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(wrappedExecFn),
			logger,
		});

		const state = await readState();
		assert.equal(state.lastUpgrade.result, 'rollback');

		// 记账前移锚点：restart 触发时刻 lastUpgrade 已落盘、inflight 已清
		assert.ok(stateAtRestart, 'restart 应被触发');
		assert.equal(stateAtRestart.lastUpgrade?.result, 'rollback', '记账必须先于 restart');
		assert.equal(stateAtRestart.inflight, undefined, 'inflight 必须在 restart 前清除');

		// restart 命令失败 → jsonl 落 rollback-restart-failed 事件（worker 禁 remoteLog）
		const logPath = nodePath.join(stateDir, 'coclaw', 'upgrade-log.jsonl');
		const lines = (await fs.readFile(logPath, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
		assert.ok(lines.some(e => e.event === 'rollback-restart-failed'));
		assert.ok(logs.some(l => l.includes('Gateway restart command failed after rollback')));
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

// ============================================================
// 11. registry fallback：第一次 update 失败、第二次 retry 成功
// ============================================================

test('runUpgrade — 第一次 update 失败时用反向 mirror 重试，成功后视为升级成功', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;
	// sentinel 用于验证 retry env 真正继承了 process.env，
	// 而不是只设了一个 npm_config_registry 字段
	const sentinelKey = `__UW_SENTINEL_${Date.now()}`;
	process.env[sentinelKey] = 'sentinel-value';

	try {
		const captured = { updates: [], registry: false };
		const execFileFn = (cmd, args, opts, cb) => {
			const argsStr = args.join(' ');

			if (argsStr.includes('config get registry')) {
				captured.registry = true;
				return cb(null, 'https://registry.npmjs.org/\n', '');
			}

			if (argsStr.includes('plugins update')) {
				captured.updates.push({ env: opts?.env });
				if (captured.updates.length === 1) return cb(new Error('first boom'));
				return cb(null, 'ok', '');
			}

			if (argsStr.includes('gateway status')) return cb(null, 'running', '');
			if (argsStr.includes('plugins list')) return cb(null, 'test-plugin', '');
			if (argsStr.includes('coclaw.upgradeHealth')) {
				return cb(null, JSON.stringify({ version: '1.1.0' }), '');
			}
			return cb(null, '', '');
		};

		const { logs, logger } = createLogger();

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(execFileFn),
			logger,
		});

		// 共两次 update 调用：首次无 env override，第二次注入 npmmirror
		assert.equal(captured.updates.length, 2);
		assert.equal(captured.updates[0].env, undefined);
		assert.equal(captured.updates[1].env.npm_config_registry, 'https://registry.npmmirror.com/');
		// 验证 retry env 真正继承了 process.env（而非孤立对象）
		assert.equal(captured.updates[1].env[sentinelKey], 'sentinel-value');
		assert.equal(captured.registry, true);

		// state 应记录成功
		const state = await readState();
		assert.equal(state.lastUpgrade.result, 'ok');

		// 关键日志
		assert.ok(logs.some(l => l.includes('Update command failed')));
		assert.ok(logs.some(l => l.includes('Retrying with fallback registry')));
		assert.ok(logs.some(l => l.includes('Update command completed on retry')));
		assert.ok(logs.some(l => l.includes('Upgrade complete')));
	} finally {
		delete process.env[sentinelKey];
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

// ============================================================
// 12. registry fallback：用户已配 npmmirror 时反向选 npmjs
// ============================================================

test('runUpgrade — 用户当前 registry 是 npmmirror 时，retry 切到 npmjs', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		const captured = { updates: [] };
		const execFileFn = (cmd, args, opts, cb) => {
			const argsStr = args.join(' ');

			if (argsStr.includes('config get registry')) {
				return cb(null, 'https://registry.npmmirror.com/\n', '');
			}

			if (argsStr.includes('plugins update')) {
				captured.updates.push({ env: opts?.env });
				if (captured.updates.length === 1) return cb(new Error('first boom'));
				return cb(null, 'ok', '');
			}

			if (argsStr.includes('gateway status')) return cb(null, 'running', '');
			if (argsStr.includes('plugins list')) return cb(null, 'test-plugin', '');
			if (argsStr.includes('coclaw.upgradeHealth')) {
				return cb(null, JSON.stringify({ version: '1.1.0' }), '');
			}
			return cb(null, '', '');
		};

		const { logger } = createLogger();

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(execFileFn),
			logger,
		});

		assert.equal(captured.updates.length, 2);
		assert.equal(captured.updates[1].env.npm_config_registry, 'https://registry.npmjs.org/');
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

// ============================================================
// 13. registry fallback：两次都失败时走 rollback，且日志含两次失败提示
// ============================================================

test('runUpgrade — 两次 update 都失败时走 rollback 且日志含 retry 失败提示', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		const { execFileFn } = createMockExec({
			updateFails: true,
			gatewayRunning: true,
		});
		const { logs, logger } = createLogger();

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(execFileFn),
			logger,
		});

		// 两次失败的日志都应出现
		assert.ok(logs.some(l => l.includes('Update command failed')));
		assert.ok(logs.some(l => l.includes('Retrying with fallback registry')));
		assert.ok(logs.some(l => l.includes('Retry with fallback registry failed')));

		// 仍按瞬态处理：rollback + 不 skip
		const state = await readState();
		assert.equal(state.lastUpgrade.result, 'rollback');
		assert.equal(state.skippedVersions, undefined);
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

// ============================================================
// 14. 第一次 update 成功时不调 npm config，不构造 retry env
// ============================================================

test('runUpgrade — 第一次 update 成功时不读取 npm registry、不重试', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		const captured = { updates: [], registryQueried: false };
		const execFileFn = (cmd, args, opts, cb) => {
			const argsStr = args.join(' ');

			if (argsStr.includes('config get registry')) {
				captured.registryQueried = true;
				return cb(null, 'https://registry.npmjs.org/\n', '');
			}

			if (argsStr.includes('plugins update')) {
				captured.updates.push({ env: opts?.env });
				return cb(null, 'ok', '');
			}

			if (argsStr.includes('gateway status')) return cb(null, 'running', '');
			if (argsStr.includes('plugins list')) return cb(null, 'test-plugin', '');
			if (argsStr.includes('coclaw.upgradeHealth')) {
				return cb(null, JSON.stringify({ version: '1.1.0' }), '');
			}
			return cb(null, '', '');
		};

		const { logger } = createLogger();

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(execFileFn),
			logger,
		});

		assert.equal(captured.updates.length, 1);
		assert.equal(captured.updates[0].env, undefined, '首次 update 不传 env，让 Node 默认继承 process.env');
		assert.equal(captured.registryQueried, false, '不应读取当前 npm registry');
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

// ============================================================
// 15. registry fallback：retry 时移除用户 NPM_CONFIG_REGISTRY 大写覆盖
// ============================================================

test('runUpgrade — retry 时清除用户 NPM_CONFIG_REGISTRY 大写 env，确保小写 fallback 生效', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;
	// 模拟用户 export 了大写 NPM_CONFIG_REGISTRY，且原值就是慢/卡住的源
	process.env.NPM_CONFIG_REGISTRY = 'https://stuck.example.com/';

	try {
		const captured = { updates: [] };
		const execFileFn = (cmd, args, opts, cb) => {
			const argsStr = args.join(' ');

			if (argsStr.includes('config get registry')) {
				return cb(null, 'https://registry.npmjs.org/\n', '');
			}

			if (argsStr.includes('plugins update')) {
				captured.updates.push({ env: opts?.env });
				if (captured.updates.length === 1) return cb(new Error('first boom'));
				return cb(null, 'ok', '');
			}

			if (argsStr.includes('gateway status')) return cb(null, 'running', '');
			if (argsStr.includes('plugins list')) return cb(null, 'test-plugin', '');
			if (argsStr.includes('coclaw.upgradeHealth')) {
				return cb(null, JSON.stringify({ version: '1.1.0' }), '');
			}
			return cb(null, '', '');
		};

		const { logger } = createLogger();

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(execFileFn),
			logger,
		});

		assert.equal(captured.updates.length, 2);
		// 关键断言：retry env 中大写已被 delete，小写注入正确 fallback
		assert.equal(
			captured.updates[1].env.NPM_CONFIG_REGISTRY,
			undefined,
			'retry 必须 delete 用户大写 NPM_CONFIG_REGISTRY 以避免覆盖小写',
		);
		assert.equal(
			captured.updates[1].env.npm_config_registry,
			'https://registry.npmmirror.com/',
		);
	} finally {
		delete process.env.NPM_CONFIG_REGISTRY;
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

// ============================================================
// 16. L2 结局矩阵（exit 0 后按 inspect 记录分流）
// ============================================================

test('L2 — exit 0 + record 达标（版本相等，等号防"严格大于"回归）→ 真升级现行流', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		const { execFileFn, calls } = createMockExec({ inspectVersion: '1.1.0', healthVersion: '1.1.0' });
		const { logs, logger } = createLogger();

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			baselineVersion: '1.0.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(execFileFn),
			logger,
		});

		// 达标走现行流：restart + 健康轮询 + 成功收尾
		assert.ok(calls.some(c => c.args.join(' ').includes('plugins inspect')));
		assert.ok(calls.some(c => c.args.join(' ').includes('gateway restart')));
		assert.ok(logs.some(l => l.includes('Install record reached target: 1.1.0')));

		const state = await readState();
		assert.equal(state.lastUpgrade.result, 'ok');
		assert.equal(state.lastUpgrade.to, '1.1.0');
		// 真升级不记 skippedVersions
		assert.equal(state.skippedVersions, undefined);
		await assert.rejects(fs.access(backupDirOf(stateDir)), '备份应已清理');
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

test('L2 — exit 0 + record 未推进 → no-op：不重启不回滚、删 .bak、立即 skipVersion、noop-skip', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		// update exit 0 但权威记录仍是基线版本（干净 skip / registry 假成功）
		const { execFileFn, calls } = createMockExec({ inspectVersion: '1.0.0' });
		const { logs, logger } = createLogger();

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			baselineVersion: '1.0.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(execFileFn),
			logger,
		});

		// 不重启、不进健康轮询；不回滚由下方 lastUpgrade.result=noop-skip（非 rollback）锚定
		//（plugins uninstall 只出现在 update 失败的 registry 兜底，对 exit-0 路径负断言恒真，无保护力）
		assert.ok(!calls.some(c => c.args.join(' ').includes('gateway restart')), 'no-op 不得触发 restart');
		assert.ok(!calls.some(c => c.args.join(' ').includes('coclaw.upgradeHealth')), 'no-op 不得进健康轮询');

		// 删备份；插件目录原封不动
		await assert.rejects(fs.access(backupDirOf(stateDir)), '备份应已删除');
		const pkg = JSON.parse(await fs.readFile(nodePath.join(pluginDir, 'package.json'), 'utf8'));
		assert.equal(pkg.version, '1.0.0');

		// 立即 skipVersion + lastUpgrade noop-skip token（接 scheduler 上报链）
		const state = await readState();
		assert.ok(state.skippedVersions.includes('1.1.0'));
		assert.equal(state.lastUpgrade.result, 'noop-skip');
		assert.equal(state.lastUpgrade.from, '1.0.0');
		assert.equal(state.lastUpgrade.to, '1.1.0');

		// 本地 jsonl 也落一条
		const logPath = nodePath.join(stateDir, 'coclaw', 'upgrade-log.jsonl');
		const entry = JSON.parse((await fs.readFile(logPath, 'utf8')).trim());
		assert.equal(entry.result, 'noop-skip');

		assert.ok(logs.some(l => l.includes('did not advance')));
		assert.ok(logs.some(l => l.includes('No-op skip complete')));
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

test('L2 — no-op 分支删 .bak 失败时不阻断 skipVersion 与状态记录', async (t) => {
	if (process.getuid?.() === 0) { t.skip('chmod-based error injection bypassed by root (CAP_DAC_OVERRIDE)'); return; }
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;
	const bakDir = backupDirOf(stateDir);

	try {
		const { execFileFn } = createMockExec({ inspectVersion: '1.0.0' });
		// 在 no-op 删备份之前（inspect 时点）把备份目录改为只读，使 removeBackup 抛错
		const wrappedExecFn = (cmd, args, opts, cb) => {
			const argsStr = args.join(' ');
			if (argsStr.includes('plugins inspect')) {
				const protectedDir = nodePath.join(bakDir, 'protected');
				fs.mkdir(protectedDir, { recursive: true })
					.then(() => fs.chmod(bakDir, 0o444))
					.then(() => execFileFn(cmd, args, opts, cb))
					.catch(() => execFileFn(cmd, args, opts, cb));
				return;
			}
			execFileFn(cmd, args, opts, cb);
		};
		const { logs, logger } = createLogger();

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			baselineVersion: '1.0.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(wrappedExecFn),
			logger,
		});

		// 恢复权限以便清理
		try { await fs.chmod(bakDir, 0o755); } catch {}

		assert.ok(logs.some(l => l.includes('Backup cleanup failed')));
		// 清理失败不阻断：skipVersion 与 noop-skip 记录仍须落盘
		const state = await readState();
		assert.ok(state.skippedVersions.includes('1.1.0'));
		assert.equal(state.lastUpgrade.result, 'noop-skip');
		assert.ok(logs.some(l => l.includes('No-op skip complete')));
	} finally {
		try { await fs.chmod(bakDir, 0o755); } catch {}
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

test('L2 — exit 0 + record 推进未达标 + 实装版本健康 → ok 并 skip toVersion', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		// latest-compatible 封顶：目标 1.1.0，实际只装上 1.0.5；健康轮询按实装版本验证
		const { execFileFn, calls } = createMockExec({ inspectVersion: '1.0.5', healthVersion: '1.0.5' });
		const { logs, logger } = createLogger();

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			baselineVersion: '1.0.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(execFileFn),
			logger,
		});

		// 磁盘已换代：必须 restart + 按实装版本健康验证（不能放任未经验证的副本下次静默激活）
		assert.ok(calls.some(c => c.args.join(' ').includes('gateway restart')));
		assert.ok(logs.some(l => l.includes('advanced to 1.0.5')));

		const state = await readState();
		// 实装版本健康 → ok（记录真实装上的版本）；toVersion 已知到不了 → 记跳过停止空转
		assert.equal(state.lastUpgrade.result, 'ok');
		assert.equal(state.lastUpgrade.to, '1.0.5');
		assert.ok(state.skippedVersions.includes('1.1.0'));
		await assert.rejects(fs.access(backupDirOf(stateDir)), '备份应已清理');
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

test('L2 — exit 0 + record 推进未达标 + 实装版本验证失败 → 现行回滚', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		// 记录推进到 1.0.5 但健康轮询一直报老版本 → 验证超时 → 现行回滚（skipVersion=true）
		const { execFileFn } = createMockExec({ inspectVersion: '1.0.5', healthVersion: '1.0.0' });
		const { logs, logger } = createLogger();

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			baselineVersion: '1.0.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(execFileFn),
			logger,
		});

		assert.ok(logs.some(l => l.includes('Verification failed')));
		assert.ok(logs.some(l => l.includes('Rollback complete')));

		const state = await readState();
		assert.equal(state.lastUpgrade.result, 'rollback');
		assert.ok(state.skippedVersions.includes('1.1.0'));
		// 插件目录被恢复
		const pkg = JSON.parse(await fs.readFile(nodePath.join(pluginDir, 'package.json'), 'utf8'));
		assert.equal(pkg.version, '1.0.0');
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

test('L2 — exit 0 + 基线不可得 + record 未达标 → 退化现行流（restart + verify(toVersion)）', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		// 不传 baselineVersion：无从判断 record 是否推进，按现行流验证 toVersion
		const { execFileFn, calls } = createMockExec({ inspectVersion: '1.0.0', healthVersion: '1.0.0' });
		const { logs, logger } = createLogger();

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(execFileFn),
			logger,
		});

		assert.ok(logs.some(l => l.includes('baseline unknown')));
		// 退化现行流：restart + verify(toVersion) → 超时 → 回滚（而非 no-op）
		assert.ok(calls.some(c => c.args.join(' ').includes('gateway restart')));
		const state = await readState();
		assert.equal(state.lastUpgrade.result, 'rollback');
		assert.ok(state.skippedVersions.includes('1.1.0'));
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

test('L2 — exit 0 + inspect 自身失败 → 保守按真升级走现行流', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		const { execFileFn, calls } = createMockExec({ inspectFails: true, healthVersion: '1.1.0' });
		const { logs, logger } = createLogger();

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			baselineVersion: '1.0.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(execFileFn),
			logger,
		});

		// 保守现行流：工具故障不得静默压制激活
		assert.ok(logs.some(l => l.includes('proceeding with standard verify')));
		assert.ok(calls.some(c => c.args.join(' ').includes('gateway restart')));

		const state = await readState();
		assert.equal(state.lastUpgrade.result, 'ok');
		assert.equal(state.skippedVersions, undefined);
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

test('L2 — exit 0 + inspect 调用抛错 → 不 fatal，保守按真升级走现行流', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		// 注入的 execFileFn 在 inspect 调用上同步抛错（违反"永不抛"契约的注入实现）：
		// 不得 fatal exit，应归一化为 inspect 自身失败，走保守 verify(toVersion)
		const { execFileFn, calls } = createMockExec({ healthVersion: '1.1.0' });
		const wrappedExecFn = (cmd, args, opts, cb) => {
			if (args.join(' ').includes('plugins inspect')) {
				throw new Error('inspect sync boom');
			}
			return execFileFn(cmd, args, opts, cb);
		};
		const { logs, logger } = createLogger();

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			baselineVersion: '1.0.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(wrappedExecFn),
			logger,
		});

		// 抛错被归一化进保守现行流，且错误信息进本地日志
		assert.ok(logs.some(l => l.includes('inspect threw: inspect sync boom')));
		assert.ok(logs.some(l => l.includes('proceeding with standard verify')));
		assert.ok(calls.some(c => c.args.join(' ').includes('gateway restart')));

		const state = await readState();
		assert.equal(state.lastUpgrade.result, 'ok');
		assert.equal(state.skippedVersions, undefined);
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

test('L2 — exit 0 + inspect 正常但无 install 记录 → 保守按真升级走现行流', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		const { execFileFn, calls } = createMockExec({ inspectNoRecord: true, healthVersion: '1.1.0' });
		const { logs, logger } = createLogger();

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			baselineVersion: '1.0.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(execFileFn),
			logger,
		});

		assert.ok(logs.some(l => l.includes('install record missing version')));
		assert.ok(calls.some(c => c.args.join(' ').includes('gateway restart')));

		const state = await readState();
		assert.equal(state.lastUpgrade.result, 'ok');
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});


// ============================================================
// 17. 缺陷 6 方案 A：update 用裸 npm 包名（解钉 spec）
// ============================================================

test('runUpgrade — plugins update 用裸包名而非插件 id（裸包名 update 顺带解钉 spec）', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		const { execFileFn, calls } = createMockExec({ healthVersion: '1.1.0' });
		const { logger } = createLogger();

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(execFileFn),
			logger,
		});

		const updateCall = calls.find(c => c.args.join(' ').includes('plugins update'));
		assert.ok(updateCall);
		assert.deepEqual(updateCall.args, ['plugins', 'update', '@test/pkg']);
		assert.ok(!updateCall.args.includes('test-plugin'), '不得用插件 id 调 update');
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

// ============================================================
// 18. inflight 生命周期：update 前写入、verify 前推进、终态清除
// ============================================================

test('runUpgrade — inflight 在 update 前写入（phase=update）、verify 前推进、成功终态清除', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		// latest-compatible 封顶场景顺带钉死 verifyTarget 同步：目标 1.1.0 实装 1.0.5
		const { execFileFn } = createMockExec({ inspectVersion: '1.0.5', healthVersion: '1.0.5' });
		const observed = {};
		const wrappedExecFn = (cmd, args, opts, cb) => {
			const argsStr = args.join(' ');
			if (argsStr.includes('plugins update') && !observed.atUpdate) {
				// update 时点：inflight 应已写入且 phase=update
				readState()
					.then((s) => { observed.atUpdate = s.inflight; })
					.then(() => execFileFn(cmd, args, opts, cb));
				return;
			}
			if (argsStr.includes('coclaw.upgradeHealth') && !observed.atVerify) {
				// 健康轮询时点：phase 应已推进到 verify，verifyTarget 同步为实装版本
				readState()
					.then((s) => { observed.atVerify = s.inflight; })
					.then(() => execFileFn(cmd, args, opts, cb));
				return;
			}
			execFileFn(cmd, args, opts, cb);
		};
		const { logger } = createLogger();

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			baselineVersion: '1.0.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(wrappedExecFn),
			logger,
		});

		// update 时点
		assert.ok(observed.atUpdate, 'update 前应已写 inflight');
		assert.equal(observed.atUpdate.phase, 'update');
		assert.equal(observed.atUpdate.from, '1.0.0');
		assert.equal(observed.atUpdate.to, '1.1.0');
		assert.equal(observed.atUpdate.verifyTarget, '1.1.0');
		assert.equal(observed.atUpdate.pluginDir, pluginDir);
		assert.ok(observed.atUpdate.ts);

		// verify 时点
		assert.ok(observed.atVerify, 'verify 期应有 inflight');
		assert.equal(observed.atVerify.phase, 'verify');
		assert.equal(observed.atVerify.verifyTarget, '1.0.5', 'advancedShortfall 须同步 verifyTarget');

		// 终态：inflight 清除 + ok 落账
		const state = await readState();
		assert.equal(state.inflight, undefined);
		assert.equal(state.lastUpgrade.result, 'ok');
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

test('runUpgrade — 回滚路径 inflight phase 推进到 rollback 后由终态清除', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		// 验证失败 → 回滚；回滚期 restart 时点（记账已前移到其前）inflight 应已清
		const { execFileFn } = createMockExec({ healthVersion: '1.0.0' });
		const observed = { restarts: [] };
		const wrappedExecFn = (cmd, args, opts, cb) => {
			if (args.join(' ').includes('gateway restart')) {
				readState()
					.then((s) => { observed.restarts.push(s); })
					.then(() => execFileFn(cmd, args, opts, cb));
				return;
			}
			execFileFn(cmd, args, opts, cb);
		};
		const { logger } = createLogger();

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(wrappedExecFn),
			logger,
		});

		// 两次 restart：verify 期 inflight 在（phase=verify）；
		// 回滚期记账已前移完成、inflight 已清、终态已落
		assert.equal(observed.restarts.length, 2);
		assert.equal(observed.restarts[0].inflight?.phase, 'verify', 'verify 期 restart 时 inflight 应在');
		assert.equal(observed.restarts[1].inflight, undefined, '回滚期 restart 时 inflight 应已清');
		assert.equal(observed.restarts[1].lastUpgrade?.result, 'rollback', '回滚记账须先于 restart');

		const state = await readState();
		assert.equal(state.inflight, undefined, '终态后 inflight 应清除');
		assert.equal(state.lastUpgrade.result, 'rollback');
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

// ============================================================
// 19. 错因富化：子命令双流尾部进账 + 脱敏
// ============================================================

test('runUpgrade — update 失败时子命令 stdout/stderr 真因进 lastUpgrade 与 jsonl', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		// 上游错误 outcome 走 stdout（console.log），execFile err.message 只附 stderr——
		// 必须双流都收，否则真因（如 prerelease 拒装）丢失
		const execFileFn = (cmd, args, opts, cb) => {
			const argsStr = args.join(' ');
			if (argsStr.includes('plugins update')) {
				return cb(new Error('Command failed'), 'refusing to install prerelease 2.0.0-rc.1', 'some stderr detail');
			}
			if (argsStr.includes('config get registry')) {
				return cb(null, 'https://registry.npmjs.org/\n', '');
			}
			return cb(null, '', '');
		};
		const { logs, logger } = createLogger();

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '2.0.0-rc.1',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(execFileFn),
			logger,
		});

		// worker 本地日志含真因
		assert.ok(logs.some(l => l.includes('refusing to install prerelease')));

		// lastUpgrade 与 jsonl 都带真因（stdout 与 stderr 两路）
		const state = await readState();
		assert.equal(state.lastUpgrade.result, 'rollback');
		assert.ok(state.lastUpgrade.error.includes('refusing to install prerelease'));
		assert.ok(state.lastUpgrade.error.includes('some stderr detail'));

		const logPath = nodePath.join(stateDir, 'coclaw', 'upgrade-log.jsonl');
		const entry = JSON.parse((await fs.readFile(logPath, 'utf8')).trim());
		assert.ok(entry.error.includes('stdout: refusing to install prerelease 2.0.0-rc.1'));
		assert.ok(entry.error.includes('stderr: some stderr detail'));
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

// --- formatCmdFailure 单元 ---

test('formatCmdFailure — 拼接 prefix + message + 双流', () => {
	const msg = formatCmdFailure('plugins update failed', new Error('exit 1'), 'out text', 'err text');
	assert.equal(msg, 'plugins update failed: exit 1 | stdout: out text | stderr: err text');
});

test('formatCmdFailure — 空流省略对应段', () => {
	const msg = formatCmdFailure('x failed', new Error('boom'), '', undefined);
	assert.equal(msg, 'x failed: boom');
});

test('formatCmdFailure — 双流各取尾部 ≤500 字符（真因在尾部）', () => {
	const longOut = `${'a'.repeat(600)}REAL-CAUSE`;
	const msg = formatCmdFailure('x failed', new Error('boom'), longOut, '');
	const stdoutPart = msg.split('stdout: ')[1];
	assert.equal(stdoutPart.length, 500);
	assert.ok(stdoutPart.endsWith('REAL-CAUSE'));
});

test('formatCmdFailure — stderr 侧独立超长截断（不依赖 stdout 路径）', () => {
	const longErr = `${'b'.repeat(600)}ERR-CAUSE`;
	const msg = formatCmdFailure('x failed', new Error('boom'), '', longErr);
	const stderrPart = msg.split('stderr: ')[1];
	assert.equal(stderrPart.length, 500);
	assert.ok(stderrPart.endsWith('ERR-CAUSE'));
});

test('formatCmdFailure — 脱敏 registry userinfo 与 _authToken', () => {
	const msg = formatCmdFailure(
		'x failed',
		new Error('fetch https://user:secret@registry.example.com/pkg failed'),
		'//registry.example.com/:_authToken=npm_abcdef123 rejected',
		'',
	);
	assert.ok(!msg.includes('secret'), 'userinfo 必须脱敏');
	assert.ok(msg.includes('://***@registry.example.com'));
	assert.ok(!msg.includes('npm_abcdef123'), '_authToken 必须脱敏');
	assert.ok(msg.includes('_authToken=***'));
});

test('formatCmdFailure — 先脱敏再截尾（截断撕裂凭据时不留裸密码）', () => {
	// 判别构造：凭据 URL 开头放在 500 字尾部边界之前——
	// 错误实现（先截尾再脱敏）：截掉 "https://user:"，残留 "topsecret@host/" 无 "://"
	// 可锚，正则漏匹配，裸密码进输出；
	// 正确实现（先脱敏再截尾）：脱敏先把 userinfo 换成 ***，截尾只切掉无害前缀。
	const url = 'https://user:topsecret@host/'; // 28 字符，"user:" 止于第 13 字符
	const out = `${url}${'y'.repeat(485)}`; // 总长 513：尾部 500 恰从 "topsecret" 起切
	const msg = formatCmdFailure('x failed', new Error('boom'), out, '');
	assert.ok(!msg.includes('topsecret'), '截断撕裂凭据 URL 时不得留下裸密码');
	assert.ok(msg.includes('://***@host'), '脱敏后的掩码应保留在输出中');
});

// ============================================================
// 20. 记账防护：state 写入全挂也非致命
// ============================================================

test('runUpgrade — state 文件不可写时成功路径仍完成（记账非致命）', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		// 在 state 文件路径预置目录：所有 state 读写报 EISDIR（备份目录不受影响）
		await fs.mkdir(nodePath.join(stateDir, 'coclaw', 'upgrade-state.json'), { recursive: true });

		const { execFileFn } = createMockExec({ healthVersion: '1.1.0' });
		const { logs, logger } = createLogger();

		// 未抛即为通过：升级确实成功，记账失败不该让 worker 报 fatal
		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(execFileFn),
			logger,
		});

		assert.ok(logs.some(l => l.includes('Failed to write inflight marker (non-fatal)')));
		assert.ok(logs.some(l => l.includes('Failed to update inflight marker (non-fatal)')));
		assert.ok(logs.some(l => l.includes('Failed to record terminal state (non-fatal)')));
		assert.ok(logs.some(l => l.includes('Upgrade complete')));
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

test('runUpgrade — state 文件不可写时回滚路径仍完成且触发 restart', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		await fs.mkdir(nodePath.join(stateDir, 'coclaw', 'upgrade-state.json'), { recursive: true });

		const { execFileFn, calls } = createMockExec({ updateFails: true });
		const { logs, logger } = createLogger();

		await runUpgrade({
			pluginDir,
			fromVersion: '1.0.0',
			toVersion: '1.1.0',
			pluginId: 'test-plugin',
			pkgName: '@test/pkg',
			opts: fastOpts(execFileFn),
			logger,
		});

		assert.ok(logs.some(l => l.includes('Failed to record terminal state (non-fatal)')));
		assert.ok(logs.some(l => l.includes('Rollback complete')));
		// 记账失败不阻断后续 restart
		assert.ok(calls.some(c => c.args.join(' ').includes('gateway restart')));
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});
