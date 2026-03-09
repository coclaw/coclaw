import { bindBot, unbindBot } from './common/bot-binding.js';
import { resolveErrorMessage } from './common/errors.js';
import { callGatewayMethod } from './common/gateway-notify.js';
import {
	alreadyBound, notBound, bindOk, unbindOk,
	gatewayNotified, gatewayNotifyFailed,
} from './common/messages.js';

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
				const serverUrl = resolveServerUrl(opts, config);
				const result = await bindBot({ code, serverUrl });
				/* c8 ignore next */
				console.log(bindOk(result));
				await notifyGateway('coclaw.refreshBridge');
			} catch (err) {
				if (err.code === 'ALREADY_BOUND') {
					console.error(alreadyBound(err));
					process.exitCode = 1;
					return;
				}
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
				console.error(`Error: ${resolveErrorMessage(err)}`);
				process.exitCode = 1;
			}
		});
}
