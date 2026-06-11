import fs from 'node:fs/promises';
import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { checkForUpdate, getPackageInfo, inspectPluginInstall } from './updater-check.js';
import { spawnUpgradeWorker } from './updater-spawn.js';
import { readInflight, readState, recordUpgradeTerminal, resolveStateDir, writeState } from './state.js';
import { removeBackup } from './worker-backup.js';
import { isVersionReached } from './worker-verify.js';
import { getRuntime } from '../runtime.js';
import { remoteLog } from '../remote-log.js';
import { atomicWriteFile } from '../utils/atomic-write.js';

// 首次检查延迟较长：失败时由 worker 触发 gateway restart，scheduler 重启后会重新计时；
// 60 分钟基线（实际随机 60-120 分钟）能把"失败→重启→再次检查"的循环周期拉长，
// 避免连续升级失败时 gateway 在短时间内反复被打扰。
const INITIAL_DELAY_MS = 60 * 60 * 1000; // 60 分钟
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 小时
const CHANNEL_ID = 'coclaw';
const LOCK_FILENAME = 'upgrade.lock';
// 锁年龄兜底：worker 最坏耗时约 36 分钟，TTL 给到约 3 倍余量。
// 超龄一律视为过期清理，兜住 worker 被强杀未清锁 / PID 被 OS 复用给长命进程的场景，
// 避免自动升级被永久卡住。
// 刻意取 110 分钟而非 120 分钟：巡检间隔 60min，锁写入与巡检有秒级抖动；
// 若 TTL 正好等于巡检间隔的整数倍，锁年龄会在第 N 次巡检时刚好 "未过期"，
// 要等到第 N+1 次巡检才清，白白多浪费一轮。110min 保证第 2 次巡检即过期。
// 代价是 worker 真卡超 110 分钟会多起一个并行 worker，此概率在当前超时矩阵下极低，
// 且底层升级命令失败会走回滚，不会破坏插件。
const LOCK_TTL_MS = 110 * 60 * 1000; // 110 分钟

// 精确 semver 形态（含可选 prerelease / build 段），spec 钉死检测用
const EXACT_SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.-]+)?(\+[\w.-]+)?$/;

// 运行态版本：模块加载时刻同步捕获，coclaw.upgradeHealth handler 与 inflight
// 对账共用本快照（getLoadedPluginVersion）。成功判据必须反映"当前 gateway
// 真正加载的代码"，禁止判定时再读磁盘 package.json：中断的升级可能已把磁盘
// 写成新版本而新代码从未被加载，误记成功会删掉唯一的回滚备份。
// （src/plugin-version.js 的懒读缓存原语是 info 展示用，语义不同，勿互相替代。）
let LOADED_PLUGIN_VERSION = null;
try {
	const rawPkg = nodeFs.readFileSync(nodePath.resolve(import.meta.dirname, '../../package.json'), 'utf8');
	const ver = JSON.parse(rawPkg)?.version;
	LOADED_PLUGIN_VERSION = typeof ver === 'string' ? ver : null;
}
/* c8 ignore next 3 -- 自身 package.json 读取失败的兜底：测试环境必可读 */
catch {
	// 读不到自身 package.json：对账退化为"无法判定"，保留 inflight 下轮重试
}

/**
 * 加载时刻钉住的自身版本快照（即当前进程真正加载的代码）。
 * 快照不可得时返回 null——调用方把 null 当"未达标"是保守正确方向；
 * 禁止加"为 null 就回退读磁盘"的 fallback（见上方快照注释的 Why）。
 * @returns {string|null}
 */
export function getLoadedPluginVersion() {
	return LOADED_PLUGIN_VERSION;
}

/**
 * 测试用：覆盖加载时快照（判别"返回快照 vs 调用时读磁盘"），返回旧值便于恢复。
 * @param {string|null} version
 * @returns {string|null}
 */
export function __setLoadedPluginVersionForTest(version) {
	const prev = LOADED_PLUGIN_VERSION;
	LOADED_PLUGIN_VERSION = version;
	return prev;
}

