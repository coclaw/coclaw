import { spawn as nodeSpawn } from 'node:child_process';
import nodePath from 'node:path';
import { resolveStateDir } from './state.js';

const WORKER_FILENAME = 'worker.js';

/**
 * 获取 worker.js 的路径
 * @returns {string}
 */
export function getWorkerPath() {
	return nodePath.join(import.meta.dirname, WORKER_FILENAME);
}

/**
 * 以 detached 进程方式启动 upgrade worker
 *
 * 使用 process.execPath 确保与 gateway 使用同一 node 版本。
 * detached + unref 确保 gateway 进程不会等待 worker。
 * 通过 -- 命名参数传递业务数据，worker 使用 util.parseArgs 解析。
 *
 * @param {object} params
 * @param {string} params.pluginDir - 插件安装目录
 * @param {string} params.fromVersion - 当前版本
 * @param {string} params.toVersion - 目标版本
 * @param {string} params.pluginId - 插件 ID
 * @param {string} params.pkgName - npm 包名
 * @param {object} [params.opts]
 * @param {Function} [params.opts.spawnFn] - 可注入的 spawn（测试用）
 * @param {object} [params.logger] - 需提供 .info() 方法（如 pino/gateway logger）
 * @returns {{ child: object }}
 */
export function spawnUpgradeWorker({ pluginDir, fromVersion, toVersion, pluginId, pkgName, opts, logger }) {
	const doSpawn = opts?.spawnFn ?? nodeSpawn;
	const workerPath = getWorkerPath();

	logger?.info?.(`[spawner] Spawning upgrade worker: ${fromVersion} → ${toVersion}`);

	// 将 state dir 传递给 worker，确保 worker 写入正确的路径
	const stateDir = resolveStateDir();
	const env = { ...process.env };
	if (stateDir) env.OPENCLAW_STATE_DIR = stateDir;

	const child = doSpawn(process.execPath, [
		workerPath,
		'--pluginDir', pluginDir,
		'--fromVersion', fromVersion,
		'--toVersion', toVersion,
		'--pluginId', pluginId,
		'--pkgName', pkgName,
	], {
		detached: true,
		stdio: 'ignore',
		env,
	});

	// spawn 失败时 Node.js 会异步 emit 'error'；若无监听器则变为未捕获异常导致 gateway 崩溃
	child.on('error', (err) => {
		logger?.warn?.(`[spawner] Worker spawn error: ${err.message}`);
	});
	child.unref();

	logger?.info?.(`[spawner] Worker spawned (pid: ${child.pid})`);
	return { child };
}

