/**
 * Claw 生命周期编排 — 协调子 store 在 claw init/remove/reconnect 时的数据加载和清理
 * 从 claws.store 抽取，打破 bots ↔ 子 store 的循环依赖
 *
 * 注册机制：本模块导入时自动向 claws.store 注册回调，
 * 因此必须在 claws.store 的 action 被首次调用前 import 本模块（通常在 app 入口）。
 */
import { __registerClawLifecycleHooks } from './claws.store.js';
import { useAgentRunsStore } from './agent-runs.store.js';
import { useAgentsStore } from './agents.store.js';
import { useSessionsStore } from './sessions.store.js';
import { useDashboardStore } from './dashboard.store.js';
import { useTopicsStore } from './topics.store.js';

/**
 * 清理某 claw 关联的所有子 store 数据（removeClawById / applySnapshot 时调用）
 * @param {string} id - clawId
 */
function cleanupClawResources(id) {
	useSessionsStore().removeSessionsByClawId(id);
	useAgentsStore().removeByClaw(id);
	useAgentRunsStore().removeByClaw(id);
	useDashboardStore().clearDashboard(id);
	useTopicsStore().removeByClaw(id);
}

/**
 * claw 离线时同步 dashboard 缓存中的 online 状态
 * @param {string} id - clawId
 */
function syncDashboardOffline(id) {
	const dashEntry = useDashboardStore().byClaw[id];
	if (dashEntry?.instance) dashEntry.instance.online = false;
}

/**
 * claw 恢复在线后刷新 dashboard
 * @param {string} id - clawId
 */
function loadDashboardForClaw(id) {
	useDashboardStore().loadDashboard(id);
}

/**
 * claw 首次初始化：加载 agents（阻塞）+ sessions/topics/dashboard（fire-and-forget）
 * @param {string} id - clawId
 */
async function initClawResources(id) {
	await useAgentsStore().loadAgents(id);
	useSessionsStore().loadAllSessions().catch(() => {});
	useTopicsStore().loadAllTopics().catch(() => {});
	useDashboardStore().loadDashboard(id).catch(() => {});
}

/**
 * RTC 长断连恢复后刷新所有子 store 数据
 * @param {string} id - clawId
 */
function refreshClawResources(id) {
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
__registerClawLifecycleHooks({
	cleanupClawResources,
	syncDashboardOffline,
	loadDashboardForClaw,
	initClawResources,
	refreshClawResources,
	dispatchAgentEvent,
});