// ── upgrade.lock：保证同时最多一个 worker 进程 ──

export function getLockPath() {
	return nodePath.join(resolveStateDir(), CHANNEL_ID, LOCK_FILENAME);
}

/**
 * 清理过期锁文件。
 *
 * 成功才打 "Stale lock removed" 的 info；失败意味着系统性异常（权限/只读 FS/
 * 路径被替换为目录等），打 warn 并上报 server，避免运维无感——这类失败若与
 * writeUpgradeLock 同源故障叠加，会让锁陷入"每轮都判过期但写不进新 pid"的循环。
 * { force: true } 对文件不存在本身不会抛，所以这里 catch 到的一定是真故障。
 * 函数本身不抛——调用方无需额外 catch。
 * @param {string} lockPath
 * @param {'missing-pid'|'ttl-exceeded'|'pid-dead'} reason - 清理原因 token，
 *   同时用作 remoteLog 的 key=value 字段
 * @param {object} [logger]
 */
async function removeStaleLock(lockPath, reason, logger) {
	try {
		await fs.rm(lockPath, { force: true });
		logger?.info?.(`[auto-upgrade] Stale lock removed (${reason})`);
	}
	catch (err) {
		logger?.warn?.(`[auto-upgrade] Stale lock removal failed (${reason}): ${err?.message}`);
		remoteLog(`upgrade.lock-cleanup-failed reason=${reason} msg=${err?.message}`);
	}
}

/**
 * 检查升级锁是否被持有（worker 进程是否存活）
 *
 * 若锁文件存在但判定为过期（PID 已死 / JSON 无效 / 超龄），顺手清理残留文件。
 * @param {object} [opts]
 * @param {object} [opts.logger]
 * @returns {Promise<boolean>}
 */
export async function isUpgradeLocked(opts) {
	const lockPath = getLockPath();
	const logger = opts?.logger;
	let raw;
	try {
		raw = await fs.readFile(lockPath, 'utf8');
	}
	catch {
		return false; // 文件不存在，无需清理
	}
	try {
		const lock = JSON.parse(raw);
		if (!lock.pid) {
			await removeStaleLock(lockPath, 'missing-pid', logger);
			return false;
		}
		// 超龄兜底：PID 复用误判、worker 被强杀未清锁等场景下一律视为过期。
		// ts 不可解析也当过期（writeUpgradeLock 必写 ISO 时间戳，缺字段即异常状态）。
		const lockTs = Date.parse(lock.ts);
		if (!Number.isFinite(lockTs) || Date.now() - lockTs > LOCK_TTL_MS) {
			await removeStaleLock(lockPath, 'ttl-exceeded', logger);
			return false;
		}
		// signal 0 不发信号，仅检查进程存活性；进程不存在时抛异常
		process.kill(lock.pid, 0);
		return true;
	}
	catch {
		// JSON 无效 / PID 已死 → 清理过期锁
		await removeStaleLock(lockPath, 'pid-dead', logger);
		return false;
	}
}

/**
 * 写入升级锁（spawn worker 后调用）
 * @param {number} pid - worker 进程 PID
 */
export async function writeUpgradeLock(pid) {
	const lockPath = getLockPath();
	await atomicWriteFile(
		lockPath,
		`${JSON.stringify({ pid, ts: new Date().toISOString() })}\n`,
	);
}

/**
 * 包含谓词：判断 child 是否位于 parent 内（两者均须已 realpath 归一）。
 *
 * 禁用裸 `startsWith('..')`——`..foo` 这类目录名会被误判为"在外"。
 * Windows 大小写差异由 path.win32.relative 天然处理；跨盘符（relative 返回
 * 绝对路径）落 isAbsolute 兜住。
 *
 * @param {string} parent
 * @param {string} child
 * @param {object} [pathImpl] - 测试注入（win32 盘符/大小写边角）；默认 nodePath
 * @returns {boolean}
 */
export function isPathInside(parent, child, pathImpl) {
	/* c8 ignore next -- ?? fallback */
	const p = pathImpl ?? nodePath;
	const rel = p.relative(parent, child);
	return rel === '' || (!rel.startsWith(`..${p.sep}`) && rel !== '..' && !p.isAbsolute(rel));
}

