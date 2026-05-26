/**
 * provider-auth handlers —— `coclaw.providerAuth.*` RPC 的纯函数实现
 * （setApiKey / list / remove + OAuth 的 loginOauth / cancelOauth）
 *
 * 设计要点（详见 docs/model-config-api.md § 2 + § 6）：
 * - 通过 dependency injection 拿 SDK / agentDir 解析器，便于单测；产线注入在 ./index.js
 * - 只动 secret 不动 cfg：set/remove 都走 SDK 的"凭据写盘"入口，不调 `updateConfig`，
 *   避免触发 gateway 全量重启（mental-model § 4.7）
 * - **set 与 remove 共享同一把文件锁**：set 走 `upsertAuthProfileWithLock`（不是上层封装的
 *   sync 版 `upsertApiKeyProfile`——后者无锁，与 `removeProviderAuthProfilesWithLock`
 *   并发时可能丢写），remove 自带文件锁。两者都基于 SDK 的 `updateAuthProfileStoreWithLock`。
 *   单 UI 用户场景下并发概率低，但代价小，顺手治本
 * - 凭据不外流：list 输出绝对不带 `key` / `token` / OAuth access/refresh，
 *   只露 `keyPreview` + 显示用元信息（email / displayName / expiresAt）
 * - 成功响应不带 `ok` 字段（看协议层 respond(true/false, ...) 标志位）；
 *   时间字段统一 ms epoch number，命名 `*At`
 * - 错误码：参数校验 `INVALID_ARGS`，其余（SDK 抛出 / 文件锁竞争 / 磁盘）`IO_FAILED`。
 *   doc 契约只承诺这两种 code，所以 catch 路径**硬编码 `IO_FAILED`**，
 *   不放任 SDK 内部 code 透传出去（仍透 message 供诊断）
 *
 * 与 plugin 既有 `respondError` / `respondInvalid`（在 plugins/openclaw/index.js）的关系：
 * 既有 helper 用 `INVALID_INPUT` / `INTERNAL_ERROR`，与本节 RPC 契约（`INVALID_ARGS` /
 * `IO_FAILED`）不一致——所以本模块自带局部 helper，避免改既有 helper 影响所有现存 RPC。
 *
 * OAuth（loginOauth / cancelOauth）补充：
 * - **真·两阶段 res**（plugin respond 可多调，详见 docs/model-config-api.md § 2.3.2）：
 *   phase-1 同步 respond accepted 帧（payload 必带 `status:'accepted'` 否则中继提前清路由），
 *   phase-2 后台轮询出结果后用同一 reqId respond 终态帧
 * - phase-1 之前的失败（region 非法 / 设备码请求失败）走单帧错误响应（INVALID_ARGS / IO_FAILED）
 * - phase-2 失败用 payload.status 区分语义（error / timeout / cancelled），结构化 error.code
 *   按语义给 OAUTH_FAILED / OAUTH_TIMEOUT / OAUTH_CANCELLED；写凭据 null / 写配置抛错走 IO_FAILED
 * - 后台轮询 fire-and-forget，但 runOAuthBackground 内全程 try/catch 保证恰好 respond 一次且不外抛；
 *   终态在 finally 清 registry
 */

import { randomUUID } from 'node:crypto';
import { PORTAL_PROVIDER_ID, CONFIG_DEFAULT_BASE_URL, VALID_REGIONS } from './minimax-oauth.js';
import { getPortalModels } from './portal-model-catalog.js';
import { remoteLog } from '../remote-log.js';

const VALID_CRED_TYPES = new Set(['api_key', 'oauth', 'token']);
const PORTAL_PROFILE_ID = `${PORTAL_PROVIDER_ID}:default`;

function respondInvalid(respond, message) {
	respond(false, undefined, { code: 'INVALID_ARGS', message });
}

function respondIoFailed(respond, err) {
	respond(false, undefined, {
		code: 'IO_FAILED',
		message: String(err?.message ?? err),
	});
}

function isNonEmptyString(v) {
	return typeof v === 'string' && v.trim().length > 0;
}

