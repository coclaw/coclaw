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