/**
 * 判断是否应跳过自动升级（L0：Nix 短路 + 位置自检）
 *
 * 账本直读已移除；来源判定（npm/path/archive/...）后移到 L1（`__check` 内
 * 逐周期 inspect，瞬时失败下周期自愈）。这里只做启动时刻的同步短路：
 * - Nix mode：config 不可变，自动升级无意义；
 * - 位置自检：正式安装三代均落在 state-dir 内，自身包根在外 ⇒ dev/link 装置，
 *   跳过整个 scheduler——避免 dev 长命网关在"已发版未 pull"常态窗口每小时
 *   spawn 一次 inspect，且不依赖 CLI 可用性。
 *
 * 只信 runtime 注入的 resolveStateDir：state.js 的 env/home 兜底可能与上游
 * 真实 state-dir 分叉，不得用于"在外"判定。runtime 不可用或 realpath/谓词
 * 任一步抛错 → 不下"在外"结论，放行到 L1 兜底 + remoteLog 信号。
 *
 * @param {string} pluginId - 兼容旧签名保留；位置判定不依赖它
 * @param {object} [opts] - 测试注入
 * @param {string} [opts.pluginRoot] - 覆盖自身包根
 * @param {string} [opts.stateDir] - 覆盖 state-dir（绕过 runtime）
 * @returns {boolean} true 表示应跳过自动升级
 */
export function shouldSkipAutoUpgrade(pluginId, opts) {
	if (isNixMode()) return true;
	try {
		let stateDir = opts?.stateDir;
		if (stateDir == null) {
			const rt = getRuntime();
			if (typeof rt?.state?.resolveStateDir !== 'function') {
				// runtime 不可用：不能用 env/home 兜底下"在外"结论，放行到 L1
				remoteLog('upgrade.state-dir-failed msg=runtime resolveStateDir unavailable');
				return false;
			}
			stateDir = rt.state.resolveStateDir();
		}
		// 先 resolve 得根、再 realpath：link 模式下结果确定为 stage 根（与 updater-check.js 同锚点）
		const pkgRoot = nodeFs.realpathSync(
			opts?.pluginRoot ?? nodePath.resolve(import.meta.dirname, '../..'),
		);
		const realStateDir = nodeFs.realpathSync(stateDir);
		if (!isPathInside(realStateDir, pkgRoot)) {
			// start() 每次 gateway 启动只走一次，至多一条，与 nix-skip 同级
			remoteLog(`upgrade.position-skip pkgRoot=${pkgRoot} stateDir=${realStateDir}`);
			return true;
		}
		return false;
	}
	catch (err) {
		// realpath/谓词任一步异常：不下"在外"结论，放行 + 信号
		/* c8 ignore next -- ?? fallback：err 字段缺省的兜底分支不强制覆盖 */
		remoteLog(`upgrade.state-dir-failed msg=${err?.message ?? String(err)}`);
		return false;
	}
}

/**
 * 判断 host 是否运行在 Nix mode。
 *
 * OpenClaw ≥ 2026.5 在 `openclaw plugins {update,install,uninstall,...}` 入口加了
 * `assertConfigWriteAllowedInCurrentMode()` 守门：当 `OPENCLAW_NIX_MODE=1` 时直接抛
 * `NixModeConfigMutationError`（code `OPENCLAW_NIX_MODE_CONFIG_IMMUTABLE`），因为
 * 这类用户的 openclaw.json 由 Nix 当 immutable 资产管，运行时改了下次 Nix 重建会被刷回。
 * 自动升级在这种环境下毫无意义且会污染日志，scheduler 启动前直接退出即可。
 *
 * @returns {boolean}
 */
export function isNixMode() {
	return process.env.OPENCLAW_NIX_MODE === '1';
}

/**
 * 自动升级调度器
 */
