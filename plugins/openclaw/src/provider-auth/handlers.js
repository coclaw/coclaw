/**
 * provider-auth handlers —— `coclaw.providerAuth.*` 三个 RPC 的纯函数实现
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
 */

const VALID_CRED_TYPES = new Set(['api_key', 'oauth', 'token']);

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
 * 构造三个 handler。
 *
 * @param {object} opts
 * @param {object} opts.sdk - openclaw/plugin-sdk/provider-auth 命名空间（或 stub）
 * @param {Function} opts.sdk.upsertAuthProfileWithLock - async；接 { profileId, credential, agentDir }
 * @param {Function} opts.sdk.buildApiKeyCredential - 同步；(provider, input, metadata?, options?) → credential
 * @param {Function} opts.sdk.ensureAuthProfileStore - 位置参数 (agentDir, options?)
 * @param {Function} opts.sdk.removeProviderAuthProfilesWithLock - async；返回 store（成功）/ null（锁/磁盘失败）
 * @param {Function} opts.sdk.formatApiKeyPreview - 遮蔽显示 helper
 * @param {Function} opts.resolveAgentDir - 返回 main agent 完整路径（含 /agent 子目录）
 * @returns {{ setApiKey: Function, list: Function, remove: Function }}
 */
export function buildProviderAuthHandlers({ sdk, resolveAgentDir }) {
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
			respond(true, undefined);
		}
		catch (err) {
			respondIoFailed(respond, err);
		}
	}

	return { setApiKey, list, remove };
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
