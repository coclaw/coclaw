/**
 * worker-backup.js — 插件目录物理备份与恢复
 *
 * 备份目录固定在 `<state-dir>/coclaw/upgrade-backup/<pluginId>/`——必须在
 * npm 地盘（extensions/<id>/node_modules）之外：`plugins update` 跑 npm 时
 * 会把安装目录里的陌生 `.bak` 目录当 extraneous 修剪掉（本机实测 update 后
 * 约 46s 消失），导致回滚时备份已无。state-dir 下的自管目录免疫 npm prune。
 *
 * state-dir 解析复用 state.js 的双轨通道（gateway 进程走 runtime 注入，
 * worker 子进程走 OPENCLAW_STATE_DIR 环境变量）。
 *
 * 备份采用原子操作：先 cp 到 `<pluginId>.tmp`，再 rename 到 `<pluginId>`，
 * 避免中途失败产生不完整的备份目录。恢复时备份目录与插件目录可能跨文件系统
 * （state-dir 与 extensions 不保证同盘），rename 报 EXDEV 时退化为 cp+rm。
 *
 * 残留语义：interrupted 等异常分支不主动清备份——保留给人工恢复，下次备份前
 * 覆盖；固定目录 + 升级锁保证同一插件至多一份，无累积风险。
 */
import fs from 'node:fs/promises';
import nodePath from 'node:path';

import { resolveStateDir } from './state.js';

const CHANNEL_ID = 'coclaw';
const BACKUP_DIRNAME = 'upgrade-backup';

/**
 * 备份目录路径：`<state-dir>/coclaw/upgrade-backup/<pluginId>`
 * @param {string} pluginId
 * @returns {string}
 */
export function getBackupDir(pluginId) {
	return nodePath.join(resolveStateDir(), CHANNEL_ID, BACKUP_DIRNAME, pluginId);
}

/**
 * 备份插件目录
 * @param {string} pluginDir - 插件安装目录
 * @param {string} pluginId - 插件 ID（备份目录名）
 * @returns {Promise<string>} 备份目录路径
 */
export async function createBackup(pluginDir, pluginId) {
	const backupDir = getBackupDir(pluginId);

	// 若上次异常退出遗留了旧备份/临时目录，先清理
	await fs.rm(backupDir, { recursive: true, force: true });
	const tmpDir = `${backupDir}.tmp`;
	await fs.rm(tmpDir, { recursive: true, force: true });

	// 先复制到临时名，再 rename（同目录内必为同文件系统，rename 原子），
	// 确保备份目录要么完整要么不存在
	await fs.mkdir(nodePath.dirname(backupDir), { recursive: true });
	await fs.cp(pluginDir, tmpDir, { recursive: true });
	await fs.rename(tmpDir, backupDir);

	return backupDir;
}

/**
 * 从备份恢复插件目录
 * @param {string} pluginDir - 插件安装目录
 * @param {string} pluginId - 插件 ID
 * @param {object} [opts]
 * @param {Function} [opts.renameFn] - 测试注入（EXDEV 分支）
 * @param {Function} [opts.rmFn] - 测试注入（EXDEV 退化路径的备份清理）
 * @param {Function} [opts.log] - 本地日志函数（worker 进程禁 remoteLog）
 * @returns {Promise<boolean>} 是否成功恢复
 */
export async function restoreFromBackup(pluginDir, pluginId, opts) {
	const backupDir = getBackupDir(pluginId);
	/* c8 ignore next -- ?./?? fallback */
	const doRename = opts?.renameFn ?? fs.rename;

	try {
		await fs.access(backupDir);
	}
	catch {
		return false;
	}

	// 删除损坏的新版本
	await fs.rm(pluginDir, { recursive: true, force: true });
	// 恢复备份：state-dir 与 extensions 可能跨文件系统，EXDEV 时退化 cp+rm
	try {
		await doRename(backupDir, pluginDir);
	}
	catch (err) {
		if (err?.code !== 'EXDEV') throw err;
		await fs.cp(backupDir, pluginDir, { recursive: true });
		// cp 成功即文件态已恢复，restore 成立；残留备份目录清理失败只降级为告警——
		// 整体抛出会让调用方误走 fallback install / 误记 rollback-failed
		try {
			/* c8 ignore next -- ?./?? fallback */
			const doRm = opts?.rmFn ?? fs.rm;
			await doRm(backupDir, { recursive: true, force: true });
		}
		catch (rmErr) {
			/* c8 ignore next -- ?? fallback：err 字段缺省的兜底分支不强制覆盖 */
			opts?.log?.(`[upgrade-worker] Backup cleanup after EXDEV restore failed (non-fatal): ${rmErr?.message ?? String(rmErr)}`);
		}
	}
	return true;
}

/**
 * 删除备份目录
 * @param {string} pluginId - 插件 ID
 */
export async function removeBackup(pluginId) {
	const backupDir = getBackupDir(pluginId);
	await fs.rm(backupDir, { recursive: true, force: true });
}

/**
 * 读取指定目录下 package.json 的版本号
 * @param {string} dir
 * @returns {Promise<string>}
 */
export async function readVersionFromDir(dir) {
	const pkgPath = nodePath.join(dir, 'package.json');
	const raw = await fs.readFile(pkgPath, 'utf8');
	return JSON.parse(raw).version;
}