export class AutoUpgradeScheduler {
	/** @type {ReturnType<typeof setTimeout>|null} */
	__initialTimer = null;
	/** @type {ReturnType<typeof setInterval>|null} */
	__intervalTimer = null;
	__running = false;
	__checking = false;
	__pluginId = null;
	__logger = console;
	__opts = {};
	/** 已报告过的 lastUpgrade.ts，用于去重 */
	__lastReportedUpgradeTs = null;
	/** L1 门禁信号去重：key=`<原因>|<toVersion>`，重启重置（稳定态装置至多重发一条） */
	__reportedGateSignals = new Set();

	/**
	 * @param {object} [params]
	 * @param {string} [params.pluginId] - 插件 ID（来自 api.id）
	 * @param {Function} [params.logger]
	 * @param {object} [params.opts] - 测试注入选项
	 * @param {number} [params.opts.initialDelayMs]
	 * @param {number} [params.opts.checkIntervalMs]
	 * @param {Function} [params.opts.execFileFn]
	 * @param {Function} [params.opts.spawnFn]
	 * @param {Function} [params.opts.shouldSkipFn]
	 * @param {Function} [params.opts.isNixModeFn]
	 * @param {Function} [params.opts.inspectInstallFn] - L1 来源门禁的 inspect 注入
	 * @param {string} [params.opts.pluginRoot] - L0 位置自检/L1 回退的包根注入
	 * @param {string} [params.opts.stateDir] - L0 位置自检的 state-dir 注入
	 * @param {Function} [params.opts.readInflightFn] - inflight 对账读注入
	 * @param {Function} [params.opts.recordUpgradeTerminalFn] - inflight 对账终态写注入
	 * @param {Function} [params.opts.removeBackupFn] - inflight 对账备份清理注入
	 * @param {string} [params.opts.runtimeVersion] - 运行态版本覆盖（对账判据注入）
	 * @param {string} [params.opts.platform] - spawn 探针平台覆盖
	 * @param {NodeJS.ProcessEnv} [params.opts.scopeEnv] - spawn 探针 env 覆盖
	 */
	constructor(params) {
		if (params?.pluginId) this.__pluginId = params.pluginId;
		if (params?.logger) this.__logger = params.logger;
		if (params?.opts) this.__opts = params.opts;
	}

	/**
	 * 启动调度器
	 */
	start() {
		if (this.__running) return;
		this.__running = true;

		if (!this.__pluginId) {
			this.__logger.warn?.('[auto-upgrade] Skipping: pluginId not provided');
			this.__running = false;
			return;
		}

		const isNix = this.__opts.isNixModeFn ?? isNixMode;
		if (isNix()) {
			// 上推到 server：用户向我们反馈"自动升级没动"时，可凭 server 端 remote log
			// 直接定位到 Nix mode 跳过路径，不必再回滚问"你是不是 nix-openclaw 装的"。
			// scheduler.start() 每次 gateway 启动只调一次，量级低、不会刷屏。
			remoteLog('upgrade.nix-mode-skip');
			this.__logger.info?.('[auto-upgrade] Skipping: host is in Nix mode (config is immutable)');
			this.__running = false;
			return;
		}

		const shouldSkip = this.__opts.shouldSkipFn ?? shouldSkipAutoUpgrade;
		if (shouldSkip(this.__pluginId, this.__opts)) {
			this.__logger.info?.('[auto-upgrade] Skipping: plugin package root is outside state-dir (dev/link install)');
			this.__running = false;
			return;
		}

		// 默认 60~120 分钟随机延迟，避免多实例同时发起检查
		/* c8 ignore next 2 -- ?? fallback：测试始终注入 initialDelayMs */
		const initialDelay = this.__opts.initialDelayMs
			?? (INITIAL_DELAY_MS + Math.floor(Math.random() * INITIAL_DELAY_MS));
		this.__logger.info?.(`[auto-upgrade] Scheduler started. First check in ${Math.round(initialDelay / 1000)}s`);

		this.__initialTimer = setTimeout(() => {
			this.__initialTimer = null;
			this.__check().catch(() => {});
			/* c8 ignore next -- ?? fallback */
			const interval = this.__opts.checkIntervalMs ?? CHECK_INTERVAL_MS;
			this.__intervalTimer = setInterval(() => this.__check().catch(() => {}), interval);
		}, initialDelay);
	}

