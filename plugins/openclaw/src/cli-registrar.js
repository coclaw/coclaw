import { resolveErrorMessage } from './common/errors.js';
import { callGatewayMethod } from './common/gateway-notify.js';
import {
	notBound, bindOk, unbindOk,
	claimCodeCreated,
} from './common/messages.js';

/**
 * 从 `openclaw gateway call` stderr 中提取核心错误信息
 * stderr 格式：`Gateway call failed: GatewayClientRequestError: <message>`
 */
function extractRpcErrorMessage(raw) {
	if (!raw) return '';
	const match = raw.match(/GatewayClientRequestError:\s*(.+)/);
	return match ? match[1].trim() : raw;
}

const GATEWAY_UNAVAILABLE_ERRORS = new Set([
	'spawn_error', 'spawn_failed', 'timeout', 'empty_output',
]);

function isGatewayUnavailable(result) {
	// exit_code_* 不视为 gateway 不可用：进程已启动成功，非零退出通常是业务错误
	return !result.ok && GATEWAY_UNAVAILABLE_ERRORS.has(result.error);
}

/* c8 ignore start -- 集成级函数，测试通过 deps.restartGateway 注入替代 */
async function restartGatewayProcess(spawnFn) {
	const { spawn: nodeSpawn } = await import('node:child_process');
	const doSpawn = spawnFn ?? nodeSpawn;
	await new Promise((resolve, reject) => {
		const child = doSpawn('openclaw', ['gateway', 'restart'], {
			stdio: 'ignore',
			shell: process.platform === 'win32',
		});
		child.on('close', (exitCode) => exitCode === 0 ? resolve() : reject(new Error(`exit ${exitCode}`)));
		child.on('error', reject);
	});
	// 等待 gateway 就绪
	await new Promise((r) => setTimeout(r, 3000));
}
/* c8 ignore stop */

// bind/unbind/enroll 的 RPC 超时（覆盖 openclaw gateway call 默认 10s）
// 卡点是 gateway ↔ server 的网络通信，bind 最多两次（先解绑再绑定）
const RPC_TIMEOUT_MS = 30_000;

/**
 * 通用 RPC 调用：gateway 不可用时重启重试
 */
async function callWithRetry(method, deps, rpcOpts) {
	const callRpc = () => callGatewayMethod(method, deps.spawn, rpcOpts);

	let result = await callRpc();

	if (isGatewayUnavailable(result)) {
		const restartFn = deps.restartGateway ?? restartGatewayProcess;
		try {
			await restartFn(deps.spawn);
		} catch {
			// 重启失败，仍然尝试再次 RPC
		}
		result = await callRpc();
	}

	return result;
}

/**
 * 通用 RPC 错误输出
 */
function handleRpcError(result, fallbackMsg) {
	if (isGatewayUnavailable(result)) {
		console.error('Error: Could not reach gateway. Ensure OpenClaw gateway is running.');
		console.error('  Try: openclaw gateway start');
	} else {
		console.error(`Error: ${extractRpcErrorMessage(result.message) || fallbackMsg}`);
	}
	process.exitCode = 1;
}

/**
 * 注册 `openclaw coclaw bind/unbind/enroll` CLI 子命令
 * bind/unbind/enroll 均为瘦 CLI，通过 gateway RPC 执行
 * @param {object} ctx - OpenClaw CLI 注册上下文
 * @param {import('commander').Command} ctx.program - Commander.js Command 实例
 * @param {object} ctx.logger - 日志实例
 * @param {object} [deps] - 可注入依赖（测试用）
 */
export function registerCoclawCli({ program, logger: _logger }, deps = {}) {
	const coclaw = program
		.command('coclaw')
		.description('CoClaw bind/unbind commands');

	coclaw
		.command('bind <code>')
		.description('Bind this Claw to CoClaw')
		.option('--server <url>', 'CoClaw server URL')
		.action(async (code, opts) => {
			try {
				const params = { code };
				if (opts?.server) params.serverUrl = opts.server;
				const result = await callWithRetry('coclaw.bind', deps, { params, timeoutMs: RPC_TIMEOUT_MS });

				if (!result.ok) {
					if (result.message && /NOT_BOUND|UNBIND_FAILED/.test(result.message)) {
						console.error(`Error: ${extractRpcErrorMessage(result.message) || 'bind failed'}`);
						process.exitCode = 1;
						return;
					}
					handleRpcError(result, 'bind failed');
					return;
				}

				const data = result.status;
				console.log(bindOk(data));
			}
			/* c8 ignore next 4 -- callGatewayMethod 不会抛异常，纯防御 */
			catch (err) {
				console.error(`Error: ${resolveErrorMessage(err)}`);
				process.exitCode = 1;
			}
		});

	coclaw
		.command('enroll')
		.description('Enroll this Claw with CoClaw (generate a claim code for the user)')
		.option('--server <url>', 'CoClaw server URL')
		.action(async (opts) => {
			try {
				const rpcOpts = { timeoutMs: RPC_TIMEOUT_MS };
				if (opts?.server) rpcOpts.params = { serverUrl: opts.server };
				const result = await callWithRetry('coclaw.enroll', deps, rpcOpts);

				if (!result.ok) {
					handleRpcError(result, 'enroll failed');
					return;
				}

				// RPC 成功：输出认领码信息
				// gateway method 的 respond 数据包含 status 字段
				const data = result.status;
				if (data?.code && data?.appUrl) {
					console.log(claimCodeCreated({
						code: data.code,
						appUrl: data.appUrl,
						expiresMinutes: data.expiresMinutes ?? 30,
					}));
				} else {
					console.log('Enroll request sent to gateway.');
				}
			}
			/* c8 ignore next 4 -- callGatewayMethod 不会抛异常，纯防御 */
			catch (err) {
				console.error(`Error: ${resolveErrorMessage(err)}`);
				process.exitCode = 1;
			}
		});

	coclaw
		.command('unbind')
		.description('Unbind this Claw from CoClaw')
		.option('--server <url>', 'CoClaw server URL')
		.action(async (opts) => {
			try {
				const rpcOpts = { timeoutMs: RPC_TIMEOUT_MS };
				if (opts?.server) rpcOpts.params = { serverUrl: opts.server };
				const result = await callWithRetry('coclaw.unbind', deps, rpcOpts);

				if (!result.ok) {
					if (result.message && /NOT_BOUND/.test(result.message)) {
						console.error(notBound());
					} else {
						handleRpcError(result, 'unbind failed');
					}
					process.exitCode = 1;
					return;
				}

				const data = result.status;
				console.log(unbindOk(data));
			}
			/* c8 ignore next 4 -- callGatewayMethod 不会抛异常，纯防御 */
			catch (err) {
				console.error(`Error: ${resolveErrorMessage(err)}`);
				process.exitCode = 1;
			}
		});
}
