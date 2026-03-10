import { bindBot, unbindBot } from './src/common/bot-binding.js';
import { registerCoclawCli } from './src/cli-registrar.js';
import { resolveErrorMessage } from './src/common/errors.js';
import { notBound, bindOk, unbindOk } from './src/common/messages.js';
import { coclawChannelPlugin } from './src/channel-plugin.js';
import { refreshRealtimeBridge, startRealtimeBridge, stopRealtimeBridge } from './src/realtime-bridge.js';
import { setRuntime } from './src/runtime.js';
import { createSessionManager } from './src/session-manager/manager.js';


function parseCommandArgs(args) {
	/* c8 ignore next */
	const tokens = (args ?? '').split(/\s+/).filter(Boolean);
	/* c8 ignore next */
	const action = tokens[0] ?? 'help';
	const options = {};
	const positionals = [];

	for (let i = 1; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token === '--server' && i + 1 < tokens.length) {
			options.server = tokens[i + 1];
			i += 1;
			continue;
		}
		positionals.push(token);
	}

	return { action, positionals, options };
}

function buildHelpText() {
	return [
		'CoClaw command:',
		'',
		'/coclaw bind <binding-code> [--server <url>]',
		'/coclaw unbind [--server <url>]',
	].join('\n');
}

function respondError(respond, err) {
	respond(false, {
		/* c8 ignore next */
		error: String(err?.message ?? err),
	});
}

/* c8 ignore start */
const plugin = {
	id: 'openclaw-coclaw',
	name: 'CoClaw',
	description: 'OpenClaw CoClaw channel plugin for remote chat',
	register(api) {
		setRuntime(api.runtime);
		const logger = api?.logger ?? console;
		const manager = createSessionManager({ logger });

		api.registerChannel({ plugin: coclawChannelPlugin });
		api.registerService({
			id: 'coclaw-realtime-bridge',
			async start() {
				await startRealtimeBridge({ logger, pluginConfig: api.pluginConfig });
			},
			async stop() {
				await stopRealtimeBridge();
			},
		});

		api.registerGatewayMethod('coclaw.refreshBridge', async ({ respond }) => {
			try {
				await refreshRealtimeBridge();
				respond(true, { status: 'refreshed' });
			}
			catch (err) {
				respondError(respond, err);
			}
		});

		api.registerGatewayMethod('coclaw.stopBridge', async ({ respond }) => {
			try {
				await stopRealtimeBridge();
				respond(true, { status: 'stopped' });
			}
			catch (err) {
				respondError(respond, err);
			}
		});

		api.registerGatewayMethod('nativeui.sessions.listAll', ({ params, respond }) => {
			try {
				respond(true, manager.listAll(params ?? {}));
			}
			catch (err) {
				respondError(respond, err);
			}
		});

		api.registerGatewayMethod('nativeui.sessions.get', ({ params, respond }) => {
			try {
				respond(true, manager.get(params ?? {}));
			}
			catch (err) {
				respondError(respond, err);
			}
		});

		api.registerCli(registerCoclawCli, { commands: ['coclaw'] });

		api.registerCommand({
			name: 'coclaw',
			description: 'CoClaw bind/unbind command',
			acceptsArgs: true,
			handler: async (ctx) => {
				const { action, positionals, options } = parseCommandArgs(ctx.args);
				if (action === 'help') {
					return { text: buildHelpText() };
				}

				try {
					if (action === 'bind') {
						const serverUrl = options.server ?? api.pluginConfig?.serverUrl;
						const result = await bindBot({
							code: positionals[0],
							serverUrl,
						});
						await refreshRealtimeBridge();
						return { text: bindOk(result) };
					}

					if (action === 'unbind') {
						const result = await unbindBot({ serverUrl: options.server });
						await stopRealtimeBridge();
						return { text: unbindOk(result) };
					}

					return { text: buildHelpText() };
				}
				catch (err) {
					if (err.code === 'NOT_BOUND') {
						return { text: notBound() };
					}
					logger.warn?.(`[coclaw] command failed: ${String(err?.message ?? err)}`);
					return {
						text: `Error: ${resolveErrorMessage(err)}`,
					};
				}
			},
		});
	},
};
/* c8 ignore stop */

export default plugin;
