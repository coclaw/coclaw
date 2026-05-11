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
		 *   不影响其他 dashboard RPC；force 调用进入时若当前飞行非 force，会等其完成再启动新一轮，避免被合流吞掉
		 */
		async loadDashboard(clawId, { force = false } = {}) {
			const id = String(clawId);

			// 飞行中守卫：同一 claw 的并发调用复用已有 promise
			// 例外：当前飞行非 force、新调用是 force → 等当前飞行结束再启动新一轮（force 不被合流吞掉）
			const inflight = _loadingByClaw.get(id);
			if (inflight) {
				if (force && !inflight.force) {
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
				this.byClaw[id] = { loading: false, error: null, instance: null, agents: [] };
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
					const [
						statusResult,
						modelsResult,
						usageCostResult,
						ttsResult,
						channelsResult,
						sessionRawResult,
						...toolResults
					] = await Promise.allSettled([
						conn.request('status', {}, { timeout: 180_000 }),
						conn.request('models.list', {}, { timeout: 180_000 }),
						conn.request('usage.cost', { mode: 'month' }, { timeout: 180_000 }),
						conn.request('tts.status', {}, { timeout: 180_000 }),
						conn.request('channels.status', { probe: false }, { timeout: 180_000 }),
						sessionsStore.getRawSessionsForClaw(id, { force }),
						...agentList.map(agent =>
							conn.request('tools.catalog', { agentId: agent.id }, { timeout: 180_000 })
						),
					]);

					// 解包结果（失败的返回 null / 空数组）
					const status = statusResult.status === 'fulfilled' ? statusResult.value : null;
					const models = modelsResult.status === 'fulfilled' ? modelsResult.value : null;
					const usageCost = usageCostResult.status === 'fulfilled' ? usageCostResult.value : null;
					const tts = ttsResult.status === 'fulfilled' ? ttsResult.value : null;
					const channels = channelsResult.status === 'fulfilled' ? channelsResult.value : null;
					// getRawSessionsForClaw 内部已吞错，理论上不会 rejected；rejected 时兜底为空数组
					const sessionRawList = sessionRawResult.status === 'fulfilled' && Array.isArray(sessionRawResult.value)
						? sessionRawResult.value
						: [];

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
					const modelCatalog = Array.isArray(models?.models) ? models.models : [];
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
	_loadingByClaw,
};
