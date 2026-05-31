/**
 * model-default/handlers.js —— coclaw.model.set / list / listAvailable 三个 RPC 的纯函数实现
 *   （listAvailable 即原 listUsable 改名；index.js 把 listUsable 留作过渡别名映到同一 handler）
 *
 * 设计要点（详见 docs/model-config-api.md § 3）：
 * - DI 注入 sdk（mutateConfigFile / loadModelCatalog / provider-auth 凭据探针 / resolveProviderIdForAuth）
 *   + loadConfig + resolveAgentDir，便于单测；产线注入在 ./index.js
 * - **出参不加 status wrap**（gateway-method-design skill 约定）：set → {}；list → { default, agents }；
 *   listAvailable → { byProvider }（configuredProviders 已迁出，UI 加 provider 排除改吃 catalog.hasCred）
 * - 错误码只用 INVALID_ARGS / IO_FAILED，参考 provider-auth/handlers.js
 *   既有 plugin 的 respondError 用 INTERNAL_ERROR 与本节契约不一致，所以本模块自带局部 helper
 * - set 校验 fail-fast 顺序：params shape → 拒未知字段 → agentId → primary 类型 → primary 形态
 *   （纯字符串：含 '/'、'/' 不在端点；不依赖 cfg）→ loadConfig → 凭据门 → 存在性
 *   形态校验**前置在 loadConfig 之前**，cfg 不可读时非法形态仍是 INVALID_ARGS 而非 IO_FAILED
 * - 凭据门 + 选模型器枚举 + list 信号全部走统一别名感知原语（resolve.js），杜绝跨界面口径分叉（§ 3.2.1）
 * - set 存在性 + listAvailable 枚举走同一目录源 loadModelCatalog({readOnly:false})：选得到 ⇒ 设得上（红线天然成立）。
 *   用 readOnly:false（含 manifest 合并）才带进 openai-codex/* 等 manifest-only provider；readOnly:true 只读落盘，
 *   这类从不落盘的 provider 缺失（oauth 已授权却选不出，本次回归根因）。
 */

import { listAllPrimariesWithCredentials, computeProviderUsable, enumerateUsableModels } from './resolve.js';
import { writePrimary } from './persist.js';

const SET_ALLOWED_KEYS = new Set(['agentId', 'primary']);
const LISTAVAILABLE_ALLOWED_KEYS = new Set(['agentId']);

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
 * 构造 set / listAvailable 用的统一别名感知凭据 deps。
 * @param {object} sdk
 * @param {string} agentDir
 * @returns {object}
 */
function buildCredDeps(sdk, agentDir) {
	return {
		agentDir,
		isProviderApiKeyConfigured: sdk.isProviderApiKeyConfigured,
		hasConfiguredSecretInput: sdk.hasConfiguredSecretInput,
		ensureAuthProfileStore: sdk.ensureAuthProfileStore,
		resolveProviderIdForAuth: sdk.resolveProviderIdForAuth,
	};
}

/**
 * cfg 相关的 primary 校验：凭据门 + 目录源存在性。
 * 形态拆分由调用方完成（fail-fast 前置在 loadConfig 之前）。
 *
 * - 凭据门走统一原语 computeProviderUsable（取代旧 ledger-only isProviderAuthProfileConfigured）：
 *   覆盖 env + 账本 + 内联 + 别名套餐，修「内联/env/别名 provider 选得到设不上」，且继续拒幽灵
 *   （无任何源凭据的 openai/gpt-5.5 被门挡住）。cooldown 中凭据仍算已配置（沿用 isProviderApiKeyConfigured 立场）。
 * - 存在性走目录源 loadModelCatalog({readOnly:false})（与选模型器枚举同源 → 「选得到设不上」红线天然成立）；
 *   用 readOnly:false（含 manifest 合并）才有 openai-codex/* 这类 manifest-only provider（readOnly:true 只读落盘缺它们）。
 *   它返回全量 manifest，但与凭据门联用并不过松——无凭据 provider 仍被门挡住；且非 buildModelsProviderData，无幽灵注入。
 *   整体抛错由外层 catch 映射 IO_FAILED（set 是写操作，失败安全为先）。
 *
 * @returns {Promise<string|null>} 错误 message；null 表通过
 */
async function validateProviderCredAndCatalog({ provider, model, primary, cfg, sdk, deps }) {
	if (!computeProviderUsable(primary, cfg, deps)) {
		return `provider "${provider}" has no usable credential`;
	}
	const entries = await sdk.loadModelCatalog({ readOnly: false });
	const exists = Array.isArray(entries)
		&& entries.some((e) => e && e.provider === provider && e.id === model);
	if (!exists) {
		return `model "${primary}" not found in catalog`;
	}
	return null;
}

