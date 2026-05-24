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
import { useFilesStore } from './files.store.js';

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
	useFilesStore().clearDirCacheByClaw(id);
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
 * claw 恢复上线时把 dashboard 缓存中的 online 标志写回 true。
 * 与 `syncDashboardOffline` 对称，仅同步展示字段；不刷新聚合数据
 * （聚合数据的刷新由 `_pendingForceRefreshOnRebuild` → `refreshClawResources` 的 rebuild 路径负责）。
 * DC 延续场景（PC 未 rebuild）下，此函数防止 dashboard 长期显示"已离线"的陈旧状态。
 * @param {string} id - clawId
 */
function syncDashboardOnline(id) {
	const dashEntry = useDashboardStore().byClaw[id];
	if (dashEntry?.instance) dashEntry.instance.online = true;
}

/**
 * claw 首次初始化：加载 agents（阻塞）+ sessions/topics/dashboard（fire-and-forget）
 * 全部 per-claw，避免多 claw 错峰恢复时全量横扫造成的 N² RPC 放大。
 * @param {string} id - clawId
 */
async function initClawResources(id) {
	await useAgentsStore().loadAgents(id);
	useSessionsStore().loadSessionsForClaw(id).catch((err) => { console.warn('[lifecycle] init sessions failed clawId=%s:', id, err); });
	useTopicsStore().loadTopicsForClaw(id).catch((err) => { console.warn('[lifecycle] init topics failed clawId=%s:', id, err); });
	useDashboardStore().loadDashboard(id).catch((err) => { console.warn('[lifecycle] init dashboard failed clawId=%s:', id, err); });
}

/**
 * RTC 长断连恢复后刷新该 claw 的子 store 数据（per-claw 局部刷新）
 * 仅 sessions 真依赖 agents（fallback ['main'] 漏非 main agent），
 * topics/dashboard 与 agents 独立，并发触发以省一跳 loadAgents RTT。
 * @param {string} id - clawId
 */
export async function refreshClawResources(id) {
	const agentsPromise = useAgentsStore().loadAgents(id).catch((err) => { console.warn('[lifecycle] refresh agents failed clawId=%s:', id, err); });
	useTopicsStore().loadTopicsForClaw(id).catch((err) => { console.warn('[lifecycle] refresh topics failed clawId=%s:', id, err); });
	// refresh 链路下 dashboard 比 sessions 先动手（dashboard 不依赖 agents，
	// sessions 必须 await agents 后才发），force=true 让 dashboard 等 sessions
	// 那边重新拉取最新 raw，避免读到刷新前的旧统计数据
	useDashboardStore().loadDashboard(id, { force: true }).catch((err) => { console.warn('[lifecycle] refresh dashboard failed clawId=%s:', id, err); });
	await agentsPromise;
	useSessionsStore().loadSessionsForClaw(id).catch((err) => { console.warn('[lifecycle] refresh sessions failed clawId=%s:', id, err); });
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
	syncDashboardOnline,
	initClawResources,
	refreshClawResources,
	dispatchAgentEvent,
});
