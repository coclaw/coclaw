import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';

import { setRuntime } from '../runtime.js';
import { readState } from './state.js';
import { runUpgrade } from './worker.js';

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

/**
 * 创建 mock execFileFn
 * @param {object} behavior - 按命令类型控制行为
 * @param {boolean} [behavior.updateFails] - plugins update 是否失败
 * @param {boolean} [behavior.gatewayRunning] - gateway status 是否返回 running
 * @param {boolean} [behavior.pluginListed] - plugins list 是否包含插件
 * @param {string} [behavior.healthVersion] - upgradeHealth 返回的版本号
 * @param {boolean} [behavior.healthFails] - upgradeHealth 是否失败
 * @param {boolean} [behavior.fallbackInstallFails] - fallback install 是否失败
 * @param {boolean} [behavior.uninstallFails] - plugins uninstall 是否失败
 */
function createMockExec(behavior = {}) {
	const {
		updateFails = false,
		gatewayRunning = true,
		pluginListed = true,
		healthVersion = '1.1.0',
		healthFails = false,
		fallbackInstallFails = false,
		uninstallFails = false,
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

			// plugins uninstall（兜底回滚先卸载再安装）
			if (argsStr.includes('plugins uninstall')) {
				if (uninstallFails) return cb(new Error('uninstall boom'));
				return cb(null, 'ok', '');
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
		timeoutMs: 200,
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
			fs.access(`${pluginDir}.bak`),
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
// 1b. 成功升级但 removeBackup 失败（non-fatal）
// ============================================================

test('runUpgrade — 成功升级但备份清理失败时仍正常完成', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		const { execFileFn } = createMockExec({ healthVersion: '1.1.0' });
		const { logs, logger } = createLogger();

		// 在 update 命令完成后，将 .bak 替换为一个文件使 fs.rm 的 recursive 语义仍可用
		// 但更简单的方式：在 createBackup 完成后给 .bak 目录设置只读权限，
		// 或者直接 mock removeBackup。这里通过修改 .bak 为无法删除的目标来触发失败。
		// 实际上 removeBackup 使用 force: true，很难让它失败。
		// 改用 mock：在 opts 中注入一个抛异常的 removeBackup 不可行（未暴露注入口）。
		// 最直接方式：临时替换 worker-backup 模块。但那会影响其他测试。
		// 替代方案：让 pluginDir.bak 指向一个不存在的特殊路径使 rm 失败。

		// 通过在 verify 成功后但 removeBackup 执行前把 .bak 改为受保护的情况，
		// 但 fs.rm with force:true 几乎不会失败。
		// 唯一可靠的方式是利用权限：将 .bak 的父目录设为只读
		const bakDir = `${pluginDir}.bak`;

		// 让 backup 创建完成后，把父目录改为只读
		// 我们需要在 update 完成之后、removeBackup 之前执行
		// 通过 wrappedExecFn 在 gateway status 检查时（verify 阶段）设置只读
		let gatewayChecks = 0;
		const wrappedExecFn = (cmd, args, opts, cb) => {
			const argsStr = args.join(' ');
			if (argsStr.includes('gateway status')) {
				gatewayChecks++;
				if (gatewayChecks === 1) {
					// 第一次 gateway status 检查时（verify 阶段），
					// 在 .bak 下创建一个只读子目录使 rm 失败
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
		try { await fs.chmod(`${pluginDir}.bak`, 0o755); } catch {}
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

		// 备份恢复后 .bak 应消失
		await assert.rejects(fs.access(`${pluginDir}.bak`));

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
		// gateway 不运行 → verifyUpgrade 会超时返回 { ok: false }
		const { execFileFn } = createMockExec({
			updateFails: false,
			gatewayRunning: false,
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
				fs.rm(`${pluginDir}.bak`, { recursive: true, force: true })
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

		// 验证 plugins uninstall 先于 install 被调用
		const uninstallIdx = calls.findIndex(
			c => c.args.join(' ').includes('plugins uninstall'),
		);
		const installIdx = calls.findIndex(
			c => c.args.join(' ').includes('plugins install'),
		);
		assert.ok(uninstallIdx >= 0, '应调用 plugins uninstall');
		assert.ok(uninstallIdx < installIdx, 'uninstall 应先于 install');

		// 验证 plugins install 被调用（包含 pkgName@version）
		const installCall = calls[installIdx];
		assert.ok(installCall, '应调用 plugins install');
		assert.ok(
			installCall.args.some(a => a.includes('@test/pkg@1.0.0')),
			'应安装旧版本',
		);

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

test('runUpgrade — restoreFromBackup 抛异常时仍走兜底安装并记录状态', async () => {
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
// 4c. 兜底回滚时 uninstall 失败，仍继续 install
// ============================================================

test('runUpgrade — 兜底回滚时 uninstall 失败不阻断，仍完成 install', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		const { execFileFn, calls } = createMockExec({
			updateFails: true,
			uninstallFails: true,
			gatewayRunning: true,
		});
		const { logs, logger } = createLogger();

		// 删除 .bak 使 restoreFromBackup 返回 false → 走 fallback 路径
		let updateCalled = false;
		const wrappedExecFn = (cmd, args, opts, cb) => {
			const argsStr = args.join(' ');
			if (argsStr.includes('plugins update') && !updateCalled) {
				updateCalled = true;
				fs.rm(`${pluginDir}.bak`, { recursive: true, force: true })
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

		// uninstall 失败不阻断，install 仍应成功
		assert.ok(logs.some(l => l.includes('Fallback install completed')));

		// 验证 uninstall 确实被调用（且失败）
		const uninstallCall = calls.find(
			c => c.args.join(' ').includes('plugins uninstall'),
		);
		assert.ok(uninstallCall, '应调用 plugins uninstall');

		// install 也被调用
		const installCall = calls.find(
			c => c.args.join(' ').includes('plugins install'),
		);
		assert.ok(installCall, '应调用 plugins install');

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

test('runUpgrade — 兜底 install 也失败时仍记录失败', async () => {
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
				fs.rm(`${pluginDir}.bak`, { recursive: true, force: true })
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

		// state 仍应记录 rollback，但 update 命令失败不记录 skippedVersions
		const state = await readState();
		assert.equal(state.lastUpgrade.result, 'rollback');
		assert.equal(state.skippedVersions, undefined);

		// 日志文件也应记录
		const logPath = nodePath.join(stateDir, 'coclaw', 'upgrade-log.jsonl');
		const logContent = await fs.readFile(logPath, 'utf8');
		const entry = JSON.parse(logContent.trim());
		assert.equal(entry.result, 'rollback');
		assert.ok(entry.error);
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

// ============================================================
// 6. 备份恢复失败 + fromVersion 不合法 → fallbackInstallOldVersion 拒绝
// ============================================================

test('runUpgrade — 备份恢复失败且 fromVersion 不合法时，版本校验拒绝仍记录 rollback', async () => {
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
				fs.rm(`${pluginDir}.bak`, { recursive: true, force: true })
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

		// state 仍应记录 rollback，但 update 命令失败不记录 skippedVersions
		const state = await readState();
		assert.equal(state.lastUpgrade.result, 'rollback');
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
				fs.rm(`${pluginDir}.bak`, { recursive: true, force: true })
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
				fs.rm(`${pluginDir}.bak`, { recursive: true, force: true })
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
				fs.rm(`${pluginDir}.bak`, { recursive: true, force: true })
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
// 7. 验证失败且 pluginListed 为 false
// ============================================================

test('runUpgrade — 验证时插件未加载，触发回滚', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		const { execFileFn } = createMockExec({
			gatewayRunning: true,
			pluginListed: false,
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

		// 验证失败应触发回滚
		assert.ok(logs.some(l => l.includes('Verification failed')));
		const state = await readState();
		assert.equal(state.lastUpgrade.result, 'rollback');
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
// 9. 回滚后 gateway 未重启（waitForGateway 超时）
// ============================================================

test('runUpgrade — 回滚后 gateway 未重启，仍正常完成', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		// update 失败触发回滚，gateway status 也失败
		const { execFileFn } = createMockExec({
			updateFails: true,
			gatewayRunning: false,
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

		// 应记录 gateway 未重启
		assert.ok(logs.some(l => l.includes('Gateway did not restart after rollback')));

		// 但仍完成回滚流程
		const state = await readState();
		assert.equal(state.lastUpgrade.result, 'rollback');
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

// ============================================================
// 10. 回滚后 gateway 成功重启
// ============================================================

test('runUpgrade — 回滚后 gateway 成功重启', async () => {
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

		assert.ok(logs.some(l => l.includes('Gateway restarted after rollback')));
	} finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		await cleanTmpEnv(base);
	}
});

