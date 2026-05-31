import { defineStore } from 'pinia';

import { useClawsStore } from './claws.store.js';
import { getReadyConn } from './get-ready-conn.js';
import { useAgentsStore } from './agents.store.js';
import { useSessionsStore } from './sessions.store.js';
import { mapToolsToCapabilities } from '../utils/capability-map.js';
import { generateModelTags } from '../utils/model-tags.js';

/**
 * @typedef {{
 *   loading: boolean,
 *   error: string|null,
 *   instance: DashboardInstance|null,
 *   agents: DashboardAgent[],
 *   hasUsableCredential: boolean,
 *   primaryModel: string|null,
 *   primaryProviderUsable: boolean,
 *   modelConfigFetched: boolean,
 * }} DashboardData
 *
 * @typedef {{
 *   name: string,
 *   online: boolean,
 *   pluginVersion: string|null,
 *   clawVersion: string|null,
 *   monthlyCost: object|null,
 *   channels: { id: string, connected: boolean }[],
 *   model: string|null,
 *   provider: string|null,
 * }} DashboardInstance
 *
 * @typedef {{
 *   id: string,
 *   name: string,
 *   avatarUrl: string|null,
 *   emoji: string|null,
 *   theme: string|null,
 *   modelTags: import('../utils/model-tags.js').ModelTag[],
 *   capabilities: { id: string, labelKey: string, icon: string }[],
 *   totalTokens: number,
 *   activeSessions: number,
 *   lastActivity: string|null,
 * }} DashboardAgent
 */

// =====================================================================
// 辅助函数（模块内部）
// =====================================================================

/**
 * 从 channels.status 响应构建频道列表
 * @param {object|null} channelsData
 * @returns {{ id: string, connected: boolean }[]}
 */
function buildChannelList(channelsData) {
	if (!channelsData || typeof channelsData !== 'object') return [];
	return Object.entries(channelsData)
		.filter(([, data]) => data && typeof data === 'object' && Array.isArray(data.accounts))
		.map(([id, data]) => ({
			id,
			connected: data.accounts.some(a => a.enabled !== false),
		}));
}

/**
 * 从 tools.catalog 响应提取工具 ID 列表
 * @param {object|null} toolsCatalog - { groups: [{ tools: [{ id }] }] }
 * @returns {string[]}
 */
function extractToolIds(toolsCatalog) {
	if (!toolsCatalog?.groups) return [];
	return toolsCatalog.groups.flatMap(g =>
		Array.isArray(g.tools) ? g.tools.map(t => t.id) : []
	);
}

/**
 * 从模型 catalog 中查找当前模型
 * @param {string|null} modelId
 * @param {object[]} catalog
 * @returns {object|null}
 */
function findCurrentModel(modelId, catalog) {
	if (!modelId || !Array.isArray(catalog)) return null;
	return catalog.find(m => m.id === modelId) ?? null;
}

/**
 * 按 agentId 过滤 session 列表
 * @param {object[]} sessions
 * @param {string} agentId
 * @returns {object[]}
 */
function filterSessionsByAgent(sessions, agentId) {
	return sessions.filter(s => {
		const key = s.key || '';
		return key.startsWith(`agent:${agentId}:`);
	});
}

/**
 * 计算 session 统计信息
 * @param {object[]} sessions
 * @returns {{ totalTokens: number, activeSessions: number, lastActivity: string|null }}
 */
function computeSessionStats(sessions) {
	let totalTokens = 0;
	let lastActivity = null;
	for (const s of sessions) {
		if (typeof s.totalTokens === 'number') totalTokens += s.totalTokens;
		if (s.updatedAt) {
			const t = new Date(s.updatedAt).getTime();
			if (!lastActivity || t > lastActivity) lastActivity = t;
		}
	}
	return {
		totalTokens,
		activeSessions: sessions.length,
		lastActivity: lastActivity ? new Date(lastActivity).toISOString() : null,
	};
}