	/**
	 * 停止调度器
	 */
	stop() {
		if (!this.__running) return;
		this.__running = false;

		if (this.__initialTimer) {
			clearTimeout(this.__initialTimer);
			this.__initialTimer = null;
		}
		if (this.__intervalTimer) {
			clearInterval(this.__intervalTimer);
			this.__intervalTimer = null;
		}
		this.__logger.info?.('[auto-upgrade] Scheduler stopped');
	}

	/**
	 * L1 门禁信号去重上报：同一 (原因, toVersion) 每个 gateway 进程周期只发一条。
	 * source-skip / 无记录是稳定态，逐周期重验若不去重会每小时刷 server；
	 * gate-inspect-failed 持续存在时也只需一条（重启重置，至多重发一条）。
	 * installPath 回退两条信号（fallback / pkg-name-mismatch）同模式去重。
	 * @param {string} key - 去重键，`<原因>|<toVersion>`
	 * @param {string} text - remoteLog 文本
	 */
	__gateSignalOnce(key, text) {
		if (this.__reportedGateSignals.has(key)) return;
		this.__reportedGateSignals.add(key);
		remoteLog(text);
	}

	/**
	 * 检查 lastUpgrade 是否有未报告的结果，若有则 remoteLog 并标记已报告
	 */
	async __reportLastUpgradeResult() {
		try {
			const readStateFn = this.__opts.readStateFn ?? readState;
			const state = await readStateFn();
			const last = state.lastUpgrade;
			if (!last?.ts || last.ts === state.lastReport) return;
			if (last.ts === this.__lastReportedUpgradeTs) return;
			this.__lastReportedUpgradeTs = last.ts;
			// error 附上报行（lastUpgrade.error 已在写入时截断），真因远程可见
			const errSuffix = last.error ? ` error=${last.error}` : '';
			remoteLog(`upgrade.result result=${last.result} from=${last.from} to=${last.to}${errSuffix}`);
			this.__logger.info?.(`[auto-upgrade] Last upgrade: ${last.from} → ${last.to} result=${last.result}`);
			state.lastReport = last.ts;
			const writeStateFn = this.__opts.writeStateFn ?? writeState;
			await writeStateFn(state);
		}
		catch (err) {
			this.__logger.warn?.(`[auto-upgrade] Report last upgrade result failed: ${err?.message}`);
			remoteLog(`upgrade.report-failed msg=${err?.message}`);
		}
	}

