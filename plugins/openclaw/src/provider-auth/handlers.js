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
import { getClawConfig } from '../claw-config.js';
import { listAllPrimaries, providerSegmentOf, computeConfiguredProviders } from '../model-default/resolve.js';
import { deepMergeInto } from '../utils/deep-merge.js';
import {
	isVerificationNote,
	extractVerification,
	findDeviceCodeMethod,
	makeDeviceCodeCtx,
} from './device-code-login.js';

const VALID_CRED_TYPES = new Set(['api_key', 'oauth', 'token']);
const PORTAL_PROFILE_ID = `${PORTAL_PROVIDER_ID}:default`;

// catalog 出参的 authMethods 映射（一条规则零特判）：只露这三 kind，token/custom 不进出参。
// kind 五值见上游 types.ts（oauth|api_key|token|device_code|custom）。
const KIND_TO_AUTH_METHOD = {
	device_code: 'oauth-device-code',
	oauth: 'oauth-login',
	api_key: 'api-key',
};

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
 * @param {object} [opts.oauth] - createMiniMaxOAuth 实例（requestDeviceCode / pollUntilSettled）；MiniMax B2 才用
 * @param {object} [opts.registry] - oauth-registry（registerLogin / getLogin / removeLogin）；B2/B1 共用
 * @param {Function} [opts.genLoginId] - () → loginId，默认 randomUUID
 * @param {Function} [opts.scheduleBackground] - (promise) → void，挂后台任务；默认 fire-and-forget + .catch
 * @param {Function} [opts.logRemote] - (text) → void，OAuth 终态诊断推送；默认模块级 remoteLog（测试注入 spy）
 * @param {Function} [opts.resolveConfig] - () → OpenClaw runtime config 快照；通用 device-code 登录（B1）拿 config 用，默认 getClawConfig
 * @param {Function} [opts.resolveProviders] - ({ config, providerRefs }) → ProviderPlugin[]；B1 经它拿 provider 的 auth 方法（生产由入口注入，内部 activate:false），默认抛错
 * @param {Function} [opts.resolveSetupProviders] - ({ config }) → ProviderPlugin[]；catalog 经它拿 setup 全集（mode:'setup', activate:false, cache:true，生产由入口注入），默认抛错
 * @param {Function} [opts.loadProviderIdResolver] - () → Promise<resolveProviderIdForAuth>；catalog 算 hasCred 时别名归一基座 id（生产由入口惰性加载 agent-runtime），默认抛错
 * @returns {{ setApiKey, list, remove, loginOauth, cancelOauth, catalog }}
 */
