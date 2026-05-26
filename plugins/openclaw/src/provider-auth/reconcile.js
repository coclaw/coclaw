/**
 * reconcile.js —— gateway 启动时把已绑定 provider 的配置模型清单对账成内置表
 *
 * 为什么需要：模型清单只在"登录成功那一刻"写一次。插件升级后表里补了新 MiniMax 模型，
 * 但老用户早已绑定、不会重新扫码——配置里还是旧清单，新模型永远不出现。启动对账补上这条：
 * 升级装新版必然重启 gateway，重启时拿表跟配置比，不一致就刷新，用户零操作。
 *
 * **关键防御（一致就一字不写）**：mutateConfigFile 是无条件写盘的（克隆→改→写，不做 diff 短路）。
 * 而"写配置"将来万一被上游改成触发 gateway 重启，无脑每次启动都写就会反复重启。所以这里
 * **先比对、只在真不一致时才写**——即便上游哪天那么干，也只会重启一次（写完即一致，下次启动
 * 判定 in-sync 不写、不重启）。
 */

import { PORTAL_PROVIDER_ID } from './minimax-oauth.js';
import { getPortalModels, portalModelsMatch } from './portal-model-catalog.js';

/**
 * 对账某个 portal-style provider 的配置模型清单。
 *
 * @param {object} opts
 * @param {Function} opts.getConfig - () → 当前 cfg 快照（getClawConfig）；null/缺时跳过
 * @param {Function} opts.mutateConfigFile - openclaw/plugin-sdk/config-mutation 的写盘入口
 * @param {string} [opts.providerId] - 默认 minimax-portal
 * @returns {Promise<{changed:boolean, reason:string}>} reason: no-config|not-bound|no-catalog|in-sync|updated
 */
export async function reconcilePortalModels({ getConfig, mutateConfigFile, providerId = PORTAL_PROVIDER_ID }) {
	const cfg = getConfig?.();
	// runtime 未注入 / config 不可读：跳过，下次启动再对
	if (!cfg || typeof cfg !== 'object') return { changed: false, reason: 'no-config' };
	const node = cfg.models?.providers?.[providerId];
	// 未绑定（无 provider 节点）→ 不碰。登录成功时已写过节点 + 清单，绑定后才谈得上对账
	if (!node || typeof node !== 'object' || Array.isArray(node)) return { changed: false, reason: 'not-bound' };
	const target = getPortalModels(providerId);
	// 表里没这个 provider（理论不该发生）→ 不动用户已有清单
	if (target.length === 0) return { changed: false, reason: 'no-catalog' };
	// 前提（务必留意）：getConfig 读的是「解析后」配置（config.current()），而 mutateConfigFile
	// 默认写「源」配置。对 minimax-portal 这俩的 models 相等——上游 bundled discovery 不给第三方
	// 扫码 provider 注入 catalog（已真机核实），解析不会增删它的模型条目，故这里读解析、写源是安全的。
	// 若上游将来改为给第三方 portal 注入模型，解析后会多出条目而源里没有 → 这里永远判不一致 → 每次
	// 启动都写；届时必须改成比对「源」配置（如 getRuntimeConfigSourceSnapshot 一类），否则正是本文件
	// 想防的反复写/重启循环。
	// 已一致 → 零写入（防重启循环的闸）
	if (portalModelsMatch(node.models, target)) return { changed: false, reason: 'in-sync' };

	await mutateConfigFile({
		afterWrite: { mode: 'auto' },
		mutate(draft) {
			const p = draft.models?.providers?.[providerId];
			// 读后到写之间被并发删（极少）→ 不无中生有重建节点，只刷新已存在的
			if (!p || typeof p !== 'object' || Array.isArray(p)) return;
			p.models = getPortalModels(providerId);
		},
	});
	return { changed: true, reason: 'updated' };
}