	/**
	 * inflight 对账：worker 写过 inflight 但没活到终态记账（典型：被自己触发的
	 * 网关重启杀死）时，由 scheduler 在锁空闲周期补记终态。
	 *
	 * 成功判据用模块加载时刻捕获的运行态版本（LOADED_PLUGIN_VERSION，与
	 * upgradeHealth 同源）：达 verifyTarget → 补记 ok + 删备份（verifyTarget ≠
	 * toVersion 时复刻 worker advancedShortfall 语义补 skip）；未达 → 补记
	 * interrupted（带 phase）+ 告警，不自动 skip——回滚记账已前移 + 终态原子化后，
	 * 中断窗口只剩"死在回滚中途"，下周期重验自然收敛，自动 skip 反而误伤瞬态。
	 * interrupted 不清备份（保留人工恢复，下次备份前覆盖）。
	 *
	 * 畸形 inflight（verifyTarget 与 to 皆缺）永远无法判定达标，defer 会让升级
	 * 管线永久停摆——按 interrupted（phase=malformed）消化；只有自身快照不可得
	 * （runtimeVersion 空）才 defer（"无法判定就不动盘"的正确保守）。
	 *
	 * @returns {Promise<boolean>} false 表示 inflight 存在但未消化（判据不可得 /
	 *   终态写失败），本周期应跳过 checkForUpdate，避免新 spawn 覆盖中断账目
	 */
	async __reconcileInflight() {
		let inflight;
		try {
			/* c8 ignore next -- ?? fallback */
			const readInflightFn = this.__opts.readInflightFn ?? readInflight;
			inflight = await readInflightFn();
		}
		catch (err) {
			this.__logger.warn?.(`[auto-upgrade] Inflight read failed: ${err?.message}`);
			remoteLog(`upgrade.reconcile-failed msg=${err?.message}`);
			return false;
		}
		if (!inflight) return true;

		const { from, to, verifyTarget, phase } = inflight;
		/* c8 ignore next -- ?? fallback */
		const recordTerminal = this.__opts.recordUpgradeTerminalFn ?? recordUpgradeTerminal;
		const target = verifyTarget || to;
		if (!target) {
			// 畸形 inflight：无判定目标，defer 等不来转机，按 interrupted 消化让管线继续
			try {
				await recordTerminal({ from: from || 'unknown', to: to || 'unknown', result: 'interrupted', phase: 'malformed' });
			}
			catch (err) {
				// 终态写失败：inflight 保留，下轮重试；本周期不再 spawn
				this.__logger.warn?.(`[auto-upgrade] Inflight reconcile failed: ${err?.message}`);
				remoteLog(`upgrade.reconcile-failed msg=${err?.message}`);
				return false;
			}
			this.__gateSignalOnce('reconcile-malformed', 'upgrade.reconcile-malformed');
			this.__logger.warn?.('[auto-upgrade] Malformed inflight (no verifyTarget/to), recorded as interrupted');
			return true;
		}
		/* c8 ignore next -- ?? fallback */
		const runtimeVersion = this.__opts.runtimeVersion ?? LOADED_PLUGIN_VERSION;
		if (!runtimeVersion) {
			// 判据不可得：不下结论，保留 inflight 下轮重试
			this.__gateSignalOnce(
				`reconcile-no-version|${to}`,
				`upgrade.reconcile-no-version to=${to}`,
			);
			this.__logger.warn?.('[auto-upgrade] Inflight found but reconcile criteria unavailable, deferring');
			return false;
		}
		try {
			if (isVersionReached(runtimeVersion, target)) {
				// 运行态已达 verifyTarget：升级实际生效（worker 只是没活到记账），补记成功
				await recordTerminal({
					from, to: runtimeVersion, result: 'ok',
					skipVersion: target !== to ? to : undefined,
				});
				/* c8 ignore next -- ?? fallback */
				const doRemoveBackup = this.__opts.removeBackupFn ?? removeBackup;
				try { await doRemoveBackup(this.__pluginId); }
				catch (e) { this.__logger.warn?.(`[auto-upgrade] Reconcile backup cleanup failed (non-fatal): ${e?.message}`); }
				this.__logger.info?.(`[auto-upgrade] Reconciled interrupted upgrade as ok: ${from} → ${runtimeVersion}`);
			}
			else {
				/* c8 ignore next -- ?? fallback */
				const phaseToken = phase ?? 'unknown';
				await recordTerminal({ from, to, result: 'interrupted', phase: phaseToken });
				remoteLog(`upgrade.interrupted from=${from} to=${to} phase=${phaseToken} runtime=${runtimeVersion}`);
				this.__logger.warn?.(`[auto-upgrade] Interrupted upgrade detected: ${from} → ${to} (phase=${phaseToken})`);
			}
			return true;
		}
		catch (err) {
			// 终态写失败：inflight 保留，下轮重试；本周期不再 spawn
			this.__logger.warn?.(`[auto-upgrade] Inflight reconcile failed: ${err?.message}`);
			remoteLog(`upgrade.reconcile-failed msg=${err?.message}`);
			return false;
		}
	}