/**
 * 判定主模型是否在可用清单内（设置子页 primary 有效性，决策4）。
 *
 * 两个必须输入：当前 primary + 可用清单（`coclaw.model.listAvailable` 的 byProvider）。
 * 任一未就绪 → 返回 null（信息不全，先不下结论、不误报）；都就绪才判 membership。
 * 一次 membership 同时等价于"该 provider 有凭据 ∧ model 在目录内"（listAvailable 已在插件侧
 * 过别名感知凭据门 + 目录交集），比旧 view:all 裸比对更严、且去掉最后一个 view:all 消费点。
 *
 * "可用清单未就绪"用 available 非对象（null）表达，而非空对象：
 *   - listAvailable 成功但 byProvider 为空 = 权威的"无可用模型" → available={} → 不在清单 → false（失效）
 *   - listAvailable 还没回来 / 失败 = available=null → 不下结论 → null
 *
 * 仪表盘不用本函数：仪表盘只看 `default.providerUsable`、不查可用清单（§7.4）。
 *
 * @param {string|null|undefined} primary - 主模型字符串 `<provider>/<model>`
 * @param {Record<string, string[]>|null|undefined} available - 可用清单 byProvider；null=未就绪
 * @returns {boolean|null} null=信息不全不下结论；true=在可用清单内；false=不在
 */
export function computePrimaryEffective(primary, available) {
	if (!primary || typeof primary !== 'string') return null;
	const idx = primary.indexOf('/');
	if (idx <= 0 || idx === primary.length - 1) return null;
	if (!available || typeof available !== 'object') return null;
	const provider = primary.slice(0, idx);
	const model = primary.slice(idx + 1);
	const ids = Array.isArray(available[provider]) ? available[provider] : [];
	return ids.includes(model);
}

// =====================================================================
// Store
// =====================================================================

/** per-claw 飞行中请求合并，防止并发调用重复发 RPC */
const _loadingByClaw = new Map();

