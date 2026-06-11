import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import nodePath from 'node:path';
import { resolveStateDir } from './state.js';

const WORKER_FILENAME = 'worker.js';
// 探针毫秒级完成；短超时防 systemd-run 异常挂起拖住 __check
const PROBE_TIMEOUT_MS = 3_000;

/**
 * 获取 worker.js 的路径
 * @returns {string}
 */
export function getWorkerPath() {
	return nodePath.join(import.meta.dirname, WORKER_FILENAME);
}

/**
 * 是否值得尝试 systemd scope 脱逃。
 * gateway 跑在 systemd service 形态（KillMode=control-group）时，worker 虽
 * detached 仍在同一 cgroup，自己触发的 `gateway restart` 会把整组杀掉——
 * 重启后的验证/回滚/记账全部不可达。仅 linux 且疑似 systemd 环境（unit 注入
 * 的环境变量在场）才探针，其它形态零改动。
 * @param {string} platform
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
export function shouldAttemptScopeEscape(platform, env) {
	return platform === 'linux' && Boolean(env.OPENCLAW_SYSTEMD_UNIT || env.INVOCATION_ID);
}

/**
 * 探针：试跑 `systemd-run [--user] --scope --quiet --collect -- /bin/true`，
 * 先 --user 变体（user service 推荐形态），失败再试无 --user（system service）。
 * @param {object} [opts]
 * @param {Function} [opts.execFileFn] - 可注入的 execFile（测试用）
 * @returns {Promise<string[]|null>} 可用变体的附加参数（['--user'] 或 []）；都不可用返回 null
 */
export async function probeSystemdScopeArgs(opts) {
	/* c8 ignore next -- ?./?? fallback */
	const doExecFile = opts?.execFileFn ?? nodeExecFile;
	const tryVariant = (variant) => new Promise((resolve) => {
		try {
			doExecFile(
				'systemd-run',
				[...variant, '--scope', '--quiet', '--collect', '--', '/bin/true'],
				{ timeout: PROBE_TIMEOUT_MS },
				(err) => resolve(!err),
			);
		}
		catch {
			// 注入实现同步抛错（如 systemd-run 不存在的极端实现）按失败处理
			resolve(false);
		}
	});
	if (await tryVariant(['--user'])) return ['--user'];
	if (await tryVariant([])) return [];
	return null;
}

/**
 * 以 detached 进程方式启动 upgrade worker
 *
 * 使用 process.execPath 确保与 gateway 使用同一 node 版本。
 * detached + unref 确保 gateway 进程不会等待 worker。
 * 通过 -- 命名参数传递业务数据，worker 使用 util.parseArgs 解析。
 *
 * systemd 环境下探针通过则包成 `systemd-run [--user] --scope --quiet --collect
 * -- <node> worker.js ...`：scope 是 service 的兄弟 cgroup，KillMode=control-group
 * 清场打不到；--scope 自挪 cgroup 后 exec、不产生 wrapper 进程，child.pid 即
 * worker 真 pid → 锁机制零改动。探针失败 → 现行裸 spawn（降级=现状），由调用方
 * 据 escapeFailed 发去重信号。真 worker 永远只 spawn 一次，没有失败重拉。
 *
 * @param {object} params
 * @param {string} params.pluginDir - 插件安装目录
 * @param {string} params.fromVersion - 当前版本
 * @param {string} params.toVersion - 目标版本
 * @param {string} [params.baselineVersion] - 升级前权威安装记录的版本（L2 结局核对基线；可缺）
 * @param {string} params.pluginId - 插件 ID
 * @param {string} params.pkgName - npm 包名
 * @param {object} [params.opts]
 * @param {Function} [params.opts.spawnFn] - 可注入的 spawn（测试用）
 * @param {Function} [params.opts.execFileFn] - 可注入的 execFile（探针，测试用）
 * @param {string} [params.opts.platform] - 平台覆盖（测试用）
 * @param {NodeJS.ProcessEnv} [params.opts.scopeEnv] - 探针启用判定的 env 覆盖（测试用）
 * @param {object} [params.logger] - 需提供 .info() 方法（如 pino/gateway logger）
 * @returns {Promise<{ child: object, escapeFailed: boolean }>} escapeFailed：疑似 systemd
 *   环境但两个探针变体都失败（降级裸 spawn），调用方据此发信号
 */
export async function spawnUpgradeWorker({ pluginDir, fromVersion, toVersion, baselineVersion, pluginId, pkgName, opts, logger }) {
	/* c8 ignore next -- ?./?? fallback */
	const doSpawn = opts?.spawnFn ?? nodeSpawn;
	/* c8 ignore next -- ?./?? fallback */
	const platform = opts?.platform ?? process.platform;
	/* c8 ignore next -- ?./?? fallback */
	const scopeEnv = opts?.scopeEnv ?? process.env;
	const workerPath = getWorkerPath();

	logger?.info?.(`[spawner] Spawning upgrade worker: ${fromVersion} → ${toVersion}`);

	let scopeArgs = null;
	let escapeFailed = false;
	if (shouldAttemptScopeEscape(platform, scopeEnv)) {
		scopeArgs = await probeSystemdScopeArgs(opts);
		if (scopeArgs) {
			logger?.info?.(`[spawner] systemd scope escape enabled (${scopeArgs.includes('--user') ? 'user' : 'system'} variant)`);
		}
		else {
			escapeFailed = true;
			logger?.warn?.('[spawner] systemd scope probe failed, falling back to bare spawn (worker may die on gateway restart)');
		}
	}

	// 将 state dir 传递给 worker，确保 worker 写入正确的路径
	const stateDir = resolveStateDir();
	const env = { ...process.env };
	if (stateDir) env.OPENCLAW_STATE_DIR = stateDir;

	const args = [
		workerPath,
		'--pluginDir', pluginDir,
		'--fromVersion', fromVersion,
		'--toVersion', toVersion,
		'--pluginId', pluginId,
		'--pkgName', pkgName,
	];
	// 基线缺失时不传 flag，worker 按"基线不可得"退化处理
	if (baselineVersion) {
		args.push('--baselineVersion', baselineVersion);
	}

	let spawnCmd = process.execPath;
	let spawnArgs = args;
	if (scopeArgs) {
		spawnCmd = 'systemd-run';
		spawnArgs = [...scopeArgs, '--scope', '--quiet', '--collect', '--', process.execPath, ...args];
	}

	const child = doSpawn(spawnCmd, spawnArgs, {
		detached: true,
		stdio: 'ignore',
		env,
		windowsHide: true,
	});

	// spawn 失败时 Node.js 会异步 emit 'error'；若无监听器则变为未捕获异常导致 gateway 崩溃
	child.on('error', (err) => {
		logger?.warn?.(`[spawner] Worker spawn error: ${err.message}`);
	});
	child.unref();

	logger?.info?.(`[spawner] Worker spawned (pid: ${child.pid})`);
	return { child, escapeFailed };
}
