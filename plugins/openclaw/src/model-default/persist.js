/**
 * model-default/persist.js —— 把 default/per-agent primary 字段级写回 cfg
 *
 * 关键约束（钉死自 D1 dump v9 + zod-schema.agent-model.ts AgentModelSchema）：
 * - 走 mutateConfigFile —— mutator 拿到的是 structuredClone 出的 deep draft，字段级修改安全；
 *   但**整体重写 model 字段会丢失 fallbacks / timeoutMs 等兄弟字段**，必须按现有形态分支处理
 * - model 字段有三态：string 简写（等价 { primary }）/ object / 缺省
 *   - object 形态：保留 fallbacks / timeoutMs，只动 primary 一项
 *   - string 形态：升级成 { primary }（原 string 本来就只有 primary 这一项语义，无损）
 *   - 缺省形态：直接置 { primary }
 * - clear primary 时：object 上 delete primary；若 object 删掉 primary 后没剩字段，删整个 model；
 *   string 形态直接删 model；entry / defaults 容器留空壳，不主动从 list 删（dump v9 § "删除某 scope 覆盖"）
 * - last-writer-wins，不传 baseHash（mutate.ts assertBaseHashMatches 在 undefined 时直接通过）
 */

/**
 * 把 default 或某 agent 的 primary 写回 cfg。
 *
 * @param {object} args
 * @param {string} [args.agentId] - 缺省 = default scope；传非空 string = per-agent scope
 * @param {string|null} args.primary - 非空 string 为设；null 为清
 * @param {object} deps
 * @param {Function} deps.mutateConfigFile - openclaw/plugin-sdk/config-mutation 的 mutateConfigFile
 */
export async function writePrimary(args, deps) {
	const { agentId, primary } = args;
	const { mutateConfigFile } = deps;
	await mutateConfigFile({
		mutate(draft) {
			ensureAgents(draft);
			if (agentId === undefined || agentId === null) {
				applyDefaultScope(draft, primary);
				return;
			}
			applyAgentScope(draft, agentId, primary);
		},
	});
}

function ensureAgents(draft) {
	const a = draft.agents;
	if (!a || typeof a !== 'object' || Array.isArray(a)) {
		draft.agents = {};
	}
}

function applyDefaultScope(draft, primary) {
	if (primary === null) {
		clearOnContainer(draft.agents.defaults);
		// defaults 容器即便清空也保留，避免影响 cfg 中其它 defaults.* 字段（这里没改它们）
		return;
	}
	const d = draft.agents.defaults;
	if (!d || typeof d !== 'object' || Array.isArray(d)) {
		draft.agents.defaults = {};
	}
	setOnContainer(draft.agents.defaults, primary);
}

function applyAgentScope(draft, agentId, primary) {
	if (!Array.isArray(draft.agents.list)) {
		draft.agents.list = [];
	}
	const idx = draft.agents.list.findIndex((e) => e?.id === agentId);
	if (primary === null) {
		if (idx === -1) return; // 没该 entry，无操作
		clearOnContainer(draft.agents.list[idx]);
		// dump v9：entry 整个就只剩这一项时留空壳，不主动从 list 删
		return;
	}
	if (idx === -1) {
		// AgentEntrySchema 内部所有子 schema 都 optional 或外层 optional，
		// { id, model: { primary } } 是合法最小 entry（核源 zod-schema.agent-runtime.ts:889）
		draft.agents.list.push({ id: agentId, model: { primary } });
		return;
	}
	setOnContainer(draft.agents.list[idx], primary);
}

/**
 * 在容器（defaults 对象 或 list[i] entry）上字段级设置 model.primary。
 * 容器存在性已由调用方保证。
 */
function setOnContainer(container, primary) {
	const cur = container.model;
	if (cur && typeof cur === 'object') {
		// 保留 fallbacks / timeoutMs 等兄弟字段
		cur.primary = primary;
		return;
	}
	// string / undefined / null：原状态没有可保留的兄弟字段，直接置 { primary }
	container.model = { primary };
}

/**
 * 在容器上字段级清除 model.primary。
 * 容器不存在 / model 不存在 → 无操作。
 */
function clearOnContainer(container) {
	if (!container || typeof container !== 'object') return;
	const cur = container.model;
	if (cur === undefined || cur === null) return;
	if (typeof cur === 'string') {
		// string 形态整个就只表达 primary，删 model 即清
		delete container.model;
		return;
	}
	if (typeof cur === 'object') {
		delete cur.primary;
		// primary 是 model object 唯一字段时整体删，避免留 {} 空壳
		if (Object.keys(cur).length === 0) {
			delete container.model;
		}
	}
}
