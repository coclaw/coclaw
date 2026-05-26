/**
 * minimax-oauth.js —— 复刻 MiniMax 设备码（device-code）OAuth 流
 *
 * 上游无给第三方插件用的"发起 OAuth 登录"入口（登录是 provider 私有 auth method，
 * 由 CLI 交互式 prompter 驱动），所以 CoClaw 自己复刻这套标准设备码流。端点 / client_id /
 * scope / 轮询语义全部抄 openclaw-repo/extensions/minimax/oauth.ts，**共用同一 client_id**
 * （token 最终要被 OpenClaw 自带的 minimax bundled 扩展认）。详见 docs/model-config-api.md § 2.3。
 *
 * 设计要点：
 * - **注入式依赖**：fetch / PKCE 生成器 / 表单编码器 / 随机数 / sleep / now 全部可注入，
 *   单测免网、不误触 global fetch；生产由 ./index.js 用 SDK + 全局 fetch 装配
 * - `requestDeviceCode`：PKCE → POST /oauth/code，拿 user_code / verification_uri /
 *   expired_in（**绝对 ms epoch 截止时刻**，与上游 `while (Date.now() < expired_in)` 同义）/ interval
 * - `pollUntilSettled`：单 async 循环轮询 POST /oauth/token，pending→sleep 再轮；
 *   success / error / 到期 / abort 四个出口，以 expired_in 为自身超时保证终态必在窗口内 fire
 *
 * 注意两个 baseUrl 不是一回事：
 * - OAuth 端点 base（建 /oauth/code、/oauth/token）：cn `https://api.minimaxi.com`
 * - provider 配置 baseUrl 兜底（写 cfg 的 models.providers）：cn `https://api.minimaxi.com/anthropic`
 *   （登录成功优先用服务端动态返回的 resourceUrl，缺省才回落到这个）
 */

import { randomBytes, randomUUID } from 'node:crypto';

const OAUTH_REGION_CONFIG = {
	cn: { baseUrl: 'https://api.minimaxi.com', clientId: '78257093-7e40-4613-99e0-527b14b39113' },
	global: { baseUrl: 'https://api.minimax.io', clientId: '78257093-7e40-4613-99e0-527b14b39113' },
};

const OAUTH_SCOPE = 'group_id profile model.completion';
const OAUTH_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:user_code';

// 轮询间隔下限：服务端可能给更小或不给，统一兜到 2s（与上游一致）
const MIN_POLL_INTERVAL = 2000;

// 跑模型用的 provider 节点 id（"token plan" 无独立 id，凭据 + 配置都落这）
export const PORTAL_PROVIDER_ID = 'minimax-portal';

// 写 cfg 的 baseUrl 兜底（带 /anthropic 后缀，区别于 OAuth 端点 base）
export const CONFIG_DEFAULT_BASE_URL = {
	cn: 'https://api.minimaxi.com/anthropic',
	global: 'https://api.minimax.io/anthropic',
};

export const VALID_REGIONS = new Set(['cn', 'global']);

function getEndpoints(region) {
	const cfg = OAUTH_REGION_CONFIG[region];
	return {
		codeEndpoint: `${cfg.baseUrl}/oauth/code`,
		tokenEndpoint: `${cfg.baseUrl}/oauth/token`,
		clientId: cfg.clientId,
	};
}

/**
 * 默认 sleep：到点或 abort 任一即 resolve。abort 时立即清 timer 提前返回，
 * 让轮询循环回到顶部判定 signal.aborted。
 * 导出供单测直接覆盖三条路径（已 abort / 正常到点 / sleep 中途 abort）。
 */
export function defaultSleep(ms, signal) {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener?.('abort', onAbort);
			resolve();
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener?.('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener?.('abort', onAbort, { once: true });
	});
}

/**
 * 解析 /oauth/token 响应（抄上游 pollOAuthToken 的容错语义）。
 * @returns {{status:'pending'}|{status:'success',token:object}|{status:'error',message:string}}
 */
async function parseTokenResponse(response) {
	const text = await response.text();
	let payload;
	if (text) {
		try { payload = JSON.parse(text); }
		catch { payload = undefined; }
	}
	if (!response.ok) {
		return {
			status: 'error',
			message: (payload?.base_resp?.status_msg ?? text) || 'MiniMax OAuth failed to parse response.',
		};
	}
	if (!payload) {
		return { status: 'error', message: 'MiniMax OAuth failed to parse response.' };
	}
	if (payload.status === 'error') {
		return { status: 'error', message: 'An error occurred. Please try again later' };
	}
	if (payload.status !== 'success') {
		return { status: 'pending' };
	}
	if (!payload.access_token || !payload.refresh_token || !payload.expired_in) {
		return { status: 'error', message: 'MiniMax OAuth returned incomplete token payload.' };
	}
	return {
		status: 'success',
		token: {
			access: payload.access_token,
			refresh: payload.refresh_token,
			expires: payload.expired_in,
			resourceUrl: payload.resource_url,
		},
	};
}

