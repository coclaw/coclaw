/**
 * model-default/resolve.js —— 从 cfg 读 default + per-agent primary 的纯函数
 *
 * model 字段三态（见上游 zod-schema.agent-model.ts AgentModelSchema）：
 * - string：modelId 简写形态，等价于 { primary: <string> }
 * - object：{ primary?, fallbacks?, timeoutMs? }，primary 可缺省（schema 标了 optional）
 * - 缺省 / null：未设
 *
 * D1 只读 primary 字段；fallbacks / timeoutMs 在 list RPC 出参里不暴露
 * （设计 dump v9 § "RPC method"、docs/model-config-api.md § 3）。
 */

export const MAIN_AGENT_ID = 'main';

/**
 * 从 model 字段（string|object|null|undefined）中提取 primary。
 * @param {unknown} modelField - cfg.agents.defaults.model 或 cfg.agents.list[i].model
 * @returns {string|null}
 */
export function readPrimaryFromModel(modelField) {
	if (typeof modelField === 'string') {
		return modelField.length > 0 ? modelField : null;
	}
	if (modelField && typeof modelField === 'object') {
		const p = modelField.primary;
		return typeof p === 'string' && p.length > 0 ? p : null;
	}
	return null;
}

/**
 * 读 default scope 的 primary（cfg.agents.defaults.model）
 * @param {object} cfg
 * @returns {string|null}
 */
export function readDefaultPrimary(cfg) {
	return readPrimaryFromModel(cfg?.agents?.defaults?.model);
}

/**
 * 读某 agent 的 primary（cfg.agents.list[i].model）。
 * 未找到该 agentId 也返回 null（与"未设"不区分）。
 * @param {object} cfg
 * @param {string} agentId
 * @returns {string|null}
 */
export function readAgentPrimary(cfg, agentId) {
	const entry = findAgentEntry(cfg, agentId);
	return entry ? readPrimaryFromModel(entry.model) : null;
}

/**
 * 在 cfg.agents.list 里按 id 找 entry。
 * @returns {object|null}
 */
export function findAgentEntry(cfg, agentId) {
	const list = cfg?.agents?.list;
	if (!Array.isArray(list)) return null;
	return list.find((e) => e?.id === agentId) ?? null;
}

/**
 * 装配 coclaw.model.list 出参（D1 契约见 docs/model-config-api.md § 3）。
 * agents 来源：cfg.agents.list 所有 entry + 永远包含 main（心智模型 § 3.5）。
 * @param {object} cfg
 * @returns {{
 *   default: { primary: string|null },
 *   agents: Record<string, { primary: string|null }>,
 * }}
 */
export function listAllPrimaries(cfg) {
	const out = {
		default: { primary: readDefaultPrimary(cfg) },
		agents: {},
	};
	const list = cfg?.agents?.list;
	if (Array.isArray(list)) {
		for (const entry of list) {
			if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) continue;
			out.agents[entry.id] = { primary: readPrimaryFromModel(entry.model) };
		}
	}
	// main agent 始终存在（心智模型 § 3.5）：cfg list 没显式 main entry 时补一条 primary=null
	if (!Object.hasOwn(out.agents, MAIN_AGENT_ID)) {
		out.agents[MAIN_AGENT_ID] = { primary: null };
	}
	return out;
}

/**
 * 取 primary 的 provider 段（'<provider>/<model>' 中第一个 '/' 之前）。
 * 不含 '/' 或 '/' 在开头（provider 段为空）时返回 null。
 * 不做别名归一化——交给下游 isProviderApiKeyConfigured 内部完成。
 * @param {string|null} primary
 * @returns {string|null}
 */
export function providerSegmentOf(primary) {
	if (typeof primary !== 'string') return null;
	const slashIdx = primary.indexOf('/');
	if (slashIdx <= 0) return null;
	return primary.slice(0, slashIdx);
}

/**
 * 某 provider 是否配了内联 key（cfg.models.providers[provider].apiKey）。
 * 仅是"配置信号"（hasConfiguredSecretInput 不验证 env 引用能否真解析，
 * 见心智模型典型陷阱 #20），方向偏向少误报。
 */
function hasInlineKey(cfg, provider, hasConfiguredSecretInput) {
	const entry = cfg?.models?.providers?.[provider];
	return entry ? hasConfiguredSecretInput(entry.apiKey) : false;
}

/**
 * 该 primary 那家 provider 有没有可用凭据。
 * 判定 = isProviderApiKeyConfigured（覆盖环境变量 + 自管账本，别名归一化其内部完成）
 *        或 该 provider 配了内联 key。
 * primary 解析不出 provider 段（含 null）时恒 false（UI 此时走 noPrimary，不看它）。
 * @param {string|null} primary
 * @param {object} cfg
 * @param {object} deps - { agentDir, isProviderApiKeyConfigured, hasConfiguredSecretInput }
 * @returns {boolean}
 */
export function computeProviderUsable(primary, cfg, deps) {
	const provider = providerSegmentOf(primary);
	if (!provider) return false;
	if (deps.isProviderApiKeyConfigured({ provider, agentDir: deps.agentDir })) return true;
	return hasInlineKey(cfg, provider, deps.hasConfiguredSecretInput);
}

/**
 * 这台 claw 有没有任何可用凭据：自管账本非空 或 任一 provider 节点有内联 key。
 * 驱动 UI 的 noKey 引导。
 * @param {object} cfg
 * @param {object} deps - { agentDir, ensureAuthProfileStore, hasConfiguredSecretInput }
 * @returns {boolean}
 */
export function computeHasAnyUsableCredential(cfg, deps) {
	const store = deps.ensureAuthProfileStore(deps.agentDir, { allowKeychainPrompt: false });
	if (store && store.profiles && Object.keys(store.profiles).length > 0) return true;
	const providers = cfg?.models?.providers;
	if (providers && typeof providers === 'object') {
		for (const entry of Object.values(providers)) {
			if (entry && deps.hasConfiguredSecretInput(entry.apiKey)) return true;
		}
	}
	return false;
}

/**
 * 装配带凭据信号的 list 出参（docs/model-config-api.md § 3.4「凭据信号」）。
 * 在 listAllPrimaries 基础上给每个 scope 加 providerUsable，并加顶层 hasAnyUsableCredential。
 * @param {object} cfg
 * @param {object} deps - { agentDir, isProviderApiKeyConfigured, hasConfiguredSecretInput, ensureAuthProfileStore }
 * @returns {{
 *   default: { primary: string|null, providerUsable: boolean },
 *   agents: Record<string, { primary: string|null, providerUsable: boolean }>,
 *   hasAnyUsableCredential: boolean,
 * }}
 */
export function listAllPrimariesWithCredentials(cfg, deps) {
	const base = listAllPrimaries(cfg);
	const out = {
		default: {
			primary: base.default.primary,
			providerUsable: computeProviderUsable(base.default.primary, cfg, deps),
		},
		agents: {},
		hasAnyUsableCredential: computeHasAnyUsableCredential(cfg, deps),
	};
	for (const [id, v] of Object.entries(base.agents)) {
		out.agents[id] = {
			primary: v.primary,
			providerUsable: computeProviderUsable(v.primary, cfg, deps),
		};
	}
	return out;
}
