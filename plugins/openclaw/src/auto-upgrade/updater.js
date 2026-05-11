import fs from 'node:fs/promises';
import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { checkForUpdate } from './updater-check.js';
import { spawnUpgradeWorker } from './updater-spawn.js';
import { readState, resolveStateDir, writeState } from './state.js';
import { getClawConfig } from '../claw-config.js';
import { remoteLog } from '../remote-log.js';
import { atomicWriteFile } from '../utils/atomic-write.js';

// OpenClaw ≥ 2026.4.25 起把插件安装记录从 openclaw.json 的 plugins.installs
// 迁移到独立账本文件，并在 loadConfig() 返回前剥掉 plugins.installs。
const INSTALLS_LEDGER_RELATIVE_PATH = nodePath.join('plugins', 'installs.json');

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
 * 读取本插件的安装记录（兼容新旧 OpenClaw 契约）
 *
 * - 新版（OpenClaw ≥ 2026.4.25）：账本文件 `<state-dir>/plugins/installs.json`
 *   下的 `installRecords[pluginId]` 是来源真相；`loadConfig()` 返回的对象里
 *   `plugins.installs` 已被剥离。
 * - 旧版（OpenClaw ≤ 2026.4.24）：账本文件不存在，
 *   `loadConfig().plugins.installs[pluginId]` 是来源真相。
 *
 * 兼容策略：先尝试账本文件；ENOENT（文件不存在）→ 回落到旧字段；
 * 其它失败（权限/JSON 损坏/缺记录）→ 视为账本不可用，按"无来源信息"处理，不回落。
 * 这两条互斥（新 gateway 必有账本、旧 gateway 必无）能让两个分支天然分流。
 *
 * 失败路径会通过 `remoteLog` 外推诊断信号（`upgrade.state-dir-failed` /
 * `upgrade.ledger-read-failed` / `upgrade.ledger-parse-failed`），避免运维只
 * 看到 start() 那条 "Skipping: not an npm-installed plugin" 时误判方向。
 *
 * 注：内部 `readFileSync` 为同步 IO，**有意保留**——只在升级周期决策时读一次
 * 账本（整个进程生命周期通常一锤子）。改 async 必须沿 `shouldSkipAutoUpgrade`
 * 等调用链向上传播，收益不抵成本。
 *
 * 另：OpenClaw plugin SDK 当前未暴露查询 installRecords 的 API，只能直接读
 * `<state-dir>/plugins/installs.json`（与上游 `manifest-metadata-scan` 等
 * 内部模块同源做法）。如果上游后续开放官方接口，可切换并删除直读分支。
 *
 * @param {string} pluginId
 * @returns {object|null}
 */
function loadInstallRecord(pluginId) {
	let ledgerPath;
	try {
		ledgerPath = nodePath.join(resolveStateDir(), INSTALLS_LEDGER_RELATIVE_PATH);
	}
	catch (err) {
		// 极少触发：host runtime 的 state resolver 自身异常
		/* c8 ignore next -- ?? fallback：err 字段缺省的兜底分支不强制覆盖 */
		remoteLog(`upgrade.state-dir-failed msg=${err?.message ?? String(err)}`);
		return null;
	}
	let raw;
	try {
		raw = nodeFs.readFileSync(ledgerPath, 'utf8');
	}
	catch (err) {
		if (err?.code === 'ENOENT') {
			return loadInstallRecordFromLegacyConfig(pluginId);
		}
		// 账本应该可读但读不到（权限/EISDIR/IO 错误）：不回落到旧字段，避免误判老路径
		// 静默返回 null 会让 start() 打 "Skipping: not an npm-installed plugin"，对运维毫无指向；
		// 把诊断信号外推到 server，便于定位
		/* c8 ignore next -- ?? fallback：err 字段缺省的兜底分支不强制覆盖 */
		remoteLog(`upgrade.ledger-read-failed code=${err?.code ?? 'unknown'} msg=${err?.message ?? String(err)}`);
		return null;
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	}
	catch (err) {
		// 账本损坏：同样不回落，并外推诊断信号
		/* c8 ignore next -- ?? fallback：err 字段缺省的兜底分支不强制覆盖 */
		remoteLog(`upgrade.ledger-parse-failed msg=${err?.message ?? String(err)}`);
		return null;
	}
	return parsed?.installRecords?.[pluginId] ?? null;
}

