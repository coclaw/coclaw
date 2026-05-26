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
import { getPortalModels, portalModelsCoveredById } from './portal-model-catalog.js';

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
	// 只按 id 判"已覆盖"：目标里每个 model id 都已在配置现有清单出现 → 视为已同步、零写入。
	// 比"全等"宽容——配置是我们的超集（别的来源，如官方 MiniMax 插件，多写了几个模型）时也判已覆盖、
	// 不去动它，避免和它来回覆盖、反复重启。仅当配置缺了我们某个 id（升级新增模型 / 老配置不全）才写。
	// 顺带说清读/写不对称：getConfig 读「解析后」配置（config.current()），mutateConfigFile 默认写
	// 「源」配置。即便上游将来在解析期给第三方 portal 注入额外模型，那也只是让配置成超集、我们的 id 仍在
	// → 判已覆盖 → 不写，不会触发"永远判不一致、每次启动都写"的循环。
	if (portalModelsCoveredById(node.models, target)) return { changed: false, reason: 'in-sync' };

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
