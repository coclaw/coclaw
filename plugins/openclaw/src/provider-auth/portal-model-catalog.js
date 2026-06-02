/**
 * portal-model-catalog.js —— OAuth/token-plan provider 的静态模型清单表
 *
 * 背景：上游对 minimax-portal 这类 provider 的模型走**写死的静态清单**，且第三方插件触发不到
 * 它的 catalog discovery——实测 `models.list view:'all'` 也只为默认 provider + 声明了
 * discovery-source 的插件跑发现，扫码 provider 永远是空。所以不把清单写进 OpenClaw 配置，
 * catalog 就为空：UI 选不到、agent 用不了。CoClaw 在这里维护一份与上游对齐的静态表，
 * 登录成功 + gateway 启动对账时写进配置。详见 docs/model-config-api.md § 2.3。
 *
 * 维护约定：
 * - MiniMax 升代时**手动**更新本表（与上游 bundled `MINIMAX_TEXT_MODEL_ORDER` 对齐——
 *   上游那份也是手填手维护的源码常量，本表负担与之持平）。
 * - 将来再遇到同类"扫码/token-plan 但 catalog 不可达"的 provider，在此加一行即可。
 * - `id` / `name` 必填非空（OpenClaw config model 条目 zod schema 要求）；id 用 provider
 *   返回的 proper-case，name 用展示名。
 * - 只维护**最必须的运行元数据**：`reasoning`（是否推理模型——缺省会被当成 false，导致推理
 *   模型被按普通模型处理、思考模式出错）、`contextWindow`、`maxTokens`。**不写 `cost`**：
 *   portal 走 token plan、不按量计费，价格无意义；`input` 默认不写（系统默认即 `['text']`），
 *   除非该型号多模态（如 M3 支持 `['text', 'image']`）才显式写出。
 *   这几个值与上游 `model-definitions.ts`（DEFAULT_MINIMAX_CONTEXT_WINDOW=204800 /
 *   MINIMAX_M3_CONTEXT_WINDOW=1_000_000 / DEFAULT_MINIMAX_MAX_TOKENS=131072）+
 *   `provider-models.ts`（reasoning / input 标记）对齐。
 */

export const PORTAL_MODEL_CATALOG = {
	// 与 openclaw-repo/extensions/minimax/ 的 provider-models.ts(reasoning/input) +
	// model-definitions.ts(contextWindow/maxTokens) 对齐；M3 起为上游默认型号、放首位
	'minimax-portal': [
		{ id: 'MiniMax-M3', name: 'MiniMax M3', reasoning: true, input: ['text', 'image'], contextWindow: 1000000, maxTokens: 131072 },
		{ id: 'MiniMax-M2.7', name: 'MiniMax M2.7', reasoning: true, contextWindow: 204800, maxTokens: 131072 },
		{ id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 Highspeed', reasoning: true, contextWindow: 204800, maxTokens: 131072 },
	],
};

/**
 * 取某 provider 的静态清单。返回**深拷贝**，避免调用方改到共享常量。
 * 未知 provider → 空数组。用 `structuredClone` 而非 `{ ...m }`：条目含嵌套字段（如 M3 的
 * `input` 数组），浅拷贝会让返回值与共享常量复用同一个数组引用，调用方 push/splice 即污染原表。
 *
 * @param {string} providerId
 * @returns {{id:string, name:string, reasoning?:boolean, input?:string[], contextWindow?:number, maxTokens?:number}[]}
 */
export function getPortalModels(providerId) {
	const list = PORTAL_MODEL_CATALOG[providerId];
	if (!Array.isArray(list)) return [];
	return list.map((m) => structuredClone(m));
}

/**
 * 判断配置里现有清单是否已**覆盖**目标的全部模型——**只按 id**，顺序无关。
 * 启动对账靠它决定"要不要写"：目标里每个 id 都已在现有清单出现 → 视为已同步、一字不写。
 *
 * 只按 id（不连 name / 其它字段）是有意为之：模型能不能被选、被用由 id 决定。这样别的来源
 * （如官方 MiniMax 插件）往同一 provider 写一份更大的清单（只要含我们的 id）时，配置成我们的
 * 超集也判已覆盖、不去覆盖它——避免每次重启都把它改回我们这份、和它来回打架。name / 参数即便
 * 与我们不同也不触发写：只保证我们的 id 在，别人的多余条目随它去。
 *
 * @param {unknown} current - 配置里现有 models（可能缺失/非数组/脏条目）
 * @param {{id:string}[]} target - 目标清单（内置表，id 必为非空字符串）
 * @returns {boolean} target 的每个 id 都在 current 出现 → true（空 target 天然被覆盖）
 */
export function portalModelsCoveredById(current, target) {
	if (!Array.isArray(target)) return false;
	const have = new Set(Array.isArray(current) ? current.map((m) => m?.id) : []);
	return target.every((m) => have.has(m?.id));
}
