/**
 * model-default/handlers.js —— coclaw.model.set / list 两个 RPC 的纯函数实现
 *
 * 设计要点（详见 docs/model-config-api.md § 3）：
 * - DI 注入 sdk（mutateConfigFile / buildModelsProviderData / isProviderAuthProfileConfigured）
 *   + loadConfig + resolveAgentDir，便于单测；产线注入在 ./index.js
 * - **出参不加 status wrap**（gateway-method-design skill 新约定）：set → {}；list → { default, agents }
 * - 错误码只用 INVALID_ARGS / IO_FAILED，参考 provider-auth/handlers.js
 *   既有 plugin 的 respondError 用 INTERNAL_ERROR 与本节契约不一致，所以本模块自带局部 helper
 * - set 校验 fail-fast 顺序：params shape → 拒未知字段 → agentId → primary 类型 → primary 形态
 *   （纯字符串：含 '/'、'/' 不在端点；不依赖 cfg）→ loadConfig → provider 凭据 → catalog
 *   形态校验**前置在 loadConfig 之前**，cfg 不可读时非法形态仍是 INVALID_ARGS 而非 IO_FAILED
 * - catalog 校验用 `view: 'all'`：picker 可见性过滤会误判某些合法 provider 不存在（subagent 调研结论）
 */

import { listAllPrimariesWithCredentials } from './resolve.js';
import { writePrimary } from './persist.js';

const ALLOWED_KEYS = new Set(['agentId', 'primary']);

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
 * 纯字符串形态拆分：要求 primary 含 '/'，且 '/' 不在端点。
 * @returns {{ provider: string, model: string }|null}
 */
function parseProviderModel(primary) {
	const slashIdx = primary.indexOf('/');
	if (slashIdx <= 0 || slashIdx === primary.length - 1) return null;
	return {
		provider: primary.slice(0, slashIdx),
		model: primary.slice(slashIdx + 1),
	};
}

/**
 * cfg 相关的 primary 校验：provider 凭据 + catalog 存在性。
 * 形态拆分由调用方完成（fail-fast 前置在 loadConfig 之前）。
 *
 * @returns {Promise<string|null>} 错误 message；null 表通过
 */
async function validateProviderCredAndCatalog({ provider, model, primary, cfg, sdk, agentDir }) {
	// 凭据校验：isProviderAuthProfileConfigured 内部就是 listUsableProviderAuthProfileIds().length > 0
	// cooldown profile 仍算"已配置"（cooldown 是临时态，上游 fallback 主循环会主动跳）
	const hasCred = sdk.isProviderAuthProfileConfigured({ provider, cfg, agentDir });
	if (!hasCred) {
		return `provider "${provider}" has no usable auth profile`;
	}

	// catalog 校验：view: 'all' 绕开 picker 可见性过滤（picker 过滤掉的 provider 不影响合法性）
	const data = await sdk.buildModelsProviderData(cfg, undefined, { view: 'all' });
	const modelSet = data?.byProvider?.get(provider);
	if (!modelSet || !modelSet.has(model)) {
		return `model "${primary}" not found in catalog`;
	}
	return null;
}

/**
 * 构造 set + list 两个 handler。
 *
 * @param {object} opts
 * @param {object} opts.sdk
 * @param {Function} opts.sdk.mutateConfigFile - openclaw/plugin-sdk/config-mutation
 * @param {Function} opts.sdk.buildModelsProviderData - openclaw/plugin-sdk/models-provider-runtime
 * @param {Function} opts.sdk.isProviderAuthProfileConfigured - openclaw/plugin-sdk/provider-auth（set 用）
 * @param {Function} opts.sdk.isProviderApiKeyConfigured - openclaw/plugin-sdk/provider-auth（list 凭据信号用）
 * @param {Function} opts.sdk.hasConfiguredSecretInput - openclaw/plugin-sdk/provider-auth（list 内联 key 判定）
 * @param {Function} opts.sdk.ensureAuthProfileStore - openclaw/plugin-sdk/provider-auth（list 账本非空判定）
 * @param {Function} opts.loadConfig - 返回当前 cfg snapshot；缺失时返回 null
 * @param {Function} opts.resolveAgentDir - 返回 main agent /agent 子目录全路径
 * @returns {{ set: Function, list: Function }}
 */
export function buildModelDefaultHandlers({ sdk, loadConfig, resolveAgentDir }) {
	async function set({ params, respond }) {
		try {
			if (!params || typeof params !== 'object' || Array.isArray(params)) {
				respondInvalid(respond, 'params must be an object');
				return;
			}
			for (const key of Object.keys(params)) {
				if (!ALLOWED_KEYS.has(key)) {
					respondInvalid(respond, `unknown field: ${key}`);
					return;
				}
			}

			const { agentId } = params;
			if (agentId !== undefined && !isNonEmptyString(agentId)) {
				respondInvalid(respond, 'agentId must be a non-empty string when provided');
				return;
			}

			if (!Object.hasOwn(params, 'primary')) {
				respondInvalid(respond, 'primary is required');
				return;
			}
			const rawPrimary = params.primary;
			if (rawPrimary !== null && typeof rawPrimary !== 'string') {
				respondInvalid(respond, 'primary must be a string or null');
				return;
			}
			// 复制粘贴常带前后空白；trim 后再做形态/凭据/catalog 校验，并按 trim 后的值落盘
			const primary = rawPrimary === null ? null : rawPrimary.trim();
			if (primary !== null && primary.length === 0) {
				respondInvalid(respond, 'primary must be a non-empty string or null');
				return;
			}

			if (primary !== null) {
				// 形态校验前置：纯字符串检查，不依赖 cfg → cfg 不可读时也能给 INVALID_ARGS
				const parts = parseProviderModel(primary);
				if (!parts) {
					respondInvalid(respond, 'primary must look like "<provider>/<model>"');
					return;
				}
				const cfg = loadConfig();
				if (!cfg) {
					respondIoFailed(respond, new Error('runtime config not available'));
					return;
				}
				const validationError = await validateProviderCredAndCatalog({
					...parts,
					primary,
					cfg,
					sdk,
					agentDir: resolveAgentDir(),
				});
				if (validationError) {
					respondInvalid(respond, validationError);
					return;
				}
			}

			// 单独 catch 写盘错误为 IO_FAILED；外层 catch 兜更上层异常（DI 调用本身崩之类）
			try {
				await writePrimary(
					{ agentId, primary },
					{ mutateConfigFile: sdk.mutateConfigFile },
				);
			}
			catch (err) {
				respondIoFailed(respond, err);
				return;
			}

			respond(true, {});
		}
		catch (err) {
			respondIoFailed(respond, err);
		}
	}

	async function list({ respond }) {
		try {
			const cfg = loadConfig();
			if (!cfg) {
				respondIoFailed(respond, new Error('runtime config not available'));
				return;
			}
			// 凭据信号（providerUsable / hasAnyUsableCredential）借三源判定：
			// env+账本 走 isProviderApiKeyConfigured（别名归一化其内部完成），
			// 内联 key 走 hasConfiguredSecretInput，账本非空走 ensureAuthProfileStore。
			const deps = {
				agentDir: resolveAgentDir(),
				isProviderApiKeyConfigured: sdk.isProviderApiKeyConfigured,
				hasConfiguredSecretInput: sdk.hasConfiguredSecretInput,
				ensureAuthProfileStore: sdk.ensureAuthProfileStore,
			};
			respond(true, listAllPrimariesWithCredentials(cfg, deps));
		}
		catch (err) {
			respondIoFailed(respond, err);
		}
	}

	return { set, list };
}
