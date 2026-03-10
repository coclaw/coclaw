import { bindWithServer, unbindWithServer } from '../api.js';
import { clearConfig, readConfig, writeConfig } from '../config.js';

const DEFAULT_SERVER_URL = 'https://im.coclaw.net';

export async function bindBot({ code, serverUrl }) {
	if (!code) {
		throw new Error('binding code is required');
	}

	const config = await readConfig();

	// 已绑定时自动解绑再重绑（解绑尽力而为，不阻塞新绑定）
	let previousBotId;
	if (config?.token) {
		previousBotId = config.botId || 'unknown';
		const oldBaseUrl = config.serverUrl;
		if (oldBaseUrl) {
			try {
				await unbindWithServer({ baseUrl: oldBaseUrl, token: config.token });
			} catch {
				// 尽力而为，忽略解绑错误
			}
		}
		await clearConfig();
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

	await writeConfig({
		serverUrl: baseUrl,
		botId: data.botId,
		token: data.token,
		boundAt: new Date().toISOString(),
	});

	return {
		botId: data.botId,
		rebound: Boolean(data.rebound),
		previousBotId,
	};
}

export async function unbindBot({ serverUrl }) {
	const config = await readConfig();
	if (!config?.token) {
		const err = new Error('not bound, nothing to unbind');
		err.code = 'NOT_BOUND';
		throw err;
	}

	const baseUrl = serverUrl ?? config.serverUrl;

	// 用户主动解绑：无论 server 通知成功与否，都清理本地绑定
	let data = null;
	let serverError = null;
	if (baseUrl) {
		try {
			data = await unbindWithServer({
				baseUrl,
				token: config.token,
			});
		}
		catch (err) {
			serverError = err;
		}
	}

	await clearConfig();

	return {
		botId: data?.botId ?? config.botId,
		serverError,
	};
}
