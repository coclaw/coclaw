/**
 * worker-backup.js — 插件目录物理备份与恢复
 *
 * 使用 Node.js 内置 fs.cp()（16.7+）进行跨平台物理复制，无外部依赖。
 * 备份采用原子操作：先 cp 到 .tmp.bak，再 rename 到 .bak，
 * 避免中途失败产生不完整的备份目录。
 *
 * 命名约束：备份目录（含临时目录）必须以 .bak 结尾。
 * OpenClaw gateway 启动时会扫描 extensions/ 下所有子目录并尝试作为插件加载，
 * 但会跳过以 .bak 结尾的目录（discovery.ts shouldIgnoreScannedDirectory）。
 * 若临时目录不以 .bak 结尾（如曾用的 .bak-tmp），在 fs.cp 期间 gateway
 * 重启会将不完整的目录当作插件加载，导致 method 重复注册或加载异常。
 */
import fs from 'node:fs/promises';
import nodePath from 'node:path';

/**
 * 备份插件目录
 * @param {string} pluginDir - 插件安装目录
 * @returns {Promise<string>} 备份目录路径
 */
export async function createBackup(pluginDir) {
	const backupDir = `${pluginDir}.bak`;

	// 若上次异常退出遗留了 .bak，先清理
	await fs.rm(backupDir, { recursive: true, force: true });

	// 先复制到临时名，再 rename，确保原子性
	const tmpDir = `${pluginDir}.tmp.bak`;
	await fs.rm(tmpDir, { recursive: true, force: true });
	await fs.cp(pluginDir, tmpDir, { recursive: true });
	await fs.rename(tmpDir, backupDir);

	return backupDir;
}

/**
 * 从备份恢复插件目录
 * @param {string} pluginDir - 插件安装目录
 * @returns {Promise<boolean>} 是否成功恢复
 */
export async function restoreFromBackup(pluginDir) {
	const backupDir = `${pluginDir}.bak`;

	try {
		await fs.access(backupDir);
	}
	catch {
		return false;
	}

	// 删除损坏的新版本
	await fs.rm(pluginDir, { recursive: true, force: true });
	// 恢复备份
	await fs.rename(backupDir, pluginDir);
	return true;
}

/**
 * 删除备份目录
 * @param {string} pluginDir - 插件安装目录
 */
export async function removeBackup(pluginDir) {
	const backupDir = `${pluginDir}.bak`;
	await fs.rm(backupDir, { recursive: true, force: true });
}

/**
 * 从 extensions 目录路径推算备份目录路径
 * @param {string} pluginDir
 * @returns {string}
 */
export function getBackupDir(pluginDir) {
	return `${pluginDir}.bak`;
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
