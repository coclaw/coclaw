/**
 * worker.js — 由 updater-spawn 以 detached 进程启动
 *
 * 用法：node worker.js --pluginDir <dir> --fromVersion <ver> --toVersion <ver>
 *                       --pluginId <id> --pkgName <name>
 *
 * 流程：备份 → openclaw plugins update → 等待 gateway 重启 → 验证 → 成功清理/失败回滚
 *
 * 注意：
 * - 本模块作为独立 node 进程运行，与 gateway 进程隔离
 * - state dir 通过 OPENCLAW_STATE_DIR 环境变量由 spawner 传入
 * - shell 仅在 Windows 启用（openclaw 全局安装生成 .cmd 包装器，需 shell 解析）
 */

import { execFile as nodeExecFile } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createBackup, restoreFromBackup, removeBackup } from './worker-backup.js';
import { verifyUpgrade, waitForGateway } from './worker-verify.js';
import { addSkippedVersion, updateLastUpgrade, appendLog } from './state.js';

const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.-]+)?$/;

/**
 * 执行 openclaw plugins update
 * @param {string} pluginId - 插件 ID
 * @param {object} [opts]
 * @param {Function} [opts.execFileFn]
 * @returns {Promise<void>}
 */
// openclaw plugins update 内部实现为 staged backup-and-replace，
// 仅支持 source === "npm" 的安装（updater 已做前置过滤）
function runPluginUpdate(pluginId, opts) {
	/* c8 ignore next -- ?./?? fallback */
	const doExecFile = opts?.execFileFn ?? nodeExecFile;
	return new Promise((resolve, reject) => {
		doExecFile('openclaw', ['plugins', 'update', pluginId], {
			timeout: 120_000,
			shell: process.platform === 'win32',
		}, (err) => {
			if (err) reject(new Error(`plugins update failed: ${err.message}`));
			else resolve();
		});
	});
}

/**
 * 尝试通过 npm 安装旧版本进行兜底回滚
 *
 * openclaw plugins install 不支持覆盖已安装插件，因此需先 uninstall。
 * uninstall 失败不阻断流程（插件可能已处于异常状态）。
 *
 * @param {string} pkgName - npm 包名
 * @param {string} version
 * @param {string} pluginId - 插件 ID
 * @param {object} [opts]
 * @param {Function} [opts.execFileFn]
 * @returns {Promise<void>}
 */
// 回滚兜底：当物理备份恢复失败时，尝试从 npm 重新安装旧版本
async function fallbackInstallOldVersion(pkgName, version, pluginId, opts) {
	// version 来自 package.json，正常不会有异常值，但 shell: true 下做防御校验
	if (!SEMVER_RE.test(version)) {
		throw new Error(`invalid version format: ${version}`);
	}
	/* c8 ignore next -- ?./?? fallback */
	const doExecFile = opts?.execFileFn ?? nodeExecFile;
	const run = (args, timeout = 120_000) => new Promise((resolve, reject) => {
		doExecFile('openclaw', args, { timeout, shell: process.platform === 'win32' }, (err) => {
			if (err) reject(err);
			else resolve();
		});
	});

	// 先卸载：install 不支持覆盖已安装插件
	try {
		await run(['plugins', 'uninstall', pluginId], 60_000);
	} catch {
		// uninstall 失败不阻断，继续尝试 install
	}

	try {
		await run(['plugins', 'install', `${pkgName}@${version}`]);
	} catch (err) {
		throw new Error(`fallback install failed: ${err.message}`);
	}
}

/**
 * 执行升级流程
 * @param {object} params
 * @param {string} params.pluginDir - 插件安装目录
 * @param {string} params.fromVersion - 当前版本
 * @param {string} params.toVersion - 目标版本
 * @param {string} params.pluginId - 插件 ID
 * @param {string} params.pkgName - npm 包名
 * @param {object} [params.opts] - 测试注入选项
 * @param {Function} [params.opts.execFileFn]
 * @param {number} [params.opts.timeoutMs]
 * @param {number} [params.opts.pollIntervalMs]
 * @param {Function} [params.logger] - 日志函数
 */
