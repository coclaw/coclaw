/**
 * Agent Run 全局注册表
 * 职责：跟踪所有活跃的 agent run，管理 per-connection 事件路由，缓冲流式消息
 * 生命周期独立于 ChatPage / chatStore，run 在页面切换后继续接收事件
 */
import { defineStore } from 'pinia';
import { applyAgentEvent } from '../utils/agent-stream.js';

/** post-acceptance 超时（30 分钟） */
const POST_ACCEPT_TIMEOUT_MS = 30 * 60_000;

export const useAgentRunsStore = defineStore('agentRuns', {
	state: () => ({
		/**
		 * 活跃 run 注册表
		 * @type {Record<string, RunState>}
		 * RunState: { runId, botId, runKey, topicMode, startTime, settled, streamingMsgs }
		 */
		runs: {},
		/**
		 * runKey → runId 索引（按 chat/topic 查询）
		 * runKey = chatSessionKey（chat 模式）或 sessionId（topic 模式）
		 * @type {Record<string, string>}
		 */
		runKeyIndex: {},
	}),

	getters: {
		/**
		 * 根据 runKey 获取活跃（未 settled）的 run
		 * @returns {(runKey: string) => RunState | null}
		 */
		getActiveRun: (state) => (runKey) => {
			const runId = state.runKeyIndex[runKey];
			if (!runId) return null;
			const run = state.runs[runId];
			return (run && !run.settled) ? run : null;
		},
		/**
		 * 指定 runKey 是否有活跃 run
		 * @returns {(runKey: string) => boolean}
		 */
		isRunning: (state) => (runKey) => {
			const runId = state.runKeyIndex[runKey];
			if (!runId) return false;
			const run = state.runs[runId];
			return !!run && !run.settled;
		},
	},

	actions: {
		/**
		 * 注册新 run
		 * @param {string} runId
		 * @param {object} opts
		 * @param {string} opts.botId
		 * @param {string} opts.runKey
		 * @param {boolean} opts.topicMode
		 * @param {object} opts.conn - BotConnection 实例
		 * @param {object[]} opts.streamingMsgs - 初始流式消息（乐观 user + bot 条目）
		 */
		register(runId, { botId, runKey, topicMode, conn, streamingMsgs = [] }) {
			console.debug('[agentRuns] register runId=%s runKey=%s botId=%s', runId, runKey, botId);

			// 清理同一 runKey 的旧 run（若有）
			const oldRunId = this.runKeyIndex[runKey];
			if (oldRunId && this.runs[oldRunId]) {
				this.__cleanupRun(oldRunId);
			}

			this.runs[runId] = {
				runId,
				botId,
				runKey,
				topicMode,
				startTime: Date.now(),
				settled: false,
				streamingMsgs: [...streamingMsgs],
				// 非响应式内部引用
				__conn: conn,
				__timer: null,
			};
			this.runKeyIndex[runKey] = runId;

			// 确保 connection 上有事件路由
			this.__ensureListener(botId, conn);

			// post-acceptance 超时
			this.runs[runId].__timer = setTimeout(() => {
				console.debug('[agentRuns] post-acceptance timeout runId=%s', runId);
				this.settle(runKey);
			}, POST_ACCEPT_TIMEOUT_MS);
		},

		/**
		 * 结束 run（用户取消或 lifecycle 终态）
		 * @param {string} runKey
		 */
		settle(runKey) {
			const runId = this.runKeyIndex[runKey];
			if (!runId) return;
			const run = this.runs[runId];
			if (!run || run.settled) return;
			console.debug('[agentRuns] settle runKey=%s runId=%s', runKey, runId);
			this.__cleanupRun(runId);
		},

		/**
		 * 内部：处理 event:agent 事件路由
		 * @param {object} payload
		 */
		__dispatch(payload) {
			const runId = payload?.runId;
			if (!runId) return;
			const run = this.runs[runId];
			if (!run || run.settled) return;

			const { changed, settled } = applyAgentEvent(run.streamingMsgs, payload);
			if (changed) {
				// 触发 Pinia 响应式更新
				this.runs[runId] = { ...run, streamingMsgs: [...run.streamingMsgs] };
			}
			if (settled) {
				console.debug('[agentRuns] lifecycle settled runId=%s', runId);
				this.__cleanupRun(runId);
			}
		},

		/**
		 * 清理单个 run
		 * @param {string} runId
		 */
		__cleanupRun(runId) {
			const run = this.runs[runId];
			if (!run) return;

			if (run.__timer) {
				clearTimeout(run.__timer);
				run.__timer = null;
			}
			run.settled = true;

			// 清理索引
			if (this.runKeyIndex[run.runKey] === runId) {
				delete this.runKeyIndex[run.runKey];
			}
			delete this.runs[runId];

			// 若该 botId 下无活跃 run，移除监听器
			this.__removeListenerIfIdle(run.botId);
		},

		// --- per-connection 事件监听器管理 ---

		/**
		 * 确保指定 botId 的 connection 上注册了事件路由
		 * @param {string} botId
		 * @param {object} conn
		 */
		__ensureListener(botId, conn) {
			if (!this.__listeners) this.__listeners = {};
			if (this.__listeners[botId]) return;

			const handler = (payload) => this.__dispatch(payload);
			conn.on('event:agent', handler);
			this.__listeners[botId] = { handler, conn };
			console.debug('[agentRuns] listener registered botId=%s', botId);
		},

		/**
		 * 若指定 botId 下无活跃 run，移除监听器
		 * @param {string} botId
		 */
		__removeListenerIfIdle(botId) {
			if (!this.__listeners?.[botId]) return;
			// 检查是否还有该 botId 的活跃 run
			const hasActive = Object.values(this.runs).some((r) => r.botId === botId && !r.settled);
			if (hasActive) return;

			const { handler, conn } = this.__listeners[botId];
			conn.off('event:agent', handler);
			delete this.__listeners[botId];
			console.debug('[agentRuns] listener removed botId=%s', botId);
		},
	},
});
