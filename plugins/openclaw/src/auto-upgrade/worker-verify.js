/**
 * worker-verify.js — 升级后验证
 *
 * 策略：触发 gateway restart → 轮询 coclaw.upgradeHealth RPC 直到返回版本
 * ≥ toVersion（等于或更新）。单次调用失败（gateway 未就绪 / plugin 未注册 /
 * JSON 非法 / 版本不够新）一律按"稍后重试"处理，在总超时窗口内持续尝试。
 *
 * 允许 > toVersion 的原因：scheduler 观察到 latest=x 并发起升级后，到实际
 * 执行 `plugins update` 之间 npm dist-tag 可能已指向 x+1；严格等 x 会把
 * 这种"升级到了更新版本"误判为失败并回滚。
 *
 * 磁盘 package.json 的版本仅作为诊断写入本地日志，不参与判定——openclaw 侧
 * `plugins.installs[id].installPath` 可能在 id-migration 等极端场景发生漂移，
 * 而 upgradeHealth 是 gateway 进程内"新代码真的被加载"的权威信号。
 *
 * worker 运行在独立子进程中，禁止使用 remoteLog；诊断信息全部通过 logger
 * （本地日志）输出，由 updater 记录到 upgrade-log.jsonl。
 */
import { execFile as nodeExecFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import nodePath from 'node:path';

// 与 updater-check.js 同逻辑，worker 运行在独立子进程，不跨进程复用 gateway 模块
function isNewerVersion(a, b) {
	const parse = (v) => v.replace(/-.*$/, '').split('.').map(Number);
	const pa = parse(a);
	const pb = parse(b);
	for (let i = 0; i < 3; i++) {
		/* c8 ignore next 2 -- ?? fallback：正常 semver 不会有缺失段 */
		if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
		if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
	}
	// x.y.z 相同时：release > pre-release（semver 规则）
	const aHasPre = a.includes('-');
	const bHasPre = b.includes('-');
	if (bHasPre && !aHasPre) return true;
	return false;
}

const CMD_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 3_000;
// 本机 openclaw 冷启动可能需访问外部资源（AWS 诊断、ollama 探测等）
// 及插件 bootstrap，合计 30~60s 常见；5 分钟给足余量
const HEALTH_TOTAL_TIMEOUT_MS = 5 * 60 * 1000;

// 单调时钟（毫秒，整数）。轮询超时只关心"流逝"，必须避开 Date.now() 的墙钟
// 跳变（NTP 同步、host suspend/resume、WSL2 vmtime sync）—— 这些跳变会让
// loop 误以为已经超时而提前退出
function monoNowMs() {
	return Number(process.hrtime.bigint() / 1_000_000n);
}

/**
 * 执行命令并返回 stdout；错误对象附带 stderr 以便诊断
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts]
 * @param {Function} [opts.execFileFn]
 * @param {number} [opts.cmdTimeoutMs]
 * @returns {Promise<string>}
 */
function runCmd(cmd, args, opts) {
	/* c8 ignore next -- ?./?? fallback */
	const doExecFile = opts?.execFileFn ?? nodeExecFile;
	/* c8 ignore next -- ?./?? fallback */
	const timeout = opts?.cmdTimeoutMs ?? CMD_TIMEOUT_MS;
	return new Promise((resolve, reject) => {
		doExecFile(cmd, args, { timeout, shell: process.platform === 'win32' }, (err, stdout, stderr) => {
			if (err) {
				/* c8 ignore next -- ?? fallback：execFile 实现不保证 stderr 一定字符串化 */
				err.stderr = String(stderr ?? '');
				reject(err);
			}
			else resolve(String(stdout).trim());
		});
	});
}

/**
 * 触发一次 gateway 重启；失败不抛（后续轮询 RPC 会兜底验证 gateway 是否就绪）
 * @param {object} [opts]
 * @param {Function} [opts.execFileFn]
 * @returns {Promise<void>}
 */
export async function triggerGatewayRestart(opts) {
	try {
		await runCmd('openclaw', ['gateway', 'restart'], opts);
	}
	catch {
		// restart 命令本身失败不阻断：openclaw 可能已在重启/daemon 自恢复；
		// 无论如何都进入后续 upgradeHealth 轮询，由它判定 gateway 最终是否可用
	}
}

/**
 * 读取磁盘 package.json 的版本号（诊断用途，不参与判定）
 * @param {string} pluginDir
 * @returns {Promise<string | null>}
 */
export async function readDiskPackageVersion(pluginDir) {
	try {
		const pkgPath = nodePath.join(pluginDir, 'package.json');
		const raw = await readFile(pkgPath, 'utf8');
		const pkg = JSON.parse(raw);
		return typeof pkg?.version === 'string' ? pkg.version : null;
	}
	catch {
		return null;
	}
}

/**
 * 单次调用 coclaw.upgradeHealth；永不抛异常，失败归一化为 { ok: false, reason }
 * @param {object} [opts]
 * @returns {Promise<{ ok: true, version: string } | { ok: false, reason: string }>}
 */
async function callUpgradeHealthOnce(opts) {
	try {
		const output = await runCmd(
			'openclaw',
			['gateway', 'call', 'coclaw.upgradeHealth', '--json'],
			opts,
		);
		let payload;
		try {
			payload = JSON.parse(output);
		}
		catch {
			return { ok: false, reason: `invalid-json: ${output.slice(0, 120)}` };
		}
		if (!payload?.version) return { ok: false, reason: 'missing-version' };
		return { ok: true, version: String(payload.version) };
	}
	catch (err) {
		const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : '';
		/* c8 ignore next -- ?? fallback */
		const msg = err?.message ?? String(err);
		const reason = (stderr || msg || 'unknown').slice(0, 200);
		return { ok: false, reason };
	}
}

/**
 * 轮询 upgradeHealth 直到版本 ≥ toVersion，或总超时
 * @param {string} toVersion
 * @param {object} [opts]
 * @param {Function} [opts.execFileFn]
 * @param {number} [opts.totalTimeoutMs]
 * @param {number} [opts.pollIntervalMs]
 * @param {number} [opts.cmdTimeoutMs]
 * @returns {Promise<{ ok: true, version: string, attempts: number, elapsedMs: number }
 *   | { ok: false, attempts: number, elapsedMs: number, lastReason: string, lastVersion: string }>}
 */
export async function pollUpgradeHealth(toVersion, opts) {
	/* c8 ignore next -- ?? fallback */
	const totalTimeout = opts?.totalTimeoutMs ?? HEALTH_TOTAL_TIMEOUT_MS;
	/* c8 ignore next -- ?? fallback */
	const pollInterval = opts?.pollIntervalMs ?? HEALTH_POLL_INTERVAL_MS;
	const start = monoNowMs();
	let attempts = 0;
	let lastReason = '';
	let lastVersion = '';

	while (monoNowMs() - start < totalTimeout) {
		attempts += 1;
		const result = await callUpgradeHealthOnce(opts);
		if (result.ok) {
			// 等于或更新均视为成功，覆盖"升级窗口期 dist-tag 前移"的情形
			if (result.version === toVersion || isNewerVersion(result.version, toVersion)) {
				return {
					ok: true,
					version: result.version,
					attempts,
					elapsedMs: monoNowMs() - start,
				};
			}
			lastVersion = result.version;
			lastReason = `version-too-old got=${result.version} want>=${toVersion}`;
		}
		else {
			lastReason = result.reason;
		}
		// 剩余时间不足以再等一个 interval 就直接退出，避免最后一次毫无意义的 sleep
		if (monoNowMs() - start + pollInterval >= totalTimeout) break;
		await sleep(pollInterval);
	}

	return {
		ok: false,
		attempts,
		elapsedMs: monoNowMs() - start,
		lastReason,
		lastVersion,
	};
}

/**
 * 完整验证流程：触发 gateway restart → 读磁盘版本（诊断）→ 轮询 upgradeHealth
 * @param {string} pluginDir - 插件安装目录（来自 openclaw.json 的权威 installPath）
 * @param {string} toVersion - 目标版本
 * @param {object} [opts]
 * @param {Function} [opts.execFileFn]
 * @param {number} [opts.totalTimeoutMs]
 * @param {number} [opts.pollIntervalMs]
 * @param {number} [opts.cmdTimeoutMs]
 * @param {Function} [log] - 本地日志函数
 * @returns {Promise<{ ok: true, version: string } | { ok: false, error: string }>}
 */
export async function verifyUpgrade(pluginDir, toVersion, opts, log) {
	const logFn = typeof log === 'function' ? log : () => {};

	await triggerGatewayRestart(opts);

	const onDiskVersion = await readDiskPackageVersion(pluginDir);
	logFn(`[upgrade-worker] On-disk package.json version: ${onDiskVersion ?? '(unreadable)'} (expected ${toVersion})`);

	const result = await pollUpgradeHealth(toVersion, opts);
	if (result.ok) {
		logFn(`[upgrade-worker] upgradeHealth verified: version=${result.version} attempts=${result.attempts} elapsed=${result.elapsedMs}ms`);
		return { ok: true, version: result.version };
	}

	const error = `verify timeout: attempts=${result.attempts} elapsed=${result.elapsedMs}ms lastVersion=${result.lastVersion || '(none)'} lastReason=${result.lastReason || '(none)'}`;
	logFn(`[upgrade-worker] ${error}`);
	return { ok: false, error };
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