/**
 * 构造一套设备码流原语，依赖全部可注入。
 *
 * @param {object} deps
 * @param {Function} deps.generatePkce - () → { verifier, challenge }（来自 SDK generatePkceVerifierChallenge）
 * @param {Function} deps.toForm - (obj) → x-www-form-urlencoded 串（来自 SDK toFormUrlEncoded）
 * @param {Function} [deps.fetchImpl] - fetch 实现，默认 globalThis.fetch
 * @param {Function} [deps.randomState] - () → state 串，默认 crypto 16 字节 base64url
 * @param {Function} [deps.randomRequestId] - () → x-request-id，默认 randomUUID
 * @param {Function} [deps.sleep] - (ms, signal) → Promise，默认到点/abort resolve
 * @param {Function} [deps.now] - () → ms epoch，默认 Date.now
 * @returns {{ requestDeviceCode: Function, pollUntilSettled: Function }}
 */
export function createMiniMaxOAuth(deps) {
	const {
		generatePkce,
		toForm,
		fetchImpl = globalThis.fetch,
		randomState = () => randomBytes(16).toString('base64url'),
		randomRequestId = () => randomUUID(),
		sleep = defaultSleep,
		now = () => Date.now(),
	} = deps;

	/**
	 * 发起设备码请求。
	 * @param {object} args
	 * @param {string} args.region - 'cn' | 'global'
	 * @returns {Promise<{verifier:string, userCode:string, verificationUri:string, expiresAt:number, interval:number}>}
	 */
	async function requestDeviceCode({ region }) {
		const { verifier, challenge } = generatePkce();
		const state = randomState();
		const endpoints = getEndpoints(region);
		const response = await fetchImpl(endpoints.codeEndpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				Accept: 'application/json',
				'x-request-id': randomRequestId(),
			},
			body: toForm({
				response_type: 'code',
				client_id: endpoints.clientId,
				scope: OAUTH_SCOPE,
				code_challenge: challenge,
				code_challenge_method: 'S256',
				state,
			}),
		});
		if (!response.ok) {
			const text = await response.text();
			throw new Error(`MiniMax OAuth authorization failed: ${text || response.statusText}`);
		}
		const payload = await response.json();
		if (!payload?.user_code || !payload?.verification_uri) {
			throw new Error(payload?.error ?? 'MiniMax OAuth authorization returned an incomplete payload.');
		}
		// expired_in 是绝对 ms epoch 截止时刻；缺失/非数会让轮询里 now()>=expiresAt 恒为 false →
		// 永不超时、phase-2 永不 fire、registry 泄漏。fail-closed：缺则抛，走 phase-1 之前的单帧错误
		// （镜像上游 `while (Date.now() < expireTimeMs)` 在 expired_in 非数时的隐式立即终止）
		if (typeof payload.expired_in !== 'number' || !Number.isFinite(payload.expired_in)) {
			throw new Error('MiniMax OAuth authorization returned an invalid expiry.');
		}
		if (payload.state !== state) {
			throw new Error('MiniMax OAuth state mismatch: possible CSRF or session corruption.');
		}
		return {
			verifier,
			userCode: payload.user_code,
			verificationUri: payload.verification_uri,
			expiresAt: payload.expired_in,
			interval: Math.max(payload.interval || MIN_POLL_INTERVAL, MIN_POLL_INTERVAL),
		};
	}

	/**
	 * 单 async 轮询循环，直到出终态。四个出口：success / error / timeout / cancelled。
	 * @param {object} args
	 * @param {string} args.region
	 * @param {string} args.userCode
	 * @param {string} args.verifier
	 * @param {number} args.expiresAt - 绝对 ms epoch 截止时刻
	 * @param {number} args.interval - 轮询间隔 ms（已兜底 ≥2s）
	 * @param {AbortSignal} [args.signal]
	 * @returns {Promise<{status:'success',token:object}|{status:'error',message:string}|{status:'timeout'}|{status:'cancelled'}>}
	 */
	async function pollUntilSettled({ region, userCode, verifier, expiresAt, interval, signal }) {
		const endpoints = getEndpoints(region);
		const pollInterval = Math.max(interval || MIN_POLL_INTERVAL, MIN_POLL_INTERVAL);
		for (;;) {
			if (signal?.aborted) return { status: 'cancelled' };
			if (now() >= expiresAt) return { status: 'timeout' };
			const response = await fetchImpl(endpoints.tokenEndpoint, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					Accept: 'application/json',
				},
				body: toForm({
					grant_type: OAUTH_GRANT_TYPE,
					client_id: endpoints.clientId,
					user_code: userCode,
					code_verifier: verifier,
				}),
			});
			const result = await parseTokenResponse(response);
			if (result.status === 'success') return { status: 'success', token: result.token };
			if (result.status === 'error') return { status: 'error', message: result.message };
			// pending：等一个间隔再轮（abort 会让 sleep 提前返回，回顶判 aborted）
			await sleep(pollInterval, signal);
		}
	}

	return { requestDeviceCode, pollUntilSettled };
}
