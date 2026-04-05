import { bindWithServer, unbindWithServer, createClaimCodeOnServer, waitClaimCodeOnServer } from '../api.js';
import { clearConfig, readConfig, writeConfig } from '../config.js';

const DEFAULT_SERVER_URL = 'https://im.coclaw.net';

function resolveServerUrl(serverUrl) {
	/* c8 ignore next */
	return serverUrl ?? process.env.COCLAW_SERVER_URL ?? DEFAULT_SERVER_URL;
}

// 这些 HTTP 状态码表示 claw 在 server 端已不存在，视为解绑成功
const ALREADY_UNBOUND_STATUSES = new Set([401, 404, 410]);

function isAlreadyUnbound(err) {
	return ALREADY_UNBOUND_STATUSES.has(err?.response?.status);
}

export async function bindClaw({ code, serverUrl }, deps = {}) {
	const {
		readCfg = readConfig,
		clearCfg = clearConfig,
		writeCfg = writeConfig,
		unbindServer = unbindWithServer,
		bindServer = bindWithServer,
	} = deps;

	if (!code) {
		throw new Error('binding code is required');
	}

	const config = await readCfg();

	// 已绑定时必须先解绑旧 claw，避免产生孤儿记录
	let previousClawId;
	if (config?.token) {
		previousClawId = config.clawId || 'unknown';
		const oldBaseUrl = config.serverUrl;
		if (oldBaseUrl) {
			try {
				await unbindServer({ baseUrl: oldBaseUrl, token: config.token });
			} catch (err) {
				if (!isAlreadyUnbound(err)) {
					const rebindErr = new Error(
						`Failed to unbind previous claw (${previousClawId}): ${err.message}. ` +
						'Unbind manually first, then retry.',
					);
					rebindErr.code = 'UNBIND_FAILED';
					throw rebindErr;
				}
			}
		}
		await clearCfg();
	}

	/* c8 ignore next */
	const baseUrl = serverUrl ?? process.env.COCLAW_SERVER_URL ?? DEFAULT_SERVER_URL;
	const data = await bindServer({
		baseUrl,
		code,
	});

	if (!data?.clawId || !data?.token) {
		throw new Error('invalid bind response');
	}

	await writeCfg({
		serverUrl: baseUrl,
		clawId: data.clawId,
		token: data.token,
		boundAt: new Date().toISOString(),
	});

	return {
		clawId: data.clawId,
		rebound: Boolean(data.rebound),
		previousClawId,
	};
}

export async function enrollClaw({ serverUrl }, deps = {}) {
	const { createClaimCode = createClaimCodeOnServer, readCfg = readConfig } = deps;

	const config = await readCfg();
	if (config?.token) {
		const err = new Error('Already bound. Run `openclaw coclaw unbind` to unbind first, then retry.');
		err.code = 'ALREADY_BOUND';
		throw err;
	}

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
		if (data?.clawId && data?.token) {
			await writeCfg({
				serverUrl: baseUrl,
				clawId: data.clawId,
				token: data.token,
				boundAt: new Date().toISOString(),
			});
			return { clawId: data.clawId };
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

export async function unbindClaw({ serverUrl }, deps = {}) {
	const {
		readCfg = readConfig,
		clearCfg = clearConfig,
		unbindServer = unbindWithServer,
	} = deps;

	const config = await readCfg();
	if (!config?.token) {
		const err = new Error('not bound, nothing to unbind');
		err.code = 'NOT_BOUND';
		throw err;
	}

	const baseUrl = serverUrl ?? config.serverUrl;

	if (baseUrl) {
		try {
			await unbindServer({ baseUrl, token: config.token });
		} catch (err) {
			// claw 在 server 已不存在 — 视为解绑成功，继续清理本地
			if (!isAlreadyUnbound(err)) {
				throw err;
			}
		}
	}

	await clearCfg();

	return { clawId: config.clawId };
}