/**
 * 构造 set / list / listAvailable 三个 handler。
 *
 * @param {object} opts
 * @param {object} opts.sdk
 * @param {Function} opts.sdk.mutateConfigFile - openclaw/plugin-sdk/config-mutation（set 写盘）
 * @param {Function} opts.sdk.loadModelCatalog - openclaw/plugin-sdk/agent-runtime（set 存在性 + listAvailable 枚举的目录源）
 * @param {Function} opts.sdk.isProviderApiKeyConfigured - openclaw/plugin-sdk/provider-auth（env+账本凭据信号，别名感知）
 * @param {Function} opts.sdk.hasConfiguredSecretInput - openclaw/plugin-sdk/provider-auth（内联 key 判定）
 * @param {Function} opts.sdk.ensureAuthProfileStore - openclaw/plugin-sdk/provider-auth（账本非空判定）
 * @param {Function} opts.sdk.resolveProviderIdForAuth - openclaw/plugin-sdk/agent-runtime（别名归一）
 * @param {Function} opts.loadConfig - 返回当前 cfg snapshot；缺失时返回 null
 * @param {Function} opts.resolveAgentDir - 返回 agent /agent 子目录全路径（默认 main agent；agentId 贯穿）
 * @returns {{ set: Function, list: Function, listAvailable: Function }}
 */
export function buildModelDefaultHandlers({ sdk, loadConfig, resolveAgentDir }) {
	async function set({ params, respond }) {
		try {
			if (!params || typeof params !== 'object' || Array.isArray(params)) {
				respondInvalid(respond, 'params must be an object');
				return;
			}
			for (const key of Object.keys(params)) {
				if (!SET_ALLOWED_KEYS.has(key)) {
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
					deps: buildCredDeps(sdk, resolveAgentDir()),
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
			// 凭据信号（providerUsable / hasAnyUsableCredential）借统一别名感知原语：
			// env+账本 走 isProviderApiKeyConfigured（别名归一其内部完成），
			// 内联 key 走 hasConfiguredSecretInput + resolveProviderIdForAuth 两侧归一，
			// 账本非空走 ensureAuthProfileStore。
			respond(true, listAllPrimariesWithCredentials(cfg, buildCredDeps(sdk, resolveAgentDir())));
		}
		catch (err) {
			respondIoFailed(respond, err);
		}
	}

	async function listAvailable({ params, respond }) {
		try {
			if (!params || typeof params !== 'object' || Array.isArray(params)) {
				respondInvalid(respond, 'params must be an object');
				return;
			}
			for (const key of Object.keys(params)) {
				if (!LISTAVAILABLE_ALLOWED_KEYS.has(key)) {
					respondInvalid(respond, `unknown field: ${key}`);
					return;
				}
			}
			const { agentId } = params;
			if (agentId !== undefined && !isNonEmptyString(agentId)) {
				respondInvalid(respond, 'agentId must be a non-empty string when provided');
				return;
			}

			const cfg = loadConfig();
			if (!cfg) {
				respondIoFailed(respond, new Error('runtime config not available'));
				return;
			}

			// agentId 一路贯穿到凭据判定（与 set/providerUsable 同 agent 的 agentDir，不分叉）。
			// 产线 resolveAgentDir=mainAgentDir 忽略入参恒 main（凭据按设计统一落 main、各 agent 层叠可见），
			// 故四个消费点在产线天然同 dir；测试可注入按 agentId 分目录的 resolver 钉住贯穿。
			const deps = buildCredDeps(sdk, resolveAgentDir(agentId));

			// 目录源 loadModelCatalog({readOnly:false})：含 manifest 合并，才有 openai-codex/* 这类 manifest-only provider
			// （readOnly:true 只读落盘缺它们 → oauth 已授权却选不出，本次回归根因）。
			// 整体抛错（罕见，如 runtime config 取不到）→ 兜空 entries：byProvider 退化为空、handler 不崩。
			// UI 加 provider 排除已不依赖本出参（改吃 providerAuth.catalog 的 hasCred），故降级只影响可选模型清单。
			let entries;
			try {
				entries = await sdk.loadModelCatalog({ readOnly: false });
			}
			catch {
				entries = [];
			}

			respond(true, enumerateUsableModels(entries, cfg, deps));
		}
		catch (err) {
			respondIoFailed(respond, err);
		}
	}

	return { set, list, listAvailable };
}
