/**
 * worker.js — 由 updater-spawn 以 detached 进程启动
 *
 * 用法：node worker.js --pluginDir <dir> --fromVersion <ver> --toVersion <ver>
 *                       --pluginId <id> --pkgName <name> [--baselineVersion <ver>]
 *
 * 流程：备份 → 写 inflight → openclaw plugins update → L2 结局核对（inspect 安装记录）
 *       → 等待 gateway 重启 → 验证 → 成功清理/失败回滚/未推进 no-op 跳过
 *       → 终态记账（recordUpgradeTerminal 原子写 lastUpgrade + 清 inflight）
 *
 * 注意：
 * - 本模块作为独立 node 进程运行，与 gateway 进程隔离
 * - state dir 通过 OPENCLAW_STATE_DIR 环境变量由 spawner 传入
 * - shell 仅在 Windows 启用（openclaw 全局安装生成 .cmd 包装器，需 shell 解析）
 * - 所有 state 写入非致命：独立 try/catch + 日志，失败继续流程（账目兜底交
 *   scheduler 的 inflight 对账）；worker 是独立子进程，禁 remoteLog
 */

import { execFile as nodeExecFile } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createBackup, restoreFromBackup, removeBackup } from './worker-backup.js';
import { verifyUpgrade, triggerGatewayRestart, isVersionReached } from './worker-verify.js';
import { inspectPluginInstall } from './updater-check.js';
import { appendLog, recordUpgradeTerminal, updateInflight, writeInflight } from './state.js';
import { getCurrentNpmRegistry, pickFallbackRegistry } from './registry-fallback.js';

const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.-]+)?$/;
// 单次 plugins update 上限：包含 npm install 大型 native deps，慢网络 + 弱机器需较长时间
const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;
// 回滚兜底重装旧版本走的是同一条 npm 下载链路，且触发前置本身是"备份已丢"的异常态，
// 此时尽量兜住比快速失败更重要，与 UPDATE_TIMEOUT_MS 对齐
const FALLBACK_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
// 子命令双流各取尾部上限：真因（prerelease 拒装等）通常在输出尾部
const CMD_OUTPUT_TAIL_CHARS = 500;

/**
 * 把子命令失败的真因拼进错误消息。
 * 上游错误 outcome 走 console.log（stdout）而 execFile err.message 只附 stderr，
 * 必须双流都收。先脱敏再截尾：截断可能把凭据切半导致正则漏匹配。
 * @param {string} prefix - 错误前缀（如 "plugins update failed"）
 * @param {Error} err - execFile 回调的 err
 * @param {string|Buffer} stdout
 * @param {string|Buffer} stderr
 * @returns {string}
 */
export function formatCmdFailure(prefix, err, stdout, stderr) {
	const scrub = (s) => String(s ?? '')
		// registry URL 的 userinfo（https://user:pass@host）
		.replace(/:\/\/[^@\s/]+@/g, '://***@')
		// .npmrc 风格 token（//host/:_authToken=xxx）
		.replace(/(_authToken\s*=\s*)\S+/gi, '$1***');
	const tail = (s) => {
		const t = s.trim();
		return t.length > CMD_OUTPUT_TAIL_CHARS ? t.slice(-CMD_OUTPUT_TAIL_CHARS) : t;
	};
	/* c8 ignore next -- ?? fallback */
	const parts = [`${prefix}: ${tail(scrub(err?.message ?? String(err)))}`];
	const out = tail(scrub(stdout));
	if (out) parts.push(`stdout: ${out}`);
	const errOut = tail(scrub(stderr));
	if (errOut) parts.push(`stderr: ${errOut}`);
	return parts.join(' | ');
}