/**
 * 构造 handler 集合。
 *
 * @param {object} opts
 * @param {object} opts.sdk - openclaw/plugin-sdk/provider-auth 命名空间（或 stub）
 * @param {Function} opts.sdk.upsertAuthProfileWithLock - async；接 { profileId, credential, agentDir }
 * @param {Function} opts.sdk.buildApiKeyCredential - 同步；(provider, input, metadata?, options?) → credential
 * @param {Function} opts.sdk.ensureAuthProfileStore - 位置参数 (agentDir, options?)
 * @param {Function} opts.sdk.removeProviderAuthProfilesWithLock - async；返回 store（成功）/ null（锁/磁盘失败）
 * @param {Function} opts.sdk.formatApiKeyPreview - 遮蔽显示 helper
 * @param {Function} [opts.sdk.mutateConfigFile] - async；OAuth 写 cfg（openclaw/plugin-sdk/config-mutation）
 * @param {Function} opts.resolveAgentDir - 返回 main agent 完整路径（含 /agent 子目录）
 * @param {object} [opts.oauth] - createMiniMaxOAuth 实例（requestDeviceCode / pollUntilSettled）；OAuth handler 才用
 * @param {object} [opts.registry] - oauth-registry（registerLogin / getLogin / removeLogin）
 * @param {Function} [opts.genLoginId] - () → loginId，默认 randomUUID
 * @param {Function} [opts.scheduleBackground] - (promise) → void，挂后台轮询；默认 fire-and-forget + .catch
 * @param {Function} [opts.logRemote] - (text) → void，OAuth 终态诊断推送；默认模块级 remoteLog（测试注入 spy）
 * @returns {{ setApiKey, list, remove, loginOauth, cancelOauth }}
 */
