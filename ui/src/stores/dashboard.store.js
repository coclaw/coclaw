import { defineStore } from 'pinia';

import { useBotConnections } from '../services/bot-connection-manager.js';
import { useBotsStore } from './bots.store.js';
import { useAgentsStore } from './agents.store.js';
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
 *   recentSessions: { key: string, label: string, updatedAt: string|null }[],
 *   contextPressure: number,
 *   sparkline: number[],
 *   cronCount: number,
 *   hasError: boolean,
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
		.filter(([key]) => key !== 'defaultAccountId')
		.map(([id, data]) => ({
			id,
			connected: Array.isArray(data?.accounts)
				? data.accounts.some(a => a.enabled !== false)
				: false,
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
 * 从 sessions.usage 响应中提取指定 agentId 的最近 7 天每日 token 数组
 * @param {object|null} usageResult
 * @param {string} agentId
 * @returns {number[]} 长度 7，索引 0=最早，6=今天
 */
function extractSparkline(usageResult, agentId) {
	if (!usageResult?.sessions) return new Array(7).fill(0);
	const today = new Date();
	const days = Array.from({ length: 7 }, (_, i) => {
		const d = new Date(today);
		d.setDate(d.getDate() - (6 - i));
		return d.toISOString().slice(0, 10);
	});
	const byDay = {};
	for (const s of usageResult.sessions) {
		if (!(s.key || '').startsWith(`agent:${agentId}:`)) continue;
		const date = s.updatedAt ? new Date(s.updatedAt).toISOString().slice(0, 10) : null;
		if (date && days.includes(date)) {
			byDay[date] = (byDay[date] || 0) + (s.totalTokens || 0);
		}
	}
	return days.map(d => byDay[d] || 0);
}

/**
 * 计算 context 压力（0-100，-1 表示无数据）
 * @param {object[]} agentSessions - 该 agent 的 sessions
 * @param {number|null} defaultContextTokens - 模型 context 上限
 * @returns {number}
 */
function computeContextPressure(agentSessions, defaultContextTokens) {
	if (!defaultContextTokens || agentSessions.length === 0) return -1;
	const sorted = [...agentSessions].sort((a, b) => {
		return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
	});
	const latest = sorted[0];
	const used = latest?.contextTokens;
	if (typeof used !== 'number' || used <= 0) return -1;
	return Math.min(100, Math.round((used / defaultContextTokens) * 100));
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

export const useDashboardStore = defineStore('dashboard', {
	state: () => ({
		/** @type {Object<string, DashboardData>} botId → dashboard 数据 */
		byBot: {},
	}),

	getters: {
		/**
		 * 获取指定 bot 的 dashboard 数据
		 * @returns {function(string): DashboardData|null}
		 */
		getDashboard() {
			return (botId) => this.byBot[String(botId)] ?? null;
		},
	},

	actions: {
		/**
		 * 加载指定 bot 的完整 dashboard 数据
		 * 通过 WS RPC 并行调用多个 gateway 方法，聚合结果
		 * @param {string} botId
		 */
		async loadDashboard(botId) {
			const id = String(botId);
			const conn = useBotConnections().get(id);
			if (!conn || conn.state !== 'connected') return;

			// 初始化 entry
			if (!this.byBot[id]) {
				this.byBot[id] = { loading: false, error: null, instance: null, agents: [] };
			}
			const entry = this.byBot[id];
			entry.loading = true;
			entry.error = null;

			try {
				// 先确保 agent 列表已加载
				const agentsStore = useAgentsStore();
				if (!agentsStore.byBot[id]?.fetched) {
					await agentsStore.loadAgents(id);
				}
				const agentList = agentsStore.getAgentsByBot(id);

				// 并行调用所有 RPC（allSettled 部分失败不影响整体）
				const [
					statusResult,
					modelsResult,
					usageCostResult,
					sessionsResult,
					ttsResult,
					channelsResult,
					sessionsUsageResultRaw,
					cronListRaw,
					...toolResults
				] = await Promise.allSettled([
					conn.request('status', {}),
					conn.request('models.list', {}),
					conn.request('usage.cost', { mode: 'month' }),
					conn.request('sessions.list', {}),
					conn.request('tts.status', {}),
					conn.request('channels.status', { probe: false }),
					conn.request('sessions.usage', {
						startDate: (() => { const d = new Date(); d.setDate(d.getDate() - 6); return d.toISOString().slice(0, 10); })(),
						endDate: new Date().toISOString().slice(0, 10),
					}),
					conn.request('cron.list', {}),
					...agentList.map(agent =>
						conn.request('tools.catalog', { agentId: agent.id })
					),
				]);

				// 解包结果（失败的返回 null）
				const status = statusResult.status === 'fulfilled' ? statusResult.value : null;
				const models = modelsResult.status === 'fulfilled' ? modelsResult.value : null;
				const usageCost = usageCostResult.status === 'fulfilled' ? usageCostResult.value : null;
				const sessions = sessionsResult.status === 'fulfilled' ? sessionsResult.value : null;
				const tts = ttsResult.status === 'fulfilled' ? ttsResult.value : null;
				const channels = channelsResult.status === 'fulfilled' ? channelsResult.value : null;
				const usageResult = sessionsUsageResultRaw.status === 'fulfilled' ? sessionsUsageResultRaw.value : null;
				const cronList = cronListRaw.status === 'fulfilled' ? cronListRaw.value : null;

				// 构建实例总览
				const botsStore = useBotsStore();
				const bot = botsStore.items.find(b => String(b.id) === id);
				const pluginInfo = botsStore.pluginInfo[id] ?? {};

				entry.instance = {
					name: bot?.name || 'OpenClaw',
					online: bot?.online ?? false,
					pluginVersion: pluginInfo.version ?? null,
					clawVersion: pluginInfo.clawVersion ?? null,
					monthlyCost: usageCost,
					channels: buildChannelList(channels),
					model: status?.model ?? null,
					provider: status?.provider ?? null,
				};

				// 构建 agent 卡片数据
				const modelCatalog = Array.isArray(models?.models) ? models.models : [];
				const sessionList = Array.isArray(sessions?.sessions) ? sessions.sessions : [];
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
					const agentSessions = filterSessionsByAgent(sessionList, agent.id);
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
						recentSessions: agentSessions
							.slice()
							.sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())
							.slice(0, 3)
							.map(s => ({
								key: s.key,
								label: s.displayName || s.label || s.key?.split(':').slice(-1)[0] || '',
								updatedAt: s.updatedAt,
							})),
						contextPressure: computeContextPressure(agentSessions, sessions?.defaults?.contextTokens ?? null),
						sparkline: extractSparkline(usageResult, agent.id),
						cronCount: Array.isArray(cronList?.jobs)
							? cronList.jobs.filter(j => {
								const target = j.sessionTarget || j.payload?.sessionTarget || '';
								return target === agent.id || target.startsWith(`agent:${agent.id}:`);
							}).length
							: 0,
						hasError: agentSessions.some(s => s.abortedLastRun === true || s.status === 'error'),
					};
				});
			}
			catch (err) {
				console.warn('[dashboard] loadDashboard failed for botId=%s:', id, err?.message);
				entry.error = err?.message ?? 'load failed';
			}
			finally {
				entry.loading = false;
			}
		},

		/**
		 * 清除指定 bot 的 dashboard 数据
		 * @param {string} botId
		 */
		clearDashboard(botId) {
			delete this.byBot[String(botId)];
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
	extractSparkline,
	computeContextPressure,
};
