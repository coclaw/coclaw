/**
 * Agent Run 全局注册表
 * 职责：跟踪所有活跃的 agent run，缓冲流式消息
 * 生命周期独立于 ChatPage / chatStore，run 在页面切换后继续接收事件
 *
 * event:agent 事件由 clawsStore.__bridgeConn 集中桥接，所有事件统一通过 __dispatch 到达本 store。
 * 本 store 不再自行管理 per-connection 监听器。
 */
import { defineStore } from 'pinia';
import { applyAgentEvent } from '../utils/agent-stream.js';

/** post-acceptance 超时（30 分钟） */
const POST_ACCEPT_TIMEOUT_MS = 30 * 60_000;
/** 事件流静默超过此时长视为已停止（用于 reconcile 判断） */
const STALE_RUN_MS = 3000;

export const useAgentRunsStore = defineStore('agentRuns', {
	state: () => ({
		/**
		 * 活跃 run 注册表
		 * @type {Record<string, RunState>}
		 * RunState: { runId, clawId, runKey, topicMode, startTime, settled, streamingMsgs }
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
			// settling 状态仍视为 active（保留 streamingMsgs 直到 loadMessages 替换完成）
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
		/** 是否有任何未完成的 run */
		busy: (state) => Object.values(state.runs).some(r => !r.settled),
	},

	actions: {
		/**
		 * 注册新 run
		 * @param {string} runId
		 * @param {object} opts
		 * @param {string} opts.clawId
		 * @param {string} opts.runKey
		 * @param {boolean} opts.topicMode
		 * @param {object} opts.conn - ClawConnection 实例（仅保留引用，不注册监听器）
		 * @param {object[]} opts.streamingMsgs - 初始流式消息（乐观 user + claw 条目）
		 * @param {string|null} [opts.anchorMsgId] - 注册时 chatStore.messages 的最后一条 server 消息 ID（用于 allMessages 定位）
		 */
		register(runId, { clawId, runKey, topicMode, conn, streamingMsgs = [], anchorMsgId = null }) {
			console.debug('[agentRuns] register runId=%s runKey=%s clawId=%s', runId, runKey, clawId);

			// 清理同一 runKey 的旧 run（若有）
			const oldRunId = this.runKeyIndex[runKey];
			if (oldRunId && this.runs[oldRunId]) {
				this.__cleanupRun(oldRunId);
			}

			this.runs[runId] = {
				runId,
				clawId,
				runKey,
				topicMode,
				anchorMsgId,
				startTime: Date.now(),
				settled: false,
				settling: false,
				lastEventAt: 0,
				streamingMsgs: [...streamingMsgs],
				__conn: conn,
				__timer: null,
			};
			this.runKeyIndex[runKey] = runId;

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
		 * 内部：处理 event:agent 事件路由（由 clawsStore.__bridgeConn 集中调用）
		 * @param {object} payload
		 */
		__dispatch(payload) {
			const runId = payload?.runId;
			if (!runId) return;
			const run = this.runs[runId];
			if (!run || run.settled) return;

			run.lastEventAt = Date.now();
			const { changed, settled } = applyAgentEvent(run.streamingMsgs, payload);
			if (changed) {
				// 触发 Pinia 响应式更新
				this.runs[runId] = { ...run, streamingMsgs: [...run.streamingMsgs] };
			}
			if (settled) {
				console.debug('[agentRuns] lifecycle settled runId=%s', runId);
				this.__settleWithTransition(runId);
			}
		},

		/**
		 * 带过渡态的 settle：先标记 settling，保留 streamingMsgs 直到外部（如 loadMessages）替换 messages
		 * 用于 lifecycle:end 到达但 loadMessages 尚未完成的场景，避免 allMessages 内容闪烁
		 * @param {string} runId
		 */
		__settleWithTransition(runId) {
			const run = this.runs[runId];
			if (!run) return;
			if (run.__timer) {
				clearTimeout(run.__timer);
				run.__timer = null;
			}
			run.settling = true;
			this.__scheduleSettleFallback(runId);
			// settling 状态下 allMessages 仍能看到 streamingMsgs（由 getActiveRun getter 判断）
			// 注意：spread 必须在调度 fallback 之后，确保新对象持有正确的 timer 引用
			this.runs[runId] = { ...run };
		},

		/**
		 * 调度 settle 兜底定时器
		 * loadMessages 飞行中时推迟清理，避免 streamingMsgs 闪烁（#193）
		 * @param {string} runId
		 */
		__scheduleSettleFallback(runId) {
			const run = this.runs[runId];
			if (!run || run.settled) return;
			if (run.__settleTimer) {
				clearTimeout(run.__settleTimer);
			}
			run.__settleTimer = setTimeout(() => {
				const r = this.runs[runId];
				if (!r || r.settled) return;
				if (r.__loadInFlight) {
					console.debug('[agentRuns] settle fallback deferred: load in-flight runId=%s', runId);
					this.__scheduleSettleFallback(runId);
					return;
				}
				this.__cleanupRun(runId);
			}, 500);
		},

		/**
		 * 标记指定 run 有 loadMessages 正在进行
		 * @param {string} runKey
		 */
		markLoadInFlight(runKey) {
			const runId = this.runKeyIndex[runKey];
			if (!runId) return;
			const run = this.runs[runId];
			if (run && !run.settled) run.__loadInFlight = true;
		},

		/**
		 * 清除 loadInFlight 标记
		 * @param {string} runKey
		 */
		clearLoadInFlight(runKey) {
			const runId = this.runKeyIndex[runKey];
			if (!runId) return;
			const run = this.runs[runId];
			if (run) run.__loadInFlight = false;
		},

		/**
		 * 完成 settle 过渡（由 chatStore loadMessages 成功后调用）
		 * @param {string} runKey
		 */
		completeSettle(runKey) {
			const runId = this.runKeyIndex[runKey];
			if (!runId) return;
			const run = this.runs[runId];
			if (!run || !run.settling) return;
			console.debug('[agentRuns] completeSettle runKey=%s runId=%s', runKey, runId);
			if (run.__settleTimer) {
				clearTimeout(run.__settleTimer);
				run.__settleTimer = null;
			}
			this.__cleanupRun(runId);
		},

		/**
		 * 去除 streamingMsgs 中的乐观 user 消息——基于锚点范围的存在性判断：
		 * 仅当 server 数据在 anchorMsgId 之后已出现 user message 时才 strip，
		 * 避免 server 尚未持久化时误删导致 user message 消逝。
		 * 不依赖 content 比较（本地为纯字符串，server 为 Claude API 数组格式，无法 === 匹配）。
		 * @param {string} runKey
		 * @param {object[]} serverMessages - loadMessages 返回的服务端消息
		 */
		stripLocalUserMsgs(runKey, serverMessages = []) {
			const runId = this.runKeyIndex[runKey];
			if (!runId) return;
			const run = this.runs[runId];
			if (!run || run.settled || run.settling) return;
			if (!run.streamingMsgs.some((m) => m._local && m.message?.role === 'user')) return;

			// 判断 server 是否已持久化本次 run 的 user message
			const anchorId = run.anchorMsgId;
			let serverHasUserMsg;
			if (!anchorId) {
				// 无锚点（首条消息）：server 中有任何 user message 即视为已持久化
				serverHasUserMsg = serverMessages.some((m) => m.message?.role === 'user');
			} else {
				let anchorIdx = -1;
				for (let i = serverMessages.length - 1; i >= 0; i--) {
					if (serverMessages[i].id === anchorId) { anchorIdx = i; break; }
				}
				if (anchorIdx === -1) {
					// 锚点被分页截断 → run 进行了很久 → user message 必然已持久化
					serverHasUserMsg = true;
				} else {
					// 锚点之后存在 user message → 已持久化
					serverHasUserMsg = serverMessages.slice(anchorIdx + 1).some((m) => m.message?.role === 'user');
				}
			}
			if (!serverHasUserMsg) return;

			const filtered = run.streamingMsgs.filter(
				(m) => !(m._local && m.message?.role === 'user'),
			);
			if (filtered.length !== run.streamingMsgs.length) {
				// 释放被移除的乐观 user 消息上的 blob URL
				for (const m of run.streamingMsgs) {
					if (!m._local || m.message?.role !== 'user' || !m._attachments) continue;
					for (const att of m._attachments) {
						if (att.url) URL.revokeObjectURL(att.url);
					}
				}
				this.runs[runId] = { ...run, streamingMsgs: filtered };
			}
		},

		/**
		 * 重连后 reconcile：loadMessages 成功后检查是否应 settle 僵尸 run
		 * @param {string} runKey
		 * @param {object[]} serverMessages - loadMessages 返回的服务端消息
		 */
		reconcileAfterLoad(runKey, serverMessages) {
			const runId = this.runKeyIndex[runKey];
			if (!runId) return;
			const run = this.runs[runId];
			if (!run || run.settled || run.settling) return;

			// 条件1：事件流已静默（尚未收到任何事件时视为非 stale）
			if (!run.lastEventAt || Date.now() - run.lastEventAt < STALE_RUN_MS) {
				console.debug('[agentRuns] reconcile skip: events still active runKey=%s (lastEventAt=%d, age=%dms)',
					runKey, run.lastEventAt || 0, run.lastEventAt ? Date.now() - run.lastEventAt : -1);
				return;
			}

			// 条件2：服务端消息已包含 run 的最终结果
			if (!this.__serverMessagesIndicateRunDone(run, serverMessages)) {
				console.debug('[agentRuns] reconcile skip: server msgs indicate run not done runKey=%s', runKey);
				return;
			}

			console.debug('[agentRuns] reconcile settle runKey=%s runId=%s', runKey, runId);
			this.__cleanupRun(runId);
		},

		/**
		 * 检查服务端消息是否已包含 run 的最终结果
		 * @param {object} run
		 * @param {object[]} messages
		 * @returns {boolean}
		 */
		__serverMessagesIndicateRunDone(run, messages) {
			if (!messages?.length) return false;
			// 从后向前找最后一条 assistant 消息
			for (let i = messages.length - 1; i >= 0; i--) {
				const msg = messages[i]?.message;
				if (!msg || msg.role !== 'assistant') continue;
				// 终止类型 stopReason 表示 run 已完成（toolUse 是中间态，不算）
				if (msg.stopReason && msg.stopReason !== 'toolUse') return true;
				// 找到 assistant 但无 stopReason → run 未完成
				return false;
			}
			return false;
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
			if (run.__settleTimer) {
				clearTimeout(run.__settleTimer);
				run.__settleTimer = null;
			}

			// 释放 streamingMsgs 中残留的 blob URL（乐观消息的 _attachments）
			for (const m of run.streamingMsgs) {
				if (!m._attachments) continue;
				for (const att of m._attachments) {
					if (att.url) URL.revokeObjectURL(att.url);
				}
			}

			run.settled = true;

			// 清理索引
			if (this.runKeyIndex[run.runKey] === runId) {
				delete this.runKeyIndex[run.runKey];
			}
			delete this.runs[runId];
		},

		/**
		 * claw 移除时清理该 claw 的所有 runs
		 * @param {string} clawId
		 */
		removeByClaw(clawId) {
			const runIds = Object.keys(this.runs).filter((id) => this.runs[id].clawId === clawId);
			for (const runId of runIds) {
				this.__cleanupRun(runId);
			}
		},
	},
});