export function buildProviderAuthHandlers({
	sdk,
	resolveAgentDir,
	oauth,
	registry,
	genLoginId = randomUUID,
	scheduleBackground = (p) => { p.catch(() => {}); },
	logRemote = remoteLog,
	resolveConfig = getClawConfig,
	resolveProviders = () => { throw new Error('provider catalog runtime not injected'); },
	resolveSetupProviders = () => { throw new Error('provider catalog runtime not injected'); },
	loadProviderIdResolver = () => { throw new Error('agent runtime not injected'); },
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
			// 账本来源（source='profile'）
			const store = sdk.ensureAuthProfileStore(resolveAgentDir());
			const ledger = [];
			const raw = store?.profiles ?? {};
			for (const [profileId, cred] of Object.entries(raw)) {
				if (!isWellFormedCredential(cred)) continue;
				ledger.push(toListEntry(profileId, cred, sdk.formatApiKeyPreview));
			}
			// 内联来源（source='inline'）：读 cfg；cfg 读不到时退化为仅账本，不连累 ledger 路径
			let cfg = null;
			try { cfg = resolveConfig(); }
			catch { cfg = null; }
			const inline = listInlineEntries(cfg, {
				hasConfiguredSecretInput: sdk.hasConfiguredSecretInput,
				formatApiKeyPreview: sdk.formatApiKeyPreview,
			});
			// env 来源（source='env'）：候选=账本∪内联∪主模型段；仅未被账本/内联覆盖的 sole-source 才列
			const covered = new Set([...ledger, ...inline].map((e) => e.provider));
			const candidates = new Set([...covered, ...collectPrimaryProviderSegments(cfg)]);
			const env = listEnvEntries(candidates, covered, { resolveEnvApiKey: sdk.resolveEnvApiKey });

			let profiles = [...ledger, ...inline, ...env];
			if (filterProvider) profiles = profiles.filter((e) => e.provider === filterProvider);
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
			const source = params?.source ?? 'profile';
			if (source === 'profile') {
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
				return;
			}
			if (source === 'inline') {
				// 内联撤销：只删 cfg.models.providers[provider].apiKey 字段，保留节点其余内容
				//（baseUrl/api/models 是用户的自定义 provider 定义，删整节点会把"没 key"恶化成"模型不存在"）。
				// 删 key 后节点变空 {} → 顺手清掉空节点。afterWrite:auto → hot 路径零打断（docs § 2.5 / § 6.14）。
				await sdk.mutateConfigFile({
					afterWrite: { mode: 'auto' },
					mutate(draft) {
						const providers = draft?.models?.providers;
						if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return;
						const node = providers[provider];
						if (!node || typeof node !== 'object') return; // 幂等：无该节点视为已撤销
						delete node.apiKey;
						if (Object.keys(node).length === 0) delete providers[provider];
					},
				});
				respond(true, {});
				return;
			}
			// env 及未知 source：插件无法撤销（env 在进程环境里）→ 后端兜底拒绝
			respondInvalid(respond, `cannot remove credential with source "${source}"`);
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

	// MiniMax 设备码登录（B2：自家复刻设备码流，码已嵌在 verification URL 里 + 写静态模型清单）。
	// 不并入通用 B1：MiniMax 不在 OpenClaw 内置 provider 字典，登录后还要补写 models.providers 清单
	// （上游对 portal 不做 catalog discovery），与 codex/copilot「内置、模型自带」不同——见 docs § 6.16。
	async function loginOauthMiniMax({ params, respond }) {
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

	// --- 通用设备码登录（B1：驱动上游 provider 的 device_code run，跟随上游同步） ---

	// 设备码失败的终态响应：phase-1 已发过 accepted → 发 phase-2 错误帧（带 status）；
	// phase-1 之前就失败 → 单帧错误（payload undefined，与 MiniMax phase-1 之前失败同形）
	function respondDeviceFailure(respond, phase1Sent, code, message, status = 'error') {
		if (phase1Sent) respond(false, { status }, { code, message });
		else respond(false, undefined, { code, message });
	}

	// 设备码登录成功：逐个写凭据 + 有 configPatch 就深合并进 cfg（hot-reload，零打断），恰好 respond 一次
	async function persistDeviceCodeSuccess({ provider, result, loginId, phase1Sent, respond }) {
		try {
			const profileIds = [];
			for (const profile of result.profiles) {
				// 同一 auth-profiles 文件，顺序写避免锁竞争（device-code 通常仅 1 个 profile）
				 
				const r = await sdk.upsertAuthProfileWithLock({
					profileId: profile.profileId,
					credential: profile.credential,
					agentDir: resolveAgentDir(),
				});
				if (r === null) {
					respondDeviceFailure(respond, phase1Sent, 'IO_FAILED', 'failed to write auth-profiles store');
					logRemote(`providerAuth.deviceCode.io-failed provider=${provider} loginId=${loginId} stage=credential`);
					return;
				}
				profileIds.push(profile.profileId);
			}
			const patch = result.configPatch;
			if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
				// configPatch 是 provider 自带的 onboarding 默认（如 codex 写 agents.defaults.models 别名）；
				// 深合并保留其它 provider，afterWrite:auto 走 hot-reload 不重启（与 MiniMax 写 cfg 一致）
				await sdk.mutateConfigFile({
					afterWrite: { mode: 'auto' },
					mutate(draft) { deepMergeInto(draft, patch); },
				});
			}
			respond(true, { status: 'ok', provider, profileIds });
			logRemote(`providerAuth.deviceCode.ok provider=${provider} loginId=${loginId} profiles=${profileIds.length}`);
		}
		catch (err) {
			respondDeviceFailure(respond, phase1Sent, 'IO_FAILED', String(err?.message ?? err));
			logRemote(`providerAuth.deviceCode.io-failed provider=${provider} loginId=${loginId} stage=config msg=${String(err?.message ?? err)}`);
		}
	}

	async function loginOauthDeviceCode({ provider, respond }) {
		try {
			const config = resolveConfig() ?? {};
			let providers;
			try {
				// resolveProviders 可能 async（生产侧惰性加载 catalog-runtime SDK 后再 resolve）
				providers = await resolveProviders({ config, providerRefs: [provider] });
			}
			catch (err) {
				// 加载器异常（SDK import 失败 / resolvePluginProviders 抛错）：phase-1 之前，单帧错误
				respondIoFailed(respond, err);
				return;
			}
			const method = findDeviceCodeMethod(providers, provider);
			if (!method) {
				respond(false, undefined, {
					code: 'NOT_FOUND',
					message: `provider "${provider}" has no device-code login method`,
				});
				return;
			}

			const loginId = genLoginId();
			const abortController = new AbortController();
			let phase1Sent = false;

			// run 内 prompter.note 吐出「含 URL 的验证 note」→ 触发 phase-1 accepted（仅一次）。
			// 结构化字段抠不到给 null，rawText 永远带上全文交前端兜底。登记发生在 respond accepted 之前，
			// 让紧随其后的 cancelOauth 一定能按 loginId 找到该登录。
			const ctx = makeDeviceCodeCtx({
				config,
				agentDir: resolveAgentDir(),
				onNote: (text) => {
					if (phase1Sent || !isVerificationNote(text)) return;
					phase1Sent = true;
					registry.registerLogin(loginId, { abortController });
					const { verificationUri, userCode } = extractVerification(text);
					respond(true, {
						status: 'accepted',
						loginId,
						provider,
						verificationUri,
						userCode,
						rawText: text,
					});
				},
			});

			// 起 run（不 await 整体）；run 仅跑一次，resolve/reject 都到这里恰好终态一次。
			// run 无 abort 钩子：取消停不掉上游后台轮询，cancelOauth 只 abort 信号 → run 到期自己 settle
			// 时这里识别 aborted、回 cancelled 终态、不写凭据（终态必达 + 清理，不做复查骚操作）。
			async function runAndSettle() {
				let result;
				let runErr;
				try {
					result = await Promise.resolve().then(() => method.run(ctx));
				}
				catch (err) {
					runErr = err;
				}
				if (phase1Sent) registry.removeLogin(loginId);

				if (runErr) {
					respondDeviceFailure(respond, phase1Sent, 'OAUTH_FAILED', String(runErr?.message ?? runErr));
					logRemote(`providerAuth.deviceCode.error provider=${provider} loginId=${loginId} stage=run msg=${String(runErr?.message ?? runErr)}`);
					return;
				}
				if (abortController.signal.aborted) {
					respondDeviceFailure(respond, phase1Sent, 'OAUTH_CANCELLED', `device-code login for ${provider} was cancelled`, 'cancelled');
					logRemote(`providerAuth.deviceCode.cancelled provider=${provider} loginId=${loginId}`);
					return;
				}
				// 上游会把中途失败吞成空 profiles（如 copilot access_denied / expired）→ 空即失败
				const profiles = Array.isArray(result?.profiles) ? result.profiles : [];
				if (profiles.length === 0) {
					respondDeviceFailure(respond, phase1Sent, 'OAUTH_FAILED', `device-code login for ${provider} returned no credentials`);
					logRemote(`providerAuth.deviceCode.error provider=${provider} loginId=${loginId} stage=empty-profiles`);
					return;
				}
				await persistDeviceCodeSuccess({ provider, result, loginId, phase1Sent, respond });
			}

			scheduleBackground(runAndSettle());
		}
		catch (err) {
			respondIoFailed(respond, err);
		}
	}

	// 登录入口路由：minimax-portal（或缺省，向后兼容）→ B2 自家流；其它任何带 device_code 方法的
	// provider → 通用 B1 驱动。不针对 codex/copilot 硬编码，后续 OpenClaw 新增 device_code provider 自动适用。
	async function loginOauth({ params, respond }) {
		const provider = params?.provider;
		// provider 给了就必须是非空串（缺省保留给 MiniMax B2 向后兼容）：空串 / 非串在边界挡掉，
		// 不让其漏进 B1 当 NOT_FOUND，也不把非串塞给上游 resolvePluginProviders（providerRefs 期望串）
		if (provider !== undefined && !isNonEmptyString(provider)) {
			respondInvalid(respond, 'provider must be a non-empty string when provided');
			return;
		}
		if (provider === undefined || provider === PORTAL_PROVIDER_ID) {
			return loginOauthMiniMax({ params, respond });
		}
		return loginOauthDeviceCode({ provider, respond });
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

	// --- provider 目录（能力 1）：枚举全集 provider + 各自认证方式 + 是否已配凭据 ---

	// 无参；出参 { providers: [{ provider, authMethods, hasCred }] }（命名对象、不 wrap、不 undefined）。
	// 数据源 = resolvePluginProviders(setup) 全集（含未配 provider）；authMethods 一条规则零特判
	// （device_code/oauth/api_key 三 kind 露出，token/custom 不露，authMethods 空则该 provider 不进出参）；
	// hasCred 复用 computeConfiguredProviders 三源（账本/内联/env）别名归一基座 id。
	// 错误码：未知字段 → INVALID_ARGS（params:{} / undefined / null 都放行）；解析/凭据探针/store 读抛错 → IO_FAILED。
	async function catalog({ params, respond }) {
		try {
			// 无参方法：params 缺省（undefined / null）或空对象都放行；带任何字段即未知字段。
			if (params !== undefined && params !== null) {
				if (typeof params !== 'object' || Array.isArray(params)) {
					respondInvalid(respond, 'params must be an object');
					return;
				}
				const keys = Object.keys(params);
				if (keys.length > 0) {
					respondInvalid(respond, `unknown field: ${keys[0]}`);
					return;
				}
			}

			const config = resolveConfig() ?? {};
			// setup 全集（含未配）：activate:false 零副作用、cache:true 复用进程内发现缓存。生产由入口注入。
			const providers = await resolveSetupProviders({ config });
			// 别名归一基座 id（hasCred 计算用）：agent-runtime 惰性加载，失败走 IO_FAILED。
			const resolveProviderIdForAuth = await loadProviderIdResolver();
			// 三源 hasCred（账本/内联/env），全过 resolveProviderIdForAuth 归一基座 id。
			const configuredSet = new Set(computeConfiguredProviders(config, {
				agentDir: resolveAgentDir(),
				isProviderApiKeyConfigured: sdk.isProviderApiKeyConfigured,
				hasConfiguredSecretInput: sdk.hasConfiguredSecretInput,
				ensureAuthProfileStore: sdk.ensureAuthProfileStore,
				resolveProviderIdForAuth,
			}));

			const out = [];
			for (const p of providers ?? []) {
				const provider = p?.id;
				if (typeof provider !== 'string' || provider.length === 0) continue;
				const authMethods = mapAuthMethods(p.auth);
				if (authMethods.length === 0) continue; // custom-only / token-only / 空 auth[] 自然排除
				out.push({ provider, authMethods, hasCred: configuredSet.has(provider) });
			}
			respond(true, { providers: out });
		}
		catch (err) {
			respondIoFailed(respond, err);
		}
	}

	return { setApiKey, list, remove, loginOauth, cancelOauth, catalog };
}

/**
 * 把 provider 的 auth[] 映射成对外的 authMethods（catalog 用，一条规则零特判）：
 * device_code→oauth-device-code、oauth→oauth-login、api_key→api-key；token/custom 不露。
 * 保留 auth[] 出现顺序，按方法名去重（一 provider 可多入口、同 kind 多条只算一次）。
 * @param {Array<{kind?:string}>} authArr - resolvePluginProviders 返回项的 auth 数组
 * @returns {string[]}
 */
function mapAuthMethods(authArr) {
	const out = [];
	const seen = new Set();
	if (!Array.isArray(authArr)) return out;
	for (const a of authArr) {
		const method = KIND_TO_AUTH_METHOD[a?.kind];
		if (method && !seen.has(method)) {
			seen.add(method);
			out.push(method);
		}
	}
	return out;
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
 * 把单条账本 credential 转成 list RPC 出参元素（source='profile'，可撤销）。
 * 关键：原始 key / token / OAuth access/refresh 绝不出 handler。
 */
function toListEntry(profileId, cred, formatApiKeyPreview) {
	const out = {
		profileId,
		provider: cred.provider,
		source: 'profile',
		removable: true,
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

/**
 * 内联来源：cfg.models.providers 里 apiKey 配了的节点（用户手写 / OAuth 写的节点若带 key）。
 * 只看 apiKey 字段——OAuth 登录写的节点无 apiKey，天然不会被误收（docs § 6.14）。
 * @param {object} cfg
 * @param {object} deps - { hasConfiguredSecretInput, formatApiKeyPreview }
 * @returns {object[]} source='inline'、removable=true 的出参元素
 */
function listInlineEntries(cfg, { hasConfiguredSecretInput, formatApiKeyPreview }) {
	const out = [];
	const providers = cfg?.models?.providers;
	if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return out;
	for (const [provider, node] of Object.entries(providers)) {
		if (!node || typeof node !== 'object') continue;
		if (!hasConfiguredSecretInput(node.apiKey)) continue;
		const entry = {
			profileId: `${provider}#inline`,
			provider,
			source: 'inline',
			removable: true,
			type: 'api_key',
		};
		// 仅明文 string key 给预览；{env}/{file} 引用形态不预览（避免怪异展示）
		if (typeof node.apiKey === 'string' && !node.apiKey.startsWith('{')) {
			entry.keyPreview = formatApiKeyPreview(node.apiKey);
		}
		out.push(entry);
	}
	return out;
}

/**
 * env 来源：对候选 provider 集合探测环境变量；仅当该 provider 未被账本/内联覆盖（sole source）才列，
 * 避免与已可撤销的行重复添噪。env 来源不可撤销（removable=false），仅展示。
 * @param {Iterable<string>} candidates - 候选 provider（账本∪内联∪主模型段）
 * @param {Set<string>} covered - 已由账本/内联列出的 provider（原始拼写）
 * @param {object} deps - { resolveEnvApiKey }
 * @returns {object[]} source='env'、removable=false 的出参元素
 */
function listEnvEntries(candidates, covered, { resolveEnvApiKey }) {
	const out = [];
	const seen = new Set();
	for (const provider of candidates) {
		if (!provider || covered.has(provider) || seen.has(provider)) continue;
		const hit = resolveEnvApiKey(provider);
		if (!hit?.apiKey) continue;
		seen.add(provider);
		out.push({
			profileId: `${provider}#env`,
			provider,
			source: 'env',
			removable: false,
			type: 'api_key',
		});
	}
	return out;
}

/**
 * 收集 default + 各 agent 主模型的 provider 段（去重交给调用方的 Set）。
 * 复用 model-default/resolve.js，不重复造主模型读取逻辑。
 * @param {object} cfg
 * @returns {string[]}
 */
function collectPrimaryProviderSegments(cfg) {
	const all = listAllPrimaries(cfg);
	const segs = [];
	const push = (primary) => {
		const seg = providerSegmentOf(primary);
		if (seg) segs.push(seg);
	};
	push(all.default.primary);
	for (const v of Object.values(all.agents)) push(v.primary);
	return segs;
}