export function buildProviderAuthHandlers({
	sdk,
	resolveAgentDir,
	oauth,
	registry,
	genLoginId = randomUUID,
	scheduleBackground = (p) => { p.catch(() => {}); },
	logRemote = remoteLog,
}) {
	// TODO: 将来若要支持"设默认模型 / 多账号顺序"等需要写 cfg 的操作，会撞上
	// gateway 重启窗口的 UX 问题——参 docs/model-config-api.md § 3 / § 5（占位章节）。
	// 当前三个 RPC 都只动 secret 不动 cfg，零重启。
	async function setApiKey({ params, respond }) {
		try {
			const provider = params?.provider;
			const apiKey = params?.apiKey;
			const profileIdInput = params?.profileId;
			if (!isNonEmptyString(provider)) {
				respondInvalid(respond, 'provider must be a non-empty string');
				return;
			}
			if (!isNonEmptyString(apiKey)) {
				respondInvalid(respond, 'apiKey must be a non-empty string');
				return;
			}
			if (profileIdInput !== undefined && !isNonEmptyString(profileIdInput)) {
				respondInvalid(respond, 'profileId must be a non-empty string when provided');
				return;
			}
			// 缺省 profileId 形式 `<provider>:default`，与上游 `buildAuthProfileId` 行为一致
			// （normalizeOptionalString 仅 trim，已在 isNonEmptyString 校验中保证非空）
			const profileId = profileIdInput ?? `${provider}:default`;
			const credential = sdk.buildApiKeyCredential(
				provider,
				apiKey,
				undefined,
				{ secretInputMode: 'plaintext' },
			);
			const result = await sdk.upsertAuthProfileWithLock({
				profileId,
				credential,
				agentDir: resolveAgentDir(),
			});
			// upsertAuthProfileWithLock 内部 try/catch 把锁失败/磁盘错误吞成 null
			if (result === null) {
				respondIoFailed(respond, new Error('failed to write auth-profiles store'));
				return;
			}
			respond(true, { profileId });
		}
		catch (err) {
			respondIoFailed(respond, err);
		}
	}

	async function list({ params, respond }) {
		try {
			const filterProvider = params?.provider;
			if (filterProvider !== undefined && !isNonEmptyString(filterProvider)) {
				respondInvalid(respond, 'provider must be a non-empty string when provided');
				return;
			}
			const store = sdk.ensureAuthProfileStore(resolveAgentDir());
			const profiles = [];
			const raw = store?.profiles ?? {};
			for (const [profileId, cred] of Object.entries(raw)) {
				if (!isWellFormedCredential(cred)) continue;
				if (filterProvider && cred.provider !== filterProvider) continue;
				profiles.push(toListEntry(profileId, cred, sdk.formatApiKeyPreview));
			}
			respond(true, { profiles });
		}
		catch (err) {
			respondIoFailed(respond, err);
		}
	}

	async function remove({ params, respond }) {
		try {
			const provider = params?.provider;
			if (!isNonEmptyString(provider)) {
				respondInvalid(respond, 'provider must be a non-empty string');
				return;
			}
			const result = await sdk.removeProviderAuthProfilesWithLock({
				provider,
				agentDir: resolveAgentDir(),
			});
			// 同 setApiKey：锁/磁盘失败时上游返回 null
			if (result === null) {
				respondIoFailed(respond, new Error('failed to update auth-profiles store'));
				return;
			}
			respond(true, {});
		}
		catch (err) {
			respondIoFailed(respond, err);
		}
	}

	// --- OAuth（MiniMax device-code，真·两阶段 res） ---

	// 写凭据 + 写 cfg；恰好 respond 一次，不外抛（成功 ok / 失败 IO_FAILED 都在内部消化）
	async function persistOAuthSuccess({ region, token, loginId, respond }) {
		try {
			const credential = {
				type: 'oauth',
				provider: PORTAL_PROVIDER_ID,
				access: token.access,
				refresh: token.refresh,
				expires: token.expires,
			};
			const result = await sdk.upsertAuthProfileWithLock({
				profileId: PORTAL_PROFILE_ID,
				credential,
				agentDir: resolveAgentDir(),
			});
			// 同 setApiKey：锁/磁盘失败时上游静默返回 null
			if (result === null) {
				respond(false, { status: 'error' }, {
					code: 'IO_FAILED',
					message: 'failed to write auth-profiles store',
				});
				logRemote(`providerAuth.oauth.io-failed loginId=${loginId} stage=credential`);
				return;
			}
			// 写 provider 节点 baseUrl —— hot-reload 路径，零打断（afterWrite:auto，禁传 restart）。
			// baseUrl 优先用服务端动态返回的 resourceUrl，缺省回落 cn/global 默认（带 /anthropic 后缀）
			const baseUrl = token.resourceUrl || CONFIG_DEFAULT_BASE_URL[region];
			// 写模型清单进 provider 节点：上游对 minimax-portal 用写死静态清单且第三方触发不到其
			// catalog discovery，不写则 catalog 为空、模型不可用。直接取内置静态表（与上游对齐），
			// 不再网络拉取——避免登录拉一次后静态过时 + 带进旧模型。后续升级新模型靠启动对账补。
			// 详见 docs/model-config-api.md § 2.3
			const models = getPortalModels(PORTAL_PROVIDER_ID);
			await sdk.mutateConfigFile({
				afterWrite: { mode: 'auto' },
				mutate(draft) {
					if (!draft.models || typeof draft.models !== 'object' || Array.isArray(draft.models)) {
						draft.models = {};
					}
					const p = draft.models.providers;
					if (!p || typeof p !== 'object' || Array.isArray(p)) {
						draft.models.providers = {};
					}
					draft.models.providers[PORTAL_PROVIDER_ID] = {
						baseUrl,
						api: 'anthropic-messages',
						authHeader: true,
						models,
					};
				},
			});
			respond(true, { status: 'ok', profileId: PORTAL_PROFILE_ID });
			logRemote(`providerAuth.oauth.ok loginId=${loginId} profileId=${PORTAL_PROFILE_ID} models=${models.length}`);
		}
		catch (err) {
			respond(false, { status: 'error' }, {
				code: 'IO_FAILED',
				message: String(err?.message ?? err),
			});
			logRemote(`providerAuth.oauth.io-failed loginId=${loginId} stage=config msg=${String(err?.message ?? err)}`);
		}
	}

	// 后台轮询循环 → 终态 respond（phase-2）。全程 try/catch，保证恰好 respond 一次且不外抛；
	// finally 清 registry，无论成功/失败/取消
	async function runOAuthBackground({ region, loginId, deviceCode, abortController, respond }) {
		try {
			const outcome = await oauth.pollUntilSettled({
				region,
				userCode: deviceCode.userCode,
				verifier: deviceCode.verifier,
				expiresAt: deviceCode.expiresAt,
				interval: deviceCode.interval,
				signal: abortController.signal,
			});
			if (outcome.status === 'cancelled') {
				respond(false, { status: 'cancelled' }, {
					code: 'OAUTH_CANCELLED',
					message: 'MiniMax OAuth login was cancelled',
				});
				logRemote(`providerAuth.oauth.cancelled loginId=${loginId}`);
				return;
			}
			if (outcome.status === 'timeout') {
				respond(false, { status: 'timeout' }, {
					code: 'OAUTH_TIMEOUT',
					message: 'MiniMax OAuth timed out before authorization completed',
				});
				logRemote(`providerAuth.oauth.timeout loginId=${loginId}`);
				return;
			}
			if (outcome.status === 'error') {
				respond(false, { status: 'error' }, {
					code: 'OAUTH_FAILED',
					message: outcome.message || 'MiniMax OAuth authorization failed',
				});
				logRemote(`providerAuth.oauth.error loginId=${loginId} msg=${outcome.message || 'authorization failed'}`);
				return;
			}
			// success：persistOAuthSuccess 内部恰好 respond 一次，不外抛
			await persistOAuthSuccess({ region, token: outcome.token, loginId, respond });
		}
		catch (err) {
			// 防御：pollUntilSettled 未预期抛错（多半是 /oauth/token 轮询期的网络/传输失败）。
			// 终态帧回 error + OAUTH_FAILED——属轮询阶段失败，区别于写盘失败的 IO_FAILED（见 docs § 2.3.6）；
			// 避免发起方永远挂着
			respond(false, { status: 'error' }, {
				code: 'OAUTH_FAILED',
				message: String(err?.message ?? err),
			});
			logRemote(`providerAuth.oauth.error loginId=${loginId} stage=poll msg=${String(err?.message ?? err)}`);
		}
		finally {
			registry.removeLogin(loginId);
		}
	}

	async function loginOauth({ params, respond }) {
		try {
			const region = params?.region ?? 'cn';
			if (!VALID_REGIONS.has(region)) {
				respondInvalid(respond, 'region must be "cn" or "global"');
				return;
			}
			let deviceCode;
			try {
				deviceCode = await oauth.requestDeviceCode({ region });
			}
			catch (err) {
				// phase-1 之前失败（网络 / HTTP / 响应不全）：单帧错误响应
				respondIoFailed(respond, err);
				return;
			}
			const loginId = genLoginId();
			const abortController = new AbortController();
			// 先登记再 respond accepted：让紧随其后的 cancelOauth 一定能找到该 loginId
			registry.registerLogin(loginId, { abortController });
			respond(true, {
				status: 'accepted',
				loginId,
				verificationUri: deviceCode.verificationUri,
				userCode: deviceCode.userCode,
				expiresAt: deviceCode.expiresAt,
				interval: deviceCode.interval,
			});
			scheduleBackground(
				runOAuthBackground({ region, loginId, deviceCode, abortController, respond }),
			);
		}
		catch (err) {
			respondIoFailed(respond, err);
		}
	}

	async function cancelOauth({ params, respond }) {
		try {
			const loginId = params?.loginId;
			if (!isNonEmptyString(loginId)) {
				respondInvalid(respond, 'loginId must be a non-empty string');
				return;
			}
			const entry = registry.getLogin(loginId);
			// 幂等：未知 loginId 也回 {}（可能已终态自清，或从来没有）
			if (entry) entry.abortController.abort();
			respond(true, {});
		}
		catch (err) {
			respondIoFailed(respond, err);
		}
	}

	return { setApiKey, list, remove, loginOauth, cancelOauth };
}

/**
 * 上游 store 偶有半残留条目（手编辑、版本迁移半截、缓存竞争等）；
 * 必须有 string `provider` + 已知 `type` 才视为 well-formed。
 */
function isWellFormedCredential(cred) {
	if (!cred || typeof cred !== 'object') return false;
	if (typeof cred.provider !== 'string' || cred.provider.length === 0) return false;
	if (!VALID_CRED_TYPES.has(cred.type)) return false;
	return true;
}

/**
 * 把单条 credential 转成 list RPC 出参元素。
 * 关键：原始 key / token / OAuth access/refresh 绝不出 handler。
 */
function toListEntry(profileId, cred, formatApiKeyPreview) {
	const out = {
		profileId,
		provider: cred.provider,
		type: cred.type,
	};
	if (cred.type === 'api_key' && typeof cred.key === 'string' && cred.key.length > 0) {
		out.keyPreview = formatApiKeyPreview(cred.key);
	}
	if (typeof cred.email === 'string') out.email = cred.email;
	if (typeof cred.displayName === 'string') out.displayName = cred.displayName;
	if ((cred.type === 'oauth' || cred.type === 'token') && typeof cred.expires === 'number') {
		out.expiresAt = cred.expires;
	}
	return out;
}
