/**
 * updater-check.js — 版本检查
 *
 * 通过 `npm view` 查询 registry 最新版本，与本地 package.json 对比。
 * 选择 npm view 而非直接 fetch registry API，是因为它自动继承用户完整的
 * npm 环境配置（registry 镜像、proxy、scoped registry、auth token 等），
 * 避免自行解析多层 .npmrc 的复杂性。每小时一次的频率下进程启动开销可忽略。
 */
import { execFile as nodeExecFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import nodePath from 'node:path';

import { readState, updateLastCheck } from './state.js';

/**
 * 读取本地 package.json 获取包名和版本号
 * @param {string} [pluginDir] - 插件根目录（默认自动检测）
 * @returns {Promise<{ name: string, version: string }>}
 */
export async function getPackageInfo(pluginDir) {
	const dir = pluginDir ?? nodePath.resolve(import.meta.dirname, '../..');
	const pkgPath = nodePath.join(dir, 'package.json');
	const raw = await readFile(pkgPath, 'utf8');
	const pkg = JSON.parse(raw);
	return { name: pkg.name, version: pkg.version };
}

/**
 * 查询 npm registry 上的最新版本
 * @param {string} pkgName - npm 包名
 * @param {object} [opts]
 * @param {Function} [opts.execFileFn] - 可注入的 execFile（测试用）
 * @returns {Promise<string>}
 */
export async function getLatestVersion(pkgName, opts) {
	const doExecFile = opts?.execFileFn ?? nodeExecFile;
	return new Promise((resolve, reject) => {
		doExecFile('npm', ['view', pkgName, 'version'], {
			timeout: 30_000,
			shell: process.platform === 'win32',
		}, (err, stdout) => {
			if (err) {
				reject(new Error(`npm view failed: ${err.message}`));
				return;
			}
			const version = String(stdout).trim();
			if (!version) {
				reject(new Error('npm view returned empty version'));
				return;
			}
			resolve(version);
		});
	});
}

/**
 * 简易 semver 比较：a > b 返回 true
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function isNewerVersion(a, b) {
	// 先比较 major.minor.patch（去掉 pre-release 后缀）
	const parse = (v) => v.replace(/-.*$/, '').split('.').map(Number);
	const pa = parse(a);
	const pb = parse(b);
	for (let i = 0; i < 3; i++) {
		if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
		if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
	}
	// x.y.z 相同时：release > pre-release（semver 规则）
	const aHasPre = a.includes('-');
	const bHasPre = b.includes('-');
	if (bHasPre && !aHasPre) return true;
	return false;
}

/**
 * 检查是否有可用更新
 * @param {object} [opts]
 * @param {Function} [opts.execFileFn] - 可注入的 execFile（测试用）
 * @param {string} [opts.pluginDir] - 插件目录
 * @returns {Promise<{ available: boolean, currentVersion: string, latestVersion?: string, pkgName: string }>}
 */
export async function checkForUpdate(opts) {
	const { name: pkgName, version: currentVersion } = await getPackageInfo(opts?.pluginDir);
	const latestVersion = await getLatestVersion(pkgName, opts);

	await updateLastCheck();

	if (!isNewerVersion(latestVersion, currentVersion)) {
		return { available: false, currentVersion, pkgName };
	}

	// 检查是否在 skippedVersions 中（曾升级失败并回滚的版本）
	const state = await readState();
	const skipped = Array.isArray(state.skippedVersions) ? state.skippedVersions : [];
	if (skipped.includes(latestVersion)) {
		return { available: false, currentVersion, latestVersion, pkgName, skipped: true };
	}

	return { available: true, currentVersion, latestVersion, pkgName };
}
