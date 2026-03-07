import { bindWithServer, unbindWithServer } from '../api.js';
import { clearConfig, readConfig, writeConfig } from '../config.js';

const DEFAULT_SERVER_URL = 'http://127.0.0.1:3000';

export async function bindBot({ code, serverUrl }) {
	if (!code) {
		throw new Error('binding code is required');
	}

	const config = await readConfig();
	if (config?.token) {
		const err = new Error('already bound, please unbind first');
		err.code = 'ALREADY_BOUND';
		err.botId = config.botId;
		throw err;
	}

	/* c8 ignore next */
	const baseUrl = serverUrl ?? process.env.COCLAW_SERVER_URL ?? DEFAULT_SERVER_URL;
	const data = await bindWithServer({
		baseUrl,
		code,
	});

	if (!data?.botId || !data?.token) {
		throw new Error('invalid bind response');
	}

	const next = {
		...config,
		serverUrl: baseUrl,
		botId: data.botId,
		token: data.token,
		boundAt: new Date().toISOString(),
	};
	await writeConfig(next);

	return {
		botId: data.botId,
		rebound: Boolean(data.rebound),
	};
}

export async function unbindBot({ serverUrl }) {
	const config = await readConfig();
	if (!config?.token) {
		const err = new Error('not bound, nothing to unbind');
		err.code = 'NOT_BOUND';
		throw err;
	}

	/* c8 ignore next */
	const baseUrl = serverUrl ?? config.serverUrl ?? process.env.COCLAW_SERVER_URL ?? DEFAULT_SERVER_URL;
	let data = null;
	let alreadyServerUnbound = false;
	try {
		data = await unbindWithServer({
			baseUrl,
			token: config.token,
		});
	}
	catch (err) {
		if (err?.response?.data?.code !== 'UNAUTHORIZED') {
			throw err;
		}
		alreadyServerUnbound = true;
	}

	await clearConfig();

	return {
		botId: data?.botId ?? config.botId,
		alreadyServerUnbound,
	};
}
