/**
 * Bot 生命周期编排 — 协调子 store 在 bot init/remove/reconnect 时的数据加载和清理
 * 从 bots.store 抽取，打破 bots ↔ 子 store 的循环依赖
 *
 * 注册机制：本模块导入时自动向 bots.store 注册回调，
 * 因此必须在 bots.store 的 action 被首次调用前 import 本模块（通��在 app 入口）。
 */
import { __registerBotLifecycleHooks } from './bots.store.js';
import { useAgentRunsStore } from './agent-runs.store.js';
import { useAgentsStore } from './agents.store.js';
import { useSessionsStore } from './sessions.store.js';
import { useDashboardStore } from './dashboard.store.js';
import { useTopicsStore } from './topics.store.js';

/**
 * 清理某 bot 关联的所有子 store 数据（removeBotById / applySnapshot 时调用）
 * @param {string} id - botId
 */
function cleanupBotResources(id) {
	useSessionsStore().removeSessionsByBotId(id);
	useAgentsStore().removeByBot(id);
	useAgentRunsStore().removeByBot(id);
	useDashboardStore().clearDashboard(id);
	useTopicsStore().removeByBot(id);
}

/**
 * bot 离线时同步 dashboard 缓存中的 online 状态
 * @param {string} id - botId
 */
function syncDashboardOffline(id) {
	const dashEntry = useDashboardStore().byBot[id];
	if (dashEntry?.instance) dashEntry.instance.online = false;
}

/**
 * bot 恢复在线后刷新 dashboard
 * @param {string} id - botId
 */
function loadDashboardForBot(id) {
	useDashboardStore().loadDashboard(id);
}

/**
 * bot 首次初始化：加载 agents（阻塞）+ sessions/topics/dashboard（fire-and-forget）
 * @param {string} id - botId
 */
async function initBotResources(id) {
	await useAgentsStore().loadAgents(id);
	useSessionsStore().loadAllSessions().catch(() => {});
	useTopicsStore().loadAllTopics().catch(() => {});
	useDashboardStore().loadDashboard(id).catch(() => {});
}

/**
 * RTC 长断连恢复后刷新所有子 store 数据
 * @param {string} id - botId
 */
function refreshBotResources(id) {
	useAgentsStore().loadAgents(id).catch(() => {});
	useSessionsStore().loadAllSessions().catch(() => {});
	useTopicsStore().loadAllTopics().catch(() => {});
	useDashboardStore().loadDashboard(id).catch(() => {});
}

/**
 * 桥接 DC 的 agent 事件到 agentRunsStore
 * @param {object} payload - 事件载荷
 */
function dispatchAgentEvent(payload) {
	useAgentRunsStore().__dispatch(payload);
}

// 自注册回调
__registerBotLifecycleHooks({
	cleanupBotResources,
	syncDashboardOffline,
	loadDashboardForBot,
	initBotResources,
	refreshBotResources,
	dispatchAgentEvent,
});
