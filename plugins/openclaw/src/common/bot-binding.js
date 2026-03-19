import { bindWithServer, unbindWithServer, createClaimCodeOnServer, waitClaimCodeOnServer } from '../api.js';
import { clearConfig, readConfig, writeConfig } from '../config.js';

const DEFAULT_SERVER_URL = 'https://im.coclaw.net';

function resolveServerUrl(serverUrl) {
	/* c8 ignore next */
	return serverUrl ?? process.env.COCLAW_SERVER_URL ?? DEFAULT_SERVER_URL;
}

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

export async function enrollBot({ serverUrl }, deps = {}) {
	const { createClaimCode = createClaimCodeOnServer } = deps;
	const baseUrl = resolveServerUrl(serverUrl);
	const data = await createClaimCode({ baseUrl });

	if (!data?.code || !data?.waitToken) {
		throw new Error('invalid enroll response');
	}

	const appUrl = `${baseUrl}/claim?code=${data.code}`;
	return {
		code: data.code,
		expiresAt: data.expiresAt,
		waitToken: data.waitToken,
		appUrl,
		serverUrl: baseUrl,
	};
}

export async function waitForClaimAndSave({ serverUrl, code, waitToken, signal }, deps = {}) {
	const { waitClaimCode = waitClaimCodeOnServer, writeCfg = writeConfig, retryDelayMs = 2000 } = deps;
	const baseUrl = resolveServerUrl(serverUrl);

	// 循环长轮询，直到成功或超时
	for (;;) {
		if (signal?.aborted) {
			throw new Error('enroll cancelled');
		}

		let data;
		try {
			data = await waitClaimCode({ baseUrl, code, waitToken });
		} catch (err) {
			// 认领码已失效 — 不可恢复，退出循环
			if (err?.response?.status === 404) {
				throw new Error('claim code not found or expired');
			}
			// 其他所有错误（HTTP 408/500、网络超时、TimeoutError 等）延迟后重试，
			// 确保后台等待不会因瞬时故障而终止
			await new Promise((r) => setTimeout(r, retryDelayMs));
			continue;
		}

		// 已认领
		if (data?.botId && data?.token) {
			await writeCfg({
				serverUrl: baseUrl,
				botId: data.botId,
				token: data.token,
				boundAt: new Date().toISOString(),
			});
			return { botId: data.botId };
		}

		// PENDING — 延迟后继续轮询
		if (data?.code === 'CLAIM_PENDING') {
			await new Promise((r) => setTimeout(r, retryDelayMs));
			continue;
		}

		// 其他未知状态
		throw new Error(`unexpected claim wait response: ${JSON.stringify(data)}`);
	}
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