	/**
	 * 执行一次检查
	 */
	async __check() {
		if (this.__checking) return;
		this.__checking = true;
		try {
			// 若上一次 spawn 的 worker 仍在运行，跳过本次检查
			const isLocked = this.__opts.isUpgradeLockedFn ?? isUpgradeLocked;
			if (await isLocked({ logger: this.__logger })) {
				remoteLog('upgrade.worker-locked');
				this.__logger.info?.('[auto-upgrade] Upgrade worker still running, skipping check');
				return;
			}

			// 锁空闲才对账：先消化 inflight（补记中断 worker 的终态），再跑新
			// checkForUpdate——未消化就 spawn 会让新 worker 覆盖中断账目
			if (!(await this.__reconcileInflight())) return;

			// 报告上一次升级结果（若有未报告的）
			await this.__reportLastUpgradeResult();

			this.__logger.info?.('[auto-upgrade] Checking for updates...');
			const result = await checkForUpdate({
				execFileFn: this.__opts.execFileFn,
			});

			if (!result.available) {
				if (result.prerelease) {
					// prerelease 挂 latest（人为失误）是稳定态，逐周期重验须去重防刷屏
					this.__gateSignalOnce(
						`prerelease-skip|${result.latestVersion}`,
						`upgrade.prerelease-skip version=${result.latestVersion}`,
					);
					this.__logger.info?.(`[auto-upgrade] Latest ${result.latestVersion} is a prerelease, skipping`);
				} else if (result.skipped) {
					// skipped 同为稳定态（直到下个正式版发布），同模式去重
					this.__gateSignalOnce(
						`skipped|${result.latestVersion}`,
						`upgrade.skipped version=${result.latestVersion}`,
					);
					this.__logger.info?.(`[auto-upgrade] Version ${result.latestVersion} skipped (previously failed)`);
				} else {
					this.__logger.info?.(`[auto-upgrade] No update available (current: ${result.currentVersion})`);
				}
				return;
			}

			// L1 来源门禁：有新版才核对权威安装记录（独立 CLI 子进程，不冻结网关，
			// 逐周期重验——结构上消灭"一次误判 → 永久静默停摆"）。
			// 必须局部 try/catch：外层 catch-all 会把这里的异常吞成泛化 upgrade.check-failed，混淆信号。
			let install;
			try {
				/* c8 ignore next -- ?? fallback */
				const inspectInstall = this.__opts.inspectInstallFn ?? inspectPluginInstall;
				const inspected = await inspectInstall(this.__pluginId, { execFileFn: this.__opts.execFileFn });
				if (!inspected.ok) {
					// inspect 真失败（exit≠0 / 解析失败）：本周期跳过，下周期自动重试（瞬时自愈、持续可见）
					this.__gateSignalOnce(
						`gate-inspect-failed|${result.latestVersion}`,
						`upgrade.gate-inspect-failed to=${result.latestVersion} msg=${inspected.reason}`,
					);
					this.__logger.warn?.(`[auto-upgrade] Install record inspect failed, skipping this cycle: ${inspected.reason}`);
					return;
				}
				install = inspected.install;
			}
			catch (err) {
				// 注入实现异常也按真失败处理：跳过本周期，下周期重试
				/* c8 ignore next -- ?? fallback：err 字段缺省的兜底分支不强制覆盖 */
				const msg = err?.message ?? String(err);
				this.__gateSignalOnce(
					`gate-inspect-failed|${result.latestVersion}`,
					`upgrade.gate-inspect-failed to=${result.latestVersion} msg=${msg}`,
				);
				this.__logger.warn?.(`[auto-upgrade] Install record inspect threw, skipping this cycle: ${msg}`);
				return;
			}

			const source = install?.source ?? 'none';
			if (source !== 'npm') {
				// 非 npm 装置（path/archive/git/...）或无安装记录（source=none）：
				// 与现状语义等价（这些装置今天也不升级），但多了远程可见性
				this.__gateSignalOnce(
					`source-skip:${source}|${result.latestVersion}`,
					`upgrade.source-skip source=${source} to=${result.latestVersion}`,
				);
				this.__logger.info?.(`[auto-upgrade] Skipping: install source is ${source} (not npm)`);
				return;
			}

			// spec 钉死可见性：install.spec 是精确版本时 update 永远 resolve 同一版本
			//（fallback install / 人工 `pkg@x.y.z` 留下的）。worker 侧裸包名 update 会
			// 顺带解钉，这里只发去重信号，不改行为
			const spec = typeof install.spec === 'string' ? install.spec : '';
			const specAt = spec.lastIndexOf('@');
			if (specAt > 0 && EXACT_SEMVER_RE.test(spec.slice(specAt + 1))) {
				this.__gateSignalOnce(
					`spec-pinned|${result.latestVersion}`,
					`upgrade.spec-pinned spec=${spec}`,
				);
			}

			// 来源验明 npm 后才上报 available——否则永不升级的装置每小时刷一条
			remoteLog(`upgrade.available from=${result.currentVersion} to=${result.latestVersion}`);
			this.__logger.info?.(`[auto-upgrade] Update available: ${result.currentVersion} → ${result.latestVersion}`);

			// installPath 取自权威记录（新鲜）；缺失时回退自推包根，
			// 并核验该目录 package.json 的包名，防错传目录给备份/回滚
			let pluginDir = install.installPath;
			if (!pluginDir) {
				pluginDir = this.__opts.pluginRoot ?? nodePath.resolve(import.meta.dirname, '../..');
				// 记录缺 installPath 是稳定异常态，与门禁信号同模式按 (原因, toVersion) 去重
				this.__gateSignalOnce(
					`install-path-fallback|${result.latestVersion}`,
					`upgrade.install-path-fallback to=${result.latestVersion} dir=${pluginDir}`,
				);
				this.__logger.warn?.(`[auto-upgrade] Install record has no installPath, falling back to plugin root: ${pluginDir}`);
				let pkgName = null;
				try {
					({ name: pkgName } = await getPackageInfo(pluginDir));
				}
				catch {
					// package.json 读不到/损坏：按核验失败处理
				}
				if (pkgName !== result.pkgName) {
					this.__gateSignalOnce(
						`no-install-path:pkg-name-mismatch|${result.latestVersion}`,
						`upgrade.no-install-path reason=pkg-name-mismatch got=${pkgName}`,
					);
					this.__logger.warn?.(`[auto-upgrade] Fallback plugin dir failed package name check (got ${pkgName}), skipping`);
					return;
				}
			}

			// 基线版本来自权威记录：worker 据此区分"record 推进/未推进"（L2 结局核对）
			const baselineVersion = typeof install.version === 'string' ? install.version : '';
			this.__logger.info?.(`[auto-upgrade] Pre-upgrade baseline: version=${baselineVersion || '(unknown)'} path=${pluginDir}`);

			const { child, escapeFailed } = await spawnUpgradeWorker({
				pluginDir,
				fromVersion: result.currentVersion,
				toVersion: result.latestVersion,
				baselineVersion,
				pluginId: this.__pluginId,
				pkgName: result.pkgName,
				opts: {
					spawnFn: this.__opts.spawnFn,
					execFileFn: this.__opts.execFileFn,
					platform: this.__opts.platform,
					scopeEnv: this.__opts.scopeEnv,
				},
				logger: this.__logger,
			});
			if (escapeFailed) {
				// systemd 形态但 scope 脱逃不可用：worker 大概率活不过自己触发的重启，
				// 终态靠下轮 inflight 对账兜底；稳定态信号去重防每小时刷屏
				this.__gateSignalOnce(
					`cgroup-escape-failed|${result.latestVersion}`,
					`upgrade.cgroup-escape-failed to=${result.latestVersion}`,
				);
			}

			// 记录 worker PID，下次 check 时据此判断 worker 是否仍在运行
			/* c8 ignore next -- ?? fallback */
			const writeLock = this.__opts.writeUpgradeLockFn ?? writeUpgradeLock;
			await writeLock(child.pid);
		}
		catch (err) {
			/* c8 ignore next -- ?? fallback：err 字段缺省的兜底分支不强制覆盖 */
			const msg = err?.message ?? String(err);
			remoteLog(`upgrade.check-failed msg=${msg}`);
			this.__logger.warn?.(`[auto-upgrade] Check failed: ${msg}`);
		}
		finally {
			this.__checking = false;
		}
	}
}