/**
 * 执行 openclaw plugins update（裸 npm 包名）
 *
 * 仅支持 source === "npm" 的安装（updater 已做前置过滤）。
 * 用裸包名而非插件 id：裸包名 update 走包名匹配产生 specOverride，成功后把
 * 安装记录的 spec 重写为裸名——一次 update 同时"装 latest + 解钉"。否则
 * fallback install 留下的 `pkg@x.y.z` 精确 spec 会让 update 永远 resolve
 * 同一版本，自动升级被永久钉死。
 * env 由调用方决定：缺省时子进程继承当前 process.env（含用户 .npmrc 自动生效）；
 * 显式传入时用于覆盖 registry 等 npm 配置以做兜底重试。
 * @param {string} pkgName - npm 包名
 * @param {object} [opts]
 * @param {Function} [opts.execFileFn]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {Promise<void>}
 */
function runPluginUpdate(pkgName, opts) {
	/* c8 ignore next -- ?./?? fallback */
	const doExecFile = opts?.execFileFn ?? nodeExecFile;
	return new Promise((resolve, reject) => {
		const execOpts = {
			timeout: UPDATE_TIMEOUT_MS,
			shell: process.platform === 'win32',
		};
		// 不传 env 时让 Node 默认继承父进程；显式 env 才覆盖
		if (opts?.env) execOpts.env = opts.env;
		doExecFile('openclaw', ['plugins', 'update', pkgName], execOpts, (err, stdout, stderr) => {
			if (err) reject(new Error(formatCmdFailure('plugins update failed', err, stdout, stderr)));
			else resolve();
		});
	});
}

/**
 * 尝试通过 npm 安装旧版本进行兜底回滚。
 * 单命令 `plugins install <pkg>@<ver> --force`：--force 即覆盖装（上游映射
 * mode=update，绕开 "already exists" 拒绝），不再需要 uninstall 前置——
 * 旧的 uninstall 在非 TTY 下要求交互确认必失败且错误被静默吞。
 *
 * @param {string} pkgName - npm 包名
 * @param {string} version
 * @param {object} [opts]
 * @param {Function} [opts.execFileFn]
 * @returns {Promise<void>}
 */
async function fallbackInstallOldVersion(pkgName, version, opts) {
	// version 来自 package.json，正常不会有异常值，但 shell: true 下做防御校验
	if (!SEMVER_RE.test(version)) {
		throw new Error(`invalid version format: ${version}`);
	}
	/* c8 ignore next -- ?./?? fallback */
	const doExecFile = opts?.execFileFn ?? nodeExecFile;
	return new Promise((resolve, reject) => {
		doExecFile(
			'openclaw',
			['plugins', 'install', `${pkgName}@${version}`, '--force'],
			{ timeout: FALLBACK_INSTALL_TIMEOUT_MS, shell: process.platform === 'win32' },
			(err, stdout, stderr) => {
				if (err) reject(new Error(formatCmdFailure('fallback install failed', err, stdout, stderr)));
				else resolve();
			},
		);
	});
}

/**
 * 执行升级流程
 * @param {object} params
 * @param {string} params.pluginDir - 插件安装目录
 * @param {string} params.fromVersion - 当前版本
 * @param {string} params.toVersion - 目标版本
 * @param {string} [params.baselineVersion] - 升级前权威安装记录的版本（L2 基线；可缺）
 * @param {string} params.pluginId - 插件 ID
 * @param {string} params.pkgName - npm 包名
 * @param {object} [params.opts] - 测试注入选项
 * @param {Function} [params.opts.execFileFn]
 * @param {number} [params.opts.timeoutMs]
 * @param {number} [params.opts.pollIntervalMs]
 * @param {Function} [params.logger] - 日志函数
 */