export async function runUpgrade({ pluginDir, fromVersion, toVersion, pluginId, pkgName, opts, logger }) {
	const log = logger ?? console.log;

	log(`[upgrade-worker] Starting upgrade: ${fromVersion} → ${toVersion}`);
	log(`[upgrade-worker] Plugin dir: ${pluginDir}`);

	// 1. 备份
	log('[upgrade-worker] Creating backup...');
	await createBackup(pluginDir);
	log('[upgrade-worker] Backup created');

	// 2. 执行升级
	log('[upgrade-worker] Running plugins update...');
	try {
		await runPluginUpdate(pluginId, opts);
	}
	catch (updateErr) {
		// 升级命令本身失败（可能是瞬态故障），恢复备份但不标记版本为 skipped
		log(`[upgrade-worker] Update command failed: ${updateErr.message}`);
		await handleRollback({
			pluginDir, fromVersion, toVersion, pluginId, pkgName,
			error: updateErr.message, skipVersion: false, opts, log,
		});
		return;
	}
	log('[upgrade-worker] Update command completed');

	// 3. 等待 gateway 重启并验证
	log('[upgrade-worker] Verifying upgrade...');
	const result = await verifyUpgrade(pluginId, opts);

	if (result.ok) {
		// 4a. 成功
		log(`[upgrade-worker] Upgrade verified. Version: ${result.version}`);
		try {
			await removeBackup(pluginDir);
		}
		catch (e) {
			log(`[upgrade-worker] Backup cleanup failed (non-fatal): ${e.message}`);
		}
		await updateLastUpgrade({ from: fromVersion, to: toVersion, result: 'ok' });
		await appendLog({ from: fromVersion, to: toVersion, result: 'ok' });
		log('[upgrade-worker] Upgrade complete');
	} else {
		// 4b. 失败，回滚
		log(`[upgrade-worker] Verification failed: ${result.error}`);
		await handleRollback({
			pluginDir, fromVersion, toVersion, pluginId, pkgName,
			error: result.error, skipVersion: true, opts, log,
		});
	}
}

/**
 * 回滚处理
 */
async function handleRollback({ pluginDir, fromVersion, toVersion, pluginId, pkgName, error, skipVersion, opts, log }) {
	log('[upgrade-worker] Attempting rollback...');

	// 首选 mv 备份目录
	let restored = false;
	try {
		restored = await restoreFromBackup(pluginDir);
	} catch (restoreErr) {
		log(`[upgrade-worker] Backup restore error: ${restoreErr.message}`);
	}

	if (restored) {
		log('[upgrade-worker] Restored from backup');
	} else {
		// 兜底：先卸载再从 npm 安装旧版本
		log('[upgrade-worker] Backup restore failed, falling back to npm install');
		try {
			await fallbackInstallOldVersion(pkgName, fromVersion, pluginId, opts);
			log('[upgrade-worker] Fallback install completed');
		}
		catch (fallbackErr) {
			log(`[upgrade-worker] Fallback install also failed: ${fallbackErr.message}`);
		}
	}

	// 等待 gateway 重启
	log('[upgrade-worker] Waiting for gateway to restart after rollback...');
	try {
		await waitForGateway(opts);
		log('[upgrade-worker] Gateway restarted after rollback');
	}
	catch {
		log('[upgrade-worker] Gateway did not restart after rollback');
	}

	// 记录状态（顺序执行因共享 state 文件，但各自 try/catch 避免单个失败阻断其余）
	// 仅验证失败（新版本确实被加载并发现有问题）才标记为 skipped；
	// update 命令失败可能是瞬态故障（网络、磁盘等），不应永久跳过该版本
	if (skipVersion) {
		try { await addSkippedVersion(toVersion); }
		/* c8 ignore next -- 状态写入 catch：测试中 stub 不会失败 */
		catch (e) { log(`[upgrade-worker] Failed to record skipped version (non-fatal): ${e.message}`); }
	}
	try { await updateLastUpgrade({ from: fromVersion, to: toVersion, result: 'rollback' }); }
	/* c8 ignore next -- 状态写入 catch */
	catch (e) { log(`[upgrade-worker] Failed to update lastUpgrade (non-fatal): ${e.message}`); }
	try { await appendLog({ from: fromVersion, to: toVersion, result: 'rollback', error }); }
	/* c8 ignore next -- 状态写入 catch */
	catch (e) { log(`[upgrade-worker] Failed to append log (non-fatal): ${e.message}`); }
	if (skipVersion) {
		log(`[upgrade-worker] Rollback complete. Version ${toVersion} added to skipped list`);
	} else {
		log(`[upgrade-worker] Rollback complete. Version ${toVersion} not skipped (transient failure)`);
	}
}

// 作为独立进程执行时的入口
/* c8 ignore start */
async function main() {
	const { values } = parseArgs({
		options: {
			pluginDir: { type: 'string' },
			fromVersion: { type: 'string' },
			toVersion: { type: 'string' },
			pluginId: { type: 'string' },
			pkgName: { type: 'string' },
		},
		strict: true,
	});

	const { pluginDir, fromVersion, toVersion, pluginId, pkgName } = values;
	if (!pluginDir || !fromVersion || !toVersion || !pluginId || !pkgName) {
		console.error('Usage: node worker.js --pluginDir <dir> --fromVersion <ver> --toVersion <ver> --pluginId <id> --pkgName <name>');
		process.exit(1);
	}

	try {
		await runUpgrade({ pluginDir, fromVersion, toVersion, pluginId, pkgName });
		process.exit(0);
	}
	catch (err) {
		console.error(`[upgrade-worker] Fatal error: ${err.message}`);
		process.exit(1);
	}
}

// 仅在直接执行时运行 main
import { fileURLToPath } from 'node:url';
import nodePath from 'node:path';
if (process.argv[1] && nodePath.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((err) => {
		console.error(`[upgrade-worker] Fatal: ${err.message}`);
		process.exit(1);
	});
}
/* c8 ignore stop */
