/**
 * worker-verify.js — 升级后验证
 *
 * 三步验证策略（任一失败即判定升级失败）：
 * 1. Gateway 存活：轮询 `openclaw gateway status`，超时 60s
 * 2. 插件已加载：`openclaw plugins list` 包含指定插件
 * 3. 升级模块健康：`openclaw gateway call coclaw.upgradeHealth` 返回版本号
 *
 * 第 3 步同时验证了插件代码能正常执行、gateway method 注册链路正常，
 * 确保插件仍具备自我升级能力。
 */
import { execFile as nodeExecFile } from 'node:child_process';

const GATEWAY_READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2000;
const CMD_TIMEOUT_MS = 30_000;

/**
 * 执行命令并返回 stdout
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts]
 * @param {Function} [opts.execFileFn]
 * @returns {Promise<string>}
 */
function runCmd(cmd, args, opts) {
	/* c8 ignore next -- ?./?? fallback */
	const doExecFile = opts?.execFileFn ?? nodeExecFile;
	return new Promise((resolve, reject) => {
		doExecFile(cmd, args, { timeout: CMD_TIMEOUT_MS, shell: process.platform === 'win32' }, (err, stdout) => {
			if (err) reject(err);
			else resolve(String(stdout).trim());
		});
	});
}

/**
 * 步骤 1：等待 gateway 恢复运行
 * @param {object} [opts]
 * @param {Function} [opts.execFileFn]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.pollIntervalMs]
 * @returns {Promise<void>}
 */
export async function waitForGateway(opts) {
	// 主动触发重启，不依赖 OpenClaw 的文件变更自动重启策略
	try {
		await runCmd('openclaw', ['gateway', 'restart'], opts);
	}
	catch {
		// restart 命令失败不阻断流程，仍尝试等待
	}

	/* c8 ignore next 2 -- ?./?? fallback */
	const timeout = opts?.timeoutMs ?? GATEWAY_READY_TIMEOUT_MS;
	const interval = opts?.pollIntervalMs ?? POLL_INTERVAL_MS;
	const start = Date.now();

	while (Date.now() - start < timeout) {
		try {
			const output = await runCmd('openclaw', ['gateway', 'status'], opts);
			if (output.includes('running')) return;
		}
		catch {
			// gateway 未就绪，继续轮询
		}
		await sleep(interval);
	}

	throw new Error('Gateway did not become ready within timeout');
}

/**
 * 步骤 2：验证插件已加载
 * @param {string} pluginId - 插件 ID
 * @param {object} [opts]
 * @param {Function} [opts.execFileFn]
 * @returns {Promise<void>}
 */
export async function verifyPluginLoaded(pluginId, opts) {
	const output = await runCmd('openclaw', ['plugins', 'list'], opts);
	if (!output.includes(pluginId)) {
		throw new Error(`Plugin ${pluginId} not found in plugins list`);
	}
}

/**
 * 步骤 3：验证升级模块健康
 * @param {object} [opts]
 * @param {Function} [opts.execFileFn]
 * @returns {Promise<string>} 返回版本号
 */
export async function verifyUpgradeHealth(opts) {
	const output = await runCmd(
		'openclaw',
		['gateway', 'call', 'coclaw.upgradeHealth', '--json'],
		opts,
	);
	try {
		const result = JSON.parse(output);
		if (!result.version) {
			throw new Error('upgradeHealth response missing version');
		}
		return result.version;
	}
	catch (err) {
		if (err.message?.includes('upgradeHealth')) throw err;
		throw new Error(`Failed to parse upgradeHealth response: ${output}`);
	}
}

/**
 * 执行完整验证流程
 * @param {string} pluginId - 插件 ID
 * @param {object} [opts]
 * @param {Function} [opts.execFileFn]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.pollIntervalMs]
 * @returns {Promise<{ ok: boolean, version?: string, error?: string }>}
 */
export async function verifyUpgrade(pluginId, opts) {
	try {
		await waitForGateway(opts);
		await verifyPluginLoaded(pluginId, opts);
		const version = await verifyUpgradeHealth(opts);
		return { ok: true, version };
	}
	catch (err) {
		/* c8 ignore next -- ?./?? fallback */
		return { ok: false, error: String(err?.message ?? err) };
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
