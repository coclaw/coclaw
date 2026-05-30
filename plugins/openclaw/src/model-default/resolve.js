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
 * 某 provider 是否配了内联 key（cfg.models.providers.<id>.apiKey）。
 * 别名感知：查询名与各内联节点 id 两侧都过 resolveProviderIdForAuth 归一后比较，
 * 故持基座 volcengine 内联 key 的用户查 volcengine-plan（套餐变体）也命中。
 * 仅是"配置信号"（hasConfiguredSecretInput 不验证 env 引用能否真解析，
 * 见心智模型典型陷阱 #20），方向偏向少误报。
 * @param {object} cfg
 * @param {string} provider - 裸 provider 名
 * @param {object} deps - { hasConfiguredSecretInput, resolveProviderIdForAuth }
 * @returns {boolean}
 */
function hasInlineKey(cfg, provider, deps) {
	const providers = cfg?.models?.providers;
	if (!providers || typeof providers !== 'object') return false;
	const targetId = deps.resolveProviderIdForAuth(provider);
	for (const [nodeId, entry] of Object.entries(providers)) {
		if (!entry || !deps.hasConfiguredSecretInput(entry.apiKey)) continue;
		if (deps.resolveProviderIdForAuth(nodeId) === targetId) return true;
	}
	return false;
}

/**
 * 某 provider（裸名）在自管账本里有没有任一来源凭据（oauth / token / api-key）。
 * 别名感知：查询名与各 profile 的 cred.provider 两侧都过 resolveProviderIdForAuth 归一后比较，
 * 与 computeConfiguredProviders 的账本口径一致（不校验 type：匹配到任一 well-formed profile 即算）。
 * 补 isProviderApiKeyConfigured 只认 api-key 的缺口：纯 OAuth provider（codex / copilot 等设备码家族）
 * 只有 oauth 凭据、无 key，旧逻辑两路皆 false 会被全组丢出 byProvider（见 changeset / TODO 根成因）。
 * 归一为空串的 provider 不匹配（与 computeConfiguredProviders 的丢弃空 id 一致），
 * 避免 whitespace-only 查询名与 whitespace-only cred 同归一到 '' 的误命中。
 * @param {string} provider - 裸 provider 名
 * @param {object} deps - { agentDir, ensureAuthProfileStore, resolveProviderIdForAuth }
 * @returns {boolean}
 */
function hasLedgerCred(provider, deps) {
	const store = deps.ensureAuthProfileStore(deps.agentDir, { allowKeychainPrompt: false });
	if (!store || !store.profiles || typeof store.profiles !== 'object') return false;
	const targetId = deps.resolveProviderIdForAuth(provider);
	if (!targetId) return false;
	for (const cred of Object.values(store.profiles)) {
		if (!cred || typeof cred.provider !== 'string' || cred.provider.length === 0) continue;
		if (deps.resolveProviderIdForAuth(cred.provider) === targetId) return true;
	}
	return false;
}

/**
 * 某 provider（裸名，无斜杠）有没有可用凭据 —— 统一别名感知原语。
 * 判定 = isProviderApiKeyConfigured（env + 账本里的 api-key，别名归一其内部完成）
 *        ∪ hasInlineKey（内联 key，别名归一）
 *        ∪ hasLedgerCred（账本里的 oauth/token 等非 api-key 凭据，别名归一）。
 * 覆盖 env + 内联 + 账本（api-key / oauth / token 全口径）+ 别名套餐；
 * 统一漏 IAM/本地（hasAuthForModelProvider 未导出 plugin-sdk，接受）。
 * 选模型器枚举 / model.set 门 / providerUsable 三个消费点同吃本原语；noKey 走姊妹原语
 * computeHasAnyUsableCredential（同源探针 + 账本判定），口径与本原语对齐、不跨界面分叉。
 * @param {string|null} provider - 裸 provider 名（如 'openai' / 'volcengine-plan'）
 * @param {object} cfg
 * @param {object} deps - { agentDir, isProviderApiKeyConfigured, hasConfiguredSecretInput, ensureAuthProfileStore, resolveProviderIdForAuth }
 * @returns {boolean}
 */
