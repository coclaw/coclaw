#!/usr/bin/env node
import nodePath from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { bindBot, unbindBot } from './common/bot-binding.js';
import { resolveErrorMessage } from './common/errors.js';
import { callGatewayMethod } from './common/gateway-notify.js';
import {
	notBound, bindOk, unbindOk,
	gatewayNotified, gatewayNotifyFailed,
} from './common/messages.js';

function parseArgs(argv) {
	const [command, ...rest] = argv;
	const options = {};
	const positionals = [];

	for (let i = 0; i < rest.length; i += 1) {
		const token = rest[i];
		if (token === '--server' && i + 1 < rest.length) {
			options.server = rest[i + 1];
			i += 1;
			continue;
		}
		positionals.push(token);
	}

	return {
		command,
		positionals,
		options,
	};
}

function printHelp() {
	console.log('Usage: coclaw <bind|unbind> [args] [--server <url>]');
	console.log('');
	console.log('Commands:');
	console.log('  bind <binding-code>');
	console.log('  unbind');
}

async function notifyGateway(method, deps) {
	const action = method.endsWith('refreshBridge') ? 'refresh' : 'stop';
	try {
		const result = await callGatewayMethod(method, deps.spawn);
		if (result.ok) {
			console.log(gatewayNotified(action));
		} else {
			console.warn(gatewayNotifyFailed());
		}
	}
	/* c8 ignore next 3 -- callGatewayMethod 已内部兜底，此处纯防御 */
	catch {
		console.warn(gatewayNotifyFailed());
	}
}

export async function main(argv = process.argv.slice(2), deps = {}) {
	const { command, positionals, options } = parseArgs(argv);

	if (!command || command === '--help' || command === '-h') {
		printHelp();
		return 0;
	}

	if (command === 'bind') {
		// 先断开 bridge，避免 unbindWithServer 触发的 bot.unbound 竞态
		await notifyGateway('coclaw.stopBridge', deps);
		const result = await bindBot({
			code: positionals[0],
			serverUrl: options.server,
		});
		/* c8 ignore next */
		console.log(bindOk(result));
		await notifyGateway('coclaw.refreshBridge', deps);
		return 0;
	}

	if (command === 'unbind') {
		try {
			const result = await unbindBot({
				serverUrl: options.server,
			});
			/* c8 ignore next */
			console.log(unbindOk(result));
			await notifyGateway('coclaw.stopBridge', deps);
			return 0;
		} catch (err) {
			if (err.code === 'NOT_BOUND') {
				console.error(notBound());
				return 1;
			}
			/* c8 ignore start -- 防御性兜底，unbindBot 当前仅抛 NOT_BOUND */
			throw err;
		}
		/* c8 ignore stop */
	}

	throw new Error(`unknown command: ${command}`);
}

/* c8 ignore start */
function isCliEntrypoint() {
	const argvPath = process.argv[1];
	if (!argvPath) {
		return false;
	}
	return import.meta.url === pathToFileURL(nodePath.resolve(argvPath)).href;
}
/* c8 ignore stop */

/* c8 ignore start */
if (isCliEntrypoint()) {
	process.on('uncaughtException', (err) => {
		console.error('[coclaw] uncaughtException:', err?.stack ?? err);
	});
	process.on('unhandledRejection', (err) => {
		console.error('[coclaw] unhandledRejection:', err?.stack ?? err);
	});

	main().catch((err) => {
		console.error(`[coclaw] ${resolveErrorMessage(err)}`);
		process.exitCode = 1;
	});
}
/* c8 ignore stop */