export async function runUpgrade({ pluginDir, fromVersion, toVersion, baselineVersion, pluginId, pkgName, opts, logger }) {
	const log = logger ?? console.log;

	log(`[upgrade-worker] Starting upgrade: ${fromVersion} → ${toVersion}`);
	log(`[upgrade-worker] Plugin dir: ${pluginDir}`);

	// 1. 备份
	log('[upgrade-worker] Creating backup...');
	await createBackup(pluginDir, pluginId);
	log('[upgrade-worker] Backup created');

	// 进入改盘阶段前写 inflight：worker 若没活到终态记账（典型：被自己触发的
	// 网关重启杀死），scheduler 下轮锁空闲时据此对账补记终态
	try {
		await writeInflight({ from: fromVersion, to: toVersion, verifyTarget: toVersion, pluginDir, phase: 'update' });
	}
	catch (e) {
		log(`[upgrade-worker] Failed to write inflight marker (non-fatal): ${e.message}`);
	}

	// 2. 执行升级（首次按用户原 env，失败后用反向 mirror 重试一次）
	log('[upgrade-worker] Running plugins update...');
	let updateErr = null;
	try {
		await runPluginUpdate(pkgName, opts);
		log('[upgrade-worker] Update command completed');
	}
	catch (firstErr) {
		log(`[upgrade-worker] Update command failed: ${firstErr.message}`);
		updateErr = firstErr;
		try {
			const current = await getCurrentNpmRegistry(opts);
			const fallback = pickFallbackRegistry(current);
			log(`[upgrade-worker] Retrying with fallback registry: ${fallback}`);
			// npm 同时认 npm_config_X 与 NPM_CONFIG_X 两种 env 命名，
			// 若用户已 export 大写版（国内常见），仅 set 小写不足以覆盖，
			// 显式 delete 大写避免 retry 仍走原 registry。
			const retryEnv = { ...process.env };
			delete retryEnv.NPM_CONFIG_REGISTRY;
			retryEnv.npm_config_registry = fallback;
			await runPluginUpdate(pkgName, { ...opts, env: retryEnv });
			log('[upgrade-worker] Update command completed on retry');
			updateErr = null;
		}
		catch (retryErr) {
			log(`[upgrade-worker] Retry with fallback registry failed: ${retryErr.message}`);
			updateErr = retryErr;
		}
	}

	if (updateErr) {
		// 两次都失败仍按瞬态故障处理（保留原 skipVersion: false 设计意图）
		await handleRollback({
			pluginDir, fromVersion, toVersion, pluginId, pkgName,
			error: updateErr.message, skipVersion: false, opts, log,
		});
		return;
	}

	// 3. L2 结局核对：update exit 0 不代表真升级（老 host 出错也 exit 0、path/缺记录干净
	// skip 也 exit 0、registry 假成功、latest-compatible 封顶）。经权威 inspect 读升级后
	// 安装记录分流结局；stdout 文本无契约承诺，仅记日志不作判据。
	// worker 是独立子进程、无 bridge 连接，禁 remoteLog——诊断只写本地日志，
	// 结局经 lastUpgrade 接 scheduler 下轮上报链。
	log('[upgrade-worker] Inspecting install record (post-update)...');
	// inspectPluginInstall 契约是永不抛，但注入实现可能同步抛错；裸抛会 fatal exit 1
	// （留备份、无状态记录），故归一化为 inspect 自身失败，走下方保守分支
	let inspected;
	try {
		inspected = await inspectPluginInstall(pluginId, opts);
	}
	catch (err) {
		/* c8 ignore next -- ?? fallback：err 字段缺省的兜底分支不强制覆盖 */
		const msg = err?.message ?? String(err);
		inspected = { ok: false, reason: `inspect threw: ${msg}` };
	}

	let verifyTarget = toVersion;
	// record 推进但未达标：按实装版本验证健康，成功后对 toVersion 记跳过（已知到不了）
	let advancedShortfall = false;
	if (inspected.ok && typeof inspected.install?.version === 'string') {
		const recordVersion = inspected.install.version;
		if (isVersionReached(recordVersion, toVersion)) {
			// 达标（等于或更新，覆盖 dist-tag 前移）：真升级，走现行 restart + 健康轮询流
			log(`[upgrade-worker] Install record reached target: ${recordVersion}`);
		}
		else if (!baselineVersion) {
			// 基线不可得：无从判断 record 是否推进，退化为现行流（restart + verify(toVersion)）
			log(`[upgrade-worker] Record version ${recordVersion} below target but baseline unknown; proceeding with standard verify`);
		}
		else if (recordVersion === baselineVersion) {
			// record 未推进：update 干净 skip / registry 假成功——磁盘什么都没变。
			// no-op：不重启、不回滚，删备份，立即记 skipVersion 停止每小时空转重试
			// （瞬时故障在新 host 上走 exit≠0 原路径，不会落到这里被永久跳过）
			log(`[upgrade-worker] Install record did not advance (still ${recordVersion}); no-op skip for ${toVersion}`);
			try { await removeBackup(pluginId); }
			catch (e) { log(`[upgrade-worker] Backup cleanup failed (non-fatal): ${e.message}`); }
			try {
				await recordUpgradeTerminal({
					from: fromVersion, to: toVersion, result: 'noop-skip', skipVersion: toVersion,
				});
			}
			/* c8 ignore next -- 状态写入 catch：测试中 stub 不会失败 */
			catch (e) { log(`[upgrade-worker] Failed to record terminal state (non-fatal): ${e.message}`); }
			log(`[upgrade-worker] No-op skip complete. Version ${toVersion} added to skipped list`);
			return;
		}
		else {
			// record 推进但未达标（latest-compatible 封顶等）：磁盘确已换代，
			// 必须健康验证实装版本，避免未经验证的新副本在下次自然重启时静默激活
			log(`[upgrade-worker] Install record advanced to ${recordVersion} (target ${toVersion} not reached); verifying actual version`);
			verifyTarget = recordVersion;
			advancedShortfall = true;
		}
	}
	else {
		// inspect 自身失败 / 记录缺版本：保守按"真升级"处理，进现行 restart + verify
		//（健康检查 + 回滚兜底），避免工具故障静默压制激活
		const reason = inspected.ok ? 'install record missing version' : inspected.reason;
		log(`[upgrade-worker] Post-update inspect unavailable (${reason}); proceeding with standard verify`);
	}

	// 4. 等待 gateway 重启并验证；phase/verifyTarget 推进进 inflight，
	// 中断时 scheduler 对账据 verifyTarget 判定成败（advancedShortfall 语义同步）
	try {
		await updateInflight({ phase: 'verify', verifyTarget });
	}
	catch (e) {
		log(`[upgrade-worker] Failed to update inflight marker (non-fatal): ${e.message}`);
	}
	log('[upgrade-worker] Verifying upgrade...');
	const result = await verifyUpgrade(pluginDir, verifyTarget, opts, log);

	if (result.ok) {
		// 4a. 成功
		log(`[upgrade-worker] Upgrade verified. Version: ${result.version}`);
		try {
			await removeBackup(pluginId);
		}
		catch (e) {
			log(`[upgrade-worker] Backup cleanup failed (non-fatal): ${e.message}`);
		}
		// 记录真实装上的版本而非目标版本——dist-tag 前移窗口下两者可能不同。
		// 不加 fallback：若 result.ok 时 version 缺失，说明上游契约被破坏，
		// 宁可让状态里直接暴露 undefined 便于排障，也不要用 toVersion 糊过去。
		// advancedShortfall：实装版本健康但 toVersion 在本 host 装不上 → 记跳过，
		// 停止注定不达标的重试
		try {
			await recordUpgradeTerminal({
				from: fromVersion, to: result.version, result: 'ok',
				skipVersion: advancedShortfall ? toVersion : undefined,
			});
		}
		catch (e) {
			log(`[upgrade-worker] Failed to record terminal state (non-fatal): ${e.message}`);
		}
		if (advancedShortfall) {
			log(`[upgrade-worker] Version ${toVersion} added to skipped list (host capped below target)`);
		}
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
 * 回滚处理。
 * result=rollback 指**文件态已恢复**（restore 或 fallback install 任一成功），
 * 运行态恢复交还重启/上游 watcher；两路都失败记 rollback-failed（error 带真因）。
 * 记账整体在 triggerGatewayRestart **之前**：回滚后文件态已定，记账不依赖重启，
 * 且 worker 在不可脱逃形态下可能被自己触发的重启杀死。
 */
async function handleRollback({ pluginDir, fromVersion, toVersion, pluginId, pkgName, error, skipVersion, opts, log }) {
	log('[upgrade-worker] Attempting rollback...');
	try {
		await updateInflight({ phase: 'rollback' });
	}
	catch (e) {
		log(`[upgrade-worker] Failed to update inflight marker (non-fatal): ${e.message}`);
	}

	// 首选 rename 备份目录
	let restored = false;
	let fallbackOk = false;
	let rollbackErrMsg = '';
	try {
		restored = await restoreFromBackup(pluginDir, pluginId, { log });
	} catch (restoreErr) {
		rollbackErrMsg = `restore: ${restoreErr.message}`;
		log(`[upgrade-worker] Backup restore error: ${restoreErr.message}`);
	}

	if (restored) {
		log('[upgrade-worker] Restored from backup');
	} else {
		// 兜底：从 npm 覆盖安装旧版本
		log('[upgrade-worker] Backup restore failed, falling back to npm install');
		try {
			await fallbackInstallOldVersion(pkgName, fromVersion, opts);
			fallbackOk = true;
			log('[upgrade-worker] Fallback install completed');
		}
		catch (fallbackErr) {
			rollbackErrMsg = rollbackErrMsg ? `${rollbackErrMsg}; ${fallbackErr.message}` : fallbackErr.message;
			log(`[upgrade-worker] Fallback install also failed: ${fallbackErr.message}`);
		}
	}

	const rollbackOk = restored || fallbackOk;
	// rollback-failed 时 error 带真因：!rollbackOk 必经 fallback 抛错，rollbackErrMsg 非空
	let finalError = error;
	if (!rollbackOk) {
		finalError = `${error}; rollback failed: ${rollbackErrMsg}`;
	}

	// 记录状态（重启前完成；失败非致命，inflight 未清交 scheduler 对账兜底）
	// 仅验证失败（新版本确实被加载并发现有问题）才标记为 skipped；
	// update 命令失败可能是瞬态故障（网络、磁盘等），不应永久跳过该版本
	try {
		await recordUpgradeTerminal({
			from: fromVersion, to: toVersion,
			result: rollbackOk ? 'rollback' : 'rollback-failed',
			error: finalError,
			skipVersion: skipVersion ? toVersion : undefined,
		});
	}
	catch (e) {
		log(`[upgrade-worker] Failed to record terminal state (non-fatal): ${e.message}`);
	}

	// 触发 gateway 重启让老版本回到运行态（尽力而为，不验证结果）
	log('[upgrade-worker] Triggering gateway restart after rollback...');
	const restartOk = await triggerGatewayRestart(opts);
	if (!restartOk) {
		// 文件态已恢复但运行态未刷新；worker 禁 remoteLog，只落 jsonl 事件供诊断
		log('[upgrade-worker] Gateway restart command failed after rollback');
		try { await appendLog({ event: 'rollback-restart-failed', from: fromVersion, to: toVersion }); }
		catch (e) { log(`[upgrade-worker] Failed to append log (non-fatal): ${e.message}`); }
	}

	if (!rollbackOk) {
		log(`[upgrade-worker] Rollback failed. Version ${toVersion} may still be active on disk`);
	} else if (skipVersion) {
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
			baselineVersion: { type: 'string' }, // 可缺：缺时按"基线不可得"退化处理
			pluginId: { type: 'string' },
			pkgName: { type: 'string' },
		},
		strict: true,
	});

	const { pluginDir, fromVersion, toVersion, baselineVersion, pluginId, pkgName } = values;
	if (!pluginDir || !fromVersion || !toVersion || !pluginId || !pkgName) {
		console.error('Usage: node worker.js --pluginDir <dir> --fromVersion <ver> --toVersion <ver> --pluginId <id> --pkgName <name> [--baselineVersion <ver>]');
		process.exit(1);
	}

	try {
		await runUpgrade({ pluginDir, fromVersion, toVersion, baselineVersion, pluginId, pkgName });
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
