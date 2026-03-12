import fs from 'node:fs/promises';
import nodePath from 'node:path';

import { checkForUpdate } from './updater-check.js';
import { spawnUpgradeWorker } from './updater-spawn.js';
import { resolveStateDir } from './state.js';
import { getRuntime } from '../runtime.js';

const INITIAL_DELAY_MS = 5 * 60 * 1000; // 5 分钟
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 小时
const CHANNEL_ID = 'coclaw';
const LOCK_FILENAME = 'upgrade.lock';

// ── upgrade.lock：保证同时最多一个 worker 进程 ──

export function getLockPath() {
	return nodePath.join(resolveStateDir(), CHANNEL_ID, LOCK_FILENAME);
}

/**
 * 检查升级锁是否被持有（worker 进程是否存活）
 *
 * 若锁文件存在但 PID 已死（过期锁），顺手清理残留文件。
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
			logger?.info?.('[auto-upgrade] Stale lock removed (missing pid)');
			await fs.rm(lockPath, { force: true }).catch(() => {});
			return false;
		}
		// signal 0 不发信号，仅检查进程存活性；进程不存在时抛异常
		process.kill(lock.pid, 0);
		return true;
	}
	catch {
		// JSON 无效 / PID 已死 → 清理过期锁
		logger?.info?.('[auto-upgrade] Stale lock removed (worker pid no longer alive)');
		await fs.rm(lockPath, { force: true }).catch(() => {});
		return false;
	}
}

/**
 * 写入升级锁（spawn worker 后调用）
 * @param {number} pid - worker 进程 PID
 */
export async function writeUpgradeLock(pid) {
	const lockPath = getLockPath();
	await fs.mkdir(nodePath.dirname(lockPath), { recursive: true });
	await fs.writeFile(
		lockPath,
		`${JSON.stringify({ pid, ts: new Date().toISOString() })}\n`,
		'utf8',
	);
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
	const rt = getRuntime();
	if (!rt?.config?.loadConfig) return true;
	try {
		const config = rt.config.loadConfig();
		const installInfo = config?.plugins?.installs?.[pluginId];
		return installInfo?.source !== 'npm';
	}
	catch {
		return true;
	}
}

/**
 * 获取插件安装路径
 * @param {string} pluginId
 * @returns {string|null}
 */
export function getPluginInstallPath(pluginId) {
	const rt = getRuntime();
	if (!rt?.config?.loadConfig) return null;
	try {
		const config = rt.config.loadConfig();
		return config?.plugins?.installs?.[pluginId]?.installPath ?? null;
	}
	catch {
		return null;
	}
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

		const shouldSkip = this.__opts.shouldSkipFn ?? shouldSkipAutoUpgrade;
		if (shouldSkip(this.__pluginId)) {
			this.__logger.info?.('[auto-upgrade] Skipping: not an npm-installed plugin');
			this.__running = false;
			return;
		}

		// 默认 5~10 分钟随机延迟，避免多实例同时发起检查
		const initialDelay = this.__opts.initialDelayMs
			?? (INITIAL_DELAY_MS + Math.floor(Math.random() * INITIAL_DELAY_MS));
		this.__logger.info?.(`[auto-upgrade] Scheduler started. First check in ${Math.round(initialDelay / 1000)}s`);

		this.__initialTimer = setTimeout(() => {
			this.__initialTimer = null;
			this.__check().catch(() => {});
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
	 * 执行一次检查
	 */
	async __check() {
		if (this.__checking) return;
		this.__checking = true;
		try {
			// 若上一次 spawn 的 worker 仍在运行，跳过本次检查
			const isLocked = this.__opts.isUpgradeLockedFn ?? isUpgradeLocked;
			if (await isLocked({ logger: this.__logger })) {
				this.__logger.info?.('[auto-upgrade] Upgrade worker still running, skipping check');
				return;
			}

			this.__logger.info?.('[auto-upgrade] Checking for updates...');
			const result = await checkForUpdate({
				execFileFn: this.__opts.execFileFn,
			});

			if (!result.available) {
				if (result.skipped) {
					this.__logger.info?.(`[auto-upgrade] Version ${result.latestVersion} skipped (previously failed)`);
				} else {
					this.__logger.info?.(`[auto-upgrade] No update available (current: ${result.currentVersion})`);
				}
				return;
			}

			this.__logger.info?.(`[auto-upgrade] Update available: ${result.currentVersion} → ${result.latestVersion}`);

			const getInstallPath = this.__opts.getPluginInstallPathFn ?? getPluginInstallPath;
			const pluginDir = getInstallPath(this.__pluginId);
			if (!pluginDir) {
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
			const writeLock = this.__opts.writeUpgradeLockFn ?? writeUpgradeLock;
			await writeLock(child.pid);
		}
		catch (err) {
			this.__logger.warn?.(`[auto-upgrade] Check failed: ${err.message}`);
		}
		finally {
			this.__checking = false;
		}
	}
}