export function computeProviderUsableByName(provider, cfg, deps) {
	if (typeof provider !== 'string' || provider.length === 0) return false;
	if (deps.isProviderApiKeyConfigured({ provider, agentDir: deps.agentDir })) return true;
	if (hasInlineKey(cfg, provider, deps)) return true;
	return hasLedgerCred(provider, deps);
}

/**
 * 该 primary 那家 provider 有没有可用凭据：取 provider 段后委托 computeProviderUsableByName。
 * primary 解析不出 provider 段（含 null）时恒 false（UI 此时走 noPrimary，不看它）。
 * @param {string|null} primary
 * @param {object} cfg
 * @param {object} deps - 同 computeProviderUsableByName
 * @returns {boolean}
 */
export function computeProviderUsable(primary, cfg, deps) {
	return computeProviderUsableByName(providerSegmentOf(primary), cfg, deps);
}

/**
 * 收集"候选 provider 名"（未归一、原始拼写）供 env 探测：
 * default + 各 agent primary 的 provider 段 ∪ 内联节点 id ∪ 账本各 profile 的 provider。
 * env-only 凭据无法穷举所有环境变量名，只在这些候选上用 isProviderApiKeyConfigured 探测，
 * 与 providerAuth.list 的 env 口径一致（纯 env、又非主模型/账本/内联的 provider 不计，接受残留）。
 * @param {object} cfg
 * @param {object|null} store - ensureAuthProfileStore 返回值（可能为 null）
 * @returns {Set<string>}
 */
function collectCandidateProviders(cfg, store) {
	const out = new Set();
	const base = listAllPrimaries(cfg);
	const seg = providerSegmentOf(base.default.primary);
	if (seg) out.add(seg);
	for (const v of Object.values(base.agents)) {
		const s = providerSegmentOf(v.primary);
		if (s) out.add(s);
	}
	const providers = cfg?.models?.providers;
	if (providers && typeof providers === 'object') {
		for (const id of Object.keys(providers)) out.add(id);
	}
	if (store && store.profiles && typeof store.profiles === 'object') {
		for (const cred of Object.values(store.profiles)) {
			if (cred && typeof cred.provider === 'string' && cred.provider.length > 0) {
				out.add(cred.provider);
			}
		}
	}
	return out;
}

/**
 * 这台 claw 有没有任何可用凭据：自管账本非空 OR 任一内联 key OR 任一候选 provider 有 env key。
 * 驱动 UI 的 noKey 引导。必补 C：补 env（候选集口径见 collectCandidateProviders），
 * 与 per-provider 的 providerUsable 口径对齐，根治"纯 env-only 用户被误弹『还没加 key』"。
 * 补后仅漏纯 IAM-only/本地（pro，接受 spurious noKey）。
 * @param {object} cfg
 * @param {object} deps - { agentDir, ensureAuthProfileStore, hasConfiguredSecretInput, isProviderApiKeyConfigured }
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
	for (const provider of collectCandidateProviders(cfg, store)) {
		if (deps.isProviderApiKeyConfigured({ provider, agentDir: deps.agentDir })) return true;
	}
	return false;
}

/**
 * 别名归一的"已配 provider"集 = 用户已持任一来源凭据的基座 provider id 集，
 * 供 UI 加 provider 时排除（套餐用户持 volcengine key 后不再被叫去加 volcengine/volcengine-plan）。
 * 三源（每个都过 resolveProviderIdForAuth 归一后去重）：
 *   ① 账本各 profile 的 cred.provider
 *   ② 内联各带 apiKey 的节点 id
 *   ③ env 候选（collectCandidateProviders 口径）中 isProviderApiKeyConfigured 命中的
 * @param {object} cfg
 * @param {object} deps - { agentDir, ensureAuthProfileStore, hasConfiguredSecretInput, isProviderApiKeyConfigured, resolveProviderIdForAuth }
 * @returns {string[]} 升序去重
 */