/**
 * 旧版 OpenClaw（≤ 2026.4.24）账本路径：openclaw.json 的 plugins.installs。
 * @param {string} pluginId
 * @returns {object|null}
 */
function loadInstallRecordFromLegacyConfig(pluginId) {
	try {
		const config = getClawConfig();
		return config?.plugins?.installs?.[pluginId] ?? null;
	}
	catch {
		return null;
	}
}

/**
 * 判断是否应跳过自动升级
 *
 * `openclaw plugins update` 仅对 source === "npm" 的安装生效。
 * source 的可能值：
 * - "npm"：从 npm registry 安装（生产环境，允许自动升级）
 * - "path"：link 模式（本地开发，跳过）
 * - "archive"：从 tarball 安装（跳过）
 *
 * @param {string} pluginId
 * @returns {boolean} true 表示应跳过自动升级
 */
export function shouldSkipAutoUpgrade(pluginId) {
	return loadInstallRecord(pluginId)?.source !== 'npm';
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
 * 获取插件安装路径
 * @param {string} pluginId
 * @returns {string|null}
 */
export function getPluginInstallPath(pluginId) {
	return loadInstallRecord(pluginId)?.installPath ?? null;
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
	 * @param {Function} [params.opts.getPluginInstallPathFn]
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
		if (shouldSkip(this.__pluginId)) {
			this.__logger.info?.('[auto-upgrade] Skipping: not an npm-installed plugin');
			this.__running = false;
			return;
		}

		// 默认 5~10 分钟随机延迟，避免多实例同时发起检查
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
			remoteLog(`upgrade.result result=${last.result} from=${last.from} to=${last.to}`);
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

			// 报告上一次升级结果（若有未报告的）
			await this.__reportLastUpgradeResult();

			this.__logger.info?.('[auto-upgrade] Checking for updates...');
			const result = await checkForUpdate({
				execFileFn: this.__opts.execFileFn,
			});

			if (!result.available) {
				if (result.skipped) {
					remoteLog(`upgrade.skipped version=${result.latestVersion}`);
					this.__logger.info?.(`[auto-upgrade] Version ${result.latestVersion} skipped (previously failed)`);
				} else {
					this.__logger.info?.(`[auto-upgrade] No update available (current: ${result.currentVersion})`);
				}
				return;
			}

			remoteLog(`upgrade.available from=${result.currentVersion} to=${result.latestVersion}`);
			this.__logger.info?.(`[auto-upgrade] Update available: ${result.currentVersion} → ${result.latestVersion}`);

			const getInstallPath = this.__opts.getPluginInstallPathFn ?? getPluginInstallPath;
			const pluginDir = getInstallPath(this.__pluginId);
			if (!pluginDir) {
				remoteLog('upgrade.no-install-path');
				this.__logger.warn?.('[auto-upgrade] Cannot determine plugin install path');
				return;
			}

			const { child } = spawnUpgradeWorker({
				pluginDir,
				fromVersion: result.currentVersion,
				toVersion: result.latestVersion,
				pluginId: this.__pluginId,
				pkgName: result.pkgName,
				opts: { spawnFn: this.__opts.spawnFn },
				logger: this.__logger,
			});

			// 记录 worker PID，下次 check 时据此判断 worker 是否仍在运行
			/* c8 ignore next -- ?? fallback */
			const writeLock = this.__opts.writeUpgradeLockFn ?? writeUpgradeLock;
			await writeLock(child.pid);
		}
		catch (err) {
			remoteLog(`upgrade.check-failed msg=${err.message}`);
			this.__logger.warn?.(`[auto-upgrade] Check failed: ${err.message}`);
		}
		finally {
			this.__checking = false;
		}
	}
}