export const useDashboardStore = defineStore('dashboard', {
	state: () => ({
		/** @type {Object<string, DashboardData>} clawId → dashboard 数据 */
		byClaw: {},
	}),

	getters: {
		/**
		 * 获取指定 claw 的 dashboard 数据
		 * @returns {function(string): DashboardData|null}
		 */
		getDashboard() {
			return (clawId) => this.byClaw[String(clawId)] ?? null;
		},
	},

	actions: {
		/**
		 * 加载指定 claw 的完整 dashboard 数据
		 * 通过 WS RPC 并行调用多个 gateway 方法，聚合结果
		 * @param {string} clawId
		 * @param {{ force?: boolean }} [opts] - force=true 时强制重拉 sessions raw（重连恢复 / 用户主动刷新场景），
		 *   不影响其他 dashboard RPC；force 调用进入时若当前已有飞行（无论 force 与否），都会等其完成再启动新一轮，
		 *   确保终态反映 force 时刻的最新数据，不复用更早飞行的陈旧快照
		 */
		async loadDashboard(clawId, { force = false } = {}) {
			const id = String(clawId);

			// 飞行中守卫：
			// - 新调用非 force → 复用已有飞行 promise（乐于拿现成快照，合流省一批 RPC）
			// - 新调用是 force → 不复用任何在飞快照，等当前飞行结束再启动独立的一轮新 load。
			//   含 force→force：第 1 个 force 的飞行可能在 force 触发动作（如选主模型）之前就已取快照，
			//   复用它会让终态停留在写入前的陈旧值，必须串一轮新 load 才能落到最新数据。
			//   串行链终止性：每个 force 调用最多触发一轮真实 load，N 个突发 force 串成 ≤N 轮顺序重载，
			//   不会自我递归无界增长（链式 load 只在“仍有在飞”时再串一次，而在飞只由真实 load 产生，受 N 约束）
			const inflight = _loadingByClaw.get(id);
			if (inflight) {
				if (force) {
					return inflight.p
						.catch(() => {})
						.then(() => this.loadDashboard(id, { force: true }));
				}
				return inflight.p;
			}

			const conn = getReadyConn(id);
			if (!conn) return;

			// 初始化 entry
			if (!this.byClaw[id]) {
				this.byClaw[id] = {
					loading: false,
					error: null,
					instance: null,
					agents: [],
					hasUsableCredential: false,
					primaryModel: null,
					primaryProviderUsable: false,
					modelConfigFetched: false,
				};
			}
			// 闭包捕获原 entry 引用：clearDashboard 在 IIFE 跑完前 delete byClaw[id] 时，
			// 旧 IIFE 仍会写到这个孤儿对象，对 store 不可见、可被 GC。后续如果有人改成
			// "复用旧 entry" 或 "clearDashboard 占位空对象" 会破，需重新评审
			const entry = this.byClaw[id];
			entry.loading = true;
			entry.error = null;

			const p = (async () => {
				try {
					// 先确保 agent 列表已加载
					const agentsStore = useAgentsStore();
					if (!agentsStore.byClaw[id]?.fetched) {
						await agentsStore.loadAgents(id);
					}
					const agentList = agentsStore.getAgentsByClaw(id);

					// sessions raw 改走 sessionsStore：与业务列表共享 _perClawLoading 飞行合流，
					// 消除 dashboard 与 sessions.store 在首屏各发一次 sessions.list 的重复 RPC
					const sessionsStore = useSessionsStore();

					// 并行调用所有 RPC（allSettled 部分失败不影响整体）
					// modelConfigResult 单条失败按默认值降级（见 design § 7.2 / § 7.4），
					// 不上报为整体 error
					//
					// 不再拉 models.list view:'all'（§7.4）：仪表盘判主模型"灵不灵"只看插件给的
					// 凭据信号、不查目录；全量目录的唯一消费点是 agent 卡片模型名徽章，而它现因
					// status.model 常为空本就不显示，故省掉每次刷新拉近千模型这一下重操作。
					// 卡片模型显示后续内聚进插件（见 ui/TODO.md）
					const [
						statusResult,
						usageCostResult,
						ttsResult,
						channelsResult,
						sessionRawResult,
						modelConfigResult,
						...toolResults
					] = await Promise.allSettled([
						conn.request('status', {}, { timeout: 180_000 }),
						conn.request('usage.cost', { mode: 'month' }, { timeout: 180_000 }),
						conn.request('tts.status', {}, { timeout: 180_000 }),
						conn.request('channels.status', { probe: false }, { timeout: 180_000 }),
						sessionsStore.getRawSessionsForClaw(id, { force }),
						conn.request('coclaw.model.list', {}, { timeout: 180_000 }),
						...agentList.map(agent =>
							conn.request('tools.catalog', { agentId: agent.id }, { timeout: 180_000 })
						),
					]);

					// 解包结果（失败的返回 null / 空数组）
					const status = statusResult.status === 'fulfilled' ? statusResult.value : null;
					const usageCost = usageCostResult.status === 'fulfilled' ? usageCostResult.value : null;
					const tts = ttsResult.status === 'fulfilled' ? ttsResult.value : null;
					const channels = channelsResult.status === 'fulfilled' ? channelsResult.value : null;
					// getRawSessionsForClaw 内部已吞错，理论上不会 rejected；rejected 时兜底为空数组
					const sessionRawList = sessionRawResult.status === 'fulfilled' && Array.isArray(sessionRawResult.value)
						? sessionRawResult.value
						: [];
					// 凭据/有效性判定改吃插件 coclaw.model.list 出参的凭据信号（§7.4）：
					//  - hasUsableCredential ← hasAnyUsableCredential（账本 + 内联，插件算好）
					//  - primaryProviderUsable ← default.providerUsable（只看凭据，不查目录）
					// 不再特判旧插件：旧插件给不出这俩字段 → 当 false → 该弹 noKey/invalid 就弹
					// （升级窗口极窄，宁可主动提示也不沉默）。
					// 橙条显隐与 catalog 解耦：catalog 失败不再压掉本该显示的提示
					const modelConfigOk = modelConfigResult.status === 'fulfilled';
					if (!modelConfigOk) {
						// 凭据 RPC 失败 → "未知态"：保持默认值且不置 fetched，外层据此不渲染橙条引导
						entry.hasUsableCredential = false;
						entry.primaryModel = null;
						entry.primaryProviderUsable = false;
						entry.modelConfigFetched = false;
					}
					else {
						const mc = modelConfigResult.value;
						const primaryModel = (typeof mc?.default?.primary === 'string' && mc.default.primary)
							? mc.default.primary
							: null;
						entry.primaryModel = primaryModel;
						entry.hasUsableCredential = mc?.hasAnyUsableCredential === true;
						entry.primaryProviderUsable = mc?.default?.providerUsable === true;
						entry.modelConfigFetched = true;
					}

					// 构建实例总览
					const clawsStore = useClawsStore();
					const claw = clawsStore.byId[id];
					const pluginInfo = claw?.pluginInfo ?? {};

					entry.instance = {
						name: pluginInfo.name || pluginInfo.hostName || claw?.name || 'OpenClaw',
						online: claw?.online ?? false,
						pluginVersion: pluginInfo.version ?? null,
						clawVersion: pluginInfo.clawVersion ?? null,
						monthlyCost: usageCost,
						channels: buildChannelList(channels),
						model: status?.model ?? null,
						provider: status?.provider ?? null,
					};

					// 构建 agent 卡片数据
					// 仪表盘不再拉全量目录（§7.4）→ catalog 恒空 → 卡片模型名徽章不显示
					// （现状本就因 status.model 常空而不显示，零可见变化）。后续内聚进插件见 ui/TODO.md
					const modelCatalog = [];
					const ttsEnabled = tts?.enabled === true;

					entry.agents = agentList.map((agent, index) => {
						const toolsCatalogResult = toolResults[index];
						const toolsCatalog = toolsCatalogResult?.status === 'fulfilled'
							? toolsCatalogResult.value
							: null;

						const toolIds = extractToolIds(toolsCatalog);
						// TODO(phase2): 当前使用实例级 status.model 给所有 agent 生成 model tag。
						// 多 agent 不同模型场景下会显示错误。Phase 2 改为通过
						// agent.identity.get 获取 per-agent 模型配置。
						const currentModel = findCurrentModel(status?.model, modelCatalog);
						const agentSessions = filterSessionsByAgent(sessionRawList, agent.id);
						const sessionStats = computeSessionStats(agentSessions);
						const display = agentsStore.getAgentDisplay(id, agent.id);

						return {
							id: agent.id,
							name: display.name,
							avatarUrl: display.avatarUrl,
							emoji: display.emoji,
							theme: agent.identity?.theme ?? null,
							modelTags: generateModelTags(currentModel),
							capabilities: mapToolsToCapabilities(toolIds, ttsEnabled),
							totalTokens: sessionStats.totalTokens,
							activeSessions: sessionStats.activeSessions,
							lastActivity: sessionStats.lastActivity,
						};
					});
				}
				catch (err) {
					console.warn('[dashboard] loadDashboard failed for clawId=%s:', id, err?.message);
					entry.error = err?.message ?? 'load failed';
					// 硬失败（allSettled 之前的 throw）→ model-config 字段未走成功分支，可能残留上次成功态。
					// 置 fetched=false 让外层把这台 claw 视为"未知态"、不渲染橙条引导（设计 § 7.2）
					entry.modelConfigFetched = false;
				}
				finally {
					entry.loading = false;
				}
			})();
			_loadingByClaw.set(id, { p, force });
			// 确保飞行中守卫在 promise 结束后清理（即使 IIFE 同步完成也不遗漏）；
			// 仅当 Map 当前条目仍是本 promise 时才清，避免老 promise 的 finally
			// 把 clearDashboard 后重入新建的飞行 promise 一起删掉
			p.finally(() => {
				if (_loadingByClaw.get(id)?.p === p) _loadingByClaw.delete(id);
			});
			return p;
		},

		/**
		 * 清除指定 claw 的 dashboard 数据
		 * @param {string} clawId
		 */
		clearDashboard(clawId) {
			const id = String(clawId);
			delete this.byClaw[id];
			// 同步清飞行中守卫，避免同 id 重绑后新 loadDashboard 命中 dedup 拿到旧 promise
			_loadingByClaw.delete(id);
		},
	},
});

/** @internal 仅供测试访问内部函数 */
export const __test__ = {
	buildChannelList,
	extractToolIds,
	findCurrentModel,
	filterSessionsByAgent,
	computeSessionStats,
	computePrimaryEffective,
	_loadingByClaw,
};
