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
 * - 每个条目 `{ id, name }` 均必填非空：OpenClaw config model 条目 zod schema 要求二者皆为
 *   非空字符串。id 用 provider 返回的 proper-case，name 用展示名。
 */

export const PORTAL_MODEL_CATALOG = {
	// 与 openclaw-repo/extensions/minimax/provider-models.ts 的
	// MINIMAX_TEXT_MODEL_ORDER / MINIMAX_TEXT_MODEL_CATALOG 对齐
	'minimax-portal': [
		{ id: 'MiniMax-M2.7', name: 'MiniMax M2.7' },
		{ id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 Highspeed' },
	],
};

/**
 * 取某 provider 的静态清单。返回**深拷贝**，避免调用方改到共享常量。
 * 未知 provider → 空数组。
 *
 * @param {string} providerId
 * @returns {{id:string, name:string}[]}
 */
export function getPortalModels(providerId) {
	const list = PORTAL_MODEL_CATALOG[providerId];
	if (!Array.isArray(list)) return [];
	return list.map((m) => ({ id: m.id, name: m.name }));
}

/**
 * 判断配置里现有清单是否已与目标一致（顺序无关，按 id+name 比对）。
 * 启动对账靠它决定"要不要写"——一致就一字不写。
 *
 * @param {unknown} current - 配置里现有 models（可能缺失/非数组/脏条目）
 * @param {{id:string, name:string}[]} target - 目标清单
 * @returns {boolean} 完全一致返回 true
 */
export function portalModelsMatch(current, target) {
	if (!Array.isArray(current) || !Array.isArray(target)) return false;
	if (current.length !== target.length) return false;
	// 用 JSON 串化每个 (id,name) 再排序逐项比——顺序无关、且不会因 id/name 含空格而撞串
	const norm = (list) => list.map((m) => JSON.stringify([m?.id, m?.name])).sort();
	const a = norm(current);
	const b = norm(target);
	return a.every((v, i) => v === b[i]);
}