export function computeConfiguredProviders(cfg, deps) {
	const store = deps.ensureAuthProfileStore(deps.agentDir, { allowKeychainPrompt: false });
	const out = new Set();
	const add = (raw) => {
		const id = deps.resolveProviderIdForAuth(raw);
		if (id) out.add(id);
	};
	if (store && store.profiles && typeof store.profiles === 'object') {
		for (const cred of Object.values(store.profiles)) {
			if (cred && typeof cred.provider === 'string' && cred.provider.length > 0) add(cred.provider);
		}
	}
	const providers = cfg?.models?.providers;
	if (providers && typeof providers === 'object') {
		for (const [id, entry] of Object.entries(providers)) {
			if (entry && deps.hasConfiguredSecretInput(entry.apiKey)) add(id);
		}
	}
	for (const provider of collectCandidateProviders(cfg, store)) {
		if (deps.isProviderApiKeyConfigured({ provider, agentDir: deps.agentDir })) add(provider);
	}
	return [...out].sort();
}

/**
 * 选模型器枚举（纯同步）：把目录源按 entry.provider 分组，留 computeProviderUsableByName 为真的 provider。
 * catalogEntries 由调用方传入（handler 调 loadModelCatalog({readOnly:false}) 后传进来；含 manifest 才有 openai-codex/* 这类 manifest-only provider），
 * 本函数不自己 await loadModelCatalog；空 / 非数组 entries → 空 byProvider。
 * 变体 provider（如 volcengine-plan）经 manifest 目录行进入 entries、再经基座 key 别名感知保留；
 * 无凭据 provider 被丢（含幽灵——幽灵根本不在 loadModelCatalog 这个源里）。
 *
 * 文本模态过滤：核实结论 = 不过滤。loadModelCatalog 输出的 ModelCatalogEntry 无 output kind 字段
 * （image_generation 等是网关响应的另一类型；imageModel 注入只在 buildModelsProviderData 尾部、不在此源），
 * 故无"纯图像/视频生成"条目混入；entry.input 是"输入"模态而非输出 kind，按它滤会误删多模态文本模型。
 *
 * @param {object[]} catalogEntries - loadModelCatalog({readOnly:false}) 的结果（ModelCatalogEntry[]）
 * @param {object} cfg
 * @param {object} deps - { agentDir, isProviderApiKeyConfigured, hasConfiguredSecretInput, resolveProviderIdForAuth, ensureAuthProfileStore }
 * @returns {{ byProvider: Record<string, string[]>, configuredProviders: string[] }}
 */
export function enumerateUsableModels(catalogEntries, cfg, deps) {
	const grouped = new Map(); // provider -> Set<modelId>
	if (Array.isArray(catalogEntries)) {
		for (const entry of catalogEntries) {
			if (!entry || typeof entry.provider !== 'string' || entry.provider.length === 0) continue;
			if (typeof entry.id !== 'string' || entry.id.length === 0) continue;
			let set = grouped.get(entry.provider);
			if (!set) {
				set = new Set();
				grouped.set(entry.provider, set);
			}
			set.add(entry.id);
		}
	}
	const byProvider = {};
	for (const [provider, ids] of grouped) {
		if (computeProviderUsableByName(provider, cfg, deps)) {
			byProvider[provider] = [...ids].sort();
		}
	}
	return { byProvider, configuredProviders: computeConfiguredProviders(cfg, deps) };
}

/**
 * 装配带凭据信号的 list 出参（docs/model-config-api.md § 3.4「凭据信号」）。
 * 在 listAllPrimaries 基础上给每个 scope 加 providerUsable，并加顶层 hasAnyUsableCredential。
 * @param {object} cfg
 * @param {object} deps - { agentDir, isProviderApiKeyConfigured, hasConfiguredSecretInput, ensureAuthProfileStore, resolveProviderIdForAuth }
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
