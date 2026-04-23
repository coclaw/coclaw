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
// 1a.1 dist-tag 前移窗口：装上的版本比 toVersion 更新时，state 记录真实版本
// ============================================================

test('runUpgrade — 装上的版本比 toVersion 更新时，state/log 记录真实装上版本', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		// scheduler 观察到 latest=1.1.0 并发起升级，worker 执行 plugins update 时
		// npm dist-tag 已前移到 1.1.1，upgradeHealth 返回 1.1.1；应视为成功并记录 1.1.1
		const { execFileFn } = createMockExec({ healthVersion: '1.1.1' });
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

		// state 的 to 必须是真实装上的版本 1.1.1，不是参数 toVersion=1.1.0
		const state = await readState();
		assert.equal(state.lastUpgrade.to, '1.1.1');
		assert.equal(state.lastUpgrade.result, 'ok');

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
		// 通过 wrappedExecFn 在 verify 阶段的 gateway restart 首次调用时设置只读
		let restartCalls = 0;
		const wrappedExecFn = (cmd, args, opts, cb) => {
			const argsStr = args.join(' ');
			if (argsStr.includes('gateway restart')) {
				restartCalls++;
				if (restartCalls === 1) {
					// 第一次 gateway restart（verify 阶段的 triggerGatewayRestart）时，
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

		// 冻结新行为：失败后必须有 fallback retry（而不是立刻 rollback），
		// 防止未来重构把 mirror 兜底逻辑去掉而测试静默通过
		const updateCount = calls.filter(c => c.args.join(' ').includes('plugins update')).length;
		assert.equal(updateCount, 2, '失败后应触发一次 fallback retry，共调用两次 plugins update');
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

test('runUpgrade — 回滚路径中 gateway restart 命令失败也不抛', async () => {
	const { base, pluginDir, stateDir } = await createTmpEnv();
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	process.env.OPENCLAW_STATE_DIR = stateDir;

	try {
		const { execFileFn } = createMockExec({ updateFails: true });
		// 包一层使 gateway restart 命令失败
		const wrappedExecFn = (cmd, args, opts, cb) => {
			if (args.join(' ').includes('gateway restart')) {
				return cb(new Error('restart boom'));
			}
			return execFileFn(cmd, args, opts, cb);
		};
		const { logger } = createLogger();

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

