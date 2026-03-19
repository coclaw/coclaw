import { bindBot, unbindBot } from './common/bot-binding.js';
import { resolveErrorMessage } from './common/errors.js';
import { callGatewayMethod } from './common/gateway-notify.js';
import {
	notBound, bindOk, unbindOk,
	gatewayNotified, gatewayNotifyFailed,
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

function resolveServerUrl(opts, config) {
	return opts?.server
		?? config?.plugins?.entries?.['openclaw-coclaw']?.config?.serverUrl
		?? process.env.COCLAW_SERVER_URL;
}

/**
 * 注册 `openclaw coclaw bind/unbind` CLI 子命令
 * @param {object} ctx - OpenClaw CLI 注册上下文
 * @param {import('commander').Command} ctx.program - Commander.js Command 实例
 * @param {object} ctx.config - OpenClaw 配置
 * @param {object} ctx.logger - 日志实例
 * @param {object} [deps] - 可注入依赖（测试用）
 */
export function registerCoclawCli({ program, config, logger }, deps = {}) {
	const notifyGateway = async (method) => {
		const action = method.endsWith('refreshBridge') ? 'refresh' : 'stop';
		try {
			const result = await callGatewayMethod(method, deps.spawn);
			if (result.ok) {
				logger.info?.(`[coclaw] ${gatewayNotified(action)}`);
			} else {
				logger.warn?.(`[coclaw] ${gatewayNotifyFailed()}`);
			}
		}
		/* c8 ignore next 3 -- callGatewayMethod 已内部兜底，此处纯防御 */
		catch {
			logger.warn?.(`[coclaw] ${gatewayNotifyFailed()}`);
		}
	};

	const coclaw = program
		.command('coclaw')
		.description('CoClaw bind/unbind commands');

	coclaw
		.command('bind <code>')
		.description('Bind this OpenClaw instance to CoClaw')
		.option('--server <url>', 'CoClaw server URL')
		.action(async (code, opts) => {
			try {
				// 先断开 bridge，避免 unbindWithServer 触发的 bot.unbound 竞态
				await notifyGateway('coclaw.stopBridge');
				const serverUrl = resolveServerUrl(opts, config);
				const result = await bindBot({ code, serverUrl });
				/* c8 ignore next */
				console.log(bindOk(result));
				await notifyGateway('coclaw.refreshBridge');
			} catch (err) {
				console.error(`Error: ${resolveErrorMessage(err)}`);
				process.exitCode = 1;
			}
		});

	coclaw
		.command('enroll')
		.description('Enroll this OpenClaw instance with CoClaw (generate a claim code for the user)')
		.option('--server <url>', 'CoClaw server URL')
		.action(async (opts) => {
			try {
				const rpcOpts = opts?.server ? { params: { serverUrl: opts.server } } : undefined;
				const callRpc = () => callGatewayMethod('coclaw.enroll', deps.spawn, rpcOpts);

				let result = await callRpc();

				// 仅在 gateway 不可用时重启重试，业务错误不重启
				if (isGatewayUnavailable(result)) {
					logger.info?.('[coclaw] enroll RPC failed, attempting gateway restart...');
					const restartFn = deps.restartGateway ?? restartGatewayProcess;
					try {
						await restartFn(deps.spawn);
					} catch {
						// 重启失败，仍然尝试再次 RPC
					}
					result = await callRpc();
				}

				if (!result.ok) {
					if (isGatewayUnavailable(result)) {
						console.error('Error: Could not reach gateway. Ensure OpenClaw gateway is running.');
						console.error('  Try: openclaw gateway start');
					} else {
						// 业务错误（如已绑定）：输出 gateway 返回的错误信息
						console.error(`Error: ${extractRpcErrorMessage(result.message) || 'enroll failed'}`);
					}
					process.exitCode = 1;
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
		.description('Unbind this OpenClaw instance from CoClaw')
		.option('--server <url>', 'CoClaw server URL')
		.action(async (opts) => {
			try {
				const result = await unbindBot({ serverUrl: opts?.server });
				/* c8 ignore next */
				console.log(unbindOk(result));
				await notifyGateway('coclaw.stopBridge');
			} catch (err) {
				if (err.code === 'NOT_BOUND') {
					console.error(notBound());
					process.exitCode = 1;
					return;
				}
				/* c8 ignore start -- 防御性兜底，unbindBot 当前仅抛 NOT_BOUND */
				console.error(`Error: ${resolveErrorMessage(err)}`);
				process.exitCode = 1;
			}
			/* c8 ignore stop */
		});
}
